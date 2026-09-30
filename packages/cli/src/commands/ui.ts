import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { dataDir, EXIT_OK, msg, refreshInstall, startSetupServer } from '@lingspark/core';
import { builtinRuleSources } from '@lingspark/rules-builtin';

interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
}

/** Opens a URL in the default browser. The URL is ours and has no `&`, so `start` is safe. */
function openBrowser(url: string): boolean {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * The Mac client's window is a thin shell around this page (D-061). It starts
 * `lingspark ui --window`, reads the address from the one line printed, and
 * shows it. The shell holds our stdin open; when it goes away, so do we.
 */
function serveWindow(url: string, io: Io, close: () => void): void {
  io.out(`LINGSPARK_URL ${url}\n`);
  process.stdin.on('end', close);
  process.stdin.on('error', close);
  process.stdin.resume();
}

/** Edge, which every Windows 10 and 11 has, can show a page as a window of its own. */
function edgePath(): string | null {
  const roots = [process.env['ProgramFiles(x86)'], process.env['ProgramFiles'], process.env['LOCALAPPDATA']];
  for (const root of roots) {
    if (root === undefined) continue;
    const exe = path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe');
    if (existsSync(exe)) return exe;
  }
  return null;
}

/**
 * On Windows the page opens as an Edge app window: no tabs, no address bar,
 * and a profile of its own, so the process we start is that window and its
 * exit means the window was closed.
 */
function openEdgeWindow(url: string, close: () => void): ChildProcess | null {
  const edge = edgePath();
  if (edge === null) return null;
  try {
    const child = spawn(
      edge,
      [
        `--app=${url}`,
        `--user-data-dir=${path.join(dataDir(), 'window')}`,
        '--window-size=336,440',
        '--no-first-run',
        '--no-default-browser-check',
      ],
      { stdio: 'ignore' },
    );
    child.on('error', close);
    child.on('exit', close);
    return child;
  } catch {
    return null;
  }
}

/**
 * `lingspark ui`, and what a double-click on the program does: the setup page
 * in the browser -- on Windows in a window of its own -- served until the user
 * clicks "done", closes it, or leaves it idle.
 */
export async function runUi(argv: string[], io: Io): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { 'no-open': { type: 'boolean', default: false }, window: { type: 'boolean', default: false } },
  });
  const shell = values.window === true;
  // A new version of the app: connected agents move to it too.
  refreshInstall();
  const server = await startSetupServer({
    cwd: shell ? homedir() : process.cwd(),
    builtinRules: builtinRuleSources,
    // A window is the session; it does not idle out while open.
    ...(shell ? { idleMs: 7 * 24 * 60 * 60_000 } : {}),
  });
  const close = (): void => server.close();
  let edge: ChildProcess | null = null;
  if (shell) {
    serveWindow(server.url, io, close);
  } else if (values['no-open'] === true) {
    io.out(`${msg.setup.uiNoBrowser(server.url)}\n`);
  } else if (process.platform === 'win32' && (edge = openEdgeWindow(server.url, close)) !== null) {
    io.out(`${msg.setup.uiWindow}\n`);
  } else {
    const opened = openBrowser(server.url);
    io.out(`${opened ? msg.setup.uiOpening(server.url) : msg.setup.uiNoBrowser(server.url)}\n`);
  }
  await server.closed;
  // "完成" on the page: the window goes too.
  if (edge !== null && edge.exitCode === null) edge.kill();
  if (shell) process.stdin.destroy();
  else io.out(`${msg.setup.done}\n`);
  return EXIT_OK;
}
