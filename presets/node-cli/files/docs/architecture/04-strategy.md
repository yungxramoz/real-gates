# 4 · Solution strategy

<!-- Written by /setup-loop from the preset, then changed only through a decision. -->

| Concern         | Choice                                                                        | Decision                 |
| --------------- | ----------------------------------------------------------------------------- | ------------------------ |
| How it is built | real-gates loop: one agent, the script merges                                 | [D-001](../DECISIONS.md) |
| Runtime         | Node.js, plain ESM, no build step                                             |                          |
| Dependencies    | Node built-ins first; each runtime dependency is a recorded decision          |                          |
| Distribution    | An npm package with one binary; `files` in `package.json` lists what ships    |                          |
| Tests           | `node:test`: in-process unit tests, end-to-end tests on the binary and on the |                          |
|                 | packed, installed package; coverage thresholds as a ratchet                   |                          |
| Interface rules | `docs/CLI-CONVENTIONS.md`: streams, exit codes, help, output                  |                          |

## Key ideas

<!-- Two to five bullets: the ideas that shape the code, e.g. "every command is a pure function
of its arguments and an io object, so it is tested without a process". -->
