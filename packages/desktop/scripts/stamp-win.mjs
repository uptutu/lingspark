#!/usr/bin/env node
// Stamps the Windows client's icon and version into an executable, in place.
//
// The order matters and is the whole reason this is a separate step. rcedit
// has to run on the *un-injected* copy of node.exe: once postject has added
// the SEA blob it relocates .rsrc to where the Authenticode signature was, and
// a PE reader handed that file spins for minutes trying to parse the blob as a
// certificate. Stamped first, the resources are already in .rsrc and postject
// carries them along (D-074).
//
// Usage: node stamp-win.mjs <exe> [--rcedit <path>] [--description <text>]
//
//   --description  what the file properties call it. The task bar falls back to
//                  this when a program has no entry of its own, so the client
//                  passes a short one and the command-line program the long
//                  sentence (D-080). Default: the sentence.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, encodeIco } from './lib/icon.mjs';

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(path.join(pkg, 'package.json'), 'utf8'));

/** Reads `--flag value`, leaving the first bare argument as the executable. */
function parseArgs(argv) {
  const options = { rcedit: undefined, description: 'LingSpark · 灵光 — 给 AI 代理写的中文 Markdown 装一道编译器' };
  let exe;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--rcedit') options.rcedit = argv[++i];
    else if (arg === '--description') options.description = argv[++i];
    else if (arg === undefined) continue;
    else if (exe === undefined) exe = arg;
  }
  if (exe === undefined) {
    console.error('用法：node stamp-win.mjs <exe> [--rcedit <path>] [--description <text>]');
    process.exit(1);
  }
  return { exe, ...options };
}

const { exe, rcedit: givenRcedit, description } = parseArgs(process.argv.slice(2));

/** rcedit 4.x is a library with no `bin` entry; the executables are in bin/. */
function findRcedit(given) {
  if (given !== undefined) return given;
  const dir = path.join(pkg, 'node_modules', 'rcedit', 'bin');
  const candidates = [path.join(dir, `rcedit-${process.arch}.exe`), path.join(dir, 'rcedit.exe')];
  return candidates.find((p) => existsSync(p)) ?? null;
}

const rcedit = findRcedit(givenRcedit);
if (rcedit === null || !existsSync(rcedit)) {
  console.error(`找不到 rcedit（试过 ${rcedit}）。先在仓库根目录运行 pnpm install。`);
  process.exit(1);
}

const iconPath = path.join(pkg, 'release', 'win-x64', 'work', 'icon.ico');
if (!existsSync(iconPath)) {
  // The .ico is built by build-windows.mjs, which runs this after preparing it.
  // Written here only when this is run on its own, so the directory it wants
  // may not be there yet.
  mkdirSync(path.dirname(iconPath), { recursive: true });
  writeFileSync(
    iconPath,
    encodeIco([16, 24, 32, 48, 64, 128, 256], decodePng(readFileSync(path.join(pkg, 'build', 'icon.png')))),
  );
}

// Without a version stamp the file shows "unknown" in Properties and a blank
// tooltip in the Start menu, which is where users first meet it.
execFileSync(
  rcedit,
  [
    exe,
    '--set-icon', iconPath,
    '--set-version-string', 'CompanyName', 'LingSpark',
    '--set-version-string', 'ProductName', 'LingSpark',
    '--set-version-string', 'FileDescription', description,
    '--set-version-string', 'InternalName', 'LingSpark',
    // The client's file is a different program from the command-line one, and
    // Windows shows this in some places where the two must not be confused.
    '--set-version-string', 'OriginalFilename', path.basename(exe),
    '--set-version-string', 'LegalCopyright', 'Copyright © 2026 Kepler · Apache-2.0',
    '--set-file-version', version,
    '--set-product-version', version,
  ],
  { stdio: 'inherit' },
);
console.log(`已写入图标和版本信息：${path.basename(exe)} ${version}`);
