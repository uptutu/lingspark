import type { Diagnostic } from '../../diagnostics/types.js';
import { registerDeterministic, report, spanRange, type RuleContext } from '../context.js';

/** Every offset covered by an occurrence of an approved spelling. */
function coveredByAllowed(text: string, allowed: ReadonlySet<string>): boolean[] {
  const covered = new Array<boolean>(text.length).fill(false);
  for (const spelling of allowed) {
    if (spelling === '') continue;
    let from = 0;
    for (;;) {
      const at = text.indexOf(spelling, from);
      if (at === -1) break;
      for (let i = at; i < at + spelling.length; i++) covered[i] = true;
      from = at + 1;
    }
  }
  return covered;
}

/**
 * D102: a spelling the glossary forbids.
 *
 * The substring trap is the whole difficulty here. A glossary that prefers
 * "日活跃用户" and forbids "日活跃" would otherwise fire on every correct use
 * of the preferred term, since one contains the other. So an occurrence is
 * only reported when none of its characters are already part of an approved
 * spelling -- and the check covers approved spellings of *every* term, not
 * just the one that owns the forbidden word.
 */
function terminology(ctx: RuleContext): Diagnostic[] {
  const { terms, allowedSpellings } = ctx.glossary;
  if (terms.length === 0) return [];

  const out: Diagnostic[] = [];

  for (const block of ctx.doc.blocks) {
    const text = block.text;
    if (text === '') continue;
    const covered = coveredByAllowed(text, allowedSpellings);

    for (const term of terms) {
      for (const forbidden of term.forbidden) {
        if (forbidden === '') continue;
        let from = 0;
        for (;;) {
          const at = text.indexOf(forbidden, from);
          if (at === -1) break;
          from = at + forbidden.length;

          let shadowed = false;
          for (let i = at; i < at + forbidden.length; i++) {
            if (covered[i] === true) {
              shadowed = true;
              break;
            }
          }
          if (shadowed) continue;

          out.push(
            report(ctx, {
              range: spanRange(ctx.doc, block, at, at + forbidden.length),
              values: { found: forbidden, preferred: term.preferred },
              fingerprintText: block.text,
              fingerprintExtra: forbidden,
            }),
          );
        }
      }
    }
  }

  return out;
}

registerDeterministic('terminology', terminology);
