import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveConfig } from './resolve.js';
import { ConfigError, findCredentialKey, loadProjectConfig, loadConfig } from './load.js';
import { createMatcher, toProjectRelative } from './matcher.js';
import { DEFAULT_INCLUDE, DEFAULT_PASSES } from './defaults.js';
import type { ProjectConfigFile, UserConfigFile } from './schema.js';

describe('resolveConfig', () => {
  it('applies cli > project > user > default for scalars', () => {
    const user: UserConfigFile = { judge: { threshold_report: 0.5 } };
    const project: ProjectConfigFile = { judge: { threshold_report: 0.8 } };

    expect(resolveConfig({ projectRoot: '/p', project, user }).judge.thresholdReport).toBe(0.8);
    expect(resolveConfig({ projectRoot: '/p', project: null, user }).judge.thresholdReport).toBe(0.5);
    expect(
      resolveConfig({ projectRoot: '/p', project: null, user: null }).judge.thresholdReport,
    ).toBe(0.7);
  });

  it('lets the cli override the project for passes', () => {
    const project: ProjectConfigFile = { passes: { hook_post: [0] } };
    const r = resolveConfig({ projectRoot: '/p', project, user: null, cli: { passes: [0, 1] } });
    expect(r.passes.hookPost).toEqual([0, 1]);
    expect(r.passes.hookStop).toEqual([0, 1]);
  });

  it('falls back to the default pass sets', () => {
    const r = resolveConfig({ projectRoot: '/p', project: null, user: null });
    expect(r.passes.hookPost).toEqual(DEFAULT_PASSES.hookPost);
    expect(r.passes.hookStop).toEqual(DEFAULT_PASSES.hookStop);
  });

  it('unions rules.disable across layers instead of overriding', () => {
    const r = resolveConfig({
      projectRoot: '/p',
      project: { rules: { disable: ['D107'] } },
      user: { rules: { disable: ['S204'] } },
    });
    expect([...r.rules.disable].sort()).toEqual(['D107', 'S204']);
  });

  it('lets the project override a severity the user also set', () => {
    const r = resolveConfig({
      projectRoot: '/p',
      project: { rules: { severity: { S204: 'error' } } },
      user: { rules: { severity: { S204: 'info' } } },
    });
    expect(r.rules.severity.get('S204')).toBe('error');
  });

  it('turns offline on if any layer asks for it', () => {
    expect(resolveConfig({ projectRoot: '/p', project: null, user: { offline: true } }).offline).toBe(true);
    expect(resolveConfig({ projectRoot: '/p', project: { offline: true }, user: null }).offline).toBe(true);
    expect(
      resolveConfig({ projectRoot: '/p', project: { offline: false }, user: null, cli: { offline: true } })
        .offline,
    ).toBe(true);
    expect(resolveConfig({ projectRoot: '/p', project: null, user: null }).offline).toBe(false);
  });

  it('keeps built-in required sections and lets a project replace one doc type', () => {
    const r = resolveConfig({
      projectRoot: '/p',
      project: { required_sections: { prd: [['缘起']] } },
      user: null,
    });
    expect(r.requiredSections.get('prd')).toEqual([['缘起']]);
    // untouched doc types keep their defaults
    expect(r.requiredSections.get('report')?.[0]).toEqual(['结论', '摘要', '概述']);
  });

  it('defaults allow_inline_suppress to true', () => {
    expect(resolveConfig({ projectRoot: null, project: null, user: null }).allowInlineSuppress).toBe(true);
  });

  it('reads miner settings only from the user layer, defaulting to off', () => {
    const r = resolveConfig({ projectRoot: '/p', project: null, user: { miner: { enabled: true } } });
    expect(r.miner.enabled).toBe(true);
    expect(r.miner.projects).toEqual([]);
    expect(resolveConfig({ projectRoot: '/p', project: null, user: null }).miner.enabled).toBe(false);
  });
});

describe('findCredentialKey', () => {
  it('finds a credential key at any depth', () => {
    expect(findCredentialKey({ judge: { api_key: 'x' } })).toBe('api_key');
    expect(findCredentialKey({ a: [{ b: { TOKEN: 'x' } }] })).toBe('TOKEN');
  });

  it('does not flag ordinary config', () => {
    expect(findCredentialKey({ judge: { backend: 'typesafe', model: 'jev-latest' } })).toBeNull();
    expect(findCredentialKey({ include: ['docs/**/*.md'] })).toBeNull();
  });

  it('stops rather than recursing forever on a cyclic object', () => {
    const a: Record<string, unknown> = {};
    a['self'] = a;
    expect(findCredentialKey(a)).toBeNull();
  });
});

describe('loadProjectConfig', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'lingspark-cfg-'));
    mkdirSync(path.join(root, '.lingspark'), { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const write = (yaml: string) =>
    writeFileSync(path.join(root, '.lingspark', 'config.yaml'), yaml, 'utf8');

  it('returns null when the project has no config file', () => {
    rmSync(path.join(root, '.lingspark'), { recursive: true });
    expect(loadProjectConfig(root).config).toBeNull();
  });

  it('parses a config from the design doc', () => {
    write(`
version: 1
include: ["docs/**/*.md"]
exclude: ["**/CHANGELOG.md"]
doc_types:
  "prd/**": prd
passes:
  hook_post: [0, 1, 2]
rules:
  disable: ["D107"]
  severity: { "S204": "info" }
`);
    const { config } = loadProjectConfig(root);
    expect(config?.include).toEqual(['docs/**/*.md']);
    expect(config?.doc_types).toEqual({ 'prd/**': 'prd' });
    expect(config?.rules?.severity).toEqual({ S204: 'info' });
  });

  it('refuses a project config that contains a credential', () => {
    write('judge:\n  backend: typesafe\n  api_key: sk-not-a-real-key\n');
    expect(() => loadProjectConfig(root)).toThrow(ConfigError);
    expect(() => loadProjectConfig(root)).toThrow(/api_key/);
  });

  it('refuses an unsupported config version', () => {
    write('version: 99\n');
    expect(() => loadProjectConfig(root)).toThrow(/version/);
  });

  it('refuses a config with an unknown key rather than silently ignoring it', () => {
    write('inclde: ["docs/**"]\n');
    expect(() => loadProjectConfig(root)).toThrow(ConfigError);
  });

  it('refuses malformed YAML', () => {
    write('include: [unclosed\n');
    expect(() => loadProjectConfig(root)).toThrow(ConfigError);
  });

  it('warns about and drops a user-only key', () => {
    write('miner:\n  enabled: true\n');
    const { config, warnings } = loadProjectConfig(root);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('miner');
    expect(config).toEqual({});
  });
});

describe('loadConfig', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'lingspark-load-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('reports projectRoot null when nothing opted in', () => {
    const dataDir = path.join(root, 'data');
    const cfg = loadConfig({
      cwd: root,
      pathEnv: { platform: 'linux', env: { LINGSPARK_DATA_DIR: dataDir }, homedir: root },
    });
    expect(cfg.projectRoot).toBeNull();
    expect(cfg.include).toEqual(DEFAULT_INCLUDE);
  });

  it('finds the project root from a nested directory', () => {
    mkdirSync(path.join(root, '.lingspark'), { recursive: true });
    writeFileSync(path.join(root, '.lingspark', 'config.yaml'), 'include: ["docs/**/*.md"]\n');
    const nested = path.join(root, 'docs', 'a');
    mkdirSync(nested, { recursive: true });

    const cfg = loadConfig({
      cwd: nested,
      pathEnv: { platform: 'linux', env: { LINGSPARK_DATA_DIR: path.join(root, 'data') }, homedir: root },
    });
    expect(cfg.projectRoot).toBe(root);
    expect(cfg.include).toEqual(['docs/**/*.md']);
  });
});

describe('toProjectRelative', () => {
  const root = path.resolve(path.sep, 'w', 'proj');

  it('produces forward-slash, project-relative paths on every platform', () => {
    expect(toProjectRelative(root, path.join(root, 'docs', 'a', 'prd.md'))).toBe('docs/a/prd.md');
  });

  it('returns null for a path outside the project', () => {
    expect(toProjectRelative(root, path.resolve(path.sep, 'w', 'other', 'x.md'))).toBeNull();
  });

  it('returns null for the project root itself', () => {
    expect(toProjectRelative(root, root)).toBeNull();
  });
});

describe('createMatcher', () => {
  const root = path.resolve(path.sep, 'w', 'proj');
  const build = (project: ProjectConfigFile | null) =>
    createMatcher(resolveConfig({ projectRoot: root, project, user: null }));

  it('outside any project, checks Markdown with the default excludes (D-050)', () => {
    const m = createMatcher(resolveConfig({ projectRoot: null, project: null, user: null }));
    expect(m.isChecked(path.join(root, 'docs', 'a.md'))).toBe(true);
    expect(m.isChecked(path.join(root, 'a.ts'))).toBe(false);
    expect(m.isChecked(path.join(root, 'CLAUDE.md'))).toBe(false);
    expect(m.isChecked(path.join(root, 'node_modules', 'x', 'README.md'))).toBe(false);
    // An agent's own memory, plans and skills, at home or in a project.
    expect(m.isChecked(path.join(root, '.claude', 'projects', 'p', 'memory', 'm.md'))).toBe(false);
    expect(m.isChecked(path.join(root, 'proj', '.cursor', 'rules', 'r.md'))).toBe(false);
    expect(m.isChecked(path.join(root, 'skills', 'x', 'SKILL.md'))).toBe(false);
    // A folder named build above a document is not build output of a project.
    expect(m.isChecked(path.join(root, 'build', 'notes', 'prd.md'))).toBe(true);
  });

  it('honours include and exclude', () => {
    const m = build({ include: ['docs/**/*.md'], exclude: ['**/CHANGELOG.md'] });
    expect(m.isChecked(path.join(root, 'docs', 'prd.md'))).toBe(true);
    expect(m.isChecked(path.join(root, 'docs', 'deep', 'prd.md'))).toBe(true);
    expect(m.isChecked(path.join(root, 'docs', 'CHANGELOG.md'))).toBe(false);
    expect(m.isChecked(path.join(root, 'src', 'a.md'))).toBe(false);
    expect(m.isChecked(path.join(root, 'docs', 'a.ts'))).toBe(false);
  });

  it('excludes agent instruction files and node_modules by default', () => {
    const m = build(null);
    expect(m.isChecked(path.join(root, 'docs', 'prd.md'))).toBe(true);
    expect(m.isChecked(path.join(root, 'CLAUDE.md'))).toBe(false);
    expect(m.isChecked(path.join(root, 'AGENTS.md'))).toBe(false);
    expect(m.isChecked(path.join(root, 'node_modules', 'x', 'readme.md'))).toBe(false);
    expect(m.isChecked(path.join(root, '.lingspark', 'notes.md'))).toBe(false);
  });

  it('never checks a file outside the project', () => {
    const m = build({ include: ['**/*.md'] });
    expect(m.isChecked(path.resolve(path.sep, 'elsewhere', 'a.md'))).toBe(false);
  });

  it('resolves doc type by declaration order, defaulting to generic', () => {
    const m = build({
      doc_types: { 'prd/**': 'prd', 'docs/design/**': 'tech-design' },
    });
    expect(m.docTypeForPath(path.join(root, 'prd', 'x.md'))).toBe('prd');
    expect(m.docTypeForPath(path.join(root, 'docs', 'design', 'x.md'))).toBe('tech-design');
    expect(m.docTypeForPath(path.join(root, 'docs', 'other.md'))).toBe('generic');
  });

  it('declared deliverables are in scope whatever their extension (D-093)', () => {
    const m = build({ include: ['docs/**/*.md'], deliverables: ['site/**/*.html', 'README.rst'] });
    const html = path.join(root, 'site', 'report.html');
    expect(m.isDeclaredDeliverable(html)).toBe(true);
    expect(m.isChecked(html)).toBe(true);
    expect(m.isDeclaredDeliverable(path.join(root, 'docs', 'a.md'))).toBe(false);
    // An excluded path stays excluded even when it matches deliverables.
    const m2 = build({ include: ['docs/**/*.md'], exclude: ['site/draft/**'], deliverables: ['site/**/*.html'] });
    expect(m2.isChecked(path.join(root, 'site', 'draft', 'x.html'))).toBe(false);
  });
});
