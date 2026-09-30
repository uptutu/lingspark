import path from 'node:path';
import { AGENT_DIRS } from '../agents.js';

/**
 * Extensions that can possibly be checked. The include globs decide the rest,
 * but they need the YAML config loaded, and this gate runs before that.
 */
const MARKDOWN = new Set(['.md', '.markdown', '.mdx']);

/**
 * The first, cheapest filter on the hook path.
 *
 * Every file an agent writes -- source code, lock files, its own memory --
 * triggers the hook. Most are not documents, and for those the hook must
 * answer inside HOOK_NOOP_MS including process start. So this module imports
 * nothing but `node:path` and the agent registry: no YAML, no zod, no Markdown
 * parser, no rules (design doc, section 5.3, step 2). Only files that survive
 * it pay for loading the checker.
 *
 * What an agent writes is what gets checked, wherever it is (D-050); the one
 * thing dropped here besides non-Markdown is the agents' own files -- memory,
 * plans, skills -- which agents write all the time. It over-approximates on
 * purpose: a survivor may still be excluded by a project's include/exclude or
 * by `lingspark: false` frontmatter, checked once the real config is loaded.
 */
export function gateFiles(files: readonly string[]): string[] {
  return files.filter(
    (f) =>
      MARKDOWN.has(path.extname(f).toLowerCase()) &&
      !path
        .resolve(f)
        .split(/[\\/]/u)
        .some((part) => AGENT_DIRS.has(part)),
  );
}
