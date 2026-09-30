import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChecker } from '../check.js';
import { runHook } from '../hook/run.js';
import { MockJudge } from '../judge/mock.js';
import type { Judge, JudgeCallContext, JudgeRequest, JudgeResponse } from '../judge/types.js';
import type { PathEnv } from '../paths.js';

const RULES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../rules-builtin/rules');
const builtinRules = readdirSync(RULES_DIR)
  .filter((n) => n.endsWith('.yaml'))
  .map((n) => ({ file: n, yaml: readFileSync(path.join(RULES_DIR, n), 'utf8') }));

const DOC = `# 退货方案

## 一、背景

推荐系统和召回服务都要在本期改造，它的延迟目前是 200 毫秒。

目前退货全靠客服人工审核，平均每单 9.5 分钟，高峰期积压超过 200 单。

短句。

## 二、方案

本期不支持离线使用。为了保证弱网体验，本期会实现离线缓存和断网重连后的自动同步。

新流程分三步：用户提交申请，系统自动审核，仓库确认收货。
`;

/** Answers "yes" only where a paragraph obviously has the rule's problem. */
const smartResolver = (state: string, name: string): number => {
  const current = /【当前段落】([\s\S]*)$/u.exec(state)?.[1] ?? state;
  if (name === 'S201') return current.includes('它的延迟') ? 0.9 : 0.05;
  if (name === 'S205') return current.includes('不支持离线使用') ? 0.95 : 0.02;
  return 0.05;
};

let root: string;
let project: string;
let doc: string;
let env: PathEnv;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'lingspark-pass2-'));
  project = path.join(root, 'proj');
  mkdirSync(path.join(project, '.lingspark'), { recursive: true });
  mkdirSync(path.join(project, 'docs'), { recursive: true });
  writeFileSync(path.join(project, '.lingspark', 'config.yaml'), 'include: ["docs/**/*.md"]\n');
  doc = path.join(project, 'docs', 'prd.md');
  writeFileSync(doc, DOC);
  env = { platform: process.platform, env: { LINGSPARK_DATA_DIR: path.join(root, 'data') }, homedir: root };
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

const check = (judge: Judge | null) =>
  createChecker({ builtinRules, pathEnv: env, judge, cli: { passes: [0, 1, 2] } }).checkFile(doc);

describe('Pass 2', () => {
  it('reports what the judge finds, with probability', async () => {
    const r = await check(new MockJudge(smartResolver));
    const s201 = r.diagnostics.find((d) => d.ruleId === 'S201');
    const s205 = r.diagnostics.find((d) => d.ruleId === 'S205');
    expect(s201?.probability).toBe(0.9);
    expect(s201?.range.start.line).toBe(5);
    expect(s205?.severity).toBe('error');
    expect(r.passesRun).toEqual([0, 1, 2]);
  });

  it('asks every block rule in one request per paragraph, and skips short blocks', async () => {
    const judge = new MockJudge(smartResolver);
    await check(judge);
    const blockRequests = judge.calls.filter((c) => c.state.includes('【当前段落】'));
    // Four paragraphs of 15+ characters; "短句。" is skipped.
    expect(blockRequests).toHaveLength(4);
    expect(blockRequests.some((c) => c.state.includes('短句'))).toBe(false);
    expect(Object.keys(blockRequests[0]?.questions ?? {}).sort()).toEqual(
      ['S201', 'S202', 'S203', 'S204', 'S205', 'S206', 'S207', 'S208'],
    );
  });

  it('gives the judge the heading path and the previous paragraph', async () => {
    const judge = new MockJudge(smartResolver);
    await check(judge);
    const second = judge.calls.find((c) => c.state.includes('【当前段落】目前退货'));
    expect(second?.state).toContain('【所属章节】退货方案 > 一、背景');
    expect(second?.state).toContain('【上一段】推荐系统和召回服务');
  });

  it('folds not_for into the question the judge sees', async () => {
    const judge = new MockJudge(smartResolver);
    await check(judge);
    const q = judge.calls[0]?.questions['S201'];
    expect(q?.instructions).toContain('以下情况不算');
    expect(q?.instructions).toContain('只判断【当前段落】');
  });

  it('makes no judge request the second time a document is checked (M2 acceptance 2)', async () => {
    await check(new MockJudge(smartResolver));
    const again = new MockJudge(smartResolver);
    const r = await check(again);
    expect(again.calls).toHaveLength(0);
    expect(r.judgeStats?.requests).toBe(0);
    expect(r.diagnostics.some((d) => d.ruleId === 'S201')).toBe(true);
  });

  it('re-asks only the edited paragraph and the one after it (M2 acceptance 3)', async () => {
    await check(new MockJudge(smartResolver));
    writeFileSync(doc, DOC.replace('平均每单 9.5 分钟', '平均每单 9 分钟'));
    const judge = new MockJudge(smartResolver);
    await check(judge);
    const asked = judge.calls.map((c) => /【当前段落】(.{6})/u.exec(c.state)?.[1] ?? c.state.slice(0, 12));
    // Only the edited paragraph: the block after it is too short to judge,
    // and a heading resets the previous-paragraph context. The section-level
    // question for the edited section is re-asked too, since its text changed;
    // the document title is not a section (see targetsFor).
    expect(asked.filter((a) => !a.startsWith('【章节'))).toEqual(['目前退货全靠']);
    const sectionCalls = judge.calls.filter((c) => c.state.startsWith('【章节标题】'));
    expect(sectionCalls.map((c) => c.state.split('\n')[0])).toEqual(['【章节标题】一、背景']);
  });

  it('raises the bar for an uncalibrated judge', async () => {
    // 0.75 clears the default 0.70 but not 0.70 + 0.10.
    const at = (p: number, calibrated: boolean) =>
      new MockJudge((s, n) => (n === 'S201' && s.includes('它的延迟') ? p : 0.01), `m-${String(calibrated)}`, calibrated);
    expect((await check(at(0.75, true))).diagnostics.some((d) => d.ruleId === 'S201')).toBe(true);
    rmSync(path.join(root, 'data'), { recursive: true, force: true });
    const r = await check(at(0.75, false));
    expect(r.diagnostics.some((d) => d.ruleId === 'S201')).toBe(false);
    expect(r.uncertain?.some((u) => u.ruleId === 'S201')).toBe(true);
  });

  it('keeps between-threshold answers for Pass 4 instead of reporting them', async () => {
    const r = await check(new MockJudge((_s, n) => (n === 'S204' ? 0.5 : 0.01)));
    expect(r.diagnostics.filter((d) => d.ruleId === 'S204')).toEqual([]);
    expect(r.uncertain?.filter((u) => u.ruleId === 'S204').length).toBeGreaterThan(0);
  });

  it('degrades to the deterministic passes when the judge fails', async () => {
    const broken: Judge = {
      id: 'broken',
      calibrated: true,
      slow: false,
      judge: () => Promise.reject(new Error('HTTP 500')),
    };
    const r = await check(broken);
    expect(r.diagnostics.every((d) => !d.ruleId.startsWith('S'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('HTTP 500'))).toBe(true);
    expect(r.judgeStats?.failedRequests).toBeGreaterThan(0);
  });

  it('drops what the judge has not answered when the budget runs out', async () => {
    const slow: Judge = {
      id: 'slow',
      calibrated: true,
      slow: false,
      judge: (_req: JudgeRequest, ctx: JudgeCallContext) =>
        new Promise<JudgeResponse>((_resolve, reject) => {
          ctx.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    };
    const t0 = Date.now();
    const r = await createChecker({ builtinRules, pathEnv: env, judge: slow, judgeBudgetMs: 200, cli: { passes: [0, 1, 2] } }).checkFile(doc);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(r.judgeStats?.timedOut).toBe(true);
    // Nothing the judge never answered is reported, and the check still returns.
    expect(r.diagnostics.filter((d) => d.ruleId.startsWith('S'))).toEqual([]);
    expect(r.passesRun).toEqual([0, 1, 2]);
  });

  it('says why Pass 2 did not run when no judge is configured', async () => {
    const r = await createChecker({ builtinRules, pathEnv: env, cli: { passes: [0, 1, 2] } }).checkFile(doc);
    expect(r.passesRun).toEqual([0, 1]);
    expect(r.judgeNote).toContain('judge.backend');
  });
});

describe('offline (design doc, 8.6 and 13)', () => {
  it('makes no network call anywhere in a full check with a remote judge configured', async () => {
    const trap = vi.fn(() => {
      throw new Error('network call while offline');
    });
    vi.stubGlobal('fetch', trap);
    mkdirSync(path.join(root, 'data'), { recursive: true });
    writeFileSync(path.join(root, 'data', 'config.yaml'), 'offline: true\njudge:\n  backend: typesafe\n');
    writeFileSync(path.join(root, 'data', 'credentials.yaml'), 'typesafe_api_key: k\n');
    const r = await createChecker({ builtinRules, pathEnv: env, cli: { passes: [0, 1, 2, 3, 4] } }).checkFile(doc);
    expect(trap).not.toHaveBeenCalled();
    expect(r.judgeNote).toContain('离线');
    expect(r.passesRun).toEqual([0, 1]);
  });
});

describe('hook with a judge', () => {
  const post = (turn = 'p1') => JSON.stringify({ session_id: 's', prompt_id: turn, cwd: project, tool_input: { file_path: doc } });
  const stop = (turn = 'p1') => JSON.stringify({ session_id: 's', prompt_id: turn, cwd: project });

  it('blocks on a semantic error after a write, and shows warnings once at Stop', async () => {
    const deps = { builtinRules, pathEnv: env, judge: new MockJudge(smartResolver) };
    const afterWrite = await runHook(post(), 'claude-code', 'post-tool-use', deps);
    expect(afterWrite.exitCode).toBe(2);
    expect(afterWrite.stderr).toContain('[S205]');
    expect(afterWrite.stderr).not.toContain('[S201]'); // warnings wait for Stop

    const atStop = await runHook(stop(), 'claude-code', 'stop', deps);
    expect(atStop.exitCode).toBe(2);
    expect(atStop.stderr).toContain('[S201]');
  });

  it('keeps a slow judge out of the after-write path', async () => {
    const slow = new MockJudge(smartResolver, 'slow-cli', false, true);
    await runHook(post(), 'claude-code', 'post-tool-use', { builtinRules, pathEnv: env, judge: slow });
    expect(slow.calls).toHaveLength(0);
    await runHook(stop(), 'claude-code', 'stop', { builtinRules, pathEnv: env, judge: slow });
    expect(slow.calls.length).toBeGreaterThan(0);
  });
});
