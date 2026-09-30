import type { ResolvedConfig } from '../config/schema.js';
import type { Diagnostic } from '../diagnostics/types.js';
import type { ParsedDoc } from '../parser/types.js';
import { isSuppressed } from '../parser/suppressions.js';
import { getDeterministic, type RuleContext } from '../rules/context.js';
import type { Glossary } from '../rules/glossary.js';
import { selectRules } from '../rules/load.js';
import type { Rule } from '../rules/schema.js';
import { msg } from '../messages.js';

export interface PassResult {
  readonly diagnostics: readonly Diagnostic[];
  /** Shadow-status rules report here instead, for stats only. */
  readonly shadowDiagnostics: readonly Diagnostic[];
  /** Diagnostics dropped by an inline suppression comment, for the weekly report. */
  readonly suppressedCount: number;
  readonly warnings: readonly string[];
}

export interface Pass1Options {
  readonly doc: ParsedDoc;
  readonly config: ResolvedConfig;
  readonly rules: ReadonlyMap<string, Rule>;
  readonly glossary: Glossary;
}

/**
 * Pass 1: every deterministic rule, no model involved (design doc, 6.2).
 *
 * A rule that throws is dropped with a warning rather than allowed to fail the
 * run. One bad rule must not cost the user the other ten, and on the hook path
 * it must not cost them the check at all (design principle 2).
 */
export function runPass1(opts: Pass1Options): PassResult {
  const { doc, config, rules, glossary } = opts;
  const diagnostics: Diagnostic[] = [];
  const shadowDiagnostics: Diagnostic[] = [];
  const warnings: string[] = [];
  let suppressedCount = 0;

  const selected = selectRules(rules, {
    pass: 1,
    docType: doc.docType,
    includeShadow: true,
  });

  for (const rule of selected) {
    if (rule.kind !== 'deterministic' || rule.impl === undefined) continue;

    const impl = getDeterministic(rule.impl);
    if (impl === undefined) {
      warnings.push(msg.rules.missingImpl(rule.id, rule.impl));
      continue;
    }

    const ctx: RuleContext = { doc, config, glossary, rule };
    let produced: Diagnostic[];
    try {
      produced = impl(ctx);
    } catch (err: unknown) {
      warnings.push(msg.rules.threw(rule.id, String(err)));
      continue;
    }

    const sink = rule.status === 'shadow' ? shadowDiagnostics : diagnostics;
    for (const d of produced) {
      if (
        config.allowInlineSuppress &&
        isSuppressed(doc.suppressions, d.ruleId, d.range.start.line)
      ) {
        suppressedCount++;
        continue;
      }
      sink.push(d);
    }
  }

  diagnostics.sort(compareDiagnostics);
  shadowDiagnostics.sort(compareDiagnostics);
  return { diagnostics, shadowDiagnostics, suppressedCount, warnings };
}

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 } as const;

/** Most severe first, then by position, then by rule id: a stable reading order. */
export function compareDiagnostics(a: Diagnostic, b: Diagnostic): number {
  const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
  if (bySeverity !== 0) return bySeverity;
  if (a.range.start.line !== b.range.start.line) return a.range.start.line - b.range.start.line;
  if (a.range.start.column !== b.range.start.column) {
    return a.range.start.column - b.range.start.column;
  }
  return a.ruleId.localeCompare(b.ruleId);
}
