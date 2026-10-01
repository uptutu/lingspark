import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
 * npm 全局安装的 pi（@earendil-works/pi-coding-agent）：Windows 上 PATH 里的
 * shim 是 .cmd，直接 spawn 不起来；真正可执行的是包里的 bundle cli.js，
 * 需要 node 来跑。Unix 的 shim 带 shebang，可以直接执行。
 */
const PI_PACKAGE = ['@earendil-works', 'pi-coding-agent'];
const PI_BUNDLE = path.join('dist', 'bundle', 'cli.js');

/** Finds a pi CLI: an explicit path, then PATH, then the npm-global bundle next to a shim. */
export function findPiCli(explicit?: string | null, env: NodeJS.ProcessEnv = process.env): string | null {
  if (explicit !== undefined && explicit !== null && explicit !== '') return existsSync(explicit) ? explicit : null;
  const names = process.platform === 'win32' ? ['pi.cmd', 'pi.exe', 'pi'] : ['pi'];
  for (const dir of (env['PATH'] ?? '').split(path.delimiter)) {
    if (dir === '') continue;
    for (const name of names) {
      const shim = path.join(dir, name);
      if (!existsSync(shim)) continue;
      const bundle = path.join(dir, 'node_modules', ...PI_PACKAGE, PI_BUNDLE);
      if (existsSync(bundle)) return bundle;
      // Unix shim: executable node script with a shebang.
      if (process.platform !== 'win32') return shim;
    }
  }
  // The shim's directory may not be on PATH (another npm prefix is): check the
  // usual global prefixes' node_modules directly.
  const bundleUnder = (root: string): string => path.join(root, 'node_modules', ...PI_PACKAGE, PI_BUNDLE);
  for (const prefix of globalPrefixes(env)) {
    const bundle = process.platform === 'win32' ? bundleUnder(prefix) : bundleUnder(path.join(prefix, 'lib'));
    if (existsSync(bundle)) return bundle;
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

/** pi 的登录凭证文件；存在即认为配置过 provider（与 codex 的 auth.json 同理）。 */
export function piAuthFile(homedir: string): string {
  return path.join(homedir, '.pi', 'agent', 'auth.json');
}

interface PiEvents {
  text: string | null;
  inputTokens: number;
  outputTokens: number;
}

/** What `pi --mode json --print` printed, reduced to what a judge needs. */
export function readPiEvents(jsonl: string): PiEvents {
  let text: string | null = null;
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
    if (ev['type'] !== 'message_end') continue;
    const message = ev['message'] as Record<string, unknown> | undefined;
    if (message?.['role'] !== 'assistant') continue;
    const content = Array.isArray(message['content']) ? (message['content'] as Record<string, unknown>[]) : [];
    const reply = content
      .filter((c) => c['type'] === 'text' && typeof c['text'] === 'string')
      .map((c) => c['text'] as string)
      .join('')
      .trim();
    if (reply !== '') text = reply;
    const usage = (message['usage'] ?? {}) as Record<string, unknown>;
    if (typeof usage['input'] === 'number') inputTokens += usage['input'];
    if (typeof usage['output'] === 'number') outputTokens += usage['output'];
  }
  return { text, inputTokens, outputTokens };
}

/**
 * Judges by asking the user's own, already signed-in pi (DECISIONS D-094):
 * the provider keys pi already has become a judge with no API key. Like the
 * other agent CLI judges it is slow and uncalibrated.
 *
 * Each call is ephemeral (--no-session), has every tool, extension, skill and
 * context file off, the lowest thinking level, and the prompt on disk as an
 * @file: a document section does not fit a Windows command line.
 */
export class PiCliJudge implements Judge, Generator {
  readonly calibrated = false;
  readonly slow = true;
  readonly id: string;

  constructor(
    private readonly cli: string,
    private readonly net: NetworkContext,
    private readonly model?: string,
  ) {
    this.id = model !== undefined && model !== '' ? `pi-cli:${model}` : 'pi-cli:default';
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
      'agent-cli://pi',
      Buffer.byteLength(req.state, 'utf8'),
      this.net.pathEnv,
    );

    const dir = mkdtempSync(path.join(os.tmpdir(), 'lingspark-pi-'));
    try {
      const promptFile = path.join(dir, 'prompt.md');
      // pi/opencode have no schema-constrained output: the schema goes in the
      // prompt and the JSON is extracted from whatever comes back.
      writeFileSync(promptFile, `${req.prompt}\n\n只输出符合这个 JSON Schema 的 JSON，不要输出任何其他内容：\n${JSON.stringify(req.schema)}`);
      const args = [
        ...(this.cli.endsWith('.js') ? [this.cli] : []),
        ...(this.model !== undefined && this.model !== '' ? ['--model', this.model] : []),
        '--system-prompt', req.system,
        '--no-session',
        '--no-tools',
        '--no-extensions',
        '--no-skills',
        '--no-context-files',
        '--thinking', 'low',
        '--mode', 'json',
        '--print',
        `@${promptFile}`,
      ];
      const { out, err } = await runAgentCli(this.cli.endsWith('.js') ? process.execPath : this.cli, args, ctx.signal);
      const ev = readPiEvents(out);
      if (ev.text === null) {
        // e.g. no provider key configured, or a model this pi cannot use.
        const why = err.trim() || 'no answer';
        if (looksSignedOut(why)) markSignedOut('pi-cli', this.net.pathEnv);
        throw new JudgeError(`pi-cli: ${why.slice(0, 200)}`);
      }
      markSignedIn('pi-cli', this.net.pathEnv);
      const reply = extractJson(ev.text);
      if (reply === null) throw new JudgeError(`pi-cli: unreadable answer ${ev.text.slice(0, 200)}`);
      return { json: reply, usage: { inputTokens: ev.inputTokens, outputTokens: ev.outputTokens } };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
