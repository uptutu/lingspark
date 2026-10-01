import { statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentId } from '../agents.js';

export type { AgentId } from '../agents.js';
export type HookEvent = 'post-tool-use' | 'stop';

/** The normalised hook input (design doc, section 5.3). */
export interface HookInput {
  readonly agent: AgentId;
  readonly event: HookEvent;
  readonly sessionId: string;
  /**
   * Identifies the current turn: Claude Code's `prompt_id`, Codex's `turn_id`,
   * CodeBuddy's `generation_id`. Null when the agent sends none of them. Used
   * to cap Stop blocks per turn.
   */
  readonly turnId: string | null;
  readonly cwd: string;
  /** Absolute paths written by this tool call; empty for Stop. */
  readonly files: readonly string[];
  /** The raw `tool_input` payload, kept for suppression attribution (D-092). */
  readonly toolInput: unknown;
  /**
   * Codex sets `stop_hook_active` when this turn was already continued by a
   * Stop hook. Claude Code has no such field (DECISIONS V-4), so it is always
   * false there and re-entry is guarded by session state instead (D-003).
   */
  readonly stopHookActive: boolean;
  /**
   * The payload came from Cursor, either through its own hooks.json or through
   * its import of Claude Code's settings (both carry `cursor_version`). Cursor
   * cannot act on anything a file-edit hook says, and takes Stop feedback as
   * JSON on stdout rather than exit 2 plus stderr.
   */
  readonly cursor: boolean;
  /**
   * The turn did not end normally: Cursor's stop `status` is "aborted" (the
   * user stopped it) or "error". Nothing may start the agent again then.
   */
  readonly aborted: boolean;
}

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/**
 * Field names under which a written file's path has been seen. The agents have
 * renamed these between versions (DECISIONS V-3), so no single name is trusted.
 */
const PATH_KEYS = ['file_path', 'filePath', 'path', 'notebook_path', 'target_file'];

/**
 * Paths named in a Codex `apply_patch` body.
 *
 * The format is line-oriented: `*** Add File: <path>`, `*** Update File:
 * <path>`, optionally followed by `*** Move to: <path>`. Deleted files are
 * skipped -- there is nothing left to check. Anything unrecognised yields no
 * paths, which the caller treats as the no-op path.
 */
export function pathsFromApplyPatch(patch: string): string[] {
  const out: string[] = [];
  for (const raw of patch.split(/\r?\n/u)) {
    const line = raw.trim();
    const m = /^\*\*\* (Add File|Update File|Move to):\s*(.+?)\s*$/u.exec(line);
    if (m?.[2] === undefined) continue;
    if (m[1] === 'Move to') {
      // The move replaces the update target that precedes it.
      out.pop();
    }
    out.push(m[2]);
  }
  return out;
}

/** Every string anywhere inside a value, for fishing a patch out of unknown shapes. */
export function stringsIn(value: unknown, depth = 0): string[] {
  if (depth > 4) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap((v) => stringsIn(v, depth + 1));
  if (isObject(value)) return Object.values(value).flatMap((v) => stringsIn(v, depth + 1));
  return [];
}

const MARKDOWN = /\.(?:md|markdown)$/iu;

/**
 * Markdown paths a shell command names (D-067): quoted ones (which may hold
 * spaces) and bare words. Whether the command wrote them is not decided here
 * -- `cat README.md` names a file too -- the caller asks the file itself.
 */
export function pathsFromCommand(command: string): string[] {
  const text = command.replace(/\$\{?HOME\}?(?=\/)/gu, '~');
  const out = new Set<string>();
  for (const m of text.matchAll(/(["'])([^"'\n]+?)\1/gu)) {
    if (m[2] !== undefined && MARKDOWN.test(m[2])) out.add(m[2]);
  }
  // Bare words outside the quotes: a quoted name with a space is one path.
  for (const word of text.replace(/(["'])[^"'\n]*?\1/gu, ' ').split(/[\s;&|<>()`$"'=]+/u)) {
    if (MARKDOWN.test(word)) out.add(word);
  }
  return [...out];
}

/**
 * How recently a file must have changed to count as written by the command
 * that names it. A shell call reports when it ends, and a heredoc writes at
 * once; a file merely read keeps its old time. Five minutes covers a long
 * script without reaching back to yesterday's edits.
 */
export const SHELL_WRITE_WINDOW_MS = 5 * 60_000;

function recentlyWritten(file: string, now: number): boolean {
  try {
    const st = statSync(file);
    return st.isFile() && now - st.mtimeMs <= SHELL_WRITE_WINDOW_MS;
  } catch {
    return false;
  }
}

const expandHome = (p: string): string => (p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p);

/** Written file paths from a tool call's input, resolved against `cwd`. */
export function extractPaths(toolInput: unknown, cwd: string, now: number = Date.now()): string[] {
  if (!isObject(toolInput)) return [];

  const found: string[] = [];
  for (const key of PATH_KEYS) {
    const p = str(toolInput[key]);
    if (p !== null) {
      found.push(p);
      break;
    }
  }

  if (found.length === 0) {
    for (const s of stringsIn(toolInput)) {
      if (s.includes('*** Begin Patch') || /^\*\*\* (Add|Update) File:/mu.test(s)) {
        found.push(...pathsFromApplyPatch(s));
      }
    }
  }

  if (found.length > 0) return [...new Set(found.map((p) => path.resolve(cwd, p)))];

  // A shell command: the Markdown files it names that have just changed.
  const command = stringsIn(toolInput['command'] ?? toolInput['cmd']).join('\n');
  if (command === '') return [];
  const written = pathsFromCommand(command)
    .map((p) => path.resolve(cwd, expandHome(p)))
    .filter((p) => recentlyWritten(p, now));
  return [...new Set(written)];
}

/**
 * Parses and normalises the JSON an agent writes to stdin.
 *
 * Returns null for anything unusable. The caller maps null to "exit 0": a hook
 * that cannot understand its input must stay out of the way (design doc, 5.4).
 */
export function parseHookInput(raw: string, agent: AgentId, event: HookEvent): HookInput | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(data)) return null;

  // Cursor names the session `conversation_id` and sends workspace roots
  // instead of a working directory.
  const sessionId = str(data['session_id']) ?? str(data['sessionId']) ?? str(data['conversation_id']);
  const roots = data['workspace_roots'];
  const cwd = str(data['cwd']) ?? (Array.isArray(roots) ? str(roots[0]) : null) ?? process.cwd();
  if (sessionId === null) return null;

  const turnId =
    str(data['prompt_id']) ?? str(data['turn_id']) ?? str(data['generation_id']) ?? str(data['promptId']);

  return {
    agent,
    event,
    sessionId,
    turnId,
    cwd,
    // Cursor's afterFileEdit puts file_path at the top level, not in tool_input.
    files: event === 'post-tool-use' ? extractPaths(data['tool_input'] ?? data, cwd) : [],
    toolInput: event === 'post-tool-use' ? (data['tool_input'] ?? data) : null,
    // Cursor counts the follow-ups its stop hooks already caused in `loop_count`.
    stopHookActive:
      data['stop_hook_active'] === true || (typeof data['loop_count'] === 'number' && data['loop_count'] > 0),
    // Our own Cursor hook knows it is Cursor even if a build stops sending the version.
    cursor: agent === 'cursor' || typeof data['cursor_version'] === 'string',
    aborted: typeof data['status'] === 'string' && data['status'] !== 'completed',
  };
}
