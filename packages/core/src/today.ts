import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { noticedAgents, waitingAgents } from './hook/waiting.js';
import { dataPaths, type PathEnv } from './paths.js';

/** What the client shows under "已开启" (D-058). */
export interface TodayStats {
  /** Documents checked today. */
  readonly checked: number;
  /**
   * Problems handed back to an agent today, each counted once however often
   * it was handed back: reported errors, plus what in-session reviews found.
   */
  readonly blocked: number;
  /** The same two numbers since the first check on this machine (D-066). */
  readonly total: { readonly checked: number; readonly blocked: number };
  /** Whether anything was ever checked on this machine. */
  readonly ever: boolean;
  /**
   * Agents connected but not heard from since (D-064): not restarted yet, or
   * -- Codex -- hooks not trusted yet. The client says so for each.
   */
  readonly waiting: readonly string[];
  /** Of those, the ones whose hint the person has already looked at (D-068). */
  readonly noticed: readonly string[];
}

/** Only the tail of the stats file is read: today is at its end. */
const TAIL_BYTES = 2 * 1024 * 1024;

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
    // A cut first line is not a record.
    return size > len ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    closeSync(fd);
  }
}

const localDay = (d: Date): string =>
  `${String(d.getFullYear())}-${String(d.getMonth() + 1)}-${String(d.getDate())}`;

type RunLine = { ts?: unknown; event?: unknown; file?: unknown; blocked?: unknown; reported?: unknown; findings?: unknown };

/** Documents and problems in a run of lines, each counted once. */
class Tally {
  private readonly files = new Set<string>();
  private readonly problems = new Set<string>();
  private blocked = 0;

  add(r: RunLine): void {
    if (r.event === 'review') {
      if (typeof r.findings === 'number') this.blocked += r.findings;
      return;
    }
    if (typeof r.file === 'string') this.files.add(r.file);
    if (Array.isArray(r.reported)) {
      for (const fp of r.reported) if (typeof fp === 'string') this.problems.add(fp);
    } else if (typeof r.blocked === 'number') {
      this.blocked += r.blocked; // a line from before problems were named
    }
  }

  get counts(): { checked: number; blocked: number } {
    return { checked: this.files.size, blocked: this.blocked + this.problems.size };
  }
}

function parse(line: string): RunLine | null {
  if (line === '') return null;
  try {
    const r = JSON.parse(line) as unknown;
    return r !== null && typeof r === 'object' ? r : null;
  } catch {
    return null;
  }
}

/**
 * Everything ever checked (D-066). The page asks every two seconds and the
 * file only grows, so each call reads just the lines added since the last
 * one. A file that shrank was replaced: start over.
 */
const totals = new Map<string, { offset: number; tally: Tally }>();

function allTime(file: string): { checked: number; blocked: number } {
  let t = totals.get(file);
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    totals.delete(file);
    return { checked: 0, blocked: 0 };
  }
  if (t === undefined || size < t.offset) {
    t = { offset: 0, tally: new Tally() };
    totals.set(file, t);
  }
  if (size > t.offset) {
    const fd = openSync(file, 'r');
    try {
      const buf = Buffer.alloc(size - t.offset);
      readSync(fd, buf, 0, buf.length, t.offset);
      // Only whole lines: one being written is read next time.
      const end = buf.lastIndexOf(0x0a) + 1;
      for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
        const r = parse(line);
        if (r !== null) t.tally.add(r);
      }
      t.offset += end;
    } finally {
      closeSync(fd);
    }
  }
  return t.tally.counts;
}

export function todayStats(env?: PathEnv, now: Date = new Date()): TodayStats {
  const file = dataPaths.runs(env);
  const text = tail(file);
  const today = localDay(now);
  const tally = new Tally();
  for (const line of text.split('\n')) {
    const r = parse(line);
    if (r === null || typeof r.ts !== 'string' || localDay(new Date(r.ts)) !== today) continue;
    tally.add(r);
  }
  return { ...tally.counts, total: allTime(file), ever: text.trim() !== '', waiting: waitingAgents(env), noticed: noticedAgents(env) };
}
