- **Use it like a client** (items of work type `api`): check the branch out into a temporary
  worktree (`git worktree add {{WORK}}/wt origin/{{BRANCH}}`), install, build and start the
  server there on a free unusual port, and call it the way someone who has only read the API
  description would: the documented examples, then a missing field, a wrong type, an extra
  field, an empty body, a very large body, a wrong method, an unknown route, no credentials and
  someone else's, the same write twice. Check the status, the headers and the body each time.
  Don't stop at the happy path the author tested. Save the transcripts into
  `.loop/shots/{{ITEM_ID}}-review/`. Stop the server and remove the worktree afterwards
  (`git worktree remove --force {{WORK}}/wt`).
