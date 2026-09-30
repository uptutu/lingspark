import { parseArgs } from 'node:util';
import {
  createChecker,
  createMatcher,
  listCheckedDocs,
  loadConfig,
  type FileCheckResult,
  docTypeSchema,
  EXIT_HAS_ERRORS,
  EXIT_INTERNAL_ERROR,
  EXIT_OK,
  formatResultsJson,
  formatResultsText,
  IMPLEMENTED_PASSES,
  msg,
  passIdSchema,
  tally,
  type CliOverrides,
  type DocType,
  type PassId,
} from '@lingspark/core';
import { builtinRuleSources } from '@lingspark/rules-builtin';

/** The checked documents of the project `dir` is in; none outside a project. */
function projectDocs(dir: string): string[] {
  const config = loadConfig({ cwd: dir });
  return config.projectRoot === null ? [] : listCheckedDocs(config.projectRoot, createMatcher(config));
}

const CHECK_USAGE = msg.cli.checkUsage;

function parsePasses(raw: string): PassId[] | null {
  const out: PassId[] = [];
  for (const part of raw.split(',')) {
    const r = passIdSchema.safeParse(Number(part.trim()));
    if (!r.success) return null;
    out.push(r.data);
  }
  return out;
}

/** `lingspark check` (design doc, 5.1). Knows nothing about hook protocols. */
export async function runCheck(argv: string[], io: { out: (s: string) => void; err: (s: string) => void }): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      format: { type: 'string', default: 'text' },
      passes: { type: 'string' },
      offline: { type: 'boolean', default: false },
      'doc-type': { type: 'string' },
      all: { type: 'boolean', default: false },
      budget: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help === true) {
    io.out(CHECK_USAGE);
    return EXIT_OK;
  }
  const all = values.all === true;
  if (positionals.length === 0 && !all) {
    io.err(`${msg.cli.noFiles}\n\n${CHECK_USAGE}`);
    return EXIT_INTERNAL_ERROR;
  }

  const format = values.format;
  if (format !== 'text' && format !== 'json') {
    io.err(msg.cli.badOption('format', String(format), 'text, json'));
    return EXIT_INTERNAL_ERROR;
  }

  const cli: { -readonly [K in keyof CliOverrides]: CliOverrides[K] } = {};
  if (values.offline === true) cli.offline = true;
  if (values.passes !== undefined) {
    const passes = parsePasses(values.passes);
    if (passes === null) {
      io.err(msg.cli.badOption('passes', values.passes, msg.cli.passesAllowed));
      return EXIT_INTERNAL_ERROR;
    }
    cli.passes = passes;
  }

  let docTypeOverride: DocType | undefined;
  if (values['doc-type'] !== undefined) {
    const r = docTypeSchema.safeParse(values['doc-type']);
    if (!r.success) {
      io.err(msg.cli.badOption('doc-type', values['doc-type'], docTypeSchema.options.join(', ')));
      return EXIT_INTERNAL_ERROR;
    }
    docTypeOverride = r.data;
  }

  const budgetS = values.budget !== undefined ? Number(values.budget) : NaN;
  const checker = createChecker({
    cli,
    ...(budgetS > 0 ? { judgeBudgetMs: budgetS * 1000 } : {}),
    builtinRules: builtinRuleSources,
    ...(docTypeOverride !== undefined ? { docTypeOverride } : {}),
  });

  const cwd = process.cwd();
  // --all: every checked document of the project this directory belongs to.
  const targets = all ? [...positionals, ...projectDocs(cwd)] : positionals;

  // One file at a time: Pass 2 shares one deadline across the whole run.
  const results: FileCheckResult[] = [];
  for (const f of [...new Set(targets)]) results.push(await checker.checkFile(f));

  // Then Pass 3 across documents. Named files are the focus; --all reports
  // every contradiction in the project.
  const across = await checker.checkAcross(targets, { focus: !all });
  for (const d of across.diagnostics) {
    const i = results.findIndex((r) => r.absPath === d.file);
    const r = results[i];
    if (r !== undefined) results[i] = { ...r, diagnostics: [...r.diagnostics, d] };
  }

  if (format === 'json') {
    io.out(formatResultsJson(results, cwd) + '\n');
  } else {
    io.out(formatResultsText(results, cwd) + '\n');
    const requested = cli.passes ?? [0, 1, 2, 3, 4];
    const missing = requested.filter((p) => !IMPLEMENTED_PASSES.includes(p));
    if (missing.length > 0) io.err(msg.check.passesSkipped(missing.join('、')) + '\n');
    for (const note of new Set(results.flatMap((r) => (r.judgeNote !== undefined ? [r.judgeNote] : [])))) {
      io.err(`${note}\n`);
    }
    for (const w of new Set(results.flatMap((r) => r.warnings))) io.err(`${w}\n`);
    for (const n of across.notes) io.err(`${n}\n`);
  }

  if (results.some((r) => r.skipped === 'not-found' || r.skipped === 'unreadable')) {
    return EXIT_INTERNAL_ERROR;
  }
  return tally(results).errors > 0 ? EXIT_HAS_ERRORS : EXIT_OK;
}
