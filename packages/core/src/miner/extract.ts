import { parseDocument } from '../parser/parse.js';
import type { Block, Range } from '../parser/types.js';
import type { SessionEvent } from './types.js';

/** A revision the user asked for: what the model wrote, what they said, what it became. */
export interface Revision {
  readonly sessionId: string;
  /** The prompt's own id when the agent records one; otherwise the event id. */
  readonly promptKey: string;
  readonly ts: string;
  readonly cwd: string;
  readonly feedback: string;
  readonly file: string;
  readonly before: string;
  readonly after: string;
}

export interface FindRevisionsOptions {
  /** Whether a written file is a document in an authorised project. */
  readonly isEligible: (absPath: string) => boolean;
  /** Only prompts from lines past this byte offset are new. Context before it is still used. */
  readonly newSince?: number;
}

/**
 * Finds W1 -> U -> W2..Wk sequences (design doc, 9.4).
 *
 * W1 is any earlier write to a file F by the model; U is a user prompt; W2..Wk
 * are writes to F before the next user prompt. Other events may sit anywhere
 * in between. `before` is F as it stood just before W2 -- which may include
 * edits the user made by hand, since each write records the file as it found
 * it -- and `after` is F after Wk.
 */
export function findRevisions(events: readonly SessionEvent[], opts: FindRevisionsOptions): Revision[] {
  const out: Revision[] = [];
  const writtenByModel = new Set<string>();
  const newSince = opts.newSince ?? -1;

  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e === undefined) continue;
    if (e.kind === 'file_write') {
      writtenByModel.add(e.path);
      continue;
    }

    // e is a user prompt U. Gather the writes it provoked.
    const firstAfter = new Map<string, Extract<SessionEvent, { kind: 'file_write' }>>();
    const lastAfter = new Map<string, Extract<SessionEvent, { kind: 'file_write' }>>();
    for (let j = i + 1; j < events.length; j++) {
      const w = events[j];
      if (w === undefined || w.kind === 'user_prompt') break;
      if (!writtenByModel.has(w.path)) continue;
      if (!firstAfter.has(w.path)) firstAfter.set(w.path, w);
      lastAfter.set(w.path, w);
    }

    if (e.offset <= newSince) continue;

    for (const [file, first] of firstAfter) {
      const last = lastAfter.get(file);
      if (last === undefined || first.before === null) continue;
      if (!opts.isEligible(file)) continue;
      if (first.before === last.after) continue; // the edits cancelled out
      out.push({
        sessionId: e.sessionId,
        promptKey: e.promptId ?? e.id,
        ts: e.ts,
        cwd: e.cwd,
        feedback: e.text,
        file,
        before: first.before,
        after: last.after,
      });
    }
  }
  return out;
}

export interface BlockChange {
  readonly before: string;
  readonly after: string;
  readonly headingPath: readonly string[];
  /** Where the changed text sat in the old version, for matching diagnostics. */
  readonly beforeRange: Range | null;
}

export interface BlockDiff {
  readonly changes: readonly BlockChange[];
  /** Changed characters over all characters, both versions counted. */
  readonly changedRatio: number;
}

/**
 * Block-level diff between two versions of a document.
 *
 * Blocks are compared by their normalised-text hash, so rewrapping a
 * paragraph is not a change. Runs of removed and added blocks between two
 * matching blocks are paired into one change: that is how a reworded
 * paragraph shows up.
 */
export function diffBlocks(before: string, after: string): BlockDiff {
  const a = parseDocument(before, { file: 'before.md' }).blocks;
  const b = parseDocument(after, { file: 'after.md' }).blocks;

  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      const row = lcs[i] as number[];
      row[j] =
        a[i]?.hash === b[j]?.hash
          ? ((lcs[i + 1] as number[])[j + 1] ?? 0) + 1
          : Math.max((lcs[i + 1] as number[])[j] ?? 0, row[j + 1] ?? 0);
    }
  }

  const changes: BlockChange[] = [];
  let removed: Block[] = [];
  let added: Block[] = [];
  let changedChars = 0;

  const flush = (): void => {
    if (removed.length === 0 && added.length === 0) return;
    const text = (bs: Block[]): string => bs.map((x) => x.text).join('\n');
    const first = removed[0];
    const last = removed[removed.length - 1];
    changes.push({
      before: text(removed),
      after: text(added),
      headingPath: (first ?? added[0])?.headingPath ?? [],
      beforeRange: first !== undefined && last !== undefined ? { start: first.range.start, end: last.range.end } : null,
    });
    changedChars += text(removed).length + text(added).length;
    removed = [];
    added = [];
  };

  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i]?.hash === b[j]?.hash) {
      flush();
      i++;
      j++;
    } else if (i < a.length && (j >= b.length || ((lcs[i + 1] as number[])[j] ?? 0) >= ((lcs[i] as number[])[j + 1] ?? 0))) {
      removed.push(a[i] as Block);
      i++;
    } else {
      added.push(b[j] as Block);
      j++;
    }
  }
  flush();

  const total = a.reduce((n, x) => n + x.text.length, 0) + b.reduce((n, x) => n + x.text.length, 0);
  return { changes, changedRatio: total === 0 ? 0 : changedChars / total };
}

/**
 * Past this share of changed text, a revision is a rewrite: the link between
 * the user's words and any particular change is too weak to learn from
 * (design doc, 9.4).
 */
export const REWRITE_RATIO = 0.6;
