// This entry point imports only constants and messages. Each command is
// loaded on demand, so `lingspark hook` on the no-op path never evaluates the
// parser, the config schema or the rules.
import { EXIT_INTERNAL_ERROR, EXIT_OK } from '@lingspark/core/constants.js';
import { msg } from '@lingspark/core/messages.js';

const VERSION = '0.1.0';

const io = {
  out: (s: string): void => {
    process.stdout.write(s);
  },
  err: (s: string): void => {
    process.stderr.write(s);
  },
};

async function main(argv: string[]): Promise<number> {
  const command = argv[0];

  // No arguments in a terminal -- which is what double-clicking the program
  // does -- opens the setup page. Piped or scripted, it stays plain help.
  if (command === undefined && process.stdin.isTTY && process.stdout.isTTY) {
    const { runUi } = await import('./commands/ui.js');
    return await runUi([], io);
  }
  if (command === undefined || command === '-h' || command === '--help') {
    io.out(msg.cli.usage);
    return EXIT_OK;
  }
  if (command === '-v' || command === '--version') {
    io.out(`${VERSION}\n`);
    return EXIT_OK;
  }

  const rest = argv.slice(1);
  switch (command) {
    case 'check': {
      const { runCheck } = await import('./commands/check.js');
      return await runCheck(rest, io);
    }
    case 'hook': {
      const { runHookCommand } = await import('./commands/hook.js');
      return runHookCommand(rest, io);
    }
    case 'install':
    case 'uninstall': {
      const { runInstall } = await import('./commands/install.js');
      return runInstall(rest, io, command);
    }
    case 'warm': {
      // Started by the hook in the background; not a command people type.
      const [{ runWarm }, { builtinRuleSources }] = await Promise.all([
        import('@lingspark/core/hook/warm.js'),
        import('@lingspark/rules-builtin'),
      ]);
      if (rest[0] !== undefined) {
        await runWarm(rest[0], { builtinRules: builtinRuleSources, ...(rest[1] !== undefined ? { agent: rest[1] } : {}) });
      }
      return EXIT_OK;
    }
    case 'setup': {
      const { runSetup } = await import('./commands/setup.js');
      return runSetup(rest, io);
    }
    case 'ui': {
      const { runUi } = await import('./commands/ui.js');
      return await runUi(rest, io);
    }
    case 'doctor': {
      const { runDoctorCommand } = await import('./commands/doctor.js');
      return await runDoctorCommand(rest, io);
    }
    case 'mine': {
      const { runMine } = await import('./commands/mine.js');
      return await runMine(rest, io);
    }
    case 'eval': {
      const { runEvalCommand } = await import('./commands/eval.js');
      return await runEvalCommand(rest, io);
    }
    case 'shadow-report': {
      const { runShadowReport } = await import('./commands/shadow-report.js');
      return runShadowReport(rest, io);
    }
    case 'feedback': {
      const { runFeedback } = await import('./commands/feedback.js');
      return runFeedback(rest, io);
    }
    case 'rule-maturity': {
      const { runRuleMaturity } = await import('./commands/rule-maturity.js');
      return runRuleMaturity(rest, io);
    }
    case 'terms': {
      const { runTerms } = await import('./commands/terms.js');
      return runTerms(rest, io);
    }
    case 'report':
    case 'rules':
      io.err(`${msg.cli.notImplemented(command)}\n`);
      return EXIT_INTERNAL_ERROR;
    default:
      io.err(`${msg.cli.unknownCommand(command)}\n`);
      return EXIT_INTERNAL_ERROR;
  }
}

const isHook = process.argv[2] === 'hook';

if (isHook) {
  // Fail-open all the way down (design doc, 5.4): nothing that escapes the
  // hook command, not even an async error, may produce a non-zero exit.
  process.on('uncaughtException', () => {
    process.exit(EXIT_OK);
  });
  process.on('unhandledRejection', () => {
    process.exit(EXIT_OK);
  });
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    if (isHook) {
      process.exitCode = EXIT_OK;
      return;
    }
    process.stderr.write(`lingspark: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = EXIT_INTERNAL_ERROR;
  },
);
