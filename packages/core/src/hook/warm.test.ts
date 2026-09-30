import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PathEnv } from '../paths.js';
import { enqueueWarm, runWarm } from './warm.js';

let root: string;
let proj: string;
let env: PathEnv;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'lingspark-warm-'));
  proj = path.join(root, 'proj');
  mkdirSync(path.join(proj, '.lingspark'), { recursive: true });
  writeFileSync(path.join(proj, '.lingspark', 'config.yaml'), 'version: 1\n');
  writeFileSync(path.join(proj, 'a.md'), '# 标题\n\n正文。\n');
  env = { platform: process.platform, env: { LINGSPARK_DATA_DIR: path.join(root, 'data') }, homedir: root };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const warmFiles = (): string[] => readdirSync(path.join(root, 'data', 'warm'));

describe('background warm-up', () => {
  it('asks for a warm-up only when none is running for the project', () => {
    expect(enqueueWarm(proj, [path.join(proj, 'a.md')], env)).toBe(true);
    // A live lock: this very process.
    const lock = warmFiles().find((f) => f.endsWith('.queue'))?.replace('.queue', '.lock') as string;
    writeFileSync(path.join(root, 'data', 'warm', lock), String(process.pid));
    expect(enqueueWarm(proj, [path.join(proj, 'a.md')], env)).toBe(false);
  });

  it('treats the lock of a process that is gone as free', () => {
    enqueueWarm(proj, [path.join(proj, 'a.md')], env);
    const lock = warmFiles().find((f) => f.endsWith('.queue'))?.replace('.queue', '.lock') as string;
    writeFileSync(path.join(root, 'data', 'warm', lock), '999999999');
    expect(enqueueWarm(proj, [path.join(proj, 'a.md')], env)).toBe(true);
  });

  it('drains the queue and releases the lock', async () => {
    enqueueWarm(proj, [path.join(proj, 'a.md')], env);
    await runWarm(proj, { builtinRules: [], pathEnv: env });
    expect(warmFiles()).toEqual([]);
    expect(existsSync(path.join(root, 'data', 'warm'))).toBe(true);
  });
});
