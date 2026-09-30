import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { looksSignedOut, markSignedIn, markSignedOut } from './signin.js';
import { runAgentCli } from './agent-cli.js';
import { recordOutbound, type NetworkContext } from './network.js';
import { parseStructured, structuredPrompt, structuredSchema, SYSTEM_PROMPT } from './prompt.js';
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
 * Where a Codex CLI may live besides PATH. The ChatGPT desktop app ships one
 * inside its bundle; that is the only copy many subscribers have.
 */
const BUNDLED = ['/Applications/ChatGPT.app/Contents/Resources/codex'];

/** Finds a Codex CLI: an explicit path, then PATH, then the desktop app's copy. */
export function findCodexCli(explicit?: string | null, env: NodeJS.ProcessEnv = process.env): string | null {
  if (explicit !== undefined && explicit !== null && explicit !== '') return existsSync(explicit) ? explicit : null;
  const exe = process.platform === 'win32' ? 'codex.exe' : 'codex';
  for (const dir of (env['PATH'] ?? '').split(path.delimiter)) {
    if (dir === '') continue;
    const candidate = path.join(dir, exe);
    if (existsSync(candidate)) return candidate;
  }
  if (process.platform === 'darwin') {
    for (const p of [...BUNDLED, ...BUNDLED.map((b) => path.join(os.homedir(), b))]) {
      if (existsSync(p)) return p;
    }
  }
  return null;
}

/**
 * The smallest model measured to answer correctly, at the lowest reasoning
 * effort. Each call still carries Codex's own agent prompt (~15k tokens) and
 * takes tens of seconds; see DECISIONS D-038.
 */
const DEFAULT_MODEL = 'gpt-6-luna';

/** What `codex exec --json` printed, reduced to what a judge needs. */
export function readCodexEvents(jsonl: string): { text: string | null; error: string | null; inputTokens: number; outputTokens: number } {
  let text: string | null = null;
  let error: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const line of jsonl.split('\n')) {
    if (line.trim() === '') continue;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const item = ev['item'] as Record<string, unknown> | undefined;
    if (ev['type'] === 'item.completed' && item?.['type'] === 'agent_message' && typeof item['text'] === 'string') {
      text = item['text'];
    } else if (ev['type'] === 'turn.completed') {
      const u = (ev['usage'] ?? {}) as Record<string, unknown>;
      if (typeof u['input_tokens'] === 'number') inputTokens += u['input_tokens'];
      if (typeof u['output_tokens'] === 'number') outputTokens += u['output_tokens'];
    } else if (ev['type'] === 'error' || ev['type'] === 'turn.failed') {
      const e = ev['error'] as Record<string, unknown> | undefined;
      const m = ev['message'] ?? e?.['message'];
      error = typeof m === 'string' ? m : JSON.stringify(ev);
    }
  }
  return { text, error, inputTokens, outputTokens };
}

/**
 * Judges by asking the user's own, already signed-in Codex (DECISIONS V-10):
 * a ChatGPT subscription becomes a judge with no API key. Like the Claude
 * Code judge it is slow and uncalibrated.
 *
 * Each call runs in an empty temporary directory with a read-only sandbox, no
 * session saved, and neither the user's config.toml (MCP servers, hooks) nor
 * their exec rules loaded: the child needs a model and nothing else.
 */
export class CodexCliJudge implements Judge, Generator {
  readonly calibrated = false;
  readonly slow = true;
  readonly id: string;

  constructor(
    private readonly cli: string,
    private readonly net: NetworkContext,
    private readonly model: string = DEFAULT_MODEL,
  ) {
    this.id = `codex-cli:${model}`;
  }

  async judge(req: JudgeRequest, ctx: JudgeCallContext): Promise<JudgeResponse> {
    const r = await this.generate(
      { system: SYSTEM_PROMPT, prompt: structuredPrompt(req), schema: structuredSchema(req), state: req.state },
      ctx,
    );
    return { answers: parseStructured(req, r.json), usage: r.usage };
  }

  async generate(req: GenerateRequest, ctx: JudgeCallContext): Promise<GenerateResponse> {
    if (this.net.offline) throw new OfflineError('offline: refused agent CLI call');
    recordOutbound(
      { backend: this.id, purpose: ctx.purpose, rules: ctx.rules ?? [], state: req.state, ...(ctx.file !== undefined ? { file: ctx.file } : {}) },
      'agent-cli://codex',
      Buffer.byteLength(req.state, 'utf8'),
      this.net.pathEnv,
    );

    const dir = mkdtempSync(path.join(os.tmpdir(), 'lingspark-codex-'));
    try {
      const schema = path.join(dir, 'schema.json');
      writeFileSync(schema, JSON.stringify(req.schema));
      const args = [
        'exec',
        '--ephemeral',
        '--skip-git-repo-check',
        '--ignore-user-config',
        '--ignore-rules',
        '--sandbox',
        'read-only',
        '--color',
        'never',
        '--json',
        '--output-schema',
        schema,
        '-C',
        dir,
        '-m',
        this.model,
        '-c',
        'model_reasoning_effort="low"',
        '-',
      ];
      // On stdin, not argv: a section can be longer than a command line may be.
      const prompt = `${req.system}\n\n${req.prompt}\n\n直接作答，不要运行命令或读取文件。`;
      const { out, err } = await runAgentCli(this.cli, args, ctx.signal, prompt);
      const ev = readCodexEvents(out);
      if (ev.text === null) {
        // e.g. not logged in, or a model this account cannot use.
        const why = ev.error ?? (err.trim() || 'no answer');
        if (looksSignedOut(why)) markSignedOut('codex-cli', this.net.pathEnv);
        throw new JudgeError(`codex-cli: ${why.slice(0, 200)}`);
      }
      markSignedIn('codex-cli', this.net.pathEnv);
      let reply: unknown;
      try {
        reply = JSON.parse(ev.text);
      } catch {
        throw new JudgeError(`codex-cli: unreadable answer ${ev.text.slice(0, 200)}`);
      }
      return { json: reply, usage: { inputTokens: ev.inputTokens, outputTokens: ev.outputTokens } };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
