- **Use it like a user** (UI items): check the branch out into a temporary worktree
     (`git worktree add .loop/review-wt origin/{{BRANCH}}`, install, build, start it on a free
     unusual port) and drive the flows with Playwright the way a first-time user would: click,
     type, submit, go back, keyboard only, the empty and error states, at 360 px and desktop. Don't
     stop at the happy path the author tested. Screenshot into `.loop/shots/{{ITEM_ID}}-review/`
     and look at every shot. Remove the worktree afterwards (`git worktree remove --force .loop/review-wt`).
