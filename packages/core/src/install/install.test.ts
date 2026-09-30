import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hasOurHooks, isOurHandler, withHooksInstalled, withHooksRemoved, type HookCommand } from './merge.js';
import {
  installBinary,
  installedHookCommand,
  applyChange,
  configFileFor,
  currentHookCommand,
  InstallError,
  lineDiff,
  planInstall,
  planUninstall,
} from './install.js';

const CMD: HookCommand = {
  posix: '"/Applications/My Tools/node" "/opt/doc lint/lingspark.cjs"',
  windows: '"C:\\Program Files\\lingspark\\lingspark.exe"',
};

/** The five starting states section 13 names, plus the one Codex users have. */
const STARTING_CONFIGS: Record<string, unknown> = {
  'empty object': {},
  'unknown fields': { outputStyle: 'Learning', model: 'x', nested: { keep: [1, 2, { deep: true }] } },
  'other hooks': {
    hooks: {
      PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo lint', timeout: 5 }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }],
      SessionStart: [{ hooks: [{ type: 'command', command: 'date' }] }],
    },
  },
  'old lingspark entry at a stale path': {
    hooks: {
      PostToolUse: [
        {
          matcher: 'Write',
          hooks: [{ type: 'command', command: '/old/place/lingspark hook --agent claude-code --event post-tool-use' }],
        },
      ],
    },
    other: 1,
  },
  'our handler sharing a group with someone else': {
    hooks: {
      Stop: [
        {
          hooks: [
            { type: 'command', command: 'say done' },
            { type: 'command', command: '"/x/lingspark" hook --agent claude-code --event stop' },
          ],
        },
      ],
    },
  },
  'explicitly empty hooks': { hooks: {} },
  'empty event array': { hooks: { Notification: [] } },
};

/**
 * Meaning, as an agent reads it. An empty `hooks` object and no `hooks` key
 * configure the same thing, so section 13's "semantically equal" treats them
 * as equal; uninstall cannot know which of the two the user started with.
 */
const semantic = (c: unknown): unknown => {
  if (c === null || typeof c !== 'object' || Array.isArray(c)) return c;
  const o = { ...(c as Record<string, unknown>) };
  const h = o['hooks'];
  if (h !== null && typeof h === 'object' && !Array.isArray(h) && Object.keys(h).length === 0) {
    delete o['hooks'];
  }
  return o;
};

/** What uninstall should give back: the original minus any lingspark handlers. */
const withoutOurs = (c: unknown): unknown => semantic(withHooksRemoved(c));

describe('withHooksInstalled / withHooksRemoved', () => {
  for (const [name, start] of Object.entries(STARTING_CONFIGS)) {
    for (const agent of ['claude-code', 'codex'] as const) {
      describe(`${name} · ${agent}`, () => {
        const installed = withHooksInstalled(start, agent, CMD);

        it('installs both hooks', () => {
          expect(hasOurHooks(installed)).toEqual({ postToolUse: true, stop: true });
        });

        it('preserves every field that is not a lingspark hook', () => {
          const { hooks: _ignored, ...restStart } = start as Record<string, unknown>;
          const { hooks: _ignored2, ...restAfter } = installed;
          expect(restAfter).toEqual(restStart);
        });

        it('is idempotent', () => {
          expect(withHooksInstalled(installed, agent, CMD)).toEqual(installed);
        });

        it('leaves exactly one lingspark handler per event', () => {
          const hooks = installed['hooks'] as Record<string, { hooks: unknown[] }[]>;
          for (const event of ['PostToolUse', 'Stop']) {
            const ours = (hooks[event] ?? []).flatMap((g) => g.hooks).filter(isOurHandler);
            expect(ours).toHaveLength(1);
          }
        });

        it('install then uninstall restores the original meaning', () => {
          expect(semantic(withHooksRemoved(installed))).toEqual(withoutOurs(start));
        });
      });
    }
  }

  it('writes commandWindows for Codex only', () => {
    const cc = withHooksInstalled({}, 'claude-code', CMD);
    const cx = withHooksInstalled({}, 'codex', CMD);
    const handler = (c: Record<string, unknown>): Record<string, unknown> =>
      ((c['hooks'] as Record<string, { hooks: Record<string, unknown>[] }[]>)['Stop']?.[0]?.hooks[0]) ?? {};
    expect(handler(cc)['commandWindows']).toBeUndefined();
    expect(handler(cx)['commandWindows']).toBe(`${CMD.windows} hook --agent codex --event stop`);
  });

  it('uses second-based timeouts a little above the internal budgets', () => {
    const c = withHooksInstalled({}, 'claude-code', CMD);
    const hooks = c['hooks'] as Record<string, { hooks: { timeout: number }[] }[]>;
    expect(hooks['PostToolUse']?.[0]?.hooks[0]?.timeout).toBe(15);
    expect(hooks['Stop']?.[0]?.hooks[0]?.timeout).toBe(90);
  });

  it("keeps someone else's handler when removing ours from a shared group", () => {
    const start = STARTING_CONFIGS['our handler sharing a group with someone else'];
    const removed = withHooksRemoved(start) as { hooks: { Stop: { hooks: unknown[] }[] } };
    expect(removed.hooks.Stop[0]?.hooks).toEqual([{ type: 'command', command: 'say done' }]);
  });
});

describe('isOurHandler', () => {
  it('recognises lingspark at any path, quoted or not', () => {
    expect(isOurHandler({ command: '"/a b/lingspark" hook --agent codex --event stop' })).toBe(true);
    expect(isOurHandler({ command: '"C:\\x\\lingspark.exe" hook --agent codex --event stop' })).toBe(true);
    expect(isOurHandler({ command: '"/n/node" "/p/lingspark.cjs" hook --agent claude-code --event stop' })).toBe(true);
  });

  it('leaves other commands alone', () => {
    expect(isOurHandler({ command: 'echo lingspark' })).toBe(false);
    expect(isOurHandler({ command: 'npx eslint --fix' })).toBe(false);
    expect(isOurHandler('lingspark hook --agent x')).toBe(false);
  });
});

describe('currentHookCommand', () => {
  it('quotes node and the script separately', () => {
    const c = currentHookCommand('/usr/local/bin/node', '/opt/doc lint/lingspark.cjs');
    expect(c.posix).toBe(`"${path.resolve('/usr/local/bin/node')}" "${path.resolve('/opt/doc lint/lingspark.cjs')}"`);
  });

  it('uses the executable alone under a single-executable build', () => {
    const exe = path.resolve('/Applications/lingspark.app/lingspark');
    expect(currentHookCommand(exe, exe).posix).toBe(`"${exe}"`);
  });

  it('refuses a path it cannot quote', () => {
    expect(() => currentHookCommand('/a"b/node', '/x.cjs')).toThrow(InstallError);
  });
});

describe('configFileFor', () => {
  it('maps each agent and scope to its settings file', () => {
    const home = path.resolve('/h');
    const proj = path.resolve('/p');
    expect(configFileFor('claude-code', 'user', { homedir: home })).toBe(path.join(home, '.claude', 'settings.json'));
    expect(configFileFor('codex', 'user', { homedir: home })).toBe(path.join(home, '.codex', 'hooks.json'));
    expect(configFileFor('claude-code', 'project', { projectDir: proj })).toBe(path.join(proj, '.claude', 'settings.json'));
    expect(configFileFor('codex', 'project', { projectDir: proj })).toBe(path.join(proj, '.codex', 'hooks.json'));
  });
});

describe('planInstall / applyChange on disk', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'lingspark-install-'));
    file = path.join(dir, '.claude', 'settings.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const backups = (): string[] =>
    existsSync(path.dirname(file))
      ? readdirSync(path.dirname(file)).filter((n) => n.includes('.lingspark-backup-'))
      : [];

  it('creates a missing file without making a backup', () => {
    const change = planInstall(file, 'claude-code', CMD);
    expect(change.existed).toBe(false);
    expect(applyChange(change)).toBeNull();
    expect(hasOurHooks(JSON.parse(readFileSync(file, 'utf8')))).toEqual({ postToolUse: true, stop: true });
  });

  it('backs up an existing file before changing it, and keeps its indentation', () => {
    mkdirSync(path.dirname(file), { recursive: true });
    const original = '{\n    "outputStyle": "Learning"\n}\n';
    writeFileSync(file, original);
    const backup = applyChange(planInstall(file, 'claude-code', CMD));
    expect(backup).not.toBeNull();
    expect(readFileSync(backup!, 'utf8')).toBe(original);
    expect(readFileSync(file, 'utf8')).toMatch(/^\{\n {4}"outputStyle"/u);
  });

  it.skipIf(process.platform === 'win32')('keeps a private config private, and its backup too', () => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '{"sandbox": {}}\n');
    chmodSync(file, 0o600);
    const backup = applyChange(planInstall(file, 'claude-code', CMD));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(backup!).mode & 0o777).toBe(0o600);
  });

  it('does not rewrite a file that is already installed', () => {
    applyChange(planInstall(file, 'claude-code', CMD));
    const second = planInstall(file, 'claude-code', CMD);
    expect(second.changed).toBe(false);
    expect(applyChange(second)).toBeNull();
    expect(backups()).toHaveLength(0);
  });

  it('treats an empty file as an empty object', () => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '');
    expect(planInstall(file, 'codex', CMD).changed).toBe(true);
  });

  it('refuses to touch a file that is not valid JSON', () => {
    mkdirSync(path.dirname(file), { recursive: true });
    const broken = '{ "a": 1, }';
    writeFileSync(file, broken);
    expect(() => planInstall(file, 'claude-code', CMD)).toThrow(InstallError);
    expect(readFileSync(file, 'utf8')).toBe(broken);
  });

  it('refuses a file whose top level is not an object', () => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '[1, 2]');
    expect(() => planInstall(file, 'claude-code', CMD)).toThrow(InstallError);
  });

  it('never overwrites an earlier backup made in the same second', () => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '{"original":true}');
    const now = new Date(2026, 8, 23, 10, 0, 0);
    const first = applyChange(planInstall(file, 'claude-code', CMD), now);
    const second = applyChange(planUninstall(file), now);
    expect(first).not.toBe(second);
    expect(JSON.parse(readFileSync(first!, 'utf8'))).toEqual({ original: true });
  });

  it('uninstall on a file with no lingspark hooks changes nothing', () => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '{"outputStyle":"Learning"}');
    expect(planUninstall(file).changed).toBe(false);
  });

  it('uninstall on a missing file does not create one', () => {
    const change = planUninstall(file);
    expect(change.changed).toBe(false);
    applyChange(change);
    expect(existsSync(file)).toBe(false);
  });

  it('round-trips a real-looking settings file on disk', () => {
    mkdirSync(path.dirname(file), { recursive: true });
    const original = { agentPushNotifEnabled: true, outputStyle: 'Learning' };
    writeFileSync(file, `${JSON.stringify(original, null, 2)}\n`);
    applyChange(planInstall(file, 'claude-code', CMD));
    applyChange(planUninstall(file));
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(original);
  });
});

describe('lineDiff', () => {
  it('marks added and removed lines, removals first', () => {
    const d = lineDiff('a\nb\nc\n', 'a\nB\nc\nd\n');
    expect(d).toContain('- b');
    expect(d).toContain('+ B');
    expect(d).toContain('+ d');
    expect(d.indexOf('- b')).toBeLessThan(d.indexOf('+ B'));
  });

  it('shows everything as added for a new file', () => {
    expect(lineDiff('', '{\n}\n')).toBe('+ {\n+ }');
  });
});

describe('installBinary', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'lingspark-bin-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const env = () => ({ platform: process.platform, env: { LINGSPARK_DATA_DIR: path.join(dir, 'data') }, homedir: dir });

  it('copies a single-file build out of the build directory and points the hook at the copy', () => {
    const built = path.join(dir, 'dist', 'lingspark');
    mkdirSync(path.dirname(built), { recursive: true });
    writeFileSync(built, 'v1');
    const cmd = installBinary(built, built, env());
    const copy = path.join(dir, 'data', 'bin', process.platform === 'win32' ? 'lingspark.exe' : 'lingspark');
    expect(cmd.posix).toBe(`"${copy}"`);
    expect(readFileSync(copy, 'utf8')).toBe('v1');
    // Rebuilding wipes the build directory; the hook's copy survives.
    rmSync(path.join(dir, 'dist'), { recursive: true });
    expect(existsSync(copy)).toBe(true);
  });

  it('copies the script and keeps node when run as node + script', () => {
    const script = path.join(dir, 'dist', 'lingspark.cjs');
    mkdirSync(path.dirname(script), { recursive: true });
    writeFileSync(script, 'js');
    const node = path.join(dir, 'node');
    const cmd = installBinary(node, script, env());
    expect(cmd.posix).toBe(`"${node}" "${path.join(dir, 'data', 'bin', 'lingspark.cjs')}"`);
  });

  it('replaces an older copy, and the dry-run command matches what install writes', () => {
    const built = path.join(dir, 'dist', 'lingspark');
    mkdirSync(path.dirname(built), { recursive: true });
    writeFileSync(built, 'v1');
    installBinary(built, built, env());
    writeFileSync(built, 'v2');
    const cmd = installBinary(built, built, env());
    expect(readFileSync(path.join(dir, 'data', 'bin', process.platform === 'win32' ? 'lingspark.exe' : 'lingspark'), 'utf8')).toBe('v2');
    expect(installedHookCommand(built, built, env())).toEqual(cmd);
  });
});
