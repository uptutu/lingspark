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
  /**
   * Warning fingerprint -> when it was last shown and how often (D-087).
   * A warning is re-shown after WARNING_DECAY_DAYS and escalates after
   * WARNING_REPEAT_ESCALATE showings. Replaces the old "shown once, trust
   * forever" set; a legacy array here reads as "never shown".
   */
  readonly warnings: Readonly<Record<string, { last: string; count: number }>>;
  /**
   * Warning fingerprints escalated to error behaviour (D-087): shown
   * WARNING_REPEAT_ESCALATE times without being fixed, they now block every
   * Stop, like an error, until fixed or the loop guard releases them.
   */
  readonly escalated: readonly string[];
  /** Turn key -> times Stop has blocked in that turn. */
  readonly stopBlocks: Readonly<Record<string, number>>;
  /**
   * Suppression directives the agent itself introduced (D-092), per file:
   * comment lines of `lingspark-disable` comments and whole-file opt-outs
   * written by the checked agent. They do not silence checks; the user can
   * always still write a suppression of their own.
   */
  readonly agentSuppressions: Readonly<Record<string, AgentSuppressionInfo>>;
  /** Document -> hash of the content the agent last reviewed (in-session review, D-057). */
  readonly reviewed: Readonly<Record<string, string>>;
  /** A review the agent was asked for and has not handed in yet. */
  readonly reviewPending: ReviewPending | null;
  /** Review requests in a row that got no report; past a few, stop asking (D-057). */
  readonly reviewUnanswered: number;
}

export interface AgentSuppressionInfo {
  /** Comment lines of `lingspark-disable` directives the agent's write introduced. */
  readonly lines: readonly number[];
  /** The agent's write introduced `lingspark: false` frontmatter. */
  readonly optedOut: boolean;
}

export interface ReviewPending {
  readonly turn: string;
  readonly files: readonly string[];
  /** Where the agent was asked to write its report. */
  readonly report: string;
  /**
   * Document -> hash of the content when it was handed over: the text every
   * quote in the report was cut from, needed to read that report back (D-094).
   * Absent in state written before then.
   */
  readonly hashes?: Readonly<Record<string, string>>;
}

const EMPTY: SessionState = {
  version: 1,
  files: [],
  fingerprints: {},
  postReported: [],
  warnings: {},
  escalated: [],
  stopBlocks: {},
  agentSuppressions: {},
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
    const hashes = texts(p['hashes']);
    const base: ReviewPending = { turn: p['turn'], files: strings(p['files']), report: p['report'] };
    // Nothing to compare against for a request written before D-094; keeping
    // the question open would be an accusation without evidence.
    return Object.keys(hashes).length === 0 ? base : { ...base, hashes };
  };
  // D-087: the old format was a flat array of shown-once fingerprints. It
  // migrates to "never shown": re-showing a warning once is harmless, and a
  // made-up timestamp would poison the decay window.
  const warningLog = (v: unknown): Record<string, { last: string; count: number }> => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: Record<string, { last: string; count: number }> = {};
    for (const [k, e] of Object.entries(v)) {
      if (e === null || typeof e !== 'object') continue;
      const last = (e as Record<string, unknown>)['last'];
      const count = (e as Record<string, unknown>)['count'];
      if (typeof last === 'string' && typeof count === 'number' && count >= 0) out[k] = { last, count };
    }
    return out;
  };
  const suppressionMap = (v: unknown): Record<string, AgentSuppressionInfo> => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: Record<string, AgentSuppressionInfo> = {};
    for (const [k, e] of Object.entries(v)) {
      if (e === null || typeof e !== 'object') continue;
      const lines = (e as Record<string, unknown>)['lines'];
      out[k] = {
        lines: Array.isArray(lines) ? lines.filter((x): x is number => typeof x === 'number' && x >= 0) : [],
        optedOut: (e as Record<string, unknown>)['optedOut'] === true,
      };
    }
    return out;
  };
  return {
    version: 1,
    files: strings(r.files),
    fingerprints: counts(r.fingerprints),
    postReported: strings(r.postReported),
    warnings: warningLog(r.warnings),
    escalated: strings(r.escalated),
    stopBlocks: counts(r.stopBlocks),
    agentSuppressions: suppressionMap(r.agentSuppressions),
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

  /**
   * Which of these warnings are due to be shown: never shown, or last shown
   * before the decay window (D-087). Read-only; pair with markWarningsReported.
   */
  dueWarnings(fps: readonly string[], decayMs: number, now: number): string[] {
    const unique = [...new Set(fps)];
    return unique.filter((fp) => {
      const e = this.state.warnings[fp];
      if (e === undefined) return true;
      const last = Date.parse(e.last);
      return Number.isNaN(last) || now - last >= decayMs;
    });
  }

  /** Records a showing: last = now, count + 1 (D-087). */
  markWarningsReported(fps: readonly string[], nowIso: string): void {
    const unique = [...new Set(fps)];
    this.apply((s) => {
      const next = { ...s.warnings };
      for (const fp of unique) {
        const e = next[fp];
        next[fp] = { last: nowIso, count: (e?.count ?? 0) + 1 };
      }
      return { ...s, warnings: next };
    });
  }

  /** How many times a warning has been shown (D-087 escalation). */
  warningCount(fp: string): number {
    return this.state.warnings[fp]?.count ?? 0;
  }

  /** Marks warnings as escalated: from now on they block like errors (D-087). */
  escalateWarnings(fps: readonly string[]): void {
    this.apply((s) => ({ ...s, escalated: [...new Set([...s.escalated, ...fps])] }));
  }

  bumpStopBlock(turnKey: string): number {
    this.apply((s) => ({
      ...s,
      stopBlocks: { ...s.stopBlocks, [turnKey]: (s.stopBlocks[turnKey] ?? 0) + 1 },
    }));
    return this.state.stopBlocks[turnKey] ?? 0;
  }

  /**
   * Records suppression directives the agent's own write introduced (D-092).
   * Lines accumulate across writes; an opted-out flag, once set, sticks until
   * the file is rewritten without the frontmatter (cleared by noteAgentSuppressions
   * with optedOut false and no lines).
   */
  noteAgentSuppressions(file: string, info: AgentSuppressionInfo): void {
    this.apply((s) => {
      const prev = s.agentSuppressions[file] ?? { lines: [], optedOut: false };
      const lines = [...new Set([...prev.lines, ...info.lines])].sort((a, b) => a - b);
      const next = { ...s.agentSuppressions, [file]: { lines, optedOut: prev.optedOut || info.optedOut } };
      return { ...s, agentSuppressions: next };
    });
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
