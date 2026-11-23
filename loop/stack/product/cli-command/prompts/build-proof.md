- A new or changed command (work type `command`) gets at least one end-to-end test in
  `tests/e2e/` whose title carries the AC ID. It starts the real binary (`bin/cli.mjs`) as a
  child process and checks stdout, stderr and the exit code separately. Cover the unhappy
  paths the AC names: a missing argument, an unknown flag, bad input, piped input.
- Follow `docs/CLI-CONVENTIONS.md`: results on stdout, messages on stderr, exit 0 / 1 / 2, a
  `--help` for every command, no colour or prompts when the output is not a terminal.
- Save a transcript of each command you built (the command line, stdout, stderr, exit code)
  into `.loop/shots/{{ITEM_ID}}/` and **read it** the way a first-time user would. The reviewer
  scores help and errors, ergonomics, output and robustness 1–10 and blocks anything below
  {{MIN_SCORE}}.
