import type { Range } from '../parser/types.js';
import type { Severity } from '../config/schema.js';

/** A reference to another place in the same or another document. */
export interface RelatedLocation {
  readonly file: string;
  readonly line: number;
  readonly note: string;
}

/** One problem a rule reports (design doc, section 5.2). */
export interface Diagnostic {
  readonly file: string;
  readonly range: Range;
  readonly ruleId: string;
  readonly severity: Severity;
  readonly message: string;
  readonly suggestion?: string;
  /** Judge-backed rules only. */
  readonly probability?: number;
  /** Whether the backend's probability can be compared to a threshold directly. */
  readonly calibrated?: boolean;
  readonly related?: readonly RelatedLocation[];
  /**
   * `sha256(ruleId + normalised block text)`. Two runs over the same unchanged
   * text produce the same fingerprint, which is what makes deduplication and
   * the loop guard possible.
   */
  readonly fingerprint: string;
}
