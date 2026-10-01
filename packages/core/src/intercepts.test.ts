import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Diagnostic } from './diagnostics/types.js';
import { isRecordedFile, listIntercepts, noteStillThere, recordIntercepts, recordReviewFindings } from './intercepts.js';
import type { PathEnv } from './paths.js';

let root: string;
let env: PathEnv;
let doc: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'lingspark-intercepts-'));
  env = { platform: process.platform, env: { LINGSPARK_DATA_DIR: root }, homedir: root };
  doc = path.join(root, '方案.md');
  writeFileSync(doc, '# 方案\n\n本季度日活目标是 50 万。\n\n经过评估，本季度日活目标是 80 万。\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const d101: Diagnostic = {
  file: '',
  range: { start: { line: 5, column: 15 }, end: { line: 5, column: 19 } },
  ruleId: 'D101',
  severity: 'error',
  message: '「本季度日活目标」在第 3 行是 50万，这里是 80万',
  suggestion: '确认哪个取值是对的，然后统一全文。',
  fingerprint: 'fp-d101',
};

describe('what LingSpark stopped (D-070)', () => {
  it('keeps the sentence with the problem marked, once however often it is told', () => {
    const d = { ...d101, file: doc };
    recordIntercepts('workbuddy', 'write', [d], env);
    recordIntercepts('workbuddy', 'stop', [d], env); // told again at Stop: still one
    const list = listIntercepts(env);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      agent: 'workbuddy',
      how: 'write',
      rule: 'D101',
      line: 5,
      before: '经过评估，本季度日活目标是 ',
      hit: '80 万',
      after: '。',
      status: 'open',
    });
  });

  it('marks a problem dealt with once a later check of the file no longer finds it', () => {
    const d = { ...d101, file: doc };
    recordIntercepts('claude-code', 'write', [d], env);
    noteStillThere(doc, [d], env); // still there
    expect(listIntercepts(env)[0]?.status).toBe('open');
    noteStillThere(doc, [], env); // gone
    noteStillThere(doc, [], env); // noted once
    expect(listIntercepts(env)[0]?.status).toBe('done');
  });

  it("keeps a review's findings as the agent quoted them, fixed or not", () => {
    recordReviewFindings(
      'codex',
      [
        { file: doc, rule: 'S204', quote: '全面赋能打造闭环', fixed: true },
        { file: doc, rule: 'S201', quote: '它会在凌晨重试', fixed: false },
      ],
      env,
    );
    const list = listIntercepts(env);
    expect(list.map((r) => [r.rule, r.how, r.hit, r.status])).toEqual([
      ['S201', 'review', '它会在凌晨重试', 'open'],
      ['S204', 'review', '全面赋能打造闭环', 'done'],
    ]);
  });

  it('opens only files the records name', () => {
    recordIntercepts('cursor', 'stop', [{ ...d101, file: doc }], env);
    expect(isRecordedFile(doc, env)).toBe(true);
    expect(isRecordedFile('/etc/hosts', env)).toBe(false);
  });
});

/**
 * "The check no longer finds it" and "the sentence is gone" look exactly alike
 * from here. Only the size of the document tells them apart, and only roughly
 * (D-095).
 */
describe('a problem the text took with it (D-095)', () => {
  const filler = (n: number): string =>
    Array.from({ length: n }, (_, i) => `第 ${i + 1} 段：说明这一段由谁来做、什么时候完成、怎么验收。`).join('\n');
  const LONG = `# 方案\n\n${filler(30)}\n\n经过评估，本季度日活目标是 80 万。\n`;

  it('does not read it as dealt with when most of the document went away', () => {
    writeFileSync(doc, LONG);
    recordIntercepts('workbuddy', 'write', [{ ...d101, file: doc }], env);
    writeFileSync(doc, '# 方案\n'); // the sentence left, with the section around it
    noteStillThere(doc, [], env);
    expect(listIntercepts(env)[0]?.status).toBe('vanished');
  });

  it('still reads it as dealt with when the document kept its size', () => {
    writeFileSync(doc, LONG);
    recordIntercepts('workbuddy', 'write', [{ ...d101, file: doc }], env);
    writeFileSync(doc, LONG.replace('80 万', '50 万')); // the number agreed, nothing gone
    noteStillThere(doc, [], env);
    expect(listIntercepts(env)[0]?.status).toBe('done');
  });

  it('takes no side for a record written before the size was kept', () => {
    const legacy = {
      type: 'intercept',
      ts: new Date().toISOString(),
      agent: 'workbuddy',
      file: doc,
      line: 5,
      rule: 'D101',
      how: 'write',
      before: '',
      hit: '80 万',
      after: '',
      why: '',
      fix: '',
      fp: 'fp-legacy',
    };
    writeFileSync(doc, LONG);
    mkdirSync(path.join(root, 'stats'), { recursive: true });
    writeFileSync(path.join(root, 'stats', 'intercepts.jsonl'), `${JSON.stringify(legacy)}\n`);
    writeFileSync(doc, '# 方案\n');
    noteStillThere(doc, [], env);
    expect(listIntercepts(env).find((r) => r.rule === 'D101')?.status).toBe('done'); // no claim either way
  });
});
