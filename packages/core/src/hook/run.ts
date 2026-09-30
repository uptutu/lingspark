import { noteStillThere, recordIntercepts } from '../intercepts.js';
import { performance } from 'node:perf_hooks';
import {
  EXIT_HOOK_BLOCK,
  EXIT_OK,
  HOOK_BUDGET_POST_MS,
  HOOK_BUDGET_STOP_MS,
  LOOP_GUARD_REPEAT,
} from '../constants.js';
import { createChecker, type Checker, type FileCheckResult } from '../check.js';
import type { Diagnostic } from '../diagnostics/types.js';
import type { Judge } from '../judge/types.js';
import { appendJsonl, log } from '../log.js';
import { msg } from '../messages.js';
import { dataPaths, type PathEnv } from '../paths.js';
import { formatFeedback } from './feedback.js';
import { parseHookInput, type AgentId, type HookEvent, type HookInput } from './input.js';
import { preflight } from './preflight.js';
import { SessionStore } from './session.js';
import { enqueueWarm, waitForWarm, warmRunning } from './warm.js';
import { contentHash, reportPathFor, reviewRequest } from './review.js';

export interface HookDeps {
  readonly builtinRules: readonly { file: string; yaml: string }[];
  readonly pathEnv?: PathEnv;
  /** Replaces the configured judge; tests use a MockJudge. `null` turns Pass 2 off. */
  readonly judge?: Judge | null;
  readonly fetchImpl?: typeof fetch;
  /** Replaces HOOK_BUDGET_STOP_MS; tests shorten it. */
  readonly stopBudgetMs?: number;
}

export interface HookResult {
  readonly exitCode: typeof EXIT_OK | typeof EXIT_HOOK_BLOCK;
  /** Fed to the model when exitCode is 2; otherwise empty. */
  readonly stderr: string;
  /** JSON for agents that read the answer from stdout (Cursor's Stop); absent otherwise. */
  readonly stdout?: string;
  /** The session whose background warm-up the caller should start (D-046, D-050). */
  readonly warmSession?: string;
}

const PASS: HookResult = { exitCode: EXIT_OK, stderr: '' };

/** Time Stop keeps for the checks that need no model after waiting for the warm-up. */
const STOP_RESERVE_MS = 10_000;

/** Saves session state; on failure logs and reports false instead of throwing. */
function trySave(store: SessionStore, env: PathEnv | undefined): boolean {
  try {
    store.save();
    return true;
  } catch (err: unknown) {
    log('error', msg.log.stateSaveFailed(String(err)), env);
    return false;
  }
}

/**
 * Without a turn id there is no way to tell one turn from the next, so Stop
 * may block at most this many times in the whole session. With one, the
 * design doc's "force at most one continuation per turn" applies (D-003).
 */
const MAX_STOP_BLOCKS_WITHOUT_TURN = LOOP_GUARD_REPEAT;

/** Per-file stats line for `stats/runs.jsonl`; the weekly report reads these. */
function recordRun(
  input: HookInput,
  r: FileCheckResult,
  told: readonly Diagnostic[],
  loopGuarded: number,
  env: PathEnv | undefined,
): void {
  const tally = (list: readonly Diagnostic[]): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const d of list) out[d.ruleId] = (out[d.ruleId] ?? 0) + 1;
    return out;
  };
  appendJsonl(dataPaths.runs(env), {
    ts: new Date().toISOString(),
    agent: input.agent,
    event: input.event,
    sessionId: input.sessionId,
    file: r.absPath,
    docType: r.docType,
    passes: r.passesRun,
    hits: tally(r.diagnostics),
    shadow: tally(r.shadowDiagnostics),
    suppressed: r.suppressedCount,
    blocked: told.length,
    // Which problems: the client counts each one once a day, however often
    // it was handed back (after the write, then again at Stop).
    reported: told.map((d) => d.fingerprint),
    loopGuarded,
  });
  // Problems recorded for this file that this check no longer finds were fixed.
  noteStillThere(r.absPath, r.diagnostics, env);
}

/**
 * Applies the loop guard (design doc, 5.4) at Stop: each blocking fingerprint
 * is counted, and one that has now blocked LOOP_GUARD_REPEAT times stops
 * blocking for the rest of the session. The model evidently cannot fix it,
 * which is also the strongest signal a rule has that it is wrong.
 */
function applyLoopGuard(
  store: SessionStore,
  blocking: readonly Diagnostic[],
  env: PathEnv | undefined,
): { kept: Diagnostic[]; guarded: Diagnostic[] } {
  const counts = store.bumpFingerprints(blocking.map((d) => d.fingerprint));
  const kept: Diagnostic[] = [];
  const guarded: Diagnostic[] = [];
  for (const d of blocking) {
    const n = counts[d.fingerprint] ?? 0;
    if (n >= LOOP_GUARD_REPEAT) {
      guarded.push(d);
      if (n === LOOP_GUARD_REPEAT) log('warn', msg.log.loopGuard(d.ruleId, d.fingerprint, n), env);
    } else {
      kept.push(d);
    }
  }
  return { kept, guarded };
}

function makeChecker(
  deps: HookDeps,
  passSet: 'hookPost' | 'hookStop',
  budgetMs: number,
  agent: string,
  skipSlow = passSet === 'hookPost',
): Checker {
  return createChecker({
    agent,
    builtinRules: deps.builtinRules,
    passSet,
    respectScope: true,
    judgeBudgetMs: budgetMs,
    // A judge that takes seconds per call has no place after every write;
    // Stop will ask it (DECISIONS V-10) -- unless the warm-up still is.
    skipSlowJudge: skipSlow,
    ...(deps.pathEnv !== undefined ? { pathEnv: deps.pathEnv } : {}),
    ...(deps.judge !== undefined ? { judge: deps.judge } : {}),
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  });
}

async function checkAll(
  files: readonly string[],
  checker: Checker,
  budgetMs: number,
): Promise<FileCheckResult[]> {
  const started = performance.now();
  const out: FileCheckResult[] = [];
  for (const f of files) {
    // Over budget: use what we have (design doc, 5.3 step 5).
    if (performance.now() - started > budgetMs) break;
    const r = await checker.checkFile(f);
    if (r.skipped === undefined) out.push(r);
  }
  return out;
}

async function onPostToolUse(input: HookInput, files: readonly string[], deps: HookDeps): Promise<HookResult> {
  const env = deps.pathEnv;
  const postChecker = makeChecker(deps, 'hookPost', HOOK_BUDGET_POST_MS, input.agent);
  const results = await checkAll(files, postChecker, HOOK_BUDGET_POST_MS);
  if (results.length === 0) return PASS;

  const store = SessionStore.open(input.sessionId, env);
  store.addFiles(results.map((r) => r.absPath));

  // Queue what was written for the session's background warm-up, so the slow
  // checks Stop runs find their answers already cached (D-046, D-050).
  // With in-session review there is no model to warm up for (D-057).
  const inSession = postChecker.settingsFor(results[0]?.absPath ?? input.cwd).config.judge.backend === 'session';
  const startWarm =
    !inSession &&
    process.env['LINGSPARK_NO_WARM'] !== '1' &&
    enqueueWarm(input.sessionId, results.map((r) => r.absPath), env);
  const warm = startWarm ? { warmSession: input.sessionId } : {};

  // After a write, errors only -- warnings wait for Stop (5.3) -- and only
  // ones this session has not already been told about. A model writing a
  // long document in several edits should hear about an early error once,
  // not after every later edit. The loop guard does not run here: on Claude
  // Code a PostToolUse exit 2 cannot block anything (DECISIONS V-4), so there
  // is no loop to guard, and counting here would spend the guard before Stop
  // -- the real enforcement point -- ever saw the error (DECISIONS D-020).
  // Cursor ignores whatever a file-edit hook says, so there nothing is told
  // now: the errors stay unmarked and Stop reports them.
  if (input.cursor) {
    for (const r of results) recordRun(input, r, [], 0, env);
    trySave(store, env);
    return { ...PASS, ...warm };
  }

  const told = new Set(store.snapshot.postReported);
  const fresh = results.flatMap((r) =>
    r.diagnostics.filter((d) => d.severity === 'error' && !told.has(d.fingerprint)),
  );
  store.markPostReported(fresh.map((d) => d.fingerprint));

  for (const r of results) {
    recordRun(input, r, fresh.filter((d) => d.file === r.absPath), 0, env);
  }
  recordIntercepts(input.agent, 'write', fresh, env);
  // A failed save only costs deduplication: the next write may repeat these
  // errors. The model still hears about them now.
  trySave(store, env);

  if (fresh.length === 0) return { ...PASS, ...warm };
  return {
    exitCode: EXIT_HOOK_BLOCK,
    stderr: formatFeedback(fresh, { cwd: input.cwd, atStop: false, includesWarnings: false }),
    ...warm,
  };
}

async function onStop(input: HookInput, store: SessionStore, deps: HookDeps): Promise<HookResult> {
  const env = deps.pathEnv;
  const turnKey = input.turnId ?? 'session';
  const allowed = input.turnId === null ? MAX_STOP_BLOCKS_WITHOUT_TURN : 1;
  if ((store.snapshot.stopBlocks[turnKey] ?? 0) >= allowed) {
    log('info', msg.log.stopReentry(turnKey), env);
    return PASS;
  }

  // Stop never races the session's background warm-up for the same answers
  // -- every call would be paid twice and both would run slower. While the
  // warm-up runs, Stop waits for it and then reads its answers from the
  // cache, keeping time in hand for the checks that need no model. If the
  // warm-up is still running then, Stop skips the slow checks altogether;
  // the warm-up finishes them and the session's next Stop reports them,
  // the answers cached by then (D-052).
  const t0 = performance.now();
  const budget = deps.stopBudgetMs ?? HOOK_BUDGET_STOP_MS;
  const deadline = t0 + budget - 1_000;
  await waitForWarm(input.sessionId, deadline - STOP_RESERVE_MS, env);
  const warmStill = warmRunning(input.sessionId, env);
  const checker = makeChecker(deps, 'hookStop', budget, input.agent, warmStill);
  const results = await checkAll(store.snapshot.files, checker, Math.max(1_000, deadline - performance.now()));
  if (results.length === 0) return PASS;

  // Then the documents against each other: everything this session wrote,
  // in whatever time is left (DECISIONS D-045, D-050).
  const left = deadline - performance.now();
  const across =
    left > 1_000 && !warmStill
      ? await checker.checkAcross(results.map((r) => r.absPath), {
          focus: true,
          budgetMs: left,
          corpus: store.snapshot.files,
        })
      : null;
  const unfinished = across === null || across.stats.some((s) => s.timedOut);
  const warm =
    unfinished &&
    process.env['LINGSPARK_NO_WARM'] !== '1' &&
    enqueueWarm(input.sessionId, results.map((r) => r.absPath), env)
      ? { warmSession: input.sessionId }
      : {};

  const all = [...results.flatMap((r) => r.diagnostics), ...(across?.diagnostics ?? [])];
  const errors = all.filter((d) => d.severity === 'error');
  const reported = new Set(store.snapshot.reportedWarnings);
  // Each warning is shown once per session, then trusted to the model (5.3).
  const newWarnings = all.filter((d) => d.severity === 'warning' && !reported.has(d.fingerprint));

  const { kept, guarded } = applyLoopGuard(store, errors, env);
  const toReport = [...kept, ...newWarnings];

  for (const r of results) {
    const mine = (list: readonly Diagnostic[]): number => list.filter((d) => d.file === r.absPath).length;
    recordRun(input, r, toReport.filter((d) => d.file === r.absPath), mine(guarded), env);
  }
  recordIntercepts(input.agent, 'stop', toReport, env);

  // In-session review (D-057): the documents whose current content the agent
  // has not reviewed yet, asked for at most once a turn.
  const settings = checker.settingsFor(results[0]?.absPath ?? input.cwd);
  let review = '';
  if (
    settings.config.judge.backend === 'session' &&
    store.snapshot.reviewPending?.turn !== turnKey &&
    // An agent that cannot write the report (plan mode, no write access) is
    // not asked again and again.
    // The request still open counts: three asked in all, then no more.
    store.snapshot.reviewUnanswered + (store.snapshot.reviewPending === null ? 0 : 1) < LOOP_GUARD_REPEAT
  ) {
    const due = results
      .map((r) => r.absPath)
      .filter((f) => {
        const h = contentHash(f);
        return h !== null && store.snapshot.reviewed[f] !== h;
      });
    const rules = [...settings.rules.values()]
      .filter((r) => r.kind === 'judge' && r.status === 'active' && (r.pass === 2 || r.pass === 3))
      .sort((a, b) => a.id.localeCompare(b.id));
    if (due.length > 0 && rules.length > 0) {
      const report = reportPathFor(input.cwd, input.sessionId);
      review = reviewRequest(due, rules, report, input.cwd);
      store.markReviewRequested({ turn: turnKey, files: due, report });
    }
  }

  if (toReport.length === 0 && review === '') {
    trySave(store, env);
    return { ...PASS, ...warm };
  }

  store.markWarningsReported(newWarnings.map((d) => d.fingerprint));
  store.bumpStopBlock(turnKey);
  // Blocking Stop is only safe while the per-turn cap and the loop guard are
  // being recorded. If they cannot be, the next Stop would block again, and
  // again: let the turn end instead (design principle 2).
  if (!trySave(store, env)) return { ...PASS, ...warm };

  const found =
    toReport.length === 0
      ? ''
      : formatFeedback(toReport, { cwd: input.cwd, atStop: true, includesWarnings: newWarnings.length > 0 });
  const text = [found, review].filter((t) => t !== '').join('\n');
  if (input.cursor) return { exitCode: EXIT_OK, stderr: '', stdout: cursorStopReply(input.agent, text), ...warm };
  return { exitCode: EXIT_HOOK_BLOCK, stderr: text, ...warm };
}

/**
 * How Cursor takes Stop feedback: JSON on stdout, exit 0. Its own hooks.json
 * reads `followup_message`; for hooks it imports from Claude Code's settings it
 * maps Claude Code's `decision: "block"` and `reason` to the same follow-up.
 */
function cursorStopReply(agent: AgentId, text: string): string {
  return JSON.stringify(agent === 'cursor' ? { followup_message: text } : { decision: 'block', reason: text });
}

/**
 * Runs the checks for an input that has already passed preflight.
 *
 * Split from `runHook` so the CLI can run the cheap preflight first and only
 * load this module -- and with it the parser and every rule -- when there is
 * something to check.
 */
export async function runHookChecks(
  input: HookInput,
  files: readonly string[],
  store: SessionStore | null,
  deps: HookDeps,
): Promise<HookResult> {
  try {
    if (input.event === 'post-tool-use') return await onPostToolUse(input, files, deps);
    return await onStop(input, store ?? SessionStore.open(input.sessionId, deps.pathEnv), deps);
  } catch (err: unknown) {
    log('error', msg.log.hookFailed(err instanceof Error ? (err.stack ?? err.message) : String(err)), deps.pathEnv);
    return PASS;
  }
}

/**
 * The whole hook, stdin text to exit code (design doc, 5.3).
 *
 * Fail-open is the contract: every path that is not "there is a diagnostic
 * the model must see" returns exit 0, including every exception (5.4).
 */
export async function runHook(raw: string, agent: AgentId, event: HookEvent, deps: HookDeps): Promise<HookResult> {
  try {
    const input = parseHookInput(raw, agent, event);
    if (input === null) {
      log('warn', msg.log.hookBadInput, deps.pathEnv);
      return PASS;
    }
    const pre = preflight(input, deps.pathEnv);
    if (!pre.proceed) return PASS;
    return await runHookChecks(input, pre.files, pre.store, deps);
  } catch (err: unknown) {
    log('error', msg.log.hookFailed(err instanceof Error ? (err.stack ?? err.message) : String(err)), deps.pathEnv);
    return PASS;
  }
}
