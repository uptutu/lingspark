import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from '../config/resolve.js';
import { loadRules } from './load.js';
import { buildGlossary, EMPTY_GLOSSARY, type Glossary } from './glossary.js';
import { runRuleExamples, summarizeExamples } from './examples.js';
import { existsSync } from 'node:fs';
import { ReplayJudge } from '../judge/mock.js';
import type { Rule } from './schema.js';
import './deterministic/index.js';

const RULES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../rules-builtin/rules',
);

function builtinSources(): { file: string; yaml: string }[] {
  return readdirSync(RULES_DIR)
    .filter((n) => n.endsWith('.yaml'))
    .sort()
    .map((n) => ({ file: path.join(RULES_DIR, n), yaml: readFileSync(path.join(RULES_DIR, n), 'utf8') }));
}

/**
 * Glossary used when exercising D102's examples. It lives here rather than in
 * the rule file so the rule schema stays about rules; the terms mirror the
 * example in section 6.2 of the design doc.
 */
const D102_GLOSSARY: Glossary = buildGlossary([
  {
    preferred: '日活跃用户',
    aliases_allowed: ['DAU'],
    forbidden: ['日活用户', '每日活跃', '日活跃'],
    definition: '当日至少打开一次 App 的去重用户数',
  },
]);

const glossaryFor = (ruleId: string): Glossary =>
  ruleId === 'D102' ? D102_GLOSSARY : EMPTY_GLOSSARY;

const config = resolveConfig({ projectRoot: '/p', project: null, user: null });

function loadAll(): Map<string, Rule> {
  const { rules, warnings } = loadRules({
    config,
    builtin: builtinSources(),
    personalDir: path.join(RULES_DIR, '__none__'),
    teamDir: path.join(RULES_DIR, '__none__'),
  });
  expect(warnings).toEqual([]);
  return new Map(rules);
}

describe('builtin rule files', () => {
  const rules = loadAll();

  it('all pass schema validation', () => {
    expect(rules.size).toBe(builtinSources().length);
  });

  it('every deterministic rule points at a registered impl', async () => {
    for (const rule of rules.values()) {
      if (rule.kind !== 'deterministic') continue;
      expect(rule.impl, `${rule.id} 没有 impl`).toBeDefined();
      const results = await runRuleExamples(rule, { config, glossary: glossaryFor(rule.id) });
      const unregistered = results.filter((r) => r.skippedReason?.includes('没有注册'));
      expect(unregistered, `${rule.id} 的 impl 未注册`).toEqual([]);
    }
  });

  it('every rule declares at least 5 positive and 5 negative examples', () => {
    for (const rule of rules.values()) {
      expect(rule.examples.positive.length, `${rule.id} 正例不足`).toBeGreaterThanOrEqual(5);
      expect(rule.examples.negative.length, `${rule.id} 反例不足`).toBeGreaterThanOrEqual(5);
    }
  });

  it('rule ids match their file names', () => {
    for (const rule of rules.values()) {
      expect(path.basename(rule.sourcePath)).toBe(`${rule.id}.yaml`);
    }
  });
});

/**
 * Recorded judge answers for the judge rules' examples, made with
 * `lingspark eval --backend <b> --record --fixtures packages/rules-builtin/fixtures/replay`,
 * which writes one subdirectory per backend. CI only ever replays them
 * (design doc, 10.4). The first recorded backend, by name, is the reference.
 */
const FIXTURES = path.resolve(RULES_DIR, '..', 'fixtures', 'replay');
const reference = existsSync(FIXTURES)
  ? readdirSync(FIXTURES)
      .sort()
      .map((d) => path.join(FIXTURES, d))
      .find((d) => existsSync(path.join(d, 'manifest.json')))
  : undefined;
const replay =
  reference === undefined
    ? null
    : (() => {
        const m = JSON.parse(readFileSync(path.join(reference, 'manifest.json'), 'utf8')) as { judgeId: string; calibrated: boolean };
        return new ReplayJudge(reference, m.judgeId, m.calibrated);
      })();

describe('builtin rule examples', () => {
  const rules = loadAll();

  for (const rule of [...rules.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const needsRecording = rule.kind === 'judge' && replay === null;
    describe(`${rule.id} ${rule.name}`, () => {
      // Judge rules without recorded answers cannot be evaluated offline.
      // Skipped, visibly, rather than passed.
      it.skipIf(needsRecording)('produces no diagnostic on any negative example', async () => {
        const results = await runRuleExamples(rule, { config, glossary: glossaryFor(rule.id), judge: replay });
        const skipped = results.filter((r) => r.skippedReason !== undefined).map((r) => `${r.kind}#${r.index}: ${r.skippedReason ?? ''}`);
        expect(skipped, `${rule.id} 有例子没能运行`).toEqual([]);
        const failures = results
          .filter((r) => r.kind === 'negative' && !r.passed)
          .map((r) => `#${r.index} ${r.note}: ${r.probability !== undefined ? `p=${r.probability.toFixed(2)}` : r.diagnostics.map((d) => d.message).join(' / ')}`);
        expect(failures, `${rule.id} 反例误报`).toEqual([]);
      });

      // A shadow rule is one that has not cleared this bar yet: it runs, its
      // findings are logged and never shown (design doc, 10.4).
      it.skipIf(needsRecording || rule.status === 'shadow')('hits at least 60% of its positive examples', async () => {
        const results = await runRuleExamples(rule, { config, glossary: glossaryFor(rule.id), judge: replay });
        const summary = summarizeExamples(rule.id, results);
        const recall = summary.positiveHit / Math.max(summary.positiveTotal, 1);
        const misses = results
          .filter((r) => r.kind === 'positive' && !r.passed)
          .map((r) => `#${r.index} ${r.note}`);
        expect(
          recall,
          `${rule.id} 正例召回 ${summary.positiveHit}/${summary.positiveTotal}，漏报：${misses.join('; ')}`,
        ).toBeGreaterThanOrEqual(0.6);
      });
    });
  }
});
