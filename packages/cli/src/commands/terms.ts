import { EXIT_OK, formatTermCandidates, msg, termCandidateTallies } from '@lingspark/core';

interface Io {
  out: (s: string) => void;
}

/** `lingspark terms` (D-091): review machine-proposed glossary term pairs. */
export function runTerms(argv: string[], io: Io): number {
  if (argv.includes('-h') || argv.includes('--help')) {
    io.out(msg.terms.usage);
    return EXIT_OK;
  }
  io.out(`${formatTermCandidates(termCandidateTallies())}\n`);
  return EXIT_OK;
}
