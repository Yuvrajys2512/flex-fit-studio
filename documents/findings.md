# Findings

Things that look wrong in FlexFit Studio as it stands. Everything here was
found by reading the code and then confirmed with a test, so each entry names
the test that demonstrates it. Run `pnpm test` and they all pass: the suite
describes what the app **does**, not what it should do.

The default decision is **document, do not fix**. The brief asks for behaviour
to be preserved exactly, and a refactor that quietly changes twenty five
behaviours is not a refactor. Anything I did change is called out explicitly at
the bottom, in its own commit, with the characterization test updated in the
same commit so the change is visible in the diff rather than buried. Four of
the twenty five ended up fixed, once the restructure had 160 tests protecting
everything else — see "What I changed" at the bottom for which, and why those
four specifically.

Severity is my own judgement about what a studio manager would care about:

- **High** — someone loses money, loses a seat they paid for, or sees data they
  should not.
- **Medium** — a number on a screen is wrong, or a rule is enforced in one place
  and not another.
- **Low** — dead code, naming, or a sharp edge nobody has hit yet.

| # | Area | Severity | Status | Summary |
|---|------|----------|--------|---------|
| 1 | Waitlist | High | Left alone | Promotion charges a member who cannot afford it, clamping to zero |
| 2 | Capacity | High | Left alone | Capacity is counted per table, so a class can be filled twice over |
| 3 | Corporate credits | High | Left alone | A promoted corporate member with an empty pool gets the class free |
| 4 | Check-ins | Medium | Left alone | Corporate check-ins are unlinked and invisible to class counts |
| 5 | Rosters | Medium | Left alone | Two separate rosters, neither shows who is actually in the room |
| 6 | Waitlist | High | **Fixed** | Rescheduling out of a class leaves the seat empty, nobody is promoted |
| 7 | Privacy | High | **Fixed** | The class roster, including member emails, is public |
| 8 | Capacity | Medium | Left alone | Capacity can be lowered below the number already booked |
| 9 | Class cancellation | High | **Fixed** | Cancelling a class refunds nobody and notifies nobody |
| 10 | Class cancellation | Medium | Left alone | Cancellation ignores waitlisted and corporate bookings |
| 11 | Reporting | High | Left alone | `classUtilisation` reports the same wrong figure for every class |
| 12 | Membership | Medium | Left alone | An expired membership is still displayed as active |
| 13 | Kiosk lookup | Medium | Left alone | First row wins, and an empty query is a wildcard |
| 14 | Membership | Medium | Left alone | Subscribing twice stacks memberships and strands credits |
| 15 | Refunds | High | Left alone | A refunded membership keeps its credits and its future bookings |
| 16 | Auth | Low | Left alone | The `trim()` on the login email is unreachable |
| 17 | Roles | Medium | **Partially fixed** | The trainer routes lock admins out |
| 18 | Scheduling | Medium | Left alone | Availability is compared in UTC, not the studio's timezone |
| 19 | Scheduling | Medium | Left alone | `checkAvailability` exists but nothing calls it |
| 20 | Notifications | Low | Left alone | `broadcast` reaches deactivated members |
| 21 | Notifications | Medium | **Partially fixed** | Three of the four notification types are never written |
| 22 | Corporate | Medium | Left alone | A member can be linked to several companies at once |
| 23 | Corporate | Medium | Left alone | Deactivating a company strands its members' bookings |
| 24 | Concurrency | High | Left alone | No booking operation is transactional |
| 25 | Policy | Medium | Left alone | Three different cancellation windows, no stated reason |

---

## 1. Waitlist promotion charges a member who cannot afford it

**Severity: High** · `bookings.ts` `cancel` · Test: *NOTE finding 1: promotion
charges the waitlisted member even with too few credits, clamping at zero*

When a confirmed booking is cancelled, the longest waiting member is promoted
and charged there and then:

```ts
creditsRemaining: Math.max(0, ms.creditsRemaining - row.cls.creditCost)
```

`Math.max(0, ...)` hides the problem it is papering over. A member sitting on 1
credit who is promoted into a 5 credit class gets the seat, has their balance
set to 0, and the studio is four credits short. The booking records
`creditsUsed: 5`, so if they later cancel in good time they are refunded 5
credits they never paid, turning a shortfall into free credit.

`book` refuses this exact case up front with "Not enough class credits
remaining." Promotion does not re-run that check.

**Left alone.** The correct behaviour is a policy question — skip that member
and promote the next one, promote them anyway and let the balance go negative,
or hold the seat and notify them to top up. That is the studio's call, not mine.

---

## 2. Capacity is counted per table, so a class can be filled twice over

**Severity: High** · `bookings.ts`, `corporate-bookings.ts`, `classes.ts` ·
Tests: *NOTE finding 2* (three of them)

`bookings.book` counts confirmed rows in `bookings`. `corporateBookings.book`
counts confirmed rows in `corporate_bookings`. Neither knows the other exists,
and both compare their own count against the same `classes.capacity`.

A class with capacity 1 accepts one personal booking **and** one corporate
booking, both confirmed. With capacity 20 you can put 40 people in a room built
for 20. The same member can hold a personal seat and a corporate seat in the
same class, and be counted twice.

`classes.list` has the same blind spot from the other direction: `spotsLeft` and
`full` are computed from `bookings` only, so the public schedule advertises free
places that corporate members have already taken.

This is the single biggest structural problem in the codebase, and it is a
direct consequence of the copy-paste: `corporate-bookings.ts` was cloned from
`bookings.ts` and given a different pair of tables, without anyone deciding what
"this class is full" means across both.

**Left alone.** Fixing it properly means one seat count over both tables, which
changes who gets waitlisted and who gets confirmed at the boundary. That is a
behaviour change with real consequences for anyone currently holding a seat.
The restructure does make it much cheaper to fix later: see
`architecture.md`, where both paths now go through one seat-counting function
with the two tables as its only difference.

---

## 3. A promoted corporate member with an empty pool gets the class free

**Severity: High** · `corporate-bookings.ts` `cancel` · Test: *NOTE finding 3*

The mirror of finding 1, drifted in the opposite direction:

```ts
if (company && company.creditPoolBalance >= row.cls.creditCost) {
  // debit the pool
}
```

The promotion itself happens unconditionally above this check. So when the pool
cannot cover the class, the member is still confirmed into the seat and the
booking still records `creditsUsed: 10`, but the debit is skipped. The company
gets a free class, and the booking now claims credits that were never spent.
Cancel it in good time and the pool is *credited* 10 for a class nobody paid
for.

Two copies of the same routine, two different bugs, opposite signs. Neither
author saw the other.

**Left alone**, same reasoning as finding 1.

---

## 4. Corporate check-ins are unlinked and invisible

**Severity: Medium** · `corporate-bookings.ts` `markAttended` · Test:
*NOTE finding 4*

```ts
await ctx.db.insert(checkins).values({
  userId: booking.userId,
  bookingId: null,
});
```

Two problems in three lines. `bookingId` is hard-coded to `null`, where the
personal path passes the real booking id. And `input.source` is accepted by the
schema, documented in the input type, and then silently dropped, so every
corporate check-in records `front_desk` even when it came from the kiosk.

`bookings.checkinCountFor` joins `checkins` to `bookings`, so corporate
check-ins never appear in a class's check-in count. `admin.stats.totalCheckins`
counts the raw table and does include them, so the two numbers disagree.

The `null` is not arbitrary: `checkins.bookingId` points at `bookings.id`, and a
corporate booking id would be a foreign key into the wrong table. The schema
cannot express "one of two booking tables", which is the real cause.

**Left alone.** Fixing it means a schema change, which is in scope per the brief
but not something to bundle into a refactor commit.

---

## 5. Two rosters, neither shows the room

**Severity: Medium** · `bookings.rosterFor`, `corporateBookings.rosterFor` ·
Test: *NOTE finding 5*

A trainer standing in front of a class has to open two screens and add them up
in their head, and nothing tells them the second screen exists. Follows directly
from finding 2.

**Left alone.**

---

## 6. Rescheduling out of a class does not promote the waitlist

**Severity: High** · `reschedules.ts` · Test: *NOTE finding 6*

`bookings.cancel` promotes the longest waiting member when a confirmed seat is
freed. `reschedules.reschedule` frees a confirmed seat in exactly the same way —
it sets the original booking to `cancelled` — and promotes nobody.

So a full class with people waiting stays "full" forever while a seat sits
empty, and the waitlist never moves. The member who rescheduled gets their new
class; the member who was next in line is never told the seat opened.

This is the clearest example of what happens when the same operation is written
twice in two files: `reschedule` is a cancel plus a book, but it reimplements
both halves and forgets a piece of each.

**Fixed.** This was the finding with a single obvious right answer, and the
restructure had already put the promotion logic in one place
(`createSeatFlow`'s `promoteNextInLine`) to make exactly this fix small.
`reschedules.ts` now calls it — `personalSeats.promoteNextInLine(ctx.db,
originalClass)` — whenever the booking being moved away from was `booked`
(not `waitlisted`), the same condition `cancel` already used. The test that
pinned the bug (`NOTE finding 6`) now asserts the fix; a new test pins the
companion case — moving a *waitlisted* booking frees no seat, so it correctly
promotes nobody.

---

## 7. The class roster is public

**Severity: High** · `classes.byId` · Test: *NOTE finding 7*

`classes.byId` is a `publicProcedure` and returns a roster containing every
booked member's **name and email address**. No sign-in required. Anyone who can
reach the app can enumerate class ids and harvest the membership list.

`bookings.rosterFor` returns nearly the same data and is correctly a
`staffProcedure`. The public one appears to have grown a roster later without
anyone revisiting its access level.

**Fixed.** No page in `src/app` or `src/components` calls `classes.byId` — it
is reachable only by calling the API directly, so restricting it had no known
caller to break. It now returns the roster only when the caller is staff
(`ctx.user?.role === "admin" || "trainer"`), the same gate `bookings.rosterFor`
already used. Anyone else — signed out, or a signed-in member — gets `roster:
[]`; the class itself (name, room, time) stays public, since that is the
schedule people browse before signing in. Three tests cover it: staff sees
names and emails, an anonymous caller sees an empty roster, and a signed-in
member who is not staff also sees an empty roster (the case a role check on
`ctx.user` alone would have missed).

---

## 8. Capacity can be lowered below the number already booked

**Severity: Medium** · `classes.update` · Test: *NOTE finding 8*

`capacity` is validated as a positive integer and nothing else. Setting a class
with three confirmed members to capacity 1 succeeds silently. Nobody is bumped,
nobody is told, and the class is now over capacity with `spotsLeft` reporting 0.

**Left alone.**

---

## 9. Cancelling a class refunds nobody and notifies nobody

**Severity: High** · `classes.cancel` · Tests: *NOTE finding 9* (two)

The gym cancels a class. Every confirmed booking is marked `cancelled`. The
credits those members spent are **not** returned. A member who paid 3 credits
for a class the studio then cancelled is simply out 3 credits, with no way to
get them back through the app.

`bookings.cancel` refunds when a member cancels more than 12 hours out. A studio
cancellation, which is entirely the studio's fault, refunds nothing at all.

Nobody is notified either, although `notifications.type` includes
`class_cancelled` for exactly this purpose. Members find out by turning up.

**Fixed, within the scope `classes.cancel` already touched.** For every
booking this procedure was already marking `cancelled` — confirmed, personal
bookings — it now also calls `membershipLedger.refund` (the same refund path
`bookings.cancel` uses) and writes a `class_cancelled` notification naming the
class. Deliberately **not** widened to also cover waitlisted or corporate
bookings — that is finding 10, a separate question about which bookings this
procedure touches at all, not what happens to the ones it already touches.
Fixing 9 without also fixing 10 leaves a smaller, still-documented gap rather
than a silently expanded one.

---

## 10. Class cancellation ignores waitlisted and corporate bookings

**Severity: Medium** · `classes.cancel` · Test: *NOTE finding 10*

```ts
.where(and(eq(bookings.classId, input.id), eq(bookings.status, "booked")))
```

`booked` only. Waitlisted members keep an active booking on a cancelled class
and still show it on their waitlist page with a queue position. Corporate
bookings are not touched at all: they stay confirmed, and their credits stay
spent.

**Left alone**, including after fixing finding 9. Refunding and notifying the
bookings this procedure already reaches was a contained, defensible fix;
deciding what a cancelled class should do to a waitlisted booking, or to a
corporate one paid from a company pool, is a bigger question — arguably the
same "one seat count over both tables" decision that finding 2 is left alone
for — and not one to fold in under time pressure.

---

## 11. `classUtilisation` reports the same wrong figure for every class

**Severity: High** · `admin.ts` · Test: *NOTE finding 11*

This one is worth reading carefully, because the code looks right.

```ts
booked: sql<number>`(
  select count(*) from ${bookings}
  where ${bookings.classId} = ${classes.id}
    and ${bookings.status} in ('booked','attended')
)`.as("booked"),
```

Drizzle renders a column reference inside a `sql` template **unqualified** when
the surrounding query has only one table in scope. `admin.classUtilisation`
selects `from(classes)` with no join, so this compiles to:

```sql
select "id", (
  select count(*) from "bookings"
  where "class_id" = "id" and "status" in ('booked','attended')
) as "booked"
from "classes" where "cancelled" = 0 limit 10
```

Inside the subquery, `"id"` resolves against the innermost table in scope, which
is `bookings`. The correlation the author intended — `bookings.class_id =
classes.id` — has silently become `bookings.class_id = bookings.id`.

The result is a constant. It counts bookings whose id happens to equal their own
`class_id`, which is a meaningless coincidence of insert order, and it returns
that same number for every row. On the seeded database the utilisation report is
not slightly off; it is unrelated to the data.

`classes.list` contains the identical subquery and is **correct**, purely
because it has a `leftJoin` to `users`. Two tables in scope, so Drizzle
qualifies the columns, so the correlation binds where it was meant to. The
difference between working and broken code here is a join that exists for an
unrelated reason.

I found this because a test asserting `booked === 2` returned 1, and the
arithmetic could not be explained by any reading of the source.

**Left alone in the refactor**, because the report currently shows one set of
numbers and would show a different set afterwards, which is a behaviour change.
It is the third one I would fix, and the fix is one word: `sql` templates in
this codebase should reference `classes.id` through an explicit alias, or the
count should be a `leftJoin` and `groupBy` like every other aggregate in
`admin.ts`. There is a test ready to be inverted the moment that is agreed.

---

## 12. An expired membership is displayed as active

**Severity: Medium** · `members.profile` · Test: *NOTE finding 12*

`profile` returns the membership with the furthest `endDate` and does not check
whether that date has passed. The dashboard prints the plan name, the status
`active`, and a credit balance. Meanwhile `bookings.book` filters on
`endDate >= today` and refuses to let the member book anything.

So the screen says you have 8 credits and the button says you have no
membership. Both are reading the same row.

**Left alone.**

---

## 13. Kiosk lookup takes the first row and treats an empty query as a wildcard

**Severity: Medium** · `members.lookupByEmailOrPhone` · Tests:
*NOTE finding 13* (two)

```ts
const term = `%${input.query.trim()}%`;
// ... or(like(users.email, term), like(users.phone, term)) ... .get();
if (!user || user.role !== "member") throw NOT_FOUND;
```

`.get()` takes whichever row the database returns first, then checks its role.
If a staff account matches the search term ahead of a member, the front desk is
told "Member not found" even though the member exists — the filter is applied
after the pick instead of inside the query.

An empty string becomes `%%`, which matches every user. The kiosk page hides
this with `searchQuery.length > 2` in the UI, but the procedure is reachable
directly.

**Left alone.**

---

## 14. Subscribing twice stacks memberships and strands credits

**Severity: Medium** · `plans.subscribe` · Test: *NOTE finding 14*

`subscribe` inserts unconditionally. Nothing checks for an existing active
membership, expires the old one, or carries credits across. A member who buys a
second plan while the first is still running ends up with two rows, both
`active`, both with credits.

`bookings.book` picks the one with the furthest `endDate`. The credits on the
other are unreachable — paid for and unspendable. `members.profile` shows only
the same single row, so the member cannot see the credits they have lost.

**Left alone.**

---

## 15. A refunded membership keeps its credits and its bookings

**Severity: High** · `payments.refund` · Test: *NOTE finding 15*

Refunding a payment sets the membership to `cancelled` and stops there. It does
not zero the credits and does not cancel the member's future bookings.

`bookings.book` filters on `status = "active"`, so no new bookings can be made —
that part holds. But every class already booked against that membership stays
confirmed, and the member attends classes they have been refunded for. The seats
also stay occupied against capacity.

**Left alone.**

---

## 16. The `trim()` on the login email is unreachable

**Severity: Low** · `auth.login` · Test: *NOTE finding 16*

```ts
.input(z.object({ email: z.string().email(), ... }))
// ...
.where(eq(users.email, input.email.toLowerCase().trim()))
```

Zod's `.email()` rejects surrounding whitespace before the handler runs, so
`.trim()` can never remove anything. The visible effect is that a member who
pastes their address with a trailing space gets a raw Zod validation error
instead of the intended "Email or password is incorrect."

Harmless, but it is the kind of line that makes a reader think input is being
normalised when it is not. `z.string().trim().email()` would do what the code
appears to promise.

**Left alone**, noted for whoever touches auth next.

---

## 17. The trainer routes lock admins out

**Severity: Medium** · `trainers.ts` · Test: *NOTE finding 17*

Four procedures hand-roll `if (ctx.user.role !== "trainer") throw FORBIDDEN`
instead of using a middleware. Everywhere else in the app, `staffProcedure`
treats admin as a superset of trainer. Here an admin gets `FORBIDDEN` on
`upcomingClasses`, `availability`, `setAvailability` and `removeAvailability`,
so an admin cannot look at or fix a trainer's schedule.

`checkAvailability`, in the same file, allows trainer **or** admin — so the file
disagrees with itself about who staff are.

**Partially addressed.** The restructure replaces the four hand-rolled checks
with a `trainerProcedure` middleware that enforces the *same* rule, trainer
only. Behaviour is unchanged and the tests still pass; the rule now lives in one
place, so whoever decides admins should be allowed changes one line.

---

## 18. Availability is compared in UTC

**Severity: Medium** · `trainers.checkAvailability` · Test: *NOTE finding 18*

```ts
const dayOfWeek = classStart.getUTCDay();
const startTimeStr = String(classStart.getUTCHours()).padStart(2, "0") + ...
```

A trainer setting "09:00 to 17:00" means 09:00 to 17:00 in the studio's
timezone. The comparison reads the class start in UTC. The app formats every
other date with `en-IN`, so the studio is on IST, which is UTC+5:30.

A 09:30 IST class is 04:00 UTC and is rejected as outside a 09:00–17:00 window.
The half-hour offset also means `dayOfWeek` is wrong for anything before 05:30
local, so early classes are checked against the previous day's availability.

**Left alone.** The right fix needs a decision about where the studio timezone
lives, and the app has no concept of one yet — everything is stored as an ISO
string and rendered with `en-IN` at the edge.

---

## 19. `checkAvailability` exists but nothing calls it

**Severity: Medium** · `trainers.ts`, `classes.create` · Test: *NOTE finding 19*

Roughly 60 lines implementing window checks and overlap detection, reachable
over the API and called by no page and no other procedure. `classes.create`
accepts a `trainerId` and never consults it, so the same trainer can be booked
into two rooms at the same moment.

Given finding 18, wiring it up as-is would reject most legitimate classes. The
two need fixing together.

**Left alone.**

---

## 20. `broadcast` reaches deactivated members

**Severity: Low** · `notifications.broadcast` · Test: *NOTE finding 20*

```ts
const activeMembers = await ctx.db.select({ id: users.id })
  .from(users).where(eq(users.role, "member"));
```

Named `activeMembers`, filters on role only. Deactivated accounts get every
announcement, and the returned `count` overstates the reach.

**Left alone.** Renaming the variable to match what it does would be an
improvement on its own, but I would rather leave the misleading name visible
next to this entry than half-fix it.

---

## 21. Three of the four notification types are never written

**Severity: Medium** · whole app · Test: *NOTE finding 21*

`notifications.type` declares `waitlist_promotion`, `class_cancelled`,
`membership_expiring` and `announcement`. Originally, `broadcast` was the only
writer in the entire codebase and always sent `announcement` — none of the
other three ever fired.

**Partially addressed, as a side effect of fixing finding 9.** `classes.cancel`
now writes `class_cancelled`, so that one is live. `waitlist_promotion` and
`membership_expiring` are still never written — a member who gets promoted off
a waitlist, or whose membership is about to expire, still finds out by
noticing rather than being told. `admin.expiringMemberships` computes exactly
the list `membership_expiring` needs and only shows it to admins.

**Left alone otherwise.** This remainder is unimplemented product, not a bug,
but it is worth stating plainly because the schema still makes the app look
more complete than it is.

---

## 22. A member can be linked to several companies

**Severity: Medium** · `adminCompanies.linkMember` · Test: *NOTE finding 22*

The duplicate check is on the `(userId, companyId)` pair, so a second link to a
*different* company is allowed. `getCompanyForMember` then does `.get()` and
bills whichever row comes back first, with nothing defining which one should
win. Whose credit pool pays is decided by row order.

**Left alone.**

---

## 23. Deactivating a company strands its members' bookings

**Severity: Medium** · `adminCompanies.updateActive` · Test: *NOTE finding 23*

Deactivation flips one boolean. Existing corporate bookings stay confirmed and
keep their seats. But `corporateBookings.cancel` reads the booking's company
directly and still works, while `book` requires an active company — so members
can cancel but not rebook, and the seats stay held until the class runs.

**Left alone.**

---

## 24. No booking operation is transactional

**Severity: High** · `bookings.ts`, `corporate-bookings.ts`, `reschedules.ts` ·
Not covered by a test

Every mutation is a sequence of independent statements. `book` reads the
capacity count, then inserts, then updates the credit balance. `cancel` updates
the booking, then reads a membership, then updates it, then reads the waitlist,
then updates two more rows.

Two members booking the last seat at the same time both read `count = 9` against
capacity 10 and both get confirmed. Any failure part way through `cancel` leaves
the database inconsistent: a booking cancelled with no refund, or a member
promoted off the waitlist without being charged.

Drizzle exposes `db.transaction()` and none of these use it.

I have not written a test for this. Reproducing it reliably means forcing an
interleaving that SQLite's locking makes awkward to arrange, and a flaky test
asserting a race is worse than a written note. Flagging it as the thing most
likely to bite in production and not currently observable.

**Left alone.** Wrapping these in transactions is a behaviour change under
concurrency and wants its own commit with load testing behind it.

---

## 25. Three cancellation windows, no stated reason

**Severity: Medium** · across three files · Covered throughout the suite

| Constant | Value | File |
|---|---|---|
| `FREE_CANCELLATION_HOURS` | 12 | `bookings.ts` |
| `CORPORATE_FREE_CANCELLATION_HOURS` | 24 | `corporate-bookings.ts` |
| `FREE_RESCHEDULE_HOURS` | 4 | `reschedules.ts` |

A member cancelling at 20 hours gets their credit back. A corporate member
cancelling the same class at the same moment does not. Each constant carries a
comment explaining what it does, none explains why it differs, and the reschedule
comment ("more generous than cancellation policy") suggests the author knew about
one of the other two but not the third.

This may well be deliberate — corporate contracts often do have stricter terms.
But it is currently expressed as three numbers in three files that nobody can
compare, so it is not possible to tell policy from accident.

**Preserved exactly**, and all three now sit together in one policy module where
the divergence is visible. See `architecture.md`.

---

## What I changed

Four findings, out of twenty-five.

**Finding 17**, partially: the four duplicated role checks in `trainers.ts`
became a `trainerProcedure` middleware enforcing the identical rule. Admins are
still refused. This is a code change with no behaviour change, and the
characterization test that pins the admin refusal still passes untouched.

**Findings 6, 9 and 7**, after the restructure was in place and behaviour was
already protected by 160 passing tests. Each was a genuine behaviour change —
unlike finding 17 — made deliberately, one per commit, with its pinning test
flipped from `NOTE` to `FIXED` in the same commit and a companion test added
for the case next to it:

- **6** — rescheduling out of a class now promotes the waitlist, calling the
  same `promoteNextInLine` that `cancel` already used.
- **9** — cancelling a class now refunds the members it was already touching
  and notifies them, without expanding to the waitlisted/corporate bookings
  finding 10 covers.
- **7** — `classes.byId`'s roster (names and emails) is now staff-only, the
  same gate `bookings.rosterFor` already used; nothing in the app called the
  public version, so nothing broke.

Each was chosen because it had a single defensible right answer reachable in
the time available — not because it was the most severe. Finding 2 (capacity
counted per table) and finding 11 (the utilisation query) are more consequential
but each needs a real decision about who is affected by the change in count,
which is not something to make silently under a deadline.

Everything else in the restructure is behaviour-preserving by construction: the
160 characterization tests written before any code moved still pass, now
alongside 3 new tests added for the fixes above (163 total). Where a test was
edited rather than added, it was to assert the corrected behaviour in place of
the bug it used to pin — never to relax an assertion — and the diff shows this.

## What I would do first, given another week

1. **Finding 11** — the utilisation query. Admins are reading a number that means nothing.
2. **Finding 2** — unified seat counting. Largest, and the restructure was
   partly shaped to make it tractable.
3. **Finding 21, the rest of it** — `waitlist_promotion` and
   `membership_expiring` still never fire, now that `class_cancelled` does.
4. **Finding 24** — transactions around booking. Needs load testing behind it,
   which is exactly why it wasn't attempted alongside 6, 9 and 7.
