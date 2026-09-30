#!/usr/bin/env node
// Builds the Windows client: the command-line program, the client's window, one
// installer.
//
// There are two programs in the package, and the client is one of them (D-080):
//
//   lingspark.exe      the command-line program -- hooks, setup, the checks.
//                      Node injected into itself, so it is also a console
//                      program: run it from a terminal.
//   client\LingSpark.exe
//                      the client. A window around the setup page, written in
//                      C# and compiled with the compiler that ships in Windows,
//                      so packaging the client needs no toolchain installed
//                      (D-061's argument: the client is a window, not a browser).
//                      It has no console: double-clicking it opens the page and
//                      nothing else (D-074 left the terminal behind).
//
// The window is ours, which is the whole point: the page used to be shown in an
// Edge application window, so the task bar showed Edge, and the program behind
// it was a console that stayed open next to the client for as long as it was.
// A machine without the WebView2 runtime (Windows 10 without Edge) still gets
// the page, in Edge, the way it did before -- the shell asks the CLI to open it
// and gets out of the way.
//
// What this script adds is therefore three things: the icon and version stamp
// on both programs, the client's window compiled from one .cs file, and an NSIS
// installer that puts the two where the shell expects to find each other.
//
// The command-line program is built here rather than reused, because the icon
// has to be stamped before postject injects the blob: after injection the
// resource section sits where the Authenticode signature was, and a PE editor
// handed that file never finishes (D-074). So this script runs `build-sea.mjs`
// with the stamp hook, then packages whatever came out.
//
// Usage: node scripts/build-windows.mjs   (after `pnpm run build` at the root)

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, encodeIco } from './lib/icon.mjs';
import { windowsNsi } from './lib/installer.mjs';
import { fetchWebview2Sdk, stageWebview2Assemblies } from './lib/webview2.mjs';

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(path.join(pkg, 'package.json'), 'utf8'));
// One directory per platform; see build-linux.mjs for why.
const release = path.join(pkg, 'release', 'win-x64');
const work = path.join(release, 'work');
// The client's own directory, laid out inside the package exactly as the
// installer puts it on disk, so the smoke test below runs the layout a user
// would get.
const clientDir = path.join(work, 'client');
const clientExe = path.join(clientDir, 'LingSpark.exe');
const sea = path.join(pkg, '..', 'cli', 'sea', 'lingspark.exe');
const setup = path.join(release, `lingspark-${version}-win-x64-setup.exe`);

const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit', shell: cmd.endsWith('.cmd') });

if (process.platform !== 'win32') {
  console.error('Windows 客户端只能在 Windows 上构建。');
  process.exit(1);
}

rmSync(release, { recursive: true, force: true });
mkdirSync(clientDir, { recursive: true });

// The icon Explorer shows on the file, in the task bar and in the Start menu:
// the same picture the Mac app uses, packed as an .ico (D-074). Written before
// the stamp step runs, which is where the installer picks it up too.
const iconPath = path.join(work, 'icon.ico');
writeFileSync(iconPath, encodeIco([16, 24, 32, 48, 64, 128, 256], decodePng(readFileSync(path.join(pkg, 'build', 'icon.png')))));

// The command-line program, stamped and injected in one go.
run(process.execPath, [
  path.join(pkg, '..', 'cli', 'scripts', 'build-sea.mjs'),
  '--stamp',
  path.join(pkg, 'scripts', 'stamp-win.mjs'),
]);

if (!existsSync(sea)) {
  console.error(`构建 SEA 之后仍然找不到 ${sea}。`);
  process.exit(1);
}

// The client's window. The C# compiler that ships in Windows is at a fixed
// place, and the 64-bit one is the one that can emit an x64 program; CSC names
// another, the way makensis does, for a machine where it lives elsewhere.
const cscCandidates = () =>
  [
    process.env['CSC'],
    path.join(process.env['SystemRoot'] ?? process.env['WINDIR'] ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(process.env['SystemRoot'] ?? process.env['WINDIR'] ?? 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ].filter((cmd) => cmd);

const csc = cscCandidates().find((cmd) => existsSync(cmd));
if (csc === undefined) {
  console.error('找不到 C# 编译器（csc.exe）。装上 .NET Framework 4.x 之后重试：');
  console.error(`  找过：${cscCandidates().join('  ')}`);
  process.exit(1);
}

const { unpacked } = await fetchWebview2Sdk({ log: (line) => console.log(line) });
const { references } = stageWebview2Assemblies(unpacked, clientDir);

// /target:winexe is the fix for the terminal window D-074 left behind: a
// program built for the console gets one from Explorer before its first line of
// code runs. /codepage:65001 is here because the shell's own source is Chinese
// and the compiler would otherwise read it as this machine's ANSI code page.
// No /win32icon: rcedit writes the icon into the finished program below, the
// same picture and the same step as the command-line program gets.
run(csc, [
  '/nologo',
  '/target:winexe',
  '/platform:x64',
  '/optimize+',
  '/codepage:65001',
  `/win32manifest:${path.join(pkg, 'src', 'win', 'app.manifest')}`,
  `/out:${clientExe}`,
  '/r:System.dll',
  '/r:System.Core.dll',
  '/r:System.Drawing.dll',
  '/r:System.Windows.Forms.dll',
  ...references.map((dll) => `/r:${dll}`),
  path.join(pkg, 'src', 'win', 'LingSpark.cs'),
]);

run(process.execPath, [
  path.join(pkg, 'scripts', 'stamp-win.mjs'),
  clientExe,
  // The task bar shows this program's description when it has no entry of its
  // own, so the client gets the short one: the sentence belongs in the
  // properties window, where there is room for it.
  '--description',
  'LingSpark · 灵光',
]);

// A program without a console has nowhere to report a problem, so the build
// asks it instead: it finds the command-line program, gets a web view out of
// this machine, and answers in its exit code (D-080). Exit 3 -- no WebView2
// runtime here -- is a fact about the build machine, not a broken client: the
// shell falls back to Edge on such a machine, which is what ships.
const check = spawnSync(clientExe, ['--check'], {
  stdio: 'inherit',
  env: { ...process.env, LINGSPARK_CLI: sea },
});
if (check.status === 4) {
  console.error('客户端找不到命令行版 lingspark，构建出来的安装包是坏的。');
  process.exit(1);
}
if (check.status === 3) {
  console.log('这台机器上没有 WebView2 运行时，客户端在用户机器上会退回 Edge 窗口。');
} else if (check.status !== 0) {
  console.error(`客户端自检没有通过（退出码 ${check.status ?? 'null'}）。`);
  process.exit(1);
} else {
  console.log('客户端自检通过：窗口、WebView2、命令行版都在。');
}

// The installer script, written out rather than kept as a checked-in file so
// the version and the paths into work/ cannot drift from this script.
const nsi = path.join(work, 'installer.nsi');
writeFileSync(nsi, windowsNsi({ setup, sea, client: clientDir, icon: iconPath }));

// NSIS is the one build input this script cannot produce itself, and it is
// installed two incompatible ways. `choco install nsis` shims makensis onto
// PATH; the stock installer from nsis.sourceforge.io drops it into Program
// Files and never touches PATH at all. Looking only at MAKENSIS and the bare
// name therefore worked on CI and failed on an ordinary Windows box that had
// NSIS sitting right there. So ask the standard directories too -- harmless
// when they do not exist -- and report where we looked when it still fails.
const makensisCandidates = () =>
  [
    process.env['MAKENSIS'],
    'makensis',
    ...[process.env['ProgramFiles(x86)'], process.env.ProgramFiles]
      .filter((dir) => dir)
      .map((dir) => path.join(dir, 'NSIS', 'makensis.exe')),
    path.join(process.env['LOCALAPPDATA'] ?? '', 'Programs', 'NSIS', 'makensis.exe'),
  ].filter((cmd) => cmd);

const findMakensis = () => {
  const tried = [];
  for (const cmd of makensisCandidates()) {
    try {
      // /VERSION is the cheapest thing makensis does, and running it is the
      // only way to tell a working makensis from a stale path.
      execFileSync(cmd, ['/VERSION'], { stdio: 'ignore' });
      return { cmd, tried };
    } catch {
      tried.push(cmd);
    }
  }
  return { cmd: null, tried };
};

const { cmd: makensis, tried } = findMakensis();
if (!makensis) {
  console.error('找不到 NSIS（makensis）。装上之后重试：');
  console.error('  Windows：winget install NSIS.NSIS  或  choco install nsis');
  console.error('  已经装好了的话，设置 MAKENSIS 指向 makensis.exe 的完整路径。');
  console.error(`  找过：${tried.join('  ')}`);
  process.exit(1);
}
run(makensis, [`/V3`, nsi]);

rmSync(work, { recursive: true, force: true });

const mb = (p) => (statSync(p).size / 1024 / 1024).toFixed(0);
console.log(`LingSpark 安装程序 -> ${path.relative(process.cwd(), setup)} (${mb(setup)} MB)`);
console.log(`装好之后 client\\LingSpark.exe 是客户端，lingspark.exe 是命令行版（${mb(sea)} MB）。`);
console.log('命令行版也可从 Releases 单独下载。');
