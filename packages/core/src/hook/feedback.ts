import path from 'node:path';
import { MAX_FEEDBACK_DIAGNOSTICS } from '../constants.js';
import type { Diagnostic } from '../diagnostics/types.js';
import { msg } from '../messages.js';
import { compareDiagnostics } from '../passes/pass1.js';

const endsWithPunctuation = (s: string): boolean => /[。！？.!?]$/u.test(s.trimEnd());
const sentence = (s: string): string => (endsWithPunctuation(s) ? s : `${s}。`);

/**
 * The text a blocked model reads (design doc, 5.3): short, actionable, at
 * most MAX_FEEDBACK_DIAGNOSTICS items, most severe first, and a closing line
 * that tells the model not to suppress its way out.
 */
export function formatFeedback(
  diagnostics: readonly Diagnostic[],
  opts: { cwd: string; atStop: boolean; includesWarnings: boolean },
): string {
  const sorted = [...diagnostics].sort(compareDiagnostics);
  const shown = sorted.slice(0, MAX_FEEDBACK_DIAGNOSTICS);
  const hidden = sorted.length - shown.length;

  const rel = (f: string): string => {
    const r = path.relative(opts.cwd, f);
    return r === '' || r.startsWith('..') ? f : r.split(path.sep).join('/');
  };

  const byFile = new Map<string, Diagnostic[]>();
  for (const d of shown) {
    const list = byFile.get(d.file) ?? [];
    list.push(d);
    byFile.set(d.file, list);
  }

  const lines: string[] = [];
  const single = byFile.size === 1;
  const firstFile = [...byFile.keys()][0] ?? '';
  lines.push(
    single
      ? msg.hook.headSingle(rel(firstFile), sorted.length, opts.atStop)
      : msg.hook.headMulti(new Set(sorted.map((d) => d.file)).size, sorted.length, opts.atStop),
  );

  let index = 0;
  for (const [file, list] of byFile) {
    lines.push('');
    if (!single) lines.push(msg.hook.fileHeading(rel(file)));
    for (const d of list) {
      index++;
      let item = msg.hook.item(index, d.range.start.line, d.ruleId, sentence(d.message));
      if (d.suggestion !== undefined) item += msg.hook.suggestion(sentence(d.suggestion));
      lines.push(item);
    }
  }

  if (hidden > 0) lines.push(msg.hook.more(hidden));
  lines.push('');
  if (opts.includesWarnings) lines.push(msg.hook.warningsNote);
  lines.push(msg.hook.closing);
  return `${lines.join('\n')}\n`;
}
