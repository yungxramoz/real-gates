# Choosing the stack

Step 0 of `/setup-loop`: what the project is built with. A project's stack is a list of **stack
blocks** (`loop/stack/<category>/<name>/`), one block per choice. This page says how to recommend
them, how to show the choice, and what to run for each outcome.

## Contents

- [When the step applies](#when-the-step-applies)
- [The interview](#the-interview)
- [Recommending](#recommending)
- [The chooser](#the-chooser)
- [What to run](#what-to-run)
- [Sets that were built for real](#sets-that-were-built-for-real)

## When the step applies

| What you find | The project's stack | Do |
| --- | --- | --- |
| `loop/loop.config.json` has a `stack` list | chosen, the project was built from blocks | Skip the step. Show the stack in one line |
| No `presets/` folder | chosen, a preset was applied | Skip the step. Show the stack in one line |
| A `presets/` folder, `profile` is `next-supabase-vercel`, no `stack` | not chosen: this is a fresh copy of the template | Run the step |

`node loop/scripts/stack.mjs` prints the stack and what it adds up to.

## The interview

Ask one question at a time, in plain words. Stop asking as soon as the answers decide every
category.

1. **What are you building?** Two sentences are enough.
2. **What does a person, or a program, touch?** Screens in a browser, commands in a terminal,
   endpoints other programs call. More than one may apply.
3. **Where does it run?** Deployed somewhere, or only on the machine of the person who uses it.
4. **Where does the data live?** A hosted database, a file on the machine, or nowhere.
5. **Is anything already decided?** A framework, a host, a database the user wants. What the user
   names is the choice: the engineer decides the stack, you only recommend.

## Recommending

```bash
node loop/scripts/stack.mjs --list --json
```

It returns every category with its blocks, each with `title`, `description`, `choose` and
`status`. `choose` is one sentence that is true or false for a project. Recommend the block whose
sentence is true for what the user said.

- **One forge and one toolchain**, always. **At most one hosting block.** Any number of the others.
- **Some blocks come only with their profile.** The list marks them with `comesWith`: the Next.js
  framework, its toolchain and Supabase belong to the profile `next-supabase-vercel`, the CLI
  command and its toolchain to `node-cli`. Their code exists only in that profile's project, so
  they cannot be mixed into another stack and the builder refuses a list that holds one. Offer
  them as the whole profile: "the web profile (Next.js, Supabase, Vercel)" and "the CLI profile"
  are two options of their own, beside the blocks that can be combined freely.
- **The toolchain follows the framework.** Anything built with Vite (a React app, a Fastify
  server) takes `toolchain/vite-plus`.
- **A product block needs a framework that serves it.** `product/web-ui` needs one that renders
  pages, `product/http-api` one that answers requests.
- **Prefer a proven block** when two fit equally. Say so when the recommendation is a draft:
  it is tested, and no project has run on it yet.
- **Nothing fits?** Say which category has no block for what the user wants. Do not pick the
  nearest one silently. The user can take the closest block and change the project by hand, or
  stop here.

## The chooser

Show the choice so the user selects, not types. One question per category, in this order: forge,
toolchain, framework, product, database, hosting.

- First one question that decides the rest: a whole profile, or a stack of the user's own. The
  options are the two profiles and "my own combination". A profile ends the chooser.
- For an own combination, every block of the category without `comesWith` is an option: its
  `title`, then its `choose` sentence.
- The recommended option comes first and is marked "(recommended)".
- A draft is marked "[draft]".
- A category that may hold several blocks (framework, product, database) lets the user pick
  several. A category that may be empty (framework, product, database, hosting) has the option
  "none".
- Use the question tool with these options when the session has one. Without it, print a numbered
  list per category and ask for the numbers.

A category with one block and no "none" (the forge today) needs no question: say what it is.

After the last answer, repeat the whole stack in one list and ask for a yes before anything is
changed.

## What to run

| The chosen blocks are | Run | Then |
| --- | --- | --- |
| The profile `next-supabase-vercel` | nothing: the template as it stands is that project | Continue with step 1 |
| The profile `node-cli` | `node scripts/apply-preset.mjs node-cli` | Commit, continue with step 1 |
| Any other list | `node scripts/build-stack.mjs --stack <a>,<b>,… --dry-run`, then the same without `--dry-run` | See below |

For a built stack:

1. Show the dry run: what is removed (the web profile's files), what each block writes, which
   blocks are drafts and which bring no files. A problem it names (two blocks that do not fit, a
   block that comes only with its profile) goes back to the chooser.
2. Ask for a yes, then run it. It refuses a working tree with uncommitted changes.
3. Ask, then install the dependencies (`pnpm install`). The lockfile it writes belongs in the
   commit: CI installs with `--frozen-lockfile`.
4. Run the project's own gate once (`pnpm check`). A failure here is a defect of a block, not of
   the user's project: say which step failed and stop.
5. Propose a commit on a branch (`chore: build the stack`). Ask before `git push`.

Then continue with step 1: the validator now reads the new stack.

## Sets that were built for real

These lists were built, installed and run through `check`, `build` and `test:e2e`:

| The project | Blocks |
| --- | --- |
| A web app with its own server and a local database | `forge/github`, `toolchain/vite-plus`, `framework/react-vite`, `framework/fastify`, `product/web-ui`, `product/http-api`, `database/sqlite`, `hosting/none` |
| A web app alone | `forge/github`, `toolchain/vite-plus`, `framework/react-vite`, `product/web-ui`, `hosting/none` |
| A server alone | `forge/github`, `toolchain/vite-plus`, `framework/fastify`, `product/http-api`, `database/sqlite`, `hosting/none` |

Any other list is put together by the same rules and has not been run. Say so before building it.
