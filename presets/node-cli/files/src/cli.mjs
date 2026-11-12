// The command line: pick one command, run it, return the exit code.
//
// Conventions (docs/CLI-CONVENTIONS.md): results go to stdout, messages to stderr; exit 0 when the
// command did its job, 1 when it failed, 2 when the command line itself was wrong. `main` never
// calls process.exit and writes only through `io`, so tests run it in-process.

import { readFileSync } from 'node:fs';

export const EXIT = Object.freeze({ ok: 0, failed: 1, usage: 2 });

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
/** The name users type: the first key of `bin` in package.json. */
export const NAME = Object.keys(pkg.bin || {})[0] || pkg.name;

/**
 * The commands, by name: { summary, usage, run(args, io) -> exit code (or nothing for 0) }.
 * A new command is one entry here, plus its tests.
 */
export const COMMANDS = {};

export function usage(commands = COMMANDS) {
  const names = Object.keys(commands).sort();
  const width = Math.max(0, ...names.map((n) => n.length));
  const list = names.length ? names.map((n) => `  ${n.padEnd(width)}  ${commands[n].summary}`) : ['  (none yet)'];
  return [`Usage: ${NAME} <command> [options]`, '', 'Commands:', ...list, '', 'Options:', '  -h, --help     Show this help, or the help of a command', '  -V, --version  Show the version', ''].join('\n');
}

/** Run the command line `argv` (without node and the script path). Returns the exit code. */
export async function main(argv, io = { stdout: process.stdout, stderr: process.stderr }, commands = COMMANDS) {
  const [first, ...rest] = argv;
  if (first === undefined || first === '--help' || first === '-h' || first === 'help') {
    io.stdout.write(usage(commands));
    return EXIT.ok;
  }
  if (first === '--version' || first === '-V') {
    io.stdout.write(`${pkg.version}\n`);
    return EXIT.ok;
  }
  if (!Object.hasOwn(commands, first)) {
    io.stderr.write(`${NAME}: unknown command "${first}". Run "${NAME} --help" for the list.\n`);
    return EXIT.usage;
  }
  const command = commands[first];
  if (rest.includes('--help') || rest.includes('-h')) {
    io.stdout.write(`Usage: ${NAME} ${command.usage || first}\n\n${command.summary}\n`);
    return EXIT.ok;
  }
  try {
    return (await command.run(rest, io)) ?? EXIT.ok;
  } catch (error) {
    // A user never sees a stack trace: one line that says what went wrong.
    io.stderr.write(`${NAME} ${first}: ${error?.message || error}\n`);
    return EXIT.failed;
  }
}
