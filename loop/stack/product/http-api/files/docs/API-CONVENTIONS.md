# API conventions

How this project's endpoints behave. Every endpoint follows it; the reviewer and the acceptance
step score against it. Change a rule here only through a decision in `docs/DECISIONS.md`.

## Paths and methods

- Every endpoint is under `/api/`. A path names a thing in the plural (`/api/projects`), and one
  of them by its id (`/api/projects/:id`).
- `GET` reads and changes nothing. `POST` creates or starts something. `PUT` replaces, `PATCH`
  changes part, `DELETE` removes. A method an endpoint does not have answers 404 or 405.
- Bodies are JSON, in and out, with `content-type: application/json`.

## Status codes

- **200**: it worked, and the body is the result
- **201**: something was created; the body is what was created
- **204**: it worked and there is nothing to return
- **400**: the request is wrong: a missing field, a wrong type, a body that is not JSON
- **401**: the endpoint needs credentials and the request has none that are valid
- **403**: the caller is known and may not do this
- **404**: there is no such endpoint, or no such thing
- **409**: the request is right and does not fit the current state (it exists already)
- **500**: the server failed. A request should never be able to cause this on purpose

A new code needs a line here first.

## Errors

Every answer from 400 up has the same body:

```json
{ "error": "not_found", "message": "No project with the id 42." }
```

- `error` is a fixed word a program can test for, in `snake_case`.
- `message` is one sentence for a person: what was wrong and, when that is not obvious, what to
  send instead.
- Never a stack trace, a file path, a query or the name of an internal part.

## Input

- Every body, query and path value is checked at the edge, before anything is read or written.
  What is not in the description is refused or ignored the same way everywhere.
- A change either happens completely or not at all: a failure halfway leaves nothing behind.
- The same write sent twice does not do the thing twice where that would be wrong.

## Health

`GET /api/health` answers `{ "status": "ok" }` when the server can do its work.
