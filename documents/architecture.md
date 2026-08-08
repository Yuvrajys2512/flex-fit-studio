# Architecture

Why the code is arranged the way it is, and what I would do next.

## The problem I was actually solving

The brief says restructure into "a codebase someone would actually want to work
in", and preserve behaviour exactly. Those two pull against each other, so the
first question was how to know when I had broken something.

Nothing in the repo answered that. There was a `test` script in `package.json`,
vitest in the devDependencies, and no tests. So the first commit is 160
characterization tests written against the original code, before anything moved.
They describe what the app **does**, including the parts that are wrong. Every
commit after that keeps them passing.

That ordering is the whole approach. Without it, "behaviour is preserved" is a
claim. With it, it is something the reader can run.

## What was wrong with the original shape

Not the folder names. `app/ components/ db/ lib/ server/` is a reasonable Next.js
layout and I kept it. The problem was one layer down.

**`server/routers/` was doing two jobs.** Each file mixed transport concerns —
input schemas, error codes, the shape a particular screen wants — with the
studio's actual rules about credits, capacity and cancellation windows. A rule
you cannot find is a rule you duplicate, so the rules were duplicated.

Three symptoms, all of them the same cause:

1. `corporate-bookings.ts` was `bookings.ts` copied and pointed at a different
   pair of tables. ~90% identical. The two copies had since drifted into
   **opposite** bugs on the same code path (findings 1 and 3): one charges a
   member who cannot pay, the other lets a company off entirely.
2. `reschedules.ts` applied the same ten rules twice, once throwing and once
   returning `{ valid, reason }`, kept in step by hand.
3. `hoursUntil` was defined three times. `activeMembershipFor` twice. The three
   cancellation windows sat in three files, so nobody could see that they
   disagree.

None of that is visible from the folder tree, which is why the folder tree was
not the thing to fix first.

## The shape now

```
src/
  app/                      Next.js routes. Unchanged.
  components/               Shared components. Unchanged.
  db/
    schema/                 six files by domain, re-exported from index
    index.ts                the client
    seed.ts
  lib/                      formatting and password helpers
  server/
    trpc.ts                 context and the four procedure builders
    routers/                TRANSPORT: validate input, call a module, shape output
    modules/                THE RULES: what the studio actually does
      booking/
        rules.ts            class validation, seat counting
        ledger.ts           who pays — membership vs company pool
        service.ts          book and cancel, once
        index.ts            the two flows, configured
      reschedule/rules.ts   the ten rules, evaluated once, returned as data
      scheduling/           availability arithmetic, no database
    shared/
      policy.ts             every studio constant, together
      time.ts               hoursUntil and friends, once
      db.ts                 the Db type, named
```

The one rule that explains all of it: **a router may not contain a rule, and a
module may not know it is being called over HTTP.**

Routers now read as a list of what the API offers. Modules read as a description
of how the gym works. When a reviewer asks "when does a member get their credits
back", the answer is in one file with a name that says so.

| File | Before | After |
|---|---|---|
| `routers/bookings.ts` | 360 | 178 |
| `routers/corporate-bookings.ts` | 289 | 100 |
| `routers/reschedules.ts` | 339 | 107 |
| `routers/trainers.ts` | 187 | 135 |

The removed lines did not vanish; roughly 650 of them became ~630 lines of
module code that is written once instead of twice, and carries the comments
explaining the parts that used to be silent.

## The three decisions worth defending

### 1. One booking engine, two ledgers

`bookings` and `corporate_bookings` differ in exactly two ways: which table
holds the seat, and who pays for it. Everything else — the class checks, the
duplicate check, the capacity count, the waitlist promotion, the cancellation
window comparison — was identical.

So `createSeatFlow(table, ledger)` takes those two things and returns `book` and
`cancel`. `index.ts` is two lines:

```ts
export const personalSeats  = createSeatFlow(bookings, membershipLedger);
export const corporateSeats = createSeatFlow(corporateBookings, companyPoolLedger);
```

**The tempting mistake here was to unify the ledgers too.** They look like they
should be the same. They are not: the personal one charges a promoted member who
cannot afford the class and clamps their balance to zero; the corporate one
checks the balance first and, finding it short, grants the seat for free. Both
are wrong, in opposite directions, and "fixing" them while claiming to preserve
behaviour would have been dishonest.

So the two ledgers stay as two implementations of one interface, in one file,
adjacent, with each divergence commented and cross-referenced to
`findings.md`. The duplication that mattered — control flow — is gone. The
difference that mattered — policy — is now impossible to miss.

I think this is the right call even ignoring the brief. The point of removing
duplication is to make disagreement visible, not to force agreement.

### 2. Rules as data, not as control flow

`reschedule` threw; `validateReschedule` returned a reason. Same ten checks in
the same order, written twice.

`evaluateReschedule` now returns a discriminated union. The mutation converts a
failure into a throw; the query reports it. The rule order is load-bearing — a
booking that is both unowned and inactive must report the ownership message, as
it always did — and it is now expressed once, so it cannot drift.

This is the change I would point at if asked which one paid for itself fastest.

### 3. `SeatTable` is typed as one table, with one cast

The honest version of a decision I went back and forth on.

`bookings` and `corporate_bookings` declare identical columns for everything the
seat flow touches. Writing a union type produced casts at nine call sites and
broke Drizzle's inference at every one. Typing against `typeof bookings` and
casting once, at the single construction site, keeps full inference inside the
module and puts the compromise in one visible place with a comment explaining
why it is sound.

One documented cast beats nine undocumented ones. If the two tables ever
diverge in a column the flow reads, that cast is where it will break, which is
where you would want it to break.

## What I did not do

**I did not restructure `src/app` or `src/components`.** They are not clean —
`kiosk/page.tsx` types a member as `any`, colours are inline hex strings in half
a dozen files, and `dashboard/page.tsx` holds modal state it could delegate. But
the pages are thin over tRPC and none of them contain studio rules. With a fixed
amount of time, server-side duplication that had already produced two
contradictory money bugs was worth more than tidying JSX. I would do the
component layer next; see below.

**I did not fix the 25 findings.** Behaviour preservation was the constraint,
and the tests prove I held to it. The single exception is finding 17, where four
copies of a role check became one middleware enforcing the identical rule.

**I did not add transactions.** Every booking mutation is a sequence of
unprotected statements and two members can take the same last seat (finding 24).
Wrapping them changes behaviour under concurrency and deserves its own commit
with load testing behind it, not a quiet inclusion in a refactor.

## What I would do next, in order

1. **Fix finding 6** — rescheduling out of a class does not promote the
   waitlist. One clear right answer, and the promotion logic is now a single
   function in `service.ts`, so it is about four lines.
2. **Fix finding 9** — a studio-cancelled class refunds nobody and notifies
   nobody. Most likely to generate a complaint.
3. **Fix finding 11** — `admin.classUtilisation` returns a number unrelated to
   the data. A test is written and ready to be inverted.
4. **Close finding 7** — the public class roster exposes member emails.
5. **Unify seat counting (finding 2)** — one count across both tables. This is
   why `countConfirmedSeats` is its own function taking a table: the fix is
   contained to it and its callers.
6. **Then the component layer** — extract the repeated panel/badge/button
   patterns, move the inline hex to the CSS variables that already exist in
   `globals.css`, and give `kiosk/page.tsx` a real type.

## Running it

Unchanged from the original README, plus:

```bash
pnpm test          # 160 characterization tests, ~8s
npx tsc --noEmit   # typecheck without stopping the dev server
```

The tests need no database and no server: each one builds a fresh in-memory
SQLite from the generated migration SQL, so they are order-independent and
safe to run in parallel.
