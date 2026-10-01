import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeFileAtomic } from '../fsutil.js';
import { agentConfigFile, agentProfile, type AgentId, type InstallScope } from '../agents.js';
import { log } from '../log.js';
import { msg } from '../messages.js';
import { dataDir, type PathEnv } from '../paths.js';
import { withHooksInstalled, withHooksRemoved, type HookCommand } from './merge.js';

export type { InstallScope } from '../agents.js';

/** A problem that must stop install before anything is written. */
export class InstallError extends Error {
  override readonly name = 'InstallError';
}

/**
 * Where an agent keeps its hook configuration (design doc, 5.6).
 *
 * Refuses agents whose hook contract has not been verified from the vendor's
 * own documentation: writing a config format we have only heard about could
 * break the user's agent (D-030).
 */
export function configFileFor(
  agent: AgentId,
  scope: InstallScope,
  where: { homedir?: string; projectDir?: string } = {},
): string {
  const profile = agentProfile(agent);
  if (profile === undefined) throw new InstallError(msg.install.unknownAgent(agent));
  if (profile.verification !== 'docs') throw new InstallError(msg.install.unverifiedAgent(profile.name, profile.source));
  const file = agentConfigFile(profile, scope, {
    homedir: where.homedir ?? os.homedir(),
    projectDir: where.projectDir ?? process.cwd(),
  });
  if (file === null) throw new InstallError(msg.install.unverifiedAgent(profile.name, profile.source));
  return file;
}

const quote = (p: string): string => {
  if (p.includes('"')) throw new InstallError(msg.install.quoteInPath(p));
  return `"${p}"`;
};

/**
 * The command that runs this lingspark, by absolute path (design doc, 5.6: no
 * reliance on PATH, no shell-specific syntax, paths with spaces quoted).
 *
 * Under a single-executable build `argv[1]` is the executable itself; under
 * `node lingspark.cjs` it is the script, and both paths go into the command.
 */
export function currentHookCommand(
  execPath: string = process.execPath,
  scriptPath: string | undefined = process.argv[1],
): HookCommand {
  const exe = path.resolve(execPath);
  const script = scriptPath === undefined ? undefined : path.resolve(scriptPath);
  const cmd = script === undefined || script === exe ? quote(exe) : `${quote(exe)} ${quote(script)}`;
  // Built on the platform it will run on, so the paths are already native.
  return { posix: cmd, windows: cmd };
}

/** Where `install` keeps the copy of lingspark that hooks run. */
export function installedBinaryDir(env?: PathEnv): string {
  return path.join(dataDir(env), 'bin');
}

/**
 * The paths the installed copy lives at, for the running program. A
 * single-file build is copied as one executable; a `node lingspark.cjs` run
 * copies the script and keeps using the same node.
 */
function installedPaths(execPath: string, scriptPath: string | undefined, env?: PathEnv): { exe: string; script?: string } {
  const exe = path.resolve(execPath);
  const script = scriptPath === undefined ? undefined : path.resolve(scriptPath);
  const dir = installedBinaryDir(env);
  if (script === undefined || script === exe) {
    return { exe: path.join(dir, process.platform === 'win32' ? 'lingspark.exe' : 'lingspark') };
  }
  return { exe, script: path.join(dir, 'lingspark.cjs') };
}

/** Whether two files hold the same bytes; false when either cannot be read. */
function sameContent(a: string, b: string): boolean {
  try {
    if (statSync(a).size !== statSync(b).size) return false;
    const hash = (f: string): string => createHash('sha256').update(readFileSync(f)).digest('hex');
    return hash(a) === hash(b);
  } catch {
    return false;
  }
}

/** The hook command `install` would write, without copying anything. */
export function installedHookCommand(
  execPath: string = process.execPath,
  scriptPath: string | undefined = process.argv[1],
  env?: PathEnv,
): HookCommand {
  const p = installedPaths(execPath, scriptPath, env);
  return currentHookCommand(p.exe, p.script ?? p.exe);
}

/**
 * Copies the running lingspark to a fixed place and returns the command that
 * runs the copy (DECISIONS D-033).
 *
 * Hooks must not point into a build directory: rebuilding wipes it, and the
 * hook then fails silently -- which is exactly what happened to the first
 * real install, and what `doctor` caught. The copy is replaced atomically,
 * so a hook that fires mid-install runs either the old or the new version,
 * never half a file.
 *
 * A copy that cannot be replaced is not a reason to refuse the install
 * (D-077). Windows will not replace a program that is running right now, and
 * the copy hooks run *is* that program whenever an agent is mid-turn -- which
 * on Windows is exactly when a person is most likely to be in the client. The
 * old copy still works, so it keeps the hooks and the new version arrives
 * with the next install that finds the file free. Only a machine with no copy
 * at all has nothing to fall back to, and that still fails.
 */
export function installBinary(
  execPath: string = process.execPath,
  scriptPath: string | undefined = process.argv[1],
  env?: PathEnv,
): HookCommand {
  const exe = path.resolve(execPath);
  const script = scriptPath === undefined ? undefined : path.resolve(scriptPath);
  const target = installedPaths(execPath, scriptPath, env);
  const source = target.script !== undefined ? script : exe;
  const dest = target.script ?? target.exe;
  if (source === undefined) throw new InstallError(msg.install.noSource);
  if (path.resolve(source) !== path.resolve(dest) && !sameContent(source, dest)) {
    mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.${String(process.pid)}.tmp`;
    try {
      copyFileSync(source, tmp);
      chmodSync(tmp, 0o755);
      renameSync(tmp, dest);
    } catch (err: unknown) {
      rmSync(tmp, { force: true });
      if (existsSync(dest)) {
        log('warn', msg.install.copyKept(dest, String(err)), env);
        return installedHookCommand(execPath, scriptPath, env);
      }
      throw new InstallError(msg.install.copyFailed(dest, String(err)));
    }
  }
  return installedHookCommand(execPath, scriptPath, env);
}

/** The indentation a JSON file already uses, so a rewrite keeps its look. */
function detectIndent(text: string): string | number {
  const m = /^[ \t]+(?=")/mu.exec(text);
  return m?.[0] ?? 2;
}

export interface ConfigChange {
  readonly file: string;
  readonly existed: boolean;
  readonly before: string;
  readonly after: string;
  readonly changed: boolean;
}

export function planChange(file: string, transform: (config: unknown) => unknown): ConfigChange {
  let before = '';
  let existed = true;
  try {
    before = readFileSync(file, 'utf8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new InstallError(msg.install.unreadable(file, String(err)));
    }
    existed = false;
  }

  let config: unknown = {};
  if (before.trim() !== '') {
    try {
      config = JSON.parse(before);
    } catch (err: unknown) {
      // Never overwrite a file we cannot read. It may be hand-edited, it may
      // be a format we do not know, and a backup does not make clobbering it
      // acceptable.
      throw new InstallError(msg.install.notJson(file, String(err)));
    }
    if (config === null || typeof config !== 'object' || Array.isArray(config)) {
      throw new InstallError(msg.install.notObject(file));
    }
  }

  const next = transform(config);
  const after = `${JSON.stringify(next, null, detectIndent(before))}\n`;
  // Compare meaning, not text: a no-op must not rewrite (or create) a file
  // just because it would come out with different whitespace.
  const changed = JSON.stringify(config) !== JSON.stringify(next);
  return { file, existed, before, after, changed };
}

export function planInstall(file: string, agent: AgentId, cmd: HookCommand): ConfigChange {
  return planChange(file, (c) => withHooksInstalled(c, agent, cmd));
}

export function planUninstall(file: string): ConfigChange {
  return planChange(file, withHooksRemoved);
}

/** `20260923T101502` in local time: sortable, and legal in file names everywhere. */
function stamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * Writes a planned change, backing up the original first (design doc, 5.6).
 * Returns the backup path, or null when there was nothing to back up.
 */
export function applyChange(change: ConfigChange, now: Date = new Date()): string | null {
  if (!change.changed) return null;
  let backup: string | null = null;
  if (change.existed) {
    // Never overwrite an earlier backup: an install and an uninstall in the
    // same second would otherwise replace the only copy of the original file.
    const base = `${change.file}.lingspark-backup-${stamp(now)}`;
    backup = base;
    for (let n = 1; existsSync(backup); n++) backup = `${base}-${String(n)}`;
    copyFileSync(change.file, backup);
  }
  writeFileAtomic(change.file, change.after);
  return backup;
}

/**
 * A minimal line diff for `--dry-run`: unchanged lines are elided to a little
 * context around each change. Config files are small, so the quadratic LCS is
 * fine.
 */
export function lineDiff(before: string, after: string, context = 2): string {
  const a = before === '' ? [] : before.replace(/\n$/u, '').split('\n');
  const b = after.replace(/\n$/u, '').split('\n');
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      const row = lcs[i] as number[];
      row[j] =
        a[i] === b[j]
          ? ((lcs[i + 1] as number[])[j + 1] ?? 0) + 1
          : Math.max((lcs[i + 1] as number[])[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const ops: { kind: ' ' | '-' | '+'; line: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      ops.push({ kind: ' ', line: a[i] ?? '' });
      i++;
      j++;
    } else if (i < a.length && (j >= b.length || ((lcs[i + 1] as number[])[j] ?? 0) >= ((lcs[i] as number[])[j + 1] ?? 0))) {
      // Removals before additions on a tie, the order a reader expects.
      ops.push({ kind: '-', line: a[i] ?? '' });
      i++;
    } else {
      ops.push({ kind: '+', line: b[j] ?? '' });
      j++;
    }
  }
  const keep = ops.map((_, k) =>
    ops.slice(Math.max(0, k - context), k + context + 1).some((o) => o.kind !== ' '),
  );
  const out: string[] = [];
  let skipped = false;
  ops.forEach((o, k) => {
    if (keep[k] === true) {
      out.push(`${o.kind} ${o.line}`);
      skipped = false;
    } else if (!skipped) {
      out.push('  …');
      skipped = true;
    }
  });
  return out.join('\n');
}
