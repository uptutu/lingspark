import type { ParsedDoc } from '../parser/types.js';
import type { Glossary } from './glossary.js';

/** A pair of frequent, similar strings the document uses, proposed for the glossary. */
export interface TermCandidate {
  readonly a: string;
  readonly b: string;
  readonly countA: number;
  readonly countB: number;
  readonly kind: 'containment' | 'similarity';
}

const MIN_CHARS = 2;
const MAX_CHARS = 10;
/** Both strings must appear at least this often to be proposed. */
const MIN_OCCURRENCES = 2;
/** Bigram-Jaccard above this makes two strings "similar" (0.4 ≈ one shared bigram in five). */
const SIMILARITY = 0.4;
/** Similar strings of wildly different lengths are usually different terms. */
const MAX_LEN_GAP = 2;
/** At most this many proposals per document; the rest will surface next time. */
const MAX_PAIRS = 20;

const CJK = /[぀-ヿ㐀-鿿豈-﫿]/u;

/** Maximal runs of CJK characters; sentences come out as one long run. */
function runsOf(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (const ch of text) {
    if (CJK.test(ch)) {
      cur += ch;
    } else {
      if (cur.length >= MIN_CHARS) out.push(cur);
      cur = '';
    }
  }
  if (cur.length >= MIN_CHARS) out.push(cur);
  return out;
}

function bigrams(text: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < text.length - 1; i++) out.add(text.slice(i, i + 2));
  return out;
}

function similarity(a: string, b: string): number {
  const ga = bigrams(a);
  const gb = bigrams(b);
  let shared = 0;
  for (const g of ga) if (gb.has(g)) shared++;
  return shared / (ga.size + gb.size - shared);
}

/**
 * Whether the glossary already owns this string: it is an approved spelling,
 * or one contains the other (D102 reports those once they are listed as
 * forbidden). The candidate pipeline only proposes what nothing covers yet.
 */
function glossaryOwned(s: string, allowed: ReadonlySet<string>): boolean {
  if (allowed.has(s)) return true;
  for (const g of allowed) {
    if (g.includes(s) || s.includes(g)) return true;
  }
  return false;
}

/**
 * D-091: term-candidate mining.
 *
 * D102 can only police spellings the glossary already knows. This is the
 * machine half of closing that gap: strings the document uses often (≥2 each)
 * that look like two spellings of one term -- one contains the other, or they
 * share most bigrams -- are proposed for human review. `lingspark terms`
 * ranks them; a human decides which become glossary entries.
 *
 * Deliberately no segmentation and no judge: false proposals are cheap (a
 * human glance), missed ones come back on the next document.
 */
export function detectTermCandidates(doc: ParsedDoc, glossary: Glossary): TermCandidate[] {
  // Frequent-substring mining, one pass: count every CJK substring of length
  // 2..10, then keep only strings with at least MIN_OCCURRENCES occurrences
  // that stand alone -- not wholly inside a longer frequent string. "版本"
  // inside two "版本号" is part of that term; "日活用户", which never occurs
  // inside "日活跃用户" (跃 sits between), is its own spelling.
  const counts = new Map<string, number>();
  const runs: string[] = [];
  for (const block of doc.blocks) {
    for (const run of runsOf(block.text)) {
      runs.push(run);
      const upto = Math.min(MAX_CHARS, run.length);
      for (let len = MIN_CHARS; len <= upto; len++) {
        for (let i = 0; i + len <= run.length; i++) {
          const s = run.slice(i, i + len);
          counts.set(s, (counts.get(s) ?? 0) + 1);
        }
      }
    }
  }

  const standalone = new Map<string, number>();
  for (const run of runs) {
    const upto = Math.min(MAX_CHARS, run.length);
    for (let len = MIN_CHARS; len <= upto; len++) {
      for (let i = 0; i + len <= run.length; i++) {
        const s = run.slice(i, i + len);
        if ((counts.get(s) ?? 0) < MIN_OCCURRENCES) continue;
        // Covered when a longer frequent string takes this same position.
        let covered = false;
        for (let L = len + 1; L <= upto - i && L <= MAX_CHARS; L++) {
          if ((counts.get(run.slice(i, i + L)) ?? 0) >= MIN_OCCURRENCES) {
            covered = true;
            break;
          }
        }
        if (!covered && i > 0) {
          for (let L = len + 1; L <= i + len && L <= MAX_CHARS; L++) {
            if ((counts.get(run.slice(i + len - L, i + len)) ?? 0) >= MIN_OCCURRENCES) {
              covered = true;
              break;
            }
          }
        }
        if (!covered) standalone.set(s, (standalone.get(s) ?? 0) + 1);
      }
    }
  }

  const terms = [...standalone.entries()]
    .filter(([s, n]) => n >= MIN_OCCURRENCES && !glossaryOwned(s, glossary.allowedSpellings))
    .map(([s]) => s);
  if (terms.length < 2) return [];

  const out: TermCandidate[] = [];
  for (let i = 0; i < terms.length; i++) {
    for (let j = i + 1; j < terms.length; j++) {
      const a = terms[i] as string;
      const b = terms[j] as string;
      const countA = counts.get(a) ?? 0;
      const countB = counts.get(b) ?? 0;

      let kind: TermCandidate['kind'] | null = null;
      if ((a.includes(b) || b.includes(a)) && a !== b) {
        kind = 'containment';
      } else if (Math.abs(a.length - b.length) <= MAX_LEN_GAP && similarity(a, b) >= SIMILARITY) {
        kind = 'similarity';
      }
      if (kind === null) continue;

      out.push({ a, b, countA, countB, kind });
    }
  }

  // Rank by the weaker side: one frequent and one rare string is weaker
  // evidence than two frequent ones.
  out.sort((x, y) => Math.min(y.countA, y.countB) - Math.min(x.countA, x.countB));
  return out.slice(0, MAX_PAIRS);
}
