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
  e = { homedir: home, pathEnv, codexLoggedIn: () => false };
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
