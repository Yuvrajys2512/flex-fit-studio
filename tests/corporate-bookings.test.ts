/**
 * Characterization tests for the corporate booking flow.
 *
 * This router is a near copy of bookings.ts against a different pair of tables.
 * The tests below pin both the shared behaviour and the places where the two
 * copies have drifted apart, which is the main thing to preserve during the
 * restructure.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import {
  freshDb,
  callerFor,
  makeUser,
  makeAdmin,
  makeMembership,
  makeClass,
  makeCompany,
  linkToCompany,
  seedBooking,
  seedCorporateBooking,
  readCompany,
  hoursFromNow,
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

async function readCorporateBooking(id: number) {
  return db
    .select()
    .from(schema.corporateBookings)
    .where(eq(schema.corporateBookings.id, id))
    .get();
}

/** A member linked to an active company holding `credits` in its pool. */
async function corporateMember(credits = 100) {
  const user = await makeUser(db);
  const company = await makeCompany(db, { creditPoolBalance: credits });
  await linkToCompany(db, user.id, company.id);
  return { user, company };
}

describe("corporateBookings.book", () => {
  it("books against the company pool and debits it", async () => {
    const { user, company } = await corporateMember(100);
    const cls = await makeClass(db, { creditCost: 3, capacity: 5 });

    const booking = await callerFor(db, user).corporateBookings.book({ classId: cls.id });

    expect(booking.status).toBe("booked");
    expect(booking.creditsUsed).toBe(3);
    expect(booking.companyId).toBe(company.id);
    expect((await readCompany(db, company.id))!.creditPoolBalance).toBe(97);
  });

  it("does not require a personal membership", async () => {
    const { user } = await corporateMember();
    const cls = await makeClass(db);
    await expect(
      callerFor(db, user).corporateBookings.book({ classId: cls.id }),
    ).resolves.toMatchObject({ status: "booked" });
  });

  it("refuses a member who is not linked to any company", async () => {
    const user = await makeUser(db);
    const cls = await makeClass(db);
    await expectTrpcError(
      callerFor(db, user).corporateBookings.book({ classId: cls.id }),
      "FORBIDDEN",
    );
  });

  it("refuses a member whose company is inactive", async () => {
    const user = await makeUser(db);
    const company = await makeCompany(db, { active: false });
    await linkToCompany(db, user.id, company.id);
    const cls = await makeClass(db);

    await expectTrpcError(
      callerFor(db, user).corporateBookings.book({ classId: cls.id }),
      "FORBIDDEN",
    );
  });

  it("refuses when the pool cannot cover the class", async () => {
    const { user } = await corporateMember(1);
    const cls = await makeClass(db, { creditCost: 2 });
    await expectTrpcError(
      callerFor(db, user).corporateBookings.book({ classId: cls.id }),
      "FORBIDDEN",
    );
  });

  it("has no unlimited pool concept, unlike personal memberships", async () => {
    const { user, company } = await corporateMember(999);
    const cls = await makeClass(db, { creditCost: 1 });

    await callerFor(db, user).corporateBookings.book({ classId: cls.id });

    // A personal membership on 999 credits would be untouched here.
    expect((await readCompany(db, company.id))!.creditPoolBalance).toBe(998);
  });

  it("waitlists at capacity without touching the pool", async () => {
    const cls = await makeClass(db, { capacity: 1, creditCost: 4 });
    const first = await corporateMember();
    await callerFor(db, first.user).corporateBookings.book({ classId: cls.id });

    const second = await corporateMember(50);
    const booking = await callerFor(db, second.user).corporateBookings.book({ classId: cls.id });

    expect(booking.status).toBe("waitlisted");
    expect(booking.creditsUsed).toBe(0);
    expect((await readCompany(db, second.company.id))!.creditPoolBalance).toBe(50);
  });

  it("rejects unknown, cancelled and already started classes", async () => {
    const { user } = await corporateMember();
    await expectTrpcError(
      callerFor(db, user).corporateBookings.book({ classId: 9999 }),
      "NOT_FOUND",
    );
    const cancelled = await makeClass(db, { cancelled: true });
    await expectTrpcError(
      callerFor(db, user).corporateBookings.book({ classId: cancelled.id }),
      "BAD_REQUEST",
    );
    const started = await makeClass(db, { startsAt: hoursFromNow(-1) });
    await expectTrpcError(
      callerFor(db, user).corporateBookings.book({ classId: started.id }),
      "BAD_REQUEST",
    );
  });

  it("rejects a duplicate corporate booking for the same class", async () => {
    const { user } = await corporateMember();
    const cls = await makeClass(db);
    await callerFor(db, user).corporateBookings.book({ classId: cls.id });
    await expectTrpcError(
      callerFor(db, user).corporateBookings.book({ classId: cls.id }),
      "CONFLICT",
    );
  });

  it("NOTE finding 2: capacity is counted per table, so one class can be filled twice over", async () => {
    const cls = await makeClass(db, { capacity: 1 });

    // Fill the single seat through the personal booking path.
    const personal = await makeUser(db);
    await makeMembership(db, personal.id);
    const personalBooking = await callerFor(db, personal).bookings.book({ classId: cls.id });
    expect(personalBooking.status).toBe("booked");

    // The corporate path counts only corporate_bookings, so it sees an empty
    // class and confirms a second member into a capacity-1 room.
    const { user } = await corporateMember();
    const corporateBooking = await callerFor(db, user).corporateBookings.book({ classId: cls.id });

    expect(corporateBooking.status).toBe("booked");
  });

  it("NOTE finding 2: a member can hold a personal and a corporate seat in the same class", async () => {
    const cls = await makeClass(db, { capacity: 10 });
    const user = await makeUser(db);
    await makeMembership(db, user.id);
    const company = await makeCompany(db);
    await linkToCompany(db, user.id, company.id);

    await callerFor(db, user).bookings.book({ classId: cls.id });
    const corporate = await callerFor(db, user).corporateBookings.book({ classId: cls.id });

    expect(corporate.status).toBe("booked");
  });
});

describe("corporateBookings.cancel", () => {
  it("refunds the pool at 24 hours, not the 12 used for personal bookings", async () => {
    const { user, company } = await corporateMember(100);
    const cls = await makeClass(db, { startsAt: hoursFromNow(25), creditCost: 5 });
    const booking = await callerFor(db, user).corporateBookings.book({ classId: cls.id });
    expect((await readCompany(db, company.id))!.creditPoolBalance).toBe(95);

    const result = await callerFor(db, user).corporateBookings.cancel({ bookingId: booking.id });

    expect(result).toEqual({ ok: true, refunded: true });
    expect((await readCompany(db, company.id))!.creditPoolBalance).toBe(100);
  });

  it("forfeits the credit between 12 and 24 hours, where a personal booking would refund", async () => {
    const { user, company } = await corporateMember(100);
    const cls = await makeClass(db, { startsAt: hoursFromNow(20), creditCost: 5 });
    const booking = await callerFor(db, user).corporateBookings.book({ classId: cls.id });

    const result = await callerFor(db, user).corporateBookings.cancel({ bookingId: booking.id });

    expect(result).toEqual({ ok: true, refunded: false });
    expect((await readCompany(db, company.id))!.creditPoolBalance).toBe(95);
  });

  it("promotes the longest waiting corporate member and charges their pool", async () => {
    const cls = await makeClass(db, { capacity: 1, creditCost: 2, startsAt: hoursFromNow(48) });

    const holder = await corporateMember();
    const holderBooking = await callerFor(db, holder.user).corporateBookings.book({
      classId: cls.id,
    });

    const waiter = await corporateMember(30);
    const wait = await seedCorporateBooking(db, {
      classId: cls.id,
      userId: waiter.user.id,
      companyId: waiter.company.id,
      status: "waitlisted",
      creditsUsed: 0,
      bookedAt: "2020-01-01T00:00:00.000Z",
    });

    await callerFor(db, holder.user).corporateBookings.cancel({ bookingId: holderBooking.id });

    expect((await readCorporateBooking(wait.id))!.status).toBe("booked");
    expect((await readCorporateBooking(wait.id))!.creditsUsed).toBe(2);
    expect((await readCompany(db, waiter.company.id))!.creditPoolBalance).toBe(28);
  });

  it("NOTE finding 3: a promoted corporate member with an empty pool is confirmed for free", async () => {
    const cls = await makeClass(db, { capacity: 1, creditCost: 10, startsAt: hoursFromNow(48) });

    const holder = await corporateMember();
    const holderBooking = await callerFor(db, holder.user).corporateBookings.book({
      classId: cls.id,
    });

    const waiter = await corporateMember(3);
    const wait = await seedCorporateBooking(db, {
      classId: cls.id,
      userId: waiter.user.id,
      companyId: waiter.company.id,
      status: "waitlisted",
      creditsUsed: 0,
    });

    await callerFor(db, holder.user).corporateBookings.cancel({ bookingId: holderBooking.id });

    // The seat is granted and creditsUsed says 10, but the guard skips the
    // debit, so the company keeps its 3 credits and pays nothing.
    expect((await readCorporateBooking(wait.id))!.status).toBe("booked");
    expect((await readCorporateBooking(wait.id))!.creditsUsed).toBe(10);
    expect((await readCompany(db, waiter.company.id))!.creditPoolBalance).toBe(3);
  });

  it("lets staff cancel and blocks unrelated members", async () => {
    const { user } = await corporateMember();
    const cls = await makeClass(db);
    const booking = await callerFor(db, user).corporateBookings.book({ classId: cls.id });

    const stranger = await makeUser(db);
    await expectTrpcError(
      callerFor(db, stranger).corporateBookings.cancel({ bookingId: booking.id }),
      "FORBIDDEN",
    );

    const admin = await makeAdmin(db);
    await expect(
      callerFor(db, admin).corporateBookings.cancel({ bookingId: booking.id }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("refuses a booking that is no longer active", async () => {
    const { user, company } = await corporateMember();
    const cls = await makeClass(db);
    const booking = await seedCorporateBooking(db, {
      classId: cls.id,
      userId: user.id,
      companyId: company.id,
      status: "attended",
    });
    await expectTrpcError(
      callerFor(db, user).corporateBookings.cancel({ bookingId: booking.id }),
      "BAD_REQUEST",
    );
  });
});

describe("corporateBookings.markAttended", () => {
  it("NOTE finding 4: records a checkin with no booking link, so class checkin counts miss it", async () => {
    const { user, company } = await corporateMember();
    const cls = await makeClass(db);
    const booking = await seedCorporateBooking(db, {
      classId: cls.id,
      userId: user.id,
      companyId: company.id,
      status: "booked",
    });
    const admin = await makeAdmin(db);

    await callerFor(db, admin).corporateBookings.markAttended({ bookingId: booking.id });

    expect((await readCorporateBooking(booking.id))!.status).toBe("attended");

    const checkins = await db.select().from(schema.checkins);
    expect(checkins).toHaveLength(1);
    expect(checkins[0].bookingId).toBeNull();
    // The personal path passes input.source through; this one always defaults.
    expect(checkins[0].source).toBe("front_desk");

    // checkinCountFor joins checkins to bookings, so this check-in is invisible.
    const { count } = await callerFor(db, admin).bookings.checkinCountFor({ classId: cls.id });
    expect(count).toBe(0);
  });

  it("accepts a source argument but ignores it", async () => {
    const { user, company } = await corporateMember();
    const cls = await makeClass(db);
    const booking = await seedCorporateBooking(db, {
      classId: cls.id,
      userId: user.id,
      companyId: company.id,
      status: "booked",
    });
    const admin = await makeAdmin(db);

    await callerFor(db, admin).corporateBookings.markAttended({
      bookingId: booking.id,
      source: "kiosk",
    });

    const checkins = await db.select().from(schema.checkins);
    expect(checkins[0].source).toBe("front_desk");
  });
});

describe("corporateBookings.mine and rosterFor", () => {
  it("mine returns future corporate bookings with the company name attached", async () => {
    const { user } = await corporateMember();
    const past = await makeClass(db, { startsAt: hoursFromNow(-48) });
    const future = await makeClass(db, { startsAt: hoursFromNow(24) });
    await callerFor(db, user).corporateBookings.book({ classId: future.id });
    await seedCorporateBooking(db, {
      classId: past.id,
      userId: user.id,
      companyId: (await makeCompany(db)).id,
      status: "booked",
    });

    const mine = await callerFor(db, user).corporateBookings.mine();
    expect(mine).toHaveLength(1);
    expect(mine[0].companyName).toBeTruthy();
  });

  it("NOTE finding 5: the two rosters are separate, so neither shows the full room", async () => {
    const admin = await makeAdmin(db);
    const cls = await makeClass(db, { capacity: 10 });

    const personal = await makeUser(db);
    await seedBooking(db, { classId: cls.id, userId: personal.id, status: "booked" });

    const { user, company } = await corporateMember();
    await seedCorporateBooking(db, {
      classId: cls.id,
      userId: user.id,
      companyId: company.id,
      status: "booked",
    });

    const personalRoster = await callerFor(db, admin).bookings.rosterFor({ classId: cls.id });
    const corporateRoster = await callerFor(db, admin).corporateBookings.rosterFor({
      classId: cls.id,
    });

    expect(personalRoster.map((r) => r.memberId)).toEqual([personal.id]);
    expect(corporateRoster.map((r) => r.memberId)).toEqual([user.id]);
  });
});
