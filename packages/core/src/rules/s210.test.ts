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
function freshCache(): { cache: JudgeCache; env: PathEnv } {
  const root = mkdtempSync(path.join(tmpdir(), 'lingspark-s210-'));
  const env: PathEnv = { platform: 'linux', env: { XDG_DATA_HOME: root }, homedir: root };
  return { cache: new JudgeCache(env), env };
}

/**
 * D-088, layer L3: S210 asks the judge whether two differently-worded numeric
 * phrases in one paragraph are the same metric with different values. It is a
 * shadow rule, so a hit must land in `shadowDiagnostics` (logged, never shown)
 * and must not produce user-facing `diagnostics`.
 */
describe('S210 同一指标换说法后数值对不上 (shadow)', () => {
  const rules = loadBuiltin();

  it('a confident hit goes to shadowDiagnostics, not diagnostics', async () => {
    const doc = parseDocument('峰值 QPS 预计为 2000，而系统的每秒请求处理能力按 3000 设计。', {
      file: 's210.test.md',
    });
    const judge = new MockJudge((_state, name) => (name === 'S210' ? 0.9 : 0));
    const res = await runPass2({
      doc,
      config,
      rules,
      judge,
      cache: freshCache().cache,
      budgetMs: 30_000,
    });
    expect(res.diagnostics).toEqual([]);
    expect(res.shadowDiagnostics.map((d) => d.ruleId)).toContain('S210');
  });

  it('a middling answer is reported as uncertain, not a shadow hit', async () => {
    const doc = parseDocument('峰值 QPS 预计为 2000，而系统的每秒请求处理能力按 3000 设计。', {
      file: 's210.test.md',
    });
    const judge = new MockJudge((_state, name) => (name === 'S210' ? 0.5 : 0));
    const res = await runPass2({
      doc,
      config,
      rules,
      judge,
      cache: freshCache().cache,
      budgetMs: 30_000,
    });
    expect(res.diagnostics).toEqual([]);
    expect(res.shadowDiagnostics).toEqual([]);
    expect(res.uncertain.map((u) => u.ruleId)).toContain('S210');
  });

  it('a confident miss produces nothing at all', async () => {
    const doc = parseDocument('接口超时设为 30 秒，重试间隔是 5 秒。', { file: 's210.test.md' });
    const judge = new MockJudge(() => 0.1);
    const res = await runPass2({
      doc,
      config,
      rules,
      judge,
      cache: freshCache().cache,
      budgetMs: 30_000,
    });
    expect(res.diagnostics).toEqual([]);
    expect(res.shadowDiagnostics).toEqual([]);
    expect(res.uncertain).toEqual([]);
  });
});
