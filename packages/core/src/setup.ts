import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { awaitFirstCall, heardFrom, waitingAgents } from './hook/waiting.js';
import { probeHook, type HookProbe } from './hook/probe.js';
import { isMap, parseDocument } from 'yaml';
import { AGENTS, agentConfigFile, agentProfile, type AgentProfile } from './agents.js';
import type { JudgeBackendId } from './config/schema.js';
import { writeFileAtomic } from './fsutil.js';
import { ourCommands, ourCommandsInText, withPluginInstalled, withPluginRemoved } from './install/merge.js';
import { bridgeContent, bridgePath, opencodePluginUrl, removeBridge, writeBridge } from './install/bridge.js';
import { agentBackendUsable, resolveAuto } from './judge/factory.js';
import { applyChange, configFileFor, installBinary, installedBinaryDir, planChange, planInstall, planUninstall } from './install/install.js';
import { findClaudeCli } from './judge/agent-cli.js';
import { findCodexCli } from './judge/codex-cli.js';
import { findPiCli, piAuthFile } from './judge/pi-cli.js';
import { findOpencodeCli, opencodeAuthFile } from './judge/opencode-cli.js';
import { getCredential } from './judge/credentials.js';
import { msg } from './messages.js';
import { dataDir, dataPaths, type PathEnv } from './paths.js';

/**
 * One-step setup (`lingspark setup` and the setup page): find the agents on
 * this machine, hook into them, pick a judge that will actually work, and opt
 * folders in. Everything here is also reachable piecemeal through `install`,
 * the config files and `doctor`; this is the path for people who never want
 * to see those.
 */

export interface SetupEnv {
  readonly homedir?: string;
  readonly pathEnv?: PathEnv;
  /** Replaced in tests; runs `codex login status`. */
  readonly codexLoggedIn?: (cli: string) => boolean;
  /**
   * The lingspark executable hooks should run. Defaults to the running
   * program; the desktop app passes the CLI it ships, because hooks must never
   * launch the app itself.
   */
  readonly binary?: string;
  /**
   * Replaced in tests; runs the agent's own hook command once to find out
   * whether it can run here (D-077). Only ever called for an agent that is
   * connected but has not called back, so a working install spawns nothing.
   */
  readonly probe?: (agent: string, commands: readonly string[]) => HookProbe;
}

export interface AgentStatus {
  readonly id: string;
  readonly name: string;
  /** Its home directory exists: the agent has been used on this machine. */
  readonly present: boolean;
  /** lingspark can write its hook config (verified from official docs). */
  readonly installable: boolean;
  /**
   * The agent itself is on this machine: its directory exists and, for the
   * agents whose directory another product also creates, the program is where
   * it should be (D-081). False means the hooks in its config are a leftover.
   */
  readonly found: boolean;
  readonly installed: boolean;
  readonly configFile: string | null;
  /** configFile with the home directory written as ~, for display. */
  readonly shownAs: string | null;
  /** A step the user still has to take in the agent itself (AgentProfile.afterInstall). */
  readonly afterInstall: string | null;
  /** Whether this agent can judge its own documents now (judge.backend auto, D-056). */
  readonly selfReview: boolean;
  /** When it cannot: the step that turns it on, or null while lingspark has no driver for it. */
  readonly selfReviewStep: string | null;
  /**
   * Whether the hook command lingspark wrote can run here, once it has run it
   * itself. Null for an agent that is not connected, and for one that has
   * already called back -- there is nothing left to wonder about (D-077).
   */
  readonly hook: HookProbe | null;
}

export interface JudgeOption {
  readonly backend: Exclude<JudgeBackendId, 'mock' | 'so1-local'>;
  readonly label: string;
  readonly available: boolean;
  /** Why it is or is not available, in the user's words. */
  readonly detail: string;
}

export interface SetupState {
  readonly agents: readonly AgentStatus[];
  readonly judge: { readonly current: string | null; readonly options: readonly JudgeOption[]; readonly recommended: string | null };
  readonly dataDir: string;
}

const home = (e: SetupEnv): string => e.homedir ?? os.homedir();
const nameOf = (id: string): string => AGENTS.find((a) => a.id === id)?.name ?? id;

function hasOurHook(file: string): boolean {
  return ourCommandsIn(file).length > 0;
}

/**
 * Our hook commands in a config file, empty when it is missing or unreadable.
 * Bridge files (pi/opencode) are not JSON: their commands are matched as text
 * (D-102), so detection treats a generated bridge exactly like a config.
 */
function ourCommandsIn(file: string): string[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  try {
    return ourCommands(JSON.parse(text));
  } catch {
    return ourCommandsInText(text);
  }
}

/**
 * Where an app sits on each platform, for `installedWhen.apps` to be looked
 * for under. This only ever knew about Applications folders, so the check
 * could not see an app on Windows or Linux at all (D-081).
 */
function appRoots(e: SetupEnv): string[] {
  const env = e.pathEnv?.env ?? process.env;
  switch (e.pathEnv?.platform ?? process.platform) {
    case 'darwin':
      return ['/Applications', path.join(home(e), 'Applications')];
    case 'win32':
      return [
        env['ProgramFiles'],
        env['ProgramFiles(x86)'],
        // Where Windows puts a per-user install, which is where the GUI agents
        // we know about go.
        env['LOCALAPPDATA'] === undefined ? undefined : path.join(env['LOCALAPPDATA'], 'Programs'),
        path.join(home(e), 'AppData', 'Local', 'Programs'),
      ].filter((d): d is string => d !== undefined);
    default:
      return ['/usr/bin', '/usr/local/bin', '/usr/share', '/opt', '/snap'];
  }
}

/**
 * Whether a command is on PATH, or an app sits where its platform puts one.
 *
 * App names are written with `/` in the profile and split here, so one list
 * can name a `.app` bundle and a `Program.exe` side by side. `doctor` asks the
 * same question, so the two never disagree about whether an agent is really
 * here (D-081).
 */
export function evidenceOf(proof: NonNullable<AgentProfile['installedWhen']>, e: SetupEnv): boolean {
  const env = e.pathEnv?.env ?? process.env;
  const exts = (e.pathEnv?.platform ?? process.platform) === 'win32' ? ['.exe', '.cmd', ''] : [''];
  const dirs = (env['PATH'] ?? '').split(path.delimiter).filter((d) => d !== '');
  if (proof.commands.some((c) => dirs.some((d) => exts.some((x) => existsSync(path.join(d, c + x)))))) return true;
  const roots = appRoots(e);
  return proof.apps.some((app) => roots.some((r) => existsSync(path.join(r, ...app.split('/')))));
}

export function agentStatuses(e: SetupEnv = {}): AgentStatus[] {
  const probe = e.probe ?? probeHook;
  // An agent that has not called back is the only one worth asking about: the
  // question the client cannot answer from disk is whether our own hook runs.
  const waiting = new Set(waitingAgents(e.pathEnv));
  return AGENTS.filter((a) => a.configFile !== null).map((a: AgentProfile) => {
    const file = agentConfigFile(a, 'user', { homedir: home(e), projectDir: process.cwd() });
    const dir = a.dirMarker ?? (a.configFile === null ? undefined : [a.configFile[0] as string]);
    const installed = file !== null && existsSync(file) && hasOurHook(file);
    const dirFound = dir !== undefined && existsSync(path.join(home(e), ...dir));
    const found = a.installedWhen === undefined || evidenceOf(a.installedWhen, e);
    return {
      id: a.id,
      name: a.name,
      // A hook we installed keeps the agent listed, so it can be turned off.
      present: installed || (dirFound && found),
      found,
      installable: a.verification === 'docs',
      installed,
      configFile: file,
      shownAs: file === null ? null : file.startsWith(home(e) + path.sep) ? `~${file.slice(home(e).length)}` : file,
      afterInstall: a.afterInstall ?? null,
      selfReview: a.judgeBackend !== undefined && agentBackendUsable(a.judgeBackend, e.pathEnv),
      selfReviewStep: a.selfReviewStep ?? null,
      hook: installed && waiting.has(a.id) && file !== null ? probe(a.id, ourCommandsIn(file)) : null,
    };
  });
}

export const defaultCodexLoggedIn = (cli: string): boolean => {
  const r = spawnSync(cli, ['login', 'status'], { encoding: 'utf8', timeout: 15_000 });
  return r.status === 0 && /logged in/iu.test(`${r.stdout}${r.stderr}`);
};

/**
 * What could answer semantic questions on this machine, most convenient first:
 * a subscription the user already signed into beats a key, and a key beats a
 * CLI whose sign-in we cannot confirm without a slow test call.
 */
export function judgeOptions(e: SetupEnv = {}): JudgeOption[] {
  const env = e.pathEnv;
  const codex = findCodexCli();
  const codexOk = codex !== null && (e.codexLoggedIn ?? defaultCodexLoggedIn)(codex);
  const claude = findClaudeCli();
  const pi = findPiCli();
  const piOk = pi !== null && existsSync(piAuthFile(env?.homedir ?? os.homedir()));
  const opencode = findOpencodeCli();
  const opencodeOk = opencode !== null && existsSync(opencodeAuthFile(env?.homedir ?? os.homedir()));
  const has = (p: 'anthropic' | 'typesafe'): boolean => getCredential(p, env) !== null;
  const auto = resolveAuto(undefined, env);
  return [
    {
      // D-057: the writing agent reviews in its own conversation; nothing to set up.
      backend: 'session',
      label: '对话内自审（推荐）',
      available: true,
      detail: msg.setup.sessionReview,
    },
    {
      // D-055/D-056: the writing agent, run in the background; needs its CLI signed in.
      backend: 'auto',
      label: '独立审稿',
      available: true,
      detail: auto === null ? msg.setup.autoNone : msg.setup.autoReady,
    },
    {
      backend: 'codex-cli',
      label: 'ChatGPT',
      available: codexOk,
      detail: codex === null ? msg.setup.codexMissing : codexOk ? msg.setup.codexReady : msg.setup.codexLoggedOut,
    },
    {
      backend: 'anthropic',
      label: 'Claude（按用量付费）',
      available: has('anthropic'),
      detail: has('anthropic') ? msg.setup.keyFound : msg.setup.keyMissing,
    },
    {
      backend: 'typesafe',
      label: 'Jev（按用量付费）',
      available: has('typesafe'),
      detail: has('typesafe') ? msg.setup.keyFound : msg.setup.keyMissing,
    },
    {
      backend: 'agent-cli',
      label: 'Claude',
      available: claude !== null,
      detail: claude === null ? msg.setup.claudeMissing : msg.setup.claudeFound,
    },
    {
      backend: 'pi-cli',
      label: 'pi',
      available: piOk,
      detail: pi === null ? msg.setup.piMissing : piOk ? msg.setup.piFound : msg.setup.piMissing,
    },
    {
      backend: 'opencode-cli',
      label: 'opencode',
      available: opencodeOk,
      detail: opencode === null ? msg.setup.opencodeMissing : opencodeOk ? msg.setup.opencodeFound : msg.setup.opencodeMissing,
    },
  ];
}

/** The judge backend in the user config, or null. Unreadable counts as none. */
function currentJudge(env?: PathEnv): string | null {
  try {
    const doc = parseDocument(readFileSync(dataPaths.config(env), 'utf8'));
    const b = doc.getIn(['judge', 'backend']);
    return typeof b === 'string' ? b : null;
  } catch {
    return null;
  }
}

export function setupState(e: SetupEnv = {}): SetupState {
  const options = judgeOptions(e);
  return {
    agents: agentStatuses(e),
    judge: {
      current: currentJudge(e.pathEnv),
      options,
      recommended: options.find((o) => o.available)?.backend ?? null,
    },
    dataDir: dataDir(e.pathEnv),
  };
}

export interface AgentChange {
  readonly id: string;
  readonly ok: boolean;
  readonly message: string;
}

/**
 * Hooks lingspark into each agent (user scope). The running program is copied
 * once and every hook points at the copy (D-033); each agent's config is
 * backed up before it is changed, exactly as `install` does.
 */
export function enableAgents(ids: readonly string[], e: SetupEnv = {}): AgentChange[] {
  if (ids.length === 0) return [];
  const command = installBinary(e.binary, e.binary, e.pathEnv);
  return ids.map((id) => {
    try {
      const profile = agentProfile(id);
      if (profile?.bridge !== undefined) {
        return enableBridge(profile, command, e);
      }
      const file = configFileFor(id, 'user', { homedir: home(e) });
      const change = planInstall(file, id, command);
      applyChange(change);
      // Newly connected: it calls us only after a restart (D-064).
      if (change.changed) awaitFirstCall(id, e.pathEnv);
      return { id, ok: true, message: change.changed ? msg.setup.agentOn(nameOf(id)) : msg.setup.agentAlreadyOn(nameOf(id)) };
    } catch (err: unknown) {
      return { id, ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  });
}

/**
 * Connects an extension-loading agent: writes its bridge file, and for
 * opencode also names the bridge in opencode.json's plugin array (D-102).
 */
function enableBridge(profile: AgentProfile, command: ReturnType<typeof installBinary>, e: SetupEnv): AgentChange {
  const id = profile.id;
  const content = bridgeContent(profile, command);
  if (content === null) return { id, ok: false, message: msg.install.unknownAgent(id) };
  const file = bridgePath(profile, home(e));
  const changed = writeBridge(file, content);
  let configChanged = false;
  if (profile.bridge === 'opencode-plugin') {
    const cfg = path.join(home(e), '.config', 'opencode', 'opencode.json');
    const change = planChange(cfg, (c) => withPluginInstalled(c, opencodePluginUrl(profile, home(e))));
    applyChange(change);
    configChanged = change.changed;
  }
  if (changed || configChanged) awaitFirstCall(id, e.pathEnv);
  return {
    id,
    ok: true,
    message: changed || configChanged ? msg.setup.agentOn(nameOf(id)) : msg.setup.agentAlreadyOn(nameOf(id)),
  };
}

/**
 * Brings connected agents up to date with this version (D-064, D-067): the
 * copy of the program their hooks run, and the hooks in their configs. Both
 * are only written when an agent is connected, so a new version of the app
 * would otherwise leave them as they were until someone flicked a switch.
 * An agent whose config changes waits for a restart, like a new one. Does
 * nothing when nothing is connected or all is current. Never throws.
 */
export function refreshInstall(e: SetupEnv = {}): void {
  try {
    const ids = agentStatuses(e)
      .filter((a) => a.installed && hooksRunThisInstall(a.id, e))
      .map((a) => a.id);
    if (ids.length > 0) enableAgents(ids, e);
  } catch {
    // e.g. Windows, with a hook running the old copy right now: next launch
  }
}

/**
 * Whether an agent's hooks run the copy in this data directory. Hooks put
 * there by another install -- a CLI with its own data directory, a
 * developer's test run -- are that install's to update, never this one's:
 * a test run once repointed every agent at a scratch folder.
 */
function hooksRunThisInstall(id: string, e: SetupEnv): boolean {
  try {
    const file = configFileFor(id, 'user', { homedir: home(e) });
    const dir = installedBinaryDir(e.pathEnv);
    return ourCommands(JSON.parse(readFileSync(file, 'utf8'))).some((c) => c.includes(dir));
  } catch {
    return false;
  }
}

export function disableAgents(ids: readonly string[], e: SetupEnv = {}): AgentChange[] {
  return ids.map((id) => {
    try {
      const profile = agentProfile(id);
      if (profile?.bridge !== undefined) {
        const removed = removeBridge(bridgePath(profile, home(e)));
        let configChanged = false;
        if (profile.bridge === 'opencode-plugin') {
          const cfg = path.join(home(e), '.config', 'opencode', 'opencode.json');
          const change = planChange(cfg, (c) => withPluginRemoved(c, opencodePluginUrl(profile, home(e))));
          applyChange(change);
          configChanged = change.changed;
        }
        heardFrom(id, e.pathEnv);
        return { id, ok: true, message: removed || configChanged ? msg.setup.agentOff(nameOf(id)) : msg.setup.agentAlreadyOn(nameOf(id)) };
      }
      const file = configFileFor(id, 'user', { homedir: home(e) });
      applyChange(planUninstall(file));
      heardFrom(id, e.pathEnv);
      return { id, ok: true, message: msg.setup.agentOff(nameOf(id)) };
    } catch (err: unknown) {
      return { id, ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  });
}

/** Sets judge.backend in the user config, keeping everything else and its comments. */
export function chooseJudge(backend: string, e: SetupEnv = {}): void {
  const file = dataPaths.config(e.pathEnv);
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    // no user config yet
  }
  const doc = parseDocument(text === '' ? '# lingspark 用户级配置\n' : text);
  // A hand-edited `judge:` that is not a mapping cannot take a key; replace it
  // rather than fail halfway through turning checking on.
  if (!isMap(doc.get('judge', true)) && doc.has('judge')) doc.delete('judge');
  doc.setIn(['judge', 'backend'], backend);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, doc.toString());
}
