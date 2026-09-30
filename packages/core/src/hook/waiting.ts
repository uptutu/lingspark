import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { dataDir, type PathEnv } from '../paths.js';

/**
 * Agents connected but not heard from yet, for the client's
 * "重新打开 X 后生效" (D-064).
 *
 * An agent reads its hooks when it starts, so a newly connected one needs a
 * restart. Connecting it leaves a marker; the first call to any of its hooks
 * -- Stop fires at the end of every turn, documents or not -- removes it.
 * The client used to wait for a checked Markdown file instead, and told
 * people who had restarted and chatted to restart, forever.
 *
 * Agents connected before this existed have no marker: they are working.
 * On the hook's no-op path: one unlink of a file that is usually not there.
 */

const dir = (env?: PathEnv): string => path.join(dataDir(env), 'state', 'waiting');

/** A newly connected agent: waiting for its first hook call. Never throws. */
export function awaitFirstCall(agent: string, env?: PathEnv): void {
  try {
    mkdirSync(dir(env), { recursive: true });
    writeFileSync(path.join(dir(env), agent), new Date().toISOString());
  } catch {
    // no reminder to restart; nothing breaks
  }
}

/** Its hook ran: it is working. Also for a disconnected agent. Never throws. */
export function heardFrom(agent: string, env?: PathEnv): void {
  try {
    rmSync(path.join(dir(env), agent), { force: true });
  } catch {
    // the client keeps saying "restart" a little longer
  }
}

/**
 * The person has looked at what these agents still need (D-068): the
 * footer's light need not stay red for them while another agent works. A
 * new wait -- a reconnect -- writes the marker afresh and asks again.
 */
export function noticeWaiting(agents: readonly string[], env?: PathEnv): void {
  const waiting = new Set(waitingAgents(env));
  for (const agent of agents) {
    if (!waiting.has(agent)) continue;
    try {
      writeFileSync(path.join(dir(env), agent), NOTICED);
    } catch {
      // the light stays red a little longer
    }
  }
}
const NOTICED = 'noticed';

export function noticedAgents(env?: PathEnv): string[] {
  return waitingAgents(env).filter((agent) => {
    try {
      return readFileSync(path.join(dir(env), agent), 'utf8') === NOTICED;
    } catch {
      return false;
    }
  });
}

export function waitingAgents(env?: PathEnv): string[] {
  try {
    return readdirSync(dir(env)).sort();
  } catch {
    return [];
  }
}
