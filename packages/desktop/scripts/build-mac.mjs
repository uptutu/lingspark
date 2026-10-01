#!/usr/bin/env node
// Builds the Mac client (D-061): LingSpark.app and its .dmg, with nothing but
// the tools that come with Xcode's command-line tools.
//
// The app is a small Swift window around the setup page plus the command-line
// lingspark the hooks run. No bundled browser: the window uses the system's
// web view, which is why the download is tens of megabytes, not hundreds.
//
// Usage: node scripts/build-mac.mjs   (after `pnpm build:sea` at the root)

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(path.join(pkg, 'package.json'), 'utf8'));
const cli = path.resolve(pkg, '..', 'cli', 'sea', 'lingspark');
const release = path.join(pkg, 'release');
const work = path.join(release, 'work');
const app = path.join(release, 'mac', 'LingSpark.app');
const dmg = path.join(release, `lingspark-${version}-mac.dmg`);
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });

if (process.platform !== 'darwin') {
  console.error('Mac 客户端只能在 Mac 上构建。');
  process.exit(1);
}
if (!existsSync(cli)) {
  console.error(`找不到 ${cli}，先在仓库根目录运行 pnpm build:sea。`);
  process.exit(1);
}

rmSync(release, { recursive: true, force: true });
const contents = path.join(app, 'Contents');
mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
mkdirSync(path.join(contents, 'Resources', 'bin'), { recursive: true });
mkdirSync(work, { recursive: true });

// The window: one universal binary, an arm64 slice and an x86_64 slice merged
// with lipo (D-099), so the same .dmg serves Apple silicon and Intel Macs.
for (const arch of ['arm64', 'x86_64']) {
  run('xcrun', [
    'swiftc',
    '-O',
    '-target',
    `${arch}-apple-macos12.0`,
    path.join(pkg, 'src', 'main.swift'),
    '-o',
    path.join(work, `LingSpark-${arch}`),
  ]);
}
run('lipo', [
  '-create',
  path.join(work, 'LingSpark-arm64'),
  path.join(work, 'LingSpark-x86_64'),
  '-output',
  path.join(contents, 'MacOS', 'LingSpark'),
]);

// The CLI the window starts and the hooks run (a copy of it, installed on
// first use). build-sea already merged its two architecture slices into one
// universal binary on macOS.
copyFileSync(cli, path.join(contents, 'Resources', 'bin', 'lingspark'));

// The icon, from the one square PNG.
const iconset = path.join(work, 'icon.iconset');
mkdirSync(iconset);
for (const size of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) {
    const px = String(size * scale);
    const name = `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`;
    execFileSync('sips', ['-z', px, px, path.join(pkg, 'build', 'icon.png'), '--out', path.join(iconset, name)], {
      stdio: 'ignore',
    });
  }
}
run('iconutil', ['-c', 'icns', iconset, '-o', path.join(contents, 'Resources', 'icon.icns')]);

writeFileSync(
  path.join(contents, 'Info.plist'),
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>LingSpark</string>
  <key>CFBundleDisplayName</key><string>LingSpark</string>
  <key>CFBundleIdentifier</key><string>io.github.lingspark</string>
  <key>CFBundleExecutable</key><string>LingSpark</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>CFBundleDevelopmentRegion</key><string>zh_CN</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>NSHumanReadableCopyright</key><string>Copyright © 2026 Kepler · Apache-2.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSSupportsAutomaticGraphicsSwitching</key><true/>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
`,
);

// Unsigned for now (README explains the first-launch step): an ad-hoc
// signature, which Apple silicon requires to run at all. Real signing and
// notarisation come with the release pipeline.
run('codesign', ['--force', '--sign', '-', path.join(contents, 'Resources', 'bin', 'lingspark')]);
run('codesign', ['--force', '--sign', '-', app]);

// The disk image (D-063): the app, a shortcut to Applications, and a window
// laid out to say "drag this there". dmgbuild writes the layout into the
// image directly; arranging it through Finder would open windows while
// building.
const dmgbuild = path.join(pkg, '.venv', 'bin', 'dmgbuild');
if (!existsSync(dmgbuild)) {
  console.error('缺少 dmgbuild。先运行：python3 -m venv packages/desktop/.venv && packages/desktop/.venv/bin/pip install dmgbuild==1.6.5');
  process.exit(1);
}
const bg = (scale) => path.join(work, `bg${scale === 2 ? '@2x' : ''}.png`);
for (const scale of [1, 2]) {
  run('xcrun', ['swift', path.join(pkg, 'build', 'dmg-background.swift'), bg(scale), String(scale)]);
}
const background = path.join(work, 'background.tiff');
run('tiffutil', ['-cathidpicheck', bg(1), bg(2), '-out', background]);
run(dmgbuild, [
  '-s',
  path.join(pkg, 'scripts', 'dmg-settings.py'),
  '-D',
  `app=${app}`,
  '-D',
  `background=${background}`,
  '-D',
  `volume_icon=${path.join(contents, 'Resources', 'icon.icns')}`,
  'LingSpark',
  dmg,
]);
rmSync(work, { recursive: true, force: true });

const mb = (p) => (statSync(p).size / 1024 / 1024).toFixed(0);
const du = execFileSync('du', ['-sm', app], { encoding: 'utf8' }).split('\t')[0];
console.log(`LingSpark.app ${du} MB -> ${path.relative(process.cwd(), dmg)} (${mb(dmg)} MB)`);
