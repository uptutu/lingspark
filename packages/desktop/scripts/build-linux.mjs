#!/usr/bin/env node
// Builds the Linux client: a .deb for Debian/Ubuntu/Mint and a tar.gz for
// everything else.
//
// Like Windows, the program itself is the client (D-074): double-clicking it
// -- here that means the .desktop entry, since an ELF binary has no icon of
// its own -- starts the setup page in a Chromium app window. So the package
// carries the single-file executable, an icon, and a launcher entry; there is
// no window shell to build.
//
// Two packages from one tree because they differ only in how they are packed:
// .deb gets dpkg-deb, which every Debian-family runner already has; tar.gz
// needs nothing at all, so Arch, Fedora and anyone without root can use it.
//
// Usage: node scripts/build-linux.mjs   (after `pnpm build:sea` at the root)

import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, encodePng, resize } from './lib/icon.mjs';

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version, description, author, license } = JSON.parse(readFileSync(path.join(pkg, 'package.json'), 'utf8'));
const sea = path.join(pkg, '..', 'cli', 'sea', 'lingspark');
// One directory per platform. A single shared release/ meant that building for
// one system deleted the other's installer, which is only harmless on CI where
// each platform has its own runner (D-074).
const release = path.join(pkg, 'release', 'linux-x64');
const work = path.join(release, 'work');
const root = path.join(work, 'root');
const deb = path.join(release, `lingspark_${version}_amd64.deb`);
const tarball = path.join(release, `lingspark-${version}-linux-x64.tar.gz`);
// Debian's own version field. The npm version is already SemVer, and dpkg
// accepts a trailing Debian revision after the last hyphen.
const debVersion = version;

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });

if (process.platform !== 'linux') {
  console.error('Linux 客户端只能在 Linux 上构建。');
  process.exit(1);
}
if (!existsSync(sea)) {
  console.error(`找不到 ${sea}，先在仓库根目录运行 pnpm build:sea。`);
  process.exit(1);
}

rmSync(release, { recursive: true, force: true });
mkdirSync(root, { recursive: true });

const icon = decodePng(readFileSync(path.join(pkg, 'build', 'icon.png')));

// The tree both packages share: the program in /usr/bin, the icon where the
// icon theme looks for it, and the launcher in /usr/share/applications.
const bin = path.join(root, 'usr', 'bin');
const share = path.join(root, 'usr', 'share');
const apps = path.join(share, 'applications');
mkdirSync(bin, { recursive: true });
mkdirSync(apps, { recursive: true });

copyFileSync(sea, path.join(bin, 'lingspark'));
chmodSync(path.join(bin, 'lingspark'), 0o755);

// hicolor's directory layout is the size: 512 at the top, then 256, 128, 64,
// 32, 16. One PNG per size, all from the same source picture.
for (const size of [16, 32, 48, 64, 128, 256, 512]) {
  const dir = path.join(share, 'icons', 'hicolor', `${size}x${size}`, 'apps');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'lingspark.png'), encodePng(resize(icon, size)));
}

/**
 * The launcher. `Terminal=false` is the point: the program opens its own
 * window, so the desktop should not also give it a terminal. `Categories` is
 * what a Linux desktop's application menu sorts by.
 */
writeFileSync(
  path.join(apps, 'lingspark.desktop'),
  `[Desktop Entry]
Type=Application
Name=LingSpark · 灵光
Name[en]=LingSpark
Comment=${description}
Comment[en]=A linter for the Chinese Markdown AI coding agents write
Exec=lingspark
Icon=lingspark
Terminal=false
Categories=Development;Utility;
Keywords=markdown;linter;ai;agent;文档;检查;
StartupNotify=true
StartupWMClass=lingspark
`,
);

// A .desktop file is only picked up after the MIME database runs; a fresh
// install often has it already, so this is a no-op there and a fix here.
const updateMime = (dir) => {
  if (existsSync('/usr/bin/update-desktop-database')) {
    try {
      run('/usr/bin/update-desktop-database', [dir], { stdio: 'ignore' });
    } catch {
      // A desktop without the cache still works; the menu just needs a restart.
    }
  }
};
updateMime(apps);

const kb = (v) => Math.round(statSync(v).size / 1024);

// The tarball: the same tree, plus a README saying what to do with it. Anyone
// on Arch or Fedora unpacks this and moves one file.
const tarRoot = path.join(work, `lingspark-${version}-linux-x64`);
mkdirSync(tarRoot, { recursive: true });
copyFileSync(path.join(bin, 'lingspark'), path.join(tarRoot, 'lingspark'));
chmodSync(path.join(tarRoot, 'lingspark'), 0o755);
copyFileSync(path.join(apps, 'lingspark.desktop'), path.join(tarRoot, 'lingspark.desktop'));
for (const size of [128, 256, 512]) {
  const dir = path.join(tarRoot, 'icons', `${size}x${size}`, 'apps');
  mkdirSync(dir, { recursive: true });
  copyFileSync(path.join(share, 'icons', 'hicolor', `${size}x${size}`, 'apps', 'lingspark.png'), path.join(dir, 'lingspark.png'));
}
writeFileSync(
  path.join(tarRoot, '安装说明.md'),
  `# LingSpark ${version} · Linux（x64）

双击 \`lingspark\` 或在终端里运行它，就是客户端本身：它会开一个窗口显示配置页。

## 装到系统里（需要管理员权限）

\`\`\`bash
sudo install -Dm755 lingspark /usr/bin/lingspark
sudo install -Dm644 lingspark.desktop /usr/share/applications/lingspark.desktop
sudo install -Dm644 icons/512x512/apps/lingspark.png /usr/share/icons/hicolor/512x512/apps/lingspark.png
sudo install -Dm644 icons/256x256/apps/lingspark.png /usr/share/icons/hicolor/256x256/apps/lingspark.png
sudo install -Dm644 icons/128x128/apps/lingspark.png /usr/share/icons/hicolor/128x128/apps/lingspark.png
\`\`\`

Debian、Ubuntu、Mint 直接用 \`.deb\` 就行，不用照上面做。

## 只给自己用（不需要管理员权限）

\`\`\`bash
mkdir -p ~/.local/bin ~/.local/share/applications ~/.local/share/icons/hicolor/512x512/apps
install -m755 lingspark ~/.local/bin/lingspark
install -m644 lingspark.desktop ~/.local/share/applications/
install -m644 icons/512x512/apps/lingspark.png ~/.local/share/icons/hicolor/512x512/apps/
\`\`\`

## 数据在哪

\`~/.local/share/lingspark\`（配置、缓存、会话状态）。删掉就是恢复出厂设置。
`,
);

run('tar', [
  '--sort=name',
  '--owner=0',
  '--group=0',
  '--numeric-owner',
  '--mtime=@0',
  '-czf',
  tarball,
  '-C',
  work,
  path.basename(tarRoot),
]);

// The .deb. Depends on nothing beyond libc: the program is a Node single-file
// executable that carries its own runtime, exactly as on Mac and Windows
// (D-025 / D-074). Chromium is a recommendation, not a requirement -- without
// it the page opens in the default browser.
//
// dpkg-deb builds one directory that holds both the file tree and DEBIAN/, so
// the control files go into the same root the /usr tree was built in.
const DEBIAN = path.join(root, 'DEBIAN');
mkdirSync(DEBIAN, { recursive: true });
writeFileSync(
  path.join(DEBIAN, 'control'),
  `Package: lingspark
Version: ${debVersion}
Section: devel
Priority: optional
Architecture: amd64
Maintainer: ${author}
Depends: libc6 (>= 2.28)
Recommends: chromium | chromium-browser | google-chrome-stable
Homepage: https://github.com/rytesdd/lingspark
Description: 给 AI 代理写的中文 Markdown 装一道编译器
 LingSpark is a linter for the Chinese Markdown documents AI coding agents
 write. It installs as an agent hook: after the agent writes a document,
 lingspark checks it and, if there are errors, blocks the agent from
 finishing its turn until they are fixed.
 .
 本程序就是客户端：双击它会开一个窗口显示配置页，不需要另外安装浏览器内核
 （配置页优先用系统的 Chromium/Chrome 应用窗口打开，没有则退回默认浏览器）。
`,
);
writeFileSync(
  path.join(DEBIAN, 'postinst'),
  `#!/bin/sh
# The desktop file is only listed after the MIME cache runs.
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database -q /usr/share/applications || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || true
fi
exit 0
`,
);
chmodSync(path.join(DEBIAN, 'postinst'), 0o755);
writeFileSync(
  path.join(DEBIAN, 'postrm'),
  `#!/bin/sh
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database -q /usr/share/applications || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || true
fi
exit 0
`,
);
chmodSync(path.join(DEBIAN, 'postrm'), 0o755);

// The licence travels with the package, as Debian expects it to.
const docDir = path.join(root, 'usr', 'share', 'doc', 'lingspark');
mkdirSync(docDir, { recursive: true });
writeFileSync(path.join(docDir, 'copyright'), `LingSpark ${version}
Copyright © 2026 Kepler

Licensed under the Apache License, Version 2.0 (${license}). Redistributions must
keep the attribution in the NOTICE file of the source distribution.

  This product includes software developed as part of LingSpark
  (https://github.com/rytesdd/lingspark), licensed Apache-2.0.

  thinking-orbs (MIT, © Jakub Antalik) is bundled in the checking program;
  its licence is kept alongside the code in the source distribution.
`);

// dpkg-deb refuses a control directory outside 0755..0775, and it refuses
// world-writable files. Rather than trust the umask -- which differs per
// machine, and on a shared or mounted filesystem can be wide open -- the tree
// is stamped here. It also makes two builds of the same commit identical.
const EXECUTABLE = new Set(['usr/bin/lingspark', 'DEBIAN/postinst', 'DEBIAN/postrm']);
const normalise = (dir, prefix = '') => {
  chmodSync(dir, 0o755);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      normalise(path.join(dir, entry.name), rel);
    } else {
      chmodSync(path.join(dir, entry.name), EXECUTABLE.has(rel) ? 0o755 : 0o644);
    }
  }
};
normalise(root);

run('dpkg-deb', ['--build', '--root-owner-group', root, deb]);

rmSync(work, { recursive: true, force: true });

const mb = (p) => (statSync(p).size / 1024 / 1024).toFixed(0);
console.log(`Debian 包    -> ${path.relative(process.cwd(), deb)} (${mb(deb)} MB)`);
console.log(`通用 tar.gz -> ${path.relative(process.cwd(), tarball)} (${mb(tarball)} MB, ${kb(sea)} KB 程序)`);
