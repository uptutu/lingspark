import { parseArgs } from 'node:util';
import { EXIT_INTERNAL_ERROR, EXIT_OK, formatShadowReport, msg, shadowReport } from '@lingspark/core';

interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
}

/** `lingspark shadow-report` (D-085): aggregates the shadow-hit log. Read-only, exit 0. */
export function runShadowReport(argv: string[], io: Io): number {
  let values: { days?: string | undefined; help?: boolean | undefined };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        days: { type: 'string', default: '7' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch {
    io.err(`${msg.shadowReport.usage}\n`);
    return EXIT_INTERNAL_ERROR;
  }
  if (values.help === true) {
    io.out(msg.shadowReport.usage);
    return EXIT_OK;
  }

  const days = Number(values.days);
  if (!Number.isInteger(days) || days < 1 || days > 90) {
    io.err(`${msg.shadowReport.badDays}\n`);
    return EXIT_INTERNAL_ERROR;
  }
  io.out(`${formatShadowReport(shadowReport({ days }))}\n`);
  return EXIT_OK;
}
