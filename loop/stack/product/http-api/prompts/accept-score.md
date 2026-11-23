4. Score every endpoint on the rubric, 1–10, calibrated against `docs/API-CONVENTIONS.md`:
   **contract**, **errors**, **robustness**, **security**. Save one transcript per endpoint
   (the request, the status, the headers that matter, the body) to
   `.loop/reviews/{{MILESTONE}}/accept-r{{ROUND}}/`; read each. A 500, a stack trace in a
   response or a hang is a failure whatever the score.
