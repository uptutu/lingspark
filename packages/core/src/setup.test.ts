import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { heardFrom, waitingAgents } from './hook/waiting.js';
import type { PathEnv } from './paths.js';
import {
  agentStatuses,
  chooseJudge,
  disableAgents,
  enableAgents,
  refreshInstall,
  setupState,
  type SetupEnv,
} from './setup.js';
import { startSetupServer } from './setup-server.js';

let root: string;
let home: string;
let e: SetupEnv;
let pathEnv: PathEnv;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'lingspark-setup-'));
  home = path.join(root, 'home');
  mkdirSync(home);
  pathEnv = { platform: process.platform, env: { LINGSPARK_DATA_DIR: path.join(root, 'data') }, homedir: home };
  // The real probe runs a hook command; here it is a stub, so no test spawns
  // anything. probeHook itself is tested in hook/probe.test.ts.
  e = { homedir: home, pathEnv, codexLoggedIn: () => false, probe: () => ({ ok: true, detail: '' }) };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('agents', () => {
  it('finds the agents used on this machine and hooks into them, reversibly', () => {
    expect(agentStatuses(e).find((a) => a.id === 'claude-code')?.present).toBe(false);
    mkdirSync(path.join(home, '.claude'));
    const before = agentStatuses(e).find((a) => a.id === 'claude-code');
    expect(before).toMatchObject({ present: true, installable: true, installed: false });

    const [r] = enableAgents(['claude-code'], e);
    expect(r?.ok).toBe(true);
    expect(agentStatuses(e).find((a) => a.id === 'claude-code')?.installed).toBe(true);
    const settings = readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8');
    expect(settings).toContain('hook --agent claude-code --event stop');

    disableAgents(['claude-code'], e);
    expect(agentStatuses(e).find((a) => a.id === 'claude-code')?.installed).toBe(false);
  });

  it('does not offer an agent whose config directory is all that is left (D-081)', () => {
    // What a machine without Cursor looks like: the directory survives, filled
    // with what other tools write.
    mkdirSync(path.join(home, '.cursor'), { recursive: true });
    writeFileSync(path.join(home, '.cursor', 'mcp.json'), '{}');
    writeFileSync(path.join(home, '.cursor', 'hooks.json'), '{}');
    expect(agentStatuses(e).find((a) => a.id === 'cursor')?.present).toBe(false);

    // The command on PATH is proof.
    const bin = path.join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(path.join(bin, 'cursor'), '');
    const onPath = { ...e, pathEnv: { ...pathEnv, env: { ...pathEnv.env, PATH: bin } } };
    expect(agentStatuses(onPath).find((a) => a.id === 'cursor')?.present).toBe(true);
  });

  it('finds the app where each platform puts it, not only in Applications (D-081)', () => {
    // The directory says the agent has been used; the app says it is really
    // there. Both are needed, so both are set up here.
    mkdirSync(path.join(home, '.cursor'), { recursive: true });

    // Windows: %LOCALAPPDATA%\Programs\Cursor\Cursor.exe
    const local = path.join(root, 'AppData', 'Local');
    mkdirSync(path.join(local, 'Programs', 'Cursor'), { recursive: true });
    writeFileSync(path.join(local, 'Programs', 'Cursor', 'Cursor.exe'), '');
    const win = { ...e, pathEnv: { platform: 'win32' as const, env: { ...pathEnv.env, LOCALAPPDATA: local }, homedir: home } };
    expect(agentStatuses(win).find((a) => a.id === 'cursor')?.present).toBe(true);

    // macOS: ~/Applications/Cursor.app
    const mac = { ...e, pathEnv: { platform: 'darwin' as const, env: { ...pathEnv.env }, homedir: home } };
    expect(agentStatuses(mac).find((a) => a.id === 'cursor')?.present).toBe(false);
    mkdirSync(path.join(home, 'Applications', 'Cursor.app'), { recursive: true });
    expect(agentStatuses(mac).find((a) => a.id === 'cursor')?.present).toBe(true);
  });

  it('says an agent is not there even when our hook is still in its config (D-081)', () => {
    // Exactly this machine: a `.cursor` directory other tools wrote, and a
    // lingspark hook in it from an earlier connect. Listed so it can be turned
    // off, but never reported as working.
    mkdirSync(path.join(home, '.cursor'), { recursive: true });
    enableAgents(['cursor'], e);
    const c = agentStatuses(e).find((a) => a.id === 'cursor');
    expect(c).toMatchObject({ present: true, installed: true, found: false });

    // Once the program is there, it is found.
    const bin = path.join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(path.join(bin, 'cursor'), '');
    const onPath = { ...e, pathEnv: { ...pathEnv, env: { ...pathEnv.env, PATH: bin } } };
    expect(agentStatuses(onPath).find((a) => a.id === 'cursor')?.found).toBe(true);
  });

  it('keeps offering an agent it did not find, by hand (D-081)', () => {
    // Not detected, but lingspark knows how to write its config: the person
    // may have it installed somewhere we do not look.
    const cursor = agentStatuses(e).find((a) => a.id === 'cursor');
    expect(cursor).toMatchObject({ present: false, installable: true, installed: false });
    const [r] = enableAgents(['cursor'], e);
    expect(r?.ok).toBe(true);
    expect(agentStatuses(e).find((a) => a.id === 'cursor')?.installed).toBe(true);
  });

  it('asks for a restart only when an agent is newly connected', () => {
    mkdirSync(path.join(home, '.claude'));
    enableAgents(['claude-code'], e);
    expect(waitingAgents(pathEnv)).toEqual(['claude-code']);
    heardFrom('claude-code', pathEnv);
    enableAgents(['claude-code'], e); // already on: nothing to restart
    expect(waitingAgents(pathEnv)).toEqual([]);
    enableAgents(['claude-code'], e);
    disableAgents(['claude-code'], e);
    expect(waitingAgents(pathEnv)).toEqual([]);
  });

  it('runs the hook command of an agent that has not called back, and only then (D-077)', () => {
    mkdirSync(path.join(home, '.claude'));
    const asked: string[][] = [];
    const pe = { ...e, probe: (id: string, cmds: readonly string[]) => (asked.push([id, ...cmds]), { ok: true, detail: '' }) };

    // Not connected: nothing to run, nothing to say.
    expect(agentStatuses(pe).find((a) => a.id === 'claude-code')?.hook).toBeNull();
    expect(asked).toEqual([]);

    enableAgents(['claude-code'], pe);
    const waiting = agentStatuses(pe).find((a) => a.id === 'claude-code');
    expect(waiting?.hook).toEqual({ ok: true, detail: '' });
    // The very command that was written into the config is the one run.
    expect(asked[0]?.[0]).toBe('claude-code');
    expect(asked[0]?.[1]).toContain('hook --agent claude-code --event');

    heardFrom('claude-code', pathEnv);
    expect(agentStatuses(pe).find((a) => a.id === 'claude-code')?.hook).toBeNull();
  });

  it('carries the reason a hook cannot run, for the page to show (D-077)', () => {
    mkdirSync(path.join(home, '.claude'));
    enableAgents(['claude-code'], e);
    const broken = { ...e, probe: () => ({ ok: false, detail: 'hook 指向的程序不存在' }) };
    expect(agentStatuses(broken).find((a) => a.id === 'claude-code')?.hook).toEqual({
      ok: false,
      detail: 'hook 指向的程序不存在',
    });
  });

  it('moves the hooks to a new version of the program when the app opens', () => {
    mkdirSync(path.join(home, '.claude'));
    const binary = path.join(root, 'lingspark');
    writeFileSync(binary, 'version 1');
    const eb = { ...e, binary };
    const copy = path.join(root, 'data', 'bin', process.platform === 'win32' ? 'lingspark.exe' : 'lingspark');
    refreshInstall(eb); // nothing connected: nothing copied
    expect(existsSync(copy)).toBe(false);
    enableAgents(['claude-code'], eb);
    expect(readFileSync(copy, 'utf8')).toBe('version 1');
    writeFileSync(binary, 'version 2');
    refreshInstall(eb);
    expect(readFileSync(copy, 'utf8')).toBe('version 2');
  });

  it("never takes over hooks that another install's program runs", () => {
    mkdirSync(path.join(home, '.claude'));
    const file = path.join(home, '.claude', 'settings.json');
    const theirs = {
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: '"/elsewhere/bin/lingspark" hook --agent claude-code --event stop' }] }],
        PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: '"/elsewhere/bin/lingspark" hook --agent claude-code --event post-tool-use' }] }],
      },
    };
    writeFileSync(file, JSON.stringify(theirs));
    refreshInstall(e);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(theirs);
  });

  it('rewrites an outdated hook config when the app opens, and asks for a restart', () => {
    mkdirSync(path.join(home, '.claude'));
    enableAgents(['claude-code'], e);
    heardFrom('claude-code', pathEnv);
    const file = path.join(home, '.claude', 'settings.json');
    // As an older version wrote it: shell commands not watched.
    writeFileSync(file, readFileSync(file, 'utf8').replace(/"matcher": "[^"]*"/u, '"matcher": "Write|Edit"'));
    refreshInstall(e);
    expect(readFileSync(file, 'utf8')).toContain('|Bash|');
    expect(waitingAgents(pathEnv)).toEqual(['claude-code']);
    heardFrom('claude-code', pathEnv);
    refreshInstall(e); // current: nothing to restart
    expect(waitingAgents(pathEnv)).toEqual([]);
  });

  it('never writes the config of an agent the product does not support', () => {
    const [r] = enableAgents(['trae'], e);
    expect(r?.ok).toBe(false);
    expect(existsSync(path.join(home, '.trae-cn'))).toBe(false);
  });
});

describe('judge choice', () => {
  it('sets the backend and keeps the rest of the user config, comments included', () => {
    mkdirSync(path.join(root, 'data'), { recursive: true });
    writeFileSync(path.join(root, 'data', 'config.yaml'), '# 我的备注\noffline: false\njudge:\n  model: m\n');
    chooseJudge('anthropic', e);
    const text = readFileSync(path.join(root, 'data', 'config.yaml'), 'utf8');
    expect(text).toContain('# 我的备注');
    expect(text).toContain('model: m');
    expect(setupState(e).judge.current).toBe('anthropic');
  });

  it('recommends nothing when nothing on the machine can answer', () => {
    const s = setupState({ ...e, pathEnv: { ...pathEnv, env: { ...pathEnv.env, PATH: '' } } });
    for (const o of s.judge.options.filter((x) => x.backend === 'codex-cli')) expect(o.available).toBe(false);
  });
});

describe('choosing the reviewer', () => {
  it('replaces a hand-edited judge entry that is not a mapping instead of failing', () => {
    mkdirSync(path.join(root, 'data'), { recursive: true });
    writeFileSync(path.join(root, 'data', 'config.yaml'), 'offline: false\njudge: session\n');
    chooseJudge('session', e);
    expect(setupState(e).judge.current).toBe('session');
    expect(readFileSync(path.join(root, 'data', 'config.yaml'), 'utf8')).toContain('offline: false');
  });
});

/** A raw request, so the Host header can be set to anything. */
function call(port: number, opts: { method?: string; path: string; host?: string; token?: string; body?: unknown }) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method: opts.method ?? 'POST',
        path: opts.path,
        headers: {
          host: opts.host ?? `127.0.0.1:${String(port)}`,
          'content-type': 'application/json',
          ...(opts.token !== undefined ? { 'x-lingspark-token': opts.token } : {}),
        },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8').on('data', (c: string) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end(opts.body === undefined ? undefined : JSON.stringify(opts.body));
  });
}

describe('setup page server', () => {
  it('serves the page only with its token, and the API only with its header', async () => {
    const s = await startSetupServer({ ...e, builtinRules: [] });
    try {
      expect((await call(s.port, { method: 'GET', path: '/' })).status).toBe(403);
      const page = await call(s.port, { method: 'GET', path: `/?t=${s.token}` });
      expect(page.status).toBe(200);
      expect(page.body).toContain('lingspark');

      expect((await call(s.port, { path: '/api/state' })).status).toBe(403);
      expect((await call(s.port, { path: '/api/state', token: 'x'.repeat(s.token.length) })).status).toBe(403);
      const state = await call(s.port, { path: '/api/state', token: s.token });
      expect(state.status).toBe(200);
      expect(JSON.parse(state.body)).toHaveProperty('agents');
    } finally {
      s.close();
    }
  });

  it("answers the page's two-second poll with today's numbers and the checking flag", async () => {
    const s = await startSetupServer({ ...e, builtinRules: [] });
    try {
      const r = await call(s.port, { path: '/api/live', token: s.token });
      expect(JSON.parse(r.body)).toEqual({
        today: { checked: 0, blocked: 0, total: { checked: 0, blocked: 0 }, ever: false, waiting: [], noticed: [] },
        checking: false,
      });
      const page = await call(s.port, { method: 'GET', path: `/?t=${s.token}` });
      expect(page.body).toContain('window.LingOrb'); // the orb ships inside the page
      expect(page.body).not.toMatch(/<script[^>]+src=/u); // nothing loaded from anywhere
    } finally {
      s.close();
    }
  });

  it('refuses a request addressed to another host name (DNS rebinding)', async () => {
    const s = await startSetupServer({ ...e, builtinRules: [] });
    try {
      const r = await call(s.port, { path: '/api/state', token: s.token, host: `evil.example:${String(s.port)}` });
      expect(r.status).toBe(421);
    } finally {
      s.close();
    }
  });

  it('writes only a judge backend it offered', async () => {
    const s = await startSetupServer({ ...e, builtinRules: [] });
    try {
      await call(s.port, { path: '/api/judge', token: s.token, body: { backend: 'mock' } });
      expect(existsSync(path.join(root, 'data', 'config.yaml'))).toBe(false);
      await call(s.port, { path: '/api/judge', token: s.token, body: { backend: 'anthropic' } });
      expect(setupState(e).judge.current).toBe('anthropic');
    } finally {
      s.close();
    }
  });

  it('says so, and writes nothing, when there is no agent to connect', async () => {
    const s = await startSetupServer({ ...e, builtinRules: [] });
    try {
      const r = JSON.parse((await call(s.port, { path: '/api/enable-all', token: s.token })).body) as { messages: string[] };
      expect(r.messages[0]).toContain('没有找到');
      expect(existsSync(path.join(root, 'data', 'config.yaml'))).toBe(false);
    } finally {
      s.close();
    }
  });

  it('brings a reloaded page back without ever handing out the token', async () => {
    const s = await startSetupServer({ ...e, builtinRules: [] });
    try {
      const r = await call(s.port, { method: 'GET', path: '/' });
      expect(r.status).toBe(403);
      expect(r.body).toContain('sessionStorage');
      expect(r.body).not.toContain(s.token);
    } finally {
      s.close();
    }
  });

  it('turns everything off with one call', async () => {
    mkdirSync(path.join(home, '.claude'));
    enableAgents(['claude-code'], e);
    const s = await startSetupServer({ ...e, builtinRules: [] });
    try {
      expect((await call(s.port, { path: '/api/disable-all', token: s.token })).status).toBe(200);
      expect(agentStatuses(e).find((a) => a.id === 'claude-code')?.installed).toBe(false);
    } finally {
      s.close();
    }
  });

  it('stops when the page says it is done', async () => {
    const s = await startSetupServer({ ...e, builtinRules: [] });
    await call(s.port, { path: '/api/done', token: s.token });
    await s.closed;
  });
});

describe('the page in a window of its own', () => {
  const fetchPage = async (query: string): Promise<string> => {
    const s = await startSetupServer({ ...e, builtinRules: [] });
    try {
      const body = await new Promise<string>((resolve, reject) => {
        const r = request(`http://127.0.0.1:${String(s.port)}/?t=${s.token}${query}`, (res) => {
          let out = '';
          res.on('data', (c: Buffer) => (out += c.toString()));
          res.on('end', () => resolve(out));
        });
        r.on('error', reject);
        r.end();
      });
      return body;
    } finally {
      s.close();
    }
  };

  // The clients on Windows and Linux open the page in a Chromium app window
  // and say so with `?window=1`; the Mac shell says it in the user agent.
  // Both paths have to add the class, because only the Mac window hides its
  // own title bar: elsewhere the page has to fill the window and stop
  // drawing a second header of its own (D-075).
  it('reads the window marker before the address bar is cleared', async () => {
    const page = await fetchPage('&window=1');
    expect(page).toContain("get('window') === '1'");
    // Read before replaceState, or the reload has already taken it away.
    expect(page.indexOf("get('window')")).toBeLessThan(page.indexOf("replaceState"));
  });

  it('still accepts the Mac client naming itself in the user agent', async () => {
    const page = await fetchPage('');
    expect(page).toContain("navigator.userAgent.indexOf('LingSpark/') >= 0");
  });

  it('draws no title bar of its own where the window already has one', async () => {
    const page = await fetchPage('&window=1');
    expect(page).toContain('body.win-app .bar, body.linux-app .bar { display: none; }');
    // The Mac shell hides the window's title and drops the traffic lights
    // into the page's bar, so that one still shows.
    expect(page).toContain('body.mac-app .bar');
  });

  it('keeps the settings button reachable without a bar', async () => {
    const page = await fetchPage('&window=1');
    // Floated in the corner rather than left inside the hidden bar.
    expect(page).toContain('.gear { position: absolute;');
    const bar = page.indexOf('<div class="bar">');
    const gear = page.indexOf('id="gear"');
    expect(gear).toBeGreaterThan(bar);
    expect(page.indexOf('</div>', bar)).toBeLessThan(gear);
  });
});
