import {
  installedHookCommand,
  EXIT_INTERNAL_ERROR,
  EXIT_OK,
  msg,
  runDoctor,
  type CheckStatus,
} from '@lingspark/core';
import { builtinRuleSources } from '@lingspark/rules-builtin';

const MARK: Readonly<Record<CheckStatus, string>> = { ok: '✓', warn: '!', fail: '✗', skip: '-' };

/** `lingspark doctor` (design doc, 5.7). Exits 3 when any check fails. */
export async function runDoctorCommand(argv: string[], io: { out: (s: string) => void }): Promise<number> {
  let current: string | undefined;
  try {
    current = installedHookCommand().posix;
  } catch {
    current = undefined;
  }
  const checks = await runDoctor({
    cwd: process.cwd(),
    offline: argv.includes('--offline'),
    builtinRules: builtinRuleSources,
    ...(current !== undefined ? { currentCommand: current } : {}),
  });

  const lines = [msg.doctor.title, ''];
  for (const c of checks) lines.push(`${MARK[c.status]} ${c.name}：${c.detail}`);
  const fails = checks.filter((c) => c.status === 'fail').length;
  const warns = checks.filter((c) => c.status === 'warn').length;
  lines.push('', msg.doctor.summary(fails, warns));
  io.out(`${lines.join('\n')}\n`);
  return fails > 0 ? EXIT_INTERNAL_ERROR : EXIT_OK;
}
