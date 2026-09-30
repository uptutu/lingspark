import { createHash } from 'node:crypto';
import path from 'node:path';
import type { ResolvedConfig } from '../config/schema.js';
import { MAX_CLAIM_PAIRS } from '../constants.js';
import type { Diagnostic } from '../diagnostics/types.js';
import { fingerprintOf } from '../diagnostics/fingerprint.js';
import { readJsonOrNull, writeFileAtomic } from '../fsutil.js';
import { cacheKey, JudgeCache } from '../judge/cache.js';
import type { Generator, Judge, JudgeCallContext, Question } from '../judge/types.js';
import { msg } from '../messages.js';
import { normalizeText } from '../parser/text.js';
import { dataPaths, type PathEnv } from '../paths.js';
import type { Rule } from '../rules/schema.js';
import { composeQuestion } from './pass2.js';

/**
 * Pass 3: consistency across a whole set of documents (design doc, 6.4,
 * widened from one document to all of a project's checked documents -- a
 * single delivery is often a PRD, a design and a report written together, and
 * the contradictions that matter sit between them; DECISIONS D-045).
 *
 * Asking a model to "find the contradictions" in a document is unreliable
 * (ContraDoc, NAACL 2024). So:
 *   1. each document is reduced to the claims it states outright, with line
 *      numbers -- cached by content, so an unchanged document costs nothing;
 *   2. claims from every document are grouped by what they are about, the
 *      same thing often being named differently in different documents;
 *   3. only claims in the same group are paired, and each pair is one closed
 *      question: do these two contradict each other?
 */

export type ClaimKind = 'definition' | 'number' | 'decision' | 'constraint' | 'scope' | 'goal' | 'conclusion';
const CLAIM_KINDS: readonly ClaimKind[] = ['definition', 'number', 'decision', 'constraint', 'scope', 'goal', 'conclusion'];

export interface Claim {
  readonly file: string;
  readonly line: number;
  readonly kind: ClaimKind;
  readonly subject: string;
  readonly text: string;
}

export interface Pass3Doc {
  readonly absPath: string;
  /** Shown to the model and in messages. */
  readonly relPath: string;
  readonly source: string;
}

export interface Pass3Options {
  readonly docs: readonly Pass3Doc[];
  /**
   * Documents written this turn. When given, only contradictions involving
   * one of them are reported: an agent is asked to fix what it just wrote,
   * not every old disagreement in the project. Manual checks pass none.
   */
  readonly focus?: ReadonlySet<string>;
  readonly generator: Generator;
  readonly judge: Judge;
  readonly rule: Rule;
  readonly config: ResolvedConfig;
  readonly pathEnv?: PathEnv;
  readonly budgetMs: number;
  readonly concurrency?: number;
}

export interface Pass3Stats {
  docs: number;
  extractionCalls: number;
  extractionCacheHits: number;
  claims: number;
  groups: number;
  pairs: number;
  pairCacheHits: number;
  judgeCalls: number;
  failedCalls: number;
  timedOut: boolean;
}

export interface Pass3Result {
  readonly diagnostics: readonly Diagnostic[];
  readonly shadowDiagnostics: readonly Diagnostic[];
  readonly claims: readonly Claim[];
  readonly stats: Pass3Stats;
}

/** Bumped whenever a prompt below changes, retiring what the old one produced. */
const EXTRACT_VERSION = 1;
const GROUP_VERSION = 3;
/** The second-look wording lives here, not in the rule file: bump this when it changes. */
const VERIFY_VERSION = 2;
/** One extraction call reads at most this much text; longer documents are split at headings. */
const CHUNK_CHARS = 12_000;
const MAX_CLAIMS_PER_CHUNK = 40;
/** Beyond this many distinct subjects, grouping falls back to exact matches. */
const MAX_SUBJECTS_TO_GROUP = 400;
const PAIRS_PER_CALL = 8;

const EXTRACT_SYSTEM =
  '你是一个严谨的中文文档分析助手。你只摘录文档里明确写出的内容，不推断、不补充、不评价。';

const extractPrompt = (numbered: string): string =>
  [
    '下面是一篇文档，每行开头是行号（L12 表示第 12 行）。',
    '请摘出其中可能与其他文档或本文其他地方相互印证或冲突的"声明"：',
    '- definition：对某个概念的定义或口径',
    '- number：带数值的事实或目标（日期、金额、比例、数量、时长）',
    '- decision：做出的方案决定（怎么做、用什么）',
    '- constraint：规则、限制、前提条件（必须、不允许、只有……才……）',
    '- scope：范围（本期做什么、不做什么）',
    '- goal：目标',
    '- conclusion：结论',
    '',
    '要求：',
    '1. 只摘明确写出的内容，不做推断；背景介绍、举例、修辞不摘。',
    '2. line 填这条声明所在的行号。',
    '3. subject 用一个简短的名词短语说明这条声明讲的是"什么对象的什么方面"，例如"退款审核方式""日活目标""上线日期""是否支持离线"。',
    '4. text 忠实转述这条声明，不超过 60 字，保留关键数字和限定条件。',
    `5. 最多 ${String(MAX_CLAIMS_PER_CHUNK)} 条，优先摘最具体、最可能被别处引用的。`,
    '',
    '【文档】',
    numbered,
  ].join('\n');

const EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    claims: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          line: { type: 'integer' },
          kind: { type: 'string', enum: [...CLAIM_KINDS] },
          subject: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['line', 'kind', 'subject', 'text'],
        additionalProperties: false,
      },
    },
  },
  required: ['claims'],
  additionalProperties: false,
} as const;

/**
 * Each subject goes with one of its claims. Names alone mislead: in a live
 * test "积分兑换审核方式" and "积分到账审核条件" -- 系统自动审核 against 需要人工审核
 * -- were judged unrelated by name, and grouped at once with a sentence each.
 */
const groupPrompt = (subjects: readonly string[], exampleOf: (s: string) => string): string =>
  [
    '下面是从一组文档里摘出的声明主题，每行一个，前面是编号，冒号后是一条例句。',
    '请把讲同一个对象的主题归为一组：同一项费用、同一个日期或时间点、同一个流程或规则、同一个指标、同一个权限、同一项范围……',
    '侧重点不同也算同一组，只要两条声明有可能说法冲突。例如"保价费率"和"保价费计算公式"是一组，"积分失效时间"和"过期任务执行时间"是一组，"删除成员权限"和"成员管理权限"是一组。',
    '不同文档对同一件事的叫法往往不同，要按意思归，不要按字面。一个主题可以出现在多个组里。宁可组分得粗一点，也不要漏掉可能冲突的主题；但讲的明显是不同事情的主题不要硬凑。',
    '只输出包含 2 个及以上编号的组。',
    '',
    ...subjects.map((s, i) => `${String(i)}. ${s}：${exampleOf(s).slice(0, 80)}`),
  ].join('\n');

const GROUP_SCHEMA = {
  type: 'object',
  properties: {
    groups: { type: 'array', items: { type: 'array', items: { type: 'integer' } } },
  },
  required: ['groups'],
  additionalProperties: false,
} as const;

const sha = (...parts: string[]): string => createHash('sha256').update(parts.join('\u0000'), 'utf8').digest('hex');

/** Where extraction and grouping results are kept; same sweep as judge answers. */
const ledgerFile = (key: string, env?: PathEnv): string =>
  path.join(dataPaths.cache(env), 'ledger', key.slice(0, 2), `${key}.json`);

function readCached<T>(key: string, env?: PathEnv): T | null {
  return readJsonOrNull(ledgerFile(key, env)) as T | null;
}

function writeCached(key: string, value: unknown, env?: PathEnv): void {
  try {
    writeFileAtomic(ledgerFile(key, env), JSON.stringify(value));
  } catch {
    // not remembered this time
  }
}

interface Chunk {
  readonly text: string;
  readonly firstLine: number;
  readonly lastLine: number;
}

/**
 * Numbered lines for the model, without code blocks, front matter or blank
 * lines, split at headings into pieces one call can read.
 */
export function chunkForExtraction(source: string): Chunk[] {
  const lines = source.split(/\r?\n/u);
  const kept: { n: number; text: string }[] = [];
  let fence: string | null = null;
  let front = lines[0]?.trim() === '---';
  lines.forEach((line, i) => {
    const t = line.trim();
    if (front) {
      if (i > 0 && t === '---') front = false;
      return;
    }
    const f = /^(```|~~~)/u.exec(t);
    if (f !== null) {
      fence = fence === null ? (f[1] ?? null) : fence === f[1] ? null : fence;
      return;
    }
    if (fence !== null || t === '') return;
    kept.push({ n: i + 1, text: `L${String(i + 1)}: ${line}` });
  });

  const chunks: Chunk[] = [];
  let cur: { n: number; text: string }[] = [];
  let size = 0;
  const flush = (): void => {
    if (cur.length === 0) return;
    chunks.push({
      text: cur.map((l) => l.text).join('\n'),
      firstLine: cur[0]?.n ?? 0,
      lastLine: cur[cur.length - 1]?.n ?? 0,
    });
    cur = [];
    size = 0;
  };
  for (const l of kept) {
    const isHeading = /^L\d+: #{1,3} /u.test(l.text);
    if (size > 0 && (size + l.text.length > CHUNK_CHARS || (isHeading && size > CHUNK_CHARS / 2))) flush();
    cur.push(l);
    size += l.text.length + 1;
  }
  flush();
  return chunks;
}

function parseClaims(json: unknown, doc: Pass3Doc, chunk: Chunk): Claim[] {
  const list = (json as { claims?: unknown } | null)?.claims;
  if (!Array.isArray(list)) return [];
  const out: Claim[] = [];
  for (const c of list as unknown[]) {
    if (c === null || typeof c !== 'object') continue;
    const r = c as Record<string, unknown>;
    const line = typeof r['line'] === 'number' ? Math.round(r['line']) : NaN;
    const kind = r['kind'];
    const subject = typeof r['subject'] === 'string' ? r['subject'].trim() : '';
    const text = typeof r['text'] === 'string' ? r['text'].trim() : '';
    // A claim must point at a real line of the text it was read from.
    if (!(line >= chunk.firstLine && line <= chunk.lastLine)) continue;
    if (!CLAIM_KINDS.includes(kind as ClaimKind) || subject === '' || text === '') continue;
    out.push({ file: doc.absPath, line, kind: kind as ClaimKind, subject, text });
  }
  return out.slice(0, MAX_CLAIMS_PER_CHUNK);
}

/** Runs async tasks at most `n` at a time, stopping new ones once `stop()` says so. */
async function pool<T>(items: readonly T[], n: number, stop: () => boolean, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length && !stop()) {
      const item = items[next++] as T;
      await run(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

/** The question for one pair, built on the rule's own wording and exclusions. */
export function pairQuestion(rule: Rule, a: number, b: number): Question | null {
  const base = composeQuestion(rule);
  if (base === null || base.type !== 'noul') return null;
  return {
    ...base,
    instructions: `只看【声明 ${String(a)}】和【声明 ${String(b)}】，材料里的其他声明只用来理解上下文。\n\n${base.instructions}`,
  };
}

const claimLine = (n: number, c: Claim, rel: (abs: string) => string): string =>
  `【声明 ${String(n)}】（${rel(c.file)} 第 ${String(c.line)} 行，主题：${c.subject}）${c.text}`;

/** The two claims of a pair, in a fixed order, as the cache sees them. */
const pairState = (a: Claim, b: Claim): string => [a.text, b.text].sort().join('\n');

/** The heading a line sits under, nearest first. */
function headingOf(lines: readonly string[], line: number): string {
  for (let i = line - 1; i >= 0; i--) {
    const m = /^#{1,6}\s+(.*)$/u.exec(lines[i] ?? '');
    if (m !== null) return m[1]?.trim() ?? '';
  }
  return '';
}

/** A claim's original lines, two either side, the claim's own line marked. */
function excerpt(n: number, c: Claim, sourceOf: ReadonlyMap<string, readonly string[]>, rel: (abs: string) => string): string {
  const lines = sourceOf.get(c.file) ?? [];
  const from = Math.max(1, c.line - 2);
  const to = Math.min(lines.length, c.line + 2);
  const body: string[] = [];
  for (let i = from; i <= to; i++) {
    const t = lines[i - 1] ?? '';
    if (t.trim() === '') continue;
    body.push(`${i === c.line ? '▶ ' : '  '}${t}`);
  }
  const heading = headingOf(lines, c.line);
  return `【原文 ${String(n)}】（${rel(c.file)} 第 ${String(c.line)} 行${heading !== '' ? `，所在章节：${heading}` : ''}）\n${body.join('\n')}`;
}

/**
 * What the two documents define, so the second look can tell that "超级管理员"
 * in one and "owner" in the other are the same role.
 */
function definitionsOf(files: readonly string[], claims: readonly Claim[], rel: (abs: string) => string): string {
  const defs = [...new Set(files)].flatMap((f) =>
    claims.filter((c) => c.file === f && c.kind === 'definition').slice(0, 10).map((c) => `- ${rel(c.file)}：${c.text}`),
  );
  return defs.length === 0 ? '' : `【两处文档里的定义，供对照名称】\n${defs.join('\n')}`;
}

/** The second, stricter look: the same rule, asked of the original text. */
export function verifyQuestion(rule: Rule): Question | null {
  const base = composeQuestion(rule);
  if (base === null || base.type !== 'noul') return null;
  return {
    ...base,
    instructions: [
      '下面是两处原文片段，▶ 标出的是被比较的那一行，其余行是它的上下文。请读完原文再判断：这两处说法是否真的相互矛盾——按原文的意思不可能同时成立？',
      '如果一处是另一处的例外或细化、讲的是不同对象或不同阶段、一处是现状另一处是目标、两处只是用不同名字称呼同一个对象，或者一处的做法本身就满足另一处的要求（比如"即时到账"满足"一个工作日内到账"），都不算矛盾。',
      // A live test: 核销率提升到 40% against 核销率目标是 35% was waved through
      // as "40% satisfies 35%". A target is not a floor to clear.
      '但同一个指标在两处写了不同的目标值（比如一处说目标 40%，另一处说目标 35%），算矛盾：目标值不是"达到就算满足"的门槛，两个数字只能有一个是对的。',
      '',
      base.instructions,
    ].join('\n'),
  };
}

export async function runPass3(opts: Pass3Options): Promise<Pass3Result> {
  const env = opts.pathEnv;
  const stats: Pass3Stats = {
    docs: opts.docs.length,
    extractionCalls: 0,
    extractionCacheHits: 0,
    claims: 0,
    groups: 0,
    pairs: 0,
    pairCacheHits: 0,
    judgeCalls: 0,
    failedCalls: 0,
    timedOut: false,
  };
  const empty = (claims: Claim[] = []): Pass3Result => ({ diagnostics: [], shadowDiagnostics: [], claims, stats });
  if (opts.docs.length === 0) return empty();

  const controller = new AbortController();
  const timer = setTimeout(() => {
    stats.timedOut = true;
    controller.abort();
  }, opts.budgetMs);
  const stop = (): boolean => controller.signal.aborted;
  const concurrency = opts.concurrency ?? 4;
  const relOf = new Map(opts.docs.map((d) => [d.absPath, d.relPath]));
  const rel = (abs: string): string => relOf.get(abs) ?? abs;

  try {
    // 1. Claims, per document chunk, cached by content.
    const claims: Claim[] = [];
    const jobs = opts.docs.flatMap((doc) => chunkForExtraction(doc.source).map((chunk) => ({ doc, chunk })));
    const pending: typeof jobs = [];
    for (const job of jobs) {
      const key = sha('extract', opts.generator.id, String(EXTRACT_VERSION), job.chunk.text);
      const hit = readCached<{ claims: Omit<Claim, 'file'>[] }>(key, env);
      if (hit !== null && Array.isArray(hit.claims)) {
        stats.extractionCacheHits++;
        claims.push(...hit.claims.map((c) => ({ ...c, file: job.doc.absPath })));
      } else {
        pending.push(job);
      }
    }
    await pool(pending, concurrency, stop, async ({ doc, chunk }) => {
      const ctx: JudgeCallContext = { signal: controller.signal, purpose: 'pass3', rules: [opts.rule.id], file: doc.relPath };
      try {
        stats.extractionCalls++;
        const r = await opts.generator.generate(
          { system: EXTRACT_SYSTEM, prompt: extractPrompt(chunk.text), schema: EXTRACT_SCHEMA, state: chunk.text },
          ctx,
        );
        const found = parseClaims(r.json, doc, chunk);
        writeCached(
          sha('extract', opts.generator.id, String(EXTRACT_VERSION), chunk.text),
          { claims: found.map(({ file: _file, ...c }) => c) },
          env,
        );
        claims.push(...found);
      } catch {
        stats.failedCalls++;
      }
    });
    stats.claims = claims.length;
    if (claims.length < 2 || stop()) return empty(claims);

    // 2. Group subjects that name the same thing. A subject may sit in
    // several groups; identical wording always groups, whatever the model says.
    const subjects = [...new Set(claims.map((c) => c.subject))].sort();
    const groups: Set<string>[] = [];
    const byNorm = new Map<string, Set<string>>();
    for (const s of subjects) {
      const norm = normalizeText(s);
      const g = byNorm.get(norm) ?? new Set<string>();
      g.add(s);
      byNorm.set(norm, g);
    }
    // Every wording is a group of its own: the same subject in two documents is
    // the plainest case there is, and a set of one subject still holds several
    // claims. Groups with fewer than two claims drop out below.
    groups.push(...byNorm.values());
    if (subjects.length >= 2 && subjects.length <= MAX_SUBJECTS_TO_GROUP) {
      // The example shown for a subject is its first claim by file and line:
      // the same on every run, whatever order extraction finished in. It shapes
      // the answer, so it is part of the cache key.
      const firstClaim = new Map<string, Claim>();
      for (const c of [...claims].sort((x, y) => x.file.localeCompare(y.file) || x.line - y.line)) {
        if (!firstClaim.has(c.subject)) firstClaim.set(c.subject, c);
      }
      const exampleOf = (subject: string): string => firstClaim.get(subject)?.text ?? '';
      const key = sha(
        'group',
        opts.generator.id,
        String(GROUP_VERSION),
        subjects.map((s) => `${s}\u0000${exampleOf(s)}`).join('\n'),
      );
      let found = readCached<number[][]>(key, env);
      if (found === null) {
        try {
          const r = await opts.generator.generate(
            {
              system: EXTRACT_SYSTEM,
              prompt: groupPrompt(subjects, exampleOf),
              schema: GROUP_SCHEMA,
              state: subjects.join('\n'),
            },
            { signal: controller.signal, purpose: 'pass3', rules: [opts.rule.id] },
          );
          const raw = (r.json as { groups?: unknown } | null)?.groups;
          found = Array.isArray(raw)
            ? raw.filter(Array.isArray).map((g) => (g as unknown[]).filter((i): i is number => typeof i === 'number' && i >= 0 && i < subjects.length))
            : [];
          writeCached(key, found, env);
        } catch {
          stats.failedCalls++;
          found = [];
        }
      }
      for (const g of found) {
        const set = new Set<string>();
        for (const i of g) {
          const s = subjects[i] as string;
          // Pull in every subject worded the same way as this one.
          for (const same of byNorm.get(normalizeText(s)) ?? [s]) set.add(same);
        }
        if (set.size > 1) groups.push(set); // one wording is already a group
      }
    }

    // 3. Pairs within a group, each involving the focus when there is one.
    const inFocus = (c: Claim): boolean => opts.focus === undefined || opts.focus.has(c.file);
    type Pair = { a: Claim; b: Claim; group: number };
    const pairs: Pair[] = [];
    const seen = new Set<string>();
    const idOf = (c: Claim): string => `${c.file}\u0000${String(c.line)}\u0000${c.text}`;
    groups.forEach((subjectsInGroup, group) => {
      const list = claims.filter((c) => subjectsInGroup.has(c.subject));
      if (list.length < 2) return;
      stats.groups++;
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i] as Claim;
          const b = list[j] as Claim;
          if (a.file === b.file && a.line === b.line) continue; // one paragraph: Pass 2's job (S205)
          if (normalizeText(a.text) === normalizeText(b.text)) continue;
          if (!inFocus(a) && !inFocus(b)) continue;
          const id = [idOf(a), idOf(b)].sort().join('\u0001');
          if (seen.has(id)) continue;
          seen.add(id);
          pairs.push({ a, b, group });
        }
      }
    });
    // Cross-document pairs first, then those far apart in one document.
    pairs.sort((x, y) => Number(y.a.file !== y.b.file) - Number(x.a.file !== x.b.file) || Math.abs(y.a.line - y.b.line) - Math.abs(x.a.line - x.b.line));
    const chosen = pairs.slice(0, MAX_CLAIM_PAIRS);
    stats.pairs = chosen.length;

    // 4. One closed question per pair, several pairs per call, answers cached per pair.
    const cache = new JudgeCache(env);
    const bump = opts.judge.calibrated ? 0 : opts.config.judge.uncalibratedBump;
    const threshold = Math.min(0.99, (opts.rule.threshold ?? opts.config.judge.thresholdReport) + bump);
    const candidates: { pair: Pair; probability: number }[] = [];
    const keyOf = (p: Pair): string => cacheKey(opts.judge.id, opts.rule.id, opts.rule.version, pairState(p.a, p.b));
    const toAsk: Pair[] = [];
    for (const p of chosen) {
      const a = cache.get(keyOf(p));
      if (a?.type === 'noul') {
        stats.pairCacheHits++;
        if (a.probability >= threshold) candidates.push({ pair: p, probability: a.probability });
      } else {
        toAsk.push(p);
      }
    }
    // Pairs of one group share a call, whatever the priority order interleaved
    // them into; each group's pairs keep that order within it.
    const byGroup = new Map<number, Pair[]>();
    for (const p of toAsk) byGroup.set(p.group, [...(byGroup.get(p.group) ?? []), p]);
    const batches: Pair[][] = [];
    for (const list of byGroup.values()) {
      for (let i = 0; i < list.length; i += PAIRS_PER_CALL) batches.push(list.slice(i, i + PAIRS_PER_CALL));
    }
    await pool(batches, concurrency, stop, async (batch) => {
      const numbered: Claim[] = [];
      const num = (c: Claim): number => {
        const i = numbered.indexOf(c);
        if (i >= 0) return i + 1;
        numbered.push(c);
        return numbered.length;
      };
      const questions: Record<string, Question> = {};
      batch.forEach((p, i) => {
        // Shown in the order the cache key sorts them in: the model's answer
        // can depend on which claim comes first, and the cached answer is
        // reused for the pair either way round.
        const [first, second] = p.a.text <= p.b.text ? [p.a, p.b] : [p.b, p.a];
        const q = pairQuestion(opts.rule, num(first), num(second));
        if (q !== null) questions[`p${String(i)}`] = q;
      });
      const state = numbered.map((c, i) => claimLine(i + 1, c, rel)).join('\n');
      try {
        stats.judgeCalls++;
        const res = await opts.judge.judge(
          { state, questions },
          { signal: controller.signal, purpose: 'pass3', rules: [opts.rule.id] },
        );
        batch.forEach((p, i) => {
          const a = res.answers[`p${String(i)}`];
          if (a?.type !== 'noul') return;
          cache.set(keyOf(p), a);
          if (a.probability >= threshold) candidates.push({ pair: p, probability: a.probability });
        });
      } catch {
        stats.failedCalls++;
      }
    });

    // 4b. Every pair the first look flagged is asked again, this time with
    // the original lines around both claims. A one-line summary drops the
    // qualifiers -- "guests" are not "members", "instant" satisfies "within a
    // day" -- and most false alarms come from exactly that. Only a pair both
    // looks agree on is reported.
    const sourceOf = new Map(opts.docs.map((d) => [d.absPath, d.source.split(/\r?\n/u)]));
    const verifyRule = { ...opts.rule, id: `${opts.rule.id}.verify` };
    const hits: { pair: Pair; probability: number }[] = [];
    await pool(candidates, concurrency, stop, async ({ pair }) => {
      const state = [
        excerpt(1, pair.a, sourceOf, rel),
        excerpt(2, pair.b, sourceOf, rel),
        definitionsOf([pair.a.file, pair.b.file], claims, rel),
      ]
        .filter((x) => x !== '')
        .join('\n\n');
      const key = cacheKey(opts.judge.id, `${verifyRule.id}.v${String(VERIFY_VERSION)}`, opts.rule.version, state);
      let a = cache.get(key);
      if (a === null) {
        const q = verifyQuestion(opts.rule);
        if (q === null) return;
        try {
          stats.judgeCalls++;
          const res = await opts.judge.judge(
            { state, questions: { v: q } },
            { signal: controller.signal, purpose: 'pass3', rules: [opts.rule.id] },
          );
          a = res.answers['v'] ?? null;
          if (a !== null) cache.set(key, a);
        } catch {
          stats.failedCalls++;
          return;
        }
      } else {
        stats.pairCacheHits++;
      }
      if (a?.type === 'noul' && a.probability >= threshold) hits.push({ pair, probability: a.probability });
    });

    // 5. One diagnostic per contradiction, on the side that was just written.
    const diagnostics: Diagnostic[] = [];
    // Two claims read off one line can both clash with the same line
    // elsewhere; the reader needs to hear about that place once.
    const reported = new Set<string>();
    for (const { pair, probability } of [...hits].sort((x, y) => y.probability - x.probability)) {
      const [here, there] = inFocus(pair.b) ? [pair.b, pair.a] : [pair.a, pair.b];
      const where = [`${here.file}:${String(here.line)}`, `${there.file}:${String(there.line)}`].sort().join('|');
      if (reported.has(where)) continue;
      reported.add(where);
      diagnostics.push({
        file: here.file,
        range: { start: { line: here.line, column: 1 }, end: { line: here.line, column: 1 } },
        ruleId: opts.rule.id,
        severity: opts.rule.severity,
        message: msg.pass3.contradiction(here.text, rel(there.file), there.line, there.text),
        ...(opts.rule.suggestion !== undefined ? { suggestion: opts.rule.suggestion } : {}),
        probability,
        calibrated: opts.judge.calibrated,
        related: [{ file: there.file, line: there.line, note: there.text }],
        fingerprint: fingerprintOf(opts.rule.id, pairState(pair.a, pair.b)),
      });
    }
    diagnostics.sort((x, y) => x.file.localeCompare(y.file) || x.range.start.line - y.range.start.line);
    return opts.rule.status === 'shadow'
      ? { diagnostics: [], shadowDiagnostics: diagnostics, claims, stats }
      : { diagnostics, shadowDiagnostics: [], claims, stats };
  } finally {
    clearTimeout(timer);
  }
}
