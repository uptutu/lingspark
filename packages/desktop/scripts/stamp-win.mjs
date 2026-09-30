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
// Usage: node stamp-win.mjs <exe> [rcedit-path]

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, encodeIco } from './lib/icon.mjs';

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(path.join(pkg, 'package.json'), 'utf8'));

const exe = process.argv[2];
if (exe === undefined) {
  console.error('用法：node stamp-win.mjs <exe>');
  process.exit(1);
}

/** rcedit 4.x is a library with no `bin` entry; the executables are in bin/. */
function findRcedit() {
  const given = process.argv[3];
  if (given !== undefined) return given;
  const dir = path.join(pkg, 'node_modules', 'rcedit', 'bin');
  const candidates = [path.join(dir, `rcedit-${process.arch}.exe`), path.join(dir, 'rcedit.exe')];
  return candidates.find((p) => existsSync(p)) ?? null;
}

const rcedit = findRcedit();
if (rcedit === null || !existsSync(rcedit)) {
  console.error(`找不到 rcedit（试过 ${rcedit}）。先在仓库根目录运行 pnpm install。`);
  process.exit(1);
}

const iconPath = path.join(pkg, 'release', 'win-x64', 'work', 'icon.ico');
if (!existsSync(iconPath)) {
  // The .ico is built by build-windows.mjs, which runs this after preparing it.
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
    '--set-version-string', 'FileDescription', 'LingSpark · 灵光 — 给 AI 代理写的中文 Markdown 装一道编译器',
    '--set-version-string', 'InternalName', 'lingspark',
    '--set-version-string', 'OriginalFilename', 'lingspark.exe',
    '--set-version-string', 'LegalCopyright', 'Copyright © 2026 Kepler · Apache-2.0',
    '--set-file-version', version,
    '--set-product-version', version,
  ],
  { stdio: 'inherit' },
);
console.log(`已写入图标和版本信息：${path.basename(exe)} ${version}`);
