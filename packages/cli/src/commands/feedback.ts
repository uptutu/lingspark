import { EXIT_INTERNAL_ERROR, EXIT_OK, msg, recordFalsePositive } from '@lingspark/core';

interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
}

/** `lingspark feedback <ruleId> <fingerprint>` (D-086): one false-positive mark. */
export function runFeedback(argv: string[], io: Io): number {
  const [ruleId, fingerprint] = argv.filter((a) => !a.startsWith('-'));
  if (ruleId === undefined || fingerprint === undefined || argv.length !== 2) {
    io.err(`${msg.feedback.badArgs}\n\n${msg.feedback.usage}`);
    return EXIT_INTERNAL_ERROR;
  }
  recordFalsePositive(ruleId, fingerprint);
  io.out(`${msg.feedback.recorded(ruleId)}\n`);
  return EXIT_OK;
}
