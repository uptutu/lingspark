import { createHash } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { recordReviewFindings } from '../intercepts.js';
import { appendJsonl } from '../log.js';
import { dataPaths, type PathEnv } from '../paths.js';
import type { Rule } from '../rules/schema.js';
import type { HookInput } from './input.js';
import type { SessionStore } from './session.js';

/**
 * In-session review (DECISIONS D-057).
 *
 * The semantic checks need a model. Rather than start a second one in the
 * background -- which needs its own sign-in on every agent but Codex -- the
 * agent that wrote the documents reviews them in its own conversation: at the
 * end of a turn it gets the review criteria, fixes what it is sure of, lists
 * what it is not sure of, and hands in a short report file. Nothing to install,
 * nothing to sign in to.
 *
 * The price is independence: the reviewer is the writer. The criteria are the
 * rules' own closed questions with their "does not count" lists, which is what
 * keeps that honest.
 *
 * This module is on the hook's light path (reading the report happens in
 * preflight): node built-ins and small helpers only.
 */

/**
 * Where the agent writes its report: in the working directory, which every
 * agent may write to, named per session so that two conversations in one
 * folder never take in each other's report.
 */
export const reportPathFor = (cwd: string, sessionId: string): string =>
  path.join(cwd, `.lingspark-review-${createHash('sha256').update(sessionId).digest('hex').slice(0, 8)}.json`);

/** Hash of a document's content, or null when it cannot be read. */
export function contentHash(file: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 32);
  } catch {
    return null;
  }
}

export interface ReportFinding {
  readonly file: string;
  readonly rule: string;
  readonly quote: string;
  readonly fixed: boolean;
}

/**
 * What one reported finding measures up to.
 *
 * - `ok`: nothing out of place between the report and the file.
 * - `suspicious`: the report and the file disagree, and the file is what can
 *   be read.
 * - `unverified`: there is nothing to compare against. Deliberately the answer
 *   for everything that changed or could not be read: a false accusation costs
 *   far more than a missed one (D-014 and every rule's budget).
 */
export type Verdict = 'ok' | 'suspicious' | 'unverified';

export interface ReviewedFinding extends ReportFinding {
  readonly suspicious: boolean;
}

export interface ReviewVerdict {
  readonly findings: readonly ReviewedFinding[];
  /** Reported, but not matched by the document it names. */
  readonly suspicious: number;
  /** Could not be compared: the text the quote came from is no longer there. */
  readonly unverified: number;
}

/** Punctuation that carries no difference in meaning, mapped to one form. */
const PUNCT: Readonly<Record<string, string>> = {
  '：': ':',
  '，': ',',
  '。': '.',
  '；': ';',
  '！': '!',
  '？': '?',
  '（': '(',
  '）': ')',
  '【': '[',
  '】': ']',
  '、': ',',
  '—': '-',
  '－': '-',
  '／': '/',
  '“': '"',
  '”': '"',
  '‘': "'",
  '’': "'",
  '《': '<',
  '》': '>',
};

/** Whitespace, markdown emphasis and zero-width marks: none of them identify a sentence. */
const SKIPPED = /[\s`*_~\u200b\ufeff]/u;

/**
 * Two renderings of one sentence, reduced to the same string: what is left
 * when spacing, emphasis and the shape of the punctuation are ignored.
 */
function comparable(s: string): string {
  let out = '';
  for (const ch of s) {
    if (SKIPPED.test(ch)) continue;
    out += (PUNCT[ch] ?? ch).toLowerCase();
  }
  return out;
}

/**
 * Whether `quote` really occurs in `text`.
 *
 * Tolerant on purpose -- wider than equality, never narrower: line breaks in
 * the middle of a sentence, a stray emphasis mark, full- or half-width commas
 * all still count as the same sentence, because a stricter test would call an
 * honest quote fabricated. An ellipsis in a quote stands for words left out:
 * every piece around it has to be there, in that order.
 */
export function quoteOccursIn(text: string, quote: string): boolean {
  const q = comparable(quote);
  if (q === '') return false;
  const t = comparable(text);
  if (t === '') return false;
  let from = 0;
  for (const part of q.split(/…+|\.{3,}/u).filter((p) => p !== '')) {
    const at = t.indexOf(part, from);
    if (at < 0) return false;
    from = at + part.length;
  }
  return true;
}

function verdictOf(
  read: (file: string) => string | null,
  file: string,
  f: ReportFinding,
  requested: Readonly<Record<string, string>> | undefined,
): Verdict {
  if (file === '') return 'unverified';
  const now = contentHash(file);
  if (now === null) return 'unverified';
  // Every quote was taken from the text as it stood when we asked. Once that
  // text changes, a quote that is missing now proves nothing: the sentence it
  // was cut from may well have been the one that got rewritten.
  const asked = requested?.[file];
  if (asked === undefined || asked !== now) return 'unverified';
  // "I fixed it" while the file is byte-identical is the report and the file
  // speaking at cross purposes; only the file can be read.
  if (f.fixed) return 'suspicious';
  if (f.quote === '') return 'unverified'; // left blank: nothing to match, nothing to claim
  const text = read(file);
  if (text === null) return 'unverified';
  return quoteOccursIn(text, f.quote) ? 'ok' : 'suspicious';
}

/**
 * Whether a report can be taken at its word (D-094).
 *
 * The reviewer is the writer (D-057), which is the price of asking nobody to
 * install anything. This is what keeps that honest: the documents are still
 * our own file system, so a report that names a passage nobody can find there
 * -- or claims a fix in a file that did not change -- is not simply believed.
 *
 * Never blocks anything. What it decides is how the finding is recorded, and
 * it says "unverified" rather than "suspicious" whenever the comparison itself
 * is unavailable.
 */
export function verifyReport(
  findings: readonly ReportFinding[],
  requested: Readonly<Record<string, string>> | undefined,
): ReviewVerdict {
  const texts = new Map<string, string | null>();
  const read = (file: string): string | null => {
    const hit = texts.get(file);
    if (hit !== undefined) return hit;
    let text: string | null = null;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      text = null;
    }
    texts.set(file, text);
    return text;
  };
  let suspicious = 0;
  let unverified = 0;
  const out: ReviewedFinding[] = findings.map((f) => {
    const v = verdictOf(read, f.file, f, requested);
    if (v === 'suspicious') suspicious += 1;
    if (v === 'unverified') unverified += 1;
    return { ...f, suspicious: v === 'suspicious' };
  });
  return { findings: out, suspicious, unverified };
}

function readReport(file: string): { findings: ReportFinding[] } | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== 'object') return null;
  const list = (raw as { findings?: unknown }).findings;
  const findings: ReportFinding[] = [];
  for (const f of Array.isArray(list) ? list : []) {
    if (f === null || typeof f !== 'object') continue;
    const o = f as Record<string, unknown>;
    findings.push({
      file: typeof o['file'] === 'string' ? o['file'] : '',
      rule: typeof o['rule'] === 'string' ? o['rule'] : '',
      quote: typeof o['quote'] === 'string' ? o['quote'].slice(0, 300) : '',
      fixed: o['fixed'] === true,
    });
  }
  return { findings };
}

/**
 * Takes in the report the agent was asked for, if it has written it: marks
 * the documents reviewed at their current content, records what was found
 * for the stats, and removes the file from the user's folder. Returns
 * whether a report came in. Never throws.
 */
export function ingestReview(input: HookInput, store: SessionStore, env?: PathEnv): boolean {
  try {
    return ingest(input, store, env);
  } catch {
    return false; // e.g. the file still held open on Windows: taken in next time
  }
}

function ingest(input: HookInput, store: SessionStore, env?: PathEnv): boolean {
  const pending = store.snapshot.reviewPending;
  if (pending === null) return false;
  const report = readReport(pending.report);
  if (report === null) return false;

  const hashes: Record<string, string> = {};
  for (const f of pending.files) {
    const h = contentHash(f);
    if (h !== null) hashes[f] = h;
  }
  // The report is read against what the agent had in front of it: the content
  // each document had when it was handed over (D-094).
  const abs = (f: ReportFinding): ReportFinding => ({
    ...f,
    file: f.file === '' ? (pending.files[0] ?? '') : path.resolve(input.cwd, f.file),
  });
  const named = report.findings.map(abs);
  const verdict = verifyReport(named, pending.hashes);
  store.markReviewed(hashes);
  rmSync(pending.report, { force: true });
  appendJsonl(dataPaths.runs(env), {
    ts: new Date().toISOString(),
    agent: input.agent,
    event: 'review',
    sessionId: input.sessionId,
    files: pending.files,
    findings: verdict.findings.length,
    fixed: verdict.findings.filter((f) => f.fixed).length,
    suspicious: verdict.suspicious,
    unverified: verdict.unverified,
    rules: [...new Set(verdict.findings.map((f) => f.rule).filter((r) => r !== ''))],
  });
  // The client's record of what was stopped, in the agent's own quotes (D-070).
  recordReviewFindings(input.agent, verdict.findings, env);
  return true;
}

/** One rule as the reviewer reads it: the closed question, then what does not count. */
function criterion(rule: Rule): string {
  const q = rule.question?.instructions.replace(/\s+/gu, ' ').trim() ?? rule.name;
  const notFor = (rule.not_for ?? []).join('；');
  return `[${rule.id}] ${rule.name}：${q}${notFor === '' ? '' : `\n    不算：${notFor}`}`;
}

/**
 * The review request appended to the end-of-turn feedback: which documents,
 * by which criteria, what to do with what is found, and the report to write.
 */
export function reviewRequest(
  files: readonly string[],
  rules: readonly Rule[],
  report: string,
  cwd: string,
): string {
  const rel = (f: string): string => {
    const r = path.relative(cwd, f);
    return r === '' || r.startsWith('..') ? f : r.split(path.sep).join('/');
  };
  const lines = [
    'LingSpark 审稿：请按下面的标准，把这一轮写的文档自己审一遍。',
    '',
    '要审的文档：',
    ...files.map((f) => `- ${rel(f)}`),
    '',
    '标准（每条后面是"不算"的情况）：',
    ...rules.map(criterion),
    '',
    '怎么做：',
    '1. 逐段对照标准，只认确实命中的问题；拿不准的不要硬算。',
    '2. 有把握的问题直接改文档；拿不准的不要改，列出来并向用户说明。',
    '3. 两处说法矛盾、又不知道哪处对时，不要自己选一边：两处都改成"待确认"，并告诉用户。',
    '4. `quote` 要抄文件里**原样出现**的一小段文字（别写成你的转述）：收回时会拿它回原文里比对，',
    '   对不上或没改就说改了的，会记成可疑。',
    `5. 最后把结果写进 ${report}（JSON，没发现问题也要写，findings 留空）：`,
    '   {"findings":[{"file":"文档路径","rule":"规则编号","quote":"原文片段","fixed":true}]}',
    '',
    '这个文件只给 LingSpark 读，读完会自动删掉：不要在回复里列出或解释它。',
    '写完这个文件，这一轮就可以结束了。',
  ];
  return `${lines.join('\n')}\n`;
}
