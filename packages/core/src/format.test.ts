import { describe, expect, it } from 'vitest';
import path from 'node:path';
import type { FileCheckResult } from './check.js';
import { formatAmberText, formatResultsJson, formatResultsText } from './format.js';

const result = (uncertain: FileCheckResult['uncertain']): FileCheckResult => ({
  absPath: '/p/docs/a.md',
  docType: 'generic',
  diagnostics: [],
  shadowDiagnostics: [],
  suppressedCount: 0,
  passesRun: [0, 1, 2],
  warnings: [],
  uncertain,
});

describe('amber list formatting (D-090)', () => {
  it('is empty when nothing is uncertain', () => {
    expect(formatAmberText([result([])], '/p')).toBe('');
  });

  it('lists uncertain items with probability in the text report', () => {
    const r = result([{ ruleId: 'S201', probability: 0.55, range: { start: { line: 3, column: 1 }, end: { line: 3, column: 5 } }, state: 'x' }]);
    const text = formatResultsText([r], '/p');
    expect(text).toContain('琥珀清单');
    expect(text).toContain(`docs${path.sep}a.md:3 [S201] 把握 55%`);
  });

  it('carries amber into the JSON report', () => {
    const r = result([{ ruleId: 'S204', probability: 0.41, range: { start: { line: 9, column: 1 }, end: { line: 9, column: 5 } }, state: 'y' }]);
    const json = JSON.parse(formatResultsJson([r], '/p')) as {
      files: { amber: { line: number; ruleId: string; probability: number }[] }[];
    };
    expect(json.files[0]?.amber).toEqual([{ line: 9, ruleId: 'S204', probability: 0.41 }]);
  });
});
