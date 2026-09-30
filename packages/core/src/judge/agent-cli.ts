import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { looksSignedOut, markSignedIn, markSignedOut } from './signin.js';
import { recordOutbound, type NetworkContext } from './network.js';
import { extractJson, parseStructured, structuredPrompt, structuredSchema, SYSTEM_PROMPT } from './prompt.js';
import {
  JudgeError,
  OfflineError,
  type GenerateRequest,
  type GenerateResponse,
  type Generator,
  type Judge,
  type JudgeCallContext,
  type JudgeRequest,
  type JudgeResponse,
} from './types.js';

/**
 * Set in the environment of every agent CLI lingspark spawns. The child is a
 * full agent session with the user's hooks installed -- including lingspark's --
 * and `lingspark hook` exits at once when it sees this, so judging can never
 * recurse into more judging.
 */
export const JUDGE_CHILD_ENV = 'LINGSPARK_JUDGE_CHILD';

/**
 * Runs an agent CLI as a judging child: marked with JUDGE_CHILD_ENV, killed
 * when the call is aborted, and resolved with whatever it printed once it
 * exits. Interpreting the output is the caller's job.
 */
export function runAgentCli(
  cli: string,
  args: readonly string[],
  signal: AbortSignal,
  stdin?: string,
): Promise<{ out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cli, args, {
      env: { ...process.env, [JUDGE_CHILD_ENV]: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8').on('data', (c: string) => (out += c));
    child.stderr.setEncoding('utf8').on('data', (c: string) => (err += c));
    const onAbort = (): void => {
      child.kill();
      reject(new JudgeError('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => {
      signal.removeEventListener('abort', onAbort);
      reject(new JudgeError(`${path.basename(cli)}: ${e.message}`));
    });
    child.on('close', () => {
      signal.removeEventListener('abort', onAbort);
      resolve({ out, err });
    });
    // Closed even when empty: a CLI that reads stdin must not wait on it.
    child.stdin.end(stdin ?? '', 'utf8');
  });
}

const numericParts = (v: string): number[] => v.split('.').map((x) => Number(x) || 0);
const compareVersions = (a: string, b: string): number => {
  const x = numericParts(a);
  const y = numericParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
};

/**
 * Finds a Claude Code CLI: an explicit path, then PATH, then the copy the
 * desktop app keeps under a version-numbered directory (DECISIONS V-10).
 */
export function findClaudeCli(explicit?: string | null, env: NodeJS.ProcessEnv = process.env): string | null {
  if (explicit !== undefined && explicit !== null && explicit !== '') return existsSync(explicit) ? explicit : null;

  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  for (const dir of (env['PATH'] ?? '').split(path.delimiter)) {
    if (dir === '') continue;
    const candidate = path.join(dir, exe);
    if (existsSync(candidate)) return candidate;
  }

  if (process.platform === 'darwin') {
    const root = path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude-code');
    let versions: string[];
    try {
      versions = readdirSync(root).filter((v) => /^\d+(\.\d+)*$/u.test(v));
    } catch {
      return null;
    }
    for (const v of versions.sort(compareVersions).reverse()) {
      const candidate = path.join(root, v, 'claude.app', 'Contents', 'MacOS', 'claude');
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Judges by asking the user's own, already signed-in agent CLI (DECISIONS
 * V-10, V-11): zero configuration where it works, but slow -- seconds per
 * call -- and uncalibrated. It runs with no tools, no session saved to disk
 * (so the miner never mistakes a judging call for a user conversation), and a
 * JSON schema for the reply.
 */
export class ClaudeCliJudge implements Judge, Generator {
  readonly calibrated = false;
  readonly slow = true;
  readonly id: string;

  constructor(
    private readonly cli: string,
    private readonly net: NetworkContext,
    private readonly model: string = 'haiku',
  ) {
    this.id = `agent-cli:claude:${model}`;
  }

  async judge(req: JudgeRequest, ctx: JudgeCallContext): Promise<JudgeResponse> {
    const r = await this.generate(
      { system: SYSTEM_PROMPT, prompt: structuredPrompt(req), schema: structuredSchema(req), state: req.state },
      ctx,
    );
    return { answers: parseStructured(req, r.json), usage: r.usage };
  }

  async generate(req: GenerateRequest, ctx: JudgeCallContext): Promise<GenerateResponse> {
    // The CLI talks to a remote model: it is network traffic like any other.
    if (this.net.offline) throw new OfflineError('offline: refused agent CLI call');
    recordOutbound(
      { backend: this.id, purpose: ctx.purpose, rules: ctx.rules ?? [], state: req.state, ...(ctx.file !== undefined ? { file: ctx.file } : {}) },
      'agent-cli://claude',
      Buffer.byteLength(req.state, 'utf8'),
      this.net.pathEnv,
    );

    // The prompt goes on stdin (`-p` with no prompt argument reads it there):
    // a whole document does not fit a Windows command line.
    const args = [
      '-p',
      '--output-format',
      'json',
      '--json-schema',
      JSON.stringify(req.schema),
      '--model',
      this.model,
      '--no-session-persistence',
      '--tools',
      '',
    ];
    const { out, err } = await runAgentCli(this.cli, args, ctx.signal, `${req.system}\n\n${req.prompt}`);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(out) as Record<string, unknown>;
    } catch {
      throw new JudgeError(`agent-cli: unreadable output ${(out || err).slice(0, 200)}`);
    }
    const resultText = typeof parsed['result'] === 'string' ? parsed['result'] : '';
    const reply = parsed['structured_output'] ?? extractJson(resultText);
    if (parsed['is_error'] === true || reply === null || reply === undefined) {
      // e.g. "Not logged in · Please run /login": remembered, so `auto`
      // stops trying this CLI for a while (D-055).
      // Only an error result: a stray prose answer about someone's login page
      // must not switch the CLI off for a day.
      if (parsed['is_error'] === true && looksSignedOut(resultText)) markSignedOut('agent-cli', this.net.pathEnv);
      throw new JudgeError(`agent-cli: ${(resultText || 'no answer').slice(0, 200)}`);
    }
    markSignedIn('agent-cli', this.net.pathEnv);
    const usage = (parsed['usage'] ?? {}) as Record<string, unknown>;
    return {
      json: reply,
      usage: {
        inputTokens: typeof usage['input_tokens'] === 'number' ? usage['input_tokens'] : 0,
        outputTokens: typeof usage['output_tokens'] === 'number' ? usage['output_tokens'] : 0,
      },
    };
  }
}
