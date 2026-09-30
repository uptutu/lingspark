import path from 'node:path';
import type { FileCheckResult } from './check.js';
import type { Diagnostic } from './diagnostics/types.js';
import { msg } from './messages.js';

/** Path shown to a human: relative to where they ran the command. */
export function displayPath(absPath: string, cwd: string): string {
  const rel = path.relative(cwd, absPath);
  return rel === '' || rel.startsWith('..') ? absPath : rel;
}

/**
 * One diagnostic in the compiler-style text format (design doc, 5.2):
 * `file:line:col: severity[RULE] message`, with an indented suggestion line.
 */
export function formatDiagnosticText(d: Diagnostic, shownPath: string): string {
  const prob = d.probability !== undefined ? ` ${msg.check.probability(d.probability)}` : '';
  const head =
    `${shownPath}:${String(d.range.start.line)}:${String(d.range.start.column)}: ` +
    `${d.severity}[${d.ruleId}] ${d.message}${prob}`;
  return d.suggestion !== undefined ? `${head}\n    ${msg.check.suggestion(d.suggestion)}` : head;
}

export interface Tally {
  readonly errors: number;
  readonly warnings: number;
  readonly infos: number;
}

export function tally(results: readonly FileCheckResult[]): Tally {
  let errors = 0;
  let warnings = 0;
  let infos = 0;
  for (const r of results) {
    for (const d of r.diagnostics) {
      if (d.severity === 'error') errors++;
      else if (d.severity === 'warning') warnings++;
      else infos++;
    }
  }
  return { errors, warnings, infos };
}

export function formatResultsText(results: readonly FileCheckResult[], cwd: string): string {
  const lines: string[] = [];
  for (const r of results) {
    const shown = displayPath(r.absPath, cwd);
    if (r.skipped !== undefined) {
      lines.push(`${shown}: ${msg.check.skipped[r.skipped] ?? r.skipped}`);
      continue;
    }
    for (const d of r.diagnostics) lines.push(formatDiagnosticText(d, shown));
  }
  const t = tally(results);
  if (lines.length > 0) lines.push('');
  lines.push(msg.check.summary(results.length, t.errors, t.warnings, t.infos));
  return lines.join('\n');
}

/** Machine-readable output. Paths are made relative so the output is portable. */
export function formatResultsJson(results: readonly FileCheckResult[], cwd: string): string {
  const files = results.map((r) => ({
    file: displayPath(r.absPath, cwd),
    docType: r.docType,
    passesRun: r.passesRun,
    ...(r.skipped !== undefined ? { skipped: r.skipped } : {}),
    suppressedCount: r.suppressedCount,
    diagnostics: r.diagnostics.map((d) => ({
      ...d,
      file: displayPath(path.resolve(d.file), cwd),
      related: d.related?.map((x) => ({ ...x, file: displayPath(path.resolve(x.file), cwd) })),
    })),
  }));
  return JSON.stringify({ files, summary: tally(results) }, null, 2);
}
