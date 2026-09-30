import type { Diagnostic } from '../../diagnostics/types.js';
import { overlapsCode, quotedSpans } from '../../parser/text.js';
import type { Block } from '../../parser/types.js';
import { lineRange, registerDeterministic, report, spanRange, type RuleContext } from '../context.js';
import { CHINESE_DIGIT_CHARS, parseNumeral } from './numerals.js';
import { msg } from '../../messages.js';

/* ------------------------------------------------------------------ D104 */

/**
 * D104: a document of a given type is missing a required section.
 *
 * Matching is by keyword against heading text, and any one synonym in a group
 * satisfies that group, so "一、背景与目标" covers both the background and the
 * goal group.
 */
function requiredSections(ctx: RuleContext): Diagnostic[] {
  const groups = ctx.config.requiredSections.get(ctx.doc.docType) ?? [];
  if (groups.length === 0) return [];

  const headings = ctx.doc.blocks.filter((b) => b.kind === 'heading').map((b) => b.text);
  if (headings.length === 0) return [];

  const missing: string[] = [];
  for (const group of groups) {
    const hit = group.some((kw) => headings.some((h) => h.includes(kw)));
    if (!hit) missing.push(group.join('/'));
  }
  if (missing.length === 0) return [];

  return [
    report(ctx, {
      range: lineRange(1),
      values: { missing: missing.join('、'), docType: ctx.doc.docType },
      fingerprintText: `${ctx.doc.docType}:${missing.join(',')}`,
    }),
  ];
}

/* ------------------------------------------------------------------ D105 */

/** D105: a heading level was skipped, e.g. `##` followed by `####`. */
function headingJump(ctx: RuleContext): Diagnostic[] {
  const out: Diagnostic[] = [];
  let previousDepth: number | null = null;

  for (const block of ctx.doc.blocks) {
    if (block.kind !== 'heading' || block.depth === undefined) continue;
    const depth = block.depth;
    if (previousDepth !== null && depth > previousDepth + 1) {
      out.push(
        report(ctx, {
          range: block.range,
          values: { from: String(previousDepth), to: String(depth), title: block.text },
          fingerprintText: block.text,
        }),
      );
    }
    previousDepth = depth;
  }
  return out;
}

/* ------------------------------------------------------------------ D110 */

/**
 * D110: a heading with nothing under it before the next heading.
 *
 * "Nothing" has to include the content that produces no Block. A section whose
 * body is a fenced ASCII architecture diagram is not empty, and reporting it
 * was this rule's only false positive on the first real document it saw, so
 * `opaqueContent` is consulted alongside the blocks.
 */
/**
 * A trailing parenthetical in which the author says the section is empty on
 * purpose: "（0项，空分组）", "（已撤销）", "（……不再重复摘录）", "（到这里结束）".
 * All four were flagged on real documents; the author already knew.
 */
const DECLARED_EMPTY = /[（(][^（）()]*(空|无|略|撤销|结束|不再|同上|见|省略|暂)[^（）()]*[）)]\s*$/u;

function emptySection(ctx: RuleContext): Diagnostic[] {
  const out: Diagnostic[] = [];
  const blocks = ctx.doc.blocks;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block === undefined || block.kind !== 'heading') continue;
    if (DECLARED_EMPTY.test(block.text)) continue;

    const nextHeading = blocks.slice(i + 1).find((b) => b.kind === 'heading');
    const sectionEnd =
      nextHeading === undefined ? ctx.doc.lineCount : nextHeading.range.start.line - 1;
    const sectionStart = block.range.end.line;

    // A parent heading whose child heading follows immediately is normal
    // structure, not an empty section.
    let hasContent =
      nextHeading !== undefined && (nextHeading.depth ?? 1) > (block.depth ?? 1);

    if (!hasContent) {
      hasContent = blocks
        .slice(i + 1)
        .some(
          (b) =>
            b.kind !== 'heading' &&
            b.range.start.line > sectionStart &&
            b.range.start.line <= sectionEnd,
        );
    }

    if (!hasContent) {
      hasContent = ctx.doc.opaqueContent.some(
        (r) => r.start.line > sectionStart && r.start.line <= sectionEnd,
      );
    }

    if (!hasContent) {
      out.push(
        report(ctx, {
          range: block.range,
          values: { title: block.text },
          fingerprintText: block.text,
        }),
      );
    }
  }
  return out;
}

/* ------------------------------------------------------------------ D111 */

const COUNT_UNITS = '点|条|个|项|步|块|方面|部分|类|种|方式|原因|步骤|阶段|要素|指标|层';

/**
 * A count that could introduce a list.
 *
 * The lookbehind drops two innocent readings seen on real documents: 只有/仅有
 * ("全页只有一个主题" means "only one", not "the following one"), and the
 * partitive 里有/中有 ("四条里有一条不是……" picks one out of four).
 */
const COUNT_PATTERN = new RegExp(
  `(?<![只仅里中])(?:以下|下面|如下|共|总共|一共|分为|包括|包含|有)\\s*` +
    `([${CHINESE_DIGIT_CHARS}\\d]{1,3})\\s*(?:${COUNT_UNITS})`,
  'gu',
);

/** Counts the list items that immediately follow `index`. */
function followingListItems(blocks: readonly Block[], index: number): number {
  let n = 0;
  for (let j = index + 1; j < blocks.length; j++) {
    if (blocks[j]?.kind !== 'list_item') break;
    n++;
  }
  return n;
}

/**
 * D111: "以下三点" followed by a list of four.
 *
 * Only fires when a list follows immediately (design doc, section 6.2), and
 * only on the clause that introduces it: the paragraph must end with a colon
 * and the count must sit in its last sentence. On real documents a count in an
 * earlier sentence was always about something else ("只有一个纯搜索框。线上
 * 则是两个并列的按钮：") and a count in quotation marks was the writer quoting
 * someone else's mistake. The two real errors the rule found in 145 documents
 * -- "另有两项……：" over four items, "原型有两种画法……：" over three -- both
 * have exactly this shape.
 */
function countMismatch(ctx: RuleContext): Diagnostic[] {
  const out: Diagnostic[] = [];
  const blocks = ctx.doc.blocks;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block === undefined) continue;
    if (block.kind !== 'paragraph' && block.kind !== 'heading') continue;

    const actual = followingListItems(blocks, i);
    if (actual === 0) continue;

    const text = block.text.trimEnd();
    if (!text.endsWith('：') && !text.endsWith(':')) continue;
    let lastSentence = 0;
    for (let k = 0; k < text.length; k++) {
      if ('。！？；!?;'.includes(text[k] ?? '')) lastSentence = k + 1;
    }
    const quotes = quotedSpans(block.text);

    COUNT_PATTERN.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = COUNT_PATTERN.exec(block.text)) !== null) {
      const raw = m[1];
      if (raw === undefined) continue;
      if (m.index < lastSentence) continue;
      const matchEnd = m.index + m[0].length;
      if (quotes.some(([s, e]) => m !== null && m.index >= s && matchEnd <= e)) continue;
      const claimed = parseNumeral(raw);
      if (claimed === null || claimed === 0) continue;
      if (claimed === actual) continue;

      const start = m.index;
      out.push(
        report(ctx, {
          range: spanRange(ctx.doc, block, start, start + m[0].length),
          values: { claimed: String(claimed), actual: String(actual), phrase: m[0] },
          fingerprintText: block.text,
          fingerprintExtra: m[0],
        }),
      );
    }
  }
  return out;
}

/* ------------------------------------------------------------------ D103 */

const ARABIC_SECTION = /^(\d+(?:[.．]\d+)*)\s*[、.．:：]?\s*/u;
const CHINESE_SECTION = new RegExp(`^第?\\s*([${CHINESE_DIGIT_CHARS}]{1,3})\\s*[、章节]`, 'u');

/** Section numbers this document actually defines, normalised to "3.2" form. */
function definedSectionNumbers(ctx: RuleContext): Set<string> {
  const out = new Set<string>();
  for (const block of ctx.doc.blocks) {
    if (block.kind !== 'heading') continue;
    const arabic = ARABIC_SECTION.exec(block.text);
    if (arabic?.[1] !== undefined) {
      out.add(arabic[1].replace(/．/gu, '.'));
      continue;
    }
    const chinese = CHINESE_SECTION.exec(block.text);
    if (chinese?.[1] !== undefined) {
      const n = parseNumeral(chinese[1]);
      if (n !== null) out.add(String(n));
    }
  }
  return out;
}

/**
 * Words that make "第 3 节" a *reference*.
 *
 * Without one, "第 3 章" is a noun: handoff notes and review lists talk about
 * the chapters of the document under review all the time ("第五章同时同步……",
 * "| 第 5 章 | 课堂质检 |"), and every such mention was flagged when the verb
 * was optional. 如 is excluded after 比/例/假/譬, where it means "for example".
 */
const REF_VERB = '(?:参见|详见|参阅|参考|见|(?<![比例假譬])如)';

const SECTION_REF = new RegExp(
  `${REF_VERB}\\s*第?\\s*([${CHINESE_DIGIT_CHARS}\\d][${CHINESE_DIGIT_CHARS}\\d.．]{0,6})\\s*[章节]`,
  'gu',
);

/**
 * 表 N / 图 N as a reference: after a reference verb, or not glued to a
 * preceding Han character. The second arm is what stops 代表 2026-09-02 from
 * reading as "table 202", and 列表 / 意图 / 地图 likewise. The number may not
 * run on into more digits or a date separator.
 */
const figureOrTableRef = (noun: string): RegExp =>
  new RegExp(
    `(?:${REF_VERB}\\s*|(?<![\\u3400-\\u9fff]))${noun}\\s*(\\d{1,3})(?![\\d\\-－./])`,
    'gu',
  );
const FIGURE_REF = figureOrTableRef('图');
const TABLE_REF = figureOrTableRef('表');

/** A 《named document》 just before the reference means it points elsewhere. */
function refersToAnotherDocument(text: string, at: number): boolean {
  return text.slice(Math.max(0, at - 15), at).includes('》');
}

/**
 * D103: a cross-reference that points at nothing.
 *
 * Every branch here refuses to fire unless the document gives it a basis for
 * comparison: section references are only checked when the document numbers
 * its headings, and figure or table references only when at least one figure
 * or table exists. A document that keeps its tables in an appendix, or
 * references another document's figure, must not be flagged.
 */
function danglingReference(ctx: RuleContext): Diagnostic[] {
  const out: Diagnostic[] = [];
  const defined = definedSectionNumbers(ctx);
  const tableCount = ctx.doc.blocks.filter((b) => b.kind === 'table').length;
  const imageCount = (ctx.doc.source.match(/!\[[^\]]*\]\(/gu) ?? []).length;

  const scan = (
    block: Block,
    pattern: RegExp,
    resolve: (raw: string) => { ok: boolean; target: string } | null,
  ): void => {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(block.text)) !== null) {
      const raw = m[1];
      if (raw === undefined) continue;
      if (overlapsCode(block.codeSpans, m.index, m.index + m[0].length)) continue;
      if (refersToAnotherDocument(block.text, m.index)) continue;
      const verdict = resolve(raw);
      if (verdict === null || verdict.ok) continue;
      const start = m.index;
      out.push(
        report(ctx, {
          range: spanRange(ctx.doc, block, start, start + m[0].length),
          values: { ref: m[0].trim(), target: verdict.target },
          fingerprintText: block.text,
          fingerprintExtra: m[0],
        }),
      );
    }
  };

  for (const block of ctx.doc.blocks) {
    if (block.kind === 'heading') continue;

    if (defined.size > 0) {
      scan(block, SECTION_REF, (raw) => {
        const normalised = raw.replace(/．/gu, '.').replace(/[.]$/u, '');
        if (/^[\d.]+$/u.test(normalised)) {
          return { ok: defined.has(normalised), target: msg.diag.sectionRef(normalised) };
        }
        const n = parseNumeral(normalised);
        if (n === null) return null;
        return { ok: defined.has(String(n)), target: msg.diag.sectionRef(normalised) };
      });
    }

    if (tableCount > 0) {
      scan(block, TABLE_REF, (raw) => {
        const n = Number(raw);
        return { ok: n >= 1 && n <= tableCount, target: msg.diag.tableRef(raw) };
      });
    }

    if (imageCount > 0) {
      scan(block, FIGURE_REF, (raw) => {
        const n = Number(raw);
        return { ok: n >= 1 && n <= imageCount, target: msg.diag.figureRef(raw) };
      });
    }
  }

  return out;
}

registerDeterministic('required-sections', requiredSections);
registerDeterministic('heading-jump', headingJump);
registerDeterministic('empty-section', emptySection);
registerDeterministic('count-mismatch', countMismatch);
registerDeterministic('dangling-reference', danglingReference);
