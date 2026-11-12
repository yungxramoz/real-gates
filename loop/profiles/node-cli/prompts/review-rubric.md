The scores are for `command` items, calibrated against `docs/CLI-CONVENTIONS.md`: **help and
     errors** (`--help` is complete and shows an example; every error says what was wrong and what
     to do, on stderr, with the right exit code), **ergonomics** (names, flags and defaults are
     what a user of similar tools expects; the common case needs no flags), **output** (results on
     stdout only, stable and parseable where a script would read it, no colour or decoration when
     piped), **robustness** (bad, missing, huge or piped input never produces a stack trace or a
     hang; nothing is half-written on failure).
