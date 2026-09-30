import { createHash } from 'node:crypto';
import type { Heading, List, ListItem, Nodes, Root, RootContent, Table } from 'mdast';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { parse as parseYaml } from 'yaml';
import { docTypeSchema, type DocType } from '../config/schema.js';
import { LineIndex } from './lines.js';
import { buildSuppressions, parseDirective, type DirectiveAt } from './suppressions.js';
import { appendNodeText, normalizeText, TextBuilder } from './text.js';
import type {
  Block,
  BlockKind,
  ParsedDoc,
  Position,
  Range,
  TableCell,
  TableStructure,
} from './types.js';

/**
 * remark alone parses neither frontmatter nor GFM tables: `---` becomes a
 * thematic break and a table becomes one long paragraph. Both plugins are
 * load-bearing, not conveniences.
 */
const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkFrontmatter, ['yaml']);

function hashOf(text: string): string {
  return createHash('sha256').update(normalizeText(text), 'utf8').digest('hex');
}

export interface ParseOptions {
  readonly file: string;
  /** Doc type implied by the path; frontmatter `doc_type` overrides it. */
  readonly docTypeFromPath?: DocType;
}

interface BuildContext {
  readonly source: string;
  readonly lines: LineIndex;
  readonly blocks: Block[];
  readonly headingStack: { depth: number; text: string }[];
  readonly directives: DirectiveAt[];
  readonly opaqueContent: Range[];
}

function rangeOf(node: Nodes): Range {
  const p = node.position;
  if (p === undefined) return { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } };
  const start: Position = { line: p.start.line, column: p.start.column };
  const end: Position = { line: p.end.line, column: p.end.column };
  return { start, end };
}

function rawOf(node: Nodes, source: string): string {
  const s = node.position?.start.offset;
  const e = node.position?.end.offset;
  if (s === undefined || e === undefined) return '';
  return source.slice(s, e);
}

type BuiltText = ReturnType<TextBuilder['build']>;

/**
 * Concatenates inline children with no separator: `**a**b` reads as `ab`,
 * exactly as it renders.
 */
function textOfInline(children: readonly Nodes[], source: string): BuiltText {
  const builder = new TextBuilder();
  for (const child of children) appendNodeText(child, source, builder);
  return builder.build();
}

/**
 * Joins block-level children with a newline each, so the paragraph boundaries
 * inside a blockquote or a multi-paragraph list item survive.
 */
function textOfBlocks(children: readonly Nodes[], source: string): BuiltText {
  const builder = new TextBuilder();
  let first = true;
  for (const child of children) {
    if (child.type === 'list') continue; // nested lists become their own blocks
    if (!first) builder.appendSynthetic('\n');
    appendNodeText(child, source, builder);
    first = false;
  }
  return builder.build();
}

function pushBlock(
  ctx: BuildContext,
  node: Nodes,
  kind: BlockKind,
  built: BuiltText,
  extra?: { depth?: number; table?: TableStructure },
): void {
  const block: Block = {
    id: `b${ctx.blocks.length}`,
    kind,
    text: built.text,
    raw: rawOf(node, ctx.source),
    range: rangeOf(node),
    headingPath: ctx.headingStack.map((h) => h.text),
    hash: hashOf(built.text),
    sourceOffsetOf: built.sourceOffsetOf,
    codeSpans: built.codeSpans,
    ...(extra?.depth !== undefined ? { depth: extra.depth } : {}),
    ...(extra?.table !== undefined ? { table: extra.table } : {}),
  };
  ctx.blocks.push(block);
}

function buildTable(node: Table, ctx: BuildContext): TableStructure {
  const rowsIn = node.children;
  const toCells = (rowIndex: number, row: (typeof rowsIn)[number]): TableCell[] =>
    row.children.map((cell, column) => {
      const built = textOfInline(cell.children, ctx.source);
      return {
        text: built.text.trim(),
        range: rangeOf(cell),
        row: rowIndex,
        column,
      };
    });

  const headerRow = rowsIn[0];
  const headerCells = headerRow === undefined ? [] : toCells(0, headerRow);
  const rows = rowsIn.slice(1).map((row, i) => toCells(i + 1, row));

  return {
    header: headerCells.map((c) => c.text),
    headerCells,
    rows,
  };
}

function visitHeading(node: Heading, ctx: BuildContext): void {
  const built = textOfInline(node.children, ctx.source);
  // The heading's own path is its ancestors, so record the block before the
  // stack takes it in.
  while (
    ctx.headingStack.length > 0 &&
    (ctx.headingStack[ctx.headingStack.length - 1]?.depth ?? 0) >= node.depth
  ) {
    ctx.headingStack.pop();
  }
  pushBlock(ctx, node, 'heading', built, { depth: node.depth });
  ctx.headingStack.push({ depth: node.depth, text: built.text });
}

function visitList(node: List, ctx: BuildContext): void {
  for (const item of node.children) visitListItem(item, ctx);
}

function visitListItem(node: ListItem, ctx: BuildContext): void {
  const built = textOfBlocks(node.children, ctx.source);
  if (built.text.trim().length > 0) pushBlock(ctx, node, 'list_item', built);
  for (const child of node.children) {
    if (child.type === 'list') visitList(child, ctx);
  }
}

function visitNode(node: RootContent, ctx: BuildContext): void {
  switch (node.type) {
    case 'code':
    case 'footnoteDefinition':
      // No block -- a judge has nothing to say about code -- but it is still
      // content, so record where it sits.
      ctx.opaqueContent.push(rangeOf(node));
      return;

    case 'yaml':
    case 'thematicBreak':
    case 'definition':
      // Neither a block nor content. Line numbers stay correct regardless,
      // because every position comes from the original source.
      return;

    case 'html': {
      const directive = parseDirective(node.value);
      if (directive !== null) {
        if (node.position !== undefined) {
          ctx.directives.push({ ...directive, line: node.position.start.line });
        }
        return;
      }
      ctx.opaqueContent.push(rangeOf(node));
      return;
    }

    case 'heading':
      visitHeading(node, ctx);
      return;

    case 'paragraph':
      pushBlock(ctx, node, 'paragraph', textOfInline(node.children, ctx.source));
      return;

    case 'list':
      visitList(node, ctx);
      return;

    case 'table':
      pushBlock(ctx, node, 'table', textOfBlocks(node.children, ctx.source), {
        table: buildTable(node, ctx),
      });
      return;

    case 'blockquote':
      pushBlock(ctx, node, 'blockquote', textOfBlocks(node.children, ctx.source));
      return;

    default:
      return;
  }
}

function readFrontmatter(tree: Root): Record<string, unknown> {
  const node = tree.children.find((c) => c.type === 'yaml');
  if (node === undefined || node.type !== 'yaml') return {};
  try {
    const parsed: unknown = parseYaml(node.value);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // A broken frontmatter block is the author's problem, not a reason to stop
    // checking the prose below it.
  }
  return {};
}

/** Pass 0 (design doc, section 6.1). */
export function parseDocument(source: string, opts: ParseOptions): ParsedDoc {
  const tree = processor.parse(source);
  const lines = new LineIndex(source);
  const frontmatter = readFrontmatter(tree);

  const ctx: BuildContext = {
    source,
    lines,
    blocks: [],
    headingStack: [],
    directives: [],
    opaqueContent: [],
  };
  for (const child of tree.children) visitNode(child, ctx);

  const fmDocType = docTypeSchema.safeParse(frontmatter['doc_type']);
  const docType: DocType = fmDocType.success
    ? fmDocType.data
    : (opts.docTypeFromPath ?? 'generic');

  const suppressions = buildSuppressions(
    ctx.directives,
    ctx.blocks.map((b) => b.range.start.line),
    lines.lineCount,
  );

  return {
    file: opts.file,
    docType,
    frontmatter,
    blocks: ctx.blocks,
    suppressions,
    opaqueContent: ctx.opaqueContent,
    lineCount: lines.lineCount,
    source,
    positionAt: (offset: number) => lines.positionAt(offset),
    optedOut: frontmatter['lingspark'] === false,
  };
}
