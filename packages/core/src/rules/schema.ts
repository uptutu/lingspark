import { z } from 'zod';
import { docTypeSchema, passIdSchema, severitySchema } from '../config/schema.js';
import { msg } from '../messages.js';

export const ruleStatusSchema = z.enum(['candidate', 'shadow', 'active', 'retired']);
export type RuleStatus = z.infer<typeof ruleStatusSchema>;

export const ruleOriginSchema = z.enum(['builtin', 'team', 'personal']);
export type RuleOrigin = z.infer<typeof ruleOriginSchema>;

export const ruleKindSchema = z.enum(['deterministic', 'judge']);
export type RuleKind = z.infer<typeof ruleKindSchema>;

export const ruleScopeSchema = z.enum(['block', 'section', 'document', 'claim_pair']);
export type RuleScope = z.infer<typeof ruleScopeSchema>;

const noulQuestionSchema = z
  .object({
    type: z.literal('noul'),
    instructions: z.string().min(1),
    criteria: z.object({ true: z.string(), false: z.string() }).optional(),
  })
  .strict();

const choiceQuestionSchema = z
  .object({
    type: z.literal('choice'),
    instructions: z.string().min(1),
    // The Jev API caps choice criteria at 255 options (verified 2026-09-20).
    criteria: z.record(z.string(), z.string()).refine((c) => Object.keys(c).length <= 255, {
      message: msg.rules.schema.choiceTooMany,
    }),
  })
  .strict();

const scoreQuestionSchema = z
  .object({
    type: z.literal('score'),
    instructions: z.string().min(1),
    criteria: z.array(z.string()).min(2).max(10),
  })
  .strict();

export const questionSchema = z.discriminatedUnion('type', [
  noulQuestionSchema,
  choiceQuestionSchema,
  scoreQuestionSchema,
]);
export type RuleQuestion = z.infer<typeof questionSchema>;

const exampleSchema = z
  .object({
    /** The text handed to the rule; for judge rules this is the `state`. */
    state: z.string().min(1),
    note: z.string().optional(),
  })
  .strict();

const provenanceSchema = z
  .object({
    created: z.union([z.string(), z.date()]),
    from_feedback: z.array(z.string()).optional(),
  })
  .strict();

export const ruleFileSchema = z
  .object({
    id: z.string().regex(/^[A-Z]+-?\d+$/u, msg.rules.schema.idShape),
    /** Bumped on every substantive edit; part of the cache key. */
    version: z.number().int().min(1),
    name: z.string().min(1),
    pass: passIdSchema,
    kind: ruleKindSchema,
    severity: severitySchema,
    scope: ruleScopeSchema,
    doc_types: z.array(docTypeSchema).min(1),
    status: ruleStatusSchema,
    origin: ruleOriginSchema,

    /** kind === 'judge' */
    question: questionSchema.optional(),
    what: z.string().optional(),
    /** Folded into the instructions; the main lever against false positives. */
    not_for: z.array(z.string()).optional(),
    threshold: z.number().min(0).max(1).optional(),

    /** kind === 'deterministic': the registered function to call. */
    impl: z.string().optional(),

    message: z.string().min(1),
    suggestion: z.string().optional(),

    examples: z
      .object({
        positive: z.array(exampleSchema).default([]),
        negative: z.array(exampleSchema).default([]),
      })
      .default({ positive: [], negative: [] }),

    provenance: provenanceSchema.optional(),
  })
  .strict()
  .superRefine((rule, ctx) => {
    if (rule.kind === 'judge' && rule.question === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: msg.rules.schema.judgeNeedsQuestion,
        path: ['question'],
      });
    }
    if (rule.kind === 'deterministic' && (rule.impl === undefined || rule.impl === '')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: msg.rules.schema.deterministicNeedsImpl,
        path: ['impl'],
      });
    }
    if (rule.kind === 'deterministic' && rule.question !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: msg.rules.schema.deterministicNoQuestion,
        path: ['question'],
      });
    }
  });

export type RuleFile = z.infer<typeof ruleFileSchema>;

/** A loaded rule, with the layer it came from recorded. */
export interface Rule extends RuleFile {
  /** Where the file lives, for error messages and `rules show`. */
  readonly sourcePath: string;
}
