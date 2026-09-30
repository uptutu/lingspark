import { z } from 'zod';

/** The config format this build understands. */
export const CONFIG_VERSION = 1;

export const docTypeSchema = z.enum(['prd', 'tech-design', 'report', 'generic']);
export type DocType = z.infer<typeof docTypeSchema>;

export const severitySchema = z.enum(['error', 'warning', 'info']);
export type Severity = z.infer<typeof severitySchema>;

export const passIdSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
]);
export type PassId = z.infer<typeof passIdSchema>;

export const judgeBackendSchema = z.enum([
  // The writing agent reviews its documents in its own conversation (D-057).
  'session',
  // Whichever agent is writing judges its own document, in the background (D-055).
  'auto',
  'mock',
  'typesafe',
  'openai-compatible',
  'anthropic',
  'agent-cli',
  'codex-cli',
  'so1-local',
]);
export type JudgeBackendId = z.infer<typeof judgeBackendSchema>;

export const extractorBackendSchema = z.enum(['mock', 'anthropic', 'openai-compatible']);
export type ExtractorBackendId = z.infer<typeof extractorBackendSchema>;

/**
 * Field names that must never appear in a project config, because a project
 * config is committed to git (design doc, section 8.5).
 */
export const CREDENTIAL_KEYS = [
  'api_key',
  'apiKey',
  'key',
  'token',
  'secret',
  'authorization',
  'credentials',
] as const;

const judgeSchema = z
  .object({
    backend: judgeBackendSchema.optional(),
    /** Backend-specific; each backend resolves its own default. */
    model: z.string().optional(),
    endpoint: z.string().url().optional(),
    /** agent-cli / codex-cli only: path to the agent's CLI when it is not on PATH. */
    command: z.string().optional(),
    threshold_report: z.number().min(0).max(1).optional(),
    threshold_low: z.number().min(0).max(1).optional(),
    /** Added to the report threshold when a backend reports uncalibrated probabilities. */
    uncalibrated_bump: z.number().min(0).max(1).optional(),
  })
  .strict();

const extractorSchema = z
  .object({
    backend: extractorBackendSchema.optional(),
    model: z.string().optional(),
    endpoint: z.string().url().optional(),
  })
  .strict();

const passesSchema = z
  .object({
    hook_post: z.array(passIdSchema).optional(),
    hook_stop: z.array(passIdSchema).optional(),
    check: z.array(passIdSchema).optional(),
  })
  .strict();

const rulesSchema = z
  .object({
    disable: z.array(z.string()).optional(),
    severity: z.record(z.string(), severitySchema).optional(),
    threshold: z.record(z.string(), z.number().min(0).max(1)).optional(),
  })
  .strict();

const minerSchema = z
  .object({
    /** Off unless the user turns it on (design doc, section 9.7). */
    enabled: z.boolean().optional(),
    /** Absolute paths of projects the miner may scan. Empty means none. */
    projects: z.array(z.string()).optional(),
  })
  .strict();

/**
 * Required section keywords per doc type (design doc, section 6.2, D104).
 * Outer array is "one group per required section"; inner array is synonyms,
 * any one of which satisfies the group.
 */
const requiredSectionsSchema = z.record(docTypeSchema, z.array(z.array(z.string())));

/** Keys that only make sense in a project config. */
export const PROJECT_ONLY_KEYS = ['include', 'exclude', 'doc_types', 'required_sections'] as const;
/** Keys that only make sense in the user-level config. */
export const USER_ONLY_KEYS = ['miner'] as const;

const commonShape = {
  version: z.number().int().optional(),
  passes: passesSchema.optional(),
  judge: judgeSchema.optional(),
  extractor: extractorSchema.optional(),
  offline: z.boolean().optional(),
  allow_inline_suppress: z.boolean().optional(),
  rules: rulesSchema.optional(),
};

export const projectConfigFileSchema = z
  .object({
    ...commonShape,
    include: z.array(z.string()).optional(),
    exclude: z.array(z.string()).optional(),
    /** Glob pattern -> doc type. Frontmatter `doc_type` wins over this. */
    doc_types: z.record(z.string(), docTypeSchema).optional(),
    required_sections: requiredSectionsSchema.optional(),
  })
  .strict();
export type ProjectConfigFile = z.infer<typeof projectConfigFileSchema>;

export const userConfigFileSchema = z
  .object({
    ...commonShape,
    miner: minerSchema.optional(),
  })
  .strict();
export type UserConfigFile = z.infer<typeof userConfigFileSchema>;

/**
 * The fully resolved configuration every other module reads. Nothing here is
 * optional: defaults have already been applied.
 */
export interface ResolvedConfig {
  /** Project root, or null for a file outside any project (checked with the defaults, D-050). */
  readonly projectRoot: string | null;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly docTypes: ReadonlyMap<string, DocType>;
  readonly requiredSections: ReadonlyMap<DocType, readonly (readonly string[])[]>;
  readonly passes: {
    readonly hookPost: readonly PassId[];
    readonly hookStop: readonly PassId[];
    readonly check: readonly PassId[];
  };
  readonly judge: {
    /** Null until the user picks one: Pass 2 is skipped rather than faked. */
    readonly backend: JudgeBackendId | null;
    readonly model: string | null;
    readonly endpoint: string | null;
    readonly command: string | null;
    readonly thresholdReport: number;
    readonly thresholdLow: number;
    readonly uncalibratedBump: number;
  };
  readonly extractor: {
    readonly backend: ExtractorBackendId | null;
    readonly model: string | null;
    readonly endpoint: string | null;
  };
  readonly offline: boolean;
  readonly allowInlineSuppress: boolean;
  readonly rules: {
    readonly disable: ReadonlySet<string>;
    readonly severity: ReadonlyMap<string, Severity>;
    readonly threshold: ReadonlyMap<string, number>;
  };
  readonly miner: {
    readonly enabled: boolean;
    readonly projects: readonly string[];
  };
  /** Non-fatal problems found while loading, for `doctor` and the log. */
  readonly warnings: readonly string[];
}
