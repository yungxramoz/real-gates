1. Nothing is deployed for this project. Work from the build the acceptance step left in
   `{{ACCEPT_WORK}}/wt/`: start it on a free unusual port. If it is gone, make it again the same
   way in your own folder (`git worktree add {{WORK}}/wt origin/{{BASE}}`, install, build,
   start). Stop the server when you are done.
2. For every endpoint this milestone added or changed, save a transcript of its main example
   (the request, the status, the headers that matter, the body) into
   `.loop/reviews/{{MILESTONE}}/`. Read each one.
