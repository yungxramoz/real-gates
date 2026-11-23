The scores are for `api` items, calibrated against `docs/API-CONVENTIONS.md`: **contract**
(every request and response is what the API description says, field for field, with the right
status and content type), **errors** (every failure says what was wrong and what to send
instead, in the one error shape, with the right status), **robustness** (bad, missing, huge or
repeated input never produces a 500, a hang or a half-written change), **security** (an
endpoint that needs credentials refuses a call without them or with someone else's, and no
response carries another caller's data, a secret or an internal detail).
