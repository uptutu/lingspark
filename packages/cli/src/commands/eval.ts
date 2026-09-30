import { parseArgs } from 'node:util';
import {
  EXIT_INTERNAL_ERROR,
  EXIT_OK,
  loadConfig,
  loadRules,
  msg,
  parseBackendSpec,
  runEval,
  type EvalMode,
} from '@lingspark/core';
import { builtinRuleSources } from '@lingspark/rules-builtin';

interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
}

/** `lingspark eval` (design doc, 10.4). Exits 1 when any evaluated rule misses the bar. */
export async function runEvalCommand(argv: string[], io: Io): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      backend: { type: 'string', multiple: true },
      rules: { type: 'string' },
      record: { type: 'boolean', default: false },
      replay: { type: 'boolean', default: false },
      fixtures: { type: 'string' },
      concurrency: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help === true) {
    io.out(msg.eval.usage);
    return EXIT_OK;
  }
  const backends = (values.backend ?? []).map(parseBackendSpec);
  if (backends.length === 0) {
    io.err(`${msg.eval.needBackend}\n\n${msg.eval.usage}`);
    return EXIT_INTERNAL_ERROR;
  }
  const mode: EvalMode = values.replay === true ? 'replay' : values.record === true ? 'record' : 'live';

  const config = loadConfig({ cwd: process.cwd() });
  const { rules } = loadRules({ config, builtin: builtinRuleSources });
  const wanted = values.rules?.split(',').map((s) => s.trim()).filter(Boolean);
  const selected = [...rules.values()]
    .filter((r) => wanted === undefined || wanted.includes(r.id))
    .sort((a, b) => a.id.localeCompare(b.id));

  const reports = await runEval({
    config,
    rules: selected,
    backends,
    mode,
    ...(values.fixtures !== undefined ? { fixturesDir: values.fixtures } : {}),
    ...(values.concurrency !== undefined && Number(values.concurrency) >= 1 ? { concurrency: Math.floor(Number(values.concurrency)) } : {}),
    // A slow backend takes minutes; say how far along it is.
    onProgress: (spec, done, total) => {
      if (process.stderr.isTTY) process.stderr.write(`\r${msg.eval.progress(spec, done, total)}`);
      else if (done === total || done % 10 === 0) io.err(`${msg.eval.progress(spec, done, total)}\n`);
    },
  });
  if (process.stderr.isTTY) process.stderr.write('\n');

  const names = new Map(selected.map((r) => [r.id, r.name]));
  const lines = [msg.eval.header(msg.eval.modes[mode] ?? mode)];
  let allPass = true;
  for (const b of reports) {
    if (b.problem !== undefined) {
      lines.push(msg.eval.problem(b.spec, b.problem));
      allPass = false;
      continue;
    }
    lines.push(msg.eval.backendLine(b.spec, b.judgeId ?? '', b.calibrated));
    for (const r of b.rules) {
      lines.push(msg.eval.ruleLine(r.ruleId, names.get(r.ruleId) ?? '', r.positiveHit, r.positiveTotal, r.falsePositives, r.negativeTotal, r.skipped, r.meetsBar));
      const why = r.results.find((x) => x.skippedReason !== undefined)?.skippedReason;
      if (why !== undefined) lines.push(msg.eval.skippedWhy(why));
      if (!r.meetsBar) allPass = false;
    }
    lines.push(
      msg.eval.totals(
        b.rules.filter((r) => r.meetsBar).length,
        b.rules.length,
        b.calls,
        b.failures,
        b.avgLatencyMs === null ? '—' : `${(b.avgLatencyMs / 1000).toFixed(2)} 秒`,
        `${String(b.inputTokens)} 入 / ${String(b.outputTokens)} 出`,
        b.costPer1000 === null ? msg.eval.unknownCost : `$${b.costPer1000.toFixed(2)}`,
      ),
    );
  }
  io.out(`${lines.join('\n')}\n`);
  return allPass ? EXIT_OK : 1;
}
