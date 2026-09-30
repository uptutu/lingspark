// End-to-end convergence harness.
//
// The question this answers is the one no unit test can: when an agent writes
// a document, does what LingSpark hands back actually move the document
// towards the target, and how many turns does it take?
//
// A real agent cannot be scripted into CI, so the writer here is a policy: it
// reads the diagnostics the real checker produces and applies the repair each
// rule's own suggestion describes. That policy is deliberately not clever. It
// is the minimum a competent editor would do, and it can only act on what
// LingSpark actually reported -- so a rule that stops firing leaves its
// problems in the document, and a rule that starts misfiring makes the
// document worse. Both show up in the numbers.
//
// What is real: the checker, the rules, the config, the glossary, the PostTool
// Use and Stop hooks, the session state, the loop guard. What is simulated:
// the model that writes the prose, and nothing about the judge (Pass 2 and 3
// need one, and a rule that only a model can judge has no scripted repair
// here; it is measured on Pass 1 and, for regressions, on the rule's own
// examples in `eval`).
//
// Deterministic by construction: no network, no clock, no randomness. The
// same tree produces the same curve, which is what makes the baseline in
// `baseline.ts` a usable regression gate.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChecker } from '../check.js';
import type { Diagnostic } from '../diagnostics/types.js';
import { EXIT_HOOK_BLOCK } from '../constants.js';
import { runHook, type HookDeps } from '../hook/run.js';
import { PROJECT_DIR } from '../paths.js';
import type { Position, Range } from '../parser/types.js';
import { CHINESE_DIGIT_CHARS, parseNumeral } from '../rules/deterministic/numerals.js';

const RULES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../rules-builtin/rules');

/** The builtin rule YAML, read the way the CLI and every other test reads it. */
export function loadBuiltinRules(): { file: string; yaml: string }[] {
  return readdirSync(RULES_DIR)
    .filter((n) => n.endsWith('.yaml'))
    .map((n) => ({ file: n, yaml: readFileSync(path.join(RULES_DIR, n), 'utf8') }));
}

/* ------------------------------------------------------------------ scenarios */

export interface Scenario {
  readonly id: string;
  /** One line: what this scenario is for. Shown in the report. */
  readonly title: string;
  /** The document's path inside the throwaway project. */
  readonly file: string;
  /** The first draft the agent writes, before it has heard anything. */
  readonly seed: string;
  /**
   * The rules this seed is written to trip.
   *
   * This is the harness's oracle, and it is deliberately not the checker's
   * own verdict. Measuring convergence by "the checker stopped complaining"
   * is circular: switch a rule off and the document is suddenly perfect. What
   * catches that is a list written down before the run, so a rule that goes
   * dark, or one that stops firing because a change to it narrowed it, is a
   * failure here rather than a quieter product.
   */
  readonly expectRules: readonly string[];
  /** `.lingspark/config.yaml`; omitted means the defaults. */
  readonly config?: string;
  /** `.lingspark/glossary.yaml`; drives D102. */
  readonly glossary?: string;
  /** Turn budget. Going over is itself a result, not a harness failure. */
  readonly maxRounds?: number;
}

/* ------------------------------------------------------------------ document */

/**
 * A Markdown document under repair.
 *
 * Lines are 1-based and columns count UTF-16 units, matching `LineIndex` --
 * the coordinates every diagnostic carries. Line endings are `\n`: the parser
 * counts a line by `\n` only, so a `\r` left in the text would shift every
 * column a rule reports.
 */
class TextDoc {
  private lines: string[];

  constructor(source: string) {
    this.lines = source.split('\n');
  }

  get text(): string {
    return this.lines.join('\n');
  }

  get lineCount(): number {
    return this.lines.length;
  }

  lineAt(line: number): string | undefined {
    return this.lines[line - 1];
  }

  private offsetOf(pos: Position): number {
    let offset = 0;
    for (let i = 0; i < pos.line - 1 && i < this.lines.length; i++) {
      offset += (this.lines[i]?.length ?? 0) + 1;
    }
    return offset + pos.column - 1;
  }

  /** Exactly the text a diagnostic underlines. */
  span(range: Range): string {
    const from = this.offsetOf(range.start);
    const to = this.offsetOf(range.end);
    return this.text.slice(from, to);
  }

  replace(range: Range, text: string): void {
    const from = this.offsetOf(range.start);
    const to = this.offsetOf(range.end);
    const source = this.text;
    this.lines = `${source.slice(0, from)}${text}${source.slice(to)}`.split('\n');
  }

  setText(source: string): void {
    this.lines = source.split('\n');
  }

  deleteLines(from: number, to: number): void {
    if (from < 1 || to < from) return;
    this.lines.splice(from - 1, to - from + 1);
  }

  insertAfter(line: number, added: readonly string[]): void {
    this.lines.splice(Math.max(0, Math.min(line, this.lines.length)), 0, ...added);
  }
}

/* ------------------------------------------------------------------ repairs */

const tight = (text: string): string => text.replace(/\s+/gu, '');

/** The numeric head of a value, without separators or the unit after it. */
const leadingNumber = (text: string): string =>
  /^\s*(\d[\d,]*(?:\.\d+)?)/u.exec(text)?.[1]?.replace(/,/gu, '') ?? '';

type Repair = (doc: TextDoc, d: Diagnostic) => boolean;

const HAN = /[㐀-䶿一-鿿]/u;
const isHan = (ch: string | undefined): boolean => ch !== undefined && HAN.test(ch);

/**
 * D106, re-derived. Half-width punctuation only counts where the rule counts
 * it: a Han character on one side and nothing on the other that would make the
 * mark a decimal point, a path or an identifier. Every replacement is one
 * character for one character, so this repair cannot move any other
 * diagnostic's coordinates.
 */
const FULL_WIDTH: Readonly<Record<string, string>> = {
  ',': '，',
  ';': '；',
  ':': '：',
  '!': '！',
  '?': '？',
  '.': '。',
  '(': '（',
  ')': '）',
};

/** Offsets of the line's inline-code spans, which the rule never reports in. */
function codeSpansOf(line: string): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== '`') continue;
    const close = line.indexOf('`', i + 1);
    if (close === -1) break;
    out.push([i, close + 1]);
    i = close;
  }
  return out;
}

function convertPunctuation(line: string): string {
  const spans = codeSpansOf(line);
  const inCode = (at: number): boolean => spans.some(([s, e]) => at >= s && at < e);
  const chars = [...line];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i] ?? '';
    const prev = chars[i - 1];
    const next = chars[i + 1];
    const wide = FULL_WIDTH[ch];
    if (wide === undefined || inCode(i)) continue;

    let hit: boolean;
    switch (ch) {
      case ',':
      case ';':
      case ':':
      case '!':
      case '?':
        hit = isHan(prev) || isHan(next);
        break;
      case '.':
        hit = isHan(prev) && (next === undefined || next === ' ' || isHan(next));
        break;
      case '(':
        hit = isHan(next);
        break;
      default:
        hit = isHan(prev);
        break;
    }
    if (hit) chars[i] = wide;
  }
  return chars.join('');
}

const ARABIC_SECTION = /^(\d+(?:[.．]\d+)*)\s*[、.．:：]?\s*/u;
const CHINESE_SECTION = new RegExp(`^第?\\s*([${CHINESE_DIGIT_CHARS}]{1,3})\\s*[、章节]`, 'u');

/** Section numbers the document defines, in the numbering style it uses. */
function definedSections(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of lines) {
    const text = raw.replace(/^#{1,6}\s+/u, '').trim();
    const arabic = ARABIC_SECTION.exec(text)?.[1];
    if (arabic !== undefined) {
      out.push(arabic.replace(/．/gu, '.'));
      continue;
    }
    const cn = CHINESE_SECTION.exec(text)?.[1];
    if (cn !== undefined) {
      const n = parseNumeral(cn);
      if (n !== null) out.push(String(n));
    }
  }
  return out;
}

/** A Chinese numeral, for pointing a reference at a section numbered that way. */
function toChineseNumeral(n: number): string {
  const digits = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  if (n < 10) return digits[n] ?? String(n);
  if (n < 20) return `十${digits[n % 10] ?? ''}`;
  if (n < 100) return `${digits[Math.floor(n / 10)] ?? ''}十${n % 10 === 0 ? '' : (digits[n % 10] ?? '')}`;
  return String(n);
}

const REPAIRS: Readonly<Record<string, Repair>> = {
  // 「label」在第 3 行是 50万，这里是 80万 -- overwrite the later value with the
  // one the document already stands behind. The underlined text is checked
  // against the message first: if the two disagree, the rule's wording changed
  // and the repair stands down rather than editing on a guess.
  D101: (doc, d) => {
    const m = /^「.+?」在第 \d+ 行是 (.+?)，这里是 (.+)$/u.exec(d.message);
    const first = m?.[1];
    const second = m?.[2];
    if (first === undefined || second === undefined) return false;
    const span = doc.span(d.range);
    // The rule underlines the number as written ("80 万") and puts the same
    // value in the message without the space ("80万"), so compare them folded.
    if (tight(span) !== tight(second)) return false;
    const current = leadingNumber(span);
    const wanted = leadingNumber(first);
    if (current === '' || wanted === '') return false;
    // Swap the digits and leave the unit and the spacing the writer chose.
    doc.replace(d.range, span.replace(current, wanted));
    return true;
  },

  // 「用户」不是本项目的标准说法，应该用「客户」
  D102: (doc, d) => {
    const m = /^「(.+?)」不是本项目的标准说法，应该用「(.+?)」$/u.exec(d.message);
    const found = m?.[1];
    const preferred = m?.[2];
    if (found === undefined || preferred === undefined) return false;
    if (doc.span(d.range) !== found) return false;
    doc.replace(d.range, preferred);
    return true;
  },

  // 第 5 节 不存在 / 表 3 不存在 -- point the reference at something the
  // document really has, in the numbering style it already uses.
  D103: (doc, d) => {
    const target = /^(.+?) 不存在$/u.exec(d.message)?.[1];
    if (target === undefined) return false;
    const span = doc.span(d.range);
    const lines = doc.text.split('\n');

    const section = /^第 (.+) 节$/u.exec(target)?.[1];
    if (section !== undefined) {
      const defined = definedSections(lines);
      if (defined.length === 0) return false;
      const wanted = parseNumeral(section) ?? Number(section);
      if (Number.isNaN(wanted)) return false;
      // Nearest real section, preferring the one before the number asked for:
      // a forward reference to a section that does not exist yet is still a
      // broken reference, and the closest honest fix is the previous section.
      const sorted = [...defined]
        // Prefer the document's own top-level numbering: a cross-reference to
        // "第 3 节" fixed by pointing it at "第 3.2 节" would be a new error.
        .filter((s) => !s.includes('.'))
        .sort((a, b) => (parseNumeral(a) ?? 0) - (parseNumeral(b) ?? 0));
      const pool = sorted.length > 0 ? sorted : defined;
      if (pool.length === 0) return false;
      const below = [...pool].reverse().find((s) => (parseNumeral(s) ?? 0) < wanted) ?? pool[0];
      if (below === undefined) return false;
      const chinese = pool.every((s) => /^[零一二三四五六七八九十]+$/u.test(s));
      const replacement = chinese ? toChineseNumeral(parseNumeral(below) ?? 0) : below;
      const next = span.replace(section, replacement);
      if (next === span) return false;
      doc.replace(d.range, next);
      return true;
    }

    const figure = /^(表|图) (\d+)$/u.exec(target);
    if (figure !== null) {
      const kind = figure[1] ?? '';
      const n = Number(figure[2] ?? '0');
      const source = lines.join('\n');
      // A table separator row is one `| --- | --- |` line, so its count is
      // the number of tables the parser would have built.
      const tables = (source.match(/^\s*\|(?:\s*:?-{2,}:?\s*\|)+\s*$/gmu) ?? []).length;
      const figures = (source.match(/!\[[^\]]*\]\(/gu) ?? []).length;
      const count = kind === '表' ? tables : figures;
      if (count === 0) return false;
      const replacement = span.replace(String(n), String(Math.min(n, count)));
      if (replacement === span) return false;
      doc.replace(d.range, replacement);
      return true;
    }
    return false;
  },

  // 这篇 prd 缺少必备章节：目标、范围/不做/非目标 -- write the missing sections.
  D104: (doc, d) => {
    const missing = /缺少必备章节：(.+)$/u.exec(d.message)?.[1];
    if (missing === undefined) return false;
    // Match the depth the document already uses for its own sections.
    const usesH2 = doc.text.split('\n').some((l) => /^##\s+/u.test(l));
    const depth = usesH2 ? 2 : 1;
    const added: string[] = [];
    for (const group of missing.split('、')) {
      const name = group.split('/')[0] ?? group;
      if (name === '') continue;
      added.push('', `${'#'.repeat(depth)} ${name}`, '', `本节说明「${name}」的结论，由需求评审补充。`);
    }
    if (added.length === 0) return false;
    // Appended at the end, so no existing coordinate moves.
    doc.insertAfter(doc.lineCount, added);
    return true;
  },

  // 标题层级从 2 级跳到了 4 级 -- the heading one level below its parent.
  D105: (doc, d) => {
    const from = /从 (\d+) 级跳到了 \d+ 级/u.exec(d.message)?.[1];
    if (from === undefined) return false;
    const line = d.range.start.line;
    const raw = doc.lineAt(line);
    if (raw === undefined) return false;
    const text = raw.replace(/^#{1,6}\s+/u, '');
    doc.replace({ start: { line, column: 1 }, end: { line, column: raw.length + 1 } }, `${'#'.repeat(Number(from) + 1)} ${text}`);
    return true;
  },

  D106: (doc) => {
    const before = doc.text;
    let inFence = false;
    const after = before
      .split('\n')
      .map((l) => {
        if (/^\s*(```|~~~)/u.test(l)) inFence = !inFence;
        return inFence ? l : convertPunctuation(l);
      })
      .join('\n');
    if (after === before) return false;
    doc.setText(after);
    return true;
  },

  // 这里还留着占位符「TODO」-- drop the line when the marker is all it says,
  // strip the marker when there is a sentence around it.
  D108: (doc, d) => {
    const marker = /「(.+?)」$/u.exec(d.message)?.[1];
    if (marker === undefined) return false;
    if (doc.span(d.range) !== marker) return false;
    const line = d.range.start.line;
    const raw = doc.lineAt(line) ?? '';
    const rest = raw
      .replace(marker, '')
      .replace(/[（(]?\s*[:：]\s*[)）]?\s*$/u, '')
      .replace(/[（(]\s*[)）]\s*$/u, '')
      .trim();
    if (rest === '') {
      doc.deleteLines(line, line);
      return true;
    }
    doc.replace(d.range, '');
    return true;
  },

  // 这一段与第 12 行的段落完全相同 -- keep the first, drop the repeat.
  D109: (doc, d) => {
    doc.deleteLines(d.range.start.line, d.range.end.line);
    return true;
  },

  // 「3.2 灰度」下面没有内容 -- put one line of real prose under the heading.
  D110: (doc, d) => {
    const title = /「(.+?)」下面没有内容/u.exec(d.message)?.[1];
    if (title === undefined) return false;
    const line = d.range.end.line;
    const sentence = `本节说明「${title}」的结论与适用范围。`;
    const following = doc.lineAt(line + 1) ?? '';
    doc.insertAfter(line, following.trim() === '' ? [sentence] : ['', sentence]);
    return true;
  },

  // 正文说「以下三点」，但下面的列表有 4 项 -- count in Arabic, which the
  // rule's own pattern accepts alongside Chinese numerals.
  D111: (doc, d) => {
    const actual = /但下面的列表有 (\d+) 项/u.exec(d.message)?.[1];
    if (actual === undefined) return false;
    const span = doc.span(d.range);
    const m = new RegExp(`[${CHINESE_DIGIT_CHARS}\\d]{1,3}`, 'u').exec(span);
    if (m === null) return false;
    doc.replace(
      {
        start: { line: d.range.start.line, column: d.range.start.column + m.index },
        end: { line: d.range.start.line, column: d.range.start.column + m.index + m[0].length },
      },
      actual,
    );
    return true;
  },
};

/**
 * The agent's turn: fix what the checker reported, bottom up so that deleting
 * or rewriting a line never moves the coordinates of a fix still to come.
 *
 * Returns how many diagnostics were acted on and how many were not. A
 * diagnostic with no repair is not a harness error -- it is the measurement.
 */
export function applyRepairs(doc: TextDoc, diagnostics: readonly Diagnostic[]): { fixed: number; unfixed: number } {
  const before = doc.text;
  let fixed = 0;
  let unfixed = 0;

  // D106 is reported per block but fixed for the whole document, so its
  // diagnostics are counted as one group: the first one to run does the work
  // and the rest are already done. Counting them one by one would report
  // fixes that did not happen.
  const d106 = diagnostics.filter((d) => d.ruleId === 'D106');
  if (d106.length > 0) {
    const changed = (REPAIRS['D106'] as Repair)(doc, d106[0] as Diagnostic);
    fixed += changed ? d106.length : 0;
    unfixed += changed ? 0 : d106.length;
  }

  // D104 only appends, so it cannot move a coordinate another repair is about
  // to use and is safe to run before them.
  const documentWide = diagnostics.filter((d) => d.ruleId === 'D104');
  for (const d of documentWide) {
    if ((REPAIRS['D104'] as Repair)(doc, d)) fixed++;
    else unfixed++;
  }

  const rest = diagnostics
    .filter((d) => d.ruleId !== 'D106' && d.ruleId !== 'D104')
    .sort((a, b) => b.range.start.line - a.range.start.line || b.range.start.column - a.range.start.column);

  for (const d of rest) {
    const repair = REPAIRS[d.ruleId];
    if (repair !== undefined && repair(doc, d)) fixed++;
    else unfixed++;
  }
  if (doc.text === before) return { fixed: 0, unfixed: diagnostics.length };
  return { fixed, unfixed };
}

/* ------------------------------------------------------------------ the loop */

export interface RoundRecord {
  /** 1-based turn number. */
  readonly round: number;
  readonly errors: number;
  readonly warnings: number;
  /** Stop asked the agent to keep going (exit 2). */
  readonly blocked: boolean;
  /** PostToolUse handed the errors straight back (exit 2). */
  readonly postBlocked: boolean;
  /** Diagnostics the agent acted on this turn. */
  readonly fixed: number;
  /** Diagnostics it left for a later turn on purpose (a warning while errors are open). */
  readonly deferred: number;
  /** Diagnostics it tried to fix and could not -- LingSpark said something unfixable. */
  readonly unfixed: number;
  /** Rules present this round that were not present the round before. */
  readonly introduced: readonly string[];
  /** The rules still outstanding. */
  readonly outstanding: readonly string[];
}

export interface ScenarioResult {
  readonly id: string;
  readonly title: string;
  readonly rounds: readonly RoundRecord[];
  /** A round was reached with nothing left to report. */
  readonly converged: boolean;
  readonly finalErrors: number;
  readonly finalWarnings: number;
  /** Every rule the seed tripped at least once across the whole run. */
  readonly rulesSeen: readonly string[];
  /** Rules the scenario is written to trip that never fired. A rule gone dark. */
  readonly rulesMissed: readonly string[];
  /** Rules still outstanding when the run ended -- what it could not fix. */
  readonly stuck: readonly string[];
  /** The document as it ended, for reading the result. */
  readonly finalDoc: string;
}

export interface ConvergeOptions {
  readonly builtinRules: readonly { file: string; yaml: string }[];
  /** Where the throwaway project is created. Defaults to a temp dir. */
  readonly dir?: string;
  /** Agent id whose hook payloads are synthesised. */
  readonly agent?: 'claude-code' | 'codex-cli';
}

const hookPayload = (cwd: string, session: string, turn: string, file?: string): string =>
  JSON.stringify(
    file === undefined
      ? { session_id: session, prompt_id: turn, cwd }
      : { session_id: session, prompt_id: turn, cwd, tool_input: { file_path: file } },
  );

/**
 * Runs one scenario to convergence.
 *
 * One session, one turn per round -- which is what an agent actually does, and
 * also what keeps the per-turn Stop cap and the session's "already told you"
 * memory behaving as they do in production. Both are part of what is measured.
 */
export async function runScenario(scenario: Scenario, opts: ConvergeOptions): Promise<ScenarioResult> {
  const dir = opts.dir ?? mkdtempSync(path.join(tmpdir(), 'lingspark-converge-'));
  const project = path.join(dir, 'project');
  const doc = path.join(project, ...scenario.file.split('/'));
  const data = path.join(dir, 'data');

  const created = opts.dir === undefined;
  const previousWarm = process.env['LINGSPARK_NO_WARM'];
  process.env['LINGSPARK_NO_WARM'] = '1'; // no judge, nothing to warm up for

  try {
    mkdirSync(path.dirname(doc), { recursive: true });
    if (scenario.config !== undefined || scenario.glossary !== undefined) {
      mkdirSync(path.join(project, PROJECT_DIR), { recursive: true });
    }
    if (scenario.config !== undefined) {
      writeFileSync(path.join(project, PROJECT_DIR, 'config.yaml'), scenario.config, 'utf8');
    }
    if (scenario.glossary !== undefined) {
      writeFileSync(path.join(project, PROJECT_DIR, 'glossary.yaml'), scenario.glossary, 'utf8');
    }
    writeFileSync(doc, scenario.seed, 'utf8');

    const pathEnv = { platform: process.platform, env: { LINGSPARK_DATA_DIR: data }, homedir: dir };
    const deps: HookDeps = { builtinRules: opts.builtinRules, pathEnv, judge: null };
    // The same checker the CLI would build, with no judge: Pass 2 and 3 have
    // nothing to run without one, so this is the product's own view of the
    // document minus the parts no scripted agent can act on anyway.
    const checker = createChecker({ builtinRules: opts.builtinRules, pathEnv, judge: null, respectScope: true });
    const maxRounds = scenario.maxRounds ?? 8;

    const rounds: RoundRecord[] = [];
    const seen = new Set<string>();
    let previous: readonly string[] | null = null;
    let converged = false;
    const session = `${scenario.id}-session`;

    for (let round = 1; round <= maxRounds; round++) {
      // The agent has just written the file, so the two hooks fire first. What
      // they say is what the agent gets to react to this turn.
      const post = await runHook(hookPayload(project, session, `t${round}`, doc), opts.agent ?? 'claude-code', 'post-tool-use', deps);
      const stop = await runHook(hookPayload(project, session, `t${round}`), opts.agent ?? 'claude-code', 'stop', deps);

      const result = await checker.checkFile(doc);
      const errors = result.diagnostics.filter((d) => d.severity === 'error');
      const warnings = result.diagnostics.filter((d) => d.severity === 'warning');
      const outstanding = [...new Set(result.diagnostics.map((d) => d.ruleId))].sort();
      for (const id of outstanding) seen.add(id);

      // Round 1 has nothing to compare against: every rule it reports is
      // new by definition, and calling that out would make the interesting
      // case -- a fix that uncovers the next problem -- impossible to see.
      const before = previous;
      const introduced = before === null ? [] : outstanding.filter((id) => !before.includes(id));

      const record: RoundRecord = {
        round,
        errors: errors.length,
        warnings: warnings.length,
        blocked: stop.exitCode === EXIT_HOOK_BLOCK,
        postBlocked: post.exitCode === EXIT_HOOK_BLOCK,
        fixed: 0,
        deferred: 0,
        unfixed: 0,
        introduced,
        outstanding,
      };

      if (result.diagnostics.length === 0) {
        rounds.push(record);
        converged = true;
        break;
      }
      if (round === maxRounds) {
        rounds.push(record);
        break;
      }
      previous = outstanding;

      // The agent's turn, in the same order LingSpark hands things back: the
      // errors that blocked the turn first, the warnings it was also told
      // about once those are gone. Fixing everything in one go would model a
      // more capable agent than the one this product actually has to convince,
      // and it would flatten the curve into a single step.
      const actionable = errors.length > 0 ? errors : result.diagnostics;
      const doc2 = new TextDoc(readFileSync(doc, 'utf8'));
      const edits = applyRepairs(doc2, actionable);
      rounds.push({
        ...record,
        fixed: edits.fixed,
        deferred: result.diagnostics.length - actionable.length,
        unfixed: edits.unfixed,
      });
      writeFileSync(doc, doc2.text, 'utf8');
    }

    const last = rounds[rounds.length - 1];
    return {
      id: scenario.id,
      title: scenario.title,
      rounds,
      converged,
      finalErrors: last?.errors ?? 0,
      finalWarnings: last?.warnings ?? 0,
      rulesSeen: [...seen].sort(),
      rulesMissed: scenario.expectRules.filter((id) => !seen.has(id)),
      stuck: [...seen].filter((id) => (last?.outstanding ?? []).includes(id)),
      finalDoc: readFileSync(doc, 'utf8'),
    };
  } finally {
    if (previousWarm === undefined) delete process.env['LINGSPARK_NO_WARM'];
    else process.env['LINGSPARK_NO_WARM'] = previousWarm;
    if (created) rmSync(dir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ report */

const BAR = '─'.repeat(64);

/** The numbers a baseline stores: enough to catch a change, small enough to read. */
export interface Metric {
  readonly rounds: number;
  readonly converged: boolean;
  readonly finalErrors: number;
  readonly finalWarnings: number;
  readonly curve: readonly number[];
  readonly rulesSeen: readonly string[];
}

export const metricOf = (r: ScenarioResult): Metric => ({
  rounds: r.rounds.length,
  converged: r.converged,
  finalErrors: r.finalErrors,
  finalWarnings: r.finalWarnings,
  curve: r.rounds.map((round) => round.errors + round.warnings),
  rulesSeen: r.rulesSeen,
});

const signed = (n: number): string => (n > 0 ? `+${String(n)}` : String(n));

/** A per-rule breakdown of the last round that still had something in it. */
function lastActiveRound(r: ScenarioResult): RoundRecord | undefined {
  return [...r.rounds].reverse().find((round) => round.outstanding.length > 0);
}

/**
 * The whole run as text: one block per scenario with the error curve, then a
 * comparison against the baseline. Printing this is the point of the harness.
 */
export function formatReport(results: readonly ScenarioResult[], baseline?: Readonly<Record<string, Metric>>): string {
  const out: string[] = [];
  for (const r of results) {
    const now = metricOf(r);
    const before = baseline?.[r.id];

    out.push('', `【${r.id}】${r.title}`, BAR);
    for (const round of r.rounds) {
      const total = round.errors + round.warnings;
      const bar = '█'.repeat(Math.min(total, 40));
      const marks = [
        round.blocked ? '拦住' : '放行',
        round.postBlocked ? '即时' : '  - ',
        `修 ${String(round.fixed)}`,
        round.deferred > 0 ? `缓 ${String(round.deferred)}` : '  - ',
        `无策 ${String(round.unfixed)}`,
      ].join(' ');
      out.push(
        `  第 ${String(round.round)} 轮  ${String(round.errors).padStart(2)} 错 ${String(round.warnings).padStart(2)} 警  ${bar.padEnd(40)}  ${marks}`,
      );
      if (round.introduced.length > 0) out.push(`          ↳ 本轮新冒出：${round.introduced.join(' ')}`);
    }
    out.push(`  曲线 ${now.curve.join(' → ') || '（无）'}   ${now.converged ? `已收敛，第 ${String(now.rounds)} 轮清零` : '未收敛'}`);

    const active = lastActiveRound(r);
    if (active !== undefined) {
      out.push(`  最后一轮未清：${active.outstanding.join(' ')}`);
      if (active.introduced.length > 0) out.push(`  修完新冒出：${active.introduced.join(' ')}`);
    }
    if (r.rulesMissed.length > 0) out.push(`  应当触发却没触发：${r.rulesMissed.join(' ')}`);
    if (!r.converged) {
      // The one case where the numbers are not the answer: what the document
      // actually ended up as.
      out.push(`  未收敛，最后一版文档：`, ...r.finalDoc.split('\n').map((l) => `    │ ${l}`));
    }
    if (before === undefined) {
      out.push('  基线：无（本次为首次记录）');
    } else {
      out.push(
        `  基线：${before.curve.join(' → ')}  ${before.converged ? `已收敛/第 ${String(before.rounds)} 轮` : '未收敛'}`,
      );
      const delta = now.curve.map((n, i) => n - (before.curve[i] ?? 0));
      if (delta.some((d) => d !== 0) || now.converged !== before.converged) {
        out.push(`  差异：曲线 ${signed(delta.reduce((a, b) => a + b, 0))}，收敛 ${now.converged ? '达成' : '未达成'}（基线${before.converged ? '达成' : '未达成'}）`);
      } else {
        out.push('  差异：无');
      }
    }
  }
  out.push('', BAR);
  return out.join('\n');
}
