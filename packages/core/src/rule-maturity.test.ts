import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { recordIntercepts } from './intercepts.js';
import { listFalsePositives, recordFalsePositive } from './feedback.js';
import { formatRuleMaturity, MIN_JUDGMENTS, ruleMaturity } from './rule-maturity.js';
import type { PathEnv } from './paths.js';

describe('false-positive budget and rule maturity (D-086)', () => {
  let root: string;
  let env: PathEnv;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'lingspark-maturity-'));
    env = { platform: 'linux', env: { XDG_DATA_HOME: root }, homedir: root };
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('records and lists false-positive marks', () => {
    recordFalsePositive('S204', 'fp1', env);
    recordFalsePositive('S204', 'fp1', env); // same mark twice: dedup happens in maturity, not here
    expect(listFalsePositives(env)).toHaveLength(2);
    expect(listFalsePositives(env)[0]).toMatchObject({ ruleId: 'S204', fingerprint: 'fp1' });
    expect(listFalsePositives({ platform: 'linux', env: {}, homedir: path.join(root, 'nope') })).toEqual([]);
  });

  const diag = (file: string, line: number, ruleId: string, fp: string) => ({
    file,
    range: { start: { line, column: 1 }, end: { line, column: 2 } },
    ruleId,
    severity: 'warning' as const,
    message: 'm',
    fingerprint: fp,
  });

  it('joins shown and wrong into a per-rule suggestion', () => {
    for (let i = 0; i < MIN_JUDGMENTS; i++) {
      recordIntercepts('claude-code', 'stop', [diag('/a.md', i + 1, 'S201', `s201-${String(i)}`)], env);
    }
    recordIntercepts('claude-code', 'stop', [diag('/a.md', 1, 'S204', 's204-a'), diag('/a.md', 2, 'S204', 's204-b')], env);
    // S201: one fp in 30 shown -> 3.3% -> 保持提示. S204: too few judgments.
    recordFalsePositive('S201', 's201-0', env);

    const rows = ruleMaturity(env);
    const s201 = rows.find((r) => r.ruleId === 'S201');
    expect(s201).toMatchObject({ shown: MIN_JUDGMENTS, wrong: 1, suggestion: '保持提示' });
    const s204 = rows.find((r) => r.ruleId === 'S204');
    expect(s204).toMatchObject({ shown: 2, suggestion: '数据不足' });
  });

  it('suggests demotion at the warn budget and promotion at the error budget', () => {
    for (let i = 0; i < MIN_JUDGMENTS; i++) {
      recordIntercepts('claude-code', 'stop', [diag('/a.md', i + 1, 'S203', `s203-${String(i)}`)], env);
      recordIntercepts('claude-code', 'stop', [diag('/a.md', i + 1, 'S205', `s205-${String(i)}`)], env);
    }
    // S203: 4/30 wrong = 13.3% -> 建议降级为影子.
    for (let i = 0; i < 4; i++) recordFalsePositive('S203', `s203-${String(i)}`, env);
    // S205: 0/30 wrong -> 可拦报.
    const rows = ruleMaturity(env);
    expect(rows.find((r) => r.ruleId === 'S203')?.suggestion).toBe('建议降级为影子');
    expect(rows.find((r) => r.ruleId === 'S205')?.suggestion).toBe('可拦报');
  });

  it('dedups fingerprints across repeated showings and formats the table', () => {
    recordIntercepts('claude-code', 'stop', [diag('/a.md', 1, 'S201', 'fp-x')], env);
    recordIntercepts('claude-code', 'stop', [diag('/a.md', 1, 'S201', 'fp-x')]); // no env: another dir, ignored
    recordIntercepts('claude-code', 'stop', [diag('/a.md', 1, 'S201', 'fp-x')], env); // same fp again: once
    const text = formatRuleMaturity(ruleMaturity(env));
    expect(text).toContain('规则成熟度');
    expect(text).toContain('S201');
    expect(text).toContain('数据不足');
    expect(text).toContain('1');
  });
});
