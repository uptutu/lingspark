import type { DocType } from '../config/schema.js';

/** 1-based line and column into the *original* file (design doc, section 5.2). */
export interface Position {
  readonly line: number;
  readonly column: number;
}

export interface Range {
  readonly start: Position;
  readonly end: Position;
}

export type BlockKind = 'heading' | 'paragraph' | 'list_item' | 'table' | 'blockquote';

/** One cell of a table, kept so numeric rules can label a value by row+column. */
export interface TableCell {
  readonly text: string;
  readonly range: Range;
  readonly row: number;
  readonly column: number;
}

export interface TableStructure {
  /** Header row cell texts, empty when the table has no header. */
  readonly header: readonly string[];
  /** Body rows, each an array of cells. Excludes the header row. */
  readonly rows: readonly (readonly TableCell[])[];
  readonly headerCells: readonly TableCell[];
}

export interface Block {
  /** Stable within a document: `b0`, `b1`, ... in source order. */
  readonly id: string;
  readonly kind: BlockKind;
  /** Markdown marks stripped. This is what a judge sees. */
  readonly text: string;
  /** Verbatim source slice. */
  readonly raw: string;
  readonly range: Range;
  /** Enclosing headings, outermost first. */
  readonly headingPath: readonly string[];
  /** Heading level, for `kind === 'heading'` only. */
  readonly depth?: number;
  /** sha256 of the normalised text; the cache key and the change detector. */
  readonly hash: string;
  /** Present for `kind === 'table'`. */
  readonly table?: TableStructure;
  /** Maps an offset in `text` back to an offset in the source file. */
  readonly sourceOffsetOf: (textOffset: number) => number;
  /**
   * `[start, end)` offsets in `text` that came from inline code. Text-level
   * rules skip these: code is quoted, not written.
   */
  readonly codeSpans: readonly (readonly [number, number])[];
}

export type SuppressionKind = 'next-line' | 'range';

export interface Suppression {
  readonly kind: SuppressionKind;
  /** Rule ids this silences; null means every rule. */
  readonly ruleIds: readonly string[] | null;
  /** Inclusive line span in the original file. */
  readonly fromLine: number;
  readonly toLine: number;
  /** Where the comment itself is, for the suppression statistics. */
  readonly commentLine: number;
}

export interface ParsedDoc {
  readonly file: string;
  readonly docType: DocType;
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly blocks: readonly Block[];
  readonly suppressions: readonly Suppression[];
  /**
   * Ranges of content that produces no Block but is still content a reader
   * sees: fenced code, ASCII diagrams, raw HTML. A section whose only content
   * is an architecture diagram is not an empty section.
   */
  readonly opaqueContent: readonly Range[];
  readonly lineCount: number;
  /** The file's full text, so rules can quote from it. */
  readonly source: string;
  /** Converts a source offset to a 1-based line/column. */
  readonly positionAt: (offset: number) => Position;
  /** True when the file asked to be skipped via `lingspark: false` frontmatter. */
  readonly optedOut: boolean;
}
