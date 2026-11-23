1. Nothing is deployed for this project. Work from the build the acceptance step left in
   `{{ACCEPT_WORK}}/wt/`: start it on a free unusual port. If it is gone, make it again the same
   way in your own folder (`git worktree add {{WORK}}/wt origin/{{BASE}}`, install, build,
   start). Stop the server when you are done.
2. With Playwright, screenshot every screen this milestone added or changed at 360 px, a common
   phone size and one desktop width, into `.loop/reviews/{{MILESTONE}}/`. Look at each one.
