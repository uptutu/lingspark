import { createHash } from 'node:crypto';
import path from 'node:path';
import { readJsonOrNull, writeFileAtomic } from '../fsutil.js';
import { dataPaths } from '../paths.js';
import { postJson, type NetworkContext } from './network.js';
import { extractJson, parseStructured, structuredPrompt, structuredSchema, SYSTEM_PROMPT, yesNoPrompt } from './prompt.js';
import {
  JudgeError,
  type Answer,
  type GenerateRequest,
  type GenerateResponse,
  type Generator,
  type Judge,
  type JudgeCallContext,
  type JudgeRequest,
  type JudgeResponse,
  type Question,
} from './types.js';

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);

type Mode = 'logprobs' | 'structured';

/** Parallel single-question calls in logprobs mode. */
const CONCURRENCY = 4;

/**
 * Probability of Y against N from the first generated token's alternatives.
 * Token spellings vary by tokenizer ("Y", " Y", "y"), so they are normalised.
 * Returns null when neither appears: the model answered something else.
 */
export function yesProbability(topLogprobs: unknown): number | null {
  if (!Array.isArray(topLogprobs)) return null;
  let y = 0;
  let n = 0;
  for (const t of topLogprobs) {
    if (!isObject(t) || typeof t['token'] !== 'string' || typeof t['logprob'] !== 'number') continue;
    const tok = t['token'].trim().toUpperCase();
    const p = Math.exp(t['logprob']);
    if (tok === 'Y' || tok === 'YES' || tok === '是') y += p;
    else if (tok === 'N' || tok === 'NO' || tok === '否') n += p;
  }
  return y + n === 0 ? null : y / (y + n);
}

/**
 * Any Chat Completions endpoint: OpenAI, OpenRouter, DashScope (Qwen),
 * DeepSeek, Moonshot, a local vLLM or Ollama (design doc, 8.2).
 *
 * Probability comes from logprobs when the endpoint returns them: one
 * single-token Y/N call per question, reading the Y-vs-N split. Endpoints
 * that reject or omit logprobs fall back to one structured call per request
 * with self-reported confidence, and the judge reports itself uncalibrated.
 * Which mode an endpoint supports is probed once and remembered on disk,
 * because each hook run is a fresh process (DECISIONS V-8).
 */
export class OpenAICompatibleJudge implements Judge, Generator {
  readonly slow = false;
  readonly id: string;
  private mode: Mode | null;
  private readonly probeFile: string;
  /** The call finding out which mode works, while one is under way. */
  private probing: Promise<unknown> | null = null;

  constructor(
    private readonly endpoint: string,
    private readonly model: string,
    private readonly apiKey: string | null,
    private readonly net: NetworkContext,
  ) {
    this.id = `openai-compatible:${model}@${new URL(endpoint).host}`;
    const key = createHash('sha256').update(`${endpoint}\u0000${model}`).digest('hex').slice(0, 16);
    this.probeFile = path.join(dataPaths.cache(net.pathEnv), `probe-${key}.json`);
    const saved = readJsonOrNull(this.probeFile) as { mode?: unknown } | null;
    this.mode = saved?.mode === 'logprobs' || saved?.mode === 'structured' ? saved.mode : null;
  }

  /** Unknown until the first call; assumed uncalibrated until proven otherwise. */
  get calibrated(): boolean {
    return this.mode === 'logprobs';
  }

  private remember(mode: Mode): void {
    this.mode = mode;
    try {
      writeFileAtomic(this.probeFile, JSON.stringify({ mode, ts: new Date().toISOString() }));
    } catch {
      // probed again next time
    }
  }

  private url(): string {
    return `${this.endpoint.replace(/\/+$/u, '')}/chat/completions`;
  }

  private post(body: Json, ctx: JudgeCallContext, state: string): Promise<unknown> {
    return postJson(this.url(), body, {
      headers: this.apiKey === null ? {} : { authorization: `Bearer ${this.apiKey}` },
      signal: ctx.signal,
      net: this.net,
      outbound: { backend: this.id, purpose: ctx.purpose, rules: ctx.rules ?? [], state, ...(ctx.file !== undefined ? { file: ctx.file } : {}) },
    });
  }

  /**
   * On first contact, one call probes and concurrent calls wait for it. Were
   * they all to probe, every one but the first would fail once the first had
   * demoted the endpoint -- Pass 2 runs four paragraphs at a time.
   */
  async judge(req: JudgeRequest, ctx: JudgeCallContext): Promise<JudgeResponse> {
    while (this.mode === null && this.probing !== null) await this.probing.catch(() => undefined);
    if (this.mode !== null) return this.judgeIn(req, ctx);
    const probe = this.judgeIn(req, ctx);
    this.probing = probe;
    try {
      return await probe;
    } finally {
      this.probing = null;
    }
  }

  private async judgeIn(req: JudgeRequest, ctx: JudgeCallContext): Promise<JudgeResponse> {
    const noul = Object.entries(req.questions).filter(([, q]) => q.type === 'noul');
    if (this.mode !== 'structured' && noul.length > 0) {
      try {
        const viaLogprobs = await this.logprobs(req, noul, ctx);
        if (this.mode === null) this.remember('logprobs');
        const rest = Object.fromEntries(Object.entries(req.questions).filter(([, q]) => q.type !== 'noul'));
        if (Object.keys(rest).length === 0) return viaLogprobs;
        const other = await this.structured({ state: req.state, questions: rest }, ctx);
        return {
          answers: { ...viaLogprobs.answers, ...other.answers },
          usage: {
            inputTokens: viaLogprobs.usage.inputTokens + other.usage.inputTokens,
            outputTokens: viaLogprobs.usage.outputTokens + other.usage.outputTokens,
          },
        };
      } catch (err: unknown) {
        // Only the endpoint saying no to logprobs demotes it -- a rejected
        // request or a reply without them. A bad key, a timeout or a network
        // blip on the first call must not be remembered as "unsupported".
        const rejected =
          err instanceof JudgeError &&
          (err.status === 400 || err.status === 422 || err.message.includes('logprobs'));
        if (this.mode !== null || !rejected) throw err;
        this.remember('structured');
      }
    }
    return this.structured(req, ctx);
  }

  private async logprobs(
    req: JudgeRequest,
    noul: [string, Question][],
    ctx: JudgeCallContext,
  ): Promise<JudgeResponse> {
    const answers: Record<string, Answer> = {};
    let inputTokens = 0;
    let outputTokens = 0;
    const queue = [...noul];
    const worker = async (): Promise<void> => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
        const [name, q] = item;
        const raw = await this.post(
          {
            model: this.model,
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: yesNoPrompt(req.state, q) },
            ],
            max_tokens: 1,
            temperature: 0,
            logprobs: true,
            top_logprobs: 10,
          },
          ctx,
          req.state,
        );
        const choice = isObject(raw) && Array.isArray(raw['choices']) ? (raw['choices'][0] as unknown) : null;
        const lp = isObject(choice) && isObject(choice['logprobs']) ? choice['logprobs']['content'] : null;
        const first = Array.isArray(lp) && isObject(lp[0]) ? lp[0]['top_logprobs'] : null;
        const p = yesProbability(first);
        if (p === null) throw new JudgeError('endpoint returned no usable logprobs');
        answers[name] = { type: 'noul', probability: p };
        const usage = isObject(raw) && isObject(raw['usage']) ? raw['usage'] : {};
        inputTokens += typeof usage['prompt_tokens'] === 'number' ? usage['prompt_tokens'] : 0;
        outputTokens += typeof usage['completion_tokens'] === 'number' ? usage['completion_tokens'] : 0;
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, noul.length) }, worker));
    return { answers, usage: { inputTokens, outputTokens } };
  }

  private async structured(req: JudgeRequest, ctx: JudgeCallContext): Promise<JudgeResponse> {
    const r = await this.generate(
      { system: SYSTEM_PROMPT, prompt: structuredPrompt(req), schema: structuredSchema(req), state: req.state },
      ctx,
    );
    return { answers: parseStructured(req, r.json), usage: r.usage };
  }

  async generate(req: GenerateRequest, ctx: JudgeCallContext): Promise<GenerateResponse> {
    const raw = await this.post(
      {
        model: this.model,
        messages: [
          { role: 'system', content: req.system },
          // json_object is the widest-supported way to ask for JSON; json_schema
          // response formats are less portable, so the schema rides in the prompt.
          { role: 'user', content: `${req.prompt}\n\n回答必须是符合这个 JSON Schema 的 JSON：\n${JSON.stringify(req.schema)}` },
        ],
        temperature: 0,
        response_format: { type: 'json_object' },
      },
      ctx,
      req.state,
    );
    const choice = isObject(raw) && Array.isArray(raw['choices']) ? (raw['choices'][0] as unknown) : null;
    const content = isObject(choice) && isObject(choice['message']) ? choice['message']['content'] : null;
    if (typeof content !== 'string') throw new JudgeError('no message content');
    const usage = isObject(raw) && isObject(raw['usage']) ? raw['usage'] : {};
    return {
      json: extractJson(content),
      usage: {
        inputTokens: typeof usage['prompt_tokens'] === 'number' ? usage['prompt_tokens'] : 0,
        outputTokens: typeof usage['completion_tokens'] === 'number' ? usage['completion_tokens'] : 0,
      },
    };
  }
}
