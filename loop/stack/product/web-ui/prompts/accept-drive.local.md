2. Run what was merged, never the working tree. From a clean copy of the merged branch:
   `git worktree add {{WORK}}/wt origin/{{BASE}}`, then in it install the dependencies from the
   lockfile and make the production build, the way `CLAUDE.md` says. Start that build on a free
   unusual port, with its output in `{{WORK}}/server.log` and any data file it keeps under
   `{{WORK}}/`. Before you test anything, fetch a page and check for a string only this commit
   serves: another process on the port gives a convincing false pass.
3. With Playwright against that local address, at 360 px, a common phone size and a desktop
   width: walk **every user journey** this milestone enables, including the unhappy paths:
   invalid input, empty and full states, expired or wrong links, keyboard only, slow network.
   Check every acceptance criterion against what you actually see, not against the code. Test
   data: only obviously fake names and `@example.com` addresses. Stop the server when you are
   done, and leave the worktree where it is: the packet step uses it.
