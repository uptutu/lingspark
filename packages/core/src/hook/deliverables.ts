import path from 'node:path';
import { AGENT_DIRS } from '../agents.js';
import { loadConfig } from '../config/load.js';
import { createMatcher } from '../config/matcher.js';
import type { PathEnv } from '../paths.js';

/**
 * The deliverables rescue (D-093). `gate.ts` drops every non-Markdown write
 * before config is loaded; a project may declare files as deliverables --
 * final outputs worth checking whatever their extension (an exported HTML
 * report, a generated README.rst). This second chance runs only for files the
 * gate dropped and only on the hook path, so the no-op stay fast for code.
 */
export function rescueDeliverables(files: readonly string[], env?: PathEnv): string[] {
  const configs = new Map<string, ReturnType<typeof loadConfig>>();
  const out: string[] = [];
  for (const f of files) {
    const abs = path.resolve(f);
    if (abs.split(/[\\/]/u).some((part) => AGENT_DIRS.has(part))) continue;
    const dir = path.dirname(abs);
    let loaded = configs.get(dir);
    if (loaded === undefined) {
      try {
        loaded = loadConfig({ cwd: dir, ...(env !== undefined ? { pathEnv: env } : {}) });
      } catch {
        continue;
      }
      configs.set(dir, loaded);
    }
    if (loaded.projectRoot === null) continue;
    try {
      if (createMatcher(loaded).isDeclaredDeliverable(abs)) out.push(f);
    } catch {
      // a matcher that cannot build must not block the hook
    }
  }
  return out;
}
