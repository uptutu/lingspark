import type { ResolvedConfig } from '../config/schema.js';
import type { Diagnostic } from '../diagnostics/types.js';
import { composeQuestion } from '../passes/pass2.js';
import { pairQuestion } from '../passes/pass3.js';
import type { Judge } from '../judge/types.js';
import { parseDocument } from '../parser/parse.js';
import { getDeterministic, type RuleContext } from './context.js';
import { EMPTY_GLOSSARY, type Glossary } from './glossary.js';
import type { Rule } from './schema.js';
import { msg } from '../messages.js';

export type ExampleKind = 'positive' | 'negative';

export interface ExampleResult {
  readonly ruleId: string;
  readonly kind: ExampleKind;
  readonly index: number;
  readonly note: string;
  /** Meaningless when `skippedReason` is set. */
  readonly passed: boolean;
  readonly diagnostics: readonly Diagnostic[];
  /** Judge rules: the probability the judge gave. */
  readonly probability?: number;
  /** Set when the example could not be run at all. */
  readonly skippedReason?: string;
}

export interface RunExamplesOptions {
  readonly config: ResolvedConfig;
  /** Per-rule glossary, for rules like D102 that need one to do anything. */
  readonly glossary?: Glossary;
  /** Needed to run judge rules; without it their examples are skipped. */
  readonly judge?: Judge | null;
}

/**
 * The state a judge sees for an example. Examples that already carry the
 * Pass 2 markers (a previous paragraph, a section heading) are used as they
 * are; a bare paragraph is wrapped the way Pass 2 would wrap it.
 */
export function exampleState(rule: Rule, state: string): string {
  if (state.includes('【')) return state;
  return rule.scope === 'section' ? `【章节标题】\n【章节内容】${state}` : `【当前段落】${state}`;
}

/**
 * Runs a rule against its own examples (design doc, section 7.3).
 *
 * A positive example must produce at least one diagnostic; a negative example
 * must produce none. The asymmetry matters: `lingspark eval` requires zero false
 * positives on negatives but only 60% recall on positives, so a negative
 * failing is always a bug and a positive failing may be a deliberate limit.
 *
 * Judge rules are asked of `opts.judge` with the same composed question and
 * threshold Pass 2 uses. With no judge they are reported as skipped -- never
 * as passed.
 */
export async function runRuleExamples(rule: Rule, opts: RunExamplesOptions): Promise<ExampleResult[]> {
  const out: ExampleResult[] = [];
  const glossary = opts.glossary ?? EMPTY_GLOSSARY;
  const all: [ExampleKind, { state: string; note?: string }, number][] = [
    ...rule.examples.positive.map((e, i) => ['positive', e, i] as [ExampleKind, typeof e, number]),
    ...rule.examples.negative.map((e, i) => ['negative', e, i] as [ExampleKind, typeof e, number]),
  ];

  if (rule.kind === 'judge') {
    // All at once, in order: each example is a separate model call, and how
    // many may run together is the judge's business (eval wraps it in a
    // limiter). One at a time, a slow backend takes most of an hour.
    const judge = opts.judge;
    // A claim-pair rule's examples are two claims, 【声明 1】 and 【声明 2】.
    const q = rule.scope === 'claim_pair' ? pairQuestion(rule, 1, 2) : composeQuestion(rule);
    return Promise.all(
      all.map(async ([kind, example, index]): Promise<ExampleResult> => {
        const base = { ruleId: rule.id, kind, index, note: example.note ?? '' };
        const skipped = (reason: string): ExampleResult => ({ ...base, passed: false, diagnostics: [], skippedReason: reason });
        if (judge === undefined || judge === null || q === null) return skipped(msg.rules.exampleNeedsJudge);
        try {
          const res = await judge.judge(
            { state: exampleState(rule, example.state), questions: { [rule.id]: q } },
            { signal: new AbortController().signal, purpose: 'eval', rules: [rule.id] },
          );
          const a = res.answers[rule.id];
          if (a === undefined || a.type !== 'noul') return skipped(msg.rules.exampleNoAnswer);
          const bump = judge.calibrated ? 0 : opts.config.judge.uncalibratedBump;
          const threshold = Math.min(0.99, (rule.threshold ?? opts.config.judge.thresholdReport) + bump);
          const hit = a.probability >= threshold;
          return { ...base, passed: kind === 'positive' ? hit : !hit, diagnostics: [], probability: a.probability };
        } catch (err: unknown) {
          return skipped(msg.rules.exampleThrew(err instanceof Error ? err.message : String(err)));
        }
      }),
    );
  }

  for (const [kind, example, index] of all) {
    const base = { ruleId: rule.id, kind, index, note: example.note ?? '' };
    const skip = (reason: string): void => {
      out.push({ ...base, passed: false, diagnostics: [], skippedReason: reason });
    };

    if (rule.impl === undefined) {
      skip(msg.rules.exampleImplMissing(''));
      continue;
    }
    const impl = getDeterministic(rule.impl);
    if (impl === undefined) {
      skip(msg.rules.exampleImplMissing(rule.impl));
      continue;
    }

    const doc = parseDocument(example.state, { file: `${rule.id}.example.md` });
    const ctx: RuleContext = { doc, config: opts.config, glossary, rule };
    try {
      const diagnostics = impl(ctx);
      const hit = diagnostics.length > 0;
      out.push({ ...base, passed: kind === 'positive' ? hit : !hit, diagnostics });
    } catch (err: unknown) {
      skip(msg.rules.exampleThrew(String(err)));
    }
  }
  return out;
}

export interface ExampleSummary {
  readonly ruleId: string;
  readonly positiveTotal: number;
  readonly positiveHit: number;
  readonly negativeTotal: number;
  /** Negatives that wrongly produced a diagnostic. */
  readonly falsePositives: number;
  /** Examples that could not be run at all. */
  readonly skipped: number;
  readonly results: readonly ExampleResult[];
}

export function summarizeExamples(ruleId: string, results: readonly ExampleResult[]): ExampleSummary {
  const ran = results.filter((r) => r.skippedReason === undefined);
  const positives = ran.filter((r) => r.kind === 'positive');
  const negatives = ran.filter((r) => r.kind === 'negative');
  return {
    ruleId,
    positiveTotal: positives.length,
    positiveHit: positives.filter((r) => r.passed).length,
    negativeTotal: negatives.length,
    falsePositives: negatives.filter((r) => !r.passed).length,
    skipped: results.length - ran.length,
    results,
  };
}
