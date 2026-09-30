import type { Diagnostic } from '../../diagnostics/types.js';
import { normalizeText, overlapsCode, quotedSpans } from '../../parser/text.js';
import { registerDeterministic, report, spanRange, type RuleContext } from '../context.js';
import { msg } from '../../messages.js';

/** Han characters. Deliberately excludes full-width punctuation. */
const HAN = /[㐀-䶿一-鿿]/u;
const LATIN_OR_DIGIT = /[0-9A-Za-z]/u;

const isHan = (ch: string | undefined): boolean => ch !== undefined && HAN.test(ch);
const isLatin = (ch: string | undefined): boolean => ch !== undefined && LATIN_OR_DIGIT.test(ch);

/* ------------------------------------------------------------------ D106 */

/**
 * D106: half-width punctuation inside Chinese text.
 *
 * Each mark has its own adjacency test rather than a blanket "no ASCII
 * punctuation in a Chinese paragraph" rule, because technical prose is full of
 * `v1.2`, `50,000` and `foo(bar)` that are correct as written. The period is
 * the most dangerous of the set and gets the strictest test.
 */
/**
 * More than this many affected blocks and D106 reports once for the whole
 * document instead of once per block.
 *
 * On real documents the problem is bimodal: either a stray half-width comma
 * or two, or a document written entirely in half-width style (351 blocks in
 * one). The second case is one decision -- switch the whole document -- and
 * listing it block by block would push every other diagnostic out of the
 * feedback the model sees.
 */
const PUNCTUATION_COLLAPSE_BLOCKS = 5;

function mixedPunctuation(ctx: RuleContext): Diagnostic[] {
  const perBlock = punctuationByBlock(ctx);
  if (perBlock.length <= PUNCTUATION_COLLAPSE_BLOCKS) return perBlock.map((p) => p.diagnostic);

  const first = perBlock[0];
  if (first === undefined) return [];
  const total = perBlock.reduce((n, p) => n + p.count, 0);
  const marks = [...new Set(perBlock.flatMap((p) => [...p.marks]))].join('');
  return [
    report(ctx, {
      range: first.diagnostic.range,
      values: { mark: marks, suffix: msg.diag.punctuationInDocument(perBlock.length, total) },
      fingerprintText: `document-wide:${marks}`,
    }),
  ];
}

function punctuationByBlock(
  ctx: RuleContext,
): { diagnostic: Diagnostic; count: number; marks: string }[] {
  const out: { diagnostic: Diagnostic; count: number; marks: string }[] = [];

  for (const block of ctx.doc.blocks) {
    const text = block.text;
    if (!HAN.test(text)) continue;
    const hits: { index: number; mark: string }[] = [];

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === undefined) continue;
      const prev = text[i - 1];
      const next = text[i + 1];
      let hit = false;

      switch (ch) {
        case ',':
        case ';':
        case ':':
        case '!':
        case '?':
          hit = isHan(prev) || isHan(next);
          break;
        case '.':
          // Only when it closes a Chinese clause: a Han character before, and
          // nothing that would make it a decimal point or a domain after.
          hit = isHan(prev) && (next === undefined || next === ' ' || isHan(next));
          break;
        case '(':
          hit = isHan(next);
          break;
        case ')':
          hit = isHan(prev);
          break;
        default:
          break;
      }

      if (hit && !overlapsCode(block.codeSpans, i, i + 1)) hits.push({ index: i, mark: ch });
    }

    if (hits.length === 0) continue;
    // One diagnostic per block, not per mark. A table of notation with
    // twenty half-width commas is one problem to fix, and twenty identical
    // warnings is how a user decides the tool is not worth having.
    const first = hits[0];
    if (first === undefined) continue;
    const marks = [...new Set(hits.map((h) => h.mark))].join('');
    out.push({
      count: hits.length,
      marks,
      diagnostic: report(ctx, {
        range: spanRange(ctx.doc, block, first.index, first.index + 1),
        values: {
          mark: marks,
          suffix: hits.length > 1 ? msg.diag.punctuationInBlock(hits.length) : '',
        },
        fingerprintText: block.text,
        fingerprintExtra: marks,
      }),
    });
  }
  return out;
}

/* ------------------------------------------------------------------ D107 */

/** D107: no space between Chinese and Latin text. Off by default; info level. */
function cjkLatinSpacing(ctx: RuleContext): Diagnostic[] {
  const out: Diagnostic[] = [];

  for (const block of ctx.doc.blocks) {
    const text = block.text;
    for (let i = 1; i < text.length; i++) {
      const prev = text[i - 1];
      const ch = text[i];
      const boundary = (isHan(prev) && isLatin(ch)) || (isLatin(prev) && isHan(ch));
      if (!boundary) continue;
      if (overlapsCode(block.codeSpans, i - 1, i + 1)) continue;
      out.push(
        report(ctx, {
          range: spanRange(ctx.doc, block, i - 1, i + 1),
          values: { span: text.slice(Math.max(0, i - 4), i + 4) },
          fingerprintText: block.text,
          fingerprintExtra: `@${String(i)}`,
        }),
      );
    }
  }
  return out;
}

/* ------------------------------------------------------------------ D108 */

/**
 * Placeholders that mean "not written yet".
 *
 * The line this list must not cross: a placeholder is text the author meant to
 * replace; an open item is the author honestly saying something is undecided.
 * 待确认、待定 and TBD are open items. Product documents use them correctly and
 * often -- 204 and 58 times across 145 real documents -- and blocking them
 * would teach the model that the way to pass is to invent an answer where the
 * honest one is "not decided yet". A checker that rewards fabrication is worse
 * than no checker. 占位 is gone for a different reason: in a booking product
 * it is a domain term ("占位时长", "不占位").
 *
 * ASCII markers need a boundary so that `TODOS.md` or a variable named
 * `xxxHandler` does not trip the rule; Chinese markers have no word
 * boundaries, so they are matched literally and kept specific enough that a
 * false hit is implausible.
 */
const ASCII_PLACEHOLDERS = /(?<![A-Za-z])(TODO|FIXME|XXX)(?![A-Za-z])/gu;
const CJK_PLACEHOLDERS = /(有待补充|待补充|待填写|此处省略|内容省略|（略）|\(略\))/gu;

/**
 * Whether a marker at `[start, end)` is being *used* as a placeholder rather
 * than mentioned or used as an ordinary word.
 *
 * Real documents showed three innocent uses, each ruled out here: a marker
 * inside inline code (`<!-- TODO: ... -->` quoted in a style guide); TODO as
 * part of a feature name ("TODO 驱动的工作流"); and 待补充/待填写 as a state
 * name, recognisable because it is listed with other states ("待补充、待确认")
 * or modifies a noun ("待填写的课次").
 */
function usedAsPlaceholder(text: string, start: number, end: number, marker: string): boolean {
  const after = text.slice(end).trimStart();
  const next = after[0];
  const prev = text.slice(0, start).trimEnd().slice(-1);

  if (marker === 'TODO' || marker === 'FIXME') {
    // TODO: / TODO： / (TODO) / a TODO opening the paragraph or item, alone or
    // followed by a space ("TODO 补充上线时间"). The raw next character, not
    // `next`: that one has had the space trimmed away.
    if (next === ':' || next === '：') return true;
    if ('(（[【'.includes(prev) && prev !== '') return true;
    const raw = text[end];
    return start === 0 && (raw === undefined || /[\s，。]/u.test(raw));
  }
  if (marker === 'XXX') return true;

  // Chinese markers.
  if (next === '的' || next === '、' || prev === '、') return false;
  return true;
}

function placeholderLeft(ctx: RuleContext): Diagnostic[] {
  const out: Diagnostic[] = [];

  for (const block of ctx.doc.blocks) {
    const quotes = quotedSpans(block.text);
    for (const pattern of [ASCII_PLACEHOLDERS, CJK_PLACEHOLDERS]) {
      pattern.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(block.text)) !== null) {
        const found = m[1] ?? m[0];
        const end = m.index + m[0].length;
        const start = m.index;
        if (overlapsCode(block.codeSpans, start, end)) continue;
        if (quotes.some(([s, e]) => start >= s && end <= e)) continue;
        if (!usedAsPlaceholder(block.text, m.index, end, found)) continue;
        out.push(
          report(ctx, {
            range: spanRange(ctx.doc, block, m.index, m.index + m[0].length),
            values: { placeholder: found },
            fingerprintText: block.text,
            fingerprintExtra: found,
          }),
        );
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ D109 */

/** Character trigrams, for a cheap similarity measure over Chinese text. */
function trigrams(text: string): Set<string> {
  const chars = [...text];
  const out = new Set<string>();
  for (let i = 0; i + 3 <= chars.length; i++) out.add(chars.slice(i, i + 3).join(''));
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const g of a) if (b.has(g)) shared++;
  return shared / (a.size + b.size - shared);
}

/** Below this, repetition is normal: "暂无", "同上", a repeated table caption. */
const MIN_DUPLICATE_CHARS = 30;

/**
 * The rule is about repeated Chinese *prose*, so it only looks at blocks with
 * at least this many Han characters. Measured in total characters, it fired
 * on pasted English transcript lines ("Continue from where you left off."),
 * image-size notices, and lists of URLs or file paths whose shared prefix made
 * them look "highly similar". None of those is a paragraph someone wrote twice.
 */
const MIN_DUPLICATE_HAN = 20;
const NEAR_DUPLICATE_THRESHOLD = 0.9;

const hanCount = (text: string): number => {
  let n = 0;
  for (const ch of text) if (isHan(ch)) n++;
  return n;
};

/**
 * D109: the same paragraph twice.
 *
 * Exact duplicates are reported from 30 characters up; near-duplicates need to
 * clear a high similarity bar as well, because two paragraphs that describe
 * parallel cases ("iOS 上……", "Android 上……") are legitimately similar and
 * reporting them would be the rule's most common false positive.
 */
function duplicateParagraph(ctx: RuleContext): Diagnostic[] {
  const out: Diagnostic[] = [];
  const candidates = ctx.doc.blocks
    .filter((b) => b.kind === 'paragraph' || b.kind === 'list_item')
    .map((b) => ({ block: b, norm: normalizeText(b.text) }))
    .filter((c) => [...c.norm].length >= MIN_DUPLICATE_CHARS && hanCount(c.norm) >= MIN_DUPLICATE_HAN);

  const grams = candidates.map((c) => trigrams(c.norm));

  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i];
      const b = candidates[j];
      if (a === undefined || b === undefined) continue;

      const exact = a.norm === b.norm;
      if (!exact) {
        const ga = grams[i];
        const gb = grams[j];
        if (ga === undefined || gb === undefined) continue;
        if (jaccard(ga, gb) < NEAR_DUPLICATE_THRESHOLD) continue;
      }

      out.push(
        report(ctx, {
          range: b.block.range,
          values: {
            line: String(a.block.range.start.line),
            kind: exact ? msg.diag.duplicateExact : msg.diag.duplicateNear,
          },
          related: [
            {
              file: ctx.doc.file,
              line: a.block.range.start.line,
              note: msg.diag.relatedOther,
            },
          ],
          fingerprintText: b.norm,
          fingerprintExtra: a.norm,
        }),
      );
      break; // one report per duplicated paragraph is enough
    }
  }
  return out;
}

registerDeterministic('mixed-punctuation', mixedPunctuation);
registerDeterministic('cjk-latin-spacing', cjkLatinSpacing);
registerDeterministic('placeholder-left', placeholderLeft);
registerDeterministic('duplicate-paragraph', duplicateParagraph);
