import type { Answer, JudgeRequest, Question } from './types.js';

/**
 * Prompt text for general-purpose LLM backends, which do not natively answer
 * typed closed questions the way Jev does. Kept in one place so every such
 * backend asks the same thing and an eval comparison compares models, not
 * phrasings.
 */

export const SYSTEM_PROMPT =
  '你是一个严格、克制的中文文档审阅判定器。你只回答被问到的封闭问题，不改写原文，不补充建议。' +
  '拿不准时如实给出较低的把握程度，而不是猜一个确定的答案。';

/** The body of one question, as a model reads it. */
export function renderQuestion(q: Question): string {
  const lines = [q.instructions.trim()];
  if (q.type === 'noul' && q.criteria !== undefined) {
    lines.push(`判为"是"：${q.criteria.true}`, `判为"否"：${q.criteria.false}`);
  } else if (q.type === 'choice') {
    for (const [k, v] of Object.entries(q.criteria)) lines.push(`${k}：${v}`);
  } else if (q.type === 'score') {
    q.criteria.forEach((c, i) => lines.push(`${String(i + 1)} 分：${c}`));
  }
  return lines.join('\n');
}

/** A request with several questions, answered in one structured reply. */
export function structuredPrompt(req: JudgeRequest): string {
  const parts = ['请阅读下面的材料，然后逐个回答问题。', '', '【材料】', req.state, '', '【问题】'];
  for (const [name, q] of Object.entries(req.questions)) {
    parts.push('', `问题 ${name}（${q.type === 'noul' ? '是 / 否' : q.type === 'choice' ? '单选' : '打分'}）：`, renderQuestion(q));
  }
  parts.push(
    '',
    '按要求的 JSON 格式回答。对每个问题：answer 是你的回答（是/否题用 true 或 false，单选题用选项键，打分题用分数），' +
      'confidence 是你对这个回答有几成把握，0 到 1 之间。',
  );
  return parts.join('\n');
}

/** JSON Schema for the structured reply to `structuredPrompt`. */
export function structuredSchema(req: JudgeRequest): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [name, q] of Object.entries(req.questions)) {
    const answer =
      q.type === 'noul'
        ? { type: 'boolean' }
        : q.type === 'choice'
          ? { type: 'string', enum: Object.keys(q.criteria) }
          : { type: 'integer', minimum: 1, maximum: q.criteria.length };
    properties[name] = {
      type: 'object',
      properties: { answer, confidence: { type: 'number', minimum: 0, maximum: 1 } },
      required: ['answer', 'confidence'],
      additionalProperties: false,
    };
  }
  return { type: 'object', properties, required: Object.keys(req.questions), additionalProperties: false };
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/**
 * Turns a structured reply into answers. A self-reported confidence is not a
 * probability, but it is the only signal these backends offer; the judge is
 * marked uncalibrated and the threshold rises to compensate (design doc, 8.2).
 * Questions whose reply is missing or malformed are simply absent.
 */
export function parseStructured(req: JudgeRequest, reply: unknown): Record<string, Answer> {
  const out: Record<string, Answer> = {};
  if (reply === null || typeof reply !== 'object') return out;
  const r = reply as Record<string, unknown>;
  for (const [name, q] of Object.entries(req.questions)) {
    const item = r[name];
    if (item === null || typeof item !== 'object') continue;
    const { answer, confidence } = item as { answer?: unknown; confidence?: unknown };
    const conf = typeof confidence === 'number' ? clamp01(confidence) : null;
    if (conf === null) continue;
    if (q.type === 'noul' && typeof answer === 'boolean') {
      out[name] = { type: 'noul', probability: answer ? conf : 1 - conf };
    } else if (q.type === 'choice' && typeof answer === 'string' && answer in q.criteria) {
      const rest = (1 - conf) / Math.max(1, Object.keys(q.criteria).length - 1);
      const probabilities = Object.fromEntries(Object.keys(q.criteria).map((k) => [k, k === answer ? conf : rest]));
      out[name] = { type: 'choice', choice: answer, probabilities, confidence: conf };
    } else if (q.type === 'score' && typeof answer === 'number') {
      out[name] = { type: 'score', score: answer, probabilities: { [String(answer)]: conf }, confidence: conf };
    }
  }
  return out;
}

/** Extracts the first JSON object from model text that may wrap it in prose or fences. */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/u.exec(text);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
}

/** Single-token prompt for the logprobs path: one question, answer Y or N. */
export function yesNoPrompt(state: string, q: Question): string {
  return [
    '【材料】',
    state,
    '',
    '【问题】',
    renderQuestion(q),
    '',
    '只回答一个字母：是就回答 Y，否就回答 N。不要输出任何其他内容。',
  ].join('\n');
}
