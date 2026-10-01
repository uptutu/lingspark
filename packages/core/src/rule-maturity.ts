import { listFalsePositives } from './feedback.js';
import { listIntercepts } from './intercepts.js';
import { msg } from './messages.js';
import type { PathEnv } from './paths.js';

/**
 * Rule maturity on real-usage data (D-086). The zero-false-positive gate is a
 * one-shot exam; a budget is a ledger. "Shown" comes from intercepts.jsonl
 * (every problem handed to an agent, once per fingerprint), "wrong" from
 * false-positives.jsonl (user marks). The suggestion is advisory: flipping a
 * rule's status in YAML stays a human decision, backed by these numbers.
 */

/** fpRate below this and enough showings: eligible to warn. */
export const WARN_FP_RATE = 0.1;
/** fpRate below this and enough showings: eligible to block as an error. */
export const ERROR_FP_RATE = 0.02;
/** Judgments below this: not enough data, whatever the rate. */
export const MIN_JUDGMENTS = 30;

export interface RuleMaturity {
  readonly ruleId: string;
  /** Distinct fingerprints ever shown for this rule. */
  readonly shown: number;
  /** Of those, how many the user marked as false positives. */
  readonly wrong: number;
  readonly fpRate: number;
  readonly suggestion: '数据不足' | '保持提示' | '可拦报' | '建议降级为影子';
}

export function ruleMaturity(env?: PathEnv): RuleMaturity[] {
  const shown = new Map<string, Set<string>>();
  for (const i of listIntercepts(env)) {
    if (i.fp === '') continue;
    const s = shown.get(i.rule) ?? new Set();
    s.add(i.fp);
    shown.set(i.rule, s);
  }

  const wrong = new Map<string, Set<string>>();
  for (const f of listFalsePositives(env)) {
    const s = wrong.get(f.ruleId) ?? new Set();
    s.add(f.fingerprint);
    wrong.set(f.ruleId, s);
  }

  const ruleIds = new Set([...shown.keys(), ...wrong.keys()]);
  const out: RuleMaturity[] = [];
  for (const ruleId of ruleIds) {
    const n = shown.get(ruleId)?.size ?? 0;
    const w = Math.min(wrong.get(ruleId)?.size ?? 0, n);
    const rate = n === 0 ? 0 : w / n;
    const suggestion: RuleMaturity['suggestion'] =
      n < MIN_JUDGMENTS ? '数据不足' : rate >= WARN_FP_RATE ? '建议降级为影子' : rate < ERROR_FP_RATE ? '可拦报' : '保持提示';
    out.push({ ruleId, shown: n, wrong: w, fpRate: rate, suggestion });
  }
  return out.sort((a, b) => a.ruleId.localeCompare(b.ruleId));
}

/** What `lingspark rule-maturity` prints. */
export function formatRuleMaturity(rows: readonly RuleMaturity[]): string {
  const lines = [msg.ruleMaturity.title, '', msg.ruleMaturity.explain, ''];
  if (rows.length === 0) {
    lines.push(msg.ruleMaturity.empty);
    return lines.join('\n');
  }
  lines.push(msg.ruleMaturity.head);
  for (const r of rows) {
    lines.push(msg.ruleMaturity.row(r.ruleId, r.shown, r.wrong, r.fpRate, r.suggestion));
  }
  lines.push('', msg.ruleMaturity.foot);
  return lines.join('\n');
}
