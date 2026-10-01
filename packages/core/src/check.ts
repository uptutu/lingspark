import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { MAX_FULL_CHECK_BYTES } from './constants.js';
import { loadConfig } from './config/load.js';
import { createMatcher, type FileMatcher } from './config/matcher.js';
import type { CliOverrides } from './config/resolve.js';
import type { DocType, PassId, ResolvedConfig } from './config/schema.js';
import type { Diagnostic } from './diagnostics/types.js';
import { JudgeCache } from './judge/cache.js';
import { createJudge } from './judge/factory.js';
import { isGenerator, type Judge } from './judge/types.js';
import { msg } from './messages.js';
import { parseDocument } from './parser/parse.js';
import { recordShadowHits } from './shadow-report.js';
import { compareDiagnostics, runPass1 } from './passes/pass1.js';
import { runPass2, type Pass2Stats, type Uncertain } from './passes/pass2.js';
import { runPass3, type Pass3Doc, type Pass3Stats } from './passes/pass3.js';
import { isSuppressed } from './parser/suppressions.js';
import type { PathEnv } from './paths.js';
import { loadGlossary, type Glossary } from './rules/glossary.js';
import { loadRules, selectRules } from './rules/load.js';
import type { Rule } from './rules/schema.js';
import { detectTermCandidates, type TermCandidate } from './rules/term-candidates.js';
// Registers every deterministic implementation. Without this import a checker
// built from this module alone would find no impl for any Pass 1 rule.
import './rules/deterministic/index.js';

/** Passes this build can actually run. Later milestones extend the list. */
export const IMPLEMENTED_PASSES: readonly PassId[] = [0, 1, 2, 3];

/** Pass 2's share of a `check` run when no caller budget is given. */
const DEFAULT_JUDGE_BUDGET_MS = 120_000;

export type SkipReason = 'opted-out' | 'out-of-scope' | 'not-found' | 'unreadable';

/** Which configured pass list to use (design doc, 5.5 `passes`). */
export type PassSet = 'check' | 'hookPost' | 'hookStop';

export interface FileCheckResult {
  /** Absolute path of the checked file. */
  readonly absPath: string;
  readonly docType: DocType;
  readonly diagnostics: readonly Diagnostic[];
  /** From shadow-status rules: recorded, never shown (design doc, 7.3). */
  readonly shadowDiagnostics: readonly Diagnostic[];
  readonly suppressedCount: number;
  readonly passesRun: readonly PassId[];
  readonly skipped?: SkipReason;
  readonly warnings: readonly string[];
  /** Why Pass 2 did not run, when it was wanted and did not. */
  readonly judgeNote?: string;
  /** Pass 2 judgements between T_LOW and the threshold; Pass 4's input. */
  readonly uncertain?: readonly Uncertain[];
  readonly judgeStats?: Pass2Stats;
  /** Machine-proposed glossary term pairs (D-091); the hook persists these. */
  readonly termCandidates?: readonly TermCandidate[];
}

export interface CheckerOptions {
  readonly cli?: CliOverrides;
  /** Builtin rule YAML, supplied by the caller so core does not depend on the rules package. */
  readonly builtinRules: readonly { file: string; yaml: string }[];
  readonly pathEnv?: PathEnv;
  /** The agent whose writes are checked; `judge.backend: auto` judges with it (D-055). */
  readonly agent?: string;
  /** Forces a doc type for every file, overriding path and frontmatter. */
  readonly docTypeOverride?: DocType;
  /** Defaults to 'check'. */
  readonly passSet?: PassSet;
  /**
   * When true, files out of scope (not matched by include/exclude: the
   * project's own, or the defaults outside any project) are skipped. The hook sets this; `check`
   * does not, because a file named on the command line was asked for
   * explicitly (DECISIONS D-012).
   */
  readonly respectScope?: boolean;
  /**
   * A judge to use instead of the configured one. Tests pass a MockJudge;
   * `null` forces Pass 2 off.
   */
  readonly judge?: Judge | null;
  /** Deadline for Pass 2 across the whole checker, in ms since creation. */
  readonly judgeBudgetMs?: number;
  /** Leave slow judges out (the PostToolUse path, DECISIONS V-10). */
  readonly skipSlowJudge?: boolean;
  /** Injected for tests; passed to network-backed judges. */
  readonly fetchImpl?: typeof fetch;
  /**
   * Suppression directives attributed to the checked agent itself (D-092), per
   * absolute file path. Those directives do not silence anything; a user's own
   * suppression of the same file is unaffected.
   */
  readonly agentSuppressions?: ReadonlyMap<string, { readonly lines: readonly number[]; readonly optedOut: boolean }>;
}

/** Everything that depends on which project a file belongs to. */
interface ProjectState {
  readonly config: ResolvedConfig;
  readonly matcher: FileMatcher;
  readonly rules: ReadonlyMap<string, Rule>;
  readonly glossary: Glossary;
  readonly warnings: readonly string[];
  readonly judge: Judge | null;
  readonly judgeProblem?: string;
}

export interface AcrossResult {
  readonly diagnostics: readonly Diagnostic[];
  readonly shadowDiagnostics: readonly Diagnostic[];
  /** Why part of the cross-document check did not run, for the user. */
  readonly notes: readonly string[];
  readonly stats: readonly Pass3Stats[];
}

export interface Checker {
  checkFile(file: string): Promise<FileCheckResult>;
  /** Checks text that is not (or not yet) on disk. `file` is used for display and config lookup. */
  checkSource(source: string, file: string): Promise<FileCheckResult>;
  /**
   * Pass 3 across documents. The documents compared are `corpus` when given
   * -- the hook passes everything the session wrote (D-050) -- and otherwise
   * every checked document of the projects `files` belong to. With `focus`,
   * only contradictions involving one of `files` are reported; without, every
   * contradiction among the compared documents is.
   */
  checkAcross(files: readonly string[], opts: AcrossOptions): Promise<AcrossResult>;
  /** The config and rules that apply to a file; the hook's in-session review reads them (D-057). */
  settingsFor(file: string): { readonly config: ResolvedConfig; readonly rules: ReadonlyMap<string, Rule> };
}

export interface AcrossOptions {
  readonly focus: boolean;
  readonly budgetMs?: number;
  readonly corpus?: readonly string[];
}

/** The deepest directory containing every path; relative paths in messages are shown from here. */
function commonDir(files: readonly string[]): string {
  const parts = files.map((f) => path.dirname(path.resolve(f)).split(path.sep));
  const first = parts[0] ?? [];
  let n = 0;
  while (n < first.length && parts.every((p) => p[n] === first[n])) n++;
  // A bare drive ("C:") would make paths drive-relative: keep its separator.
  const joined = first.slice(0, n).join(path.sep);
  return n <= 1 ? joined + path.sep : joined;
}

/** Directories never worth walking into when listing a project's documents. */
const PRUNE = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.lingspark', '.next', 'target', 'vendor']);
/** A project with more documents than this is checked on the first ones found. */
const MAX_ACROSS_DOCS = 300;

/** Every Markdown file the project checks, found by walking from its root. */
export function listCheckedDocs(root: string, matcher: FileMatcher, limit = MAX_ACROSS_DOCS): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0 && out.length < limit) {
    const dir = stack.pop() as string;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!PRUNE.has(e.name)) stack.push(abs);
      } else if (/\.(md|markdown|mdx)$/iu.test(e.name) && matcher.isChecked(abs)) {
        out.push(abs);
        if (out.length >= limit) break;
      }
    }
  }
  return out.sort();
}

/**
 * Builds a checker that loads config, rules, glossary and judge once per
 * project.
 *
 * Files handed to one checker can belong to different projects -- `lingspark
 * check a/x.md b/y.md` -- so the state is cached by project root rather than
 * loaded once globally.
 */
export function createChecker(opts: CheckerOptions): Checker {
  const byRoot = new Map<string, ProjectState>();
  const started = Date.now();
  const cache = new JudgeCache(opts.pathEnv);

  const stateFor = (absPath: string): ProjectState => {
    const config = loadConfig({
      cwd: path.dirname(absPath),
      ...(opts.cli !== undefined ? { cli: opts.cli } : {}),
      ...(opts.pathEnv !== undefined ? { pathEnv: opts.pathEnv } : {}),
    });
    const key = config.projectRoot ?? '';
    const cached = byRoot.get(key);
    if (cached !== undefined) return cached;

    const warnings = [...config.warnings];
    const glossary = loadGlossary(config.projectRoot, warnings);
    const loaded = loadRules({
      config,
      builtin: opts.builtinRules,
      ...(opts.pathEnv !== undefined ? { pathEnv: opts.pathEnv } : {}),
    });
    warnings.push(...loaded.warnings);

    let judge: Judge | null;
    let judgeProblem: string | undefined;
    if (opts.judge !== undefined) {
      judge = opts.judge;
    } else {
      const setup = createJudge(config, {
        ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
        ...(opts.pathEnv !== undefined ? { pathEnv: opts.pathEnv } : {}),
        ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
      });
      judge = setup.judge;
      judgeProblem = setup.problem;
    }
    if (judge !== null && judge.slow && opts.skipSlowJudge === true) {
      judge = null;
      judgeProblem = msg.judge.skippedSlow;
    }

    const state: ProjectState = {
      config,
      matcher: createMatcher(config),
      rules: loaded.rules,
      glossary,
      warnings,
      judge,
      ...(judgeProblem !== undefined ? { judgeProblem } : {}),
    };
    byRoot.set(key, state);
    return state;
  };

  const skippedResult = (absPath: string, skipped: SkipReason): FileCheckResult => ({
    absPath,
    docType: 'generic',
    diagnostics: [],
    shadowDiagnostics: [],
    suppressedCount: 0,
    passesRun: [],
    skipped,
    warnings: [],
  });

  const inScope = (absPath: string): boolean =>
    opts.respectScope !== true || stateFor(absPath).matcher.isChecked(absPath);

  const run = async (source: string, absPath: string, sizeBytes: number): Promise<FileCheckResult> => {
    const state = stateFor(absPath);
    const docTypeFromPath = opts.docTypeOverride ?? state.matcher.docTypeForPath(absPath);
    const parsed = parseDocument(source, { file: absPath, docTypeFromPath });

    // D-092: suppressions the agent introduced about itself do not silence
    // checks. Strip exactly those; everything else in the file stands.
    const attribution = opts.agentSuppressions?.get(absPath);
    const effective =
      attribution !== undefined && (attribution.lines.length > 0 || attribution.optedOut)
        ? {
            ...parsed,
            suppressions: parsed.suppressions.filter((s) => !attribution.lines.includes(s.commentLine)),
            ...(attribution.optedOut ? { optedOut: false as const } : {}),
          }
        : parsed;
    const doc = opts.docTypeOverride !== undefined ? { ...effective, docType: opts.docTypeOverride } : effective;

    const base = { absPath, docType: doc.docType, warnings: state.warnings };
    if (doc.optedOut) {
      return { ...base, diagnostics: [], shadowDiagnostics: [], suppressedCount: 0, passesRun: [], skipped: 'opted-out' };
    }

    const wanted = state.config.passes[opts.passSet ?? 'check'];
    let passes = wanted.filter((p) => IMPLEMENTED_PASSES.includes(p));
    // Section 5.4: large files get the cheap passes only.
    if (sizeBytes > MAX_FULL_CHECK_BYTES) passes = passes.filter((p) => p <= 1);

    const passesRun: PassId[] = [];
    if (passes.includes(0)) passesRun.push(0);

    const diagnostics: Diagnostic[] = [];
    const shadowDiagnostics: Diagnostic[] = [];
    let suppressedCount = 0;
    const warnings = [...state.warnings];

    if (passes.includes(1)) {
      const r = runPass1({ doc, config: state.config, rules: state.rules, glossary: state.glossary });
      diagnostics.push(...r.diagnostics);
      shadowDiagnostics.push(...r.shadowDiagnostics);
      suppressedCount += r.suppressedCount;
      warnings.push(...r.warnings);
      passesRun.push(1);
    }

    let judgeNote: string | undefined;
    let uncertain: readonly Uncertain[] | undefined;
    let judgeStats: Pass2Stats | undefined;
    if (passes.includes(2)) {
      if (state.judge === null) {
        judgeNote = state.judgeProblem;
      } else {
        const budget = (opts.judgeBudgetMs ?? DEFAULT_JUDGE_BUDGET_MS) - (Date.now() - started);
        if (budget > 0) {
          const r = await runPass2({ doc, config: state.config, rules: state.rules, judge: state.judge, cache, budgetMs: budget });
          diagnostics.push(...r.diagnostics);
          shadowDiagnostics.push(...r.shadowDiagnostics);
          suppressedCount += r.suppressedCount;
          warnings.push(...r.warnings);
          uncertain = r.uncertain;
          judgeStats = r.stats;
          passesRun.push(2);
        }
      }
    }

    diagnostics.sort(compareDiagnostics);
    shadowDiagnostics.sort(compareDiagnostics);
    if (shadowDiagnostics.length > 0) recordShadowHits(shadowDiagnostics, opts.pathEnv);
    const termCandidates = detectTermCandidates(doc, state.glossary);
    return {
      ...base,
      diagnostics,
      shadowDiagnostics,
      suppressedCount,
      passesRun,
      warnings,
      ...(judgeNote !== undefined ? { judgeNote } : {}),
      ...(uncertain !== undefined ? { uncertain } : {}),
      ...(judgeStats !== undefined ? { judgeStats } : {}),
      ...(termCandidates.length > 0 ? { termCandidates } : {}),
    };
  };

  const across = async (files: readonly string[], o: AcrossOptions): Promise<AcrossResult> => {
    const diagnostics: Diagnostic[] = [];
    const shadowDiagnostics: Diagnostic[] = [];
    const notes = new Set<string>();
    const stats: Pass3Stats[] = [];
    const t0 = Date.now();
    const budget = o.budgetMs ?? opts.judgeBudgetMs ?? DEFAULT_JUDGE_BUDGET_MS;

    // One run per config: files under different projects (or under none) are
    // compared separately, each with its own rules and judge.
    const projects = new Map<string, { state: ProjectState; focus: Set<string>; corpus: Set<string> }>();
    const group = (abs: string): { state: ProjectState; focus: Set<string>; corpus: Set<string> } => {
      const state = stateFor(abs);
      const key = state.config.projectRoot ?? '';
      const entry = projects.get(key) ?? { state, focus: new Set<string>(), corpus: new Set<string>() };
      projects.set(key, entry);
      return entry;
    };
    for (const f of files) group(path.resolve(f)).focus.add(path.resolve(f));
    for (const f of o.corpus ?? []) {
      const abs = path.resolve(f);
      const g = group(abs);
      if (g.state.matcher.isChecked(abs)) g.corpus.add(abs);
    }

    for (const { state, focus, corpus } of projects.values()) {
      const root = state.config.projectRoot;
      // Outside any project with no corpus given (`lingspark check a.md b.md`),
      // the files named are the ones to compare.
      const listed =
        o.corpus !== undefined ? [...corpus].sort() : root !== null ? listCheckedDocs(root, state.matcher) : [...focus].sort();
      if (listed.length < 2) continue;
      const base = root ?? commonDir(listed);
      if (!state.config.passes[opts.passSet ?? 'check'].includes(3)) continue;
      const rules = selectRules(state.rules, { pass: 3, docType: 'generic', includeShadow: true }).filter(
        (r) => r.kind === 'judge' && r.scope === 'claim_pair',
      );
      if (rules.length === 0) continue;
      if (state.judge === null) {
        if (state.judgeProblem !== undefined) notes.add(state.judgeProblem);
        continue;
      }
      if (!isGenerator(state.judge)) {
        notes.add(msg.pass3.noGenerator(state.judge.id));
        continue;
      }

      const docs: (Pass3Doc & { suppressions: ReturnType<typeof parseDocument>['suppressions'] })[] = [];
      for (const abs of listed) {
        let source: string;
        try {
          if (statSync(abs).size > MAX_FULL_CHECK_BYTES) continue;
          source = readFileSync(abs, 'utf8');
        } catch {
          continue;
        }
        const doc = parseDocument(source, { file: abs, docTypeFromPath: state.matcher.docTypeForPath(abs) });
        if (doc.optedOut) continue;
        docs.push({ absPath: abs, relPath: path.relative(base, abs), source, suppressions: doc.suppressions });
      }
      const suppressionsOf = new Map(docs.map((d) => [d.absPath, d.suppressions]));

      for (const rule of rules) {
        const left = budget - (Date.now() - t0);
        if (left <= 0) break;
        const r = await runPass3({
          docs,
          ...(o.focus ? { focus } : {}),
          generator: state.judge,
          judge: state.judge,
          rule,
          config: state.config,
          ...(opts.pathEnv !== undefined ? { pathEnv: opts.pathEnv } : {}),
          budgetMs: left,
        });
        stats.push(r.stats);
        if (r.stats.timedOut) notes.add(msg.pass3.timedOut);
        const keep = (d: Diagnostic): boolean => {
          const sup = suppressionsOf.get(d.file);
          return !(state.config.allowInlineSuppress && sup !== undefined && isSuppressed(sup, d.ruleId, d.range.start.line));
        };
        diagnostics.push(...r.diagnostics.filter(keep));
        shadowDiagnostics.push(...r.shadowDiagnostics.filter(keep));
      }
      if (shadowDiagnostics.length > 0) recordShadowHits(shadowDiagnostics, opts.pathEnv);
    }
    return { diagnostics, shadowDiagnostics, notes: [...notes], stats };
  };

  return {
    checkAcross: across,
    settingsFor: (file: string) => {
      const state = stateFor(path.resolve(file));
      return { config: state.config, rules: state.rules };
    },

    async checkFile(file: string): Promise<FileCheckResult> {
      const absPath = path.resolve(file);
      if (!inScope(absPath)) return skippedResult(absPath, 'out-of-scope');
      let source: string;
      let size: number;
      try {
        size = statSync(absPath).size;
        source = readFileSync(absPath, 'utf8');
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        return skippedResult(absPath, code === 'ENOENT' ? 'not-found' : 'unreadable');
      }
      return run(source, absPath, size);
    },

    async checkSource(source: string, file: string): Promise<FileCheckResult> {
      const absPath = path.resolve(file);
      if (!inScope(absPath)) return skippedResult(absPath, 'out-of-scope');
      return run(source, absPath, Buffer.byteLength(source, 'utf8'));
    },
  };
}
