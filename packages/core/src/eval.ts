import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { ResolvedConfig } from './config/schema.js';
import { writeFileAtomic } from './fsutil.js';
import { createJudge } from './judge/factory.js';
import { RecordingJudge, ReplayJudge } from './judge/mock.js';
import type { Judge, JudgeCallContext, JudgeRequest, JudgeResponse } from './judge/types.js';
import { dataDir, type PathEnv } from './paths.js';
import { runRuleExamples, summarizeExamples, type ExampleSummary } from './rules/examples.js';
import type { Rule } from './rules/schema.js';

/**
 * USD per million tokens, input and output, for backends whose price is
 * published and known to this build. Anything else shows no cost rather than
 * a guess.
 */
const PRICES: Readonly<Record<string, readonly [number, number]>> = {
  'anthropic:claude-haiku-4-5': [1, 5],
  'anthropic:claude-sonnet-5': [2, 10],
  'anthropic:claude-opus-5': [5, 25],
};

export type EvalMode = 'live' | 'record' | 'replay';

export interface BackendSpec {
  /** judge.backend value. */
  readonly backend: string;
  /** Overrides judge.model. */
  readonly model?: string;
}

/** Parses `anthropic` or `anthropic:claude-sonnet-5`. */
export function parseBackendSpec(raw: string): BackendSpec {
  const i = raw.indexOf(':');
  return i === -1 ? { backend: raw } : { backend: raw.slice(0, i), model: raw.slice(i + 1) };
}

/** Wraps a judge to measure what each call costs in time and tokens. */
class Metered implements Judge {
  calls = 0;
  failures = 0;
  inputTokens = 0;
  outputTokens = 0;
  latencyMs = 0;

  constructor(private readonly inner: Judge) {}
  get id(): string {
    return this.inner.id;
  }
  get calibrated(): boolean {
    return this.inner.calibrated;
  }
  get slow(): boolean {
    return this.inner.slow;
  }

  async judge(req: JudgeRequest, ctx: JudgeCallContext): Promise<JudgeResponse> {
    this.calls++;
    const t0 = Date.now();
    try {
      const r = await this.inner.judge(req, ctx);
      this.inputTokens += r.usage.inputTokens;
      this.outputTokens += r.usage.outputTokens;
      return r;
    } catch (err) {
      this.failures++;
      throw err;
    } finally {
      this.latencyMs += Date.now() - t0;
    }
  }
}

/**
 * Lets at most `limit` calls through at a time. Examples are fired all at
 * once; this is what keeps a backend from seeing ninety at the same moment.
 */
class Limited implements Judge {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(
    private readonly inner: Judge,
    private readonly limit: number,
    private readonly onDone: () => void,
  ) {}
  get id(): string {
    return this.inner.id;
  }
  get calibrated(): boolean {
    return this.inner.calibrated;
  }
  get slow(): boolean {
    return this.inner.slow;
  }

  async judge(req: JudgeRequest, ctx: JudgeCallContext): Promise<JudgeResponse> {
    if (this.active >= this.limit) await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    try {
      return await this.inner.judge(req, ctx);
    } finally {
      this.active--;
      this.waiting.shift()?.();
      this.onDone();
    }
  }
}

export interface BackendReport {
  readonly spec: string;
  readonly judgeId: string | null;
  /** Why this backend could not run at all. */
  readonly problem?: string;
  readonly calibrated: boolean;
  readonly rules: readonly (ExampleSummary & { readonly meetsBar: boolean })[];
  readonly calls: number;
  readonly failures: number;
  readonly avgLatencyMs: number | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Estimated USD per 1000 judge calls; null when the price is unknown. */
  readonly costPer1000: number | null;
}

export interface EvalOptions {
  readonly config: ResolvedConfig;
  readonly rules: readonly Rule[];
  readonly backends: readonly BackendSpec[];
  readonly mode: EvalMode;
  /** Where fixtures are written or read; one subdirectory per judge. */
  readonly fixturesDir?: string;
  readonly pathEnv?: PathEnv;
  readonly fetchImpl?: typeof fetch;
  /** Judge calls in flight at once, per backend. Default 4. */
  readonly concurrency?: number;
  /** Called after each judge call, for a progress line on long runs. */
  readonly onProgress?: (spec: string, done: number, total: number) => void;
}

const safeName = (id: string): string => id.replace(/[^A-Za-z0-9._-]+/gu, '_');

interface Manifest {
  readonly judgeId: string;
  readonly calibrated: boolean;
}

/**
 * The bar a rule must clear to be `active` (design doc, 10.4): no false
 * positives on its negative examples, at least 60% recall on its positive
 * ones, and nothing skipped.
 */
export function meetsBar(s: ExampleSummary): boolean {
  return s.skipped === 0 && s.falsePositives === 0 && s.positiveTotal > 0 && s.positiveHit / s.positiveTotal >= 0.6;
}

/**
 * `lingspark eval` (design doc, 10.4): the labelled examples of judge rules, run
 * against one or more backends, side by side.
 *
 * `record` saves every exchange so the same comparison can be `replay`ed
 * without the network or the bill -- which is how CI evaluates judge rules.
 * Feedback triples join the sample set once M3's backtest maps categories to
 * rules.
 */
export async function runEval(opts: EvalOptions): Promise<BackendReport[]> {
  const root = opts.fixturesDir ?? path.join(dataDir(opts.pathEnv), 'eval', 'fixtures');
  const out: BackendReport[] = [];

  for (const spec of opts.backends) {
    const label = spec.model !== undefined ? `${spec.backend}:${spec.model}` : spec.backend;
    const config: ResolvedConfig = {
      ...opts.config,
      judge: { ...opts.config.judge, backend: spec.backend as ResolvedConfig['judge']['backend'], ...(spec.model !== undefined ? { model: spec.model } : {}) },
    };

    let judge: Judge;
    if (opts.mode === 'replay') {
      // The fixture directory is found by the spec, the judge id by the manifest.
      const dir = path.join(root, safeName(label));
      let manifest: Manifest;
      try {
        manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as Manifest;
      } catch {
        out.push(emptyReport(label, `没有找到 ${dir} 里的录制结果，先用 --record 录一次`));
        continue;
      }
      judge = new ReplayJudge(dir, manifest.judgeId, manifest.calibrated);
    } else {
      const setup = createJudge(config, {
        ...(opts.pathEnv !== undefined ? { pathEnv: opts.pathEnv } : {}),
        ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
      });
      if (setup.judge === null) {
        out.push(emptyReport(label, setup.problem));
        continue;
      }
      judge = setup.judge;
      if (opts.mode === 'record') {
        const dir = path.join(root, safeName(label));
        mkdirSync(dir, { recursive: true });
        writeFileAtomic(
          path.join(dir, 'manifest.json'),
          `${JSON.stringify({ judgeId: judge.id, calibrated: judge.calibrated } satisfies Manifest, null, 2)}\n`,
        );
        judge = new RecordingJudge(judge, dir);
      }
    }

    // Metered inside the limiter, so latency is the call's own and not its
    // time in the queue.
    const metered = new Metered(judge);
    const judgeRules = opts.rules.filter((r) => r.kind === 'judge');
    const total = judgeRules.reduce((n, r) => n + r.examples.positive.length + r.examples.negative.length, 0);
    let done = 0;
    const limited = new Limited(metered, opts.concurrency ?? 4, () => opts.onProgress?.(label, ++done, total));
    const rules = await Promise.all(
      judgeRules.map(async (rule) => {
        const s = summarizeExamples(rule.id, await runRuleExamples(rule, { config, judge: limited }));
        return { ...s, meetsBar: meetsBar(s) };
      }),
    );

    const replayLatency = judge instanceof ReplayJudge && judge.latencies.length > 0
      ? judge.latencies.reduce((a, b) => a + b, 0) / judge.latencies.length
      : null;
    const price = PRICES[metered.id];
    const ok = metered.calls - metered.failures;
    out.push({
      spec: label,
      judgeId: metered.id,
      calibrated: metered.calibrated,
      rules,
      calls: metered.calls,
      failures: metered.failures,
      avgLatencyMs: replayLatency ?? (metered.calls > 0 ? metered.latencyMs / metered.calls : null),
      inputTokens: metered.inputTokens,
      outputTokens: metered.outputTokens,
      costPer1000:
        price !== undefined && ok > 0
          ? ((metered.inputTokens * price[0] + metered.outputTokens * price[1]) / 1e6 / ok) * 1000
          : null,
    });
  }
  return out;
}

function emptyReport(spec: string, problem: string): BackendReport {
  return {
    spec,
    judgeId: null,
    problem,
    calibrated: false,
    rules: [],
    calls: 0,
    failures: 0,
    avgLatencyMs: null,
    inputTokens: 0,
    outputTokens: 0,
    costPer1000: null,
  };
}
