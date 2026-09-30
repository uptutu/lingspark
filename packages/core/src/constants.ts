/**
 * Global constants from the design doc, section 3.
 *
 * These are defaults. Anything listed here may be overridden by user or
 * project configuration; nothing else in the codebase may hard-code these
 * numbers.
 */

/** Probability at or above which a judge answer becomes a diagnostic. */
export const T_REPORT = 0.7;

/**
 * Probabilities in [T_LOW, T_REPORT) are "uncertain": not reported, but
 * eligible for the Pass 4 escalation review.
 */
export const T_LOW = 0.4;

/** Internal time budget for the PostToolUse hook, in milliseconds. */
export const HOOK_BUDGET_POST_MS = 8_000;

/** Internal time budget for the Stop hook, in milliseconds. */
export const HOOK_BUDGET_STOP_MS = 60_000;

/**
 * Wall-clock ceiling for the no-op path (a write to a file we do not check),
 * process startup included. This is the constraint that drives the packaging
 * choice; see DECISIONS.md.
 */
export const HOOK_NOOP_MS = 150;

/** Maximum diagnostics fed back to the model in one hook response. */
export const MAX_FEEDBACK_DIAGNOSTICS = 10;

/**
 * After a diagnostic with the same fingerprint recurs this many times in one
 * session, it stops blocking: the model evidently cannot fix it, which is a
 * signal the rule may be a false positive.
 */
export const LOOP_GUARD_REPEAT = 3;

/** Upper bound on claim pairs compared in Pass 3 for a single document. */
export const MAX_CLAIM_PAIRS = 200;

/** Upper bound on questions batched into a single judge request. */
export const MAX_QUESTIONS_PER_REQUEST = 20;

/** Files above this size run Pass 0 and Pass 1 only. */
export const MAX_FULL_CHECK_BYTES = 200 * 1024;

/** Hook timeouts written into agent config, in seconds (section 5.4). */
export const HOOK_TIMEOUT_POST_S = 15;
export const HOOK_TIMEOUT_STOP_S = 90;

/**
 * How long the client waits for an agent's hook command when it runs it once
 * itself to see whether it works (D-077). Generous, because a single-file
 * build is a whole Node runtime starting up; the client only does this once
 * per install, never while the page is being clicked around.
 */
export const PROBE_TIMEOUT_MS = 10_000;

/** Process exit codes for `lingspark check` (section 5.1). */
export const EXIT_OK = 0;
export const EXIT_HAS_ERRORS = 1;
/** The blocking exit code both agents understand for hooks (section 5.3). */
export const EXIT_HOOK_BLOCK = 2;
export const EXIT_INTERNAL_ERROR = 3;
