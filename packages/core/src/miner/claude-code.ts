import { readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SessionEvent, TranscriptAdapter, TranscriptFile } from './types.js';

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** `~/.claude/projects`, where Claude Code keeps one JSONL per session. */
export function defaultClaudeCodeRoot(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

/**
 * Text the harness injects into user messages. None of it is the user
 * talking, and a feedback record built from it would teach the slow loop
 * nonsense (design doc, 9.2).
 */
const INJECTED = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/gu,
  /<local-command-caveat>[\s\S]*?<\/local-command-caveat>/gu,
  /<local-command-stdout>[\s\S]*?<\/local-command-stdout>/gu,
  /<local-command-stderr>[\s\S]*?<\/local-command-stderr>/gu,
  /<command-name>[\s\S]*?<\/command-name>/gu,
  /<command-message>[\s\S]*?<\/command-message>/gu,
  /<command-args>[\s\S]*?<\/command-args>/gu,
  /<bash-input>[\s\S]*?<\/bash-input>/gu,
  /<bash-stdout>[\s\S]*?<\/bash-stdout>/gu,
  /<bash-stderr>[\s\S]*?<\/bash-stderr>/gu,
  /^\[Request interrupted by user[^\]]*\]$/gmu,
];

export function stripInjected(text: string): string {
  let out = text;
  for (const re of INJECTED) out = out.replace(re, '');
  return out.trim();
}

/** The user's own words in a message: a string, or the text blocks of an array. */
function userText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is Json => isObject(b) && b['type'] === 'text' && typeof b['text'] === 'string')
    .map((b) => b['text'] as string)
    .join('\n');
}

/** tool_use id -> input, collected from assistant lines. */
type ToolInputs = Map<string, Json>;

function collectToolUses(msg: unknown, into: ToolInputs): void {
  if (!isObject(msg) || !Array.isArray(msg['content'])) return;
  for (const block of msg['content'] as unknown[]) {
    if (isObject(block) && block['type'] === 'tool_use' && typeof block['id'] === 'string' && isObject(block['input'])) {
      into.set(block['id'], block['input']);
    }
  }
}

function toolUseIdOf(msg: unknown): string | null {
  if (!isObject(msg) || !Array.isArray(msg['content'])) return null;
  for (const block of msg['content'] as unknown[]) {
    if (isObject(block) && block['type'] === 'tool_result' && typeof block['tool_use_id'] === 'string') {
      return block['tool_use_id'];
    }
  }
  return null;
}

/** Replaces the first (or every) occurrence, as the Edit tool does. */
function applyEdit(text: string, oldS: string, newS: string, all: boolean): string | null {
  if (oldS === '' || !text.includes(oldS)) return null;
  return all ? text.split(oldS).join(newS) : text.replace(oldS, () => newS);
}

/**
 * Reconstructs a write's before/after from a tool result.
 *
 * Verified (9.2): `toolUseResult` carries `filePath` and `originalFile`, the
 * whole file before the write. Write results also carry the new `content`.
 * For edits the new content may be absent, so it is rebuilt from the old and
 * new strings -- read from the result under either spelling, or from the
 * matching tool_use input. Field names are not trusted to be stable (V-3).
 * Anything that cannot be reconstructed exactly is dropped: a wrong "after"
 * would put words in the model's mouth.
 */
function writeFrom(result: Json, input: Json | undefined): { path: string; before: string | null; after: string } | null {
  const filePath = str(result['filePath']) ?? str(input?.['file_path']) ?? str(input?.['filePath']);
  if (filePath === null) return null;

  const original = str(result['originalFile']);
  const before = original === null || original === '' ? null : original;

  const written = str(result['content']);
  if (written !== null && (result['type'] === 'create' || result['type'] === 'update' || input?.['content'] !== undefined)) {
    return { path: filePath, before, after: written };
  }

  if (before === null) return written === null ? null : { path: filePath, before, after: written };

  const edits: { old: string; new: string; all: boolean }[] = [];
  const oldS = str(result['oldString']) ?? str(input?.['old_string']) ?? str(input?.['old_str']);
  const newS = str(result['newString']) ?? str(input?.['new_string']) ?? str(input?.['new_str']);
  const all = result['replaceAll'] === true || input?.['replace_all'] === true;
  if (oldS !== null && newS !== null) {
    edits.push({ old: oldS, new: newS, all });
  } else if (Array.isArray(input?.['edits'])) {
    // MultiEdit, in versions that have it.
    for (const e of input['edits'] as unknown[]) {
      if (!isObject(e)) return null;
      const o = str(e['old_string']);
      const n = str(e['new_string']);
      if (o === null || n === null) return null;
      edits.push({ old: o, new: n, all: e['replace_all'] === true });
    }
  }
  if (edits.length === 0) return written === null ? null : { path: filePath, before, after: written };

  let after: string | null = before;
  for (const e of edits) {
    if (after === null) return null;
    after = applyEdit(after, e.old, e.new, e.all);
  }
  return after === null ? null : { path: filePath, before, after };
}

/** Parses Claude Code transcript text. Exported for tests. */
export function parseClaudeCodeTranscript(text: string): SessionEvent[] {
  const out: SessionEvent[] = [];
  const toolInputs: ToolInputs = new Map();
  let offset = 0;

  for (const rawLine of text.split('\n')) {
    const lineEnd = offset + Buffer.byteLength(rawLine, 'utf8') + 1;
    const lineOffset = lineEnd;
    offset = lineEnd;
    if (rawLine.trim() === '') continue;

    let row: unknown;
    try {
      row = JSON.parse(rawLine);
    } catch {
      continue; // a partially written last line, or garbage: skip, never fail
    }
    if (!isObject(row)) continue;
    if (row['isSidechain'] === true) continue; // sub-agent traffic (9.2)

    const type = row['type'];
    const sessionId = str(row['sessionId']) ?? '';
    const ts = str(row['timestamp']) ?? '';
    const cwd = str(row['cwd']) ?? '';
    const id = str(row['uuid']) ?? `${sessionId}:${String(lineOffset)}`;

    if (type === 'assistant') {
      collectToolUses(row['message'], toolInputs);
      continue;
    }
    if (type !== 'user') continue; // system, attachment, snapshots, unknown: ignored

    const result = row['toolUseResult'];
    if (result !== undefined) {
      if (!isObject(result)) continue;
      const toolId = toolUseIdOf(row['message']);
      const w = writeFrom(result, toolId === null ? undefined : toolInputs.get(toolId));
      if (w === null) continue;
      const abs = path.isAbsolute(w.path) ? w.path : path.resolve(cwd || '/', w.path);
      out.push({ kind: 'file_write', id, sessionId, ts, path: abs, before: w.before, after: w.after, cwd, offset: lineOffset });
      continue;
    }

    if (row['isMeta'] === true) continue; // harness-generated user turns
    const message = row['message'];
    const textIn = stripInjected(userText(isObject(message) ? message['content'] : undefined));
    if (textIn === '') continue;
    out.push({
      kind: 'user_prompt',
      id,
      sessionId,
      promptId: str(row['promptId']),
      ts,
      text: textIn,
      cwd,
      offset: lineOffset,
    });
  }
  return out;
}

export const claudeCodeAdapter: TranscriptAdapter = {
  agent: 'claude-code',

  discover(roots: readonly string[]): TranscriptFile[] {
    const out: TranscriptFile[] = [];
    for (const root of roots) {
      let projects: string[];
      try {
        projects = readdirSync(root);
      } catch {
        continue;
      }
      for (const p of projects) {
        const dir = path.join(root, p);
        let names: string[];
        try {
          names = readdirSync(dir).filter((n) => n.endsWith('.jsonl'));
        } catch {
          continue;
        }
        for (const n of names) {
          const file = path.join(dir, n);
          try {
            const st = statSync(file);
            if (st.isFile()) out.push({ agent: 'claude-code', path: file, size: st.size, mtimeMs: st.mtimeMs });
          } catch {
            // vanished between readdir and stat
          }
        }
      }
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  },

  parse(file: TranscriptFile): SessionEvent[] {
    let text: string;
    try {
      text = readFileSync(file.path, 'utf8');
    } catch {
      return [];
    }
    return parseClaudeCodeTranscript(text);
  },
};
