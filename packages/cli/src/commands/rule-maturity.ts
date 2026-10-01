import { EXIT_OK, formatRuleMaturity, msg, ruleMaturity } from '@lingspark/core';

interface Io {
  out: (s: string) => void;
}

/** `lingspark rule-maturity` (D-086): the false-positive budget, per rule. */
export function runRuleMaturity(argv: string[], io: Io): number {
  if (argv.includes('-h') || argv.includes('--help')) {
    io.out(msg.ruleMaturity.usage);
    return EXIT_OK;
  }
  io.out(`${formatRuleMaturity(ruleMaturity())}\n`);
  return EXIT_OK;
}
