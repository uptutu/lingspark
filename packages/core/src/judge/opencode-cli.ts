import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { looksSignedOut, markSignedIn, markSignedOut } from './signin.js';
import { runAgentCli } from './agent-cli.js';
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
 * npm 全局安装的 opencode-ai：Windows 的 PATH shim 是 .cmd，spawn 不起来；
 * 真正可执行的是包里的 bin/opencode.exe。Unix 的 shim 可直接执行。
 */
const OPENCODE_PACKAGE = ['opencode-ai', 'bin'];
const OPENCODE_EXE = process.platform === 'win32' ? 'opencode.exe' : 'opencode';

/** Finds an opencode CLI: an explicit path, then PATH, then the npm-global exe next to a shim. */
export function findOpencodeCli(explicit?: string | null, env: NodeJS.ProcessEnv = process.env): string | null {
  if (explicit !== undefined && explicit !== null && explicit !== '') return existsSync(explicit) ? explicit : null;
  const names = process.platform === 'win32' ? ['opencode.exe', 'opencode.cmd', 'opencode'] : ['opencode'];
  for (const dir of (env['PATH'] ?? '').split(path.delimiter)) {
    if (dir === '') continue;
    for (const name of names) {
      const shim = path.join(dir, name);
      if (!existsSync(shim)) continue;
      const exe = path.join(dir, 'node_modules', ...OPENCODE_PACKAGE, OPENCODE_EXE);
      if (existsSync(exe)) return exe;
      if (process.platform !== 'win32') return shim;
    }
  }
  // The shim's directory may not be on PATH (another npm prefix is): check the
  // usual global prefixes' node_modules directly.
  const exeUnder = (root: string): string => path.join(root, 'node_modules', ...OPENCODE_PACKAGE, OPENCODE_EXE);
  for (const prefix of globalPrefixes(env)) {
    const exe = process.platform === 'win32' ? exeUnder(prefix) : exeUnder(path.join(prefix, 'lib'));
    if (existsSync(exe)) return exe;
  }
  return null;
}

/** npm global prefixes worth a direct look when the shim directory is not on PATH. */
function globalPrefixes(env: NodeJS.ProcessEnv): string[] {
  const out: string[] = [];
  if (env['npm_config_prefix'] !== undefined && env['npm_config_prefix'] !== '') out.push(env['npm_config_prefix']);
  if (process.platform === 'win32') {
    const roaming = env['APPDATA'] ?? path.join(os.homedir(), 'AppData', 'Roaming');
    out.push(path.join(roaming, 'npm'));
  } else {
    out.push('/usr/local', '/usr');
  }
  return out;
}

/** opencode 的登录凭证文件；存在即认为配置过 provider（与 codex 的 auth.json 同理）。 */
export function opencodeAuthFile(homedir: string): string {
  return path.join(homedir, '.local', 'share', 'opencode', 'auth.json');
}

interface OpencodeEvents {
  text: string | null;
  inputTokens: number;
  outputTokens: number;
}

/** What `opencode run --format json` printed, reduced to what a judge needs. */
export function readOpencodeEvents(jsonl: string): OpencodeEvents {
  let text = '';
  let sawText = false;
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
    const part = ev['part'] as Record<string, unknown> | undefined;
    if (ev['type'] === 'text' && part?.['type'] === 'text' && typeof part['text'] === 'string') {
      text += part['text'];
      sawText = true;
    } else if (ev['type'] === 'step_finish' && part !== undefined) {
      const tokens = (part['tokens'] ?? {}) as Record<string, unknown>;
      if (typeof tokens['input'] === 'number') inputTokens += tokens['input'];
      if (typeof tokens['output'] === 'number') outputTokens += tokens['output'];
    }
  }
  return { text: sawText ? text.trim() : null, inputTokens, outputTokens };
}

/**
 * Judges by asking the user's own, already signed-in opencode (DECISIONS
 * D-094): the provider keys opencode already has become a judge with no API
 * key. Like the other agent CLI judges it is slow and uncalibrated.
 *
 * Each call runs with --pure (no user plugins) and a fresh session. opencode
 * has no tool-free mode: the prompt tells it to answer directly, and a run
 * that ignores this simply produces an unparseable answer, which surfaces as
 * a JudgeError instead of a wrong verdict.
 */
export class OpencodeCliJudge implements Judge, Generator {
  readonly calibrated = false;
  readonly slow = true;
  readonly id: string;

  constructor(
    private readonly cli: string,
    private readonly net: NetworkContext,
    private readonly model?: string,
  ) {
    this.id = model !== undefined && model !== '' ? `opencode-cli:${model}` : 'opencode-cli:default';
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
      'agent-cli://opencode',
      Buffer.byteLength(req.state, 'utf8'),
      this.net.pathEnv,
    );

    // The prompt goes in one positional argument: `opencode run` has no stdin
    // prompt. A document section fits the ~32k command line; the schema is
    // embedded because opencode has no schema-constrained output.
    const prompt = `${req.system}\n\n${req.prompt}\n\n只输出符合这个 JSON Schema 的 JSON，不要输出任何其他内容，也不要运行任何命令或读取任何文件：\n${JSON.stringify(req.schema)}`;
    const args = [
      'run',
      '--pure',
      '--format', 'json',
      ...(this.model !== undefined && this.model !== '' ? ['--model', this.model] : []),
      prompt,
    ];
    const { out, err } = await runAgentCli(this.cli, args, ctx.signal);
    const ev = readOpencodeEvents(out);
    if (ev.text === null) {
      // e.g. no provider key configured, or the opencode proxy is down.
      const why = err.trim() || 'no answer';
      if (looksSignedOut(why)) markSignedOut('opencode-cli', this.net.pathEnv);
      throw new JudgeError(`opencode-cli: ${why.slice(0, 200)}`);
    }
    markSignedIn('opencode-cli', this.net.pathEnv);
    const reply = extractJson(ev.text);
    if (reply === null) throw new JudgeError(`opencode-cli: unreadable answer ${ev.text.slice(0, 200)}`);
    return { json: reply, usage: { inputTokens: ev.inputTokens, outputTokens: ev.outputTokens } };
  }
}
