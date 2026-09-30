import { closeSync, openSync, readSync, statSync } from 'node:fs';
import type { Diagnostic } from './diagnostics/types.js';
import { appendJsonl } from './log.js';
import { dataPaths, type PathEnv } from './paths.js';
import { msg } from './messages.js';

/**
 * Shadow rules run but never tell (design doc, 7.3). D-085: their hits are
 * recorded per hit -- rule, file, line, fingerprint -- so that a weekly
 * report can show "what the checker quietly noticed" and the maturity gate
 * (D-086) has a data source. One fingerprint on one day counts once, no
 * matter how many runs saw it: the hook checks a file after the write and
 * again at Stop, and the warm-up may check it a third time.
 */

/** Appends one JSONL line per hit. Never throws -- stats are best-effort. */
export function recordShadowHits(hits: readonly Diagnostic[], env?: PathEnv): void {
  const ts = new Date().toISOString();
  for (const d of hits) {
    appendJsonl(dataPaths.shadowHits(env), {
      ts,
      file: d.file,
      line: d.range.start.line,
      ruleId: d.ruleId,
      fingerprint: d.fingerprint,
    });
  }
}

export interface ShadowRuleStat {
  readonly ruleId: string;
  /** Unique (fingerprint, day) pairs in the window: one real hit, counted once. */
  readonly hits: number;
  /** Distinct files the rule fired on. */
  readonly files: number;
  /** ISO timestamp of the most recent hit. */
  readonly lastSeen: string;
}

export interface ShadowReport {
  /** The window actually used, in days. */
  readonly days: number;
  /** First moment of the window, ISO. */
  readonly since: string;
  readonly rules: readonly ShadowRuleStat[];
}

const DAY_MS = 86_400_000;
/** Only the tail is read: the file only grows and the report has a window. */
const TAIL_BYTES = 4 * 1024 * 1024;

const localDay = (d: Date): string =>
  `${String(d.getFullYear())}-${String(d.getMonth() + 1)}-${String(d.getDate())}`;

function tail(file: string): string {
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch {
    return '';
  }
  try {
    const size = statSync(file).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const text = buf.toString('utf8');
    return size > len ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    closeSync(fd);
  }
}

type HitLine = { ts?: unknown; ruleId?: unknown; file?: unknown; line?: unknown; fingerprint?: unknown };

function parse(line: string): HitLine | null {
  if (line === '') return null;
  try {
    const r = JSON.parse(line) as unknown;
    return r !== null && typeof r === 'object' ? r : null;
  } catch {
    return null;
  }
}

/**
 * Aggregates the shadow-hit log over the last `days` days. Never throws: a
 * missing or unreadable log means "no hits", same as an empty one.
 */
export function shadowReport(opts: { env?: PathEnv; now?: Date; days?: number } = {}): ShadowReport {
  const days = opts.days ?? 7;
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - days * DAY_MS);

  const byRule = new Map<string, { hits: Set<string>; files: Set<string>; last: string }>();
  for (const line of tail(dataPaths.shadowHits(opts.env)).split('\n')) {
    const r = parse(line);
    if (r === null || typeof r.ts !== 'string') continue;
    const ts = new Date(r.ts);
    if (Number.isNaN(ts.getTime()) || ts < since || ts > now) continue;
    const ruleId = typeof r.ruleId === 'string' ? r.ruleId : 'unknown';
    const fingerprint = typeof r.fingerprint === 'string' ? r.fingerprint : `${String(r.line)}`;
    const file = typeof r.file === 'string' ? r.file : '';
    const stat = byRule.get(ruleId) ?? { hits: new Set(), files: new Set(), last: '' };
    stat.hits.add(`${fingerprint}@${localDay(ts)}`);
    stat.files.add(file);
    if (r.ts > stat.last) stat.last = r.ts;
    byRule.set(ruleId, stat);
  }

  const rules = [...byRule.entries()]
    .map(([ruleId, s]): ShadowRuleStat => ({ ruleId, hits: s.hits.size, files: s.files.size, lastSeen: s.last }))
    .sort((a, b) => b.hits - a.hits || a.ruleId.localeCompare(b.ruleId));
  return { days, since: since.toISOString(), rules };
}

/** What `lingspark shadow-report` prints (D-019: text lives in messages.ts). */
export function formatShadowReport(report: ShadowReport): string {
  const lines = [msg.shadowReport.title(report.days), '', msg.shadowReport.explain];
  if (report.rules.length === 0) {
    lines.push('', msg.shadowReport.empty(report.days));
    return lines.join('\n');
  }
  lines.push('');
  for (const r of report.rules) {
    lines.push(msg.shadowReport.ruleLine(r.ruleId, r.hits, r.files, r.lastSeen.slice(0, 10)));
  }
  return lines.join('\n');
}
