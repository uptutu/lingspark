import {
  DEFAULT_EXCLUDE,
  DEFAULT_INCLUDE,
  DEFAULT_JUDGE,
  DEFAULT_PASSES,
  DEFAULT_REQUIRED_SECTIONS,
} from './defaults.js';
import type {
  DocType,
  ExtractorBackendId,
  JudgeBackendId,
  PassId,
  ProjectConfigFile,
  ResolvedConfig,
  Severity,
  UserConfigFile,
} from './schema.js';

/**
 * Overrides from the command line. Highest priority (design doc, section 5.5).
 */
export interface CliOverrides {
  readonly offline?: boolean;
  readonly passes?: readonly PassId[];
  readonly judgeBackend?: JudgeBackendId;
}

export interface ResolveInput {
  readonly projectRoot: string | null;
  readonly project: ProjectConfigFile | null;
  readonly user: UserConfigFile | null;
  readonly cli?: CliOverrides;
  /** Non-fatal problems collected by the loader. */
  readonly warnings?: readonly string[];
}

/** First defined value wins. Used to express "cli > project > user > default". */
function pick<T>(...candidates: (T | undefined)[]): T | undefined {
  for (const c of candidates) if (c !== undefined) return c;
  return undefined;
}

/**
 * Collapse the config layers into the single object the rest of the codebase
 * reads.
 *
 * Scalars follow strict priority. `rules.disable` is the deliberate exception:
 * the layers are unioned rather than overridden, because a disable is always a
 * request for *less* checking, and design principle 1 says to err that way. A
 * user who silenced a noisy rule for themselves should not have it switched
 * back on by a project config they cloned.
 */
export function resolveConfig(input: ResolveInput): ResolvedConfig {
  const { project, user, cli } = input;
  const warnings = [...(input.warnings ?? [])];

  const docTypes = new Map<string, DocType>(Object.entries(project?.doc_types ?? {}));

  const requiredSections = new Map(DEFAULT_REQUIRED_SECTIONS);
  for (const [docType, groups] of Object.entries(project?.required_sections ?? {})) {
    if (groups) requiredSections.set(docType as DocType, groups);
  }

  const disable = new Set<string>([
    ...(user?.rules?.disable ?? []),
    ...(project?.rules?.disable ?? []),
  ]);

  const severity = new Map<string, Severity>([
    ...Object.entries(user?.rules?.severity ?? {}),
    ...Object.entries(project?.rules?.severity ?? {}),
  ]);

  const threshold = new Map<string, number>([
    ...Object.entries(user?.rules?.threshold ?? {}),
    ...Object.entries(project?.rules?.threshold ?? {}),
  ]);

  const judgeBackend: JudgeBackendId | null =
    pick(cli?.judgeBackend, project?.judge?.backend, user?.judge?.backend) ??
    DEFAULT_JUDGE.backend;

  const extractorBackend =
    pick<ExtractorBackendId>(project?.extractor?.backend, user?.extractor?.backend) ?? null;

  return {
    projectRoot: input.projectRoot,
    include: project?.include ?? DEFAULT_INCLUDE,
    exclude: project?.exclude ?? DEFAULT_EXCLUDE,
    docTypes,
    requiredSections,
    passes: {
      hookPost: pick(cli?.passes, project?.passes?.hook_post, user?.passes?.hook_post) ??
        DEFAULT_PASSES.hookPost,
      hookStop: pick(cli?.passes, project?.passes?.hook_stop, user?.passes?.hook_stop) ??
        DEFAULT_PASSES.hookStop,
      check: pick(cli?.passes, project?.passes?.check, user?.passes?.check) ??
        DEFAULT_PASSES.check,
    },
    judge: {
      backend: judgeBackend,
      model: pick(project?.judge?.model, user?.judge?.model) ?? null,
      // Where documents (and the user's API key) are sent, and which program
      // is run, may only come from the user's own config. A project config
      // arrives with a git clone; letting it name an endpoint would let any
      // repository redirect every document -- and the key in the
      // Authorization header -- to a server of its choosing (DECISIONS D-031).
      endpoint: user?.judge?.endpoint ?? null,
      command: user?.judge?.command ?? null,
      thresholdReport:
        pick(project?.judge?.threshold_report, user?.judge?.threshold_report) ??
        DEFAULT_JUDGE.thresholdReport,
      thresholdLow:
        pick(project?.judge?.threshold_low, user?.judge?.threshold_low) ??
        DEFAULT_JUDGE.thresholdLow,
      uncalibratedBump:
        pick(project?.judge?.uncalibrated_bump, user?.judge?.uncalibrated_bump) ??
        DEFAULT_JUDGE.uncalibratedBump,
    },
    extractor: {
      backend: extractorBackend,
      model: pick(project?.extractor?.model, user?.extractor?.model) ?? null,
      endpoint: user?.extractor?.endpoint ?? null, // same reason as judge.endpoint
    },
    // Offline is a safety switch, so any layer that asks for it gets it.
    offline: cli?.offline === true || project?.offline === true || user?.offline === true,
    allowInlineSuppress:
      pick(project?.allow_inline_suppress, user?.allow_inline_suppress) ?? true,
    rules: { disable, severity, threshold },
    miner: {
      enabled: user?.miner?.enabled ?? false,
      projects: user?.miner?.projects ?? [],
    },
    warnings,
  };
}
