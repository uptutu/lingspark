import { parseArgs } from 'node:util';
import {
  AGENTS,
  claudeCodeAdapter,
  createJudge,
  dataPaths,
  EXIT_INTERNAL_ERROR,
  EXIT_OK,
  loadUserConfig,
  mine,
  msg,
  resolveConfig,
} from '@lingspark/core';
import { builtinRuleSources } from '@lingspark/rules-builtin';

interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
}

const PREVIEW = 5;

/** `lingspark mine` (design doc, 9.7), extraction only until M2 adds classification. */
export async function runMine(argv: string[], io: Io): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      agent: { type: 'string', default: 'all' },
      since: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help === true) {
    io.out(msg.mine.usage);
    return EXIT_OK;
  }

  const agent = String(values.agent);
  const others = AGENTS.filter((a) => a.id !== 'claude-code').map((a) => a.name).join('、');
  if (agent !== 'all' && agent !== 'claude-code') {
    if (AGENTS.some((a) => a.id === agent)) {
      io.err(`${msg.mine.onlyClaudeCode(others)}\n`);
      return EXIT_OK;
    }
    io.err(`${msg.cli.badOption('agent', agent, 'claude-code, all')}\n`);
    return EXIT_INTERNAL_ERROR;
  }
  if (agent === 'all') io.err(`${msg.mine.onlyClaudeCode(others)}\n`);

  let since: Date | undefined;
  if (values.since !== undefined) {
    since = new Date(values.since);
    if (Number.isNaN(since.getTime())) {
      io.err(`${msg.mine.badSince(values.since)}\n`);
      return EXIT_INTERNAL_ERROR;
    }
  }

  const user = loadUserConfig();
  const config = resolveConfig({ projectRoot: null, project: null, user: user.config });
  const dryRun = values['dry-run'] === true;

  // Classification needs a judge. Without one, records keep a null category
  // and are classified on a later run (design doc, 9.5).
  const setup = config.miner.enabled && config.miner.projects.length > 0 ? createJudge(config) : null;
  const result = await mine({
    config,
    builtinRules: builtinRuleSources,
    adapters: [claudeCodeAdapter],
    dryRun,
    judge: setup?.judge ?? null,
    ...(since !== undefined ? { since } : {}),
  });

  if (result.status === 'disabled') {
    io.out(`${msg.mine.disabled(dataPaths.config())}\n`);
    return EXIT_OK;
  }
  if (result.status === 'no-projects') {
    io.out(`${msg.mine.noProjects(dataPaths.config())}\n`);
    return EXIT_OK;
  }

  const lines = [
    msg.mine.summary(
      result.transcriptsSeen,
      result.transcriptsScanned,
      result.records.length,
      result.skippedDuplicate,
      result.skippedRewrite,
      dryRun,
    ),
  ];
  if (result.records.length > 0) {
    lines.push('', msg.mine.preview);
    for (const r of result.records.slice(0, PREVIEW)) {
      const text = r.feedback.replace(/\s+/gu, ' ');
      lines.push(msg.mine.previewItem(r.file, text.length > 60 ? `${text.slice(0, 60)}…` : text, r.missed));
    }
    if (setup?.judge === null || setup === null) lines.push('', msg.mine.unclassified);
  }
  if (result.skippedNotRevision > 0) lines.push(msg.mine.notRevision(result.skippedNotRevision));
  if (result.backfilled > 0) lines.push(msg.mine.backfilled(result.backfilled));
  io.out(`${lines.join('\n')}\n`);
  return EXIT_OK;
}
