import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { AGENTS, agentConfigFile, agentProfile, installableAgents } from './agents.js';
import { parseHookInput } from './hook/input.js';
import { configFileFor, InstallError } from './install/install.js';
import { hasOurHooks, withHooksInstalled, withHooksRemoved } from './install/merge.js';

const where = { homedir: path.resolve('/h'), projectDir: path.resolve('/p') };
const CMD = { posix: '"/x/lingspark"', windows: '"C:\\x\\lingspark.exe"' };

describe('agent registry', () => {
  it('has unique ids', () => {
    expect(new Set(AGENTS.map((a) => a.id)).size).toBe(AGENTS.length);
  });

  it('can install into every agent whose hooks are documented', () => {
    // Exactly the four the product supports (D-060).
    expect(installableAgents().map((a) => a.id).sort()).toEqual(['claude-code', 'codex', 'cursor', 'workbuddy']);
  });

  it('knows where each documented agent keeps its hooks', () => {
    const file = (id: string) => agentConfigFile(agentProfile(id)!, 'user', where);
    expect(file('cursor')).toBe(path.join(where.homedir, '.cursor', 'hooks.json'));
    expect(file('workbuddy')).toBe(path.join(where.homedir, '.workbuddy', 'settings.json'));
    expect(agentConfigFile(agentProfile('codex')!, 'project', where)).toBe(
      path.join(where.projectDir, '.codex', 'hooks.json'),
    );
  });

  it('refuses an agent the product does not support', () => {
    for (const id of ['qoder', 'codebuddy', 'trae', 'no-such-agent']) {
      expect(() => configFileFor(id, 'user', where)).toThrow(InstallError);
    }
  });

  for (const agent of AGENTS) {
    it(`installs and removes cleanly for ${agent.id}`, () => {
      const start = {
        theirs: 1,
        ...(agent.format === 'cursor' ? { version: 1 } : {}),
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say hi' }] }] },
      };
      const installed = withHooksInstalled(start, agent.id, CMD);
      expect(hasOurHooks(installed)).toEqual({ postToolUse: true, stop: true });
      expect(JSON.stringify(installed)).toContain(`--agent ${agent.id} --event stop`);
      expect(withHooksRemoved(installed)).toEqual(start);
    });
  }
});

describe('Cursor hooks.json', () => {
  it("writes Cursor's own layout: version 1, flat handlers, one follow-up per stop", () => {
    const installed = withHooksInstalled({ hooks: { stop: [{ command: 'mine' }] } }, 'cursor', CMD) as {
      version: number;
      hooks: Record<string, unknown[]>;
    };
    expect(installed.version).toBe(1);
    expect(installed.hooks['afterFileEdit']).toEqual([
      { command: '"/x/lingspark" hook --agent cursor --event post-tool-use', timeout: 15 },
    ]);
    // Documents written from the shell come in here (D-067).
    expect(installed.hooks['afterShellExecution']).toEqual(installed.hooks['afterFileEdit']);
    expect(installed.hooks['stop']).toEqual([
      { command: 'mine' },
      { command: '"/x/lingspark" hook --agent cursor --event stop', timeout: 90, loop_limit: 1 },
    ]);
    expect(withHooksRemoved(installed)).toEqual({ version: 1, hooks: { stop: [{ command: 'mine' }] } });
  });
});

describe('hook input from other agents', () => {
  it('reads a CodeBuddy Stop payload: generation_id as the turn, no cwd', () => {
    const raw = JSON.stringify({
      session_id: 's',
      transcript_path: '/t',
      permission_mode: 'default',
      hook_event_name: 'Stop',
      generation_id: 'g-7',
      stop_hook_active: false,
    });
    const input = parseHookInput(raw, 'codebuddy', 'stop');
    expect(input?.turnId).toBe('g-7');
    expect(input?.cwd).toBe(process.cwd());
  });

  it('reads a Trae-style PostToolUse payload with tool_output instead of tool_response', () => {
    const raw = JSON.stringify({
      session_id: 's',
      cwd: '/w',
      hook_event_name: 'PostToolUse',
      tool_name: 'Write',
      tool_input: { file_path: 'docs/a.md', content: 'x' },
      tool_output: 'ok',
    });
    expect(parseHookInput(raw, 'trae', 'post-tool-use')?.files).toEqual([path.resolve('/w', 'docs/a.md')]);
  });
});
