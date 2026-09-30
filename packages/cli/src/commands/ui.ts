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

/**
 * A browser that can show a page as a window of its own. On Windows this is
 * what the client falls back to when the machine has no WebView2 runtime, and
 * on Linux it is the whole client (D-074 / D-080). Windows and Linux have no
 * one browser to name, so this is a list: the first one installed wins. Windows
 * 10 and 11 always have Edge, so it is always found there.
 */
function browserPath(): string | null {
  const roots =
    process.platform === 'win32'
      ? [process.env['ProgramFiles(x86)'], process.env['ProgramFiles'], process.env['LOCALAPPDATA']]
      : process.platform === 'darwin'
        ? ['/Applications', path.join(homedir(), 'Applications')]
        : // Linux: the usual names, then whatever the alternatives system
          // says -- that is where a non-standard install actually is (D-074).
          ['/usr/bin', '/usr/local/bin', '/opt/google/chrome', '/snap/bin', '/usr/lib/flatpak/exports/bin'];
  const names =
    process.platform === 'win32'
      ? [path.join('Microsoft', 'Edge', 'Application', 'msedge.exe')]
      : process.platform === 'darwin'
        ? [
            path.join('Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
            path.join('Microsoft Edge.app', 'Contents', 'MacOS', 'Microsoft Edge'),
            path.join('Chromium.app', 'Contents', 'MacOS', 'Chromium'),
          ]
        : ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'microsoft-edge', 'brave-browser'];
  for (const name of names) {
    for (const root of roots) {
      if (root === undefined) continue;
      const exe = path.join(root, name);
      if (existsSync(exe)) return exe;
    }
  }
  return process.platform === 'linux' ? linuxBrowserFromAlternatives() : null;
}

/**
 * `update-alternatives` is the one place on Linux that knows where a browser
 * really is, including installs this script would not guess. Read only; if it
 * is not there, the caller falls back to the default browser.
 */
function linuxBrowserFromAlternatives(): string | null {
  const alt = '/etc/alternatives';
  for (const name of ['x-www-browser', 'gnome-www-browser', 'www-browser']) {
    const exe = path.join(alt, name);
    if (existsSync(exe)) return exe;
  }
  return null;
}

/**
 * On Windows and Linux the client is the page in a window of its own -- no
 * tabs, no address bar -- in a profile of its own, so the process we start is
 * that window and its exit means the window was closed. Chromium's `--app` is
 * the same switch Edge honours.
 *
 * On Windows this is the client's fallback: the client is a WebView2 window of
 * its own (D-080) and only asks for this when the machine has no WebView2
 * runtime. Linux has no shell at all, so this is the client there (D-074).
 *
 * `&window=1` is how the page learns it is in that window. The Mac shell says
 * so in its user agent, but nothing sets one here, and the page has to know:
 * it fills the window instead of drawing a 320x400 card, and it leaves off its
 * own title bar -- this window brings one of its own, above the page (D-075).
 */
function openAppWindow(url: string, close: () => void): ChildProcess | null {
  const exe = browserPath();
  if (exe === null) return null;
  const address = `${url}${url.includes('?') ? '&' : '?'}window=1`;
  try {
    const child = spawn(
      exe,
      [
        `--app=${address}`,
        `--user-data-dir=${path.join(dataDir(), 'window')}`,
        // The window is 336x440: the page fills the content area, and what is
        // left of those numbers is the frame and the title bar, whose height
        // is the user's setting, not ours (D-075).
        '--window-size=336,440',
        '--no-first-run',
        '--no-default-browser-check',
        // Edge opens its own welcome page over ours on a fresh profile -- the
        // window title says LingSpark while the body is a sign-in prompt, and
        // the user is left staring at it instead of the setup page. These are
        // Edge's own first-run features; Chromium needs no equivalent, and
        // asking it for ones it does not know is harmless.
        '--disable-features=msEdgeFirstRunExperience,msEdgeWelcomePage,msEdgeSignIn,Translate,OptimizationHints',
        // Nothing here should ever reach the network: the page is a local
        // address, and a background request that stalls would keep the window
        // blank on a slow connection.
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-sync',
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
 * `lingspark ui`, and what a double-click on the command-line program does: the
 * setup page in a window of its own on Windows and Linux, and in the browser
 * elsewhere. Served until the user clicks "done", closes the window, or leaves
 * it idle.
 *
 * The Mac and Windows clients are shells of their own that start this with
 * `--window` and hold its standard input open (D-061 / D-080); on Windows this
 * is also the client's fallback for a machine with no WebView2 runtime, where
 * the shell gets out of the way and lets the line below open the window.
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
  const windowed = process.platform === 'win32' || process.platform === 'linux';
  let app: ChildProcess | null = null;
  if (shell) {
    serveWindow(server.url, io, close);
  } else if (values['no-open'] === true) {
    io.out(`${msg.setup.uiNoBrowser(server.url)}\n`);
  } else if (windowed && (app = openAppWindow(server.url, close)) !== null) {
    io.out(`${msg.setup.uiWindow}\n`);
  } else {
    const opened = openBrowser(server.url);
    io.out(`${opened ? msg.setup.uiOpening(server.url) : msg.setup.uiNoBrowser(server.url)}\n`);
  }
  await server.closed;
  // "完成" on the page: the window goes too.
  if (app !== null && app.exitCode === null) app.kill();
  if (shell) process.stdin.destroy();
  else io.out(`${msg.setup.done}\n`);
  return EXIT_OK;
}
