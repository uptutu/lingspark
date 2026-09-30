import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from '../config/resolve.js';
import type { PathEnv } from '../paths.js';
import { parseClaudeCodeTranscript, stripInjected } from './claude-code.js';
import { diffBlocks, findRevisions } from './extract.js';
import { mine, ulid, type FeedbackRecord } from './mine.js';
import { MockJudge } from '../judge/mock.js';

const RULES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../rules-builtin/rules');
const builtinRules = readdirSync(RULES_DIR)
  .filter((n) => n.endsWith('.yaml'))
  .map((n) => ({ file: n, yaml: readFileSync(path.join(RULES_DIR, n), 'utf8') }));

/* ------------------------------------------------------------------------
 * Fixture builder. Every line follows the structure verified in section 9.2
 * of the design doc: user prompts carry no toolUseResult; tool results do, and
 * their message content is an array holding a tool_result block; assistant
 * messages hold tool_use blocks.
 * ---------------------------------------------------------------------- */

class Transcript {
  private readonly lines: string[] = [];
  private n = 0;
  constructor(
    private readonly sessionId: string,
    private readonly cwd: string,
  ) {}

  private base(extra: Record<string, unknown>): Record<string, unknown> {
    this.n++;
    return {
      uuid: `u${String(this.n)}`,
      parentUuid: this.n > 1 ? `u${String(this.n - 1)}` : null,
      timestamp: new Date(Date.UTC(2026, 8, 18, 7, 0, this.n)).toISOString(),
      cwd: this.cwd,
      sessionId: this.sessionId,
      isSidechain: false,
      ...extra,
    };
  }

  prompt(text: string | unknown[], promptId?: string, extra: Record<string, unknown> = {}): this {
    this.lines.push(
      JSON.stringify(this.base({ type: 'user', promptId: promptId ?? `p${String(this.n + 1)}`, message: { role: 'user', content: text }, ...extra })),
    );
    return this;
  }

  write(file: string, content: string, originalFile: string | null, extra: Record<string, unknown> = {}): this {
    const id = `toolu_${String(this.n + 1)}`;
    this.lines.push(
      JSON.stringify(this.base({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Write', input: { file_path: file, content } }] }, ...extra })),
    );
    this.lines.push(
      JSON.stringify(
        this.base({
          type: 'user',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
          toolUseResult: {
            type: originalFile === null ? 'create' : 'update',
            filePath: file,
            content,
            originalFile,
            structuredPatch: [],
            userModified: false,
          },
          ...extra,
        }),
      ),
    );
    return this;
  }

  /** An Edit whose result, like real ones, carries no full new content. */
  edit(file: string, originalFile: string, oldString: string, newString: string, userModified = false): this {
    const id = `toolu_${String(this.n + 1)}`;
    this.lines.push(
      JSON.stringify(
        this.base({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Edit', input: { file_path: file, old_string: oldString, new_string: newString, replace_all: false } }] },
        }),
      ),
    );
    this.lines.push(
      JSON.stringify(
        this.base({
          type: 'user',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
          toolUseResult: { filePath: file, originalFile, structuredPatch: [], userModified },
          sourceToolAssistantUUID: `u${String(this.n)}`,
        }),
      ),
    );
    return this;
  }

  raw(line: string): this {
    this.lines.push(line);
    return this;
  }

  text(): string {
    return `${this.lines.join('\n')}\n`;
  }
}

const DRAFT = `# 退货审核方案

## 一、背景

以下三点需要确认：

- 买家上传的凭证是否真实
- 退货原因如何采集

## 二、方案

先按规则自动审核，再人工复核，流程和现在一样。

## 三、风险

上游数据延迟时，审核结果可能过期。
`;

const FIXED_COUNT = DRAFT.replace('以下三点需要确认', '以下两点需要确认');
const REWORDED_PLAN = FIXED_COUNT.replace(
  '先按规则自动审核，再人工复核，流程和现在一样。',
  '先按规则自动审核；审核不通过的申请才进入人工复核，其余自动退款。',
);

/* ------------------------------------------------------------------ parsing */

describe('parseClaudeCodeTranscript', () => {
  const doc = '/w/p/docs/prd.md';

  it('turns prompts into user_prompt and tool results into file_write', () => {
    const t = new Transcript('s1', '/w/p').prompt('写一篇方案').write(doc, DRAFT, null).prompt('改一下');
    const ev = parseClaudeCodeTranscript(t.text());
    expect(ev.map((e) => e.kind)).toEqual(['user_prompt', 'file_write', 'user_prompt']);
    const w = ev[1];
    expect(w?.kind === 'file_write' && w.before).toBeNull();
    expect(w?.kind === 'file_write' && w.after).toBe(DRAFT);
  });

  it('never treats a tool result as something the user said', () => {
    const t = new Transcript('s1', '/w/p').write(doc, DRAFT, null);
    expect(parseClaudeCodeTranscript(t.text()).filter((e) => e.kind === 'user_prompt')).toEqual([]);
  });

  it('rebuilds an Edit from the old file and the tool_use input', () => {
    const t = new Transcript('s1', '/w/p').edit(doc, DRAFT, '以下三点', '以下两点');
    const [w] = parseClaudeCodeTranscript(t.text());
    expect(w?.kind === 'file_write' && w.after).toBe(FIXED_COUNT);
  });

  it('drops an Edit it cannot reconstruct rather than guessing', () => {
    const t = new Transcript('s1', '/w/p').edit(doc, DRAFT, '原文里没有这句', '新句子');
    expect(parseClaudeCodeTranscript(t.text())).toEqual([]);
  });

  it('reads block-array messages and strips injected text', () => {
    const t = new Transcript('s1', '/w/p').prompt([
      { type: 'text', text: '<system-reminder>internal</system-reminder>第三节读起来像翻译的' },
      { type: 'image', source: {} },
    ]);
    const [p] = parseClaudeCodeTranscript(t.text());
    expect(p?.kind === 'user_prompt' && p.text).toBe('第三节读起来像翻译的');
  });

  it('skips a message that is nothing but injected text', () => {
    const t = new Transcript('s1', '/w/p').prompt('<command-name>/model</command-name><command-args>x</command-args>');
    expect(parseClaudeCodeTranscript(t.text())).toEqual([]);
  });

  it('skips sub-agent lines, harness meta turns, unknown types and garbage', () => {
    const t = new Transcript('s1', '/w/p')
      .prompt('子代理的话', 'px', { isSidechain: true })
      .write(doc, DRAFT, null, { isSidechain: true })
      .prompt('Caveat: generated', 'pm', { isMeta: true })
      .raw(JSON.stringify({ type: 'file-history-snapshot', snapshot: {} }))
      .raw(JSON.stringify({ type: 'some-future-type', whatever: 1 }))
      .raw('{ this is not json')
      .raw('"a string"');
    expect(parseClaudeCodeTranscript(t.text())).toEqual([]);
  });

  it('keeps a relative path relative to the line cwd', () => {
    const t = new Transcript('s1', '/w/p').write('docs/prd.md', DRAFT, null);
    const [w] = parseClaudeCodeTranscript(t.text());
    expect(w?.kind === 'file_write' && w.path).toBe(path.resolve('/w/p', 'docs/prd.md'));
  });
});

describe('stripInjected', () => {
  it('removes every harness wrapper and keeps the user text', () => {
    expect(stripInjected('<local-command-caveat>x</local-command-caveat>\n真正的意见')).toBe('真正的意见');
    expect(stripInjected('[Request interrupted by user]')).toBe('');
  });
});

/* ------------------------------------------------------------------ extraction */

describe('findRevisions', () => {
  const doc = '/w/p/docs/prd.md';
  const all = { isEligible: () => true };

  it('finds W1 -> U -> W2 with the right before and after', () => {
    const t = new Transcript('s1', '/w/p')
      .prompt('写方案')
      .write(doc, DRAFT, null)
      .prompt('背景里说三点只列了两点', 'p-fix')
      .edit(doc, DRAFT, '以下三点', '以下两点');
    const [r, ...rest] = findRevisions(parseClaudeCodeTranscript(t.text()), all);
    expect(rest).toEqual([]);
    expect(r?.feedback).toBe('背景里说三点只列了两点');
    expect(r?.promptKey).toBe('p-fix');
    expect(r?.before).toBe(DRAFT);
    expect(r?.after).toBe(FIXED_COUNT);
  });

  it('spans every edit in a round: before the first, after the last', () => {
    const t = new Transcript('s1', '/w/p')
      .write(doc, DRAFT, null)
      .prompt('两处都改')
      .edit(doc, DRAFT, '以下三点', '以下两点')
      .edit(doc, FIXED_COUNT, '先按规则自动审核，再人工复核，流程和现在一样。', '先按规则自动审核；审核不通过的申请才进入人工复核，其余自动退款。');
    const [r] = findRevisions(parseClaudeCodeTranscript(t.text()), all);
    expect(r?.before).toBe(DRAFT);
    expect(r?.after).toBe(REWORDED_PLAN);
  });

  it('allows unrelated events between W1 and U', () => {
    const t = new Transcript('s1', '/w/p')
      .write(doc, DRAFT, null)
      .write('/w/p/src/a.ts', 'x', null)
      .raw(JSON.stringify({ type: 'system', content: 'noise' }))
      .prompt('改计数')
      .edit(doc, DRAFT, '以下三点', '以下两点');
    expect(findRevisions(parseClaudeCodeTranscript(t.text()), all)).toHaveLength(1);
  });

  it('uses the file as the user left it when they edited it by hand in between', () => {
    const handEdited = DRAFT.replace('## 三、风险', '## 三、风险与对策');
    const t = new Transcript('s1', '/w/p')
      .write(doc, DRAFT, null)
      .prompt('我手动改了标题，你再把计数改对')
      .edit(doc, handEdited, '以下三点', '以下两点', true);
    const [r] = findRevisions(parseClaudeCodeTranscript(t.text()), all);
    expect(r?.before).toBe(handEdited);
    expect(r?.after).toBe(handEdited.replace('以下三点', '以下两点'));
  });

  it('ignores a prompt followed by writes to files the model had not written before', () => {
    const t = new Transcript('s1', '/w/p').prompt('新写一篇').write(doc, DRAFT, null);
    expect(findRevisions(parseClaudeCodeTranscript(t.text()), all)).toEqual([]);
  });

  it('respects eligibility', () => {
    const t = new Transcript('s1', '/w/p').write(doc, DRAFT, null).prompt('改').edit(doc, DRAFT, '以下三点', '以下两点');
    expect(findRevisions(parseClaudeCodeTranscript(t.text()), { isEligible: () => false })).toEqual([]);
  });
});

describe('diffBlocks', () => {
  it('reports only the changed paragraph, with its heading path', () => {
    const d = diffBlocks(FIXED_COUNT, REWORDED_PLAN);
    expect(d.changes).toHaveLength(1);
    expect(d.changes[0]?.before).toContain('流程和现在一样');
    expect(d.changes[0]?.after).toContain('其余自动退款');
    expect(d.changes[0]?.headingPath).toEqual(['退货审核方案', '二、方案']);
    expect(d.changedRatio).toBeLessThan(0.6);
  });

  it('does not count rewrapping as a change', () => {
    expect(diffBlocks('# 标题\n\n一段话。\n', '# 标题\n\n一段话。\n\n').changes).toEqual([]);
  });

  it('sees a rewrite as mostly changed', () => {
    expect(diffBlocks('# A\n\n甲乙丙丁戊己庚辛。\n', '# B\n\n完全不同的另一段内容。\n').changedRatio).toBeGreaterThan(0.6);
  });
});

/* ------------------------------------------------------------------ mine() */

describe('mine', () => {
  let root: string;
  let project: string;
  let transcripts: string;
  let env: PathEnv;
  let doc: string;

  const config = (enabled: boolean, projects: string[]) =>
    resolveConfig({ projectRoot: null, project: null, user: { miner: { enabled, projects } } });

  const run = (over: Partial<Parameters<typeof mine>[0]> = {}) =>
    mine({ config: config(true, [project]), builtinRules, pathEnv: env, roots: [transcripts], ...over });

  const records = (): FeedbackRecord[] => {
    const f = path.join(root, 'data', 'feedback', 'feedback.jsonl');
    if (!existsSync(f)) return [];
    return readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as FeedbackRecord);
  };

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'lingspark-mine-'));
    project = path.join(root, 'proj');
    mkdirSync(path.join(project, 'docs'), { recursive: true });
    doc = path.join(project, 'docs', 'prd.md');
    transcripts = path.join(root, 'claude-projects');
    mkdirSync(path.join(transcripts, '-proj'), { recursive: true });
    env = { platform: process.platform, env: { LINGSPARK_DATA_DIR: path.join(root, 'data') }, homedir: root };

    const t = new Transcript('s1', project)
      .prompt('写一篇退货审核方案')
      .write(doc, DRAFT, null)
      .prompt('背景里说三点只列了两点，改一下', 'p-count')
      .edit(doc, DRAFT, '以下三点', '以下两点')
      .prompt('方案一节说得太笼统，写清楚哪些申请要人工复核', 'p-plan')
      .edit(doc, FIXED_COUNT, '先按规则自动审核，再人工复核，流程和现在一样。', '先按规则自动审核；审核不通过的申请才进入人工复核，其余自动退款。');
    writeFileSync(path.join(transcripts, '-proj', 's1.jsonl'), t.text());
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('does nothing while mining is off, and says why', async () => {
    expect((await mine({ config: config(false, [project]), builtinRules, pathEnv: env, roots: [transcripts] })).status).toBe('disabled');
    expect((await mine({ config: config(true, []), builtinRules, pathEnv: env, roots: [transcripts] })).status).toBe('no-projects');
    expect(records()).toEqual([]);
  });

  it('extracts one record per revision, with null classification', async () => {
    const r = await run();
    expect(r.status).toBe('ok');
    expect(r.records).toHaveLength(2);
    const [count, plan] = records();
    expect(count?.feedback).toBe('背景里说三点只列了两点，改一下');
    expect(count?.file).toBe('docs/prd.md');
    expect(count?.project).toBe(project);
    expect(count?.category).toBeNull();
    expect(count?.isRevision).toBeNull();
    expect(count?.id).toMatch(/^fb_[0-9A-HJKMNP-TV-Z]{26}$/u);
    expect(plan?.changes[0]?.headingPath).toEqual(['退货审核方案', '二、方案']);
  });

  it('records which rules already caught the problem, and which it missed', async () => {
    await run();
    const [count, plan] = records();
    // D111 fires on "以下三点" over two items: the rule already covers this.
    expect(count?.matchedRules).toContain('D111');
    expect(count?.missed).toBe(false);
    // Nothing fires on a vague plan paragraph: a miss for the slow loop.
    expect(plan?.matchedRules).toEqual([]);
    expect(plan?.missed).toBe(true);
  });

  it('never writes a duplicate on a re-run', async () => {
    await run();
    const second = await run();
    expect(second.transcriptsScanned).toBe(0); // unchanged file skipped outright
    expect(records()).toHaveLength(2);
  });

  it('picks up only the new revision when a transcript grows', async () => {
    await run();
    const more = new Transcript('s1', project)
      .prompt('风险一节补一句对策', 'p-risk')
      .edit(doc, REWORDED_PLAN, '上游数据延迟时，审核结果可能过期。', '上游数据延迟时，审核结果可能过期；超过五分钟自动转人工。');
    appendFileSync(path.join(transcripts, '-proj', 's1.jsonl'), more.text());
    const r = await run();
    expect(r.records.map((x) => x.promptId)).toEqual(['p-risk']);
    expect(records()).toHaveLength(3);
  });

  it('skips a rewrite', async () => {
    const t = new Transcript('s2', project)
      .write(doc, DRAFT, null)
      .prompt('整个重写', 'p-rw')
      .write(doc, '# 全新的文档\n\n和原来完全不一样的内容，一句都没留。\n', DRAFT);
    writeFileSync(path.join(transcripts, '-proj', 's2.jsonl'), t.text());
    const r = await run();
    expect(r.skippedRewrite).toBe(1);
    expect(r.records.some((x) => x.promptId === 'p-rw')).toBe(false);
  });

  it('ignores documents outside the authorised projects', async () => {
    const other = path.join(root, 'other', 'x.md');
    const t = new Transcript('s3', path.join(root, 'other'))
      .write(other, DRAFT, null)
      .prompt('改', 'p-other')
      .edit(other, DRAFT, '以下三点', '以下两点');
    writeFileSync(path.join(transcripts, '-proj', 's3.jsonl'), t.text());
    expect((await run()).records.some((x) => x.promptId === 'p-other')).toBe(false);
  });

  it('writes nothing on a dry run', async () => {
    const r = await run({ dryRun: true });
    expect(r.records).toHaveLength(2);
    expect(records()).toEqual([]);
    expect(existsSync(path.join(root, 'data', 'feedback', 'miner-state.json'))).toBe(false);
  });

  it('never modifies a transcript', async () => {
    const file = path.join(transcripts, '-proj', 's1.jsonl');
    const before = readFileSync(file, 'utf8');
    await run();
    expect(readFileSync(file, 'utf8')).toBe(before);
  });
});

describe('mine with classification (design doc, 9.5)', () => {
  let root: string;
  let project: string;
  let transcripts: string;
  let env: PathEnv;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'lingspark-classify-'));
    project = path.join(root, 'proj');
    mkdirSync(path.join(project, 'docs'), { recursive: true });
    transcripts = path.join(root, 'claude-projects');
    mkdirSync(path.join(transcripts, '-proj'), { recursive: true });
    env = { platform: process.platform, env: { LINGSPARK_DATA_DIR: path.join(root, 'data') }, homedir: root };
    const doc = path.join(project, 'docs', 'prd.md');
    const t = new Transcript('s1', project)
      .write(doc, DRAFT, null)
      .prompt('背景里说三点只列了两点，改一下', 'p-fix')
      .edit(doc, DRAFT, '以下三点', '以下两点')
      .prompt('顺便把风险一节也加一句对策', 'p-new')
      .edit(doc, FIXED_COUNT, '上游数据延迟时，审核结果可能过期。', '上游数据延迟时，审核结果可能过期；超过五分钟自动转人工。');
    writeFileSync(path.join(transcripts, '-proj', 's1.jsonl'), t.text());
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const config = () => resolveConfig({ projectRoot: null, project: null, user: { miner: { enabled: true, projects: [project] } } });
  /** Says "revision, logic" for the count complaint and "not a revision" for the new request. */
  const judge = () =>
    new MockJudge((state, name) => {
      const isFix = state.includes('三点只列了两点');
      if (name === 'isRevision') return isFix ? 0.93 : 0.1;
      return { type: 'choice', choice: 'logic', probabilities: { logic: 0.8 }, confidence: 0.8 };
    });
  const records = (): FeedbackRecord[] =>
    readFileSync(path.join(root, 'data', 'feedback', 'feedback.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as FeedbackRecord);

  it('classifies revisions and drops what is not feedback on the writing', async () => {
    const j = judge();
    const r = await mine({ config: config(), builtinRules, pathEnv: env, roots: [transcripts], judge: j });
    expect(r.records.map((x) => x.promptId)).toEqual(['p-fix']);
    expect(r.skippedNotRevision).toBe(1);
    const [rec] = records();
    expect(rec?.category).toBe('logic');
    expect(rec?.isRevision).toBe(0.93);
    // Only the user's words and the changed blocks are sent, never the document.
    expect(j.calls.every((c) => !c.state.includes('## 三、风险'))).toBe(true);
  });

  it('backfills records a judge-less run left unclassified', async () => {
    await mine({ config: config(), builtinRules, pathEnv: env, roots: [transcripts] });
    expect(records().every((x) => x.category === null)).toBe(true);
    expect(records()).toHaveLength(2);
    const r = await mine({ config: config(), builtinRules, pathEnv: env, roots: [transcripts], judge: judge() });
    expect(r.backfilled).toBe(2);
    expect(records().map((x) => [x.promptId, x.category])).toEqual([['p-fix', 'logic']]);
  });
});

describe('ulid', () => {
  it('sorts by time and is 26 Crockford characters', () => {
    const a = ulid(1_000);
    const b = ulid(2_000);
    expect(a).toHaveLength(26);
    expect(a < b).toBe(true);
  });
});
