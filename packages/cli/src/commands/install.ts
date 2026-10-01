import { parseArgs } from 'node:util';
import os from 'node:os';
import {
  AGENTS,
  AGENT_IDS,
  applyBridge,
  applyChange,
  installableAgents,
  configFileFor,
  installBinary,
  installedHookCommand,
  EXIT_INTERNAL_ERROR,
  EXIT_OK,
  InstallError,
  lineDiff,
  msg,
  planBridge,
  planInstall,
  planUninstall,
  type InstallScope,
} from '@lingspark/core';

const SCOPES: readonly InstallScope[] = ['user', 'project'];

/** The file the installed hook actually runs, for the message. */
const installedBinaryPath = (): string => {
  const cmd = installedHookCommand().posix;
  const paths = [...cmd.matchAll(/"([^"]+)"/gu)].map((m) => m[1] ?? '');
  return paths[paths.length - 1] ?? cmd;
};

interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
}

/** `lingspark install` and `lingspark uninstall` (design doc, 5.6). */
export function runInstall(argv: string[], io: Io, mode: 'install' | 'uninstall'): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      agent: { type: 'string' },
      scope: { type: 'string', default: 'user' },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
  });

  const usage = msg.install.usage(
    installableAgents().map((a) => a.id).join(', '),
    AGENTS.filter((a) => a.verification !== 'docs').map((a) => a.id).join(', '),
  );
  if (values.help === true) {
    io.out(usage);
    return EXIT_OK;
  }

  const agent = String(values.agent);
  if (!AGENT_IDS.includes(agent)) {
    io.err(`${msg.cli.badOption('agent', agent, AGENT_IDS.join(', '))}\n\n${usage}`);
    return EXIT_INTERNAL_ERROR;
  }
  const scope = values.scope as InstallScope;
  if (!SCOPES.includes(scope)) {
    io.err(`${msg.cli.badOption('scope', String(values.scope), SCOPES.join(', '))}\n`);
    return EXIT_INTERNAL_ERROR;
  }

  try {
    const profile = AGENTS.find((a) => a.id === agent);
    const dryRun = values['dry-run'] === true;
    // Copy first, then point the hook at the copy -- never at a build output
    // that the next rebuild wipes (D-033). A dry run copies nothing.
    const command = mode === 'install' ? (dryRun ? installedHookCommand() : installBinary()) : null;

    if (profile?.bridge !== undefined) {
      // Extension-loading agents: the "config" is a generated bridge file.
      // Project-scope bridges do not exist yet; the bridge lives in the home.
      if (scope !== 'user') {
        io.err(`${msg.cli.badOption('scope', scope, 'user')}\n`);
        return EXIT_INTERNAL_ERROR;
      }
      const cmd = command ?? installedHookCommand();
      const change = planBridge(profile, mode, cmd, os.homedir());
      if (!change.changed) {
        io.out(`${msg.install.nothingToDo(change.file)}\n`);
        return EXIT_OK;
      }
      if (dryRun) {
        io.out(`${msg.install.dryRunHead(change.file, change.existed)}\n\n${lineDiff(change.before, change.after)}\n`);
        return EXIT_OK;
      }
      applyBridge(profile, mode, cmd, os.homedir());
      const lines = [
        mode === 'install' ? msg.install.installed(agent, change.file) : msg.install.uninstalled(agent, change.file),
      ];
      if (mode === 'install') lines.push(msg.install.copied(installedBinaryPath()));
      if (mode === 'install') lines.push('', msg.install.restartHint, msg.install.scopeHint);
      if (mode === 'install' && profile.afterInstall !== undefined) lines.push('', profile.afterInstall);
      io.out(`${lines.join('\n')}\n`);
      return EXIT_OK;
    }

    const file = configFileFor(agent, scope);
    const change = command !== null ? planInstall(file, agent, command) : planUninstall(file);

    if (!change.changed) {
      const lines = [msg.install.nothingToDo(file)];
      if (mode === 'install' && !dryRun) lines.push(msg.install.copied(installedBinaryPath()));
      io.out(`${lines.join('\n')}\n`);
      return EXIT_OK;
    }

    if (dryRun) {
      io.out(`${msg.install.dryRunHead(file, change.existed)}\n\n${lineDiff(change.before, change.after)}\n`);
      return EXIT_OK;
    }

    const backup = applyChange(change);
    const lines = [
      mode === 'install' ? msg.install.installed(agent, file) : msg.install.uninstalled(agent, file),
    ];
    if (backup !== null) lines.push(msg.install.backup(backup));
    if (mode === 'install') lines.push(msg.install.copied(installedBinaryPath()));
    if (mode === 'install') lines.push('', msg.install.restartHint, msg.install.scopeHint);
    const after = AGENTS.find((a) => a.id === agent)?.afterInstall;
    if (mode === 'install' && after !== undefined) lines.push('', after);
    io.out(`${lines.join('\n')}\n`);
    return EXIT_OK;
  } catch (err: unknown) {
    io.err(`${err instanceof InstallError ? err.message : String(err)}\n`);
    return EXIT_INTERNAL_ERROR;
  }
}
