/**
 * The judge contract (design doc, 8.1). Shaped after the Jev API; every other
 * backend adapts to it.
 */

export type Question =
  | { readonly type: 'noul'; readonly instructions: string; readonly criteria?: { readonly true: string; readonly false: string } }
  | { readonly type: 'choice'; readonly instructions: string; readonly criteria: Readonly<Record<string, string>> }
  | { readonly type: 'score'; readonly instructions: string; readonly criteria: readonly string[] };

export type Answer =
  | { readonly type: 'noul'; readonly probability: number }
  | {
      readonly type: 'choice';
      readonly choice: string;
      readonly probabilities: Readonly<Record<string, number>>;
      readonly confidence: number;
    }
  | {
      readonly type: 'score';
      readonly score: number;
      readonly probabilities: Readonly<Record<string, number>>;
      readonly confidence: number;
    };

export interface JudgeRequest {
  readonly state: string;
  readonly questions: Readonly<Record<string, Question>>;
}

export interface JudgeResponse {
  readonly answers: Readonly<Record<string, Answer>>;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
}

/** Why this call is being made; recorded in the outbound log (8.6). */
export type JudgePurpose = 'pass2' | 'pass3' | 'classify' | 'eval' | 'doctor';

export interface JudgeCallContext {
  readonly signal: AbortSignal;
  readonly purpose: JudgePurpose;
  /** Rule ids the questions belong to, for the outbound log. */
  readonly rules?: readonly string[];
  /** Document the state came from, for the outbound log. */
  readonly file?: string;
}

export interface Judge {
  /** Backend plus model, e.g. `typesafe:jev-latest`. Part of every cache key. */
  readonly id: string;
  /**
   * Whether probabilities can be compared to a threshold as they are. False
   * for backends that only self-report confidence; those face a higher bar
   * (design doc, 8.2).
   */
  readonly calibrated: boolean;
  /**
   * Seconds rather than fractions of a second per call. Slow judges are kept
   * out of the PostToolUse path (DECISIONS V-10).
   */
  readonly slow: boolean;
  judge(req: JudgeRequest, ctx: JudgeCallContext): Promise<JudgeResponse>;
}

/**
 * A structured-generation request: the model writes a JSON value matching
 * `schema`. Used where a closed question is not enough -- extracting the
 * claims a document makes (design doc, 6.4) -- and, underneath, by every
 * general-purpose judge backend to answer its closed questions.
 */
export interface GenerateRequest {
  readonly system: string;
  readonly prompt: string;
  readonly schema: Readonly<Record<string, unknown>>;
  /** The document text the prompt carries, for the outbound log. */
  readonly state: string;
}

export interface GenerateResponse {
  readonly json: unknown;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
}

/** A backend that can write, not only answer. Jev cannot; the others can. */
export interface Generator {
  readonly id: string;
  readonly slow: boolean;
  generate(req: GenerateRequest, ctx: JudgeCallContext): Promise<GenerateResponse>;
}

export const isGenerator = (x: unknown): x is Generator =>
  typeof x === 'object' && x !== null && typeof (x as { generate?: unknown }).generate === 'function';

/** A judge that could not answer. Callers drop the affected questions, never the check. */
export class JudgeError extends Error {
  override readonly name = 'JudgeError';
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** A network call attempted while offline. Always a bug if it reaches a user. */
export class OfflineError extends Error {
  override readonly name = 'OfflineError';
}
