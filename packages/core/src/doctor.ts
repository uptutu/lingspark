import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadProjectConfig, loadUserConfig } from './config/load.js';
import { resolveConfig } from './config/resolve.js';
import { installableAgents, type AgentId } from './agents.js';
import { loadConfig } from './config/load.js';
import { createJudge } from './judge/factory.js';
import { configFileFor, type InstallScope } from './install/install.js';
import { hasOurHooks, ourCommands } from './install/merge.js';
import { msg } from './messages.js';
import { dataDir, findProjectRoot, type PathEnv } from './paths.js';
import { getDeterministic } from './rules/context.js';
import { loadRules } from './rules/load.js';
import { evidenceOf } from './setup.js';
import './rules/deterministic/index.js';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface DoctorCheck {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: string;
}

export interface DoctorOptions {
  readonly cwd: string;
  readonly builtinRules: readonly { file: string; yaml: string }[];
  readonly pathEnv?: PathEnv;
  readonly homedir?: string;
  /** Command prefix this lingspark would install; used to spot stale hooks. */
  readonly currentCommand?: string;
  /** Skip the live judge call. */
  readonly offline?: boolean;
  readonly fetchImpl?: typeof fetch;
}

const d = msg.doctor;

function checkDataDir(env: PathEnv | undefined): DoctorCheck {
  const dir = dataDir(env);
  try {
    mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.doctor-${randomBytes(4).toString('hex')}`);
    writeFileSync(probe, 'ok');
    rmSync(probe);
    return { name: d.dataDir, status: 'ok', detail: dir };
  } catch (err: unknown) {
    return { name: d.dataDir, status: 'fail', detail: d.notWritable(dir, String(err)) };
  }
}

function checkUserConfig(env: PathEnv | undefined): DoctorCheck {
  try {
    const { config, warnings } = loadUserConfig(env);
    if (config === null) return { name: d.userConfig, status: 'ok', detail: d.usingDefaults };
    if (warnings.length > 0) return { name: d.userConfig, status: 'warn', detail: warnings.join('；') };
    return { name: d.userConfig, status: 'ok', detail: d.valid };
  } catch (err: unknown) {
    return { name: d.userConfig, status: 'fail', detail: err instanceof Error ? err.message : String(err) };
  }
}

function checkProjectConfig(cwd: string): { check: DoctorCheck; root: string | null } {
  const root = findProjectRoot(cwd, existsSync);
  if (root === null) {
    // Nothing to set up: outside any project the defaults apply (D-050).
    return { check: { name: d.projectConfig, status: 'ok', detail: d.noProjectConfig(cwd) }, root };
  }
  try {
    const { warnings } = loadProjectConfig(root);
    return {
      check: {
        name: d.projectConfig,
        status: warnings.length > 0 ? 'warn' : 'ok',
        detail: warnings.length > 0 ? warnings.join('；') : root,
      },
      root,
    };
  } catch (err: unknown) {
    return {
      check: { name: d.projectConfig, status: 'fail', detail: err instanceof Error ? err.message : String(err) },
      root,
    };
  }
}

function checkRules(opts: DoctorOptions, projectRoot: string | null): DoctorCheck[] {
  const config = resolveConfig({ projectRoot, project: null, user: null });
  const { rules, warnings } = loadRules({
    config,
    builtin: opts.builtinRules,
    ...(opts.pathEnv !== undefined ? { pathEnv: opts.pathEnv } : {}),
  });
  const missingImpl = [...rules.values()]
    .filter((r) => r.kind === 'deterministic' && (r.impl === undefined || getDeterministic(r.impl) === undefined))
    .map((r) => r.id);

  const out: DoctorCheck[] = [];
  out.push({
    name: d.rules,
    status: warnings.length > 0 ? 'fail' : 'ok',
    detail: warnings.length > 0 ? warnings.join('；') : d.rulesLoaded(rules.size),
  });
  if (missingImpl.length > 0) {
    out.push({ name: d.ruleImpls, status: 'fail', detail: d.missingImpls(missingImpl.join(', ')) });
  }
  return out;
}

/** Executable paths quoted at the start of a hook command. */
function commandPaths(command: string): string[] {
  const head = command.split(/\s+hook\s+--agent\b/u)[0] ?? '';
  return [...head.matchAll(/"([^"]+)"/gu)].map((m) => m[1] ?? '').filter((p) => p !== '');
}

function checkAgentHooks(
  agent: AgentId,
  scope: InstallScope,
  opts: DoctorOptions,
): DoctorCheck | null {
  const file = configFileFor(agent, scope, {
    ...(opts.homedir !== undefined ? { homedir: opts.homedir } : {}),
    projectDir: opts.cwd,
  });
  const name = d.hookFor(agent, scope);
  if (!existsSync(file)) {
    return scope === 'user' ? { name, status: 'warn', detail: d.notInstalled(agent) } : null;
  }

  let config: unknown;
  try {
    config = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err: unknown) {
    return { name, status: 'fail', detail: d.agentConfigBroken(file, String(err)) };
  }

  const has = hasOurHooks(config);
  if (!has.postToolUse && !has.stop) {
    return scope === 'user' ? { name, status: 'warn', detail: d.notInstalled(agent) } : null;
  }
  if (!has.postToolUse || !has.stop) {
    return { name, status: 'warn', detail: d.partiallyInstalled(file) };
  }

  // Every executable the installed commands point at must still exist: an
  // app update that moved the binary leaves a hook that silently does nothing.
  const commands = ourCommands(config);
  const missing = [...new Set(commands.flatMap(commandPaths))].filter((p) => !existsSync(p));
  if (missing.length > 0) {
    return { name, status: 'fail', detail: d.stalePath(missing.join(', '), agent) };
  }
  if (opts.currentCommand !== undefined && !commands.every((c) => c.startsWith(opts.currentCommand ?? ''))) {
    return { name, status: 'warn', detail: d.otherCopy(file, agent) };
  }
  return { name, status: 'ok', detail: file };
}

/** Codex reads [hooks] from config.toml too; two sources for one layer is a trap (D-021). */
function checkCodexToml(homedir: string): DoctorCheck | null {
  const toml = path.join(homedir, '.codex', 'config.toml');
  let text: string;
  try {
    text = readFileSync(toml, 'utf8');
  } catch {
    return null;
  }
  if (!/^\s*\[\s*hooks(\.|\s*\])/mu.test(text)) return null;
  return { name: d.codexToml, status: 'warn', detail: d.codexTomlHasHooks(toml) };
}

/**
 * Whether the configured judge answers at all (design doc, 5.7). Asks one
 * trivial question -- a real request, so a real (tiny) cost -- and reports
 * how long it took. Skipped offline.
 */
export async function checkJudge(opts: DoctorOptions): Promise<DoctorCheck> {
  let config;
  try {
    config = loadConfig({ cwd: opts.cwd, ...(opts.pathEnv !== undefined ? { pathEnv: opts.pathEnv } : {}) });
  } catch (err: unknown) {
    return { name: d.judge, status: 'fail', detail: err instanceof Error ? err.message : String(err) };
  }
  if (config.judge.backend === null) return { name: d.judge, status: 'warn', detail: msg.judge.notConfigured };
  // `session` is not a judge this program can call -- the writing agent reviews
  // in its own conversation and the Stop hook drives that. It is also what the
  // client writes for a person who has said nothing, so calling it broken
  // would make a fresh install report a failure out of the box (D-078).
  if (config.judge.backend === 'session') return { name: d.judge, status: 'ok', detail: msg.judge.inSession };
  const setup = createJudge(config, {
    ...(opts.pathEnv !== undefined ? { pathEnv: opts.pathEnv } : {}),
    ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.offline === true ? { offline: true } : {}),
  });
  if (setup.judge === null) {
    return { name: d.judge, status: opts.offline === true ? 'skip' : 'fail', detail: setup.problem };
  }
  const judge = setup.judge;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), judge.slow ? 90_000 : 30_000);
  const t0 = Date.now();
  try {
    const res = await judge.judge(
      { state: '【当前段落】今天下午有雨，出门记得带伞。', questions: { ping: { type: 'noul', instructions: '这段话是否在谈论天气？' } } },
      { signal: controller.signal, purpose: 'doctor' },
    );
    if (res.answers['ping'] === undefined) return { name: d.judge, status: 'fail', detail: d.judgeNoAnswer(judge.id) };
    return { name: d.judge, status: 'ok', detail: d.judgeOk(judge.id, (Date.now() - t0) / 1000, judge.calibrated) };
  } catch (err: unknown) {
    return { name: d.judge, status: 'fail', detail: d.judgeFailed(judge.id, err instanceof Error ? err.message : String(err)) };
  } finally {
    clearTimeout(timer);
  }
}

/** `lingspark doctor` (design doc, 5.7). */
export async function runDoctor(opts: DoctorOptions): Promise<DoctorCheck[]> {
  const home = opts.homedir ?? os.homedir();
  const out: DoctorCheck[] = [];

  out.push({ name: d.runtime, status: 'ok', detail: `Node ${process.version} · ${process.platform}-${process.arch}` });
  out.push(checkDataDir(opts.pathEnv));
  out.push(checkUserConfig(opts.pathEnv));

  const project = checkProjectConfig(opts.cwd);
  out.push(project.check);
  out.push(...checkRules(opts, project.root));

  for (const profile of installableAgents()) {
    const { id: agent, configFile } = profile;
    // Only agents that exist on this machine: a line per agent the user has
    // never installed is noise, not a finding.
    const agentDir = configFile?.[0];
    const present = agentDir !== undefined && existsSync(path.join(home, agentDir));
    const installedInProject = agentDir !== undefined && existsSync(path.join(opts.cwd, ...(configFile ?? [])));
    if (!present && !installedInProject) continue;
    // A directory another product also creates is not the agent (D-081): say so
    // here too, so self-check never claims success for something that is gone.
    if (profile.installedWhen !== undefined && !evidenceOf(profile.installedWhen, { homedir: home, ...(opts.pathEnv !== undefined ? { pathEnv: opts.pathEnv } : {}) })) {
      out.push({ name: d.programFor(profile.name), status: 'warn', detail: d.programNotFound(profile.name) });
    }
    for (const scope of ['user', 'project'] as const) {
      const c = checkAgentHooks(agent, scope, { ...opts, homedir: home });
      if (c !== null) out.push(c);
    }
  }
  const toml = checkCodexToml(home);
  if (toml !== null) out.push(toml);

  out.push(await checkJudge(opts));
  return out;
}
