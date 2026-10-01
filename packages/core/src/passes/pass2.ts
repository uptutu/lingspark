import { MAX_QUESTIONS_PER_REQUEST } from '../constants.js';
import type { ResolvedConfig } from '../config/schema.js';
import { fingerprintOf } from '../diagnostics/fingerprint.js';
import type { Diagnostic } from '../diagnostics/types.js';
import { cacheKey, type JudgeCache } from '../judge/cache.js';
import type { Answer, Judge, Question } from '../judge/types.js';
import { msg } from '../messages.js';
import { isSuppressed } from '../parser/suppressions.js';
import type { Block, ParsedDoc, Range } from '../parser/types.js';
import { interpolate } from '../rules/context.js';
import { selectRules } from '../rules/load.js';
import type { Rule } from '../rules/schema.js';
import { compareDiagnostics, type PassResult } from './pass1.js';

/** Blocks shorter than this carry too little to judge (design doc, 6.3). */
export const MIN_JUDGED_CHARS = 15;
/** Upper bound on one section's text sent for a section-scoped rule. */
const MAX_SECTION_CHARS = 6_000;
/** Requests in flight at once. */
const CONCURRENCY = 4;

/** A judgement that fell between T_LOW and the report threshold: Pass 4's input (6.6). */
export interface Uncertain {
  readonly ruleId: string;
  readonly probability: number;
  readonly range: Range;
  readonly state: string;
}

export interface Pass2Stats {
  readonly questions: number;
  readonly cacheHits: number;
  readonly requests: number;
  readonly failedRequests: number;
  readonly timedOut: boolean;
}

export interface Pass2Result extends PassResult {
  readonly uncertain: readonly Uncertain[];
  readonly stats: Pass2Stats;
}

export interface Pass2Options {
  readonly doc: ParsedDoc;
  readonly config: ResolvedConfig;
  readonly rules: ReadonlyMap<string, Rule>;
  readonly judge: Judge;
  readonly cache: JudgeCache;
  /** Wall-clock budget; unanswered questions are dropped when it runs out (5.3). */
  readonly budgetMs: number;
}

/**
 * What the judge sees for a block: where it sits, the paragraph before it
 * (for pronouns and topic), and the block itself (design doc, 6.3). Because
 * the previous paragraph is part of the state, and the state is part of the
 * cache key, editing one paragraph re-asks about it and the one after it,
 * and nothing else.
 */
export function blockState(block: Block, previous: Block | undefined): string {
  const parts: string[] = [];
  if (block.headingPath.length > 0) parts.push(`【所属章节】${block.headingPath.join(' > ')}`);
  if (previous !== undefined) parts.push(`【上一段】${previous.text}`);
  parts.push(`【当前段落】${block.text}`);
  return parts.join('\n');
}

export function sectionState(heading: Block, body: readonly Block[]): string {
  const text = body.map((b) => b.text).join('\n');
  return `【章节标题】${heading.text}\n【章节内容】${text.length > MAX_SECTION_CHARS ? `${text.slice(0, MAX_SECTION_CHARS)}……` : text}`;
}

/**
 * The question as the judge receives it. `not_for` is folded into the
 * instructions here -- the rule author only maintains YAML (7.1) -- and it is
 * the main lever against false positives, so it goes last, where it reads as
 * the final word.
 */
export function composeQuestion(rule: Rule): Question | null {
  const q = rule.question;
  if (q === undefined) return null;
  const parts = [q.instructions.trim()];
  if (rule.scope === 'block') parts.push('只判断【当前段落】；【所属章节】和【上一段】只用来理解上下文。');
  if (rule.scope === 'section-cross') parts.push('只判断【章节内容】与【前文】是否冲突；【前文】是已确认的上下文，不要就【前文】自身下结论。');
  if (rule.what !== undefined) parts.push(`要找的问题：${rule.what}`);
  if (rule.not_for !== undefined && rule.not_for.length > 0) {
    parts.push(`以下情况不算：\n${rule.not_for.map((x) => `- ${x}`).join('\n')}`);
  }
  const instructions = parts.join('\n\n');
  if (q.type === 'noul') return { type: 'noul', instructions, ...(q.criteria !== undefined ? { criteria: q.criteria } : {}) };
  if (q.type === 'choice') return { type: 'choice', instructions, criteria: q.criteria };
  return { type: 'score', instructions, criteria: q.criteria };
}

/** Probability that the rule's problem is present, from any answer shape. */
function hitProbability(a: Answer): number {
  if (a.type === 'noul') return a.probability;
  // Choice and score rules would need their own mapping; none exist yet.
  return 0;
}

interface Target {
  readonly state: string;
  readonly range: Range;
  readonly fingerprintText: string;
  readonly rules: readonly Rule[];
}

function targetsFor(doc: ParsedDoc, rules: readonly Rule[]): Target[] {
  const blockRules = rules.filter((r) => r.scope === 'block');
  const sectionRules = rules.filter((r) => r.scope === 'section');
  const sectionCrossRules = rules.filter((r) => r.scope === 'section-cross');
  const out: Target[] = [];

  let previous: Block | undefined;
  for (const b of doc.blocks) {
    if (b.kind === 'heading') {
      previous = undefined;
      continue;
    }
    if ((b.kind === 'paragraph' || b.kind === 'list_item') && [...b.text].length >= MIN_JUDGED_CHARS && blockRules.length > 0) {
      out.push({ state: blockState(b, previous), range: b.range, fingerprintText: b.text, rules: blockRules });
    }
    previous = b;
  }

  if (sectionRules.length > 0 || sectionCrossRules.length > 0) {
    // A document's single top-level heading is its title, and its "section"
    // is the whole document: asking whether all of it matches the title is
    // both noisy and expensive -- every edit anywhere would re-ask it.
    const h1s = doc.blocks.filter((b) => b.kind === 'heading' && b.depth === 1);
    const title = h1s.length === 1 ? h1s[0] : undefined;
    doc.blocks.forEach((h, i) => {
      if (h.kind !== 'heading' || h === title) return;
      const body: Block[] = [];
      for (const b of doc.blocks.slice(i + 1)) {
        if (b.kind === 'heading' && (b.depth ?? 1) <= (h.depth ?? 1)) break;
        if (b.kind !== 'heading') body.push(b);
      }
      if ([...body.map((b) => b.text).join('')].length < MIN_JUDGED_CHARS) return;
      if (sectionRules.length > 0) {
        out.push({ state: sectionState(h, body), range: h.range, fingerprintText: h.text, rules: sectionRules });
      }
      if (sectionCrossRules.length > 0) {
        // section-cross (D-089): the question is whether THIS section
        // contradicts what earlier sections established. The prior text is
        // context, judged as settled; truncate it so the request stays small.
        const priorText = doc.blocks
          .slice(0, i)
          .map((b) => (b.kind === 'heading' ? `\n## ${b.text}` : b.text))
          .join('\n');
        const prior = priorText.length > MAX_SECTION_CHARS ? `${priorText.slice(0, MAX_SECTION_CHARS)}……` : priorText;
        out.push({
          state: `${sectionState(h, body)}\n【前文】${prior}`,
          range: h.range,
          fingerprintText: h.text,
          rules: sectionCrossRules,
        });
      }
    });
  }
  return out;
}

/**
 * Pass 2: paragraph-level semantic rules, asked of the judge (design doc, 6.3).
 *
 * Every answer is cached by (judge, rule, rule version, state), so a document
 * checked twice costs nothing the second time. Anything the judge fails to
 * answer -- error, timeout, a malformed reply -- is simply absent: the pass
 * reports less, never fails the check (design principle 2).
 */
export async function runPass2(opts: Pass2Options): Promise<Pass2Result> {
  const { doc, config, judge, cache } = opts;
  const selected = selectRules(opts.rules, { pass: 2, docType: doc.docType, includeShadow: true }).filter(
    (r) => r.kind === 'judge' && r.question !== undefined,
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(0, opts.budgetMs));
  timer.unref();

  const bump = judge.calibrated ? 0 : config.judge.uncalibratedBump;
  const thresholdOf = (r: Rule): number => Math.min(0.99, (r.threshold ?? config.judge.thresholdReport) + bump);

  const diagnostics: Diagnostic[] = [];
  const shadowDiagnostics: Diagnostic[] = [];
  const uncertain: Uncertain[] = [];
  const warnings = new Set<string>();
  let suppressedCount = 0;
  let questions = 0;
  let cacheHits = 0;
  let requests = 0;
  let failedRequests = 0;

  const consider = (t: Target, rule: Rule, answer: Answer): void => {
    const p = hitProbability(answer);
    const threshold = thresholdOf(rule);
    if (p < threshold) {
      if (p >= config.judge.thresholdLow) {
        uncertain.push({ ruleId: rule.id, probability: p, range: t.range, state: t.state });
      }
      return;
    }
    if (config.allowInlineSuppress && isSuppressed(doc.suppressions, rule.id, t.range.start.line)) {
      suppressedCount++;
      return;
    }
    const d: Diagnostic = {
      file: doc.file,
      range: t.range,
      ruleId: rule.id,
      severity: rule.severity,
      message: interpolate(rule.message, {}),
      ...(rule.suggestion !== undefined ? { suggestion: rule.suggestion } : {}),
      probability: p,
      calibrated: judge.calibrated,
      fingerprint: fingerprintOf(rule.id, t.fingerprintText),
    };
    (rule.status === 'shadow' ? shadowDiagnostics : diagnostics).push(d);
  };

  // Build every request up front; answer what the cache already knows.
  type Job = { target: Target; rules: Rule[]; asked: Record<string, Question> };
  const jobs: Job[] = [];
  for (const t of targetsFor(doc, selected)) {
    const pending: Rule[] = [];
    for (const rule of t.rules) {
      questions++;
      const hit = cache.get(cacheKey(judge.id, rule.id, rule.version, t.state));
      if (hit !== null) {
        cacheHits++;
        consider(t, rule, hit);
      } else {
        pending.push(rule);
      }
    }
    for (let i = 0; i < pending.length; i += MAX_QUESTIONS_PER_REQUEST) {
      const chunk = pending.slice(i, i + MAX_QUESTIONS_PER_REQUEST);
      const asked: Record<string, Question> = {};
      for (const r of chunk) {
        const q = composeQuestion(r);
        if (q !== null) asked[r.id] = q;
      }
      if (Object.keys(asked).length > 0) jobs.push({ target: t, rules: chunk, asked });
    }
  }

  const run = async (): Promise<void> => {
    for (let job = jobs.shift(); job !== undefined; job = jobs.shift()) {
      if (controller.signal.aborted) return;
      requests++;
      try {
        const res = await opts.judge.judge(
          { state: job.target.state, questions: job.asked },
          { signal: controller.signal, purpose: 'pass2', rules: Object.keys(job.asked), file: doc.file },
        );
        for (const rule of job.rules) {
          const a = res.answers[rule.id];
          if (a === undefined) continue;
          cache.set(cacheKey(judge.id, rule.id, rule.version, job.target.state), a);
          consider(job.target, rule, a);
        }
      } catch (err: unknown) {
        if (controller.signal.aborted) return;
        failedRequests++;
        warnings.add(msg.judge.failed(err instanceof Error ? err.message : String(err)));
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, run));
  clearTimeout(timer);

  diagnostics.sort(compareDiagnostics);
  shadowDiagnostics.sort(compareDiagnostics);
  return {
    diagnostics,
    shadowDiagnostics,
    suppressedCount,
    warnings: [...warnings],
    uncertain,
    stats: { questions, cacheHits, requests, failedRequests, timedOut: controller.signal.aborted },
  };
}
