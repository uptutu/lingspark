import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { dataDir, type PathEnv } from '../paths.js';

/**
 * Remembers that an agent's CLI answered "not signed in".
 *
 * Desktop apps do not share their sign-in with the CLI they bundle: Claude
 * Code inside the Claude app, WorkBuddy's engine. The CLI is on disk, looks
 * usable, and fails on the first call. Checking sign-in up front would cost a
 * model call; remembering the failure costs nothing, so `auto` skips that CLI
 * for a while and falls back to one that works (D-055).
 */
const FORGET_AFTER_MS = 24 * 60 * 60_000;

const marker = (backend: string, env?: PathEnv): string =>
  path.join(dataDir(env), 'state', `signed-out-${backend}`);

export function markSignedOut(backend: string, env?: PathEnv): void {
  try {
    mkdirSync(path.dirname(marker(backend, env)), { recursive: true });
    writeFileSync(marker(backend, env), new Date().toISOString());
  } catch {
    // nothing remembered: the next call finds out again
  }
}

export function markSignedIn(backend: string, env?: PathEnv): void {
  rmSync(marker(backend, env), { force: true });
}

export function recentlySignedOut(backend: string, env?: PathEnv): boolean {
  const file = marker(backend, env);
  if (!existsSync(file)) return false;
  try {
    return Date.now() - statSync(file).mtimeMs < FORGET_AFTER_MS;
  } catch {
    return false;
  }
}

/** The error text a CLI gives when it has no account to use. */
export const looksSignedOut = (text: string): boolean =>
  /not logged in|please run \/login|authentication required|未登录/iu.test(text);
