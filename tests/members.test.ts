/**
 * Characterization tests for auth, member records, plans and payments.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import {
  freshDb,
  callerFor,
  makeUser,
  makeAdmin,
  makeTrainer,
  makePlan,
  makeMembership,
  makeClass,
  seedBooking,
  daysFromNow,
  schema,
  type TestDb,
} from "./helpers/harness";

let db: TestDb;

beforeEach(async () => {
  db = await freshDb();
});

async function expectTrpcError(p: Promise<unknown>, code: TRPCError["code"]) {
  await expect(p).rejects.toMatchObject({ code });
}

describe("auth", () => {
  it("me returns null when signed out and the user when signed in", async () => {
    expect(await callerFor(db, null).auth.me()).toBeNull();
    const user = await makeUser(db);
    expect((await callerFor(db, user).auth.me())!.id).toBe(user.id);
  });

  it("logs in with the right password and opens a session", async () => {
    const user = await makeUser(db, { email: "case@test.local" });

    const result = await callerFor(db, null).auth.login({
      email: "case@test.local",
      password: "password123",
    });

    expect(result).toEqual({ id: user.id, name: user.name, role: "member" });
    const sessions = await db.select().from(schema.sessions);
    expect(sessions).toHaveLength(1);
    expect(new Date(sessions[0].expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("lower-cases the email, so a capitalised address still signs in", async () => {
    await makeUser(db, { email: "case@test.local" });
    await expect(
      callerFor(db, null).auth.login({ email: "CASE@TEST.LOCAL", password: "password123" }),
    ).resolves.toMatchObject({ role: "member" });
  });

  it("NOTE finding 16: the trim() on the email is unreachable, zod rejects spaces first", async () => {
    await makeUser(db, { email: "case@test.local" });

    // login() calls input.email.toLowerCase().trim(), but z.string().email()
    // has already refused anything with surrounding whitespace, so a user who
    // pastes their address with a trailing space gets a validation error
    // rather than the friendly "Email or password is incorrect."
    await expectTrpcError(
      callerFor(db, null).auth.login({ email: " case@test.local ", password: "password123" }),
      "BAD_REQUEST",
    );
  });

  it("rejects a wrong password and an unknown email with the same message", async () => {
    await makeUser(db, { email: "known@test.local" });
    await expectTrpcError(
      callerFor(db, null).auth.login({ email: "known@test.local", password: "wrong" }),
      "UNAUTHORIZED",
    );
    await expectTrpcError(
      callerFor(db, null).auth.login({ email: "nobody@test.local", password: "password123" }),
      "UNAUTHORIZED",
    );
  });

  it("refuses a deactivated account after the password check", async () => {
    await makeUser(db, { email: "off@test.local", active: false });
    await expectTrpcError(
      callerFor(db, null).auth.login({ email: "off@test.local", password: "password123" }),
      "FORBIDDEN",
    );
  });

  it("registers a member and stores a salted hash rather than the password", async () => {
    const result = await callerFor(db, null).auth.register({
      email: "New@Test.Local",
      password: "hunter22",
      name: "New Person",
    });

    expect(result.name).toBe("New Person");
    const row = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, result.id))
      .get();
    expect(row!.email).toBe("new@test.local");
    expect(row!.role).toBe("member");
    expect(row!.passwordHash).not.toContain("hunter22");
    expect(row!.passwordHash).toMatch(/^[0-9a-f]{32}:[0-9a-f]{64}$/);
  });

  it("refuses a duplicate email and a short password", async () => {
    await makeUser(db, { email: "taken@test.local" });
    await expectTrpcError(
      callerFor(db, null).auth.register({
        email: "taken@test.local",
        password: "longenough",
        name: "x",
      }),
      "CONFLICT",
    );
    await expect(
      callerFor(db, null).auth.register({ email: "s@test.local", password: "abc", name: "x" }),
    ).rejects.toThrow();
  });

  it("logout deletes the session row for the current token", async () => {
    const user = await makeUser(db);
    await db
      .insert(schema.sessions)
      .values({ userId: user.id, token: `test-token-${user.id}`, expiresAt: daysFromNow(30) });

    await callerFor(db, user).auth.logout();

    expect(await db.select().from(schema.sessions)).toEqual([]);
  });
});

describe("members.profile", () => {
  it("returns the membership with the latest end date plus an attended count", async () => {
    const user = await makeUser(db);
    await makeMembership(db, user.id, { endDate: daysFromNow(5) });
    const current = await makeMembership(db, user.id, { endDate: daysFromNow(90) });

    const cls = await makeClass(db);
    await seedBooking(db, { classId: cls.id, userId: user.id, status: "attended" });
    await seedBooking(db, { classId: cls.id, userId: user.id, status: "booked" });

    const profile = await callerFor(db, user).members.profile();

    expect(profile.membership!.id).toBe(current.id);
    expect(profile.classesAttended).toBe(1);
  });

  it("NOTE finding 12: profile shows an expired membership without saying it lapsed", async () => {
    const user = await makeUser(db);
    await makeMembership(db, user.id, { endDate: daysFromNow(-10), status: "active" });

    const profile = await callerFor(db, user).members.profile();

    // bookings.book would refuse this member, but the dashboard still prints
    // the plan and its credits as though it were usable.
    expect(profile.membership).not.toBeNull();
    expect(profile.membership!.status).toBe("active");
  });

  it("returns a null membership for a member who never subscribed", async () => {
    const user = await makeUser(db);
    expect((await callerFor(db, user).members.profile()).membership).toBeNull();
  });
});

describe("members.search and byId", () => {
  it("search matches on name or email and is staff only", async () => {
    const admin = await makeAdmin(db);
    await makeUser(db, { name: "Rahul Khanna", email: "rahul@x.test" });
    await makeUser(db, { name: "Sana Iyer", email: "sana@y.test" });

    expect((await callerFor(db, admin).members.search({ q: "rahul" })).length).toBe(1);
    expect((await callerFor(db, admin).members.search({ q: "y.test" })).length).toBe(1);

    const member = await makeUser(db);
    await expectTrpcError(callerFor(db, member).members.search({ q: "a" }), "FORBIDDEN");
  });

  it("search with an empty term returns everyone, including staff", async () => {
    const admin = await makeAdmin(db);
    await makeUser(db);
    await makeTrainer(db);

    expect((await callerFor(db, admin).members.search({ q: "" })).length).toBe(3);
  });

  it("byId returns the member and membership history without the password hash", async () => {
    const admin = await makeAdmin(db);
    const user = await makeUser(db);
    await makeMembership(db, user.id);

    const result = await callerFor(db, admin).members.byId({ id: user.id });

    expect(result.memberships).toHaveLength(1);
    expect(result).not.toHaveProperty("passwordHash");
  });
});

describe("members.lookupByEmailOrPhone", () => {
  it("finds a member by a partial email or phone", async () => {
    const admin = await makeAdmin(db);
    const user = await makeUser(db, { email: "kiosk@test.local", phone: "+91 91234 56789" });

    expect((await callerFor(db, admin).members.lookupByEmailOrPhone({ query: "kiosk@" })).id)
      .toBe(user.id);
    expect((await callerFor(db, admin).members.lookupByEmailOrPhone({ query: "91234" })).id)
      .toBe(user.id);
  });

  it("NOTE finding 13: returns not found when the first row happens to be staff", async () => {
    const admin = await makeAdmin(db, { email: "staff@shared.test" });
    const member = await makeUser(db, { email: "member@shared.test" });

    // Both rows match "shared.test". The query takes the first row, sees a
    // non-member and gives up rather than looking for the member behind it.
    await expectTrpcError(
      callerFor(db, admin).members.lookupByEmailOrPhone({ query: "shared.test" }),
      "NOT_FOUND",
    );
    void member;
  });

  it("NOTE finding 13: an empty query is a wildcard that returns the first user row", async () => {
    // Insert the member first so it holds the lowest id.
    const first = await makeUser(db);
    const admin = await makeAdmin(db);
    await makeUser(db);

    // The kiosk guards this with a length check in the UI, but the procedure
    // itself happily treats "" as "%%" and matches everyone.
    expect((await callerFor(db, admin).members.lookupByEmailOrPhone({ query: "" })).id)
      .toBe(first.id);
  });
});

describe("members.setActive and setRole", () => {
  it("are admin only", async () => {
    const trainer = await makeTrainer(db);
    const user = await makeUser(db);
    await expectTrpcError(
      callerFor(db, trainer).members.setActive({ id: user.id, active: false }),
      "FORBIDDEN",
    );
    await expectTrpcError(
      callerFor(db, trainer).members.setRole({ id: user.id, role: "admin" }),
      "FORBIDDEN",
    );
  });

  it("let an admin deactivate and promote a member", async () => {
    const admin = await makeAdmin(db);
    const user = await makeUser(db);

    expect((await callerFor(db, admin).members.setActive({ id: user.id, active: false })).active)
      .toBe(false);
    expect((await callerFor(db, admin).members.setRole({ id: user.id, role: "trainer" })).role)
      .toBe("trainer");
  });
});

describe("plans", () => {
  it("list hides inactive plans unless asked", async () => {
    await makePlan(db, { name: "Live" });
    await makePlan(db, { name: "Retired", active: false });

    expect((await callerFor(db, null).plans.list()).map((p) => p.name)).toEqual(["Live"]);
    expect(await callerFor(db, null).plans.list({ includeInactive: true })).toHaveLength(2);
  });

  it("subscribe creates a membership dated from today and a matching paid payment", async () => {
    const user = await makeUser(db);
    const plan = await makePlan(db, { durationDays: 30, classCredits: 12, priceCents: 750_000 });

    const membership = await callerFor(db, user).plans.subscribe({ planId: plan.id });

    expect(membership).toMatchObject({
      userId: user.id,
      planId: plan.id,
      creditsRemaining: 12,
      status: "active",
      startDate: daysFromNow(0),
      endDate: daysFromNow(30),
    });

    const [payment] = await db.select().from(schema.payments);
    expect(payment).toMatchObject({
      userId: user.id,
      membershipId: membership.id,
      amountCents: 750_000,
      method: "card",
      status: "paid",
    });
    expect(payment.reference).toMatch(/^PAY-\d+$/);
  });

  it("NOTE finding 14: subscribing again stacks a second membership instead of replacing", async () => {
    const user = await makeUser(db);
    const plan = await makePlan(db, { classCredits: 5 });

    await callerFor(db, user).plans.subscribe({ planId: plan.id });
    await callerFor(db, user).plans.subscribe({ planId: plan.id });

    // Two active memberships now exist. Booking silently uses whichever has the
    // furthest end date, so the credits on the other are stranded.
    const rows = await db
      .select()
      .from(schema.memberships)
      .where(eq(schema.memberships.userId, user.id));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "active")).toBe(true);
  });

  it("refuses an unknown or retired plan", async () => {
    const user = await makeUser(db);
    await expectTrpcError(callerFor(db, user).plans.subscribe({ planId: 9999 }), "NOT_FOUND");
    const retired = await makePlan(db, { active: false });
    await expectTrpcError(
      callerFor(db, user).plans.subscribe({ planId: retired.id }),
      "BAD_REQUEST",
    );
  });

  it("create and setActive are admin only", async () => {
    const user = await makeUser(db);
    await expectTrpcError(
      callerFor(db, user).plans.create({ name: "x", priceCents: 1, durationDays: 1 }),
      "FORBIDDEN",
    );
  });
});

describe("payments", () => {
  it("mine returns the member's own payments, newest first, with the plan name", async () => {
    const user = await makeUser(db);
    const plan = await makePlan(db, { name: "Gold" });
    await callerFor(db, user).plans.subscribe({ planId: plan.id });

    const rows = await callerFor(db, user).payments.mine();
    expect(rows).toHaveLength(1);
    expect(rows[0].planName).toBe("Gold");

    const stranger = await makeUser(db);
    expect(await callerFor(db, stranger).payments.mine()).toEqual([]);
  });

  it("refund flips the payment and cancels the linked membership", async () => {
    const admin = await makeAdmin(db);
    const user = await makeUser(db);
    const plan = await makePlan(db, { classCredits: 8 });
    const membership = await callerFor(db, user).plans.subscribe({ planId: plan.id });
    const [payment] = await db.select().from(schema.payments);

    const refunded = await callerFor(db, admin).payments.refund({ id: payment.id });

    expect(refunded.status).toBe("refunded");
    const after = await db
      .select()
      .from(schema.memberships)
      .where(eq(schema.memberships.id, membership.id))
      .get();
    expect(after!.status).toBe("cancelled");
  });

  it("NOTE finding 15: a refunded membership keeps its credits and its future bookings", async () => {
    const admin = await makeAdmin(db);
    const user = await makeUser(db);
    const plan = await makePlan(db, { classCredits: 8 });
    const membership = await callerFor(db, user).plans.subscribe({ planId: plan.id });
    const cls = await makeClass(db);
    const booking = await callerFor(db, user).bookings.book({ classId: cls.id });
    const [payment] = await db.select().from(schema.payments);

    await callerFor(db, admin).payments.refund({ id: payment.id });

    const after = await db
      .select()
      .from(schema.memberships)
      .where(eq(schema.memberships.id, membership.id))
      .get();
    expect(after!.status).toBe("cancelled");
    expect(after!.creditsRemaining).toBe(7);

    const bookingAfter = await db
      .select()
      .from(schema.bookings)
      .where(eq(schema.bookings.id, booking.id))
      .get();
    expect(bookingAfter!.status).toBe("booked");
  });

  it("only paid payments can be refunded, and refunded ones cannot be marked paid", async () => {
    const admin = await makeAdmin(db);
    const user = await makeUser(db);
    const pending = await db
      .insert(schema.payments)
      .values({ userId: user.id, amountCents: 100, method: "cash", status: "pending" })
      .returning()
      .get();

    await expectTrpcError(callerFor(db, admin).payments.refund({ id: pending.id }), "BAD_REQUEST");

    await callerFor(db, admin).payments.markPaid({ id: pending.id });
    await callerFor(db, admin).payments.refund({ id: pending.id });
    await expectTrpcError(
      callerFor(db, admin).payments.markPaid({ id: pending.id }),
      "BAD_REQUEST",
    );
  });

  it("all is admin only", async () => {
    const trainer = await makeTrainer(db);
    await expectTrpcError(callerFor(db, trainer).payments.all(), "FORBIDDEN");
  });
});
