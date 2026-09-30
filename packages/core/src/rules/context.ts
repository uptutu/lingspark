import type { ResolvedConfig } from '../config/schema.js';
import type { Diagnostic, RelatedLocation } from '../diagnostics/types.js';
import { fingerprintOf } from '../diagnostics/fingerprint.js';
import type { ParsedDoc, Range } from '../parser/types.js';
import type { Glossary } from './glossary.js';
import type { Rule } from './schema.js';
import { msg } from '../messages.js';

export interface RuleContext {
  readonly doc: ParsedDoc;
  readonly config: ResolvedConfig;
  readonly glossary: Glossary;
  readonly rule: Rule;
}

/** A deterministic rule: pure, synchronous, no network (design doc, 6.2). */
export type DeterministicImpl = (ctx: RuleContext) => Diagnostic[];

const registry = new Map<string, DeterministicImpl>();

/** Registers a rule implementation under the name its YAML's `impl` refers to. */
export function registerDeterministic(name: string, impl: DeterministicImpl): void {
  if (registry.has(name)) throw new Error(msg.rules.duplicateImpl(name));
  registry.set(name, impl);
}

export function getDeterministic(name: string): DeterministicImpl | undefined {
  return registry.get(name);
}

export function registeredDeterministicNames(): string[] {
  return [...registry.keys()].sort();
}

/** Fills `{placeholder}` slots in a rule's message or suggestion. */
export function interpolate(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/gu, (whole, key: string) => values[key] ?? whole);
}

export interface ReportOptions {
  readonly range: Range;
  /** Values for `{placeholder}` slots in the rule's message. */
  readonly values?: Readonly<Record<string, string>>;
  /** Overrides the rule's message entirely. */
  readonly message?: string;
  readonly suggestion?: string;
  readonly related?: readonly RelatedLocation[];
  /**
   * Text the fingerprint is computed from. Defaults to the message, but a rule
   * should pass the *block text* when it has one: the fingerprint must survive
   * the diagnostic moving to another line.
   */
  readonly fingerprintText?: string;
  /** Distinguishes several diagnostics of the same rule in the same block. */
  readonly fingerprintExtra?: string;
}

/** Builds a diagnostic with the rule's severity, message and suggestion applied. */
export function report(ctx: RuleContext, opts: ReportOptions): Diagnostic {
  const values = opts.values ?? {};
  const message = opts.message ?? interpolate(ctx.rule.message, values);
  const suggestion =
    opts.suggestion ??
    (ctx.rule.suggestion !== undefined ? interpolate(ctx.rule.suggestion, values) : undefined);

  return {
    file: ctx.doc.file,
    range: opts.range,
    ruleId: ctx.rule.id,
    severity: ctx.rule.severity,
    message,
    ...(suggestion !== undefined ? { suggestion } : {}),
    ...(opts.related !== undefined ? { related: opts.related } : {}),
    fingerprint: fingerprintOf(
      ctx.rule.id,
      opts.fingerprintText ?? message,
      opts.fingerprintExtra ?? '',
    ),
  };
}

/** A single-line range, for rules that point at a whole line. */
export function lineRange(line: number, fromColumn = 1, toColumn = 1): Range {
  return { start: { line, column: fromColumn }, end: { line, column: toColumn } };
}

/**
 * Turns an offset span inside a block's stripped text into a source range.
 *
 * This is what lets a diagnostic underline the offending words rather than the
 * paragraph that contains them.
 */
export function spanRange(
  doc: ParsedDoc,
  block: { sourceOffsetOf: (o: number) => number },
  startInText: number,
  endInText: number,
): Range {
  return {
    start: doc.positionAt(block.sourceOffsetOf(startInText)),
    end: doc.positionAt(block.sourceOffsetOf(endInText)),
  };
}
