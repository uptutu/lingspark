import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PathEnv } from '../paths.js';
import { extractPaths, parseHookInput, pathsFromApplyPatch, pathsFromCommand, SHELL_WRITE_WINDOW_MS } from './input.js';
import { gateFiles } from './gate.js';
import { SessionStore, sessionFileName } from './session.js';
import { MockJudge } from '../judge/mock.js';
import { runHook, type HookDeps } from './run.js';
import { reportPathFor } from './review.js';

const RULES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../rules-builtin/rules',
);
const builtinRules = readdirSync(RULES_DIR)
  .filter((n) => n.endsWith('.yaml'))
  .map((n) => ({ file: n, yaml: readFileSync(path.join(RULES_DIR, n), 'utf8') }));

const BAD_DOC = `# 方案

## 一、背景

以下三点需要确认：

- 甲
- 乙

## 二、方案

TODO: 补充回滚方案。
`;

const GOOD_DOC = `# 方案

## 一、背景

以下两点需要确认：

- 甲
- 乙

## 二、方案

回滚：出问题时切回人工流程。
`;

/* ------------------------------------------------------------ input */

describe('pathsFromApplyPatch', () => {
  it('reads added and updated files, and skips deleted ones', () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: docs/new.md',
      '+hello',
      '*** Update File: docs/prd.md',
      '@@',
      '-a',
      '+b',
      '*** Delete File: docs/old.md',
      '*** End Patch',
    ].join('\n');
    expect(pathsFromApplyPatch(patch)).toEqual(['docs/new.md', 'docs/prd.md']);
  });

  it('follows a move to the new name', () => {
    const patch = '*** Begin Patch\n*** Update File: a.md\n*** Move to: b.md\n@@\n*** End Patch';
    expect(pathsFromApplyPatch(patch)).toEqual(['b.md']);
  });

  it('returns nothing for text that is not a patch', () => {
    expect(pathsFromApplyPatch('ls -la && echo hi')).toEqual([]);
  });
});

describe('extractPaths', () => {
  const cwd = path.resolve(path.sep, 'w', 'p');

  it('reads every file-path field name the agents have used', () => {
    for (const key of ['file_path', 'filePath', 'path', 'notebook_path']) {
      expect(extractPaths({ [key]: 'docs/a.md' }, cwd)).toEqual([path.join(cwd, 'docs', 'a.md')]);
    }
  });

  it('keeps absolute paths as they are', () => {
    const abs = path.resolve(path.sep, 'else', 'x.md');
    expect(extractPaths({ file_path: abs }, cwd)).toEqual([abs]);
  });

  it('finds an apply_patch body in a string command', () => {
    const command = '*** Begin Patch\n*** Update File: docs/prd.md\n*** End Patch';
    expect(extractPaths({ command }, cwd)).toEqual([path.join(cwd, 'docs', 'prd.md')]);
  });

  it('finds an apply_patch body in an argv array', () => {
    const command = ['apply_patch', '*** Begin Patch\n*** Add File: x.md\n*** End Patch'];
    expect(extractPaths({ command }, cwd)).toEqual([path.join(cwd, 'x.md')]);
  });

  it('returns nothing for unknown shapes', () => {
    expect(extractPaths(null, cwd)).toEqual([]);
    expect(extractPaths('x', cwd)).toEqual([]);
    expect(extractPaths({ command: 'npm test' }, cwd)).toEqual([]);
  });
});

describe('documents written from the shell (D-067)', () => {
  it('names the Markdown files a command mentions, quoted or bare', () => {
    expect(pathsFromCommand("cat > docs/报告.md <<'EOF'\n# 标题\nEOF")).toEqual(['docs/报告.md']);
    expect(pathsFromCommand('tee "my notes.md" >/dev/null && echo ok>>b.markdown')).toEqual(['my notes.md', 'b.markdown']);
    expect(pathsFromCommand('cp draft.md $HOME/out/final.md')).toEqual(['draft.md', '~/out/final.md']);
    expect(pathsFromCommand('npm test && ls src')).toEqual([]);
  });

  it('counts a named file only if it has just changed, so reading one is not writing it', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lingspark-shell-'));
    try {
      writeFileSync(path.join(dir, 'new.md'), '# 新');
      writeFileSync(path.join(dir, 'old.md'), '# 旧');
      const now = Date.now();
      const later = now + SHELL_WRITE_WINDOW_MS + 60_000;
      const command = "cat old.md && cat > new.md <<'EOF'\n# 新\nEOF";
      expect(extractPaths({ command }, dir, now).sort()).toEqual([path.join(dir, 'new.md'), path.join(dir, 'old.md')]);
      // Long after: neither was written by this command.
      expect(extractPaths({ command }, dir, later)).toEqual([]);
      expect(extractPaths({ command: 'cat missing.md' }, dir, now)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads the command from an argv array too (Codex)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lingspark-shell-'));
    try {
      writeFileSync(path.join(dir, 'a.md'), '# a');
      expect(extractPaths({ command: ['bash', '-lc', 'printf x > a.md'] }, dir)).toEqual([path.join(dir, 'a.md')]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('parseHookInput', () => {
  it('normalises Claude Code input, using prompt_id as the turn', () => {
    const raw = JSON.stringify({
      session_id: 's',
      prompt_id: 'p',
      cwd: '/w',
      tool_input: { file_path: 'a.md' },
    });
    const input = parseHookInput(raw, 'claude-code', 'post-tool-use');
    expect(input?.turnId).toBe('p');
    expect(input?.stopHookActive).toBe(false);
    expect(input?.files).toHaveLength(1);
  });

  it('normalises Codex input, using turn_id and stop_hook_active', () => {
    const raw = JSON.stringify({ session_id: 's', turn_id: 't', cwd: '/w', stop_hook_active: true });
    const input = parseHookInput(raw, 'codex', 'stop');
    expect(input?.turnId).toBe('t');
    expect(input?.stopHookActive).toBe(true);
    expect(input?.files).toEqual([]);
  });

  it('rejects input it cannot use', () => {
    expect(parseHookInput('not json', 'codex', 'stop')).toBeNull();
    expect(parseHookInput('[]', 'codex', 'stop')).toBeNull();
    expect(parseHookInput('{"cwd":"/w"}', 'codex', 'stop')).toBeNull(); // no session id
  });
});

/* ------------------------------------------------------------ fixtures */

interface Fixture {
  root: string;
  project: string;
  doc: string;
  env: PathEnv;
  deps: HookDeps;
}

function makeFixture(): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), 'lingspark-hook-'));
  // A space and Chinese in the project path: both must survive (section 13).
  const project = path.join(root, '我的 项目');
  mkdirSync(path.join(project, '.lingspark'), { recursive: true });
  mkdirSync(path.join(project, 'docs'), { recursive: true });
  mkdirSync(path.join(project, 'src'), { recursive: true });
  writeFileSync(path.join(project, '.lingspark', 'config.yaml'), 'include: ["docs/**/*.md"]\n');
  const doc = path.join(project, 'docs', 'prd.md');
  writeFileSync(doc, BAD_DOC);
  writeFileSync(path.join(project, 'src', 'a.ts'), 'export {};\n');
  const env: PathEnv = {
    platform: process.platform,
    env: { LINGSPARK_DATA_DIR: path.join(root, 'data') },
    homedir: root,
  };
  return { root, project, doc, env, deps: { builtinRules, pathEnv: env } };
}

const post = (fx: Fixture, file: string, turn = 'p1', session = 's1'): string =>
  JSON.stringify({ session_id: session, prompt_id: turn, cwd: fx.project, tool_input: { file_path: file } });
const stop = (fx: Fixture, turn = 'p1', session = 's1'): string =>
  JSON.stringify({ session_id: session, prompt_id: turn, cwd: fx.project });

/* ------------------------------------------------------------ gate */

describe('gateFiles', () => {
  let fx: Fixture;
  beforeEach(() => (fx = makeFixture()));
  afterEach(() => rmSync(fx.root, { recursive: true, force: true }));

  it('keeps Markdown wherever it is, and drops code and agents\' own files', () => {
    const outside = path.join(fx.root, 'elsewhere', 'x.md');
    const memory = path.join(fx.root, '.claude', 'projects', 'p', 'memory', 'm.md');
    const plan = path.join(fx.root, '.codex', 'plans', 'p.md');
    expect(gateFiles([fx.doc, path.join(fx.project, 'src', 'a.ts'), outside, memory, plan])).toEqual([fx.doc, outside]);
  });
});

/* ------------------------------------------------------------ session */

describe('SessionStore', () => {
  let fx: Fixture;
  beforeEach(() => (fx = makeFixture()));
  afterEach(() => rmSync(fx.root, { recursive: true, force: true }));

  it('replays its own changes onto a concurrent writer instead of overwriting them', () => {
    const a = SessionStore.open('s', fx.env);
    const b = SessionStore.open('s', fx.env);
    a.addFiles(['/x.md']);
    a.bumpFingerprints(['fp']);
    b.addFiles(['/y.md']);
    b.bumpFingerprints(['fp']);
    a.save();
    b.save();
    const fresh = SessionStore.open('s', fx.env).snapshot;
    expect([...fresh.files].sort()).toEqual(['/x.md', '/y.md']);
    expect(fresh.fingerprints['fp']).toBe(2);
  });

  it('survives a corrupted state file', () => {
    const file = path.join(fx.root, 'data', 'sessions', 's.json');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '{ not json');
    expect(SessionStore.open('s', fx.env).snapshot.files).toEqual([]);
  });

  it('never lets a session id escape the sessions directory', () => {
    expect(sessionFileName('abc-123_X')).toBe('abc-123_X');
    const odd = sessionFileName('../../etc/passwd');
    expect(odd).toMatch(/^h-[0-9a-f]{32}$/u);
  });
});

/* ------------------------------------------------------------ runHook */

describe('runHook', () => {
  let fx: Fixture;
  beforeEach(() => (fx = makeFixture()));
  afterEach(() => rmSync(fx.root, { recursive: true, force: true }));

  it('passes a write to a non-document file without output', async () => {
    const r = await runHook(post(fx, path.join(fx.project, 'src', 'a.ts')), 'claude-code', 'post-tool-use', fx.deps);
    expect(r).toEqual({ exitCode: 0, stderr: '' });
  });

  it('checks a document outside any project: what the agent writes is what gets checked (D-050)', async () => {
    const other = path.join(fx.root, 'other');
    mkdirSync(other);
    writeFileSync(path.join(other, 'x.md'), BAD_DOC);
    const r = await runHook(post(fx, path.join(other, 'x.md')), 'claude-code', 'post-tool-use', fx.deps);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('[D111]');
  });

  it("passes an agent's own memory file", async () => {
    const memory = path.join(fx.root, '.claude', 'projects', 'p', 'memory', 'm.md');
    mkdirSync(path.dirname(memory), { recursive: true });
    writeFileSync(memory, BAD_DOC);
    const r = await runHook(post(fx, memory), 'claude-code', 'post-tool-use', fx.deps);
    expect(r).toEqual({ exitCode: 0, stderr: '' });
  });

  it('passes a document outside the include globs', async () => {
    const readme = path.join(fx.project, 'README.md');
    writeFileSync(readme, BAD_DOC);
    const r = await runHook(post(fx, readme), 'claude-code', 'post-tool-use', fx.deps);
    expect(r.exitCode).toBe(0);
  });

  it('passes a document that opts out in its frontmatter', async () => {
    writeFileSync(fx.doc, `---\nlingspark: false\n---\n\n${BAD_DOC}`);
    const r = await runHook(post(fx, fx.doc), 'claude-code', 'post-tool-use', fx.deps);
    expect(r.exitCode).toBe(0);
  });

  it('blocks on errors after a write and tells the model what to fix', async () => {
    const r = await runHook(post(fx, fx.doc), 'claude-code', 'post-tool-use', fx.deps);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('docs/prd.md');
    expect(r.stderr).toContain('[D111]');
    expect(r.stderr).toContain('[D108]');
    expect(r.stderr).toContain('不要自行添加 lingspark-disable');
  });

  it('does not repeat an error it already reported after an earlier write', async () => {
    expect(((await runHook(post(fx, fx.doc), 'claude-code', 'post-tool-use', fx.deps))).exitCode).toBe(2);
    expect(((await runHook(post(fx, fx.doc), 'claude-code', 'post-tool-use', fx.deps))).exitCode).toBe(0);
  });

  it('re-blocks pi on every write of the same bad document (D-102)', async () => {
    // pi acts on PostToolUse feedback by blocking the write itself; the
    // "tell once" dedup would let the model's retry through on the second,
    // identical write. Found live 2026-10-01.
    expect(((await runHook(post(fx, fx.doc), 'pi', 'post-tool-use', fx.deps))).exitCode).toBe(2);
    const retry = await runHook(post(fx, fx.doc), 'pi', 'post-tool-use', fx.deps);
    expect(retry.exitCode).toBe(2);
    expect(retry.stderr).toContain('[D111]');
  });

  it('blocks Stop while errors remain, at most once per turn', async () => {
    await runHook(post(fx, fx.doc), 'claude-code', 'post-tool-use', fx.deps);
    const first = await runHook(stop(fx), 'claude-code', 'stop', fx.deps);
    expect(first.exitCode).toBe(2);
    expect(first.stderr).toContain('结束之前');
    expect(((await runHook(stop(fx), 'claude-code', 'stop', fx.deps))).exitCode).toBe(0);
  });

  it('lets Stop through once the document is fixed', async () => {
    await runHook(post(fx, fx.doc), 'claude-code', 'post-tool-use', fx.deps);
    writeFileSync(fx.doc, GOOD_DOC);
    expect(((await runHook(stop(fx, 'p2'), 'claude-code', 'stop', fx.deps))).exitCode).toBe(0);
  });

  it('passes Stop when this session wrote no checked documents', async () => {
    expect(((await runHook(stop(fx, 'p1', 'fresh'), 'claude-code', 'stop', fx.deps))).exitCode).toBe(0);
  });

  it('honours Codex stop_hook_active', async () => {
    await runHook(post(fx, fx.doc, 't1', 'c1'), 'codex', 'post-tool-use', fx.deps);
    const raw = JSON.stringify({ session_id: 'c1', turn_id: 't9', cwd: fx.project, stop_hook_active: true });
    expect(((await runHook(raw, 'codex', 'stop', fx.deps))).exitCode).toBe(0);
  });

  it('stops blocking an error the model has failed to fix three times (loop guard)', async () => {
    await runHook(post(fx, fx.doc), 'claude-code', 'post-tool-use', fx.deps);
    const codes: number[] = [];
    for (const turn of ['t1', 't2', 't3', 't4']) {
      codes.push((((await runHook(stop(fx, turn), 'claude-code', 'stop', fx.deps)))).exitCode);
    }
    expect(codes).toEqual([2, 2, 0, 0]);
    const logFile = path.join(fx.root, 'data', 'logs', 'lingspark.log');
    expect(readFileSync(logFile, 'utf8')).toContain('循环保护');
  });

  it('shows each warning once per session at Stop', async () => {
    writeFileSync(fx.doc, GOOD_DOC.replace('## 二、方案\n\n回滚：出问题时切回人工流程。\n', '## 二、方案\n\n#### 跳级标题\n\n正文。\n'));
    await runHook(post(fx, fx.doc), 'claude-code', 'post-tool-use', fx.deps);
    const first = await runHook(stop(fx, 't1'), 'claude-code', 'stop', fx.deps);
    expect(first.exitCode).toBe(2);
    expect(first.stderr).toContain('[D105]');
    expect(((await runHook(stop(fx, 't2'), 'claude-code', 'stop', fx.deps))).exitCode).toBe(0);
  });

  /* D-087: warnings decay and escalate. */

  const WARN_DOC = GOOD_DOC.replace('## 二、方案\n\n回滚：出问题时切回人工流程。\n', '## 二、方案\n\n#### 跳级标题\n\n正文。\n');

  /** Ages every warning record in the session file and optionally sets its count. */
  const ageWarnings = (daysAgo: number, count?: number): void => {
    const file = path.join(fx.root, 'data', 'sessions', 's1.json');
    const s = JSON.parse(readFileSync(file, 'utf8')) as {
      warnings: Record<string, { last: string; count: number }>;
    };
    const last = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
    for (const k of Object.keys(s.warnings)) s.warnings[k] = { last, count: count ?? s.warnings[k]!.count };
    writeFileSync(file, JSON.stringify(s));
  };

  it('re-shows a warning after the decay window (D-087)', async () => {
    writeFileSync(fx.doc, WARN_DOC);
    await runHook(post(fx, fx.doc), 'claude-code', 'post-tool-use', fx.deps);
    expect(((await runHook(stop(fx, 't1'), 'claude-code', 'stop', fx.deps))).exitCode).toBe(2);
    // Same window: not due again.
    expect(((await runHook(stop(fx, 't2'), 'claude-code', 'stop', fx.deps))).exitCode).toBe(0);
    // Age it past the decay window: shown again.
    ageWarnings(10);
    const again = await runHook(stop(fx, 't3'), 'claude-code', 'stop', fx.deps);
    expect(again.exitCode).toBe(2);
    expect(again.stderr).toContain('[D105]');
  });

  it('escalates a repeatedly unheeded warning to blocking every turn (D-087)', async () => {
    writeFileSync(fx.doc, WARN_DOC);
    await runHook(post(fx, fx.doc), 'claude-code', 'post-tool-use', fx.deps);
    expect(((await runHook(stop(fx, 't1'), 'claude-code', 'stop', fx.deps))).exitCode).toBe(2); // showing #1
    // Pretend it was shown once more long ago: this showing makes #3 -> escalated.
    ageWarnings(10, 2);
    expect(((await runHook(stop(fx, 't2'), 'claude-code', 'stop', fx.deps))).exitCode).toBe(2);
    // Not due as a warning, but escalated: still blocks, like an error.
    const blocked = await runHook(stop(fx, 't3'), 'claude-code', 'stop', fx.deps);
    expect(blocked.exitCode).toBe(2);
    expect(blocked.stderr).toContain('[D105]');
    // The loop guard eventually releases it, as it does any error.
    for (const turn of ['t4', 't5', 't6']) await runHook(stop(fx, turn), 'claude-code', 'stop', fx.deps);
    expect(((await runHook(stop(fx, 't7'), 'claude-code', 'stop', fx.deps))).exitCode).toBe(0);
  });

  it('writes a stats line per checked file', async () => {
    await runHook(post(fx, fx.doc), 'claude-code', 'post-tool-use', fx.deps);
    const lines = readFileSync(path.join(fx.root, 'data', 'stats', 'runs.jsonl'), 'utf8').trim().split('\n');
    const rec = JSON.parse(lines[0] ?? '{}') as { hits: Record<string, number>; blocked: number };
    expect(rec.hits['D111']).toBe(1);
    expect(rec.blocked).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------ amber list (D-090) */

describe('amber list (D-090)', () => {
  // A paragraph long enough to be judged (MIN_JUDGED_CHARS) and free of
  // deterministic errors: amber comes from the judge alone.
  const LONG_DOC = '## 一、背景\n\n本期要先把工单处理时长降下来，这是客服团队目前最痛的问题，没有之一。\n';

  let fx: Fixture;
  beforeEach(() => {
    fx = makeFixture();
    mkdirSync(path.join(fx.root, 'data'), { recursive: true });
    // Any non-session backend: no in-session review text in these assertions.
    writeFileSync(path.join(fx.root, 'data', 'config.yaml'), 'judge:\n  backend: anthropic\n');
    writeFileSync(fx.doc, LONG_DOC);
  });
  afterEach(() => rmSync(fx.root, { recursive: true, force: true }));

  // 0.5 sits between T_LOW (0.4) and the report threshold (0.7): amber, no diagnostic.
  const deps = (): HookDeps => ({ ...fx.deps, judge: new MockJudge(() => 0.5) });

  const intercepts = (): { rule: string; why: string }[] => {
    const f = path.join(fx.root, 'data', 'stats', 'intercepts.jsonl');
    if (!existsSync(f)) return [];
    return readFileSync(f, 'utf8')
      .trim()
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l) as { rule: string; why: string });
  };

  it('amber alone never blocks, and is recorded for the client', async () => {
    await runHook(post(fx, fx.doc), 'claude-code', 'post-tool-use', deps());
    const r = await runHook(stop(fx, 't1'), 'claude-code', 'stop', deps());
    expect(r.exitCode).toBe(0);
    expect(intercepts().some((i) => i.why.includes('把握'))).toBe(true);
  });

  it('amber rides along when Stop blocks for real problems', async () => {
    writeFileSync(fx.doc, `${LONG_DOC}\nTODO: 补充数据口径。\n`);
    await runHook(post(fx, fx.doc), 'claude-code', 'post-tool-use', deps());
    const r = await runHook(stop(fx, 't1'), 'claude-code', 'stop', deps());
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('琥珀清单');
    expect(r.stderr).toContain('[D108]');
  });
});

/* ------------------------------------------------------------ term candidates (D-091) */

describe('term candidates (D-091)', () => {
  // Two spellings of one metric, each frequent, neither in the (empty) glossary.
  const DRIFT_DOC = [
    '## 指标口径',
    '',
    '日活跃用户是核心指标。日活跃用户每天统计一次。',
    '',
    '运营侧叫日活用户。日活用户不参与分成。',
  ].join('\n');

  let fx: Fixture;
  beforeEach(() => {
    fx = makeFixture();
    mkdirSync(path.join(fx.root, 'data'), { recursive: true });
    writeFileSync(path.join(fx.root, 'data', 'config.yaml'), 'judge:\n  backend: anthropic\n');
    writeFileSync(fx.doc, DRIFT_DOC);
  });
  afterEach(() => rmSync(fx.root, { recursive: true, force: true }));

  const records = (): { file: string; candidates: { a: string; b: string }[] }[] => {
    const f = path.join(fx.root, 'data', 'feedback', 'term-candidates.jsonl');
    if (!existsSync(f)) return [];
    return readFileSync(f, 'utf8')
      .trim()
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l) as { file: string; candidates: { a: string; b: string }[] });
  };

  it('PostToolUse persists machine-proposed term pairs for `lingspark terms`', async () => {
    await runHook(post(fx, fx.doc), 'claude-code', 'post-tool-use', fx.deps);
    const all = records().flatMap((r) => r.candidates.map((c) => [c.a, c.b].sort().join('|')));
    expect(all).toContain('日活用户|日活跃用户');
  });
});

/* ------------------------------------------------------------ suppression attribution (D-092) */

describe('suppression attribution (D-092)', () => {
  const SUPPRESSED_DOC = `# 方案\n\n## 二、方案\n\n<!-- lingspark-disable D108 -->\n\nTODO: 补充回滚方案。\n`;
  const OPTED_OUT_DOC = '---\nlingspark: false\n---\n\n# 方案\n\nTODO: 补充回滚方案。\n';

  let fx: Fixture;
  beforeEach(() => {
    fx = makeFixture();
    mkdirSync(path.join(fx.root, 'data'), { recursive: true });
    writeFileSync(path.join(fx.root, 'data', 'config.yaml'), 'judge:\n  backend: anthropic\n');
  });
  afterEach(() => rmSync(fx.root, { recursive: true, force: true }));

  // tool_input carries the whole new content: the write introduced everything in it.
  const postWithContent = (file: string, content: string): string =>
    JSON.stringify({ session_id: 's1', prompt_id: 'p1', cwd: fx.project, tool_input: { file_path: file, content } });

  it('a suppression comment the agent wrote does not silence the error in the same write', async () => {
    writeFileSync(fx.doc, SUPPRESSED_DOC);
    const r = await runHook(postWithContent(fx.doc, SUPPRESSED_DOC), 'claude-code', 'post-tool-use', fx.deps);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('[D108]');
    // And Stop still sees it: the attribution survives in the session.
    const stop = await runHook(JSON.stringify({ session_id: 's1', prompt_id: 'p1', cwd: fx.project }), 'claude-code', 'stop', fx.deps);
    expect(stop.exitCode).toBe(2);
    expect(stop.stderr).toContain('[D108]');
  });

  it("the same comment, written by the user, still silences the error", async () => {
    // The file carries the directive, but this tool call's payload does not:
    // the directive predates the write and is the user's.
    writeFileSync(fx.doc, SUPPRESSED_DOC);
    const r = await runHook(postWithContent(fx.doc, '只调整了下措辞。'), 'claude-code', 'post-tool-use', fx.deps);
    expect(r.exitCode).toBe(0);
  });

  it("`lingspark: false` frontmatter the agent wrote does not opt the file out", async () => {
    writeFileSync(fx.doc, OPTED_OUT_DOC);
    const r = await runHook(postWithContent(fx.doc, OPTED_OUT_DOC), 'claude-code', 'post-tool-use', fx.deps);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('[D108]');
  });

  it('counts refused self-suppressions in the per-file stats', async () => {
    writeFileSync(fx.doc, SUPPRESSED_DOC);
    await runHook(postWithContent(fx.doc, SUPPRESSED_DOC), 'claude-code', 'post-tool-use', fx.deps);
    const runs = readFileSync(path.join(fx.root, 'data', 'stats', 'runs.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { agentSuppress?: number });
    expect(runs[0]?.agentSuppress).toBe(1);
  });
});

/* ------------------------------------------------------------ deliverables rescue (D-093) */

describe('deliverables rescue (D-093)', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = makeFixture();
    mkdirSync(path.join(fx.root, 'data'), { recursive: true });
    writeFileSync(path.join(fx.root, 'data', 'config.yaml'), 'judge:\n  backend: anthropic\n');
    writeFileSync(
      path.join(fx.project, '.lingspark', 'config.yaml'),
      'include: ["docs/**/*.md"]\ndeliverables: ["site/**/*.html"]\n',
    );
    mkdirSync(path.join(fx.project, 'site'), { recursive: true });
  });
  afterEach(() => rmSync(fx.root, { recursive: true, force: true }));

  it('a declared deliverable is checked though the gate drops non-Markdown', async () => {
    const html = path.join(fx.project, 'site', 'report.html');
    writeFileSync(html, '<h1>报告</h1>\n\nTODO: 补充数据来源。\n');
    const r = await runHook(post(fx, html), 'claude-code', 'post-tool-use', fx.deps);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('[D108]');
  });

  it('a non-declared non-Markdown file stays a no-op', async () => {
    const css = path.join(fx.project, 'site', 'style.css');
    writeFileSync(css, 'body { color: red; }\n');
    const r = await runHook(post(fx, css), 'claude-code', 'post-tool-use', fx.deps);
    expect(r.exitCode).toBe(0);
  });
});

/* ------------------------------------------------------------ in-session review (D-057) */

describe('in-session review', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = makeFixture();
    mkdirSync(path.join(fx.root, 'data'), { recursive: true });
    writeFileSync(path.join(fx.root, 'data', 'config.yaml'), 'judge:\n  backend: session\n');
    writeFileSync(fx.doc, GOOD_DOC);
  });
  afterEach(() => rmSync(fx.root, { recursive: true, force: true }));

  const report = (session = 's1'): string => reportPathFor(fx.project, session);
  const runs = (): { event: string; findings?: number; suspicious?: number }[] =>
    readFileSync(path.join(fx.root, 'data', 'stats', 'runs.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { event: string; findings?: number; suspicious?: number });

  it('asks the writing agent to review its documents at the end of the turn', async () => {
    await runHook(post(fx, fx.doc), 'claude-code', 'post-tool-use', fx.deps);
    const r = await runHook(stop(fx, 't1'), 'claude-code', 'stop', fx.deps);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('LingSpark 审稿');
    expect(r.stderr).toContain('docs/prd.md');
    expect(r.stderr).toContain('[S204]'); // the criteria come from the rules themselves
    expect(r.stderr).toContain(report());
    expect(r.warmSession).toBeUndefined(); // no model to warm up for
  });

  it('asks once a turn, takes the report in, and does not ask again for unchanged documents', async () => {
    await runHook(post(fx, fx.doc), 'claude-code', 'post-tool-use', fx.deps);
    await runHook(stop(fx, 't1'), 'claude-code', 'stop', fx.deps);
    // The agent stops again in the same turn without a report: not asked twice.
    expect((await runHook(stop(fx, 't1'), 'claude-code', 'stop', fx.deps)).exitCode).toBe(0);

    writeFileSync(report(), JSON.stringify({ findings: [{ file: 'docs/prd.md', rule: 'S204', quote: '回滚：出问题时切回人工流程。', fixed: false }] }));
    expect((await runHook(stop(fx, 't1'), 'claude-code', 'stop', fx.deps)).exitCode).toBe(0);
    expect(existsSync(report())).toBe(false); // taken in and removed from the user's folder
    expect(runs().find((r) => r.event === 'review')?.findings).toBe(1);

    // Next turn, nothing changed: nothing to review.
    expect((await runHook(stop(fx, 't2'), 'claude-code', 'stop', fx.deps)).exitCode).toBe(0);
    // The document changes: reviewed again.
    writeFileSync(fx.doc, `${GOOD_DOC}\n补充一段。\n`);
    expect((await runHook(stop(fx, 't3'), 'claude-code', 'stop', fx.deps)).stderr).toContain('LingSpark 审稿');
  });

  it('takes the report in even when the agent says the turn was already continued', async () => {
    await runHook(post(fx, fx.doc, 't1', 'c1'), 'codex', 'post-tool-use', fx.deps);
    const raw = (active: boolean): string =>
      JSON.stringify({ session_id: 'c1', turn_id: 't1', cwd: fx.project, stop_hook_active: active });
    expect((await runHook(raw(false), 'codex', 'stop', fx.deps)).exitCode).toBe(2);
    writeFileSync(report('c1'), '{"findings":[]}');
    expect((await runHook(raw(true), 'codex', 'stop', fx.deps)).exitCode).toBe(0);
    expect(existsSync(report('c1'))).toBe(false);
  });

  it("never takes in another conversation's report from the same folder", async () => {
    await runHook(post(fx, fx.doc, 't1', 'a'), 'claude-code', 'post-tool-use', fx.deps);
    await runHook(post(fx, fx.doc, 't1', 'b'), 'claude-code', 'post-tool-use', fx.deps);
    await runHook(stop(fx, 't1', 'a'), 'claude-code', 'stop', fx.deps);
    await runHook(stop(fx, 't1', 'b'), 'claude-code', 'stop', fx.deps);
    writeFileSync(report('a'), '{"findings":[]}');
    await runHook(stop(fx, 't2', 'b'), 'claude-code', 'stop', fx.deps);
    expect(existsSync(report('a'))).toBe(true); // b left a's report alone
  });

  it('stops asking an agent that never hands in a report', async () => {
    await runHook(post(fx, fx.doc), 'claude-code', 'post-tool-use', fx.deps);
    const asked: boolean[] = [];
    for (const turn of ['t1', 't2', 't3', 't4', 't5']) {
      asked.push((await runHook(stop(fx, turn), 'claude-code', 'stop', fx.deps)).stderr.includes('LingSpark 审稿'));
    }
    expect(asked).toEqual([true, true, true, false, false]);
  });

  it('does not take a report at its word when its quotes are nowhere to be found (D-094)', async () => {
    await runHook(post(fx, fx.doc), 'claude-code', 'post-tool-use', fx.deps);
    await runHook(stop(fx, 't1'), 'claude-code', 'stop', fx.deps);
    // Nothing was edited, and this passage is in no document we wrote.
    writeFileSync(
      report(),
      JSON.stringify({ findings: [{ file: 'docs/prd.md', rule: 'S204', quote: '这段从来没写过', fixed: false }] }),
    );
    await runHook(stop(fx, 't1'), 'claude-code', 'stop', fx.deps);

    const intercepted = readFileSync(path.join(fx.root, 'data', 'stats', 'intercepts.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { how?: string; suspicious?: boolean });
    expect(intercepted.find((r) => r.how === 'review')?.suspicious).toBe(true);
    expect(runs().find((r) => r.event === 'review')?.suspicious).toBe(1);
  });
});

/* ------------------------------------------------------------ Stop and the warm-up (D-052) */

describe('Stop and the background warm-up', () => {
  let fx: Fixture;
  beforeEach(() => (fx = makeFixture()));
  afterEach(() => rmSync(fx.root, { recursive: true, force: true }));

  const lockFor = (session: string): string =>
    path.join(fx.root, 'data', 'warm', `${createHash('sha256').update(session).digest('hex').slice(0, 16)}.lock`);

  it('waits for a running warm-up instead of asking the same questions, and still reports in time', async () => {
    await runHook(post(fx, fx.doc), 'claude-code', 'post-tool-use', fx.deps);
    mkdirSync(path.dirname(lockFor('s1')), { recursive: true });
    writeFileSync(lockFor('s1'), String(process.pid)); // a live warm-up: this very process
    const started = Date.now();
    const r = await runHook(stop(fx), 'claude-code', 'stop', { ...fx.deps, stopBudgetMs: 2_500 });
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(r.exitCode).toBe(2); // the rules that need no model still report
    expect(r.warmSession).toBeUndefined(); // the running warm-up picks up the queue itself
  });

  it('hands the cross-document check to the warm-up when there is no time left for it', async () => {
    await runHook(post(fx, fx.doc), 'claude-code', 'post-tool-use', fx.deps);
    const r = await runHook(stop(fx), 'claude-code', 'stop', { ...fx.deps, stopBudgetMs: 1_000 });
    expect(r.warmSession).toBe('s1');
  });
});

/* ------------------------------------------------------------ Cursor */

// Payloads shaped as https://cursor.com/docs/agent/hooks documents them.
const cursorBase = (fx: Fixture, gen = 'g1') => ({
  conversation_id: 'c1',
  generation_id: gen,
  model: 'm',
  cursor_version: '3.21.18',
  workspace_roots: [fx.project],
  user_email: null,
  transcript_path: null,
});
const cursorEdit = (fx: Fixture, file: string): string =>
  JSON.stringify({ ...cursorBase(fx), hook_event_name: 'afterFileEdit', file_path: file, edits: [{ old_string: '', new_string: 'x' }] });
const cursorStop = (fx: Fixture, loopCount = 0, gen = 'g1'): string =>
  JSON.stringify({ ...cursorBase(fx, gen), hook_event_name: 'stop', status: 'completed', loop_count: loopCount });

describe('runHook under Cursor', () => {
  let fx: Fixture;
  beforeEach(() => (fx = makeFixture()));
  afterEach(() => rmSync(fx.root, { recursive: true, force: true }));

  it('reads the conversation, the workspace root and the edited file', () => {
    const input = parseHookInput(cursorEdit(fx, fx.doc), 'cursor', 'post-tool-use');
    expect(input).toMatchObject({ sessionId: 'c1', turnId: 'g1', cwd: fx.project, files: [fx.doc], cursor: true });
  });

  it('stays quiet after an edit and hands the problems over as a follow-up at stop', async () => {
    const edit = await runHook(cursorEdit(fx, fx.doc), 'cursor', 'post-tool-use', fx.deps);
    expect(edit).toMatchObject({ exitCode: 0, stderr: '' });
    expect(edit.stdout).toBeUndefined();

    const r = await runHook(cursorStop(fx), 'cursor', 'stop', fx.deps);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout ?? '{}') as { followup_message?: string };
    expect(out.followup_message).toContain('docs/prd.md');
    expect(out.followup_message).toContain('[D111]');
  });

  it('never restarts a turn the user stopped', async () => {
    await runHook(cursorEdit(fx, fx.doc), 'cursor', 'post-tool-use', fx.deps);
    const aborted = JSON.stringify({ ...cursorBase(fx), hook_event_name: 'stop', status: 'aborted', loop_count: 0 });
    expect(await runHook(aborted, 'cursor', 'stop', fx.deps)).toEqual({ exitCode: 0, stderr: '' });
  });

  it('follows up at most once per turn', async () => {
    await runHook(cursorEdit(fx, fx.doc), 'cursor', 'post-tool-use', fx.deps);
    const again = await runHook(cursorStop(fx, 1, 'g2'), 'cursor', 'stop', fx.deps);
    expect(again).toEqual({ exitCode: 0, stderr: '' });
  });

  it("answers in Claude Code's format when Cursor runs the Claude Code hook", async () => {
    await runHook(cursorEdit(fx, fx.doc), 'claude-code', 'post-tool-use', fx.deps);
    const r = await runHook(cursorStop(fx), 'claude-code', 'stop', fx.deps);
    expect(JSON.parse(r.stdout ?? '{}')).toMatchObject({ decision: 'block' });
  });

  it('leaves the answer to its own hook when both are installed', async () => {
    mkdirSync(path.join(fx.root, '.cursor'));
    writeFileSync(
      path.join(fx.root, '.cursor', 'hooks.json'),
      JSON.stringify({ version: 1, hooks: { stop: [{ command: '"/x/lingspark" hook --agent cursor --event stop' }] } }),
    );
    await runHook(cursorEdit(fx, fx.doc), 'cursor', 'post-tool-use', fx.deps);
    expect(await runHook(cursorStop(fx), 'claude-code', 'stop', fx.deps)).toEqual({ exitCode: 0, stderr: '' });
    expect((await runHook(cursorStop(fx), 'cursor', 'stop', fx.deps)).stdout).toContain('followup_message');
  });
});

/* ------------------------------------------------------------ fail-open (section 13) */

describe('fail-open', () => {
  let fx: Fixture;
  beforeEach(() => (fx = makeFixture()));
  afterEach(() => {
    try {
      chmodSync(path.join(fx.root, 'data'), 0o755);
      chmodSync(path.join(fx.root, 'data', 'sessions'), 0o755);
    } catch {
      // may not exist
    }
    rmSync(fx.root, { recursive: true, force: true });
  });

  it('exits 0 when stdin is not JSON', async () => {
    expect(((await runHook('{{{', 'claude-code', 'post-tool-use', fx.deps))).exitCode).toBe(0);
    expect(((await runHook('', 'claude-code', 'stop', fx.deps))).exitCode).toBe(0);
  });

  it('exits 0 when the project config is broken', async () => {
    writeFileSync(path.join(fx.project, '.lingspark', 'config.yaml'), 'include: [unclosed\n');
    expect(((await runHook(post(fx, fx.doc), 'claude-code', 'post-tool-use', fx.deps))).exitCode).toBe(0);
  });

  it('exits 0 when the project config carries a credential', async () => {
    writeFileSync(path.join(fx.project, '.lingspark', 'config.yaml'), 'judge:\n  api_key: x\n');
    expect(((await runHook(post(fx, fx.doc), 'claude-code', 'post-tool-use', fx.deps))).exitCode).toBe(0);
  });

  it('keeps checking with the other rules when one rule file is broken', async () => {
    mkdirSync(path.join(fx.project, '.lingspark', 'rules'));
    writeFileSync(path.join(fx.project, '.lingspark', 'rules', 'T-0001.yaml'), 'id: [broken\n');
    const r = await runHook(post(fx, fx.doc), 'claude-code', 'post-tool-use', fx.deps);
    expect(r.exitCode).toBe(2);
  });

  it('exits 0 when the file was deleted before the check ran', async () => {
    rmSync(fx.doc);
    expect(((await runHook(post(fx, fx.doc), 'claude-code', 'post-tool-use', fx.deps))).exitCode).toBe(0);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'still reports after a write, but never blocks Stop, when state cannot be saved',
    async () => {
      await runHook(post(fx, fx.doc, 'p0', 'ro'), 'claude-code', 'post-tool-use', fx.deps);
      const data = path.join(fx.root, 'data');
      chmodSync(path.join(data, 'sessions'), 0o500);
      chmodSync(data, 0o500);
      // After a write: the model must still hear about real errors.
      writeFileSync(fx.doc, BAD_DOC.replace('TODO', 'FIXME'));
      expect(((await runHook(post(fx, fx.doc, 'p1', 'ro'), 'claude-code', 'post-tool-use', fx.deps))).exitCode).toBe(2);
      // At Stop: without a persisted per-turn cap the block could repeat
      // forever, so Stop must let the turn end.
      expect(((await runHook(stop(fx, 'p1', 'ro'), 'claude-code', 'stop', fx.deps))).exitCode).toBe(0);
      chmodSync(path.join(data, 'sessions'), 0o755);
    },
  );
});
