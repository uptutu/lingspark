#!/usr/bin/env node
// Builds the single-file executable: the bundled CLI injected into a copy of
// the running Node binary (Node "single executable applications").
//
// Why this and not bun compile or pkg: DECISIONS V-9 / D-006. Measured cold
// start is indistinguishable from bare `node`, it needs nothing beyond Node
// itself, and the one hard constraint -- the entry must be CommonJS -- is
// already how the CLI is bundled.
//
// The binary is for the platform and architecture this script runs on. Cross
// builds happen by running it on each CI runner (macOS arm64/x64, Windows x64).
//
// Usage: node scripts/build-sea.mjs   (after `tsup`)

import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(pkg, 'dist');
const entry = path.join(dist, 'lingspark.cjs');
const blob = path.join(dist, 'sea-prep.blob');
const seaConfig = path.join(dist, 'sea-config.json');
const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
// Its own directory, not dist/: the bundler cleans dist/ on every build, and
// a hook pointing at a file that a rebuild deletes fails silently (D-033).
const seaDir = path.join(pkg, 'sea');
const out = path.join(seaDir, isWin ? 'lingspark.exe' : 'lingspark');
const postject = path.join(pkg, 'node_modules', '.bin', isWin ? 'postject.cmd' : 'postject');

// The fuse string is fixed by Node; it marks where the blob goes.
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit', shell: isWin && cmd.endsWith('.cmd') });

if (!existsSync(entry)) {
  console.error(`找不到 ${entry}，先运行 tsup。`);
  process.exit(1);
}

writeFileSync(
  seaConfig,
  JSON.stringify({ main: entry, output: blob, disableExperimentalSEAWarning: true, useCodeCache: false }, null, 2),
);
run(process.execPath, ['--experimental-sea-config', seaConfig]);

mkdirSync(seaDir, { recursive: true });
rmSync(out, { force: true });
copyFileSync(process.execPath, out);
chmodSync(out, 0o755);

// A signed binary cannot be modified in place; strip, inject, re-sign ad hoc.
// Real signing and notarisation happen in the release pipeline (M5).
if (isMac) run('codesign', ['--remove-signature', out]);
// Node ships with its local debugging symbols: a quarter of the file, and
// nothing a user ever needs. Exported symbols stay (D-061).
if (isMac) run('strip', ['-x', out]);

run(postject, [
  out,
  'NODE_SEA_BLOB',
  blob,
  '--sentinel-fuse',
  FUSE,
  ...(isMac ? ['--macho-segment-name', 'NODE_SEA'] : []),
]);

if (isMac) run('codesign', ['--sign', '-', out]);

rmSync(blob, { force: true });
rmSync(seaConfig, { force: true });

// Smoke test: the binary must run with nothing but itself.
const version = execFileSync(out, ['--version'], { encoding: 'utf8' }).trim();
const mb = (statSync(out).size / 1024 / 1024).toFixed(1);
console.log(`lingspark ${version} -> ${path.relative(process.cwd(), out)} (${mb} MB)`);
