import path from 'node:path';
import picomatch from 'picomatch';
import { BUILD_OUTPUT_EXCLUDE } from './defaults.js';
import type { DocType, ResolvedConfig } from './schema.js';

/**
 * Turns an absolute path into the project-relative, forward-slash form that
 * glob patterns are written against.
 *
 * Returns null when the file is outside the project: patterns are anchored at
 * the project root, so a path that escapes it can never match and must not be
 * checked.
 */
export function toProjectRelative(projectRoot: string, absPath: string): string | null {
  const rel = path.relative(projectRoot, path.resolve(absPath));
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

/**
 * The path a pattern is matched against when no project is in play: the
 * absolute path without its root (`/` or a drive), so the default "any
 * directory named x" patterns work on it.
 */
function rootless(absPath: string): string {
  const abs = path.resolve(absPath);
  return abs.slice(path.parse(abs).root.length).split(path.sep).join('/');
}

export interface FileMatcher {
  /** Whether this file is in scope, ignoring frontmatter (design doc, 5.5 steps 1-2). */
  isChecked(absPath: string): boolean;
  /** The doc type implied by the path. Frontmatter `doc_type` overrides this. */
  docTypeForPath(absPath: string): DocType;
}

/**
 * Compiles the include/exclude/doc_types patterns once.
 *
 * Compiling matters: this runs on the hook no-op path, once per written file,
 * and picomatch compiles a pattern into a regexp each time you call it with a
 * string.
 */
export function createMatcher(config: ResolvedConfig): FileMatcher {
  const { projectRoot } = config;

  // Inside a project, patterns are anchored at its root and a path that
  // escapes it never matches. Outside any project (D-050) the defaults apply
  // to the whole path: any Markdown file, minus the excluded ones.
  const relative = (absPath: string): string | null =>
    projectRoot === null ? rootless(absPath) : toProjectRelative(projectRoot, absPath);

  const opts = { dot: true } as const;
  const isIncluded = picomatch(config.include as string[], opts);
  const exclude =
    projectRoot === null ? config.exclude.filter((p) => !BUILD_OUTPUT_EXCLUDE.includes(p)) : config.exclude;
  const isExcluded = exclude.length > 0 ? picomatch(exclude as string[], opts) : () => false;

  const docTypeMatchers: { match: (s: string) => boolean; docType: DocType }[] = [];
  for (const [pattern, docType] of config.docTypes) {
    docTypeMatchers.push({ match: picomatch(pattern, opts), docType });
  }

  return {
    isChecked(absPath: string): boolean {
      const rel = relative(absPath);
      if (rel === null) return false;
      return isIncluded(rel) && !isExcluded(rel);
    },

    docTypeForPath(absPath: string): DocType {
      const rel = relative(absPath);
      if (rel === null) return 'generic';
      // Declaration order decides. The user controls the order, which is more
      // predictable than guessing which pattern is "more specific".
      for (const m of docTypeMatchers) {
        if (m.match(rel)) return m.docType;
      }
      return 'generic';
    },
  };
}
