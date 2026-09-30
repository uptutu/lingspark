import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createChecker } from '../check.js';
import { loadProjectConfig } from '../config/load.js';
import { createMatcher, type FileMatcher } from '../config/matcher.js';
import { resolveConfig } from '../config/resolve.js';
import type { DocType, ResolvedConfig } from '../config/schema.js';
import { appendLine, readJsonOrNull, writeFileAtomic } from '../fsutil.js';
import type { AgentId } from '../agents.js';
import { dataPaths, type PathEnv } from '../paths.js';
import { claudeCodeAdapter, defaultClaudeCodeRoot } from './claude-code.js';
import { classifyFeedback } from './classify.js';
import { diffBlocks, findRevisions, REWRITE_RATIO, type Revision } from './extract.js';
import type { Judge } from '../judge/types.js';
import type { TranscriptAdapter } from './types.js';

/** One line of `feedback/feedback.jsonl` (design doc, 9.6). */
export interface FeedbackRecord {
  readonly id: string;
  readonly agent: AgentId;
  readonly sessionId: string;
  readonly promptId: string;
  readonly ts: string;
  readonly project: string;
  readonly file: string;
  readonly docType: DocType;
  readonly feedback: string;
  /** Filled in by classification (M2); null until then. */
  readonly isRevision: number | null;
  readonly category: string | null;
  readonly categoryConfidence: number | null;
  readonly changes: readonly { before: string; after: string; headingPath: readonly string[] }[];
  /** Rules that fired on the changed parts of `before`, with the rule set of the day. */
  readonly matchedRules: readonly string[];
  /** No rule fired on what the user asked to change: a miss the slow loop learns from. */
  readonly missed: boolean;
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A ULID: sortable by creation time, unique without coordination. */
export function ulid(now: number = Date.now()): string {
  let time = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(10);
  let rand = '';
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      rand += CROCKFORD[(acc >> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return time + rand.slice(0, 16);
}

interface MinerState {
  readonly files: Record<string, { offset: number; size: number; mtimeMs: number }>;
}

function readState(env?: PathEnv): MinerState {
  const raw = readJsonOrNull(dataPaths.minerState(env));
  if (raw !== null && typeof raw === 'object' && 'files' in raw) {
    const files = (raw).files;
    if (files !== null && typeof files === 'object') return { files: files as MinerState['files'] };
  }
  return { files: {} };
}

/** Keys of records already on disk, so a re-run never duplicates one (9.6). */
function existingKeys(env?: PathEnv): Set<string> {
  const keys = new Set<string>();
  let text: string;
  try {
    text = readFileSync(dataPaths.feedback(env), 'utf8');
  } catch {
    return keys;
  }
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const r = JSON.parse(line) as Partial<FeedbackRecord>;
      keys.add(`${r.sessionId ?? ''}|${r.promptId ?? ''}|${r.project ?? ''}|${r.file ?? ''}`);
    } catch {
      // a damaged line costs its own record, nothing more
    }
  }
  return keys;
}

export type MineStatus = 'disabled' | 'no-projects' | 'ok';

export interface MineOptions {
  /** User-level config: `miner.enabled` and `miner.projects` live there. */
  readonly config: ResolvedConfig;
  readonly builtinRules: readonly { file: string; yaml: string }[];
  readonly pathEnv?: PathEnv;
  /** Transcript roots; defaults to each adapter's standard location. */
  readonly roots?: readonly string[];
  readonly adapters?: readonly TranscriptAdapter[];
  readonly since?: Date;
  /** Report what would happen; write nothing. */
  readonly dryRun?: boolean;
  /**
   * Classifies each record (design doc, 9.5) when given. Without one the
   * records keep a null category, to be classified on a later run.
   */
  readonly judge?: Judge | null;
}

export interface MineResult {
  readonly status: MineStatus;
  readonly transcriptsSeen: number;
  readonly transcriptsScanned: number;
  readonly records: readonly FeedbackRecord[];
  readonly skippedRewrite: number;
  readonly skippedDuplicate: number;
  /** Dropped because the judge said the prompt was not feedback on the writing. */
  readonly skippedNotRevision: number;
  /** Records from earlier runs classified in this one. */
  readonly backfilled: number;
}

interface AuthorisedProject {
  readonly root: string;
  readonly matcher: FileMatcher;
  readonly config: ResolvedConfig;
}

/**
 * The whitelisted projects, each with its include/exclude compiled. A
 * whitelisted project without `.lingspark/config.yaml` uses the defaults:
 * listing it in `miner.projects` is already an explicit opt-in.
 */
function authorisedProjects(roots: readonly string[]): AuthorisedProject[] {
  const out: AuthorisedProject[] = [];
  for (const r of roots) {
    const root = path.resolve(r);
    let project = null;
    try {
      project = loadProjectConfig(root).config;
    } catch {
      continue; // a broken project config disqualifies the project, not the run
    }
    const config = resolveConfig({ projectRoot: root, project, user: null });
    out.push({ root, matcher: createMatcher(config), config });
  }
  return out;
}

const within = (root: string, file: string): boolean => {
  const rel = path.relative(root, file);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

/**
 * Classifies records an earlier run left unclassified (9.5: "留待以后补跑"),
 * rewriting the feedback file. Records the judge says are not feedback on
 * the writing are dropped, as they would have been at extraction time.
 */
async function backfill(env: PathEnv | undefined, judge: Judge, config: ResolvedConfig): Promise<number> {
  let text: string;
  try {
    text = readFileSync(dataPaths.feedback(env), 'utf8');
  } catch {
    return 0;
  }
  const out: string[] = [];
  let changed = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let r: FeedbackRecord;
    try {
      r = JSON.parse(line) as FeedbackRecord;
    } catch {
      out.push(line);
      continue;
    }
    if (r.isRevision !== null) {
      out.push(line);
      continue;
    }
    const c = await classifyFeedback(r.feedback, r.changes, judge, config, new AbortController().signal);
    if (c.kind === 'failed') {
      out.push(line);
      continue;
    }
    changed++;
    if (c.kind === 'not-revision') continue;
    out.push(JSON.stringify({ ...r, isRevision: c.isRevision, category: c.category, categoryConfidence: c.categoryConfidence }));
  }
  if (changed > 0) writeFileAtomic(dataPaths.feedback(env), `${out.join('\n')}\n`);
  return changed;
}

/**
 * `lingspark mine` (design doc, 9.7).
 *
 * Off unless the user turned it on and named projects. Transcripts are only
 * ever read. A transcript whose size and mtime have not changed is skipped;
 * one that grew is re-read from the start -- a revision found in new lines may
 * refer back to a write from before them -- but only prompts past the stored
 * offset produce records.
 */
export async function mine(opts: MineOptions): Promise<MineResult> {
  const empty = { transcriptsSeen: 0, transcriptsScanned: 0, records: [], skippedRewrite: 0, skippedDuplicate: 0, skippedNotRevision: 0, backfilled: 0 };
  if (!opts.config.miner.enabled) return { status: 'disabled', ...empty };
  if (opts.config.miner.projects.length === 0) return { status: 'no-projects', ...empty };

  const env = opts.pathEnv;
  const projects = authorisedProjects(opts.config.miner.projects);
  const projectOf = (file: string): AuthorisedProject | undefined =>
    projects.find((p) => within(p.root, file) && p.matcher.isChecked(file));

  const adapters = opts.adapters ?? [claudeCodeAdapter];
  const state = readState(env);
  const nextState: MinerState = { files: { ...state.files } };
  const seenKeys = existingKeys(env);
  // matchedRules uses the deterministic passes only. Running the judge over
  // every `before` document would cost a model call per paragraph per record;
  // how the semantic rules would have fared is M3's backtest (DECISIONS D-032).
  const checker = createChecker({
    builtinRules: opts.builtinRules,
    judge: null,
    ...(env !== undefined ? { pathEnv: env } : {}),
  });
  const judge = opts.judge ?? null;
  const sinceMs = opts.since?.getTime() ?? -Infinity;

  const records: FeedbackRecord[] = [];
  let seen = 0;
  let scanned = 0;
  let skippedRewrite = 0;
  let skippedDuplicate = 0;
  let skippedNotRevision = 0;

  for (const adapter of adapters) {
    const roots = opts.roots ?? (adapter.agent === 'claude-code' ? [defaultClaudeCodeRoot()] : []);
    for (const file of adapter.discover(roots)) {
      seen++;
      if (file.mtimeMs < sinceMs) continue;
      const prev = state.files[file.path];
      if (prev !== undefined && prev.size === file.size && prev.mtimeMs === file.mtimeMs) continue;
      scanned++;

      const events = adapter.parse(file);
      const newSince = prev !== undefined && prev.size <= file.size ? prev.offset : -1;
      const revisions: Revision[] = findRevisions(events, {
        isEligible: (f) => projectOf(f) !== undefined,
        newSince,
      });

      for (const rev of revisions) {
        if (Date.parse(rev.ts) < sinceMs) continue;
        const project = projectOf(rev.file);
        if (project === undefined) continue;
        const relFile = path.relative(project.root, rev.file).split(path.sep).join('/');
        const key = `${rev.sessionId}|${rev.promptKey}|${project.root}|${relFile}`;
        if (seenKeys.has(key)) {
          skippedDuplicate++;
          continue;
        }

        const diff = diffBlocks(rev.before, rev.after);
        if (diff.changes.length === 0) continue;
        if (diff.changedRatio > REWRITE_RATIO) {
          skippedRewrite++;
          continue;
        }

        const checked = await checker.checkSource(rev.before, rev.file);
        const hitLines = diff.changes.flatMap((c) => (c.beforeRange === null ? [] : [c.beforeRange]));
        const matchedRules = [
          ...new Set(
            checked.diagnostics
              .filter((d) =>
                hitLines.some((r) => d.range.start.line >= r.start.line && d.range.start.line <= r.end.line),
              )
              .map((d) => d.ruleId),
          ),
        ].sort();

        const changes = diff.changes.map((c) => ({ before: c.before, after: c.after, headingPath: c.headingPath }));
        let isRevision: number | null = null;
        let category: string | null = null;
        let categoryConfidence: number | null = null;
        if (judge !== null && opts.dryRun !== true) {
          const c = await classifyFeedback(rev.feedback, changes, judge, opts.config, new AbortController().signal);
          if (c.kind === 'not-revision') {
            seenKeys.add(key);
            skippedNotRevision++;
            continue;
          }
          if (c.kind === 'revision') {
            isRevision = c.isRevision;
            category = c.category;
            categoryConfidence = c.categoryConfidence;
          }
        }

        seenKeys.add(key);
        records.push({
          id: `fb_${ulid(Date.parse(rev.ts) || Date.now())}`,
          agent: adapter.agent,
          sessionId: rev.sessionId,
          promptId: rev.promptKey,
          ts: rev.ts,
          project: project.root,
          file: relFile,
          docType: checked.docType,
          feedback: rev.feedback,
          isRevision,
          category,
          categoryConfidence,
          changes,
          matchedRules,
          missed: matchedRules.length === 0,
        });
      }

      nextState.files[file.path] = { offset: file.size, size: file.size, mtimeMs: file.mtimeMs };
    }
  }

  let backfilled = 0;
  if (opts.dryRun !== true) {
    if (judge !== null) backfilled = await backfill(env, judge, opts.config);
    for (const r of records) appendLine(dataPaths.feedback(env), JSON.stringify(r));
    writeFileAtomic(dataPaths.minerState(env), `${JSON.stringify(nextState, null, 2)}\n`);
  }

  return { status: 'ok', transcriptsSeen: seen, transcriptsScanned: scanned, records, skippedRewrite, skippedDuplicate, skippedNotRevision, backfilled };
}
