import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appendJsonl } from '../log.js';
import { dataPaths, type PathEnv } from '../paths.js';
import { parseDocument } from '../parser/parse.js';
import { buildGlossary, EMPTY_GLOSSARY } from './glossary.js';
import { detectTermCandidates } from './term-candidates.js';
import { formatTermCandidates, termCandidateTallies } from '../term-candidates-report.js';

const docOf = (text: string) => parseDocument(text, { file: 't.md' });

describe('detectTermCandidates (D-091)', () => {
  it('proposes two frequent spellings of one term, containment or similar', () => {
    const text = [
      '我们使用日活跃用户作为核心指标。',
      '日活跃用户每天统计一次。',
      '运营口径里叫日活用户。',
      '日活用户不参与分成计算。',
      '',
      '缓存放在内存里。',
      '离线缓存会在启动时预热。',
      '缓存的键是用户 ID。',
      '离线缓存失效后回源。',
    ].join('\n');
    const found = detectTermCandidates(docOf(text), EMPTY_GLOSSARY);
    const pairs = found.map((c) => [c.a, c.b].sort().join('|'));
    expect(pairs).toContain('日活用户|日活跃用户');
    expect(pairs).toContain('离线缓存|缓存');
  });

  it('never proposes a string the glossary already owns', () => {
    const glossary = buildGlossary([
      { preferred: '日活跃用户', aliases_allowed: [], forbidden: ['日活用户'] },
    ]);
    const text = '日活跃用户是核心指标。日活跃用户每日统计。口径叫日活用户。日活用户不分成。';
    const found = detectTermCandidates(docOf(text), glossary);
    const pairs = found.map((c) => [c.a, c.b].sort().join('|'));
    expect(pairs).not.toContain('日活用户|日活跃用户');
  });

  it('ignores one-off strings: both spellings must appear at least twice', () => {
    const text = '日活跃用户是核心指标。口径偶尔也叫日活用户，但只有这一次。';
    const found = detectTermCandidates(docOf(text), EMPTY_GLOSSARY);
    expect(found).toEqual([]);
  });

  it('unrelated frequent strings are not proposed', () => {
    const text = [
      '版本号在配置里。版本号每周检查。',
      '测试环境单独部署。测试环境不连生产库。',
    ].join('\n');
    const found = detectTermCandidates(docOf(text), EMPTY_GLOSSARY);
    expect(found).toEqual([]);
  });
});

describe('termCandidateTallies (D-091)', () => {
  it('aggregates the same pair across files, newest and widest first', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'lingspark-terms-'));
    const env: PathEnv = { platform: 'linux', env: { XDG_DATA_HOME: root }, homedir: root };
    appendJsonl(dataPaths.termCandidates(env), {
      ts: '2026-09-30T10:00:00Z',
      agent: 'claude-code',
      file: '/a.md',
      candidates: [{ a: '日活用户', b: '日活跃用户', countA: 2, countB: 3, kind: 'similarity' }],
    });
    appendJsonl(dataPaths.termCandidates(env), {
      ts: '2026-09-30T12:00:00Z',
      agent: 'claude-code',
      file: '/b.md',
      candidates: [{ a: '日活跃用户', b: '日活用户', countA: 4, countB: 2, kind: 'similarity' }],
    });
    appendJsonl(dataPaths.termCandidates(env), {
      ts: '2026-09-30T11:00:00Z',
      agent: 'codex',
      file: '/c.md',
      candidates: [{ a: '缓存', b: '离线缓存', countA: 2, countB: 2, kind: 'containment' }],
    });

    const rows = termCandidateTallies(env);
    expect(rows.length).toBe(2);
    // Same pair from two files beats a one-file pair.
    expect(rows[0]).toMatchObject({ a: '日活用户', b: '日活跃用户', files: 2, occurrences: 4 });
    expect(rows[1]).toMatchObject({ files: 1 });

    const printed = formatTermCandidates(rows);
    expect(printed).toContain('日活用户');
    expect(printed).toContain('术语候选');
  });

  it('an empty log formats without throwing', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'lingspark-terms-'));
    const env: PathEnv = { platform: 'linux', env: { XDG_DATA_HOME: root }, homedir: root };
    expect(termCandidateTallies(env)).toEqual([]);
    expect(formatTermCandidates([])).toContain('术语候选');
  });
});
