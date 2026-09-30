import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveConfig } from '../config/resolve.js';
import type { PathEnv } from '../paths.js';
import { createJudge, resolveAuto } from './factory.js';
import { markSignedIn, markSignedOut, recentlySignedOut } from './signin.js';

let root: string;
let env: PathEnv;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'lingspark-auto-'));
  env = { platform: process.platform, env: { LINGSPARK_DATA_DIR: path.join(root, 'data') }, homedir: root };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const both = (): boolean => true;
const only = (b: string) => (x: string): boolean => x === b;

describe('judge.backend: auto (D-055)', () => {
  it('lets the writing agent judge its own document', () => {
    expect(resolveAuto('codex', env, both)).toBe('codex-cli');
    expect(resolveAuto('claude-code', env, both)).toBe('agent-cli');
  });

  it('never borrows another agent: a writer that cannot judge gets the model-free checks (D-056)', () => {
    // Claude Code inside the Claude app: its CLI is not signed in, Codex is.
    expect(resolveAuto('claude-code', env, only('codex-cli'))).toBeNull();
    // Cursor and WorkBuddy have no CLI lingspark drives yet.
    expect(resolveAuto('cursor', env, both)).toBeNull();
    expect(resolveAuto('workbuddy', env, both)).toBeNull();
  });

  it('says which step turns the writer\'s own judging on', () => {
    const config = resolveConfig({ projectRoot: null, project: null, user: { judge: { backend: 'auto' } } });
    const claude = createJudge(config, { pathEnv: env, agent: 'claude-code', usable: only('codex-cli') });
    expect(claude.judge).toBeNull();
    expect(claude.problem).toContain('Claude Code');
    expect(claude.problem).toContain('登录');
    expect(createJudge(config, { pathEnv: env, agent: 'cursor', usable: both }).problem).toContain('还在适配');
  });

  it('with no writing agent (a person running check), uses the first signed-in agent', () => {
    expect(resolveAuto(undefined, env, only('agent-cli'))).toBe('agent-cli');
    expect(resolveAuto(undefined, env, () => false)).toBeNull();
  });

  it('builds the chosen agent judge, ignoring a model named for another backend', () => {
    const config = resolveConfig({ projectRoot: null, project: null, user: { judge: { backend: 'auto', model: 'gpt-x' } } });
    const setup = createJudge(config, { pathEnv: env, agent: 'claude-code', usable: only('agent-cli') });
    // The CLI may be missing on this machine; either way it is the Claude one, never gpt-x.
    expect(setup.judge?.id ?? setup.problem).not.toContain('gpt-x');
  });

  it('remembers a CLI that answered "not signed in", and forgets once it works', () => {
    expect(recentlySignedOut('agent-cli', env)).toBe(false);
    markSignedOut('agent-cli', env);
    expect(recentlySignedOut('agent-cli', env)).toBe(true);
    markSignedIn('agent-cli', env);
    expect(recentlySignedOut('agent-cli', env)).toBe(false);
  });
});
