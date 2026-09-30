import { postJson, type NetworkContext } from './network.js';
import {
  JudgeError,
  type Answer,
  type Judge,
  type JudgeCallContext,
  type JudgeRequest,
  type JudgeResponse,
  type Question,
} from './types.js';

export const TYPESAFE_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const TYPESAFE_DEFAULT_MODEL = 'jev-latest';

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function probabilities(v: unknown): Record<string, number> {
  if (!isObject(v)) return {};
  const out: Record<string, number> = {};
  for (const [k, p] of Object.entries(v)) if (typeof p === 'number') out[k] = p;
  return out;
}

/** Maps one Jev answer onto ours (API shape verified 2026-09-20, DECISIONS V-7). */
function mapAnswer(q: Question, a: unknown): Answer | null {
  if (!isObject(a)) return null;
  if (q.type === 'noul') {
    const p = num(a['noul']);
    return p === null ? null : { type: 'noul', probability: p };
  }
  const confidence = num(a['confidence']) ?? 0;
  if (q.type === 'choice') {
    const choice = typeof a['choice'] === 'string' ? a['choice'] : null;
    return choice === null ? null : { type: 'choice', choice, probabilities: probabilities(a['probabilities']), confidence };
  }
  const score = num(a['score']);
  return score === null ? null : { type: 'score', score, probabilities: probabilities(a['probabilities']), confidence };
}

/**
 * The Jev System One API (design doc, 8.2). Returns calibrated probabilities,
 * which is why the design was built around it -- though its Chinese accuracy
 * is unpublished, so it competes with the others in `eval` like any backend.
 */
export class TypesafeJudge implements Judge {
  readonly calibrated = true;
  readonly slow = false;
  readonly id: string;

  constructor(
    private readonly apiKey: string,
    private readonly net: NetworkContext,
    private readonly model: string = TYPESAFE_DEFAULT_MODEL,
    private readonly endpoint: string = TYPESAFE_ENDPOINT,
  ) {
    this.id = `typesafe:${model}`;
  }

  async judge(req: JudgeRequest, ctx: JudgeCallContext): Promise<JudgeResponse> {
    try {
      return await this.once(req, ctx);
    } catch (err: unknown) {
      // The API documents no limit on request size. A 422 may mean "too big",
      // so split the questions once and try each half (DECISIONS V-7).
      const names = Object.keys(req.questions);
      if (!(err instanceof JudgeError) || err.status !== 422 || names.length < 2) throw err;
      const half = Math.ceil(names.length / 2);
      const pick = (ks: string[]): JudgeRequest => ({
        state: req.state,
        questions: Object.fromEntries(ks.map((k) => [k, req.questions[k] as Question])),
      });
      const [a, b] = await Promise.all([this.once(pick(names.slice(0, half)), ctx), this.once(pick(names.slice(half)), ctx)]);
      return {
        answers: { ...a.answers, ...b.answers },
        usage: {
          inputTokens: a.usage.inputTokens + b.usage.inputTokens,
          outputTokens: a.usage.outputTokens + b.usage.outputTokens,
        },
      };
    }
  }

  private async once(req: JudgeRequest, ctx: JudgeCallContext): Promise<JudgeResponse> {
    const raw = await postJson(
      this.endpoint,
      { model: this.model, state: req.state, questions: req.questions },
      {
        headers: { authorization: `Bearer ${this.apiKey}` },
        signal: ctx.signal,
        net: this.net,
        outbound: { backend: this.id, purpose: ctx.purpose, rules: ctx.rules ?? [], state: req.state, ...(ctx.file !== undefined ? { file: ctx.file } : {}) },
      },
    );
    if (!isObject(raw) || !isObject(raw['answers'])) throw new JudgeError('unexpected response shape');
    const answers: Record<string, Answer> = {};
    for (const [name, q] of Object.entries(req.questions)) {
      const a = mapAnswer(q, (raw['answers'])[name]);
      if (a !== null) answers[name] = a;
    }
    const usage = isObject(raw['usage']) ? raw['usage'] : {};
    return {
      answers,
      usage: { inputTokens: num(usage['input_tokens']) ?? 0, outputTokens: num(usage['output_tokens']) ?? 0 },
    };
  }
}
