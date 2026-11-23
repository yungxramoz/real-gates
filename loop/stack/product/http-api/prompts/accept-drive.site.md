2. Dev URL: `{{DEV_URL}}`. If the environment variable `{{BYPASS_ENV}}` is set, send its value as
   the `{{BYPASS_HEADER}}` header to get past preview protection. Never print it.
3. Call **every endpoint** this milestone enables on the dev URL, the way the author of a client
   would: the documented examples first, then the unhappy paths: a missing field, a wrong type,
   an empty and a very large body, a wrong method, an unknown route, no credentials and the
   wrong ones, the same write twice. Check every acceptance criterion against the status, the
   headers and the body you actually get, not against the code. Test data: only obviously fake
   names and `@example.com` addresses; clean up through the API's own calls where it offers
   them. Never touch production.
