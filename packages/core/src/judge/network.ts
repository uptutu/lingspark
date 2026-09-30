import { createHash } from 'node:crypto';
import { appendJsonl } from '../log.js';
import { dataPaths, type PathEnv } from '../paths.js';
import { JudgeError, OfflineError, type JudgePurpose } from './types.js';

/** Hosts that never leave the machine; allowed while offline (design doc, 8.6). */
export function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/gu, '');
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost');
  } catch {
    return false;
  }
}

export interface NetworkContext {
  readonly offline: boolean;
  readonly pathEnv?: PathEnv;
  /** Injected in tests; defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch;
}

export interface OutboundRecord {
  readonly backend: string;
  readonly purpose: JudgePurpose;
  readonly rules: readonly string[];
  readonly file?: string;
  /** The state sent, hashed: the log records that something was sent, never what. */
  readonly state: string;
}

/**
 * Appends to `logs/outbound.jsonl` (design doc, 8.6): hashes and byte counts
 * only, never text. Written before the request goes out, so a request that
 * hangs or crashes the process is still on record.
 */
export function recordOutbound(rec: OutboundRecord, url: string, bytes: number, env?: PathEnv): void {
  appendJsonl(dataPaths.outboundLog(env), {
    ts: new Date().toISOString(),
    backend: rec.backend,
    purpose: rec.purpose,
    rules: rec.rules,
    bytes,
    stateHash: `sha256:${createHash('sha256').update(rec.state, 'utf8').digest('hex')}`,
    ...(rec.file !== undefined ? { file: rec.file } : {}),
    host: (() => {
      try {
        return new URL(url).host;
      } catch {
        return '';
      }
    })(),
  });
}

/**
 * A `fetch` with the offline guard and the outbound log built in.
 *
 * Handed to SDK clients (the Anthropic SDK accepts a custom `fetch`), so
 * requests they make obey the same two rules as ours: nothing leaves the
 * machine while offline, and everything that does leave is on record.
 */
export function guardedFetch(net: NetworkContext, outbound: OutboundRecord): typeof fetch {
  const inner = net.fetchImpl ?? fetch;
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (net.offline && !isLocalUrl(url)) {
      throw new OfflineError(`offline: refused request to ${new URL(url).host}`);
    }
    const body = init?.body;
    const bytes = typeof body === 'string' ? Buffer.byteLength(body, 'utf8') : 0;
    recordOutbound(outbound, url, bytes, net.pathEnv);
    return inner(input, init);
  });
}

const RETRYABLE = new Set([429, 529, 502, 503]);
const MAX_ATTEMPTS = 4;

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new JudgeError('aborted'));
      return;
    }
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new JudgeError('aborted'));
      },
      { once: true },
    );
  });

/**
 * POSTs JSON with the offline guard, the outbound log, and retries.
 *
 * Every network request lingspark makes goes through here, which is what makes
 * the offline guarantee checkable: with `offline` set, a non-local URL throws
 * before anything is sent. Rate-limit and overload responses are retried with
 * exponential backoff, but only inside the caller's deadline -- the signal is
 * the hook's time budget.
 */
export async function postJson(
  url: string,
  body: unknown,
  opts: {
    readonly headers: Readonly<Record<string, string>>;
    readonly signal: AbortSignal;
    readonly net: NetworkContext;
    readonly outbound: OutboundRecord;
  },
): Promise<unknown> {
  if (opts.net.offline && !isLocalUrl(url)) {
    throw new OfflineError(`offline: refused request to ${new URL(url).host}`);
  }
  const payload = JSON.stringify(body);
  const bytes = Buffer.byteLength(payload, 'utf8');
  const doFetch = opts.net.fetchImpl ?? fetch;

  for (let attempt = 1; ; attempt++) {
    recordOutbound(opts.outbound, url, bytes, opts.net.pathEnv);
    let res: Response;
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...opts.headers },
        body: payload,
        signal: opts.signal,
      });
    } catch (err: unknown) {
      if (opts.signal.aborted) throw new JudgeError('aborted');
      throw new JudgeError(`network: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (res.ok) {
      try {
        return (await res.json());
      } catch {
        throw new JudgeError('response was not JSON', res.status);
      }
    }

    if (RETRYABLE.has(res.status) && attempt < MAX_ATTEMPTS) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** (attempt - 1);
      await sleep(Math.min(wait, 8_000), opts.signal);
      continue;
    }

    let detail = '';
    try {
      detail = (await res.text()).slice(0, 300);
    } catch {
      // body unreadable
    }
    throw new JudgeError(`HTTP ${String(res.status)}: ${detail}`, res.status);
  }
}
