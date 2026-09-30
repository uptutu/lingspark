// The Windows client's build inputs (D-080), checked here rather than in
// packages/*/src/**/*.test.ts (vitest only collects there).
// Run: node packages/desktop/scripts/lib/win-shell.test.mjs
//
// What is worth testing without building anything: the installer's layout (the
// two programs have to land where the shell looks for each other, and every
// file has to be removed again), and the contract the shell keeps with the
// command-line program -- a C# file and a TypeScript one that only meet over
// one printed line and one exit code.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { windowsNsi } from './installer.mjs';
import { webview2Sdk } from './webview2.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..', '..');
const shellSource = readFileSync(path.join(desktop, 'src', 'win', 'LingSpark.cs'), 'utf8');
const uiSource = readFileSync(path.resolve(desktop, '..', 'cli', 'src', 'commands', 'ui.ts'), 'utf8');
const nsi = windowsNsi({
  setup: 'C:\\build\\lingspark-0.1.0-win-x64-setup.exe',
  sea: 'C:\\build\\cli\\sea\\lingspark.exe',
  client: 'C:\\build\\work\\client',
  icon: 'C:\\build\\work\\icon.ico',
});

let checks = 0;
const check = (name, fn) => {
  fn();
  checks++;
  console.log(`  ok  ${name}`);
};

console.log('windows client build');

check('the installer starts with a BOM, or the Chinese in it is mojibake', () => {
  assert.equal(nsi.codePointAt(0), 0xfeff);
});

check('puts the command-line program and the client where the shell looks', () => {
  // The shell reads ../../lingspark.exe from its own directory, so the two must
  // not end up in the same folder: on a Windows disk "LingSpark.exe" and
  // "lingspark.exe" are one name.
  const lines = nsi.split('\n').map((l) => l.trim());
  const at = (needle) => lines.findIndex((l) => l === needle);
  const cli = at('SetOutPath "$INSTDIR"');
  const client = at('SetOutPath "$INSTDIR\\client"');
  assert.ok(cli >= 0, 'the command-line program has an output directory');
  assert.ok(client > cli, 'the client is installed after it');
  assert.equal(lines[cli + 1], 'File "C:\\\\build\\\\cli\\\\sea\\\\lingspark.exe"');
  assert.equal(lines[client + 1], 'File "C:\\\\build\\\\work\\\\client\\\\LingSpark.exe"');
});

check('ships the WebView2 runtime files next to the client', () => {
  for (const name of ['LingSpark.exe', 'Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll']) {
    assert.ok(nsi.includes(`File "C:\\\\build\\\\work\\\\client\\\\${name}"`), `installs ${name}`);
    assert.ok(nsi.includes(`Delete "$INSTDIR\\client\\${name}"`), `removes ${name}`);
  }
  assert.ok(nsi.includes('RMDir "$INSTDIR\\client"'));
});

check('every shortcut opens the client, not the command-line program', () => {
  const shortcuts = nsi.split('\n').filter((l) => l.trim().startsWith('CreateShortcut'));
  assert.equal(shortcuts.length, 3);
  for (const line of shortcuts) {
    assert.match(line, /"\$INSTDIR\\client\\LingSpark\.exe"/, line);
    // The icon is the third argument; a shortcut pointing into work/ would keep
    // a blank icon once the build cleans that directory up (D-074).
    assert.ok(!line.includes('work\\client'), line);
  }
});

check('the shell and the CLI agree on the one line that carries the address', () => {
  assert.ok(uiSource.includes('`LINGSPARK_URL ${url}\\n`'), 'the CLI prints the marker');
  assert.ok(shellSource.includes('private const string UrlMarker = "LINGSPARK_URL "'), 'the shell reads the same marker');
});

check('the shell starts the server the way the Mac shell does, and holds its input', () => {
  assert.match(shellSource, /new ProcessStartInfo\(cli, "ui --window"\)/);
  // Whoever goes first, the other one follows: the shell closing ends the
  // service, and the service going away closes the window.
  assert.match(shellSource, /server\.StandardInput\.Close\(\)/);
  assert.match(shellSource, /server\.Exited \+= delegate/);
  assert.match(uiSource, /process\.stdin\.on\('end', close\)/);
});

check('the shell tells the page it is in a window, so the page draws no bar of its own', () => {
  // Same as the Edge application window it replaces, so the page needs no new
  // way to know (D-075).
  assert.match(shellSource, /"&\+window=1"|\?window=1"/);
});

check('the build can ask the client whether it works, and the answer is an exit code', () => {
  assert.match(shellSource, /Array\.IndexOf\(args, "--check"\)/);
  assert.match(shellSource, /return NoRuntime;/);
  assert.match(shellSource, /return NoCli;/);
});

check('the window brings the icon that was stamped into the program', () => {
  // The title bar, the task bar and the tray draw the window's icon, not the
  // file's: a form with none of its own falls back to the system application
  // icon, which is a white window in four colours. rcedit's star was in the
  // program all along and nothing ever read it back out (D-082); D-096 parks
  // the same star in the tray.
  assert.match(shellSource, /Icon\.ExtractAssociatedIcon\(Application\.ExecutablePath\)/);
  assert.match(shellSource, /form\.Icon = star/);
  assert.match(shellSource, /tray\.Icon = star/);
  // Leaving it unset has to be survivable: a program with no icon still opens.
  assert.match(shellSource, /catch \(Exception\)\s*\{\s*\/\/ A program with no icon/);
});

check("the window's own title bar is painted in the dark the page is drawn in", () => {
  // 20 from Windows 10 2004 on, 19 on the 1809-1903 builds that answer to
  // nothing else; both tried, so one Windows does not get to decide for the
  // other, and a build that knows neither keeps the title bar it came with.
  assert.match(shellSource, /DwmSetWindowAttribute\(window, 20, ref dark, 4\) != 0\)/);
  assert.match(shellSource, /DwmSetWindowAttribute\(window, 19, ref dark, 4\)/);
  // The switch alone only turns the caption dark grey. The page behind it is
  // #000000, so on Windows 11 the caption is painted that same black (D-082).
  assert.match(shellSource, /DwmSetWindowAttribute\(window, 35, ref black, 4\)/);
  // Asked when the handle appears, so no white bar is seen turning dark.
  assert.match(shellSource, /form\.HandleCreated \+= delegate \{ DarkenTitleBar\(form\); \};/);
});

check('the window is a fixed size: no maximize button, no dragging it bigger', () => {
  // The page is one 336x440 card (D-075); enlarging shows nothing. A sizable
  // border with MaximizeBox=false leaves a greyed-out button that reads as
  // broken (D-082), so the size is fixed by the frame itself instead (D-096):
  // the button is not drawn, and the frame cannot be dragged.
  assert.match(shellSource, /form\.FormBorderStyle = FormBorderStyle\.FixedSingle/);
  assert.match(shellSource, /form\.MaximizeBox = false;/);
  assert.ok(!/form\.FormBorderStyle = FormBorderStyle\.Sizable/.test(shellSource), 'not resizable');
});

check('closing or minimizing parks the window in the tray, running in the background', () => {
  // Not a task-bar minimize (D-083, revised): the window leaves the screen
  // entirely -- no task-bar entry, server keeps running. The user asked for
  // exactly this: a client that lives in the tray (D-096).
  assert.match(shellSource, /new NotifyIcon/);
  assert.match(shellSource, /form\.Hide\(\)/);
  assert.match(shellSource, /form\.ShowInTaskbar = false/);
  // Born invisible: without this line the icon exists for the whole session
  // and never shows -- shipped exactly that way once (D-097).
  assert.match(shellSource, /tray\.Visible = true;/);
  // Only a close the user asked for is intercepted; the programmatic closes
  // (self-test, server exit, Application.Exit) must keep their old path.
  assert.match(shellSource, /e\.CloseReason == CloseReason\.UserClosing/);
  assert.match(shellSource, /e\.Cancel = true;/);
  // ...and there has to be a real way out: the tray's own "退出".
  assert.match(shellSource, /allowClose = true;/);
  assert.match(shellSource, /Application\.Exit\(\);/);
});

check('a second launch brings the hidden window back through the tray owner', () => {
  // Hide() takes the window out of the task bar, so ShowWindow from the second
  // instance cannot fully restore it; the running instance has to do it
  // itself, woken by a named event the second instance pokes (D-096).
  assert.match(shellSource, /EventWaitHandle\.OpenExisting\(ShowSignal\)\.Set\(\)/);
  assert.match(shellSource, /new EventWaitHandle\(false, EventResetMode\.AutoReset, ShowSignal\)/);
  assert.match(shellSource, /RestoreFromTray\(form\)/);
});

check('the tray menu drives the same API the page does: agent switches and status', () => {
  // Right-clicking the star has to show the page's own switches and states,
  // not a second, dumber source of truth (D-098). Every route here is one the
  // page calls; the token is the one the server printed in its address.
  assert.match(shellSource, /Post\("\/api\/state"/);
  assert.match(shellSource, /"\/api\/agent"/);
  assert.match(shellSource, /\/api\/enable-all/);
  assert.match(shellSource, /\/api\/disable-all/);
  assert.match(shellSource, /x-lingspark-token/);
  // The token comes from the ?t= of the printed address.
  assert.match(shellSource, /&\)t=\(\[\^&\]\+\)/);
  // A row click flips the switch the way the page does: {id, on}.
  assert.ok(
    shellSource.includes('"{\\"id\\":\\"" + id + "\\",\\"on\\":'),
    'the toggle body is the page\'s own {id, on} shape',
  );
  // The state the menu shows is polled, and only one question is in flight.
  assert.match(shellSource, /ThreadPool\.QueueUserWorkItem/);
  assert.match(shellSource, /poll\.Tick \+= delegate/);
});

check('the manifest has no comments: Windows refuses to load one', () => {
  // A manifest with an XML comment in it fails at launch with "side-by-side
  // configuration is incorrect", which is a miserable half hour if you have not
  // heard of it. The explanation for it lives in scripts/build-windows.mjs.
  const manifest = readFileSync(path.join(desktop, 'src', 'win', 'app.manifest'), 'utf8');
  assert.ok(!manifest.includes('<!--'), 'no XML comment in app.manifest');
  assert.match(manifest, /dpiAwareness/);
  assert.match(manifest, /supportedOS/);
});

check('the WebView2 SDK is pinned together with its hash', () => {
  assert.match(webview2Sdk.version, /^\d+(\.\d+)+$/);
  assert.equal(webview2Sdk.sha512.length, 88, 'base64 of a 512-bit hash');
  assert.ok(webview2Sdk.files.some((f) => f.endsWith('WebView2Loader.dll')));
  // net462 is not a preference: the compiler that ships in Windows is C# 5 and
  // the machine may have nothing but the .NET Framework.
  assert.ok(
    webview2Sdk.files.filter((f) => f.endsWith('.dll') && !f.includes('WebView2Loader')).every((f) => f.includes('net462')),
    'only the .NET Framework assemblies',
  );
});

console.log(`\n${String(checks)} checks passed`);
