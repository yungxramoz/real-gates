- A new or changed endpoint (work type `api`) gets at least one end-to-end test whose title
  carries the AC ID. It starts the real server on a free port and calls it over HTTP, and checks
  the status, the headers that matter and the body. Cover the unhappy paths the AC names: a
  missing field, a wrong type, an unknown route, a wrong method, no credentials or the wrong
  ones where the endpoint asks for them.
- Follow `docs/API-CONVENTIONS.md`: one shape for every error body, the status codes it lists,
  input checked at the boundary before anything is read or written, no stack trace or internal
  name in a response.
- Save a transcript of each endpoint you built (the request, the status, the headers that
  matter, the body) into `.loop/shots/{{ITEM_ID}}/` and **read it** the way the author of a
  client would. The reviewer scores contract, errors, robustness and security 1–10 and blocks
  anything below {{MIN_SCORE}}.
