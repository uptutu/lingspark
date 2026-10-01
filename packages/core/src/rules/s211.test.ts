import { describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from '../config/resolve.js';
import { JudgeCache } from '../judge/cache.js';
import { MockJudge } from '../judge/mock.js';
import { parseDocument } from '../parser/parse.js';
import { runPass2 } from '../passes/pass2.js';
import type { PathEnv } from '../paths.js';
import { loadRules } from './load.js';
import type { Rule } from './schema.js';
import './deterministic/index.js';

const RULES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../rules-builtin/rules',
);

function loadBuiltin(): Map<string, Rule> {
  const { rules, warnings } = loadRules({
    config: resolveConfig({ projectRoot: '/p', project: null, user: null }),
    builtin: readdirSync(RULES_DIR)
      .filter((n) => n.endsWith('.yaml'))
      .sort()
      .map((n) => ({ file: path.join(RULES_DIR, n), yaml: readFileSync(path.join(RULES_DIR, n), 'utf8') })),
    personalDir: path.join(RULES_DIR, '__none__'),
    teamDir: path.join(RULES_DIR, '__none__'),
  });
  expect(warnings).toEqual([]);
  return new Map(rules);
}

const config = resolveConfig({ projectRoot: '/p', project: null, user: null });

// Judge answers persist to disk by default; tests must not share a cache
// (or leak into the real one), so each run gets its own throwaway data dir.
function freshCache(): JudgeCache {
  const root = mkdtempSync(path.join(tmpdir(), 'lingspark-s211-'));
  const env: PathEnv = { platform: 'linux', env: { XDG_DATA_HOME: root }, homedir: root };
  return new JudgeCache(env);
}

const DOC = [
  '# 项目计划',
  '',
  '## 范围',
  '',
  '本期只做 Web 端，不做移动端。',
  '',
  '## 发布计划',
  '',
  'App 商店审核通过后，iOS 版本随本期一同上线。',
].join('\n');

/**
 * D-089: S211 judges each section against the accumulated text before it.
 * The prior text is context, not the object of judgement, so the state the
 * judge sees carries a 【前文】 marker. Shadow status: hits are logged, never
 * shown.
 */
describe('S211 章节与前言冲突 (shadow, section-cross)', () => {
  const rules = loadBuiltin();

  it('sends each section a state that includes the prior text as 【前文】', async () => {
    const doc = parseDocument(DOC, { file: 's211.test.md' });
    const judge = new MockJudge(() => 0.1);
    await runPass2({ doc, config, rules, judge, cache: freshCache(), budgetMs: 30_000 });

    // 范围 and 发布计划 are both real sections; the h1 title is not asked.
    expect(judge.calls.length).toBeGreaterThanOrEqual(2);
    const states = judge.calls.map((c) => c.state);
    const cross = states.filter((s) => s.includes('【前文】'));
    expect(cross.length).toBe(2);
    // The second section's 前文 contains the first section's content.
    const second = cross.find((s) => s.includes('发布计划'));
    expect(second).toBeDefined();
    expect(second).toContain('本期只做 Web 端，不做移动端。');
    // The state carries the section markers the rule's question names.
    expect(second).toContain('【章节标题】');
    expect(second).toContain('【章节内容】');
  });

  it('a confident hit goes to shadowDiagnostics, not diagnostics', async () => {
    const doc = parseDocument(DOC, { file: 's211.test.md' });
    const judge = new MockJudge((_state, name) => (name === 'S211' ? 0.9 : 0));
    const res = await runPass2({ doc, config, rules, judge, cache: freshCache(), budgetMs: 30_000 });
    expect(res.diagnostics.filter((d) => d.ruleId === 'S211')).toEqual([]);
    expect(res.shadowDiagnostics.map((d) => d.ruleId)).toContain('S211');
  });

  it('a document with only a title and body asks no section-cross question', async () => {
    const doc = parseDocument('# 标题\n\n只有标题和正文，没有小节。', { file: 's211.test.md' });
    const judge = new MockJudge(() => 0.9);
    const res = await runPass2({ doc, config, rules, judge, cache: freshCache(), budgetMs: 30_000 });
    expect(judge.calls.filter((c) => c.state.includes('【前文】'))).toEqual([]);
    expect(res.shadowDiagnostics.filter((d) => d.ruleId === 'S211')).toEqual([]);
  });
});
