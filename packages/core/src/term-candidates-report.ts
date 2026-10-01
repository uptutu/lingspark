import { readFileSync } from 'node:fs';
import { msg } from './messages.js';
import { dataPaths, type PathEnv } from './paths.js';
import type { TermCandidate } from './rules/term-candidates.js';

/**
 * Term-candidate review (D-091). The hook appends one line per checked file
 * with the pairs `detectTermCandidates` proposed; this is the read side:
 * aggregate the same pair across files and rank by how often and how widely
 * it shows up. Proposals are machine-made; entering a pair into the glossary
 * stays a human decision.
 */

interface RecordLine {
  readonly ts: string;
  readonly file: string;
  readonly candidates: readonly TermCandidate[];
}

/** One proposed pair, aggregated over every file that produced it. */
export interface TermCandidateTally {
  readonly a: string;
  readonly b: string;
  /** How many distinct files proposed this pair. */
  readonly files: number;
  /** Sum of min(countA, countB) over those files. */
  readonly occurrences: number;
  readonly kind: 'containment' | 'similarity';
  /** Most recent proposal time, ISO. */
  readonly last: string;
}

function listRecords(env?: PathEnv): RecordLine[] {
  let text: string;
  try {
    text = readFileSync(dataPaths.termCandidates(env), 'utf8');
  } catch {
    return [];
  }
  const out: RecordLine[] = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    try {
      const r = JSON.parse(line) as Partial<RecordLine>;
      if (typeof r.ts === 'string' && typeof r.file === 'string' && Array.isArray(r.candidates)) {
        out.push({ ts: r.ts, file: r.file, candidates: r.candidates as TermCandidate[] });
      }
    } catch {
      // a torn line: skip it
    }
  }
  return out;
}

export function termCandidateTallies(env?: PathEnv): TermCandidateTally[] {
  const byPair = new Map<string, { a: string; b: string; files: Set<string>; occurrences: number; kind: TermCandidate['kind']; last: string }>();
  for (const r of listRecords(env)) {
    for (const c of r.candidates) {
      const key = [c.a, c.b].sort().join('');
      const e = byPair.get(key) ?? { a: c.a, b: c.b, files: new Set(), occurrences: 0, kind: c.kind, last: '' };
      e.files.add(r.file);
      e.occurrences += Math.min(c.countA, c.countB);
      if (r.ts > e.last) e.last = r.ts;
      byPair.set(key, e);
    }
  }
  return [...byPair.values()]
    .map((e) => ({ a: e.a, b: e.b, files: e.files.size, occurrences: e.occurrences, kind: e.kind, last: e.last }))
    .sort((x, y) => y.files - x.files || y.occurrences - x.occurrences);
}

/** What `lingspark terms` prints. */
export function formatTermCandidates(rows: readonly TermCandidateTally[]): string {
  const lines = [msg.terms.title, '', msg.terms.explain, ''];
  if (rows.length === 0) {
    lines.push(msg.terms.empty);
    return lines.join('\n');
  }
  lines.push(msg.terms.head);
  for (const r of rows.slice(0, 50)) {
    lines.push(msg.terms.row(r.a, r.b, r.files, r.occurrences, r.kind));
  }
  lines.push('', msg.terms.foot);
  return lines.join('\n');
}
