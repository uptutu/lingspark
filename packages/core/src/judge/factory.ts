import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentProfile } from '../agents.js';
import type { ResolvedConfig } from '../config/schema.js';
import { msg } from '../messages.js';
import type { PathEnv } from '../paths.js';
import { ClaudeCliJudge, findClaudeCli } from './agent-cli.js';
import { CodexCliJudge, findCodexCli } from './codex-cli.js';
import { AnthropicJudge } from './anthropic.js';
import { credentialHint, getCredential } from './credentials.js';
import { isLocalUrl, type NetworkContext } from './network.js';
import { OpenAICompatibleJudge, } from './openai-compatible.js';
import { TypesafeJudge } from './typesafe.js';
import { recentlySignedOut } from './signin.js';
import type { Judge } from './types.js';

type AgentBackend = 'agent-cli' | 'codex-cli';

/** With no writing agent (a person running `lingspark check`), the ones tried in turn. */
const WITHOUT_AGENT: readonly AgentBackend[] = ['codex-cli', 'agent-cli'];

/** Whether an agent CLI can answer now: installed, signed in as far as we can tell cheaply. */
export function agentBackendUsable(backend: AgentBackend, env?: PathEnv): boolean {
  if (recentlySignedOut(backend, env)) return false;
  if (backend === 'codex-cli') {
    return findCodexCli() !== null && existsSync(path.join(env?.homedir ?? os.homedir(), '.codex', 'auth.json'));
  }
  return findClaudeCli() !== null;
}

/**
 * `judge.backend: auto` (D-055, D-056): the agent that is writing judges its
 * own document, and only that agent -- no other product is borrowed. When it
 * cannot be driven in the background (no CLI lingspark can drive, or a CLI
 * that is not signed in), its documents get the checks that need no model,
 * and the user is told the one step that turns its own judging on.
 *
 * A person running `lingspark check` has no writing agent; then the first
 * signed-in agent on the machine judges.
 */
export function resolveAuto(
  agent: string | undefined,
  env?: PathEnv,
  usable: (b: AgentBackend, env?: PathEnv) => boolean = agentBackendUsable,
): AgentBackend | null {
  if (agent === undefined) return WITHOUT_AGENT.find((b) => usable(b, env)) ?? null;
  const own = agentProfile(agent)?.judgeBackend;
  return own !== undefined && usable(own, env) ? own : null;
}

export type JudgeSetup =
  | { readonly judge: Judge; readonly problem?: undefined }
  | { readonly judge: null; readonly problem: string };

/**
 * Builds the configured judge, or says why there is none.
 *
 * "None" is a normal outcome, not an error: Pass 2 is then skipped, and the
 * deterministic passes still run (design principle 2). The reason is surfaced
 * by `check` and `doctor` so the user knows what to configure.
 */
export function createJudge(
  config: ResolvedConfig,
  opts: {
    pathEnv?: PathEnv;
    fetchImpl?: typeof fetch;
    offline?: boolean;
    /** The agent whose write is being checked; `auto` uses its own CLI. */
    agent?: string;
    /** Replaces the installed/signed-in probe; tests use it. */
    usable?: (b: AgentBackend, env?: PathEnv) => boolean;
  } = {},
): JudgeSetup {
  const j = config.judge;
  const net: NetworkContext = {
    offline: opts.offline ?? config.offline,
    ...(opts.pathEnv !== undefined ? { pathEnv: opts.pathEnv } : {}),
    ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
  };
  const env = opts.pathEnv;

  // Offline, only a judge on this machine may run (design doc, 8.6).
  const remote =
    j.backend === 'auto' ||
    j.backend === 'typesafe' ||
    j.backend === 'anthropic' ||
    j.backend === 'agent-cli' ||
    j.backend === 'codex-cli' ||
    (j.backend === 'openai-compatible' && (j.endpoint === null || !isLocalUrl(j.endpoint)));
  if (net.offline && remote) return { judge: null, problem: msg.judge.offline };

  switch (j.backend) {
    case null:
      return { judge: null, problem: msg.judge.notConfigured };

    case 'session':
      // Nothing to call: the agent reviews in its conversation, driven by the Stop hook.
      return { judge: null, problem: msg.judge.inSession };

    case 'auto': {
      const backend = resolveAuto(opts.agent, env, opts.usable);
      if (backend === null) {
        const who = opts.agent === undefined ? undefined : agentProfile(opts.agent);
        return {
          judge: null,
          problem: who === undefined ? msg.judge.autoNone : msg.judge.selfReviewOff(who.name, who.selfReviewStep ?? msg.judge.selfReviewLater),
        };
      }
      // A model or command in the config belongs to a backend chosen by name.
      return createJudge({ ...config, judge: { ...j, backend, model: null, command: null } }, opts);
    }

    case 'typesafe': {
      const key = getCredential('typesafe', env);
      if (key === null) return { judge: null, problem: msg.judge.missingKey('Jev', credentialHint('typesafe', env)) };
      return { judge: new TypesafeJudge(key, net, j.model ?? undefined, j.endpoint ?? undefined) };
    }

    case 'openai-compatible': {
      if (j.endpoint === null) return { judge: null, problem: msg.judge.needsEndpoint };
      if (j.model === null) return { judge: null, problem: msg.judge.needsModel };
      const host = new URL(j.endpoint).hostname;
      const which = host.includes('openrouter') ? 'openrouter' : 'openai';
      const key = getCredential(which, env);
      const local = ['localhost', '127.0.0.1', '::1'].includes(host);
      if (key === null && !local) {
        return { judge: null, problem: msg.judge.missingKey(host, credentialHint(which, env)) };
      }
      return { judge: new OpenAICompatibleJudge(j.endpoint, j.model, key, net) };
    }

    case 'anthropic': {
      const key = getCredential('anthropic', env);
      if (key === null) return { judge: null, problem: msg.judge.missingKey('Claude', credentialHint('anthropic', env)) };
      return { judge: new AnthropicJudge(key, net, j.model ?? undefined, j.endpoint ?? undefined) };
    }

    case 'agent-cli': {
      const cli = findClaudeCli(j.command);
      if (cli === null) return { judge: null, problem: msg.judge.noAgentCli };
      return { judge: new ClaudeCliJudge(cli, net, j.model ?? undefined) };
    }

    case 'codex-cli': {
      const cli = findCodexCli(j.command);
      if (cli === null) return { judge: null, problem: msg.judge.noCodexCli };
      return { judge: new CodexCliJudge(cli, net, j.model ?? undefined) };
    }

    case 'mock':
      // Tests construct MockJudge directly. Selecting it in a config would
      // make a real check report invented findings, so refuse.
      return { judge: null, problem: msg.judge.mockInConfig };

    case 'so1-local':
      return { judge: null, problem: msg.judge.notYet('so1-local', 'M4') };
  }
}
