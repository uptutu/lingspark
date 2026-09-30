import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beginActivity, checkingNow } from './hook/activity.js';
import { awaitFirstCall, heardFrom, noticeWaiting } from './hook/waiting.js';
import type { PathEnv } from './paths.js';
import { todayStats } from './today.js';

let root: string;
let env: PathEnv;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'lingspark-today-'));
  env = { platform: process.platform, env: { LINGSPARK_DATA_DIR: root }, homedir: root };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const log = (r: object): void => {
  mkdirSync(path.join(root, 'stats'), { recursive: true });
  appendFileSync(path.join(root, 'stats', 'runs.jsonl'), `${JSON.stringify(r)}\n`);
};

describe("today's numbers for the client", () => {
  it('says nothing was ever checked on a new machine', () => {
    expect(todayStats(env)).toEqual({ checked: 0, blocked: 0, total: { checked: 0, blocked: 0 }, ever: false, waiting: [], noticed: [] });
  });

  it("counts today's documents once each, and each problem once however often it was handed back", () => {
    const now = new Date(2026, 8, 30, 15, 0);
    const today = new Date(2026, 8, 30, 9, 0).toISOString();
    log({ ts: new Date(2026, 8, 29, 9, 0).toISOString(), event: 'stop', file: '/old.md', blocked: 5 });
    log({ ts: today, agent: 'codex', event: 'post-tool-use', file: '/a.md', blocked: 2, reported: ['p1', 'p2'] });
    log({ ts: today, event: 'stop', file: '/a.md', blocked: 1, reported: ['p1'] }); // p1 again
    log({ ts: today, event: 'post-tool-use', file: '/b.md', blocked: 0, reported: [] });
    log({ ts: today, event: 'review', files: ['/a.md', '/b.md'], findings: 3 });
    expect(todayStats(env, now)).toEqual({
      checked: 2,
      blocked: 5,
      total: { checked: 3, blocked: 10 },
      ever: true,
      waiting: [],
      noticed: [],
    });
  });
});

describe('all-time numbers', () => {
  it('keep counting as lines are added, reading only the new ones', () => {
    log({ ts: new Date(2026, 8, 1).toISOString(), file: '/a.md', reported: ['p1'] });
    expect(todayStats(env).total).toEqual({ checked: 1, blocked: 1 });
    log({ ts: new Date(2026, 8, 2).toISOString(), file: '/a.md', reported: ['p1', 'p2'] });
    log({ ts: new Date(2026, 8, 2).toISOString(), file: '/b.md', reported: [] });
    expect(todayStats(env).total).toEqual({ checked: 2, blocked: 2 });
  });

  it('start over when the file is replaced by a shorter one', () => {
    log({ ts: new Date(2026, 8, 1).toISOString(), file: '/a.md', reported: ['p1', 'p2', 'p3'] });
    log({ ts: new Date(2026, 8, 1).toISOString(), file: '/b.md', reported: [] });
    expect(todayStats(env).total).toEqual({ checked: 2, blocked: 3 });
    rmSync(path.join(root, 'stats', 'runs.jsonl'));
    log({ ts: new Date(2026, 8, 3).toISOString(), file: '/c.md', reported: [] });
    expect(todayStats(env).total).toEqual({ checked: 1, blocked: 0 });
  });
});

describe('which connected agents still need a restart', () => {
  it('waits for a newly connected agent until any of its hooks runs, document or not', () => {
    awaitFirstCall('claude-code', env);
    awaitFirstCall('codex', env);
    expect(todayStats(env).waiting).toEqual(['claude-code', 'codex']);
    heardFrom('claude-code', env);
    expect(todayStats(env).waiting).toEqual(['codex']);
    expect(todayStats(env).checked).toBe(0);
  });

  it('remembers that the person has seen a wait, until the agent waits anew', () => {
    awaitFirstCall('codex', env);
    noticeWaiting(['codex', 'cursor'], env); // cursor is not waiting: nothing to note
    expect(todayStats(env)).toMatchObject({ waiting: ['codex'], noticed: ['codex'] });
    awaitFirstCall('codex', env);
    expect(todayStats(env).noticed).toEqual([]);
    heardFrom('codex', env);
    expect(todayStats(env)).toMatchObject({ waiting: [], noticed: [] });
  });
});

describe('"a check is running"', () => {
  it('holds while this process works and ends when it is done', () => {
    expect(checkingNow(env)).toBe(false);
    const done = beginActivity(env);
    expect(checkingNow(env)).toBe(true);
    done();
    expect(checkingNow(env)).toBe(false);
  });

  it('ignores a marker left by a process that is gone', () => {
    mkdirSync(path.join(root, 'state', 'checking'), { recursive: true });
    appendFileSync(path.join(root, 'state', 'checking', '999999999'), 'x');
    expect(checkingNow(env)).toBe(false);
  });
});
