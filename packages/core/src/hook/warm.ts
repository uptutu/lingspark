import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createChecker } from '../check.js';
import { log } from '../log.js';
import { dataDir, type PathEnv } from '../paths.js';
import { SessionStore } from './session.js';
import { beginActivity } from './activity.js';

/**
 * Background warm-up (DECISIONS D-046).
 *
 * The Stop hook has a minute. A judge that borrows the user's Codex or Claude
 * Code takes tens of seconds per call, and the cross-document check needs
 * several calls per document -- more than a minute on its own. But an agent
 * writing a set of documents takes minutes between its first write and its
 * Stop. So after each write, the hook queues the file and makes sure one
 * background process per session is working through the queue: the same
 * checks Stop will run, with no deadline, their answers landing in the
 * caches Stop reads. Per session, because that is what Stop compares the
 * documents against (D-050).
 *
 * Nothing here may ever affect the agent: the hook only appends to a file and
 * starts a detached process; the process's failures go to the log.
 */

const WARM_BUDGET_MS = 15 * 60_000;
/** A lock older than this belongs to a process that died without cleaning up. */
const STALE_LOCK_MS = 20 * 60_000;
const MAX_ROUNDS = 10;

const keyOf = (session: string): string => createHash('sha256').update(session).digest('hex').slice(0, 16);
const dir = (env?: PathEnv): string => path.join(dataDir(env), 'warm');
const queueFile = (session: string, env?: PathEnv): string => path.join(dir(env), `${keyOf(session)}.queue`);
const lockFile = (session: string, env?: PathEnv): string => path.join(dir(env), `${keyOf(session)}.lock`);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Whether a warm-up for this session is running now. */
export function warmRunning(session: string, env?: PathEnv): boolean {
  const file = lockFile(session, env);
  try {
    if (Date.now() - statSync(file).mtimeMs > STALE_LOCK_MS) return false;
    return alive(Number(readFileSync(file, 'utf8').trim()));
  } catch {
    return false;
  }
}

/**
 * Queues written files for the session's warm-up. Returns true when no
 * warm-up is running, so the caller should start one.
 */
export function enqueueWarm(session: string, files: readonly string[], env?: PathEnv): boolean {
  try {
    mkdirSync(dir(env), { recursive: true });
    appendFileSync(queueFile(session, env), files.map((f) => `${f}\n`).join(''));
    return !warmRunning(session, env);
  } catch {
    return false;
  }
}

function takeQueue(session: string, env?: PathEnv): string[] {
  // Move the queue aside before reading it: a hook appending meanwhile writes
  // a new queue file instead of a line that would be deleted unread.
  const file = queueFile(session, env);
  const taken = `${file}.${String(process.pid)}`;
  let text = '';
  try {
    renameSync(file, taken);
    text = readFileSync(taken, 'utf8');
    rmSync(taken, { force: true });
  } catch {
    return [];
  }
  return [...new Set(text.split('\n').filter((l) => l !== ''))];
}

/**
 * Waits until the session's warm-up is done or `deadline` (a performance.now()
 * time) passes. Stop uses it rather than asking the model the same questions
 * the warm-up is asking at that moment (D-052).
 */
export async function waitForWarm(session: string, deadline: number, env?: PathEnv): Promise<void> {
  while (warmRunning(session, env) && performance.now() < deadline) {
    await new Promise((r) => setTimeout(r, Math.min(500, Math.max(0, deadline - performance.now()))));
  }
}

export interface WarmDeps {
  readonly builtinRules: readonly { file: string; yaml: string }[];
  readonly pathEnv?: PathEnv;
  /** The agent that wrote the files; `judge.backend: auto` judges with it. */
  readonly agent?: string;
}

/**
 * Works through the session's queue: Pass 2 on each queued file, then Pass 3
 * with them as the focus against everything the session wrote, until the
 * queue stays empty. One process per session; a second one started meanwhile
 * exits at once.
 */
export async function runWarm(session: string, deps: WarmDeps): Promise<void> {
  const env = deps.pathEnv;
  if (warmRunning(session, env)) return;
  const lock = lockFile(session, env);
  const mine = String(process.pid);
  try {
    mkdirSync(dir(env), { recursive: true });
    // A lock left by a process that is gone is not a lock.
    if (existsSync(lock)) rmSync(lock, { force: true });
    // Exclusive create: two warm-ups started by parallel writes cannot both
    // get past here, so one never works under the other's lock.
    writeFileSync(lock, mine, { flag: 'wx' });
  } catch {
    return;
  }
  const done = beginActivity(env);
  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const files = takeQueue(session, env);
      if (files.length === 0) break;
      const checker = createChecker({
        builtinRules: deps.builtinRules,
        passSet: 'hookStop',
        respectScope: true,
        judgeBudgetMs: WARM_BUDGET_MS,
        ...(deps.agent !== undefined ? { agent: deps.agent } : {}),
        ...(env !== undefined ? { pathEnv: env } : {}),
      });
      for (const f of files) await checker.checkFile(f);
      const corpus = SessionStore.open(session, env).snapshot.files;
      await checker.checkAcross(files, { focus: true, budgetMs: WARM_BUDGET_MS, corpus });
    }
  } catch (err: unknown) {
    log('warn', `warm-up failed: ${err instanceof Error ? err.message : String(err)}`, env);
  } finally {
    done();
    // Only our own lock: never one another warm-up has taken since.
    try {
      if (readFileSync(lock, 'utf8').trim() === mine) rmSync(lock, { force: true });
    } catch {
      // already gone
    }
  }
}
