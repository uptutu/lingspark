import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { msg } from './messages.js';
import { SETUP_PAGE } from './setup-page.js';
import { checkingNow } from './hook/activity.js';
import { noticeWaiting } from './hook/waiting.js';
import { AGENT_IDS } from './agents.js';
import { isRecordedFile, listIntercepts } from './intercepts.js';
import { todayStats, type TodayStats } from './today.js';
import { chooseJudge, defaultCodexLoggedIn, disableAgents, enableAgents, setupState, type SetupEnv } from './setup.js';

/**
 * The setup page's server (`lingspark ui`): the same operations as
 * `lingspark setup`, behind buttons.
 *
 * It can rewrite agent configs, so it takes care that only the page it served
 * can drive it:
 * - it listens on 127.0.0.1 only;
 * - every request must name exactly that host and port, so a web page that
 *   rebinds its own domain to 127.0.0.1 is refused;
 * - every API call must carry a random token that only the served page knows,
 *   in a custom header -- which a cross-origin page cannot send without a CORS
 *   preflight this server never approves;
 * - it exits after 30 minutes without a request.
 */

export interface SetupServerOptions extends SetupEnv {
  readonly cwd?: string;
  readonly builtinRules: readonly { file: string; yaml: string }[];
  readonly idleMs?: number;
}

export interface SetupServer {
  readonly url: string;
  readonly token: string;
  readonly port: number;
  /** Resolves when the user clicks "done" or the server idles out. */
  readonly closed: Promise<void>;
  close(): void;
}

const MAX_BODY = 64 * 1024;

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
      } else body += c;
    });
    req.on('end', () => {
      try {
        const v = body === '' ? {} : (JSON.parse(body) as unknown);
        resolve(v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  });
}

const send = (res: ServerResponse, status: number, body: unknown, type = 'application/json; charset=utf-8'): void => {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

const once = <T>(f: (arg: string) => T): ((arg: string) => T) => {
  const seen = new Map<string, T>();
  return (arg) => {
    if (!seen.has(arg)) seen.set(arg, f(arg));
    return seen.get(arg) as T;
  };
};

const RELOAD_PAGE =
  '<!doctype html><meta charset="utf-8"><title>LingSpark · 灵光</title>' +
  '<body style="background:#000"><script>var t = sessionStorage.getItem("lingspark-token");' +
  'if (t) location.replace("/?t=" + encodeURIComponent(t));</script>';

const sameToken = (a: string, b: string): boolean =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Rule id to its Chinese name, read from the rule sources. */
function namesOf(sources: readonly { yaml: string }[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const { yaml } of sources) {
    const id = /^id:\s*(\S+)/mu.exec(yaml)?.[1];
    const name = /^name:\s*(.+?)\s*$/mu.exec(yaml)?.[1];
    if (id !== undefined && name !== undefined) out.set(id, name.replace(/^['"]|['"]$/gu, ''));
  }
  return out;
}

/** Opens a file in its app, or shows it in Finder / Explorer. */
function openFile(file: string, reveal: boolean): boolean {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', reveal ? ['-R', file] : [file]]
      : process.platform === 'win32'
        ? ['explorer', reveal ? [`/select,${file}`] : [file]]
        : ['xdg-open', [reveal ? path.dirname(file) : file]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export function startSetupServer(opts: SetupServerOptions): Promise<SetupServer> {
  const ruleNames = namesOf(opts.builtinRules);
  const token = randomBytes(24).toString('hex');
  const env: SetupEnv = {
    ...(opts.homedir !== undefined ? { homedir: opts.homedir } : {}),
    ...(opts.pathEnv !== undefined ? { pathEnv: opts.pathEnv } : {}),
    // Asked once per server: spawning `codex login status` on every state
    // request kept the panel on "正在检查这台电脑…" for seconds.
    codexLoggedIn: once(opts.codexLoggedIn ?? defaultCodexLoggedIn),
    ...(opts.binary !== undefined ? { binary: opts.binary } : {}),
  };
  let host = '';
  let finish: () => void = () => undefined;
  const closed = new Promise<void>((r) => (finish = r));
  let idle: NodeJS.Timeout | undefined;
  // Browsers keep connections alive; close them too, or close() never finishes.
  const shutdown = (): void => {
    server.close();
    server.closeAllConnections();
  };

  const live = (): { today: TodayStats; checking: boolean } => ({
    today: todayStats(opts.pathEnv),
    checking: checkingNow(opts.pathEnv),
  });

  const api = (route: string, body: Record<string, unknown>): unknown => {
    const str = (k: string): string => (typeof body[k] === 'string' ? body[k] : '');
    switch (route) {
      case '/api/state':
        return { ...setupState(env), ...live() };
      case '/api/live':
        // Polled every couple of seconds by the page: cheap on purpose (D-058).
        return live();
      case '/api/notice-waiting': {
        // The person hovered the red light and read what is missing (D-068).
        const ids = Array.isArray(body['ids']) ? body['ids'].filter((x): x is string => typeof x === 'string') : [];
        noticeWaiting(ids.filter((id) => AGENT_IDS.includes(id)), opts.pathEnv);
        return live();
      }
      case '/api/enable-all': {
        const state = setupState(env);
        const targets = state.agents.filter((a) => a.present && a.installable).map((a) => a.id);
        // Nothing to connect: say so, and write nothing.
        if (targets.length === 0) return { messages: [msg.setup.noAgentsFound] };
        const messages = enableAgents(targets, env).map((a) => a.message);
        if (state.judge.current === null && state.judge.recommended !== null) {
          try {
            chooseJudge(state.judge.recommended, env);
          } catch (err: unknown) {
            // The agents are connected either way; the page must hear that.
            messages.push(msg.setup.judgeNotSaved(err instanceof Error ? err.message : String(err)));
          }
        }
        return { messages };
      }
      case '/api/disable-all':
        return {
          messages: disableAgents(setupState(env).agents.filter((a) => a.installed).map((a) => a.id), env).map((a) => a.message),
        };
      case '/api/agent':
        return { messages: (body['on'] === true ? enableAgents : disableAgents)([str('id')], env).map((a) => a.message) };
      case '/api/judge': {
        // Only a backend the page offered; nothing else is written to the config.
        const backend = str('backend');
        if (!setupState(env).judge.options.some((o) => o.backend === backend)) return { messages: [] };
        try {
          chooseJudge(backend, env);
        } catch (err: unknown) {
          return { messages: [msg.setup.judgeNotSaved(err instanceof Error ? err.message : String(err))] };
        }
        return { messages: [] };
      }
      case '/api/done':
        setImmediate(shutdown);
        return { messages: [] };
      case '/api/intercepts':
        // What was stopped, with the rule's name for the page (D-070).
        return { items: listIntercepts(opts.pathEnv).map((r) => ({ ...r, ruleName: ruleNames.get(r.rule) ?? r.rule })) };
      case '/api/open': {
        // Only a file the records name: this is not a way to open anything.
        const file = str('file');
        if (file === '' || !isRecordedFile(file, opts.pathEnv)) return { ok: false };
        return { ok: openFile(file, body['reveal'] === true) };
      }
      default:
        return undefined;
    }
  };

  const server = createServer((req, res) => {
    clearTimeout(idle);
    idle = setTimeout(shutdown, opts.idleMs ?? 30 * 60_000);

    if (req.headers.host !== host) {
      send(res, 421, { error: 'wrong host' });
      return;
    }
    const url = new URL(req.url ?? '/', `http://${host}`);

    if (req.method === 'GET' && url.pathname === '/') {
      if (!sameToken(url.searchParams.get('t') ?? '', token)) {
        // A reload loses the token the page took out of the address bar; this
        // page puts it back from the tab's own storage, which no other site
        // can read. It carries no token itself.
        send(res, 403, RELOAD_PAGE, 'text/html; charset=utf-8');
        return;
      }
      send(res, 200, SETUP_PAGE, 'text/html; charset=utf-8');
      return;
    }

    const given = req.headers['x-lingspark-token'];
    if (req.method !== 'POST' || typeof given !== 'string' || !sameToken(given, token)) {
      send(res, 403, { error: 'forbidden' });
      return;
    }
    readJson(req)
      .then((body) => api(url.pathname, body))
      .then((out) => (out === undefined ? send(res, 404, { error: 'not found' }) : send(res, 200, out)))
      .catch((err: unknown) => send(res, 500, { error: err instanceof Error ? err.message : String(err) }));
  });

  server.on('close', () => {
    clearTimeout(idle);
    finish();
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      host = `127.0.0.1:${String(port)}`;
      idle = setTimeout(shutdown, opts.idleMs ?? 30 * 60_000);
      resolve({
        url: `http://${host}/?t=${token}`,
        token,
        port,
        closed,
        close: shutdown,
      });
    });
  });
}

