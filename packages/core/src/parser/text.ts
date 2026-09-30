import type { Nodes, PhrasingContent } from 'mdast';

/**
 * A run of characters in the extracted text that came verbatim from a
 * contiguous run in the source file.
 */
interface Segment {
  /** Offset in the extracted text. */
  readonly out: number;
  /** Offset in the source file. */
  readonly src: number;
  readonly len: number;
}

/** Maps an offset in extracted text back to an offset in the source file. */
export type SourceOffsetOf = (textOffset: number) => number;

/**
 * Builds plain text out of inline markdown while remembering where each piece
 * came from.
 *
 * Without this, a diagnostic about "the third sentence of this paragraph"
 * could only point at the paragraph. Rules need to underline a span, and the
 * span's offset in the stripped text does not line up with the source once
 * `**`, backticks or link syntax have been removed.
 */
export class TextBuilder {
  private out = '';
  private readonly segments: Segment[] = [];
  private readonly code: [number, number][] = [];

  /** Appends text that exists in the source at `src`. */
  appendFromSource(value: string, src: number): void {
    if (value.length === 0) return;
    this.segments.push({ out: this.out.length, src, len: value.length });
    this.out += value;
  }

  /** Appends text with no source counterpart (image alt text, joiners). */
  appendSynthetic(value: string): void {
    this.out += value;
  }

  /** Marks `[start, end)` of the extracted text as inline code. */
  markCode(start: number, end: number): void {
    if (end > start) this.code.push([start, end]);
  }

  get length(): number {
    return this.out.length;
  }

  build(): { text: string; sourceOffsetOf: SourceOffsetOf; codeSpans: readonly (readonly [number, number])[] } {
    const segments = this.segments;
    const sourceOffsetOf: SourceOffsetOf = (textOffset: number): number => {
      if (segments.length === 0) return 0;
      let lo = 0;
      let hi = segments.length - 1;
      let found = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const seg = segments[mid];
        if (seg === undefined) break;
        if (textOffset < seg.out) {
          hi = mid - 1;
        } else if (textOffset >= seg.out + seg.len) {
          found = mid;
          lo = mid + 1;
        } else {
          return seg.src + (textOffset - seg.out);
        }
      }
      // Offset landed in synthetic text or past the end: clamp to the end of
      // the nearest preceding source run, or to the start of the first one.
      if (found >= 0) {
        const seg = segments[found];
        if (seg !== undefined) return seg.src + seg.len;
      }
      return segments[0]?.src ?? 0;
    };
    return { text: this.out, sourceOffsetOf, codeSpans: this.code.slice() };
  }
}

/** Whether `[start, end)` overlaps any inline code span. */
export function overlapsCode(
  codeSpans: readonly (readonly [number, number])[],
  start: number,
  end: number,
): boolean {
  return codeSpans.some(([s, e]) => start < e && end > s);
}

/** How many backticks open an inlineCode span at `offset` in `source`. */
function backtickRun(source: string, offset: number): number {
  let n = 0;
  while (source.charCodeAt(offset + n) === 96 /* ` */) n++;
  return n;
}

/**
 * Appends a node's visible text to `builder`, recursing into inline children.
 *
 * Markdown marks disappear; what a reader sees is what a judge sees.
 */
export function appendNodeText(node: Nodes, source: string, builder: TextBuilder): void {
  switch (node.type) {
    case 'text': {
      const start = node.position?.start.offset;
      if (start === undefined) builder.appendSynthetic(node.value);
      else builder.appendFromSource(node.value, start);
      return;
    }

    case 'inlineCode': {
      const before = builder.length;
      const start = node.position?.start.offset;
      if (start === undefined) {
        builder.appendSynthetic(node.value);
      } else {
        // The node position spans the backticks; the value does not. Padding
        // inside `` ` `` is also stripped from the value, so only trust the
        // offset when the arithmetic lines up.
        const ticks = backtickRun(source, start);
        const inner = start + ticks;
        if (source.slice(inner, inner + node.value.length) === node.value) {
          builder.appendFromSource(node.value, inner);
        } else {
          builder.appendSynthetic(node.value);
        }
      }
      // Code stays in the text -- a judge reading the paragraph should see it
      // -- but text-level rules must be able to tell it apart: `TODO:` inside
      // backticks is a writer talking about placeholders, not leaving one.
      builder.markCode(before, builder.length);
      return;
    }

    case 'break':
      builder.appendSynthetic('\n');
      return;

    case 'image':
      // Alt text is visible to a reader, but it is not in the source at a
      // usable offset, so it maps to nothing.
      if (node.alt !== null && node.alt !== undefined) builder.appendSynthetic(node.alt);
      return;

    case 'imageReference':
      if (node.alt !== null && node.alt !== undefined) builder.appendSynthetic(node.alt);
      return;

    case 'html':
      // Inline HTML is markup, not prose. Skipping it keeps comments and
      // `<br>` out of what the rules read.
      return;

    case 'footnoteReference':
      return;

    default: {
      const children = (node as { children?: PhrasingContent[] }).children;
      if (children === undefined) return;
      for (const child of children) appendNodeText(child, source, builder);
    }
  }
}

/**
 * Normalised form used for hashing and for equality between blocks.
 *
 * Whitespace runs collapse to one space and the ends are trimmed, so that
 * re-wrapping a paragraph does not invalidate its cache entry.
 */
export function normalizeText(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

const QUOTE_PAIRS: Readonly<Record<string, string>> = {
  '“': '”',
  '「': '」',
  '『': '』',
  '"': '"',
};

/**
 * `[start, end)` spans of text inside quotation marks.
 *
 * Quoted text is being mentioned, not used: "文案称“同时满足以下 3 项”" quotes
 * someone else's count, and `"TODO: 补充"` in a set of instructions talks
 * about a placeholder rather than leaving one. Rules that react to specific
 * words skip these spans.
 */
export function quotedSpans(text: string): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < text.length; i++) {
    const close = QUOTE_PAIRS[text[i] ?? ''];
    if (close === undefined) continue;
    const end = text.indexOf(close, i + 1);
    if (end === -1) continue;
    out.push([i, end + 1]);
    i = end;
  }
  return out;
}
