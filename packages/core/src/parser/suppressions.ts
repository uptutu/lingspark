import type { Suppression } from './types.js';

const DIRECTIVE =
  /^<!--\s*lingspark-(disable-next-line|disable|enable)(?<ids>[^->]*?)\s*-->$/u;

export interface ParsedDirective {
  readonly directive: 'disable-next-line' | 'disable' | 'enable';
  /** null means "every rule". */
  readonly ruleIds: readonly string[] | null;
}

/** Recognises `<!-- lingspark-disable S201, S203 -->` and friends. */
export function parseDirective(html: string): ParsedDirective | null {
  const m = DIRECTIVE.exec(html.trim());
  if (m === null) return null;
  const directive = m[1] as ParsedDirective['directive'];
  const rawIds = (m.groups?.['ids'] ?? '').trim();
  if (rawIds === '') return { directive, ruleIds: null };
  const ruleIds = rawIds
    .split(/[\s,]+/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return { directive, ruleIds: ruleIds.length > 0 ? ruleIds : null };
}

interface OpenRange {
  readonly ruleIds: readonly string[] | null;
  readonly fromLine: number;
  readonly commentLine: number;
}

export interface DirectiveAt extends ParsedDirective {
  readonly line: number;
}

/**
 * Turns the directives found in a document into line ranges.
 *
 * `disable-next-line` is resolved against `blockStartLines`: the intent is
 * "the next thing I wrote", not literally the next line, and a blank line
 * between the comment and the paragraph is normal Markdown.
 *
 * An `enable` closes every open `disable` whose rule set overlaps it (a bare
 * `enable` closes all of them). Overlapping disables of different rules are
 * rare enough that a more clever rule would cost more in surprise than it
 * saves.
 */
export function buildSuppressions(
  directives: readonly DirectiveAt[],
  blockStartLines: readonly number[],
  lastLine: number,
): Suppression[] {
  const out: Suppression[] = [];
  const open: OpenRange[] = [];

  const overlaps = (a: readonly string[] | null, b: readonly string[] | null): boolean =>
    a === null || b === null || a.some((id) => b.includes(id));

  for (const d of directives) {
    switch (d.directive) {
      case 'disable-next-line': {
        const target = blockStartLines.find((l) => l > d.line) ?? d.line + 1;
        out.push({
          kind: 'next-line',
          ruleIds: d.ruleIds,
          fromLine: target,
          toLine: target,
          commentLine: d.line,
        });
        break;
      }
      case 'disable':
        open.push({ ruleIds: d.ruleIds, fromLine: d.line + 1, commentLine: d.line });
        break;
      case 'enable': {
        for (let i = open.length - 1; i >= 0; i--) {
          const o = open[i];
          if (o === undefined) continue;
          if (!overlaps(o.ruleIds, d.ruleIds)) continue;
          out.push({
            kind: 'range',
            ruleIds: o.ruleIds,
            fromLine: o.fromLine,
            toLine: Math.max(o.fromLine, d.line - 1),
            commentLine: o.commentLine,
          });
          open.splice(i, 1);
        }
        break;
      }
    }
  }

  // An unmatched `disable` runs to the end of the file, which is what a reader
  // of the comment would expect.
  for (const o of open) {
    out.push({
      kind: 'range',
      ruleIds: o.ruleIds,
      fromLine: o.fromLine,
      toLine: lastLine,
      commentLine: o.commentLine,
    });
  }

  return out;
}

/** Whether a diagnostic for `ruleId` at `line` has been silenced. */
export function isSuppressed(
  suppressions: readonly Suppression[],
  ruleId: string,
  line: number,
): boolean {
  return suppressions.some(
    (s) =>
      line >= s.fromLine &&
      line <= s.toLine &&
      (s.ruleIds === null || s.ruleIds.includes(ruleId)),
  );
}
