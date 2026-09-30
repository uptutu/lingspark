import { readFileSync, statSync, writeFileSync } from 'node:fs';
import type { Diagnostic } from './diagnostics/types.js';
import { appendJsonl } from './log.js';
import { dataPaths, type PathEnv } from './paths.js';

/**
 * What LingSpark stopped, in the words the agent wrote (D-070): the client's
 * "拦截记录". One line per problem the first time it is handed to the agent,
 * with the sentence it sits in; later lines say a problem is gone.
 *
 * Kept on this machine only, in the data directory, and trimmed to the most
 * recent MAX_RECORDS. The stats in `runs.jsonl` count problems; this file is
 * the only place their text is kept.
 */

/** How the problem came to light. */
export type InterceptHow = 'write' | 'stop' | 'review';

export interface InterceptRecord {
  readonly type: 'intercept';
  readonly ts: string;
  readonly agent: string;
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  readonly how: InterceptHow;
  /** The sentence, cut around the problem: before + hit + after. */
  readonly before: string;
  readonly hit: string;
  readonly after: string;
  readonly why: string;
  readonly fix: string;
  /** Deterministic and model findings: the diagnostic fingerprint. Review: ''. */
  readonly fp: string;
  /** Review findings the agent says it fixed. */
  readonly fixed?: boolean;
}

interface Resolved {
  readonly type: 'resolved';
  readonly ts: string;
  readonly fp: string;
}

export interface Intercept extends Omit<InterceptRecord, 'type' | 'fixed'> {
  readonly status: 'done' | 'open';
}

const MAX_RECORDS = 500;
/** Trim when the file grows past this; a record is a few hundred bytes. */
const TRIM_AT_BYTES = 600 * 1024;
/** Characters of context kept on each side of the problem. */
const CONTEXT = 40;

const file = (env?: PathEnv): string => dataPaths.intercepts(env);

function readLines(env?: PathEnv): (InterceptRecord | Resolved)[] {
  let text: string;
  try {
    text = readFileSync(file(env), 'utf8');
  } catch {
    return [];
  }
  const out: (InterceptRecord | Resolved)[] = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    try {
      const r = JSON.parse(line) as InterceptRecord | Resolved;
      if (r.type === 'intercept' || r.type === 'resolved') out.push(r);
    } catch {
      // a torn line: skip it
    }
  }
  return out;
}

/** The line a diagnostic points at, cut to a readable window around it. */
function quoteOf(text: string, d: Diagnostic): { before: string; hit: string; after: string } {
  const line = text.split(/\r?\n/u)[d.range.start.line - 1] ?? '';
  const start = Math.min(Math.max(d.range.start.column - 1, 0), line.length);
  const end =
    d.range.end.line === d.range.start.line ? Math.min(Math.max(d.range.end.column - 1, start), line.length) : line.length;
  // A problem that spans nothing (a whole-block finding): show the line.
  if (end <= start) return { before: '', hit: line.trim(), after: '' };
  const before = line.slice(0, start);
  const after = line.slice(end);
  return {
    before: (before.length > CONTEXT ? '…' + before.slice(-CONTEXT) : before).trimStart(),
    hit: line.slice(start, end),
    after: (after.length > CONTEXT ? after.slice(0, CONTEXT) + '…' : after).trimEnd(),
  };
}

function trim(env?: PathEnv): void {
  try {
    if (statSync(file(env)).size < TRIM_AT_BYTES) return;
    const lines = readLines(env);
    const records = lines.filter((l): l is InterceptRecord => l.type === 'intercept').slice(-MAX_RECORDS);
    const keep = new Set(records.map((r) => r.fp).filter((fp) => fp !== ''));
    const resolved = lines.filter((l): l is Resolved => l.type === 'resolved' && keep.has(l.fp));
    const next = [...records, ...resolved].sort((a, b) => a.ts.localeCompare(b.ts));
    writeFileSync(file(env), next.map((l) => JSON.stringify(l)).join('\n') + '\n');
  } catch {
    // an untrimmed file is only a bigger file
  }
}

/**
 * Records the problems just handed to an agent, each once: a problem told
 * after the write and again at Stop is one interception. Never throws.
 */
export function recordIntercepts(
  agent: string,
  how: Exclude<InterceptHow, 'review'>,
  told: readonly Diagnostic[],
  env?: PathEnv,
): void {
  if (told.length === 0) return;
  try {
    const known = new Set(readLines(env).flatMap((l) => (l.type === 'intercept' ? [l.fp] : [])));
    const texts = new Map<string, string>();
    const ts = new Date().toISOString();
    for (const d of told) {
      if (known.has(d.fingerprint)) continue;
      known.add(d.fingerprint);
      if (!texts.has(d.file)) {
        try {
          texts.set(d.file, readFileSync(d.file, 'utf8'));
        } catch {
          texts.set(d.file, '');
        }
      }
      const record: InterceptRecord = {
        type: 'intercept',
        ts,
        agent,
        file: d.file,
        line: d.range.start.line,
        rule: d.ruleId,
        how,
        ...quoteOf(texts.get(d.file) ?? '', d),
        why: d.message,
        fix: d.suggestion ?? '',
        fp: d.fingerprint,
      };
      appendJsonl(file(env), record);
    }
    trim(env);
  } catch {
    // the check itself is unaffected
  }
}

/** What an agent's in-session review found, as it reported it. Never throws. */
export function recordReviewFindings(
  agent: string,
  findings: readonly { file: string; rule: string; quote: string; fixed: boolean }[],
  env?: PathEnv,
): void {
  const ts = new Date().toISOString();
  for (const f of findings) {
    if (f.quote === '' && f.rule === '') continue;
    const record: InterceptRecord = {
      type: 'intercept',
      ts,
      agent,
      file: f.file,
      line: 0,
      rule: f.rule,
      how: 'review',
      before: '',
      hit: f.quote,
      after: '',
      why: '',
      fix: '',
      fp: '',
      fixed: f.fixed,
    };
    appendJsonl(file(env), record);
  }
}

/**
 * After a file is checked: the problems recorded for it that this check no
 * longer finds are gone -- the agent changed the text. Never throws.
 */
export function noteStillThere(path: string, current: readonly Diagnostic[], env?: PathEnv): void {
  try {
    const lines = readLines(env);
    const gone = new Set(lines.flatMap((l) => (l.type === 'resolved' ? [l.fp] : [])));
    const now = new Set(current.map((d) => d.fingerprint));
    const ts = new Date().toISOString();
    for (const l of lines) {
      if (l.type !== 'intercept' || l.fp === '' || l.file !== path) continue;
      if (now.has(l.fp) || gone.has(l.fp)) continue;
      gone.add(l.fp);
      appendJsonl(file(env), { type: 'resolved', ts, fp: l.fp } satisfies Resolved);
    }
  } catch {
    // the status stays "open" a little longer
  }
}

/** Every interception, newest first, with whether it has been dealt with. */
export function listIntercepts(env?: PathEnv): Intercept[] {
  const lines = readLines(env);
  const gone = new Set(lines.flatMap((l) => (l.type === 'resolved' ? [l.fp] : [])));
  return lines
    .filter((l): l is InterceptRecord => l.type === 'intercept')
    .map(({ type: _type, fixed, ...r }) => ({
      ...r,
      status: (r.fp === '' ? fixed === true : gone.has(r.fp)) ? ('done' as const) : ('open' as const),
    }))
    .reverse();
}

/** Whether a path is one the records name, so the client may open it. */
export function isRecordedFile(path: string, env?: PathEnv): boolean {
  return readLines(env).some((l) => l.type === 'intercept' && l.file === path);
}
