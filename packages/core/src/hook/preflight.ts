import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PathEnv } from '../paths.js';
import { gateFiles } from './gate.js';
import { ingestReview } from './review.js';
import type { HookInput } from './input.js';
import { SessionStore } from './session.js';

export type Preflight =
  | { readonly proceed: false; readonly reason: string }
  | { readonly proceed: true; readonly files: readonly string[]; readonly store: SessionStore | null };

/**
 * Everything the hook can decide without loading the checker.
 *
 * Like `gate.ts`, this module and its imports stay free of YAML, zod, remark
 * and rules, so the CLI can run it and only then pull in the heavy code. The
 * common answer -- "not a document in an opted-in project" -- is reached here.
 */
export function preflight(input: HookInput, env?: PathEnv): Preflight {
  // Cursor also runs the hooks it finds in Claude Code's settings. With our own
  // Cursor hook installed as well, only that one answers; otherwise every
  // problem would be reported twice.
  if (input.cursor && input.agent !== 'cursor' && cursorHookInstalled(env)) {
    return { proceed: false, reason: 'cursor-hook-installed' };
  }
  if (input.event === 'post-tool-use') {
    const files = gateFiles(input.files);
    if (files.length === 0) return { proceed: false, reason: 'no-candidate-files' };
    return { proceed: true, files, store: null };
  }

  // Stop. A review report the agent was asked for comes in first, whatever
  // happens next: this may well be the Stop that ends the turn (D-057).
  const store = SessionStore.open(input.sessionId, env);
  if (ingestReview(input, store, env)) {
    try {
      store.save();
    } catch {
      // the report is gone but not recorded: the documents get reviewed again
    }
  }

  // The user stopped the turn (or it failed): never start the agent again.
  if (input.aborted) return { proceed: false, reason: 'aborted' };
  // Codex tells us outright when this turn was already continued.
  if (input.stopHookActive) return { proceed: false, reason: 'stop-hook-active' };

  const files = store.snapshot.files;
  if (files.length === 0) return { proceed: false, reason: 'no-session-files' };
  return { proceed: true, files, store };
}

/** Whether ~/.cursor/hooks.json runs lingspark as Cursor. A text search: no JSON parse on the no-op path. */
function cursorHookInstalled(env?: PathEnv): boolean {
  try {
    const text = readFileSync(path.join(env?.homedir ?? os.homedir(), '.cursor', 'hooks.json'), 'utf8');
    return /lingspark[^\n]*\bhook\s+--agent\s+cursor\b/u.test(text);
  } catch {
    return false;
  }
}
