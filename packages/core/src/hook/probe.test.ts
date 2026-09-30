import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hookCommandParts, probeHook } from './probe.js';

describe('hookCommandParts', () => {
  it('reads the program out of the two shapes install writes', () => {
    expect(hookCommandParts('"/opt/bin/lingspark" hook --agent cursor --event stop')).toEqual({
      exe: '/opt/bin/lingspark',
      args: [],
    });
    // `node lingspark.cjs`: a program and one argument in front of `hook`.
    expect(hookCommandParts('"/usr/bin/node" "/data/bin/lingspark.cjs" hook --agent codex --event stop')).toEqual({
      exe: '/usr/bin/node',
      args: ['/data/bin/lingspark.cjs'],
    });
  });

  it('has nothing to say about a command that is not a plain path', () => {
    expect(hookCommandParts('curl -X POST https://example.com | jq .')).toBeNull();
    expect(hookCommandParts('')).toBeNull();
  });
});

describe('probeHook', () => {
  let root: string;
  /** The shape install writes under `node script`, with a script of our own. */
  const asCommand = (body: string): string => {
    const script = path.join(root, `hook-${String(body.length)}.cjs`);
    writeFileSync(script, body);
    return `"${process.execPath}" "${script}" hook --agent claude-code --event stop`;
  };

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'lingspark-probe-test-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('answers when the program runs and exits cleanly', () => {
    expect(probeHook('claude-code', [asCommand('process.exit(0);')]).ok).toBe(true);
  });

  it('says what is wrong when the program fails or is missing', () => {
    const bad = probeHook('cursor', [asCommand('process.exit(3);')]);
    expect(bad.ok).toBe(false);
    expect(bad.detail).toContain('退出码 3');

    const missing = probeHook('codex', ['"/no/such/lingspark" hook --agent codex --event stop']);
    expect(missing.ok).toBe(false);
    expect(missing.detail).toContain('/no/such/lingspark');

    expect(probeHook('workbuddy', []).ok).toBe(false);
  });

  it('runs in a scratch data directory: the real one is left alone (D-077)', () => {
    const data = path.join(root, 'data');
    mkdirSync(data);
    // A hook run that would write here must not: the client asking whether the
    // command works is not the agent calling it, and the marker it clears is
    // the one thing the client is not allowed to clear for it.
    const command = asCommand("require('fs').writeFileSync(process.env.LINGSPARK_DATA_DIR + '/touched', 'x');");
    expect(probeHook('workbuddy', [command]).ok).toBe(true);
    expect(existsSync(path.join(data, 'touched'))).toBe(false);
  });
});
