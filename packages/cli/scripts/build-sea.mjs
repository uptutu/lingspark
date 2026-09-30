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
// Usage: node scripts/build-sea.mjs [--stamp <script>]
//
//   --stamp <script>  run `node <script> <exe>` on the copy of node.exe before
//                     the blob goes in. The Windows client uses it to write its
//                     icon and version (D-074); it has to happen here, because
//                     after postject relocates .rsrc a PE editor no longer
//                     finishes on this file.

import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version: pkgVersion } = JSON.parse(readFileSync(path.join(pkg, 'package.json'), 'utf8'));
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
// postject is plain JavaScript, so it runs under this Node rather than through
// the .cmd shim pnpm writes into .bin/: on Windows that shim can only be
// launched with shell:true, and passing an argument list that way is deprecated
// (DEP0190) and quoted by concatenation rather than escaping. Same program,
// no shell, and the same code path on all three platforms.
const postject = path.join(pkg, 'node_modules', 'postject', 'dist', 'cli.js');

// The fuse string is fixed by Node; it marks where the blob goes.
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

// Optional pre-injection step, see the header.
const stampAt = process.argv.indexOf('--stamp');
const stamp = stampAt >= 0 ? process.argv[stampAt + 1] : undefined;
if (stampAt >= 0 && stamp === undefined) {
  console.error('--stamp 后面要给一个脚本的路径。');
  process.exit(1);
}

// No shell: everything below is a real executable (this Node, or codesign and
// strip on Mac), and a shell would only add quoting to reason about.
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });

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

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Windows refuses to delete a file that is running, and on Windows this program
// is also the client (D-074): double-clicking the exe in sea/ opens the setup
// page, so the leftover from the last build is regularly the very thing holding
// the next one up. Nothing retries its way out of a program that is genuinely
// still open -- but a process we just killed, and the virus scanner reading a
// freshly written 90 MB binary, both let go within a second or two, and those
// must not be reported as "you left the client open". So wait it out first and
// blame the running program only when waiting has not helped.
const removeOut = () => {
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(out, { force: true });
      return;
    } catch (err) {
      if (err.code !== 'EPERM' && err.code !== 'EBUSY') throw err;
      if (attempt >= 20) {
        console.error(`删不掉 ${out}：它正在运行。`);
        console.error('  Windows 不让构建覆盖正在运行的程序，重试多少次都没用。');
        console.error('  这个程序就是客户端（D-074）——把它关掉再构建。');
        process.exit(1);
      }
      sleep(250);
    }
  }
};
removeOut();
copyFileSync(process.execPath, out);
chmodSync(out, 0o755);

// Before injection, while .rsrc is still the one node.exe shipped with.
if (stamp !== undefined) run(process.execPath, [path.resolve(stamp), out]);

// A signed binary cannot be modified in place; strip, inject, re-sign ad hoc.
// Real signing and notarisation happen in the release pipeline (M5).
if (isMac) run('codesign', ['--remove-signature', out]);
// Node ships with its local debugging symbols: a quarter of the file, and
// nothing a user ever needs. Exported symbols stay (D-061).
if (isMac) run('strip', ['-x', out]);

run(process.execPath, [
  postject,
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

// Smoke test: the binary must run with nothing but itself -- and it must be
// *our* program, not bare node. A copy of node.exe whose blob never landed
// starts perfectly well and cheerfully prints node's own version, so "it ran"
// proves nothing on its own; comparing the version it reports is what actually
// proves the injection landed. A build that ships such a file looks fine right
// up until a user double-clicks it and gets no client.
const version = execFileSync(out, ['--version'], { encoding: 'utf8' }).trim();
if (version !== pkgVersion) {
  console.error(`注入之后 ${out} 自称版本 ${version}，不是 ${pkgVersion}。`);
  console.error('  这个文件是 node.exe 本身：SEA 的 blob 没进去，别拿它当客户端发出去。');
  process.exit(1);
}
const mb = (statSync(out).size / 1024 / 1024).toFixed(1);
console.log(`lingspark ${version} -> ${path.relative(process.cwd(), out)} (${mb} MB)`);
