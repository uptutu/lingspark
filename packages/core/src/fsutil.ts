import { randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Writes a file so that a reader never sees it half-written: write to a
 * sibling temp file, then rename over the target (design doc, section 5.4).
 *
 * Rename is atomic on the same filesystem on both macOS and Windows, which is
 * why the temp file lives next to the target rather than in the OS temp dir.
 *
 * An existing file keeps its permissions. The temp file would otherwise come
 * out with the default ones, and a config its owner kept private -- WorkBuddy
 * keeps settings.json at 0600 -- would quietly become readable by everyone.
 */
export function writeFileAtomic(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  let mode: number | undefined;
  try {
    mode = statSync(file).mode & 0o777;
  } catch {
    // a new file: default permissions
  }
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, content, { encoding: 'utf8', ...(mode !== undefined ? { mode } : {}) });
    // The umask can narrow what writeFileSync's mode asked for; set it outright.
    if (mode !== undefined) chmodSync(tmp, mode);
    renameSync(tmp, file);
  } catch (err: unknown) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** Appends one line, creating the directory if needed. */
export function appendLine(file: string, line: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, line.endsWith('\n') ? line : `${line}\n`, 'utf8');
}

/** Reads and parses JSON; null when missing or unparsable. */
export function readJsonOrNull(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch {
    return null;
  }
}
