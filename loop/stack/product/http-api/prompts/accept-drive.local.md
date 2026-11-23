2. Run what was merged, never the working tree. From a clean copy of the merged branch:
   `git worktree add {{WORK}}/wt origin/{{BASE}}`, then in it install the dependencies from the
   lockfile and make the production build, the way `CLAUDE.md` says. Start that build on a free
   unusual port, with its output in `{{WORK}}/server.log` and any data file it keeps under
   `{{WORK}}/`. Before you test anything, call an endpoint only this commit has: another process
   on the port gives a convincing false pass.
3. Call **every endpoint** this milestone enables on that local address, the way the author of
   a client would: the documented examples first, then the unhappy paths: a missing field, a
   wrong type, an empty and a very large body, a wrong method, an unknown route, no credentials
   and the wrong ones, the same write twice. Check every acceptance criterion against the
   status, the headers and the body you actually get, not against the code. Test data: only
   obviously fake names and `@example.com` addresses. Stop the server when you are done, and
   leave the worktree where it is: the packet step uses it.
