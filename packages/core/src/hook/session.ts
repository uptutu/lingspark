import { createHash } from 'node:crypto';
import { readJsonOrNull, writeFileAtomic } from '../fsutil.js';
import { dataPaths, type PathEnv } from '../paths.js';

/** What `sessions/<id>.json` holds (design doc, sections 4.3 and 5.4). */
export interface SessionState {
  readonly version: 1;
  /** Checked documents this session has written, for the Stop hook. */
  readonly files: readonly string[];
  /** Error fingerprint -> times Stop has blocked on it (the loop guard's count). */
  readonly fingerprints: Readonly<Record<string, number>>;
  /** Error fingerprints already fed back after a write; not repeated on later writes. */
  readonly postReported: readonly string[];
  /** Warning fingerprints already shown once on Stop; never shown again. */
  readonly reportedWarnings: readonly string[];
  /** Turn key -> times Stop has blocked in that turn. */
  readonly stopBlocks: Readonly<Record<string, number>>;
  /** Document -> hash of the content the agent last reviewed (in-session review, D-057). */
  readonly reviewed: Readonly<Record<string, string>>;
  /** A review the agent was asked for and has not handed in yet. */
  readonly reviewPending: ReviewPending | null;
  /** Review requests in a row that got no report; past a few, stop asking (D-057). */
  readonly reviewUnanswered: number;
}

export interface ReviewPending {
  readonly turn: string;
  readonly files: readonly string[];
  /** Where the agent was asked to write its report. */
  readonly report: string;
}

const EMPTY: SessionState = {
  version: 1,
  files: [],
  fingerprints: {},
  postReported: [],
  reportedWarnings: [],
  stopBlocks: {},
  reviewed: {},
  reviewPending: null,
  reviewUnanswered: 0,
};

/** Anything that is not a safe file name is hashed, so an odd id cannot escape the directory. */
export function sessionFileName(sessionId: string): string {
  if (/^[A-Za-z0-9_-]{1,128}$/u.test(sessionId)) return sessionId;
  return `h-${createHash('sha256').update(sessionId, 'utf8').digest('hex').slice(0, 32)}`;
}

function coerce(raw: unknown): SessionState {
  if (raw === null || typeof raw !== 'object') return EMPTY;
  const r = raw as Partial<Record<keyof SessionState, unknown>>;
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  const counts = (v: unknown): Record<string, number> => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: Record<string, number> = {};
    for (const [k, n] of Object.entries(v)) if (typeof n === 'number' && n >= 0) out[k] = n;
    return out;
  };
  const texts = (v: unknown): Record<string, string> => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: Record<string, string> = {};
    for (const [k, t] of Object.entries(v)) if (typeof t === 'string') out[k] = t;
    return out;
  };
  const pending = (v: unknown): ReviewPending | null => {
    if (v === null || typeof v !== 'object') return null;
    const p = v as Record<string, unknown>;
    if (typeof p['turn'] !== 'string' || typeof p['report'] !== 'string') return null;
    return { turn: p['turn'], files: strings(p['files']), report: p['report'] };
  };
  return {
    version: 1,
    files: strings(r.files),
    fingerprints: counts(r.fingerprints),
    postReported: strings(r.postReported),
    reportedWarnings: strings(r.reportedWarnings),
    stopBlocks: counts(r.stopBlocks),
    reviewed: texts(r.reviewed),
    reviewPending: pending(r.reviewPending),
    reviewUnanswered: typeof r.reviewUnanswered === 'number' && r.reviewUnanswered >= 0 ? r.reviewUnanswered : 0,
  };
}

/**
 * Session state with changes recorded as operations and replayed on save.
 *
 * Several hooks from one session can run at once (design doc, 5.4). Atomic
 * rename keeps the file from being corrupted, but a plain read-modify-write
 * would still let one hook silently undo another's update. So `save` re-reads
 * the file immediately before writing and applies this run's increments to
 * whatever is there now. The window for a lost update shrinks to the gap
 * between that read and the rename.
 */
export class SessionStore {
  private state: SessionState;
  private readonly ops: ((s: SessionState) => SessionState)[] = [];

  private constructor(
    private readonly file: string,
    initial: SessionState,
  ) {
    this.state = initial;
  }

  static open(sessionId: string, env?: PathEnv): SessionStore {
    const file = dataPaths.session(sessionFileName(sessionId), env);
    return new SessionStore(file, coerce(readJsonOrNull(file)));
  }

  get snapshot(): SessionState {
    return this.state;
  }

  private apply(op: (s: SessionState) => SessionState): void {
    this.ops.push(op);
    this.state = op(this.state);
  }

  addFiles(files: readonly string[]): void {
    this.apply((s) => ({ ...s, files: [...new Set([...s.files, ...files])] }));
  }

  /** Increments each fingerprint once and returns the resulting counts. */
  bumpFingerprints(fps: readonly string[]): Record<string, number> {
    const unique = [...new Set(fps)];
    this.apply((s) => {
      const next = { ...s.fingerprints };
      for (const fp of unique) next[fp] = (next[fp] ?? 0) + 1;
      return { ...s, fingerprints: next };
    });
    const out: Record<string, number> = {};
    for (const fp of unique) out[fp] = this.state.fingerprints[fp] ?? 0;
    return out;
  }

  markPostReported(fps: readonly string[]): void {
    this.apply((s) => ({ ...s, postReported: [...new Set([...s.postReported, ...fps])] }));
  }

  markWarningsReported(fps: readonly string[]): void {
    this.apply((s) => ({
      ...s,
      reportedWarnings: [...new Set([...s.reportedWarnings, ...fps])],
    }));
  }

  bumpStopBlock(turnKey: string): number {
    this.apply((s) => ({
      ...s,
      stopBlocks: { ...s.stopBlocks, [turnKey]: (s.stopBlocks[turnKey] ?? 0) + 1 },
    }));
    return this.state.stopBlocks[turnKey] ?? 0;
  }

  /** A new request; one still open when it is replaced went unanswered. */
  markReviewRequested(pending: ReviewPending): void {
    this.apply((s) => ({
      ...s,
      reviewPending: pending,
      reviewUnanswered: s.reviewUnanswered + (s.reviewPending === null ? 0 : 1),
    }));
  }

  /** Records the content each document had when its review came in, and closes the request. */
  markReviewed(hashes: Readonly<Record<string, string>>): void {
    this.apply((s) => ({ ...s, reviewed: { ...s.reviewed, ...hashes }, reviewPending: null, reviewUnanswered: 0 }));
  }

  save(): void {
    if (this.ops.length === 0) return;
    let fresh = coerce(readJsonOrNull(this.file));
    for (const op of this.ops) fresh = op(fresh);
    writeFileAtomic(this.file, `${JSON.stringify(fresh, null, 2)}\n`);
    this.state = fresh;
    this.ops.length = 0;
  }
}
