import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { agentProfile } from '../agents.js';
import { hasOurPlugin, ourCommandsInText, withPluginInstalled, withPluginRemoved } from './merge.js';
import { InstallError } from './install.js';
import { applyBridge, bridgeContent, bridgePath, opencodePluginUrl, planBridge, writeBridge } from './bridge.js';

const CMD = {
  posix: '"/n/node" "/d/lingspark.cjs"',
  windows: '"C:\\d\\lingspark.exe"',
} as const;

const pi = agentProfile('pi');
const opencode = agentProfile('opencode');

describe('bridgeContent', () => {
  it('generates an extension only for bridge agents', () => {
    expect(bridgeContent(pi!, CMD)).toContain('pi.on("tool_call"');
    expect(bridgeContent(opencode!, CMD)).toContain('"tool.execute.before"');
    expect(bridgeContent(agentProfile('claude-code')!, CMD)).toBeNull();
  });

  it('embeds both hook commands with the right events', () => {
    const text = bridgeContent(pi!, CMD)!;
    expect(ourCommandsInText(text)).toEqual([
      `${CMD.posix} hook --agent pi --event post-tool-use`,
      `${CMD.posix} hook --agent pi --event stop`,
    ]);
    const oc = bridgeContent(opencode!, CMD)!;
    expect(oc).toContain('hook --agent opencode --event post-tool-use');
    expect(oc).toContain('LINGSPARK_JUDGE_CHILD');
  });

  it('opencode’s plugin is plain JS loaded as ESM: no TS annotation, no require (D-102)', () => {
    const oc = bridgeContent(opencode!, CMD)!;
    expect(oc).not.toMatch(/:\s*(any|string|number|boolean)\b/u);
    expect(oc).not.toMatch(/\bas\s+any\b/u);
    // opencode loads plugins as ES modules; a top-level require is undefined
    // there and kills the whole plugin (found live 2026-10-01).
    expect(oc).not.toContain('require(');
    expect(oc).toContain("import { spawnSync } from 'node:child_process';");
    // pi's jiti loader accepts require in its TS extensions.
    expect(bridgeContent(pi!, CMD)).toContain("require('node:child_process')");
  });

  it('both templates mirror write content to a sibling temp file (pre-write hooks)', () => {
    for (const a of [pi, opencode]) {
      const text = bridgeContent(a!, CMD)!;
      expect(text).toContain('lingspark-mirror-');
      expect(text).toContain('rmSync(mirrored');
    }
  });
});

describe('opencodePluginUrl', () => {
  it('is a file URL with forward slashes', () => {
    const home = path.resolve('/h');
    const expected = `file:///${home.split(path.sep).join('/')}/.config/opencode/plugins/lingspark.js`;
    expect(opencodePluginUrl(opencode!, home)).toBe(expected);
  });
});

describe('withPluginInstalled / withPluginRemoved', () => {
  const url = 'file:///h/.config/opencode/plugins/lingspark.js';

  it('adds the entry and preserves everything else', () => {
    const start = { model: 'x', plugin: ['file:///other.js'] };
    const installed = withPluginInstalled(start, url);
    expect(installed).toEqual({ model: 'x', plugin: ['file:///other.js', url] });
  });

  it('is idempotent and never duplicates', () => {
    const once = withPluginInstalled({}, url);
    expect(withPluginInstalled(once, url)).toEqual(once);
    expect(hasOurPlugin(once, url)).toBe(true);
    expect(hasOurPlugin({ plugin: ['file:///other.js'] }, url)).toBe(false);
  });

  it('removal drops the key when the array empties, keeps strangers', () => {
    expect(withPluginRemoved({ plugin: [url] }, url)).toEqual({});
    expect(withPluginRemoved({ plugin: [url, 'x'], a: 1 }, url)).toEqual({ plugin: ['x'], a: 1 });
  });
});

describe('writeBridge', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'lingspark-bridge-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes a missing bridge and reports change', () => {
    const file = path.join(dir, 'deep', 'lingspark.ts');
    expect(writeBridge(file, 'content-v1')).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('content-v1');
  });

  it('is a no-op when content matches', () => {
    const file = path.join(dir, 'lingspark.ts');
    expect(writeBridge(file, 'same')).toBe(true);
    expect(writeBridge(file, 'same')).toBe(false);
  });

  it('refuses to clobber a file that is not recognisably ours', () => {
    const file = path.join(dir, 'lingspark.ts');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '// user wrote their own extension\nexport default function () {}\n');
    expect(() => writeBridge(file, 'ours')).toThrow(InstallError);
    expect(readFileSync(file, 'utf8')).toContain('user wrote their own extension');
  });

  it('replaces an older lingspark bridge, backing it up', () => {
    const file = path.join(dir, 'lingspark.ts');
    writeBridge(file, bridgeContent(pi!, CMD)!);
    const next = bridgeContent(pi!, { ...CMD, posix: '"/n2/node" "/d/lingspark.cjs"' })!;
    expect(writeBridge(file, next)).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(next);
    const backups = readdirSync(dir).filter((n) => n.includes('.lingspark-backup-'));
    expect(backups).toHaveLength(1);
    expect(ourCommandsInText(readFileSync(path.join(dir, backups[0]!), 'utf8'))).toContain(
      `${CMD.posix} hook --agent pi --event post-tool-use`,
    );
  });
});

describe('planBridge / applyBridge on disk', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'lingspark-bridge-home-'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const cfg = (): string => path.join(home, '.config', 'opencode', 'opencode.json');

  it('installs pi by writing the extension file only', () => {
    const plan = planBridge(pi!, 'install', CMD, home);
    expect(plan.changed).toBe(true);
    expect(plan.existed).toBe(false);
    applyBridge(pi!, 'install', CMD, home);
    const file = bridgePath(pi!, home);
    expect(ourCommandsInText(readFileSync(file, 'utf8'))).toHaveLength(2);
    // pi has no side config to merge.
    expect(existsSync(cfg())).toBe(false);
  });

  it('installs opencode and merges the plugin entry into opencode.json', () => {
    mkdirSync(path.dirname(cfg()), { recursive: true });
    writeFileSync(cfg(), JSON.stringify({ plugin: ['file:///keep.js'], theme: 'dark' }, null, 2) + '\n');
    const url = opencodePluginUrl(opencode!, home);
    expect(applyBridge(opencode!, 'install', CMD, home)).toBe(true);
    const after = JSON.parse(readFileSync(cfg(), 'utf8')) as { plugin: string[]; theme: string };
    expect(after.theme).toBe('dark');
    expect(after.plugin).toEqual(['file:///keep.js', url]);
    expect(existsSync(bridgePath(opencode!, home))).toBe(true);
  });

  it('is idempotent on re-install', () => {
    applyBridge(opencode!, 'install', CMD, home);
    expect(applyBridge(opencode!, 'install', CMD, home)).toBe(false);
    expect(planBridge(opencode!, 'install', CMD, home).changed).toBe(false);
  });

  it('uninstall removes the bridge and the plugin entry, keeping strangers', () => {
    mkdirSync(path.dirname(cfg()), { recursive: true });
    writeFileSync(cfg(), JSON.stringify({ plugin: ['file:///keep.js'] }) + '\n');
    applyBridge(opencode!, 'install', CMD, home);
    expect(applyBridge(opencode!, 'uninstall', CMD, home)).toBe(true);
    expect(existsSync(bridgePath(opencode!, home))).toBe(false);
    expect(JSON.parse(readFileSync(cfg(), 'utf8'))).toEqual({ plugin: ['file:///keep.js'] });
  });

  it('uninstall on a missing bridge changes nothing', () => {
    expect(applyBridge(pi!, 'uninstall', CMD, home)).toBe(false);
    expect(planBridge(pi!, 'uninstall', CMD, home).changed).toBe(false);
  });

  it('a stale opencode config entry is cleaned even when the bridge file is already gone', () => {
    const url = opencodePluginUrl(opencode!, home);
    mkdirSync(path.dirname(cfg()), { recursive: true });
    writeFileSync(cfg(), JSON.stringify({ plugin: [url, 'file:///keep.js'] }) + '\n');
    expect(applyBridge(opencode!, 'uninstall', CMD, home)).toBe(false);
    expect(JSON.parse(readFileSync(cfg(), 'utf8'))).toEqual({ plugin: ['file:///keep.js'] });
  });
});
