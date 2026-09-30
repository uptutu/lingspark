import { appendLine } from './fsutil.js';
import { dataPaths, type PathEnv } from './paths.js';

export type LogLevel = 'info' | 'warn' | 'error';

/**
 * Appends to `logs/lingspark.log`. Never throws.
 *
 * The log is where fail-open failures go (design doc, section 5.4), so the
 * logger itself must not be a way to fail: a read-only data directory must not
 * turn a swallowed error into a crash.
 */
export function log(level: LogLevel, message: string, env?: PathEnv): void {
  try {
    appendLine(
      dataPaths.log(env),
      `${new Date().toISOString()} ${level.toUpperCase()} ${message.replace(/\n/gu, '\\n')}`,
    );
  } catch {
    // Nowhere left to report to.
  }
}

/** Appends a JSON record to a JSONL file. Never throws. */
export function appendJsonl(file: string, record: unknown): void {
  try {
    appendLine(file, JSON.stringify(record));
  } catch {
    // Stats are best-effort; losing one line must not affect the check.
  }
}
