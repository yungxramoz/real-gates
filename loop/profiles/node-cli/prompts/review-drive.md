- **Use it like a user** (items of work type `command`): check the branch out into a temporary
     worktree (`git worktree add .loop/review-wt origin/{{BRANCH}}`) and run the binary there
     (`node .loop/review-wt/bin/cli.mjs …`) the way someone who has only read `--help` would: the
     documented examples, no arguments, `--help` on the command, an unknown flag, a missing
     argument, bad input, input from a pipe, output into a pipe (`| cat`), a very long argument.
     Check stdout, stderr and the exit code separately each time. Don't stop at the happy path
     the author tested. Save the transcripts into `.loop/shots/{{ITEM_ID}}-review/`. Remove the
     worktree afterwards (`git worktree remove --force .loop/review-wt`).
