import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { Diagnostic } from './diagnostics/types.js';
import { createChecker } from './check.js';
import { dataPaths, type PathEnv } from './paths.js';
import { formatShadowReport, recordShadowHits, shadowReport } from './shadow-report.js';

const diag = (file: string, line: number, ruleId: string, fingerprint: string): Diagnostic => ({
  file,
  range: { start: { line, column: 1 }, end: { line, column: 5 } },
  ruleId,
  severity: 'warning',
  message: 'shadow',
  fingerprint,
});

const hit = (ts: string, file: string, line: number, ruleId: string, fingerprint: string): string =>
  JSON.stringify({ ts, file, line, ruleId, fingerprint });

describe('shadow-report (D-085)', () => {
  let root: string;
  let env: PathEnv;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'lingspark-shadow-'));
    env = { platform: 'linux', env: { XDG_DATA_HOME: root }, homedir: root };
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const readLog = (): unknown[] =>
    readFileSync(dataPaths.shadowHits(env), 'utf8')
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l) as unknown);

  const writeLog = (lines: readonly string[]): void => {
    mkdirSync(path.dirname(dataPaths.shadowHits(env)), { recursive: true });
    writeFileSync(dataPaths.shadowHits(env), `${lines.join('\n')}\n`, 'utf8');
  };

  it('records one JSONL line per hit with rule, file, line, fingerprint', () => {
    recordShadowHits([diag('/docs/a.md', 3, 'S206', 'fp1'), diag('/docs/a.md', 9, 'S206', 'fp2')], env);
    const lines = readLog();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ file: '/docs/a.md', line: 3, ruleId: 'S206', fingerprint: 'fp1' });
    expect(typeof (lines[0] as { ts: unknown }).ts).toBe('string');
  });

  it('never throws on an unwritable data dir', () => {
    rmSync(root, { recursive: true, force: true });
    expect(() => recordShadowHits([diag('/a.md', 1, 'S206', 'fp')], env)).not.toThrow();
  });

  it('counts the same fingerprint on the same day once, across repeated runs', () => {
    // now is local: late enough to be after every timestamp below (08:00Z = 16:00 local at UTC+8).
    const now = new Date('2026-09-30T23:59:59');
    // The same hit recorded twice (write-check then Stop-check): two lines, one hit.
    writeLog([
      hit('2026-09-30T08:00:00.000Z', '/docs/a.md', 3, 'S206', 'fp1'),
      hit('2026-09-30T09:00:00.000Z', '/docs/a.md', 3, 'S206', 'fp1'),
      hit('2026-09-29T08:00:00.000Z', '/docs/a.md', 3, 'S206', 'fp1'),
      hit('2026-09-30T08:00:00.000Z', '/docs/b.md', 7, 'G301', 'fp2'),
    ]);
    const report = shadowReport({ env, now, days: 7 });
    const s206 = report.rules.find((r) => r.ruleId === 'S206');
    expect(s206).toMatchObject({ hits: 2, files: 1 }); // two days, one file
    const g301 = report.rules.find((r) => r.ruleId === 'G301');
    expect(g301).toMatchObject({ hits: 1, files: 1 });
    expect(report.rules[0]?.ruleId).toBe('S206'); // sorted by hits desc
    expect(s206?.lastSeen).toBe('2026-09-30T09:00:00.000Z');
  });

  it('excludes hits outside the window and future hits', () => {
    const now = new Date('2026-09-30T12:00:00');
    writeLog([
      hit('2026-09-20T08:00:00.000Z', '/a.md', 1, 'S206', 'old'),
      hit('2026-10-01T08:00:00.000Z', '/a.md', 1, 'S206', 'future'),
      hit('2026-09-29T08:00:00.000Z', '/a.md', 1, 'S206', 'in'),
    ]);
    const report = shadowReport({ env, now, days: 7 });
    expect(report.rules).toHaveLength(1);
    expect(report.rules[0]).toMatchObject({ ruleId: 'S206', hits: 1 });
  });

  it('tolerates a missing log and malformed lines', () => {
    expect(shadowReport({ env }).rules).toHaveLength(0);
    writeLog(['not json', '{"noTs": true}']);
    expect(shadowReport({ env }).rules).toHaveLength(0);
  });

  it('formats an empty and a populated report', () => {
    const now = new Date('2026-09-30T23:59:59');
    writeLog([hit('2026-09-30T08:00:00.000Z', '/docs/a.md', 3, 'S206', 'fp1')]);
    const text = formatShadowReport(shadowReport({ env, now, days: 7 }));
    expect(text).toContain('影子规则命中报告（最近 7 天）');
    expect(text).toContain('[S206] 命中 1 次，涉及 1 个文件，最近：2026-09-30');
    const elsewhere: PathEnv = { platform: 'linux', env: {}, homedir: path.join(root, 'elsewhere') };
    expect(formatShadowReport(shadowReport({ env: elsewhere, days: 7 }))).toContain('没有影子规则命中');
  });

  it('a checker run records its shadow hits to the log (the check.ts wiring)', async () => {
    const yaml = [
      'id: X901',
      'version: 1',
      'name: 占位符（影子）',
      'pass: 1',
      'kind: deterministic',
      'impl: placeholder-left',
      'severity: error',
      'scope: document',
      'doc_types: [generic]',
      'status: shadow',
      'origin: builtin',
      "message: '占位符：{match}'",
      'suggestion: 补全内容。',
    ].join('\n');
    const checker = createChecker({
      builtinRules: [{ file: 'X901.yaml', yaml }],
      judge: null,
      pathEnv: env,
    });
    const r = await checker.checkSource('TODO: 补充回滚方案。\n', path.join(root, 'doc.md'));
    expect(r.shadowDiagnostics.length).toBeGreaterThan(0);
    expect(r.diagnostics).toHaveLength(0); // shadow means: recorded, never shown
    const lines = readLog();
    expect(lines).toHaveLength(r.shadowDiagnostics.length);
    expect(lines[0]).toMatchObject({ ruleId: 'X901', file: path.join(root, 'doc.md') });
  });
});
