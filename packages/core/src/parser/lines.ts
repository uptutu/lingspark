import type { Position } from './types.js';

/**
 * Offset -> line/column lookup over a source text.
 *
 * Built once per document and shared by every rule, because rules report
 * positions constantly and scanning the text each time is quadratic.
 */
export class LineIndex {
  /** Offset at which each line starts, `lineStarts[0] === 0`. */
  private readonly lineStarts: number[];

  constructor(source: string) {
    const starts = [0];
    for (let i = 0; i < source.length; i++) {
      if (source.charCodeAt(i) === 10 /* \n */) starts.push(i + 1);
    }
    this.lineStarts = starts;
  }

  /** 1-based line and column for a source offset. */
  positionAt(offset: number): Position {
    const clamped = Math.max(0, offset);
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((this.lineStarts[mid] ?? 0) <= clamped) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: clamped - (this.lineStarts[lo] ?? 0) + 1 };
  }

  get lineCount(): number {
    return this.lineStarts.length;
  }
}
