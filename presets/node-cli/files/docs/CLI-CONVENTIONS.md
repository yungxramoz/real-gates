# CLI conventions

How this tool behaves on a command line. Every command follows it; the reviewer and the
acceptance step score against it. Change a rule here only through a decision in
`docs/DECISIONS.md`.

## Streams

| Stream | Carries |
| ------ | ------- |
| stdout | The result, and nothing else. What a script would capture or pipe on |
| stderr | Everything said to a person: errors, warnings, progress |

A command whose result is empty prints nothing on stdout. `--help` and `--version` are results:
they go to stdout.

## Exit codes

| Code | Meaning |
| ---- | ------- |
| 0 | The command did its job |
| 1 | The command ran and failed (a missing file, a refused connection) |
| 2 | The command line was wrong (an unknown command or flag, a missing argument). Nothing was done |

A new code needs a row here first.

## Help and errors

- `<name> --help` lists every command with a one-line summary. `<name> <command> --help` shows
  the usage line, what the command does, its options, and one example that works as written.
- An error is one line on stderr: `<name> <command>: what was wrong`, followed by what to do
  when that is not obvious. A user never sees a stack trace.
- An unknown command or flag names it and points at `--help`.

## Arguments and options

- Options have a long form (`--output`); a short form (`-o`) only for the ones used daily.
- `--` ends the options. `-` as a file name means stdin or stdout.
- The common case needs no options. A default that surprises is a bug.
- A destructive command asks before it acts when stdin is a terminal, and refuses without
  `--yes` when it is not.

## Output

- Output that a script might read is stable: one record per line, or `--json` with documented
  keys. Changing it is a breaking change.
- No colour, spinners or prompts unless stdout is a terminal. Respect `NO_COLOR`.
- No trailing spaces; the output ends with a newline.

## Robustness

- Input may be empty, huge, binary or piped. None of that produces a stack trace or a hang.
- A command that fails halfway leaves no half-written file: write to a temporary file, then rename.
- Nothing reads or writes outside the paths the user named, except documented config locations.
