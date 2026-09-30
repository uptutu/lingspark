import type { ResolvedConfig } from '../config/schema.js';
import type { Judge, JudgeRequest } from '../judge/types.js';

/** Feedback categories (design doc, 9.5). */
export const CATEGORIES: Readonly<Record<string, string>> = {
  logic: '前后矛盾、逻辑不通、结论没有依据',
  expression: '表达不自然、翻译腔、啰嗦、读不懂',
  terminology: '术语不一致、用词不准',
  missing: '缺内容、没讲清楚',
  structure: '顺序、层次、详略的问题',
  factual: '内容与事实或用户掌握的信息不符',
  format: '排版、标点、格式',
  requirement_change: '用户改了主意或提了新要求，不是模型写错了',
  other: '其他',
};

/** Categories that never feed rule generation (9.5). */
export const NON_ERROR_CATEGORIES = new Set(['requirement_change', 'other']);

const MAX_CHANGES = 3;
const MAX_CHANGE_CHARS = 400;

const clip = (s: string): string => (s.length > MAX_CHANGE_CHARS ? `${s.slice(0, MAX_CHANGE_CHARS)}……` : s);

/**
 * What the judge sees: the user's words and the blocks that changed, before
 * and after. Never the whole document (9.5) -- the question is about the
 * feedback, and the rest of the document is none of the judge's business.
 */
export function classificationRequest(
  feedback: string,
  changes: readonly { before: string; after: string }[],
): JudgeRequest {
  const lines = ['【用户对文档说的话】', feedback, '', '【模型随后做的修改】'];
  for (const c of changes.slice(0, MAX_CHANGES)) {
    lines.push(`改前：${clip(c.before) || '（无）'}`, `改后：${clip(c.after) || '（删除）'}`, '');
  }
  return {
    state: lines.join('\n').trim(),
    questions: {
      isRevision: {
        type: 'noul',
        instructions:
          '用户说的这句话，是否是在对模型已经写好的文档内容或行文提出修改意见？' +
          '（而不是提一个新需求、问一个问题、让模型继续往下写、或者闲聊）',
        criteria: {
          true: '用户在指出已写内容的问题，或者要求改写已写的内容',
          false: '用户在提新需求、提问、让模型继续，或者这句话与已写内容的质量无关',
        },
      },
      category: {
        type: 'choice',
        instructions: '用户的修改意见主要属于哪一类？',
        criteria: CATEGORIES,
      },
    },
  };
}

export type Classification =
  | { readonly kind: 'revision'; readonly isRevision: number; readonly category: string | null; readonly categoryConfidence: number | null }
  | { readonly kind: 'not-revision'; readonly isRevision: number }
  | { readonly kind: 'failed' };

/**
 * Classifies one piece of feedback (design doc, 9.5). A record whose
 * "is this a revision" probability is below the report threshold is not
 * feedback about the writing and is dropped by the caller.
 */
export async function classifyFeedback(
  feedback: string,
  changes: readonly { before: string; after: string }[],
  judge: Judge,
  config: ResolvedConfig,
  signal: AbortSignal,
): Promise<Classification> {
  let res;
  try {
    res = await judge.judge(classificationRequest(feedback, changes), { signal, purpose: 'classify' });
  } catch {
    return { kind: 'failed' };
  }
  const rev = res.answers['isRevision'];
  if (rev === undefined || rev.type !== 'noul') return { kind: 'failed' };
  const threshold = Math.min(0.99, config.judge.thresholdReport + (judge.calibrated ? 0 : config.judge.uncalibratedBump));
  if (rev.probability < threshold) return { kind: 'not-revision', isRevision: rev.probability };
  const cat = res.answers['category'];
  return {
    kind: 'revision',
    isRevision: rev.probability,
    category: cat !== undefined && cat.type === 'choice' ? cat.choice : null,
    categoryConfidence: cat !== undefined && cat.type === 'choice' ? cat.confidence : null,
  };
}
