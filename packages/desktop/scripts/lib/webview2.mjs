#!/usr/bin/env node
// The WebView2 SDK the Windows client is compiled against (D-080).
//
// The client's own source is one C# file; what it needs from the SDK is three
// files, fetched once and kept in .lingspark-scratch/ like any other downloaded
// toolchain. Both the version and the package's own hash are pinned here: the
// build refuses a download that does not match, so a compromised mirror or a
// truncated file stops the build instead of becoming a shipped client.
//
// Which of the SDK's frameworks to use is decided by the compiler, not here:
// the C# compiler that ships in Windows is old (C# 5), so the assemblies have
// to be the .NET Framework ones -- the SDK's netcoreapp and net6 builds are
// reference assemblies for a newer compiler, and net462 is what a machine that
// only has the .NET Framework can load at run time.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const root = path.resolve(desktop, '..', '..');

/** The SDK build this client is compiled against, and what must arrive with it. */
export const webview2Sdk = {
  version: '1.0.4258.31',
  /** NuGet's own SHA-512 of the .nupkg, from its catalog entry. */
  sha512: 'HlGVwvyP/IWiXAU8K57Vmg59khY3DWMOxMnH4AHusFRy0/vDAjKItXUIVNXiXXaq4CLfSZyNUic1wOIlnPLsPQ==',
  /** Copied next to the client: the two managed assemblies, and the native loader they P/Invoke into. */
  files: [
    'lib/net462/Microsoft.Web.WebView2.Core.dll',
    'lib/net462/Microsoft.Web.WebView2.WinForms.dll',
    'runtimes/win-x64/native/WebView2Loader.dll',
  ],
};

const cacheDir = (version) => path.join(root, '.lingspark-scratch', 'webview2', version);

const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });

/**
 * The package, verified and unpacked, ready to copy from.
 *
 * @param {{ log?: (s: string) => void }} [options]
 * @returns {Promise<{ unpacked: string }>} the directory holding the SDK's own layout
 */
export async function fetchWebview2Sdk({ log = () => {} } = {}) {
  const { version, sha512 } = webview2Sdk;
  const dir = cacheDir(version);
  const nupkg = path.join(dir, `microsoft.web.webview2.${version}.nupkg`);
  const unpacked = path.join(dir, 'pkg');
  mkdirSync(dir, { recursive: true });

  if (!existsSync(nupkg)) {
    log(`下载 WebView2 SDK ${version}…`);
    // The flat container serves the package itself; nothing else in the SDK is used.
    const url = `https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/${version}/microsoft.web.webview2.${version}.nupkg`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`下载 WebView2 SDK 失败：HTTP ${response.status} ${response.statusText}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const got = createHash('sha512').update(bytes).digest('base64');
    if (got !== sha512) {
      throw new Error(
        'WebView2 SDK 的 SHA-512 对不上，已中止构建。\n' +
          `  期望 ${sha512}\n  实际 ${got}\n` +
          '  换版本时版本号和这里的哈希要一起改（哈希取自 NuGet 的 catalog 条目）。',
      );
    }
    writeFileSync(nupkg, bytes);
  }

  // A stamp rather than the directory's existence: a run interrupted halfway
  // through unpacking leaves the directory there and the files in it short.
  const stamp = path.join(unpacked, '.unpacked');
  if (!existsSync(stamp)) {
    rmSync(unpacked, { recursive: true, force: true });
    mkdirSync(unpacked, { recursive: true });
    // tar.exe is in Windows 10 1803 and later and reads zip, which is what a
    // .nupkg is. Node has no zip reader of its own, and PowerShell's
    // Expand-Archive insists on a .zip extension.
    run('tar.exe', ['-xf', nupkg, '-C', unpacked]);
    writeFileSync(stamp, `${version}\n`);
  }
  return { unpacked };
}

/**
 * Puts the three files beside the client, where the two managed assemblies have
 * to be for the loader to find them, and hands back the ones the compiler has to
 * reference.
 *
 * @param {string} unpacked as returned by {@link fetchWebview2Sdk}
 * @param {string} dest the directory the client is built into
 * @returns {{ references: string[], runtime: string[] }} absolute paths
 */
export function stageWebview2Assemblies(unpacked, dest) {
  mkdirSync(dest, { recursive: true });
  const staged = webview2Sdk.files.map((file) => {
    const from = path.join(unpacked, ...file.split('/'));
    if (!existsSync(from)) {
      throw new Error(`WebView2 SDK 里没有 ${file}——这个版本改了布局的话，改 webview2Sdk.files。`);
    }
    const to = path.join(dest, path.basename(file));
    copyFileSync(from, to);
    return to;
  });
  const loader = staged.find((file) => path.basename(file) === 'WebView2Loader.dll');
  return {
    // The native loader is deliberately absent here: it is not a managed
    // assembly, and handing it to the compiler as a reference is an error.
    references: staged.filter((file) => file !== loader),
    runtime: staged,
  };
}
