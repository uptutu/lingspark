// hook-probe for opencode: logs tool.execute.before / session.idle payloads, tests block by throwing.
import { appendFileSync } from 'node:fs';

const OUT = 'C:/Users/alexk/codes/lingspark/tools/hook-probe/captured.jsonl';

function log(payload) {
  try {
    appendFileSync(OUT, JSON.stringify({ ts: new Date().toISOString(), agent: 'opencode', payload }) + '\n');
  } catch {
    // fail-open
  }
}

export const LingsparkProbe = async ({ project, directory, worktree }) => {
  log({ kind: 'init', project, directory, worktree });
  return {
    'tool.execute.before': async (input, output) => {
      log({ kind: 'tool.execute.before', input, output });
      if (input.tool === 'write' && JSON.stringify(output.args).includes('blocked.md')) {
        log({ kind: 'block', note: 'throwing for blocked.md' });
        throw new Error('PROBE: blocked by lingspark-probe');
      }
    },
    'tool.execute.after': async (input) => {
      log({ kind: 'tool.execute.after', input });
    },
    'session.idle': async ({ event }) => {
      log({ kind: 'session.idle', event });
    },
    event: async ({ event }) => {
      log({ kind: 'event', type: event.type, full: event.type === 'session.idle' ? event : undefined });
    },
  };
};
