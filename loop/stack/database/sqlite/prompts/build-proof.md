- A change to the database schema is a new file in `migrations/`, numbered after the last one.
  Never edit a migration that is already on the base branch: a database that ran it would not
  run it again. A test opens a fresh database file, applies every migration in order and checks
  the result.
- Tests and the app you start to try a change use a database file of their own, in a temporary
  folder or under `.loop/`. Never open, copy or delete a database file a person uses.
