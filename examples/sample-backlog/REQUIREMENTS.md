# Requirements — Team lunch poll (sample)

A sample of what `/shape-project` writes, for a tiny app: a team creates a lunch poll, everyone
votes on a phone, the poll closes at a set time and shows the winner. The matching backlog is
[backlog.json](backlog.json). Not part of your project; read it, then shape your own.

## E1 — Polls

### S1.1 — Create a poll

As an organiser, I want to create a poll with a few lunch options and a closing time, so that the
team can decide before noon.

- AC-1.1 An organiser creates a poll with 2 to 8 options and a closing time in the future.
- AC-1.2 A poll with fewer than 2 options or a closing time in the past is refused with a message next to the field.
- AC-1.3 After creating, the organiser sees a share link.

### S1.2 — Vote

As a team member, I want to open the link and vote with one tap, so that voting takes seconds.

- AC-1.4 Anyone with the link votes for one option without an account.
- AC-1.5 A second vote from the same browser replaces the first.
- AC-1.6 Voting works at 360 px and passes axe with no violations.

## E2 — Results and reminders

### S2.1 — Results

As a team member, I want to see the results, so that I know where we eat.

- AC-2.1 While open, the poll shows vote counts per option, updated on reload.
- AC-2.2 At the closing time the poll stops taking votes and shows the winner; a tie lists every tied option.

### S2.2 — Reminder

As an organiser, I want a reminder email to go out 15 minutes before closing, so that late voters
still vote.

- AC-2.3 A reminder email goes to the organiser's address 15 minutes before closing, once.
- AC-2.4 In preview and CI the email is sent to the stub, never to a real inbox.
