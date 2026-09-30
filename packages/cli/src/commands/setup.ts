import { parseArgs } from 'node:util';
import {
  AGENTS,
  chooseJudge,
  enableAgents,
  EXIT_INTERNAL_ERROR,
  EXIT_OK,
  msg,
  setupState,
} from '@lingspark/core';

interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
}

/**
 * `lingspark setup`: everything a new user needs, in one command, with
 * defaults that are right for almost everyone. Each step reports what it did;
 * a step that cannot be done is explained and the rest still run.
 */
export function runSetup(argv: string[], io: Io): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      judge: { type: 'string' },
      agents: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help === true) {
    io.out(msg.setup.usage);
    return EXIT_OK;
  }

  const state = setupState();
  const lines = [msg.setup.heading, '', msg.setup.agentsHead];
  let failed = false;

  const wanted = values.agents?.split(',').map((s) => s.trim()).filter(Boolean);
  const targets = state.agents
    .filter((a) => a.installable && (wanted !== undefined ? wanted.includes(a.id) : a.present))
    .map((a) => a.id);
  if (targets.length === 0) lines.push(msg.setup.noAgents);
  const after = setupState();
  for (const r of enableAgents(targets)) {
    lines.push(`  ${r.ok ? '✓' : '✗'} ${r.message}`);
    const step = AGENTS.find((a) => a.id === r.id)?.afterInstall;
    if (r.ok && step !== undefined) lines.push(`    ${step}`);
    const status = after.agents.find((a) => a.id === r.id);
    if (r.ok && status !== undefined && (values.judge ?? after.judge.current ?? after.judge.recommended) === 'auto') {
      lines.push(`    ${status.selfReview ? msg.setup.selfReviewOn : msg.setup.selfReviewOff(status.selfReviewStep)}`);
    }
    if (!r.ok) failed = true;
  }
  for (const a of state.agents.filter((x) => x.present && !x.installable)) {
    lines.push(msg.setup.communityAgent(AGENTS.find((p) => p.id === a.id)?.name ?? a.id));
  }

  lines.push('', msg.setup.judgeHead);
  const byBackend = new Map(state.judge.options.map((o) => [o.backend as string, o]));
  if (values.judge !== undefined && values.judge !== 'none') {
    chooseJudge(values.judge);
    lines.push(msg.setup.judgeChosen(byBackend.get(values.judge)?.label ?? values.judge));
  } else if (values.judge === 'none') {
    lines.push(msg.setup.judgeNone);
  } else if (state.judge.current !== null) {
    lines.push(msg.setup.judgeKept(state.judge.current));
  } else if (state.judge.recommended !== null) {
    chooseJudge(state.judge.recommended);
    lines.push(msg.setup.judgeChosen(byBackend.get(state.judge.recommended)?.label ?? state.judge.recommended));
  } else {
    lines.push(msg.setup.judgeNone);
  }

  lines.push('', msg.setup.done);
  io.out(`${lines.join('\n')}\n`);
  return failed ? EXIT_INTERNAL_ERROR : EXIT_OK;
}
