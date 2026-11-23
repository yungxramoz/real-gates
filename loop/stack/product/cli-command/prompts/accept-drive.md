2. Install what a user would get, never the working tree. From a clean copy of the merged branch:
   `git worktree add {{WORK}}/wt origin/{{BASE}}`, then in it `npm ci` (if there is a lockfile
   with dependencies) and `npm pack --pack-destination ..`, which puts the tarball into
   `{{WORK}}/`. Install it into an empty folder: `npm install --prefix {{WORK}}/app <tarball>`.
   Run the binary only from `{{WORK}}/app/node_modules/.bin/`. A file the package forgot to ship
   fails here and nowhere else. Never install globally and never `npm link`.
3. Walk **every command** this milestone enables, from that installed binary, in scratch folders
   under `{{WORK}}/`: the examples from `--help`, then the unhappy paths: no arguments, an unknown
   flag, a missing argument, bad input, piped input, output into a pipe. Check every acceptance
   criterion against what you actually see on stdout, stderr and in the exit code, not against
   the code. Test data: only obviously fake names and `@example.com` addresses. Remove the
   worktree when you are done (`git worktree remove --force {{WORK}}/wt`).
