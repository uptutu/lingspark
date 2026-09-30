/** A sentence, with offsets into the text it was split from. */
export interface Sentence {
  readonly text: string;
  /** Inclusive start offset in the input text. */
  readonly start: number;
  /** Exclusive end offset in the input text. */
  readonly end: number;
}

/**
 * Sentence-final punctuation (design doc, section 6.1).
 *
 * The half-width period is deliberately absent. In mixed Chinese/English
 * technical prose it appears in `3.5`, `v1.2`, `docs.typesafe.ai` and `etc.`
 * far more often than it ends a sentence, and a wrong split shows up as a
 * false positive in every rule that reasons per sentence. Design principle 1.
 */
const TERMINATORS = new Set(['。', '！', '？', '；', '!', '?', ';', '…']);

/** Closing punctuation that belongs to the sentence it follows. */
const CLOSERS = new Set([
  '”', '’', '"', "'",
  '）', ')', '】', ']', '］',
  '》', '」', '』', '〉', '>',
]);

/**
 * Splits text into sentences, keeping every offset usable.
 *
 * Callers combine the returned offsets with `Block.sourceOffsetOf` to point a
 * diagnostic at one sentence inside a paragraph.
 */
export function splitSentences(text: string): Sentence[] {
  const out: Sentence[] = [];
  const chars = [...text];

  // Offsets are in UTF-16 code units so they compose with String.slice and
  // with the source map, but iteration is by code point so an emoji or a rare
  // CJK character cannot split a surrogate pair.
  const offsets: number[] = [];
  let acc = 0;
  for (const ch of chars) {
    offsets.push(acc);
    acc += ch.length;
  }
  offsets.push(acc);

  let start = 0;
  const flush = (endIndex: number): void => {
    const from = offsets[start] ?? 0;
    const to = offsets[endIndex] ?? text.length;
    const slice = text.slice(from, to);
    const leading = slice.length - slice.trimStart().length;
    const trimmed = slice.trim();
    if (trimmed.length > 0) {
      out.push({ text: trimmed, start: from + leading, end: from + leading + trimmed.length });
    }
    start = endIndex;
  };

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === undefined) continue;

    if (ch === '\n') {
      flush(i + 1);
      continue;
    }

    if (!TERMINATORS.has(ch)) continue;

    // "真的吗？！" and "等等……" end once, not two or three times.
    let j = i;
    while (j + 1 < chars.length && TERMINATORS.has(chars[j + 1] ?? '')) j++;
    while (j + 1 < chars.length && CLOSERS.has(chars[j + 1] ?? '')) j++;
    flush(j + 1);
    i = j;
  }

  if (start < chars.length) flush(chars.length);
  return out;
}
