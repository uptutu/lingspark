import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { dataDir, type PathEnv } from '../paths.js';

/**
 * "A check is running right now", for the client's orb (D-058).
 *
 * Each hook run that gets past preflight, and each background warm-up, leaves
 * a file named after its process id while it works. The client counts the
 * files whose process is still alive. A process killed mid-check leaves its
 * file behind; the pid test, and an age limit for reused pids, ignore it.
 */

const STALE_MS = 15 * 60_000;
const dir = (env?: PathEnv): string => path.join(dataDir(env), 'state', 'checking');

/** Marks this process as checking; call the returned function when done. Never throws. */
export function beginActivity(env?: PathEnv): () => void {
  const file = path.join(dir(env), String(process.pid));
  try {
    mkdirSync(dir(env), { recursive: true });
    writeFileSync(file, new Date().toISOString());
  } catch {
    return () => undefined;
  }
  return () => rmSync(file, { force: true });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function checkingNow(env?: PathEnv): boolean {
  let names: string[];
  try {
    names = readdirSync(dir(env));
  } catch {
    return false;
  }
  return names.some((n) => {
    const file = path.join(dir(env), n);
    try {
      if (Date.now() - statSync(file).mtimeMs > STALE_MS) return false;
    } catch {
      return false;
    }
    const pid = Number(n);
    if (Number.isInteger(pid) && pid > 0 && alive(pid)) return true;
    rmSync(file, { force: true }); // left behind by a process that is gone
    return false;
  });
}
