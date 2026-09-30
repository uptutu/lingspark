import { spawn } from 'node:child_process';
import path from 'node:path';
import { parseArgs } from 'node:util';
// Only light modules are imported statically. The checker, the parser and the
// rules are loaded with a dynamic import after preflight says there is work
// to do, so the no-op path -- most writes an agent makes -- never pays for
// them (design doc, 5.3 step 2; HOOK_NOOP_MS).
import { AGENT_IDS } from '@lingspark/core/agents.js';
import { EXIT_OK } from '@lingspark/core/constants.js';
import { parseHookInput, type HookEvent } from '@lingspark/core/hook/input.js';
import { preflight } from '@lingspark/core/hook/preflight.js';
import { beginActivity } from '@lingspark/core/hook/activity.js';
import { heardFrom } from '@lingspark/core/hook/waiting.js';
import { log } from '@lingspark/core/log.js';
import { msg } from '@lingspark/core/messages.js';

const EVENTS: readonly HookEvent[] = ['post-tool-use', 'stop'];

/** Stop reading stdin after this long; the agent should have closed it. */
const STDIN_TIMEOUT_MS = 5_000;
/** A hook payload bigger than this is not something we understand. */
const STDIN_MAX_BYTES = 16 * 1024 * 1024;

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    const done = (): void => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const timer = setTimeout(done, STDIN_TIMEOUT_MS);
    timer.unref();
    process.stdin.on('data', (c: Buffer) => {
      size += c.length;
      if (size <= STDIN_MAX_BYTES) chunks.push(c);
    });
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}

/**
 * Starts `lingspark warm <session> <agent>` detached, so it outlives this hook and the
 * agent never waits for it (D-046). The same program runs it: the single
 * executable, or node with the same script.
 */
function startWarm(sessionId: string, agent: string): void {
  try {
    const script = process.argv[1];
    const args = script !== undefined && path.resolve(script) !== path.resolve(process.execPath) ? [script] : [];
    const child = spawn(process.execPath, [...args, 'warm', sessionId, agent], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // no warm-up this time; Stop does the work itself
  }
}

export interface HookIo {
  readonly out: (s: string) => void;
  readonly err: (s: string) => void;
}

/**
 * `lingspark hook --agent <a> --event <e>` (design doc, 5.3).
 *
 * Every failure mode here -- bad arguments included -- exits 0. A broken
 * install must degrade to "no checking", never to "the agent stops working".
 */
export async function runHookCommand(argv: string[], io: HookIo): Promise<number> {
  // A session lingspark itself started to judge text: never check it, or
  // judging would recurse into more judging (see judge/agent-cli.ts).
  if (process.env['LINGSPARK_JUDGE_CHILD'] === '1') return EXIT_OK;
  try {
    const { values } = parseArgs({
      args: argv,
      options: { agent: { type: 'string' }, event: { type: 'string' } },
      strict: false,
    });
    const agent = String(values['agent']);
    const event = values['event'] as HookEvent;
    if (!AGENT_IDS.includes(agent) || !EVENTS.includes(event)) {
      log('warn', msg.log.hookFailed(`bad arguments: ${argv.join(' ')}`));
      return EXIT_OK;
    }
    // The agent has picked up its hooks: the client stops saying "restart".
    heardFrom(agent);

    const input = parseHookInput(await readStdin(), agent, event);
    if (input === null) {
      log('warn', msg.log.hookBadInput);
      return EXIT_OK;
    }

    const pre = preflight(input);
    if (!pre.proceed) return EXIT_OK;
    // From here on the check is real work; the client's orb shows it (D-058).
    const done = beginActivity();
    try {
      const [{ runHookChecks }, { builtinRuleSources }] = await Promise.all([
        import('@lingspark/core/hook/run.js'),
        import('@lingspark/rules-builtin'),
      ]);
      const result = await runHookChecks(input, pre.files, pre.store, { builtinRules: builtinRuleSources });
      if (result.warmSession !== undefined) startWarm(result.warmSession, agent);
      if (result.stdout !== undefined) io.out(result.stdout);
      if (result.stderr !== '') io.err(result.stderr);
      return result.exitCode;
    } finally {
      done();
    }
  } catch (err: unknown) {
    log('error', msg.log.hookFailed(err instanceof Error ? (err.stack ?? err.message) : String(err)));
    return EXIT_OK;
  }
}
