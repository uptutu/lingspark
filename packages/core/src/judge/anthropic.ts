import Anthropic from '@anthropic-ai/sdk';
import { guardedFetch, isLocalUrl, type NetworkContext } from './network.js';
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
 * Default model. The design doc asks for the cheapest current Claude model
 * for judging (8.2), which is Claude Haiku 4.5; `judge.model` overrides it.
 */
export const ANTHROPIC_DEFAULT_MODEL = 'claude-haiku-4-5';

/**
 * Claude through the official SDK (design doc, 8.2).
 *
 * The Messages API exposes no token probabilities, so answers come back as
 * structured output with a self-reported confidence, and the judge is
 * uncalibrated: its threshold is raised (8.2). The SDK's `fetch` is replaced
 * by `guardedFetch`, so the offline switch and the outbound log apply to it
 * exactly as they do to raw requests.
 */
export class AnthropicJudge implements Judge, Generator {
  readonly calibrated = false;
  readonly slow = false;
  readonly id: string;
  /** Some models may not accept `output_config.format`; remembered once seen. */
  private structuredOutputs = true;

  constructor(
    private readonly apiKey: string,
    private readonly net: NetworkContext,
    private readonly model: string = ANTHROPIC_DEFAULT_MODEL,
    private readonly baseURL?: string,
  ) {
    this.id = `anthropic:${model}`;
  }

  async judge(req: JudgeRequest, ctx: JudgeCallContext): Promise<JudgeResponse> {
    const r = await this.generate(
      { system: SYSTEM_PROMPT, prompt: structuredPrompt(req), schema: structuredSchema(req), state: req.state },
      ctx,
    );
    return { answers: parseStructured(req, r.json), usage: r.usage };
  }

  async generate(req: GenerateRequest, ctx: JudgeCallContext): Promise<GenerateResponse> {
    // Refuse here rather than inside fetch: the SDK treats a throwing fetch as
    // a connection error and retries it, which would wait and then report the
    // wrong error.
    if (this.net.offline && (this.baseURL === undefined || !isLocalUrl(this.baseURL))) {
      throw new OfflineError('offline: refused request to the Anthropic API');
    }
    const client = new Anthropic({
      apiKey: this.apiKey,
      maxRetries: 2,
      fetch: guardedFetch(this.net, {
        backend: this.id,
        purpose: ctx.purpose,
        rules: ctx.rules ?? [],
        state: req.state,
        ...(ctx.file !== undefined ? { file: ctx.file } : {}),
      }),
      ...(this.baseURL !== undefined ? { baseURL: this.baseURL } : {}),
    });

    const params = {
      model: this.model,
      max_tokens: 8192,
      system: req.system,
      messages: [{ role: 'user' as const, content: req.prompt }],
    };

    let response: Anthropic.Message;
    try {
      response = await client.messages.create(
        this.structuredOutputs
          ? { ...params, output_config: { format: { type: 'json_schema', schema: { ...req.schema } } } }
          : params,
        { signal: ctx.signal },
      );
    } catch (err: unknown) {
      if (err instanceof OfflineError) throw err;
      if (err instanceof Anthropic.BadRequestError && this.structuredOutputs) {
        // Fall back to asking for JSON in the prompt, which every prompt here
        // already does, and parse it out of the text.
        this.structuredOutputs = false;
        return this.generate(req, ctx);
      }
      if (err instanceof Anthropic.APIUserAbortError) throw new JudgeError('aborted');
      if (err instanceof Anthropic.APIError) {
        const status: unknown = err.status;
        throw new JudgeError(`anthropic: ${err.message}`, typeof status === 'number' ? status : undefined);
      }
      throw new JudgeError(`anthropic: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (response.stop_reason === 'refusal') throw new JudgeError('anthropic: refused');
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    return {
      json: extractJson(text),
      usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
    };
  }
}
