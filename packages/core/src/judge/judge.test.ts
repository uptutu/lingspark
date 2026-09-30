import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PathEnv } from '../paths.js';
import { resolveConfig } from '../config/resolve.js';
import { ClaudeCliJudge } from './agent-cli.js';
import { CodexCliJudge, readCodexEvents } from './codex-cli.js';
import { AnthropicJudge } from './anthropic.js';
import { cacheKey, JudgeCache, sweepCache } from './cache.js';
import { getCredential } from './credentials.js';
import { createJudge } from './factory.js';
import { MockJudge, RecordingJudge, ReplayJudge } from './mock.js';
import { guardedFetch, isLocalUrl, postJson } from './network.js';
import { OpenAICompatibleJudge, yesProbability } from './openai-compatible.js';
import { parseStructured, structuredSchema } from './prompt.js';
import { TypesafeJudge } from './typesafe.js';
import { JudgeError, OfflineError, type JudgeCallContext, type JudgeRequest } from './types.js';

const REQ: JudgeRequest = {
  state: '【当前段落】推荐系统和召回服务都需要改造，它的延迟目前是 200 毫秒。',
  questions: {
    S201: { type: 'noul', instructions: '是否存在指代不明的代词？' },
    S204: { type: 'noul', instructions: '是否是空话？' },
  },
};

const ctx = (): JudgeCallContext => ({ signal: new AbortController().signal, purpose: 'pass2', rules: ['S201', 'S204'], file: 'docs/a.md' });

let root: string;
let env: PathEnv;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'lingspark-judge-'));
  env = { platform: process.platform, env: { LINGSPARK_DATA_DIR: path.join(root, 'data') }, homedir: root };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const outbound = (): Record<string, unknown>[] => {
  const f = path.join(root, 'data', 'logs', 'outbound.jsonl');
  return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>) : [];
};

/** A fetch that answers from a function and records what was asked. */
function fakeFetch(respond: (url: string, body: unknown) => { status?: number; json: unknown }) {
  const calls: { url: string; body: unknown }[] = [];
  const f = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url, body });
    const r = respond(url, body);
    return Promise.resolve(
      new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } }),
    );
  }) as typeof fetch;
  return { f, calls };
}

/* ------------------------------------------------------------ network */

describe('network guard', () => {
  it('recognises local URLs', () => {
    expect(isLocalUrl('http://localhost:11434/v1')).toBe(true);
    expect(isLocalUrl('http://127.0.0.1:8000')).toBe(true);
    expect(isLocalUrl('http://[::1]:8000')).toBe(true);
    expect(isLocalUrl('https://api.typesafe.ai/v1')).toBe(false);
  });

  it('refuses a remote request while offline, before anything is sent', async () => {
    const { f, calls } = fakeFetch(() => ({ json: {} }));
    const net = { offline: true, pathEnv: env, fetchImpl: f };
    await expect(
      postJson('https://api.example.com/x', {}, { headers: {}, signal: ctx().signal, net, outbound: { backend: 'b', purpose: 'pass2', rules: [], state: 's' } }),
    ).rejects.toBeInstanceOf(OfflineError);
    await expect(guardedFetch(net, { backend: 'b', purpose: 'pass2', rules: [], state: 's' })('https://api.example.com/x')).rejects.toBeInstanceOf(OfflineError);
    expect(calls).toEqual([]);
    expect(outbound()).toEqual([]);
  });

  it('still allows a local endpoint while offline', async () => {
    const { f, calls } = fakeFetch(() => ({ json: { ok: true } }));
    await postJson('http://localhost:11434/v1/x', {}, { headers: {}, signal: ctx().signal, net: { offline: true, pathEnv: env, fetchImpl: f }, outbound: { backend: 'b', purpose: 'pass2', rules: [], state: 's' } });
    expect(calls).toHaveLength(1);
  });

  it('logs hashes and sizes, never the text or the key', async () => {
    const { f } = fakeFetch(() => ({ json: { ok: true } }));
    await postJson('https://api.example.com/x', { state: REQ.state }, {
      headers: { authorization: 'Bearer sk-secret-123' },
      signal: ctx().signal,
      net: { offline: false, pathEnv: env, fetchImpl: f },
      outbound: { backend: 'b', purpose: 'pass2', rules: ['S201'], state: REQ.state, file: 'docs/a.md' },
    });
    const [rec] = outbound();
    expect(rec?.['rules']).toEqual(['S201']);
    expect(String(rec?.['stateHash'])).toMatch(/^sha256:[0-9a-f]{64}$/u);
    const raw = readFileSync(path.join(root, 'data', 'logs', 'outbound.jsonl'), 'utf8');
    expect(raw).not.toContain('推荐系统');
    expect(raw).not.toContain('sk-secret');
  });

  it('retries a rate limit, then succeeds', async () => {
    let n = 0;
    const { f } = fakeFetch(() => (++n === 1 ? { status: 429, json: {} } : { json: { ok: true } }));
    const r = await postJson('https://api.example.com/x', {}, { headers: {}, signal: ctx().signal, net: { offline: false, pathEnv: env, fetchImpl: f }, outbound: { backend: 'b', purpose: 'pass2', rules: [], state: 's' } });
    expect(r).toEqual({ ok: true });
    expect(n).toBe(2);
  });
});

/* ------------------------------------------------------------ backends */

describe('TypesafeJudge', () => {
  it('sends the Jev request shape and maps answers back', async () => {
    const { f, calls } = fakeFetch(() => ({
      json: { model: 'jev-latest', answers: { S201: { noul: 0.91 }, S204: { noul: 0.05 } }, usage: { input_tokens: 40, output_tokens: 2 } },
    }));
    const r = await new TypesafeJudge('k', { offline: false, pathEnv: env, fetchImpl: f }).judge(REQ, ctx());
    expect(calls[0]?.url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(calls[0]?.body).toMatchObject({ model: 'jev-latest', state: REQ.state, questions: REQ.questions });
    expect(r.answers['S201']).toEqual({ type: 'noul', probability: 0.91 });
    expect(r.usage).toEqual({ inputTokens: 40, outputTokens: 2 });
  });

  it('splits the questions once on a 422', async () => {
    const { f, calls } = fakeFetch((_u, body) => {
      const qs = Object.keys((body as { questions: object }).questions);
      return qs.length > 1 ? { status: 422, json: {} } : { json: { answers: { [qs[0] as string]: { noul: 0.5 } }, usage: {} } };
    });
    const r = await new TypesafeJudge('k', { offline: false, pathEnv: env, fetchImpl: f }).judge(REQ, ctx());
    expect(Object.keys(r.answers).sort()).toEqual(['S201', 'S204']);
    expect(calls).toHaveLength(3);
  });
});

describe('OpenAICompatibleJudge', () => {
  const logprobReply = (y: number) => ({
    choices: [{ message: { content: 'Y' }, logprobs: { content: [{ token: 'Y', top_logprobs: [{ token: 'Y', logprob: Math.log(y) }, { token: 'N', logprob: Math.log(1 - y) }] }] } }],
    usage: { prompt_tokens: 10, completion_tokens: 1 },
  });

  it('reads Y against N from logprobs and reports itself calibrated', async () => {
    const { f } = fakeFetch(() => ({ json: logprobReply(0.8) }));
    const j = new OpenAICompatibleJudge('https://api.deepseek.com/v1', 'deepseek-chat', 'k', { offline: false, pathEnv: env, fetchImpl: f });
    const r = await j.judge(REQ, ctx());
    expect((r.answers['S201'] as { probability: number }).probability).toBeCloseTo(0.8, 5);
    expect(j.calibrated).toBe(true);
  });

  it('falls back to structured answers when the endpoint rejects logprobs, and remembers', async () => {
    const { f, calls } = fakeFetch((_u, body) =>
      (body as { logprobs?: boolean }).logprobs === true
        ? { status: 400, json: { error: 'logprobs not supported' } }
        : { json: { choices: [{ message: { content: JSON.stringify({ S201: { answer: true, confidence: 0.9 }, S204: { answer: false, confidence: 0.7 } }) } }] } },
    );
    const net = { offline: false, pathEnv: env, fetchImpl: f };
    const j = new OpenAICompatibleJudge('https://x.example.com/v1', 'm', 'k', net);
    const r = await j.judge(REQ, ctx());
    expect((r.answers['S201'] as { probability: number }).probability).toBeCloseTo(0.9);
    expect((r.answers['S204'] as { probability: number }).probability).toBeCloseTo(0.3);
    expect(j.calibrated).toBe(false);
    const before = calls.length;
    // A fresh process reads the remembered probe and goes straight to structured.
    await new OpenAICompatibleJudge('https://x.example.com/v1', 'm', 'k', net).judge(REQ, ctx());
    expect(calls.length - before).toBe(1);
  });

  it('probes once when first contact comes as several calls at once', async () => {
    // Found by running eval in parallel: every concurrent probe but the first
    // failed once the first had demoted the endpoint.
    const { f, calls } = fakeFetch((_u, body) =>
      (body as { logprobs?: boolean }).logprobs === true
        ? { status: 400, json: { error: 'logprobs not supported' } }
        : { json: { choices: [{ message: { content: JSON.stringify({ S201: { answer: true, confidence: 0.9 }, S204: { answer: false, confidence: 0.7 } }) } }] } },
    );
    const j = new OpenAICompatibleJudge('https://z.example.com/v1', 'm', 'k', { offline: false, pathEnv: env, fetchImpl: f });
    const results = await Promise.all(Array.from({ length: 4 }, () => j.judge(REQ, ctx())));
    expect(results.every((r) => Object.keys(r.answers).length === 2)).toBe(true);
    expect(calls.filter((c) => (c.body as { logprobs?: boolean }).logprobs === true).length).toBeLessThanOrEqual(2);
  });

  it('does not remember "unsupported" after an auth failure', async () => {
    const { f } = fakeFetch(() => ({ status: 401, json: {} }));
    const net = { offline: false, pathEnv: env, fetchImpl: f };
    await expect(new OpenAICompatibleJudge('https://y.example.com/v1', 'm', 'bad', net).judge(REQ, ctx())).rejects.toBeInstanceOf(JudgeError);
    expect(readdirSync(path.join(root, 'data')).includes('cache') ? readdirSync(path.join(root, 'data', 'cache')) : []).toEqual([]);
  });

  it('yesProbability normalises token spellings', () => {
    expect(yesProbability([{ token: ' y', logprob: Math.log(0.6) }, { token: 'No', logprob: Math.log(0.2) }])).toBeCloseTo(0.75);
    expect(yesProbability([{ token: 'Maybe', logprob: 0 }])).toBeNull();
  });
});

describe('AnthropicJudge', () => {
  const message = (text: string, stop = 'end_turn') => ({
    id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-4-5', stop_reason: stop, stop_sequence: null,
    content: [{ type: 'text', text }], usage: { input_tokens: 50, output_tokens: 20 },
  });

  it('goes through the SDK with structured output and marks itself uncalibrated', async () => {
    const { f, calls } = fakeFetch(() => ({ json: message(JSON.stringify({ S201: { answer: true, confidence: 0.85 }, S204: { answer: false, confidence: 0.9 } })) }));
    const j = new AnthropicJudge('k', { offline: false, pathEnv: env, fetchImpl: f });
    const r = await j.judge(REQ, ctx());
    expect(calls[0]?.url).toMatch(/\/v1\/messages$/u);
    expect(calls[0]?.body).toMatchObject({ model: 'claude-haiku-4-5', output_config: { format: { type: 'json_schema' } } });
    expect((r.answers['S201'] as { probability: number }).probability).toBeCloseTo(0.85);
    expect((r.answers['S204'] as { probability: number }).probability).toBeCloseTo(0.1);
    expect(j.calibrated).toBe(false);
    expect(outbound()).toHaveLength(1);
  });

  it('is blocked by the offline switch like any other request', async () => {
    const { f, calls } = fakeFetch(() => ({ json: message('{}') }));
    await expect(new AnthropicJudge('k', { offline: true, pathEnv: env, fetchImpl: f }).judge(REQ, ctx())).rejects.toBeInstanceOf(OfflineError);
    expect(calls).toEqual([]);
  });

  it('treats a refusal as no answer', async () => {
    const { f } = fakeFetch(() => ({ json: message('', 'refusal') }));
    await expect(new AnthropicJudge('k', { offline: false, pathEnv: env, fetchImpl: f }).judge(REQ, ctx())).rejects.toBeInstanceOf(JudgeError);
  });
});

describe.skipIf(process.platform === 'win32')('ClaudeCliJudge', () => {
  const fakeCli = (reply: object): string => {
    const file = path.join(root, 'claude');
    writeFileSync(file, `#!/usr/bin/env node\nif (process.env.LINGSPARK_JUDGE_CHILD !== '1') process.exit(9);\nprocess.stdout.write(${JSON.stringify(JSON.stringify(reply))});\n`);
    chmodSync(file, 0o755);
    return file;
  };

  it('reads structured_output and marks the child so its hooks stand down', async () => {
    const cli = fakeCli({ is_error: false, structured_output: { S201: { answer: true, confidence: 0.8 }, S204: { answer: false, confidence: 0.6 } }, usage: { input_tokens: 5, output_tokens: 3 } });
    const r = await new ClaudeCliJudge(cli, { offline: false, pathEnv: env }).judge(REQ, ctx());
    expect((r.answers['S201'] as { probability: number }).probability).toBeCloseTo(0.8);
  });

  it('surfaces "not logged in" as a judge error', async () => {
    const cli = fakeCli({ is_error: true, result: 'Not logged in · Please run /login' });
    await expect(new ClaudeCliJudge(cli, { offline: false, pathEnv: env }).judge(REQ, ctx())).rejects.toThrow(/Not logged in/u);
  });

  it('refuses to run while offline', async () => {
    await expect(new ClaudeCliJudge('/nonexistent', { offline: true, pathEnv: env }).judge(REQ, ctx())).rejects.toBeInstanceOf(OfflineError);
  });
});

describe.skipIf(process.platform === 'win32')('CodexCliJudge', () => {
  /**
   * A stand-in for `codex exec --json`: checks it was started the isolated
   * way, that the question arrived on stdin and the schema on disk, then
   * prints the events a real run prints (recorded 2026-09-24, codex-cli 0.155).
   */
  const fakeCodex = (events: object[]): string => {
    const file = path.join(root, 'codex');
    const script = `#!/usr/bin/env node
const fs = require('node:fs');
const a = process.argv.slice(2);
if (process.env.LINGSPARK_JUDGE_CHILD !== '1') process.exit(9);
for (const f of ['exec', '--ephemeral', '--ignore-user-config', '--json', '-']) if (!a.includes(f)) process.exit(10);
if (a[a.indexOf('--sandbox') + 1] !== 'read-only') process.exit(11);
if (!fs.existsSync(a[a.indexOf('--output-schema') + 1])) process.exit(12);
fs.writeFileSync(${JSON.stringify(path.join(root, 'workdir.txt'))}, a[a.indexOf('-C') + 1]);
let input = '';
process.stdin.on('data', (c) => (input += c)).on('end', () => {
  if (!input.includes('推荐系统和召回服务')) process.exit(13);
  process.stdout.write(${JSON.stringify(events.map((e) => JSON.stringify(e)).join('\n'))} + '\\n');
});
`;
    writeFileSync(file, script);
    chmodSync(file, 0o755);
    return file;
  };
  const answer = (text: string): object[] => [
    { type: 'thread.started', thread_id: 't' },
    { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text } },
    { type: 'turn.completed', usage: { input_tokens: 15496, cached_input_tokens: 0, output_tokens: 23, reasoning_output_tokens: 0 } },
  ];

  it('reads the final message, counts usage, and leaves no working directory behind', async () => {
    const cli = fakeCodex(answer(JSON.stringify({ S201: { answer: true, confidence: 0.8 }, S204: { answer: false, confidence: 0.6 } })));
    const judge = new CodexCliJudge(cli, { offline: false, pathEnv: env });
    const r = await judge.judge(REQ, ctx());
    expect(judge.id).toBe('codex-cli:gpt-6-luna');
    expect((r.answers['S201'] as { probability: number }).probability).toBeCloseTo(0.8);
    expect((r.answers['S204'] as { probability: number }).probability).toBeCloseTo(0.4);
    expect(r.usage).toEqual({ inputTokens: 15496, outputTokens: 23 });
    // The child ran in its own empty directory, removed afterwards.
    expect(existsSync(readFileSync(path.join(root, 'workdir.txt'), 'utf8'))).toBe(false);
    expect(outbound()[0]?.['backend']).toBe('codex-cli:gpt-6-luna');
  });

  it('surfaces an error event when there is no answer', async () => {
    const cli = fakeCodex([{ type: 'turn.started' }, { type: 'error', message: 'Not logged in. Run codex login.' }]);
    await expect(new CodexCliJudge(cli, { offline: false, pathEnv: env }).judge(REQ, ctx())).rejects.toThrow(/Not logged in/u);
  });

  it('refuses to run while offline', async () => {
    await expect(new CodexCliJudge('/nonexistent', { offline: true, pathEnv: env }).judge(REQ, ctx())).rejects.toBeInstanceOf(OfflineError);
  });

  it('ignores lines that are not events', () => {
    expect(readCodexEvents('warning: something\n{"type":"turn.failed","error":{"message":"quota"}}\n').error).toBe('quota');
  });
});

/* ------------------------------------------------------------ structured prompt */

describe('structured replies', () => {
  it('builds a strict schema covering every question', () => {
    const s = structuredSchema(REQ) as { required: string[]; additionalProperties: boolean };
    expect(s.required).toEqual(['S201', 'S204']);
    expect(s.additionalProperties).toBe(false);
  });

  it('drops malformed items instead of guessing', () => {
    const a = parseStructured(REQ, { S201: { answer: 'yes', confidence: 0.9 }, S204: { answer: true } });
    expect(a).toEqual({});
  });
});

/* ------------------------------------------------------------ cache, credentials, replay */

describe('JudgeCache', () => {
  it('stores and returns answers by key', () => {
    const c = new JudgeCache(env);
    const k = cacheKey('j', 'S201', 1, REQ.state);
    expect(c.get(k)).toBeNull();
    c.set(k, { type: 'noul', probability: 0.3 });
    expect(c.get(k)).toEqual({ type: 'noul', probability: 0.3 });
  });

  it('keys change with the rule version and ignore rewrapping', () => {
    expect(cacheKey('j', 'S201', 1, 'a  b')).toBe(cacheKey('j', 'S201', 1, 'a b'));
    expect(cacheKey('j', 'S201', 1, 'a')).not.toBe(cacheKey('j', 'S201', 2, 'a'));
    expect(cacheKey('j1', 'S201', 1, 'a')).not.toBe(cacheKey('j2', 'S201', 1, 'a'));
  });

  it('sweeps expired entries, then the least recently used over the size cap', () => {
    const c = new JudgeCache(env);
    const keys = ['a', 'b', 'c'].map((x) => cacheKey('j', x, 1, x));
    keys.forEach((k) => c.set(k, { type: 'noul', probability: 0.5 }));
    const now = Date.now();
    const file = (k: string) => path.join(root, 'data', 'cache', k.slice(0, 2), `${k}.json`);
    utimesSync(file(keys[0] as string), new Date(now - 40 * 86_400_000), new Date(now - 40 * 86_400_000));
    utimesSync(file(keys[1] as string), new Date(now - 2000), new Date(now - 2000));
    const size = readFileSync(file(keys[2] as string)).length;
    const r = sweepCache(env, { maxBytes: size, now });
    expect(r.removedExpired).toBe(1);
    expect(r.removedForSize).toBe(1);
    expect(existsSync(file(keys[2] as string))).toBe(true);
  });
});

describe('credentials', () => {
  it('prefers the environment, then credentials.yaml', () => {
    mkdirSync(path.join(root, 'data'), { recursive: true });
    writeFileSync(path.join(root, 'data', 'credentials.yaml'), 'anthropic_api_key: from-file\n');
    expect(getCredential('anthropic', env)).toBe('from-file');
    expect(getCredential('anthropic', { ...env, env: { ...env.env, ANTHROPIC_API_KEY: 'from-env' } })).toBe('from-env');
    expect(getCredential('typesafe', env)).toBeNull();
  });
});

describe('record and replay', () => {
  it('replays exactly what was recorded, and refuses what was not', async () => {
    const dir = path.join(root, 'fixtures');
    const real = new MockJudge(() => 0.77, 'real:1', true);
    await new RecordingJudge(real, dir).judge(REQ, ctx());
    const replay = new ReplayJudge(dir, 'real:1', true);
    const r = await replay.judge(REQ, ctx());
    expect((r.answers['S201'] as { probability: number }).probability).toBe(0.77);
    await expect(replay.judge({ ...REQ, state: '另一段' }, ctx())).rejects.toBeInstanceOf(JudgeError);
  });
});

describe('createJudge', () => {
  const cfg = (judge: object) => resolveConfig({ projectRoot: null, project: null, user: { judge } });

  it('has no judge until one is configured', () => {
    expect(createJudge(resolveConfig({ projectRoot: null, project: null, user: null }), { pathEnv: env }).judge).toBeNull();
  });

  it('explains a missing key without revealing anything', () => {
    const r = createJudge(cfg({ backend: 'anthropic' }), { pathEnv: env });
    expect(r.judge).toBeNull();
    expect(r.problem).toContain('ANTHROPIC_API_KEY');
  });

  it('refuses mock in a real configuration', () => {
    expect(createJudge(cfg({ backend: 'mock' }), { pathEnv: env }).judge).toBeNull();
  });

  it('never lets a project config choose the endpoint', () => {
    const r = resolveConfig({
      projectRoot: '/p',
      project: { judge: { backend: 'openai-compatible', endpoint: 'https://evil.example.com/v1', model: 'm' } },
      user: null,
    });
    expect(r.judge.endpoint).toBeNull();
  });
});
