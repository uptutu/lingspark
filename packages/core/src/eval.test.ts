import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from './config/resolve.js';
import { meetsBar, parseBackendSpec, runEval } from './eval.js';
import { loadRules } from './rules/load.js';
import type { PathEnv } from './paths.js';

const RULES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../rules-builtin/rules');
const builtin = readdirSync(RULES_DIR)
  .filter((n) => n.endsWith('.yaml'))
  .map((n) => ({ file: n, yaml: readFileSync(path.join(RULES_DIR, n), 'utf8') }));

let root: string;
let env: PathEnv;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'lingspark-eval-'));
  env = { platform: process.platform, env: { LINGSPARK_DATA_DIR: path.join(root, 'data') }, homedir: root };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/**
 * A local "model" that says yes when the paragraph contains one of the words
 * S204's positive examples are made of. Good enough to exercise the
 * machinery; it is not a claim about any real model's quality.
 */
const BUZZ = /赋能|闭环|高质量发展|再上新台阶|全方位/u;
let calls = 0;
const localModel = ((_url: string, init?: { body?: unknown }) => {
  calls++;
  const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
  const prompt = body.messages.at(-1)?.content ?? '';
  const material = /【当前段落】([\s\S]*?)\n\n【问题】/u.exec(prompt)?.[1] ?? '';
  const content = JSON.stringify({ S204: { answer: BUZZ.test(material), confidence: 0.95 } });
  return Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 100, completion_tokens: 10 } }), { status: 200 }));
}) as unknown as typeof fetch;

const config = () =>
  resolveConfig({
    projectRoot: null,
    project: null,
    user: { judge: { backend: 'openai-compatible', endpoint: 'http://localhost:11434/v1', model: 'local' } },
  });

const s204 = () => {
  const { rules } = loadRules({ config: config(), builtin, personalDir: '/nope', teamDir: '/nope' });
  return [rules.get('S204')!];
};

describe('parseBackendSpec', () => {
  it('splits an optional model', () => {
    expect(parseBackendSpec('anthropic')).toEqual({ backend: 'anthropic' });
    expect(parseBackendSpec('anthropic:claude-sonnet-5')).toEqual({ backend: 'anthropic', model: 'claude-sonnet-5' });
  });
});

describe('runEval', () => {
  it('compares two backends side by side (M2 acceptance 5)', async () => {
    const reports = await runEval({
      config: config(),
      rules: s204(),
      backends: [parseBackendSpec('openai-compatible'), parseBackendSpec('openai-compatible:other')],
      mode: 'live',
      pathEnv: env,
      fetchImpl: localModel,
    });
    expect(reports.map((r) => r.spec)).toEqual(['openai-compatible', 'openai-compatible:other']);
    for (const r of reports) {
      expect(r.rules[0]?.ruleId).toBe('S204');
      expect(r.rules[0]?.positiveHit).toBe(5);
      expect(r.rules[0]?.falsePositives).toBe(0);
      expect(r.rules[0]?.meetsBar).toBe(true);
      expect(r.calls).toBe(10);
      expect(r.inputTokens).toBe(1000);
    }
  });

  it('replays exactly what it recorded, with no network', async () => {
    const fixtures = path.join(root, 'fixtures');
    const recorded = await runEval({ config: config(), rules: s204(), backends: [parseBackendSpec('openai-compatible')], mode: 'record', fixturesDir: fixtures, pathEnv: env, fetchImpl: localModel });
    expect(existsSync(path.join(fixtures, 'openai-compatible', 'manifest.json'))).toBe(true);

    calls = 0;
    const replayed = await runEval({ config: config(), rules: s204(), backends: [parseBackendSpec('openai-compatible')], mode: 'replay', fixturesDir: fixtures, pathEnv: env });
    expect(calls).toBe(0);
    expect(replayed[0]?.rules).toEqual(recorded[0]?.rules);
  });

  it('reports a backend it cannot run instead of failing', async () => {
    const [r] = await runEval({ config: config(), rules: s204(), backends: [parseBackendSpec('anthropic')], mode: 'live', pathEnv: env });
    expect(r?.problem).toContain('ANTHROPIC_API_KEY');
    const [missing] = await runEval({ config: config(), rules: s204(), backends: [parseBackendSpec('typesafe')], mode: 'replay', fixturesDir: path.join(root, 'none'), pathEnv: env });
    expect(missing?.problem).toContain('--record');
  });
});

describe('meetsBar', () => {
  it('needs zero false positives, 60% recall and nothing skipped', () => {
    const base = { ruleId: 'X', results: [], negativeTotal: 5 };
    expect(meetsBar({ ...base, positiveTotal: 5, positiveHit: 3, falsePositives: 0, skipped: 0 })).toBe(true);
    expect(meetsBar({ ...base, positiveTotal: 5, positiveHit: 2, falsePositives: 0, skipped: 0 })).toBe(false);
    expect(meetsBar({ ...base, positiveTotal: 5, positiveHit: 5, falsePositives: 1, skipped: 0 })).toBe(false);
    expect(meetsBar({ ...base, positiveTotal: 5, positiveHit: 5, falsePositives: 0, skipped: 1 })).toBe(false);
  });
});
