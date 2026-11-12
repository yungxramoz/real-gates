1. Nothing is deployed for this project. Work from the installed package the acceptance step
   left in `.loop/accept-{{MILESTONE}}/app/`; if it is gone, build it again the same way (pack the
   merged `origin` branch, install the tarball into a folder under `.loop/`).
2. For every command this milestone added or changed, save a transcript of `--help` and of its
   main example (command line, stdout, stderr, exit code) into `.loop/reviews/{{MILESTONE}}/`.
   Read each one.
