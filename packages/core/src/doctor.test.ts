import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDoctor, type DoctorOptions } from './doctor.js';
import { withHooksInstalled } from './install/merge.js';

const RULES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../rules-builtin/rules');
const builtinRules = readdirSync(RULES_DIR)
  .filter((n) => n.endsWith('.yaml'))
  .map((n) => ({ file: n, yaml: readFileSync(path.join(RULES_DIR, n), 'utf8') }));

describe('runDoctor', () => {
  let root: string;
  let opts: DoctorOptions;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'lingspark-doctor-'));
    mkdirSync(path.join(root, 'proj', '.lingspark'), { recursive: true });
    writeFileSync(path.join(root, 'proj', '.lingspark', 'config.yaml'), '');
    opts = {
      cwd: path.join(root, 'proj'),
      builtinRules,
      homedir: path.join(root, 'home'),
      pathEnv: { platform: process.platform, env: { LINGSPARK_DATA_DIR: path.join(root, 'data') }, homedir: root },
    };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const byName = async (name: string) => (await runDoctor(opts)).find((c) => c.name.startsWith(name));

  it('passes the basics in a clean opted-in project', async () => {
    const checks = await runDoctor(opts);
    expect(checks.filter((c) => c.status === 'fail')).toEqual([]);
    // No judge configured is a warning with instructions, not a failure.
    expect(checks.find((c) => c.name === '判定后端')?.status).toBe('warn');
    expect((await byName('规则集'))?.status).toBe('ok');
    expect((await byName('当前目录的项目配置'))?.status).toBe('ok');
  });

  it('is fine without a project config: the defaults apply (D-050)', async () => {
    rmSync(path.join(root, 'proj', '.lingspark'), { recursive: true });
    expect((await byName('当前目录的项目配置'))?.status).toBe('ok');
  });

  it('fails on a broken project config', async () => {
    writeFileSync(path.join(root, 'proj', '.lingspark', 'config.yaml'), 'include: [x\n');
    expect((await byName('当前目录的项目配置'))?.status).toBe('fail');
  });

  it('reports an installed hook whose executable still exists as ok', async () => {
    const exe = path.join(root, 'bin', 'lingspark');
    mkdirSync(path.dirname(exe), { recursive: true });
    writeFileSync(exe, '');
    const settings = path.join(root, 'home', '.claude', 'settings.json');
    mkdirSync(path.dirname(settings), { recursive: true });
    writeFileSync(settings, JSON.stringify(withHooksInstalled({}, 'claude-code', { posix: `"${exe}"`, windows: `"${exe}"` })));
    expect((await byName('claude-code hook（用户级）'))?.status).toBe('ok');
  });

  it('fails when the installed hook points at a program that is gone', async () => {
    const settings = path.join(root, 'home', '.claude', 'settings.json');
    mkdirSync(path.dirname(settings), { recursive: true });
    const gone = path.join(root, 'moved-away', 'lingspark');
    writeFileSync(settings, JSON.stringify(withHooksInstalled({}, 'claude-code', { posix: `"${gone}"`, windows: `"${gone}"` })));
    const c = await byName('claude-code hook（用户级）');
    expect(c?.status).toBe('fail');
    expect(c?.detail).toContain(gone);
  });

  it('warns when Codex config.toml also defines hooks', async () => {
    mkdirSync(path.join(root, 'home', '.codex'), { recursive: true });
    writeFileSync(path.join(root, 'home', '.codex', 'config.toml'), '[features]\nx = 1\n\n[hooks]\n');
    expect((await byName('Codex config.toml'))?.status).toBe('warn');
  });

  it('does not list agents that are not on this machine', async () => {
    const names = (await runDoctor(opts)).map((c) => c.name);
    expect(names.some((n) => n.startsWith('cursor'))).toBe(false);
    mkdirSync(path.join(root, 'home', '.cursor'), { recursive: true });
    expect((await runDoctor(opts)).some((c) => c.name.startsWith('cursor'))).toBe(true);
  });

  it('says an agent is not here when only its directory is (D-081)', async () => {
    // A directory other tools leave behind, and our hook in it: the hook line
    // below is true, and it still is not a working Cursor.
    const settings = path.join(root, 'home', '.cursor', 'hooks.json');
    mkdirSync(path.dirname(settings), { recursive: true });
    writeFileSync(settings, JSON.stringify(withHooksInstalled({}, 'cursor', { posix: '"/n/lingspark"', windows: '"/n/lingspark"' })));
    const c = (await runDoctor(opts)).find((x) => x.name === 'Cursor 程序');
    expect(c?.status).toBe('warn');
    expect(c?.detail).toContain('没找到 Cursor 本身');
  });

  it('passes the review mode the client itself recommends (D-078)', async () => {
    mkdirSync(path.join(root, 'data'), { recursive: true });
    // What `lingspark ui` writes for a person who has chosen nothing: the
    // agent reviews in its own conversation. Nothing here can be called, and
    // nothing is wrong -- so a fresh install must not report a failure.
    writeFileSync(path.join(root, 'data', 'config.yaml'), 'judge:\n  backend: session\n');
    const c = (await runDoctor(opts)).find((x) => x.name === '判定后端');
    expect(c?.status).toBe('ok');
    expect((await runDoctor(opts)).filter((x) => x.status === 'fail')).toEqual([]);
  });

  it('asks the configured judge one question and reports how it went', async () => {
    mkdirSync(path.join(root, 'data'), { recursive: true });
    writeFileSync(path.join(root, 'data', 'config.yaml'), 'judge:\n  backend: openai-compatible\n  endpoint: http://localhost:9/v1\n  model: m\n');
    const fetchImpl = (() => Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content: '{"ping":{"answer":true,"confidence":0.9}}' } }] })))) as unknown as typeof fetch;
    const c = (await runDoctor({ ...opts, fetchImpl })).find((x) => x.name === '判定后端');
    expect(c?.status).toBe('ok');
    expect(c?.detail).toContain('openai-compatible:m');
  });

  it('fails when the data directory cannot be written', async () => {
    writeFileSync(path.join(root, 'data'), 'a file where the directory should be');
    expect((await byName('数据目录'))?.status).toBe('fail');
  });
});
