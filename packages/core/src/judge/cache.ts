import { createHash } from 'node:crypto';
import { readdirSync, rmSync, statSync, utimesSync } from 'node:fs';
import path from 'node:path';
import { readJsonOrNull, writeFileAtomic } from '../fsutil.js';
import { normalizeText } from '../parser/text.js';
import { dataPaths, type PathEnv } from '../paths.js';
import type { Answer } from './types.js';

/**
 * Cache key (design doc, 8.4): judge + rule + rule version + normalised
 * state. Changing a rule's wording means bumping its version, which retires
 * every answer given to the old wording.
 */
export function cacheKey(judgeId: string, ruleId: string, ruleVersion: number, state: string): string {
  return createHash('sha256')
    .update(`${judgeId}\u0000${ruleId}\u0000${String(ruleVersion)}\u0000${normalizeText(state)}`, 'utf8')
    .digest('hex');
}

interface Entry {
  readonly answer: Answer;
  readonly ts: string;
}

/**
 * Judge answers on disk, one JSON file per answer, sharded by the first two
 * hex digits of the key (8.4). Plain files, no database: a native module
 * would make the two-platform build fragile (4.2).
 *
 * Reads and writes never throw. A cache that cannot be read is a cache miss;
 * one that cannot be written is a cache that does not remember.
 */
export class JudgeCache {
  constructor(private readonly env?: PathEnv) {}

  private file(key: string): string {
    return path.join(dataPaths.cache(this.env), key.slice(0, 2), `${key}.json`);
  }

  get(key: string): Answer | null {
    const file = this.file(key);
    const raw = readJsonOrNull(file) as Entry | null;
    if (raw === null || typeof raw !== 'object' || raw.answer === undefined) return null;
    // Touch on read, so cleanup evicts what has not been *used*, not what
    // was written long ago.
    try {
      const now = new Date();
      utimesSync(file, now, now);
    } catch {
      // read-only cache still works
    }
    return raw.answer;
  }

  set(key: string, answer: Answer): void {
    try {
      writeFileAtomic(this.file(key), JSON.stringify({ answer, ts: new Date().toISOString() } satisfies Entry));
    } catch {
      // not remembered this time
    }
  }
}

export interface CacheSweep {
  readonly removedExpired: number;
  readonly removedForSize: number;
  readonly bytesAfter: number;
}

/**
 * Evicts entries unused for `maxAgeDays`, then the least recently used until
 * the total is under `maxBytes` (8.4). Only called from non-interactive
 * commands -- never on the hook path.
 */
export function sweepCache(
  env?: PathEnv,
  opts: { maxAgeDays?: number; maxBytes?: number; now?: number } = {},
): CacheSweep {
  const root = dataPaths.cache(env);
  const maxAge = (opts.maxAgeDays ?? 30) * 86_400_000;
  const maxBytes = opts.maxBytes ?? 200 * 1024 * 1024;
  const now = opts.now ?? Date.now();

  const entries: { file: string; size: number; used: number }[] = [];
  let shards: string[];
  try {
    shards = readdirSync(root);
  } catch {
    return { removedExpired: 0, removedForSize: 0, bytesAfter: 0 };
  }
  for (const shard of shards) {
    let names: string[];
    try {
      names = readdirSync(path.join(root, shard));
    } catch {
      continue;
    }
    for (const n of names) {
      const file = path.join(root, shard, n);
      try {
        const st = statSync(file);
        entries.push({ file, size: st.size, used: st.mtimeMs });
      } catch {
        // gone
      }
    }
  }

  let removedExpired = 0;
  let removedForSize = 0;
  const kept: typeof entries = [];
  for (const e of entries) {
    if (now - e.used > maxAge) {
      rmSync(e.file, { force: true });
      removedExpired++;
    } else {
      kept.push(e);
    }
  }

  let total = kept.reduce((s, e) => s + e.size, 0);
  kept.sort((a, b) => a.used - b.used);
  for (const e of kept) {
    if (total <= maxBytes) break;
    rmSync(e.file, { force: true });
    total -= e.size;
    removedForSize++;
  }
  return { removedExpired, removedForSize, bytesAfter: total };
}
