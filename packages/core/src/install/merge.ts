import { agentProfile, type AgentId, type AgentProfile, type HookFormat } from '../agents.js';
import { HOOK_TIMEOUT_POST_S, HOOK_TIMEOUT_STOP_S } from '../constants.js';
import type { HookEvent } from '../hook/input.js';

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);

/** How the installed hook invokes lingspark. */
export interface HookCommand {
  /** For macOS/Linux, or every platform when `windows` is absent. */
  readonly posix: string;
  /** Written as Codex's `commandWindows`; Claude Code has no equivalent field. */
  readonly windows: string;
}

/**
 * Recognises a handler this tool installed, in any version and at any path.
 *
 * Matching on the command text rather than an exact string is what makes
 * install idempotent across upgrades: an entry left by an older lingspark at an
 * older path is still ours, gets replaced rather than duplicated, and gets
 * removed by uninstall (design doc, 5.6; section 12 on paths changing).
 */
export function isOurHandler(handler: unknown): boolean {
  if (!isObject(handler)) return false;
  const cmd = handler['command'];
  return typeof cmd === 'string' && /lingspark[^\n]*\bhook\s+--agent\b/u.test(cmd);
}

/** Event names per config layout. Every agent but Cursor uses Claude Code's spelling. */
const EVENT_KEYS: Readonly<Record<HookFormat, Readonly<Record<HookEvent, string>>>> = {
  claude: { 'post-tool-use': 'PostToolUse', stop: 'Stop' },
  cursor: { 'post-tool-use': 'afterFileEdit', stop: 'stop' },
};

/**
 * Further event names that also feed an event. Cursor reports shell commands
 * apart from file edits; documents written from the shell come in there (D-067).
 */
const MORE_KEYS: Readonly<Record<HookFormat, Partial<Readonly<Record<HookEvent, readonly string[]>>>>> = {
  claude: {},
  cursor: { 'post-tool-use': ['afterShellExecution'] },
};

function handlerFor(agent: AgentProfile, event: HookEvent, cmd: HookCommand): Json {
  const suffix = ` hook --agent ${agent.id} --event ${event}`;
  const timeout = event === 'stop' ? HOOK_TIMEOUT_STOP_S : HOOK_TIMEOUT_POST_S;
  if (agent.format === 'cursor') {
    // Cursor's own cap on stop follow-ups, as a second guard next to ours (D-003).
    return { command: cmd.posix + suffix, timeout, ...(event === 'stop' ? { loop_limit: 1 } : {}) };
  }
  return {
    type: 'command',
    command: cmd.posix + suffix,
    ...(agent.commandWindows ? { commandWindows: cmd.windows + suffix } : {}),
    timeout,
  };
}

/**
 * Our handlers in a config, in either layout: inside matcher groups
 * (Claude Code and most agents) or directly in the event list (Cursor).
 */
function ourHandlersIn(list: unknown): Json[] {
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry: unknown): Json[] => {
    if (isOurHandler(entry)) return [entry as Json];
    if (isObject(entry) && Array.isArray(entry['hooks'])) return (entry['hooks'] as unknown[]).filter(isOurHandler) as Json[];
    return [];
  });
}

/** The commands of every lingspark handler in a config file's contents. */
export function ourCommands(config: unknown): string[] {
  const hooks = isObject(config) && isObject(config['hooks']) ? config['hooks'] : {};
  return Object.values(hooks).flatMap((list) => ourHandlersIn(list).map((h) => String(h['command'])));
}

function profileOf(agent: AgentId): AgentProfile {
  const p = agentProfile(agent);
  if (p === undefined) throw new Error(`unknown agent: ${agent}`);
  return p;
}

/** Removes our handlers everywhere, dropping groups and events left empty. */
function stripOurs(hooks: Json): Json {
  const out: Json = {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      out[event] = groups; // not ours to interpret
      continue;
    }
    const kept: unknown[] = [];
    for (const group of groups) {
      if (isOurHandler(group)) continue; // a flat Cursor entry
      if (!isObject(group) || !Array.isArray(group['hooks'])) {
        kept.push(group);
        continue;
      }
      const handlers = (group['hooks'] as unknown[]).filter((h) => !isOurHandler(h));
      if (handlers.length === (group['hooks'] as unknown[]).length) {
        kept.push(group);
      } else if (handlers.length > 0) {
        kept.push({ ...group, hooks: handlers });
      }
      // else: the group held only our handler -- drop it
    }
    if (kept.length > 0 || groups.length === 0) out[event] = kept;
  }
  return out;
}

/**
 * Returns `config` with lingspark's hooks installed for `agent`.
 *
 * Everything else in the file is preserved as-is, including fields this tool
 * does not know about and other tools' hooks. Any lingspark entries already
 * present are replaced, so running install twice changes nothing the second
 * time.
 */
export function withHooksInstalled(config: unknown, agentId: AgentId, cmd: HookCommand): Json {
  const agent = profileOf(agentId);
  const base: Json = isObject(config) ? { ...config } : {};
  const hooks = stripOurs(isObject(base['hooks']) ? base['hooks'] : {});

  const add = (event: HookEvent): void => {
    const handler = handlerFor(agent, event, cmd);
    const entry: Json =
      agent.format === 'cursor'
        ? handler
        : event === 'post-tool-use'
          ? { matcher: agent.writeMatcher, hooks: [handler] }
          : { hooks: [handler] };
    for (const key of [EVENT_KEYS[agent.format][event], ...(MORE_KEYS[agent.format][event] ?? [])]) {
      const existing = Array.isArray(hooks[key]) ? (hooks[key] as unknown[]) : [];
      hooks[key] = [...existing, entry];
    }
  };
  add('post-tool-use');
  add('stop');

  // Cursor refuses a hooks.json without it.
  if (agent.format === 'cursor' && base['version'] === undefined) base['version'] = 1;
  base['hooks'] = hooks;
  return base;
}

/**
 * Returns `config` with every lingspark hook removed. Event arrays and a
 * `hooks` object left empty by the removal are removed too (design doc, 5.6),
 * so install followed by uninstall restores the original meaning.
 */
export function withHooksRemoved(config: unknown): Json {
  const base: Json = isObject(config) ? { ...config } : {};
  const original = base['hooks'];
  if (!isObject(original)) return base;
  // stripOurs already drops events that removal emptied, and keeps events
  // that were empty to begin with.
  const hooks = stripOurs(original);
  if (Object.keys(hooks).length === 0 && Object.keys(original).length > 0) {
    delete base['hooks'];
  } else {
    base['hooks'] = hooks;
  }
  return base;
}

/** Whether a config currently has lingspark hooks for both events, in either layout. */
export function hasOurHooks(config: unknown): { postToolUse: boolean; stop: boolean } {
  const hooks = isObject(config) && isObject(config['hooks']) ? config['hooks'] : {};
  const has = (event: HookEvent): boolean =>
    Object.values(EVENT_KEYS).some((keys) => ourHandlersIn(hooks[keys[event]]).length > 0);
  return { postToolUse: has('post-tool-use'), stop: has('stop') };
}
