import type { AgentId } from '../agents.js';

/** One transcript file an adapter found. */
export interface TranscriptFile {
  readonly agent: AgentId;
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

/**
 * What the miner needs from a transcript, agent-neutral (design doc, 9.3).
 *
 * `offset` is the byte offset just past the line the event came from, so the
 * extractor can tell events that are new since the last run from those it
 * only needs as context.
 */
export type SessionEvent =
  | {
      readonly kind: 'user_prompt';
      readonly id: string;
      readonly sessionId: string;
      readonly promptId: string | null;
      readonly ts: string;
      readonly text: string;
      readonly cwd: string;
      readonly offset: number;
    }
  | {
      readonly kind: 'file_write';
      readonly id: string;
      readonly sessionId: string;
      readonly ts: string;
      readonly path: string;
      /** Full file content before the write; null when the file was created. */
      readonly before: string | null;
      readonly after: string;
      readonly cwd: string;
      readonly offset: number;
    };

export interface TranscriptAdapter {
  readonly agent: AgentId;
  discover(roots: readonly string[]): TranscriptFile[];
  /** Every event in the file, in order. Read-only: never writes the transcript. */
  parse(file: TranscriptFile): SessionEvent[];
}
