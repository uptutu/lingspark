import path from 'node:path';
import os from 'node:os';

/**
 * Everything the path layer needs from the outside world. Injected rather
 * than read from globals so the cross-platform tests can run on any host.
 */
export interface PathEnv {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  homedir: string;
}

export function currentPathEnv(): PathEnv {
  return { platform: process.platform, env: process.env, homedir: os.homedir() };
}

/**
 * The user-level data directory (section 4.3). Nothing under here ever leaves
 * the machine.
 */
export function dataDir(e: PathEnv = currentPathEnv()): string {
  if (e.env['LINGSPARK_DATA_DIR']) return path.resolve(e.env['LINGSPARK_DATA_DIR']);

  switch (e.platform) {
    case 'darwin':
      return path.join(e.homedir, 'Library', 'Application Support', 'lingspark');
    case 'win32': {
      const appData = e.env['APPDATA'] ?? path.join(e.homedir, 'AppData', 'Roaming');
      return path.join(appData, 'lingspark');
    }
    default: {
      const xdg = e.env['XDG_DATA_HOME'];
      const base = xdg && xdg.length > 0 ? xdg : path.join(e.homedir, '.local', 'share');
      return path.join(base, 'lingspark');
    }
  }
}

/** Named locations inside the data directory. */
export const dataPaths = {
  config: (e?: PathEnv) => path.join(dataDir(e), 'config.yaml'),
  credentials: (e?: PathEnv) => path.join(dataDir(e), 'credentials.yaml'),
  personalRules: (e?: PathEnv) => path.join(dataDir(e), 'rules', 'personal'),
  candidateRules: (e?: PathEnv) => path.join(dataDir(e), 'rules', 'candidates'),
  cache: (e?: PathEnv) => path.join(dataDir(e), 'cache'),
  sessions: (e?: PathEnv) => path.join(dataDir(e), 'sessions'),
  session: (id: string, e?: PathEnv) => path.join(dataDir(e), 'sessions', `${id}.json`),
  feedback: (e?: PathEnv) => path.join(dataDir(e), 'feedback', 'feedback.jsonl'),
  minerState: (e?: PathEnv) => path.join(dataDir(e), 'feedback', 'miner-state.json'),
  runs: (e?: PathEnv) => path.join(dataDir(e), 'stats', 'runs.jsonl'),
  /** What was stopped, with the text (D-070). */
  intercepts: (e?: PathEnv) => path.join(dataDir(e), 'stats', 'intercepts.jsonl'),
  reports: (e?: PathEnv) => path.join(dataDir(e), 'reports'),
  log: (e?: PathEnv) => path.join(dataDir(e), 'logs', 'lingspark.log'),
  outboundLog: (e?: PathEnv) => path.join(dataDir(e), 'logs', 'outbound.jsonl'),
  /** Per-hit shadow-rule records; the weekly report reads these (D-085). */
  shadowHits: (e?: PathEnv) => path.join(dataDir(e), 'logs', 'shadow-hits.jsonl'),
} as const;

/** The marker that opts a project in: `<project>/.lingspark/config.yaml`. */
export const PROJECT_DIR = '.lingspark';
export const PROJECT_CONFIG = 'config.yaml';

/**
 * Walk up from `startDir` looking for `.lingspark/config.yaml`.
 *
 * This runs on the hook no-op path, so it takes the existence predicate as an
 * argument: the caller passes a plain synchronous `fs.existsSync` and we avoid
 * pulling in any of the async machinery before we know the file is checked.
 */
export function findProjectRoot(
  startDir: string,
  exists: (p: string) => boolean,
): string | null {
  let dir = path.resolve(startDir);
  for (;;) {
    if (exists(path.join(dir, PROJECT_DIR, PROJECT_CONFIG))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
