import { describe, it, expect } from 'vitest';
import { parseDocument } from './parse.js';
import { splitSentences } from './sentences.js';
import { isSuppressed, parseDirective } from './suppressions.js';

const DOC = `---
doc_type: prd
owner: kk
---

# 一、背景

段落一。

## 1.1 现状

段落二，带 **强调** 和 \`代码\` 的内容。

- 项目 A
- 项目 B
  - 嵌套项

\`\`\`ts
const x = 1;
\`\`\`

| 指标 | 现状 | 目标 |
|---|---|---|
| 日活 | 50 万 | 80 万 |
| 留存 | 32% | 38% |

> 这是引用。

# 二、方案

结尾段落。
`;

describe('parseDocument', () => {
  const doc = parseDocument(DOC, { file: 'docs/prd.md' });

  it('reads frontmatter and lets doc_type override the path', () => {
    expect(doc.frontmatter['owner']).toBe('kk');
    expect(doc.docType).toBe('prd');
    expect(parseDocument(DOC, { file: 'x.md', docTypeFromPath: 'report' }).docType).toBe('prd');
  });

  it('falls back to the path doc type when frontmatter has none', () => {
    const d = parseDocument('# 标题\n\n正文。\n', { file: 'x.md', docTypeFromPath: 'report' });
    expect(d.docType).toBe('report');
    expect(parseDocument('正文。\n', { file: 'x.md' }).docType).toBe('generic');
  });

  it('detects the lingspark: false opt-out', () => {
    expect(doc.optedOut).toBe(false);
    expect(parseDocument('---\nlingspark: false\n---\n\n正文。\n', { file: 'x.md' }).optedOut).toBe(true);
  });

  it('emits no block for frontmatter, code blocks or thematic breaks', () => {
    const kinds = doc.blocks.map((b) => b.kind);
    expect(kinds).not.toContain('code');
    expect(doc.blocks.some((b) => b.text.includes('const x = 1'))).toBe(false);
    expect(doc.blocks.some((b) => b.text.includes('doc_type'))).toBe(false);
  });

  it('keeps original line numbers across the skipped code block', () => {
    // The table sits after a fenced code block; its line must count the fence.
    const table = doc.blocks.find((b) => b.kind === 'table');
    const expectedLine = DOC.split('\n').findIndex((l) => l.startsWith('| 指标')) + 1;
    expect(table?.range.start.line).toBe(expectedLine);
  });

  it('gives blocks stable sequential ids in source order', () => {
    expect(doc.blocks.map((b) => b.id)).toEqual(doc.blocks.map((_, i) => `b${i}`));
  });

  it('records the heading path as ancestors only', () => {
    const p = doc.blocks.find((b) => b.text.startsWith('段落二'));
    expect(p?.headingPath).toEqual(['一、背景', '1.1 现状']);

    const h = doc.blocks.find((b) => b.kind === 'heading' && b.text === '1.1 现状');
    expect(h?.headingPath).toEqual(['一、背景']);
    expect(h?.depth).toBe(2);
  });

  it('pops the heading stack when a shallower heading arrives', () => {
    const last = doc.blocks.find((b) => b.text === '结尾段落。');
    expect(last?.headingPath).toEqual(['二、方案']);
  });

  it('strips markdown marks from block text', () => {
    const p = doc.blocks.find((b) => b.text.startsWith('段落二'));
    expect(p?.text).toBe('段落二，带 强调 和 代码 的内容。');
  });

  it('maps an offset in stripped text back to the right source offset', () => {
    const p = doc.blocks.find((b) => b.text.startsWith('段落二'));
    expect(p).toBeDefined();
    for (const needle of ['段落二', '强调', '代码', '的内容']) {
      const i = p!.text.indexOf(needle);
      const src = p!.sourceOffsetOf(i);
      expect(doc.source.slice(src, src + needle.length)).toBe(needle);
    }
  });

  it('emits one block per list item, including nested ones', () => {
    const items = doc.blocks.filter((b) => b.kind === 'list_item').map((b) => b.text);
    expect(items).toEqual(['项目 A', '项目 B', '嵌套项']);
  });

  it('emits one block per table, with per-cell structure and positions', () => {
    const table = doc.blocks.find((b) => b.kind === 'table');
    expect(table?.table?.header).toEqual(['指标', '现状', '目标']);
    expect(table?.table?.rows).toHaveLength(2);
    expect(table?.table?.rows[0]?.map((c) => c.text)).toEqual(['日活', '50 万', '80 万']);

    const cell = table?.table?.rows[1]?.[2];
    expect(cell?.text).toBe('38%');
    expect(cell?.row).toBe(2);
    expect(cell?.column).toBe(2);
    expect(DOC.split('\n')[(cell?.range.start.line ?? 1) - 1]).toContain('38%');
  });

  it('emits blockquotes as their own block', () => {
    expect(doc.blocks.find((b) => b.kind === 'blockquote')?.text).toBe('这是引用。');
  });

  it('hashes normalised text, so re-wrapping does not change the hash', () => {
    const a = parseDocument('一二三四五六七八。\n', { file: 'a.md' }).blocks[0];
    const b = parseDocument('一二三四五六七八。\n\n', { file: 'b.md' }).blocks[0];
    expect(a?.hash).toBe(b?.hash);
    const c = parseDocument('一二三四五六七九。\n', { file: 'c.md' }).blocks[0];
    expect(a?.hash).not.toBe(c?.hash);
  });

  it('survives broken frontmatter instead of throwing', () => {
    const d = parseDocument('---\n[unclosed\n---\n\n正文。\n', { file: 'x.md' });
    expect(d.frontmatter).toEqual({});
    expect(d.blocks.some((b) => b.text === '正文。')).toBe(true);
  });

  it('handles an empty document', () => {
    const d = parseDocument('', { file: 'x.md' });
    expect(d.blocks).toEqual([]);
    expect(d.suppressions).toEqual([]);
  });
});

describe('positionAt', () => {
  const doc = parseDocument('第一行\n第二行\n第三行\n', { file: 'x.md' });

  it('converts offsets to 1-based line and column', () => {
    expect(doc.positionAt(0)).toEqual({ line: 1, column: 1 });
    expect(doc.positionAt(4)).toEqual({ line: 2, column: 1 });
    expect(doc.positionAt(5)).toEqual({ line: 2, column: 2 });
    expect(doc.positionAt(8)).toEqual({ line: 3, column: 1 });
  });
});

describe('splitSentences', () => {
  it('splits on Chinese sentence-final punctuation', () => {
    const s = splitSentences('第一句。第二句！第三句？第四句；');
    expect(s.map((x) => x.text)).toEqual(['第一句。', '第二句！', '第三句？', '第四句；']);
  });

  it('keeps closing quotes and brackets with their sentence', () => {
    const s = splitSentences('他说“走吧。”然后走了。');
    expect(s.map((x) => x.text)).toEqual(['他说“走吧。”', '然后走了。']);
  });

  it('treats a run of terminators as one ending', () => {
    expect(splitSentences('真的吗？！下一句。').map((x) => x.text)).toEqual(['真的吗？！', '下一句。']);
  });

  it('does not split on a half-width period', () => {
    const s = splitSentences('版本是 v1.2.3，文档在 docs.typesafe.ai 上。');
    expect(s).toHaveLength(1);
  });

  it('breaks on newlines', () => {
    expect(splitSentences('甲\n乙').map((x) => x.text)).toEqual(['甲', '乙']);
  });

  it('keeps a trailing fragment with no terminator', () => {
    expect(splitSentences('完整句。残句').map((x) => x.text)).toEqual(['完整句。', '残句']);
  });

  it('returns offsets that slice back to the sentence', () => {
    const text = '第一句。  第二句！';
    for (const s of splitSentences(text)) {
      expect(text.slice(s.start, s.end)).toBe(s.text);
    }
  });

  it('returns nothing for blank input', () => {
    expect(splitSentences('   \n  ')).toEqual([]);
  });
});

describe('parseDirective', () => {
  it('parses each directive form', () => {
    expect(parseDirective('<!-- lingspark-disable-next-line S201 -->')).toEqual({
      directive: 'disable-next-line',
      ruleIds: ['S201'],
    });
    expect(parseDirective('<!-- lingspark-disable S201, S203 -->')).toEqual({
      directive: 'disable',
      ruleIds: ['S201', 'S203'],
    });
    expect(parseDirective('<!-- lingspark-enable -->')).toEqual({
      directive: 'enable',
      ruleIds: null,
    });
  });

  it('ignores unrelated comments', () => {
    expect(parseDirective('<!-- TODO: 补充 -->')).toBeNull();
    expect(parseDirective('<!-- lingsparkish -->')).toBeNull();
  });
});

describe('suppressions', () => {
  it('applies disable-next-line to the next block, across a blank line', () => {
    const d = parseDocument(
      ['<!-- lingspark-disable-next-line S201 -->', '', '这一段被豁免。', '', '这一段不被豁免。', ''].join('\n'),
      { file: 'x.md' },
    );
    const exempt = d.blocks.find((b) => b.text.startsWith('这一段被'));
    const notExempt = d.blocks.find((b) => b.text.startsWith('这一段不'));
    expect(isSuppressed(d.suppressions, 'S201', exempt!.range.start.line)).toBe(true);
    expect(isSuppressed(d.suppressions, 'S203', exempt!.range.start.line)).toBe(false);
    expect(isSuppressed(d.suppressions, 'S201', notExempt!.range.start.line)).toBe(false);
  });

  it('applies a disable/enable range', () => {
    const d = parseDocument(
      ['第一段。', '', '<!-- lingspark-disable S203 -->', '', '第二段。', '', '<!-- lingspark-enable S203 -->', '', '第三段。', ''].join('\n'),
      { file: 'x.md' },
    );
    const line = (needle: string) => d.blocks.find((b) => b.text.startsWith(needle))!.range.start.line;
    expect(isSuppressed(d.suppressions, 'S203', line('第一段'))).toBe(false);
    expect(isSuppressed(d.suppressions, 'S203', line('第二段'))).toBe(true);
    expect(isSuppressed(d.suppressions, 'S203', line('第三段'))).toBe(false);
  });

  it('runs an unmatched disable to the end of the file', () => {
    const d = parseDocument(['<!-- lingspark-disable -->', '', '一。', '', '二。', ''].join('\n'), {
      file: 'x.md',
    });
    for (const b of d.blocks) {
      expect(isSuppressed(d.suppressions, 'ANY', b.range.start.line)).toBe(true);
    }
  });
});
