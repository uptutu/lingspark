import { readFileSync } from 'node:fs';
import { appendJsonl } from './log.js';
import { dataPaths, type PathEnv } from './paths.js';

/**
 * False-positive feedback (D-086). Every problem LingSpark shows an agent is
 * recorded in intercepts.jsonl with its rule and fingerprint; when the user
 * says "that one was wrong", one line lands here. The maturity report is the
 * join of the two files: shown vs wrong, per rule.
 */

export interface FalsePositive {
  readonly ts: string;
  readonly ruleId: string;
  readonly fingerprint: string;
}

/** Appends one mark. Never throws. */
export function recordFalsePositive(ruleId: string, fingerprint: string, env?: PathEnv): void {
  appendJsonl(dataPaths.falsePositives(env), {
    ts: new Date().toISOString(),
    ruleId,
    fingerprint,
  });
}

/** Every mark, oldest first. A missing or unreadable file means none. */
export function listFalsePositives(env?: PathEnv): FalsePositive[] {
  let text: string;
  try {
    text = readFileSync(dataPaths.falsePositives(env), 'utf8');
  } catch {
    return [];
  }
  const out: FalsePositive[] = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    try {
      const r = JSON.parse(line) as Partial<FalsePositive>;
      if (typeof r.ts === 'string' && typeof r.ruleId === 'string' && typeof r.fingerprint === 'string') {
        out.push({ ts: r.ts, ruleId: r.ruleId, fingerprint: r.fingerprint });
      }
    } catch {
      // a torn line: skip it
    }
  }
  return out;
}
