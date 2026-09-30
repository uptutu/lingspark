import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../fsutil.js';
import { normalizeText } from '../parser/text.js';
import { JudgeError, type Answer, type Judge, type JudgeCallContext, type JudgeRequest, type JudgeResponse, type Question } from './types.js';

export type MockResolver = (state: string, name: string, question: Question) => number | Answer;

/**
 * A judge that answers from a function (design doc, 8.2: `mock`). Every
 * automated test uses this or a replay; no test may touch the network.
 */
export class MockJudge implements Judge {
  readonly calls: JudgeRequest[] = [];

  constructor(
    private readonly resolve: MockResolver,
    readonly id = 'mock',
    readonly calibrated = true,
    readonly slow = false,
  ) {}

  judge(req: JudgeRequest, ctx: JudgeCallContext): Promise<JudgeResponse> {
    if (ctx.signal.aborted) return Promise.reject(new JudgeError('aborted'));
    this.calls.push(req);
    const answers: Record<string, Answer> = {};
    for (const [name, q] of Object.entries(req.questions)) {
      const r = this.resolve(req.state, name, q);
      answers[name] = typeof r === 'number' ? { type: 'noul', probability: r } : r;
    }
    return Promise.resolve({ answers, usage: { inputTokens: req.state.length, outputTokens: 0 } });
  }
}

/** Identity of a request for record/replay: judge, state, and the exact questions. */
export function requestHash(judgeId: string, req: JudgeRequest): string {
  const questions = Object.keys(req.questions)
    .sort()
    .map((k) => [k, req.questions[k]]);
  return createHash('sha256')
    .update(JSON.stringify([judgeId, normalizeText(req.state), questions]), 'utf8')
    .digest('hex');
}

interface Fixture {
  readonly judgeId: string;
  readonly request: JudgeRequest;
  readonly response: JudgeResponse;
  readonly latencyMs: number;
}

/**
 * Wraps a real judge and saves every exchange (`eval --record`, 10.4), so the
 * same evaluation can be replayed later without the network or the cost.
 */
export class RecordingJudge implements Judge {
  constructor(
    private readonly inner: Judge,
    private readonly dir: string,
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
    const t0 = Date.now();
    const response = await this.inner.judge(req, ctx);
    const fixture: Fixture = { judgeId: this.inner.id, request: req, response, latencyMs: Date.now() - t0 };
    mkdirSync(this.dir, { recursive: true });
    writeFileAtomic(path.join(this.dir, `${requestHash(this.inner.id, req)}.json`), `${JSON.stringify(fixture, null, 2)}\n`);
    return response;
  }
}

/**
 * Answers from recorded fixtures (`eval --replay`, CI). A request that was
 * never recorded is an error, not a guess: a replay that silently invents
 * answers would make a passing test meaningless.
 */
export class ReplayJudge implements Judge {
  readonly slow = false;
  /** Recorded latency of each replayed call, for the eval report. */
  readonly latencies: number[] = [];

  constructor(
    private readonly dir: string,
    readonly id: string,
    readonly calibrated: boolean,
  ) {}

  judge(req: JudgeRequest, ctx: JudgeCallContext): Promise<JudgeResponse> {
    if (ctx.signal.aborted) return Promise.reject(new JudgeError('aborted'));
    const file = path.join(this.dir, `${requestHash(this.id, req)}.json`);
    let fixture: Fixture;
    try {
      fixture = JSON.parse(readFileSync(file, 'utf8')) as Fixture;
    } catch {
      return Promise.reject(new JudgeError(`no recorded answer for this request (${path.basename(file)})`));
    }
    this.latencies.push(fixture.latencyMs);
    return Promise.resolve(fixture.response);
  }
}
