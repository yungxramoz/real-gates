2. Install what a user would get, never the working tree. From a clean copy of the merged branch:
   `git worktree add .loop/accept-wt origin/{{BASE}}`, then in it `npm ci` (if there is a lockfile
   with dependencies) and `npm pack --pack-destination ../accept-{{MILESTONE}}` (create that
   folder first). Install the tarball into an empty folder:
   `npm install --prefix .loop/accept-{{MILESTONE}}/app <tarball>`. Run the binary only from
   `.loop/accept-{{MILESTONE}}/app/node_modules/.bin/`. A file the package forgot to ship fails
   here and nowhere else. Never install globally and never `npm link`.
3. Walk **every command** this milestone enables, from that installed binary, in a scratch folder
   under `.loop/`: the examples from `--help`, then the unhappy paths: no arguments, an unknown
   flag, a missing argument, bad input, piped input, output into a pipe. Check every acceptance
   criterion against what you actually see on stdout, stderr and in the exit code, not against
   the code. Test data: only obviously fake names and `@example.com` addresses. Remove the
   worktree when you are done (`git worktree remove --force .loop/accept-wt`).
