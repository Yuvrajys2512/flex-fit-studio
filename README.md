# FlexFit Studio

Class booking and membership management for a single gym site. Members book classes, buy memberships and spend class credits. Staff run the front desk, manage trainers and pull reports. Companies buy credit pools their employees book against.

## Start here

This is a restructured version of the original codebase. Behaviour is unchanged
and there is a test suite that proves it.

> **About the commit history:** commits by `Admin-1` … `Admin-5` are the original codebase this project started from.
> My work starts at *"Add characterization test suite covering current behaviour"* (August 2026).

| Document | What it is |
| --- | --- |
| [documents/architecture.md](documents/architecture.md) | How the code is arranged and why. Read this first. |
| [documents/findings.md](documents/findings.md) | 25 things that look wrong, what I did about each, and why. |

The short version: the studio's rules used to live inside the tRPC routers,
which meant they were duplicated — `corporate-bookings.ts` was a copy of
`bookings.ts` that had drifted into the opposite bug on the same code path. The
rules now live in `src/server/modules/`, the routers are transport, and 160
tests written against the original code still pass — plus 3 more added
alongside the 4 findings (of 25) that got fixed rather than just documented.

## Requirements

Node 20 or newer, and pnpm. If you don't have pnpm:

```bash
npm install -g pnpm
```

The database is SQLite and lives in a file. There's no server to install and no account to create.

## Getting set up

```bash
pnpm install
pnpm db:push
pnpm db:seed
pnpm dev
```

That gets you a populated studio at http://localhost:3000 with a couple of weeks of classes either side of today.

`db:push` creates `flexfit.db` and applies the schema. `db:seed` fills it with sample members, plans, classes and bookings.

## Signing in

| Role    | Email                  | Password   |
| ------- | ---------------------- | ---------- |
| Admin   | admin@flexfit.test     | admin123   |
| Trainer | arjun@flexfit.test     | trainer123 |
| Member  | rahul.k@example.com    | member123  |

Every seeded member uses `member123`. The other member emails are in `src/db/seed.ts`.

## Commands

| Command         | What it does                                      |
| --------------- | ------------------------------------------------- |
| `pnpm dev`      | Development server on port 3000                    |
| `pnpm build`    | Production build                                   |
| `pnpm test`     | The characterization suite, 163 tests, about 8 seconds |
| `pnpm db:push`  | Apply the schema in `src/db/schema/`               |
| `pnpm db:seed`  | Wipe the data and reseed                           |
| `pnpm db:reset` | Delete the database file, then push and seed again |

`db:reset` is the one you want when the data gets into a state you don't like. It's destructive and it's meant to be.

## The tests

```bash
pnpm test
```

163 tests describing what the app **does**, not what it should do. 160 were
written against the original code before any of it moved, and they are the
reason the restructure can claim to preserve behaviour everywhere it wasn't
deliberately changed. The other 3 were added alongside the fixes to findings
6, 9 and 7 — see [documents/findings.md](documents/findings.md).

They need no database and no running server. Each test builds a fresh in-memory
SQLite from the generated migration SQL and calls procedures through
`appRouter.createCaller`, so they are order-independent and run in parallel.

Where today's behaviour looks wrong, the test still pins it and carries a
`NOTE finding N` comment pointing at the matching entry in
[documents/findings.md](documents/findings.md). A test named
*"NOTE finding 11: classUtilisation reports the same wrong count for every
class"* is not a mistake — it is a bug held in place deliberately, so that
fixing it later is a visible, reviewable change rather than an accident.

## Two things that will waste your time

Don't run `pnpm build` while `pnpm dev` is running. The build writes over the directory the dev server is using and the app starts throwing `MODULE_NOT_FOUND`. Nothing is actually broken. Stop the dev server, delete `.next`, start it again. If you want to typecheck while the server is up, use `npx tsc --noEmit` instead.

If you're changing anything in `src/db/schema/`, run `pnpm db:push` afterwards or the app and the database will disagree with each other in confusing ways.

## Layout

```
src/
  app/          routes and pages
  components/   shared components
  db/
    schema/     tables, split by domain, re-exported from index
    index.ts    the client
    seed.ts
  lib/          formatting and password helpers
  server/
    trpc.ts     context and the procedure builders
    routers/    transport: validate input, call a module, shape the output
    modules/    the studio's rules — booking, reschedule, scheduling
    shared/     policy constants, time helpers, the Db type
drizzle/        generated migration SQL, also used to build the test database
tests/          characterization suite
documents/      architecture.md and findings.md
```

The rule that explains the split: a router may not contain a rule, and a module
may not know it is being called over HTTP. [architecture.md](documents/architecture.md)
covers the reasoning.
