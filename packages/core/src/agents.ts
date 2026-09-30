import path from 'node:path';

/**
 * Every coding agent lingspark knows how to sit beside, in one place.
 *
 * The product supports four agents -- Claude Code, Codex, Cursor and
 * WorkBuddy (D-060) -- and most of them follow the hook
 * protocol Claude Code introduced: a `hooks` object keyed by event, matcher
 * groups, command handlers, JSON on stdin, exit 2 plus stderr to push back.
 * So the runtime side is shared, and what differs per agent is data: where its
 * hook config lives, and how sure we are of the details.
 *
 * This module is imported on the hook no-op path; keep it free of anything
 * heavier than `node:path`.
 */

/**
 * How much of an agent's hook contract has been checked.
 *
 * - `docs`: event names, stdin fields, exit-code semantics and the config
 *   location were read from the vendor's own documentation.
 * - `community`: the agent has hooks, but the details come from third parties
 *   or from nothing at all. lingspark will run as such an agent's hook, but will
 *   not write into its config file on its own: writing a format we have not
 *   verified risks breaking the user's agent (DECISIONS D-030).
 */
export type Verification = 'docs' | 'community';

/**
 * How an agent lays out its hook config.
 *
 * - `claude`: Claude Code's layout, which most agents copied: `hooks` keyed by
 *   `PostToolUse` / `Stop`, each a list of matcher groups holding handlers.
 * - `cursor`: Cursor's own layout: `version: 1`, `hooks` keyed by camelCase
 *   events (`afterFileEdit`, `stop`), each a flat list of handlers. Cursor also
 *   answers differently -- see HookInput.cursor.
 */
export type HookFormat = 'claude' | 'cursor';

export interface AgentProfile {
  readonly id: string;
  readonly name: string;
  readonly verification: Verification;
  /** Where the hook config lives, relative to the home or project directory; null when unknown. */
  readonly configFile: readonly string[] | null;
  /** Codex accepts a Windows-specific command next to `command`. */
  readonly commandWindows: boolean;
  /** Tool-name pattern for PostToolUse. Every agent documented so far takes `A|B` alternation. */
  readonly writeMatcher: string;
  readonly format: HookFormat;
  /**
   * What proves the agent is installed when its config directory alone does
   * not: another product can create that directory. WorkBuddy runs the
   * CodeBuddy engine and leaves a ~/.codebuddy behind on machines that never
   * had CodeBuddy. Any listed command on PATH, or app in an Applications
   * folder, counts. Absent: the directory is enough.
   */
  readonly installedWhen?: { readonly commands: readonly string[]; readonly apps: readonly string[] };
  /**
   * What the user still has to do in the agent after lingspark wrote its
   * config, in the user's words. Codex skips a hook nobody has reviewed and
   * says nothing about it, so without this step "connected" is not true.
   */
  readonly afterInstall?: string;
  /**
   * The judge backend that runs this agent itself in the background, for
   * `judge.backend: auto`: the agent that wrote a document judges it, and the
   * user needs no second product (D-055). Absent: the agent has no CLI
   * lingspark can drive yet, and auto falls back to another signed-in one.
   */
  readonly judgeBackend?: 'agent-cli' | 'codex-cli';
  /** What turns this agent's own judging on when it is off, in the user's words (D-056). */
  readonly selfReviewStep?: string;
  /** Where the facts in this profile came from. */
  readonly source: string;
}

/**
 * Tool names that write files, as documented across agents. A name no agent
 * uses matches nothing and costs nothing; a missing one silently turns the
 * check off (DECISIONS V-3), so the list errs long.
 *
 * Shell tools are in it too (D-067): agents write documents with
 * `cat > x.md <<EOF` as often as with their write tool. Most shell calls
 * name no Markdown file and leave on the no-op path.
 */
const WRITE_TOOLS =
  'Write|Edit|MultiEdit|NotebookEdit|apply_patch|Bash|shell|local_shell|exec_command|execute_command|run_command|run_terminal_cmd';

export const AGENTS: readonly AgentProfile[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    verification: 'docs',
    configFile: ['.claude', 'settings.json'],
    commandWindows: false,
    writeMatcher: WRITE_TOOLS,
    format: 'claude',
    judgeBackend: 'agent-cli',
    selfReviewStep: '在终端里运行一次 Claude Code 的命令行并登录（桌面应用里的登录不会给后台用）',
    source: 'https://code.claude.com/docs/en/hooks',
  },
  {
    id: 'codex',
    name: 'Codex',
    verification: 'docs',
    // hooks.json, never config.toml (DECISIONS D-021).
    configFile: ['.codex', 'hooks.json'],
    commandWindows: true,
    writeMatcher: WRITE_TOOLS,
    format: 'claude',
    judgeBackend: 'codex-cli',
    selfReviewStep: '登录 ChatGPT 桌面版或 Codex 命令行',
    afterInstall: '还差一步：在 Codex 里输入 /hooks，把 LingSpark 的两个挂钩标为信任。没信任之前，Codex 会不声不响地跳过它们。',
    source: 'https://learn.chatgpt.com/docs/hooks',
  },
  {
    id: 'cursor',
    name: 'Cursor',
    verification: 'docs',
    configFile: ['.cursor', 'hooks.json'],
    commandWindows: false,
    // Unused: afterFileEdit fires for file edits only, and takes no matcher.
    writeMatcher: WRITE_TOOLS,
    format: 'cursor',
    source: 'https://cursor.com/docs/agent/hooks',
  },
  {
    id: 'workbuddy',
    name: 'WorkBuddy',
    verification: 'docs',
    // WorkBuddy runs the CodeBuddy engine with its config directory set to
    // ~/.workbuddy (~/.workbuddy-ai for the overseas build, not handled). The
    // hook format and semantics are in Tencent's WorkBuddy docs; the location
    // for the personal edition was read from WorkBuddy 5.6.2 itself (D-051).
    configFile: ['.workbuddy', 'settings.json'],
    commandWindows: false,
    writeMatcher: WRITE_TOOLS,
    format: 'claude',
    source: 'https://cloud.tencent.com/document/product/1831/134517',
  },
];

/**
 * Directories where coding agents keep their own files: settings, memory,
 * plans, skills, commands. The Markdown in them is written for an agent, not
 * for a person, and an agent updating its memory is exactly when a hook must
 * stay out of the way -- so nothing under them is ever checked, wherever they
 * sit (home directory or project). Every registered agent's config directory,
 * plus agents lingspark does not hook into but whose files it can still meet.
 */
export const AGENT_DIRS: ReadonlySet<string> = new Set([
  ...AGENTS.flatMap((a) => (a.configFile === null ? [] : [a.configFile[0] as string])),
  // Agents lingspark does not support (D-060) still keep their own files here.
  '.qoder',
  '.codebuddy',
  '.trae',
  '.trae-cn',
  '.kimi',
  '.gemini',
  '.windsurf',
  '.github',
]);

export type AgentId = string;

export const AGENT_IDS: readonly string[] = AGENTS.map((a) => a.id);

export function agentProfile(id: string): AgentProfile | undefined {
  return AGENTS.find((a) => a.id === id);
}

/** Agents lingspark can install itself into without help. */
export function installableAgents(): AgentProfile[] {
  return AGENTS.filter((a) => a.verification === 'docs' && a.configFile !== null);
}

export type InstallScope = 'user' | 'project';

/** Absolute path of an agent's hook config, or null when it is not known. */
export function agentConfigFile(
  profile: AgentProfile,
  scope: InstallScope,
  where: { homedir: string; projectDir: string },
): string | null {
  if (profile.configFile === null) return null;
  const base = scope === 'user' ? where.homedir : path.resolve(where.projectDir);
  return path.join(base, ...profile.configFile);
}
