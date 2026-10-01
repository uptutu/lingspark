#!/usr/bin/env node
// Builds the single-file executable: the bundled CLI injected into a copy of
// the running Node binary (Node "single executable applications").
//
// Why this and not bun compile or pkg: DECISIONS V-9 / D-006. Measured cold
// start is indistinguishable from bare `node`, it needs nothing beyond Node
// itself, and the one hard constraint -- the entry must be CommonJS -- is
// already how the CLI is bundled.
//
// The binary is for the platform and architecture this script runs on --
// except on macOS, where it additionally downloads the official Node build
// for the other architecture and merges the two into one universal binary
// with lipo (D-099), so a single .dmg serves Apple silicon and Intel alike.
// Cross builds for Windows/Linux happen by running it on each CI runner.
//
// Usage: node scripts/build-sea.mjs [--stamp <script>]
//
//   --stamp <script>  run `node <script> <exe>` on the copy of node.exe before
//                     the blob goes in. The Windows client uses it to write its
//                     icon and version (D-074); it has to happen here, because
//                     after postject relocates .rsrc a PE editor no longer
//                     finishes on this file.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
// is one users double-click as well as run in a terminal: double-clicking the
// exe in sea/ opens the setup page, so the leftover from the last build is
// regularly the very thing holding the next one up. Nothing retries its way out
// of a program that is genuinely still open -- but a process we just killed,
// and the virus scanner reading a freshly written 90 MB binary, both let go
// within a second or two, and those must not be reported as "you left the
// client open". So wait it out first and blame the running program only when
// waiting has not helped.
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
        console.error('  装好的客户端是另一个程序（client\\LingSpark.exe，D-080），但这个');
        console.error('  文件双击也会开配置页——把它关掉再构建。');
        process.exit(1);
      }
      sleep(250);
    }
  }
};

// A signed binary cannot be modified in place; remove the signature, strip,
// inject, re-sign ad hoc. Real signing and notarisation happen in the release
// pipeline (M5). The codesign/strip steps are mac-only; on Windows .rsrc must
// still be the one node.exe shipped with when --stamp runs, so the stamp
// happens before this and outside it.
const injectBlob = (file) => {
  if (isMac) run('codesign', ['--remove-signature', file]);
  // Node ships with its local debugging symbols: a quarter of the file, and
  // nothing a user ever needs. Exported symbols stay (D-061).
  if (isMac) run('strip', ['-x', file]);
  run(process.execPath, [
    postject,
    file,
    'NODE_SEA_BLOB',
    blob,
    '--sentinel-fuse',
    FUSE,
    ...(isMac ? ['--macho-segment-name', 'NODE_SEA'] : []),
  ]);
  if (isMac) run('codesign', ['--sign', '-', file]);
};

// --- macOS: the other architecture's Node, downloaded once ------------------
// A universal binary needs a slice this machine cannot run. The SEA blob is
// plain JS and architecture-independent; only the base binary differs, and
// node's official per-arch tarballs provide it. Cached under sea/cache/
// (sea/ is gitignored) so only the first build on a machine touches the
// network, and checksummed against node's published SHASUMS256.txt before
// the binary is ever used as a base.

const noNetwork = () => {
  if (process.env.LINGSPARK_NO_NETWORK === '1') {
    console.error('需要联网下载另一架构的 Node，但 LINGSPARK_NO_NETWORK=1。');
    console.error('  清掉这个环境变量再构建，或在联网机器上构建过一次（sea/cache/ 有缓存即可）。');
    process.exit(1);
  }
};

const download = (url, dest) => {
  console.log(`下载 ${url}`);
  run('curl', ['-fsSL', url, '-o', dest]);
};

function verifySha256(file, name) {
  const cache = path.join(seaDir, 'cache');
  const sumsFile = path.join(cache, `SHASUMS256-${process.version}.txt`);
  if (!existsSync(sumsFile)) {
    noNetwork();
    mkdirSync(cache, { recursive: true });
    download(`https://nodejs.org/dist/${process.version}/SHASUMS256.txt`, sumsFile);
  }
  const line = readFileSync(sumsFile, 'utf8')
    .split('\n')
    .find((l) => l.endsWith(` ${name}`));
  const actual = createHash('sha256').update(readFileSync(file)).digest('hex');
  if (!line || line.split(' ')[0] !== actual) {
    console.error(`${name} 的 SHA-256 与 nodejs.org 公布的 SHASUMS256.txt 对不上。`);
    console.error('  删掉 sea/cache/ 里的副本重新下载；若还不对，先别用它构建。');
    process.exit(1);
  }
}

function foreignNode(arch) {
  const base = `node-${process.version}-darwin-${arch}`;
  const dir = path.join(seaDir, 'cache', base);
  const bin = path.join(dir, 'bin', 'node');
  if (existsSync(bin)) return bin;
  const tarball = path.join(seaDir, 'cache', `${base}.tar.gz`);
  if (!existsSync(tarball)) {
    noNetwork();
    mkdirSync(path.join(seaDir, 'cache'), { recursive: true });
    download(`https://nodejs.org/dist/${process.version}/${base}.tar.gz`, tarball);
  }
  verifySha256(tarball, `${base}.tar.gz`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  run('tar', ['-xzf', tarball, '-C', dir]);
  return bin;
}

removeOut();

if (isMac) {
  // One binary, both architectures (D-099): the native slice from this Node,
  // the foreign slice from the official tarball, merged with lipo. The
  // foreign slice is never executed (an arm64 Mac may not even have Rosetta);
  // lipo -info proves it carries the right architecture, and the smoke test
  // below runs the merged binary on its native slice.
  const nativeArch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const foreignArch = nativeArch === 'arm64' ? 'x64' : 'arm64';
  const slices = [];
  for (const arch of [nativeArch, foreignArch]) {
    const slice = path.join(seaDir, `lingspark-${arch}`);
    rmSync(slice, { force: true });
    copyFileSync(arch === nativeArch ? process.execPath : foreignNode(arch), slice);
    chmodSync(slice, 0o755);
    injectBlob(slice);
    const want = arch === 'arm64' ? 'arm64' : 'x86_64';
    const info = execFileSync('lipo', ['-info', slice], { encoding: 'utf8' });
    if (!info.includes(want)) {
      console.error(`切片 ${slice} 的架构对不上：${info.trim()}，应有 ${want}。`);
      process.exit(1);
    }
    slices.push(slice);
  }
  run('lipo', ['-create', ...slices, '-output', out]);
  for (const slice of slices) rmSync(slice, { force: true });
  run('codesign', ['--sign', '-', out]);
} else {
  copyFileSync(process.execPath, out);
  chmodSync(out, 0o755);

  // Before injection, while .rsrc is still the one node.exe shipped with.
  if (stamp !== undefined) run(process.execPath, [path.resolve(stamp), out]);

  injectBlob(out);
}

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
