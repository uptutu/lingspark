import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { contentHash, quoteOccursIn, verifyReport, type ReportFinding } from './review.js';

/**
 * A review report is worth only what it can be checked against: the reviewer
 * is the writer (D-057). These are the ways a report and a document can agree
 * or disagree, and what may be said about each (D-094).
 */

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'lingspark-review-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const DOC = [
  '# 方案',
  '',
  '两个任务在**凌晨**跑，产出写到同一个表。',
  '',
  '本季度日活目标：50 万。',
  '',
].join('\n');

function write(name: string, text: string): string {
  const file = path.join(root, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}

describe('quoteOccursIn', () => {
  it('finds a sentence that is there, whatever the spacing', () => {
    expect(quoteOccursIn(DOC, '两个任务在凌晨跑')).toBe(true); // emphasis marks in the way
    expect(quoteOccursIn(DOC, '本季度日活目标: 50 万')).toBe(true); // a half-width colon
    expect(quoteOccursIn(DOC, '写到同一个表。\n\n本季度日活目标')).toBe(true); // across the break
    expect(quoteOccursIn(DOC, '# 方案 两个任务在凌晨跑')).toBe(true); // across the heading
  });

  it('allows an ellipsis for the words left out', () => {
    expect(quoteOccursIn(DOC, '两个任务……写到同一个表')).toBe(true);
    expect(quoteOccursIn(DOC, '两个任务...写到同一个表')).toBe(true);
  });

  it('says no when the sentence is not there, or answers nothing', () => {
    expect(quoteOccursIn(DOC, '这段从来没写过')).toBe(false);
    expect(quoteOccursIn(DOC, '写到同一个表。……方案')).toBe(false); // the pieces are in this order nowhere
    expect(quoteOccursIn(DOC, '')).toBe(false);
  });
});

describe('verifyReport (D-094)', () => {
  const file = (): string => write('docs/prd.md', DOC);
  const hash = (file: string): string => {
    const h = contentHash(file);
    if (h === null) throw new Error(`cannot hash ${file}`);
    return h;
  };

  const base: ReportFinding = { file: 'relative-does-not-matter', rule: 'S204', quote: '两个任务在凌晨跑', fixed: false };

  it('takes a quote that is really there at face value', () => {
    const f = file();
    const v = verifyReport([{ ...base, file: f }], { [f]: hash(f) });
    expect(v.findings[0]?.suspicious).toBe(false);
    expect([v.suspicious, v.unverified]).toEqual([0, 0]);
  });

  it('flags a quote nobody can find in a document that did not change', () => {
    const f = file();
    const v = verifyReport([{ ...base, file: f, quote: '这段从来没写过' }], { [f]: hash(f) });
    expect(v.findings[0]?.suspicious).toBe(true);
    expect(v.suspicious).toBe(1);
  });

  it('flags "I fixed it" said over a byte-identical file', () => {
    const f = file();
    const v = verifyReport([{ ...base, file: f, fixed: true }], { [f]: hash(f) });
    expect(v.findings[0]?.suspicious).toBe(true);
  });

  it('claims nothing once the text the quote came from has changed', () => {
    const f = file();
    const asked = { [f]: hash(f) };
    writeFileSync(f, `${DOC}\n补充一段说明。\n`);
    const v = verifyReport([{ ...base, file: f, quote: '这段从来没写过' }], asked);
    expect(v.findings[0]?.suspicious).toBe(false);
    expect([v.suspicious, v.unverified]).toEqual([0, 1]);
  });

  it('claims nothing when the request kept no hash, or the file cannot be read', () => {
    const f = file();
    expect(verifyReport([{ ...base, file: f, quote: '不存在的话' }], undefined).unverified).toBe(1);
    expect(verifyReport([{ ...base, file: f, quote: '不存在的话' }], {}).unverified).toBe(1);
    expect(verifyReport([{ ...base, file: path.join(root, 'nope.md') }], { [f]: hash(f) }).unverified).toBe(1);
  });

  it('does not read an empty quote as evidence either way', () => {
    const f = file();
    const v = verifyReport([{ ...base, file: f, quote: '' }], { [f]: hash(f) });
    expect(v.findings[0]?.suspicious).toBe(false);
    expect(v.unverified).toBe(1);
  });
});
