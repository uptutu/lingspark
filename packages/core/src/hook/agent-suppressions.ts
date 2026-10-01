import { parseDirective } from '../parser/suppressions.js';
import { stringsIn } from './input.js';

/**
 * Suppression attribution (D-092). A `lingspark-disable` comment silences a
 * rule, and `lingspark: false` frontmatter silences a whole file -- fine when
 * the user writes it, self-grading when the checked agent writes it. This
 * module decides which directives the agent's own tool call introduced, by
 * matching the directives found in the file against the text the tool call
 * carried (Write's `content`, Edit's `new_string`, an apply_patch body).
 */

export interface AgentSuppressionInfo {
  /** 1-based comment lines of `lingspark-disable` directives the write introduced. */
  readonly lines: readonly number[];
  /** The write introduced `lingspark: false` frontmatter. */
  readonly optedOut: boolean;
}

const OPT_OUT = /^\s*lingspark:\s*false\s*$/mu;

/** Whether the file's YAML frontmatter opts the file out. */
function frontmatterOptsOut(text: string): boolean {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text);
  return m?.[1] !== undefined && OPT_OUT.test(m[1]);
}

/**
 * Directives the given tool payload introduced into `fileText`.
 * Matching is textual: a directive line in the file whose trimmed text appears
 * anywhere in the payload's strings was (re)written by this tool call. A
 * directive the file already had, that the payload does not mention, is the
 * user's and stands.
 */
export function findAgentSuppressions(fileText: string, toolInput: unknown): AgentSuppressionInfo {
  const haystack = stringsIn(toolInput).join('\n');
  const lines: number[] = [];
  if (haystack !== '') {
    const fileLines = fileText.split(/\r?\n/u);
    for (let i = 0; i < fileLines.length; i++) {
      const trimmed = (fileLines[i] as string).trim();
      if (parseDirective(trimmed) === null) continue;
      if (haystack.includes(trimmed)) lines.push(i + 1);
    }
  }
  const optedOut = frontmatterOptsOut(fileText) && haystack.includes('lingspark: false');
  return { lines, optedOut };
}
