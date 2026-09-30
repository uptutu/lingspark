import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PROBE_TIMEOUT_MS } from '../constants.js';
import { msg } from '../messages.js';

/**
 * Whether the hook an agent's config points at can actually run here.
 *
 * The client paints a red light for an agent that has connected but not called
 * back, and until now that one colour had to stand for two very different
 * situations: the agent simply has not been restarted yet -- the ordinary
 * case, a few seconds of patience -- and the hook is broken, which never gets
 * better on its own. A person cannot tell them apart, so the red reads as
 * "it failed", and on a fresh Windows install, where the copy of the program
 * is a locked .exe and the hooks are in four configs at once, that is exactly
 * what it looks like (D-077).
 *
 * So the client runs the very command it wrote, once, and finds out. This
 * proves our side: the program exists, starts, takes the arguments and exits
 * cleanly. It says nothing about whether the agent will call -- only the agent
 * knows that, and the light stays "not yet" until it does.
 */

export interface HookProbe {
  readonly ok: boolean;
  /** In the user's words; empty when nothing is wrong. */
  readonly detail: string;
}

const OK: HookProbe = { ok: true, detail: '' };

/**
 * The executable and the arguments in front of it, from a command we wrote:
 * `"C:\...\lingspark.exe" "C:\...\lingspark.cjs" hook --agent ...` is a
 * program and one argument, `"…/lingspark" hook --agent ...` is just a
 * program. Returns null for anything else, which is the only shape `install`
 * ever writes -- and the only shape it is safe to run: a command with shell
 * syntax in it is somebody else's, and running it to "test" it is not ours to
 * do.
 */
export function hookCommandParts(command: string): { exe: string; args: string[] } | null {
  const head = command.split(/\s+hook\s+--agent\b/u)[0] ?? '';
  const quoted = [...head.matchAll(/"([^"]+)"/gu)].map((m) => m[1] ?? '').filter((p) => p !== '');
  const [exe, ...args] = quoted;
  return exe === undefined || head.trim() !== quoted.map((q) => `"${q}"`).join(' ') ? null : { exe, args };
}

/** Keyed by the program and when it changed: one run per install, not per click. */
const cache = new Map<string, HookProbe>();

function stamp(file: string): string {
  try {
    const s = statSync(file);
    return `${String(s.mtimeMs)}:${String(s.size)}`;
  } catch {
    return 'gone';
  }
}

/**
 * Runs one of our hook commands for `agent` and reports whether it worked.
 *
 * The run is given a scratch data directory: the hook must not clear the real
 * "waiting for first call" marker, because the agent has not made that call --
 * this is the client asking whether it *could*, which is a different question.
 */
export function probeHook(agent: string, commands: readonly string[]): HookProbe {
  const command = commands.find((c) => new RegExp(`\\bhook\\s+--agent\\s+${agent}\\b`, 'u').test(c)) ?? commands[0];
  if (command === undefined) return { ok: false, detail: msg.probe.noCommand };
  const parts = hookCommandParts(command);
  if (parts === null) return { ok: false, detail: msg.probe.unreadable(command) };
  if (!existsSync(parts.exe)) return { ok: false, detail: msg.probe.noBinary(parts.exe) };

  const key = `${parts.exe}|${parts.args.join(' ')}|${stamp(parts.exe)}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const scratch = mkdtempSync(path.join(tmpdir(), 'lingspark-probe-'));
  let result: HookProbe;
  try {
    const r = spawnSync(parts.exe, [...parts.args, 'hook', '--agent', agent, '--event', 'stop'], {
      stdio: 'ignore',
      timeout: PROBE_TIMEOUT_MS,
      env: { ...process.env, LINGSPARK_DATA_DIR: scratch },
      windowsHide: true,
    });
    // A timeout kills the child: no exit code, and a signal to say why.
    if (r.status === 0) result = OK;
    else if (r.status === null) result = { ok: false, detail: msg.probe.slow(parts.exe) };
    else if (r.error !== undefined) result = { ok: false, detail: msg.probe.spawnFailed(parts.exe, r.error.message) };
    else result = { ok: false, detail: msg.probe.badExit(parts.exe, String(r.status)) };
  } catch (caught: unknown) {
    // spawnSync only throws on a malformed call; never let a probe take the
    // client down with it.
    result = {
      ok: false,
      detail: msg.probe.spawnFailed(parts.exe, caught instanceof Error ? caught.message : String(caught)),
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  cache.set(key, result);
  return result;
}
