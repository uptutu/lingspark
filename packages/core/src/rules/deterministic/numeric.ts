import type { Diagnostic } from '../../diagnostics/types.js';
import { splitSentences } from '../../parser/sentences.js';
import type { Block } from '../../parser/types.js';
import { registerDeterministic, report, spanRange, type RuleContext } from '../context.js';
import { msg } from '../../messages.js';

/** One number found in the document, with whatever labels it. */
export interface Measurement {
  /** Raw label text: the noun phrase before the number, or row + column headers. */
  readonly label: string;
  /** The number as written, without separators: "50", "32.5". */
  readonly value: string;
  /** Unit as written, or '' when there is none. */
  readonly unit: string;
  /** Where it came from, for the diagnostic. */
  readonly block: Block;
  /**
   * Which part of the block: a line break right after a full stop starts a
   * new part (D-069). Agents often write one sentence per line with no blank
   * line between, which Markdown reads as a single paragraph.
   */
  readonly part: number;
  readonly line: number;
  readonly startInText: number;
  readonly endInText: number;
  readonly source: 'prose' | 'table';
  /**
   * For table cells: which table-shaped context the label is meaningful in,
   * as `section path | header row`. Two table cells are only comparable when
   * this matches. Empty for prose.
   */
  readonly scope: string;
}

/**
 * Units worth recognising. Restricting to a list rather than "any characters
 * after a number" keeps `2026 年 11 月` from being read as a measurement of
 * 11 somethings.
 */
const UNITS = [
  '%', '‰',
  '万', '亿', '千', '百',
  'K', 'k', 'M', 'm', 'B',
  '个', '人', '次', '条', '台', '家', '位', '款',
  '元', '美元', '万元', '亿元',
  '倍', '分', '点',
  '毫秒', '秒', '分钟', '小时', '天', '周', '月', '年',
  'ms', 's', 'MB', 'GB', 'KB', 'TB', 'QPS', 'TPS',
];
const UNIT_ALTERNATION = UNITS.slice()
  .sort((a, b) => b.length - a.length)
  .map((u) => u.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
  .join('|');

/**
 * A number, optionally followed by a unit from the list.
 *
 * The lookbehind refuses a number glued to a Latin letter, and the lookahead
 * refuses a Latin unit glued to more letters or digits. Without them `D3B`
 * reads as "3 billion" and `H100` as "100 of something" -- both seen on real
 * documents, where identifiers outnumber measurements.
 */
const NUMBER_WITH_UNIT = new RegExp(
  `(?<![A-Za-z0-9.])(\\d+(?:,\\d{3})*(?:\\.\\d+)?)\\s*(${UNIT_ALTERNATION})?(?![A-Za-z0-9])`,
  'gu',
);

/**
 * Words that mean the sentence is describing a change or a comparison.
 *
 * Two different numbers for the same thing are expected there -- that is what
 * "from 32% to 38%" says -- so every measurement in such a sentence is
 * dropped. The design doc calls this out explicitly, and it is the single
 * biggest source of false positives the rule would otherwise have.
 */
const CHANGE_MARKERS =
  /(从|由|提升|提高|增长|增加|上升|下降|降至|降到|减少|缩短|翻|同比|环比|改为|调整为|优化到|→|->|至少|最多|不超过|超过|低于|高于)/u;

/**
 * "<label> <copula> <number>": the shape of a sentence that *states* what a
 * quantity is. 日活目标是 50 万、接口超时设为 30 秒、覆盖率：80%.
 *
 * Only numbers introduced this way count as measurements. On real documents
 * the characters in front of a bare number are as often a preposition (按、
 * 约), a verb (扣除), or the tail of the previous number (万元计) as they are
 * a noun, and every such fragment used as a label was a false positive. A
 * copula is the writer telling us the thing on its left is the name of the
 * number on its right.
 *
 * The label may not contain a digit or a stop character, so it cannot reach
 * back across a clause boundary or into an earlier number.
 */
const STATED_VALUE = new RegExp(
  '(?<label>[^，。！？；、,.!?;:：（）()【】\\[\\]「」《》"\'”“…\\n\\t\\d]{2,24}?)' +
    '\\s*(?:设置为|设定为|设为|定为|等于|达到|是|为|：|:)' +
    '\\s*(?:约|大约|大概|共|合计|总计)?\\s*$',
  'u',
);

/**
 * Discourse connectives that get swept up in front of a label.
 *
 * "其中本期预算是 300 万元" is about 本期预算, not about a metric called
 * 其中本期预算. Only pure connectives are on this list: hedges like 预计
 * stay, because a forecast and a measurement genuinely are different things
 * and merging them would manufacture a contradiction.
 */
const LEADING_CONNECTIVES = [
  '其中', '另外', '此外', '同时', '并且', '以及', '而其', '而', '但', '且', '则', '也',
];

/** Approximation words that attach to the label's end: 日活目标约为 -> 日活目标. */
const TRAILING_HEDGES = ['大约', '大概', '约'];

/**
 * A label containing any of these is a fragment of the neighbouring number or
 * of a range, not a name: 万元月薪计、万—、至第.
 */
const JUNK_IN_LABEL = /[万亿千百元%‰—–~～至到第]/u;

/** A number that opens a range: 57 万—82 万元, 3 至 5 天. */
const RANGE_AFTER = /^\s*[—–\-~～至到]\s*\d/u;

/**
 * The name of the quantity a number states, or null when the number is not
 * stated as the value of something (no copula, or a junk label).
 */
export function statedLabel(text: string, numberStart: number): string | null {
  const window = text.slice(Math.max(0, numberStart - 40), numberStart);
  const found = STATED_VALUE.exec(window)?.groups?.['label'];
  if (found === undefined) return null;

  let label = found.trim();
  for (;;) {
    const current = label;
    const lead = LEADING_CONNECTIVES.find((c) => current.startsWith(c) && current.length > c.length);
    if (lead === undefined) break;
    label = current.slice(lead.length).trim();
  }
  for (;;) {
    const current = label;
    const hedge = TRAILING_HEDGES.find((h) => current.endsWith(h) && current.length > h.length);
    if (hedge === undefined) break;
    label = current.slice(0, -hedge.length).trim();
  }

  if (label.length < 2 || JUNK_IN_LABEL.test(label)) return null;
  return label;
}

/** Every number in a stretch of prose, skipping sentences about change. */
function measurementsInProse(block: Block): Measurement[] {
  const out: Measurement[] = [];
  const upTo = (offset: number, re: RegExp): number => block.text.slice(0, offset).match(re)?.length ?? 0;

  for (const sentence of splitSentences(block.text)) {
    if (CHANGE_MARKERS.test(sentence.text)) continue;

    NUMBER_WITH_UNIT.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = NUMBER_WITH_UNIT.exec(sentence.text)) !== null) {
      const rawValue = m[1];
      if (rawValue === undefined) continue;
      // A number with no unit is usually part of a name, not a measurement:
      // "Pass 0", "v2", "第 3 步", "D101". Requiring a unit is what the design
      // doc suggests, and dropping it produced a dozen false positives on the
      // first real document this rule saw.
      if (m[2] === undefined) continue;
      // The low end of a range is not a value on its own.
      if (RANGE_AFTER.test(sentence.text.slice(m.index + m[0].length))) continue;

      const startInSentence = m.index;
      const label = statedLabel(sentence.text, startInSentence);
      if (label === null) continue;

      out.push({
        label,
        value: rawValue.replace(/,/gu, ''),
        unit: m[2] ?? '',
        block,
        part: upTo(sentence.start, /[。！？!?][ \t]*\n/gu),
        line: block.range.start.line + upTo(sentence.start + startInSentence, /\n/gu),
        startInText: sentence.start + startInSentence,
        endInText: sentence.start + startInSentence + m[0].length,
        source: 'prose',
        scope: '',
      });
    }
  }
  return out;
}

/**
 * Numbers in a table, labelled by their row header and column header.
 *
 * Only tables whose first column is a real key take part. On real documents
 * the first column is often *not* unique -- a sensitivity table lists
 * "两期合计" once per scenario, and the scenario lives in the second column --
 * and treating such a column as a key reported every scenario as contradicting
 * every other. A table with a repeated first-column value is multi-dimensional
 * and is skipped whole.
 */
function measurementsInTable(block: Block): Measurement[] {
  const table = block.table;
  if (table === undefined) return [];

  const keys = table.rows.map((r) => normalizeLabel(r[0]?.text ?? ''));
  if (keys.some((k) => k === '') || new Set(keys).size !== keys.length) return [];

  const scope = `${block.headingPath.join(' > ')} | ${table.header.join(' | ')}`;
  const out: Measurement[] = [];

  for (const row of table.rows) {
    const rowHeader = row[0]?.text ?? '';
    for (const cell of row) {
      if (cell.column === 0) continue;
      const columnHeader = table.header[cell.column] ?? '';
      if (rowHeader === '' && columnHeader === '') continue;

      NUMBER_WITH_UNIT.lastIndex = 0;
      const m = NUMBER_WITH_UNIT.exec(cell.text);
      const rawValue = m?.[1];
      if (m === null || rawValue === undefined) continue;
      if (m[2] === undefined) continue; // see the note in measurementsInProse

      out.push({
        label: `${rowHeader}·${columnHeader}`.replace(/^·|·$/gu, ''),
        value: rawValue.replace(/,/gu, ''),
        unit: m[2] ?? '',
        block,
        part: 0,
        line: cell.range.start.line,
        startInText: 0,
        endInText: 0,
        source: 'table',
        scope,
      });
    }
  }
  return out;
}

/** All measurements in a document, in source order. */
export function collectMeasurements(ctx: RuleContext): Measurement[] {
  const out: Measurement[] = [];
  for (const block of ctx.doc.blocks) {
    if (block.kind === 'table') out.push(...measurementsInTable(block));
    else if (block.kind === 'paragraph' || block.kind === 'list_item')
      out.push(...measurementsInProse(block));
  }
  return out;
}

/** Labels shorter than this carry no information: "的", "共", a stray "值". */
const MIN_LABEL_CHARS = 2;

/**
 * Labels shorter than this are only compared inside one section.
 *
 * A bare two-character noun -- 费用、预算、时长 -- is usually a property of
 * whatever the section is about: "3.2 用户服务中心" and "3.4 事业部" each list
 * a 费用, and they differ because they are different things. A compound like
 * 日活目标 or 本期预算 names a document-wide fact, which is what this rule
 * exists to hold consistent. Length is a crude proxy for that difference, but
 * it is the only one available without understanding the text; telling the
 * two apart properly is Pass 3's job.
 */
const MIN_CROSS_SECTION_LABEL_CHARS = 3;

/**
 * Label form used for equality: whitespace gone, full-width Latin folded.
 *
 * Deliberately *not* fuzzy. Treating 日活 and 日活目标 as the same label would
 * raise recall and would also report a target against a current value, which
 * is the exact false positive this rule cannot afford.
 */
export function normalizeLabel(label: string): string {
  return label
    .replace(/\s+/gu, '')
    .replace(/[！-～]/gu, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .toLowerCase();
}

/**
 * Decides whether two measurements contradict each other.
 *
 * L1 is the strictest possible reading: same label character for character;
 * same unit character for character; different number (design doc, 6.2).
 *
 * L2 (D-088) canonicalises units that convert without guessing -- 50 万
 * against 500,000 元, 30 秒 against 1 分钟, 20% against 200‰. Two numbers in
 * the same unit family compare by magnitude; families never mix (元 never
 * compares with 美元, 人 never with 次), and units with no safe conversion
 * (月、年、倍、个…) fall back to the L1 strictness.
 *
 * Everything that returns true becomes an `error`-level diagnostic that blocks
 * the model, so the deliberate exclusions stay: prose and table measurements
 * are not compared with each other; two table cells only under the same
 * heading path and header row; two values in the same paragraph part never
 * (enumerations and worked calculations); short labels only within one
 * section. L3 -- paraphrased labels that *mean* the same metric -- is the
 * shadow rule S210, asked of the judge, never of this function.
 */
export interface Canonical {
  readonly magnitude: number;
  readonly dimension: string;
}

/**
 * Unit families and their scales (D-088, layer L2). Anything not listed has
 * no safe conversion -- months and years vary in length, 倍/分/点 mean
 * different things in different contexts, and each counting noun is its own
 * dimension -- and keeps the L1 char-for-char comparison.
 */
const UNIT_CANON: Readonly<Record<string, { readonly scale: number; readonly dimension: string }>> = {
  '%': { scale: 0.01, dimension: 'ratio' },
  '‰': { scale: 0.001, dimension: 'ratio' },
  '万': { scale: 1e4, dimension: 'count' },
  '亿': { scale: 1e8, dimension: 'count' },
  '千': { scale: 1e3, dimension: 'count' },
  '百': { scale: 1e2, dimension: 'count' },
  'K': { scale: 1e3, dimension: 'count' },
  'k': { scale: 1e3, dimension: 'count' },
  'M': { scale: 1e6, dimension: 'count' },
  'm': { scale: 1e6, dimension: 'count' },
  'B': { scale: 1e9, dimension: 'count' },
  '元': { scale: 1, dimension: 'money' },
  '万元': { scale: 1e4, dimension: 'money' },
  '亿元': { scale: 1e8, dimension: 'money' },
  '美元': { scale: 1, dimension: 'usd' },
  '毫秒': { scale: 0.001, dimension: 'time' },
  'ms': { scale: 0.001, dimension: 'time' },
  '秒': { scale: 1, dimension: 'time' },
  's': { scale: 1, dimension: 'time' },
  '分钟': { scale: 60, dimension: 'time' },
  '小时': { scale: 3600, dimension: 'time' },
  '天': { scale: 86400, dimension: 'time' },
  '周': { scale: 604800, dimension: 'time' },
  'KB': { scale: 1024, dimension: 'bytes' },
  'MB': { scale: 1024 ** 2, dimension: 'bytes' },
  'GB': { scale: 1024 ** 3, dimension: 'bytes' },
  'TB': { scale: 1024 ** 4, dimension: 'bytes' },
};

/** The comparable form of a measurement, or null when its unit is not convertible. */
export function canonicalOf(value: string, unit: string): Canonical | null {
  const c = UNIT_CANON[unit];
  return c === undefined ? null : { magnitude: Number(value) * c.scale, dimension: c.dimension };
}

function isConflict(a: Measurement, b: Measurement): boolean {
  if (a.source !== b.source) return false;
  if (a.scope !== b.scope) return false;
  if (a.block === b.block && a.part === b.part) return false;

  const labelA = normalizeLabel(a.label);
  const labelChars = [...labelA].length;
  if (labelChars < MIN_LABEL_CHARS) return false;
  if (labelA !== normalizeLabel(b.label)) return false;

  const sameSection = a.block.headingPath.join('\n') === b.block.headingPath.join('\n');
  if (!sameSection && labelChars < MIN_CROSS_SECTION_LABEL_CHARS) return false;

  const ca = canonicalOf(a.value, a.unit);
  const cb = canonicalOf(b.value, b.unit);
  if (ca !== null && cb !== null) {
    if (ca.dimension !== cb.dimension) return false;
    const max = Math.max(1, Math.abs(ca.magnitude), Math.abs(cb.magnitude));
    return Math.abs(ca.magnitude - cb.magnitude) > 1e-9 * max;
  }
  if (a.unit !== b.unit) return false;

  return Number(a.value) !== Number(b.value);
}

/**
 * D101: the same thing given two different numbers.
 *
 * Extraction is mechanical -- a number, an optional unit from a known list,
 * and the noun phrase in front of it; in a table, the row and column headers.
 * Sentences that describe a change are dropped wholesale before any of this.
 * What survives is handed to `isConflict`, which owns the judgement call.
 */
/**
 * A label stated with this many distinct values is a field that recurs per
 * record -- "参考讲解时长" once per slide, "月薪" once per role -- rather than
 * one fact stated inconsistently. A genuine slip is one value, restated wrong
 * once; three or more different values is a pattern, and reporting every pair
 * of them would bury the document.
 */
const REPEATED_FIELD_VALUES = 3;

function numericConsistency(ctx: RuleContext): Diagnostic[] {
  const all = collectMeasurements(ctx);

  // D-088 L2: values that convert to the same magnitude (30 秒 = 1 分钟)
  // must not count as distinct occurrences of a "recurring field", and the
  // grouping key drops the raw unit so convertible spellings of one metric
  // share a bucket. Units with no safe conversion keep the L1 raw comparison.
  const distinct = new Map<string, Set<string>>();
  for (const m of all) {
    const c = canonicalOf(m.value, m.unit);
    const key = `${m.source}|${m.scope}|${normalizeLabel(m.label)}|${c?.dimension ?? `raw:${m.unit}`}`;
    let values = distinct.get(key);
    if (values === undefined) distinct.set(key, (values = new Set()));
    values.add(String(c?.magnitude ?? Number(m.value)));
  }
  const measurements = all.filter((m) => {
    const c = canonicalOf(m.value, m.unit);
    const key = `${m.source}|${m.scope}|${normalizeLabel(m.label)}|${c?.dimension ?? `raw:${m.unit}`}`;
    return (distinct.get(key)?.size ?? 0) < REPEATED_FIELD_VALUES;
  });

  const out: Diagnostic[] = [];
  const reported = new Set<string>();

  for (let i = 0; i < measurements.length; i++) {
    for (let j = i + 1; j < measurements.length; j++) {
      const a = measurements[i];
      const b = measurements[j];
      if (a === undefined || b === undefined) continue;
      if (!isConflict(a, b)) continue;

      const key = `${a.label}|${a.value}${a.unit}|${b.value}${b.unit}`;
      if (reported.has(key)) continue;
      reported.add(key);

      out.push(
        report(ctx, {
          range:
            b.source === 'table'
              ? { start: { line: b.line, column: 1 }, end: { line: b.line, column: 1 } }
              : spanRange(ctx.doc, b.block, b.startInText, b.endInText),
          values: {
            label: a.label,
            line: String(a.line),
            first: `${a.value}${a.unit}`,
            second: `${b.value}${b.unit}`,
          },
          related: [{ file: ctx.doc.file, line: a.line, note: msg.diag.relatedOtherValue }],
          fingerprintText: `${a.label}|${a.value}${a.unit}|${b.value}${b.unit}`,
        }),
      );
    }
  }

  return out;
}

registerDeterministic('numeric-consistency', numericConsistency);
