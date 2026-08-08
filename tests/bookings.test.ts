/**
 * Characterization tests for the member booking flow.
 *
 * These describe what the app does today, not what it ought to do. Where
 * today's behaviour looks wrong it is still pinned here, with a NOTE comment
 * pointing at the entry in documents/findings.md.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";
import {
  freshDb,
  callerFor,
  makeUser,
  makeAdmin,
  makeMembership,
  makeClass,
  seedBooking,
  readBooking,
  readMembership,
  hoursFromNow,
  daysFromNow,
  type TestDb,
} from "./helpers/harness";

let db: TestDb;

beforeEach(async () => {
  db = await freshDb();
});

async function expectTrpcError(p: Promise<unknown>, code: TRPCError["code"]) {
  await expect(p).rejects.toMatchObject({ code });
}

describe("bookings.book", () => {
  it("books a member into a class with space and spends the credit cost", async () => {
    const user = await makeUser(db);
    const membership = await makeMembership(db, user.id, { creditsRemaining: 10 });
    const cls = await makeClass(db, { creditCost: 2, capacity: 5 });

    const booking = await callerFor(db, user).bookings.book({ classId: cls.id });

    expect(booking.status).toBe("booked");
    expect(booking.creditsUsed).toBe(2);
    expect(booking.membershipId).toBe(membership.id);
    expect((await readMembership(db, membership.id))!.creditsRemaining).toBe(8);
  });

  it("waitlists when the class is at capacity and charges nothing", async () => {
    const cls = await makeClass(db, { capacity: 1, creditCost: 3 });
    const first = await makeUser(db);
    await makeMembership(db, first.id);
    await seedBooking(db, { classId: cls.id, userId: first.id, status: "booked", creditsUsed: 3 });

    const user = await makeUser(db);
    const membership = await makeMembership(db, user.id, { creditsRemaining: 10 });

    const booking = await callerFor(db, user).bookings.book({ classId: cls.id });

    expect(booking.status).toBe("waitlisted");
    expect(booking.creditsUsed).toBe(0);
    expect((await readMembership(db, membership.id))!.creditsRemaining).toBe(10);
  });

  it("treats a membership with 999 or more credits as unlimited and never decrements", async () => {
    const user = await makeUser(db);
    const membership = await makeMembership(db, user.id, { creditsRemaining: 999 });
    const cls = await makeClass(db, { creditCost: 5 });

    const booking = await callerFor(db, user).bookings.book({ classId: cls.id });

    expect(booking.status).toBe("booked");
    // The booking still records the cost even though the balance is untouched.
    expect(booking.creditsUsed).toBe(5);
    expect((await readMembership(db, membership.id))!.creditsRemaining).toBe(999);
  });

  it("rejects an unknown class", async () => {
    const user = await makeUser(db);
    await makeMembership(db, user.id);
    await expectTrpcError(callerFor(db, user).bookings.book({ classId: 9999 }), "NOT_FOUND");
  });

  it("rejects a cancelled class", async () => {
    const user = await makeUser(db);
    await makeMembership(db, user.id);
    const cls = await makeClass(db, { cancelled: true });
    await expectTrpcError(callerFor(db, user).bookings.book({ classId: cls.id }), "BAD_REQUEST");
  });

  it("rejects a class that has already started", async () => {
    const user = await makeUser(db);
    await makeMembership(db, user.id);
    const cls = await makeClass(db, { startsAt: hoursFromNow(-1) });
    await expectTrpcError(callerFor(db, user).bookings.book({ classId: cls.id }), "BAD_REQUEST");
  });

  it("rejects a second booking for the same class", async () => {
    const user = await makeUser(db);
    await makeMembership(db, user.id);
    const cls = await makeClass(db);
    await callerFor(db, user).bookings.book({ classId: cls.id });
    await expectTrpcError(callerFor(db, user).bookings.book({ classId: cls.id }), "CONFLICT");
  });

  it("allows rebooking after cancelling, because only booked and waitlisted block", async () => {
    const user = await makeUser(db);
    await makeMembership(db, user.id);
    const cls = await makeClass(db);
    const first = await callerFor(db, user).bookings.book({ classId: cls.id });
    await callerFor(db, user).bookings.cancel({ bookingId: first.id });

    const second = await callerFor(db, user).bookings.book({ classId: cls.id });
    expect(second.status).toBe("booked");
  });

  it("requires an active membership", async () => {
    const user = await makeUser(db);
    const cls = await makeClass(db);
    await expectTrpcError(callerFor(db, user).bookings.book({ classId: cls.id }), "FORBIDDEN");
  });

  it("ignores an expired membership", async () => {
    const user = await makeUser(db);
    await makeMembership(db, user.id, { endDate: daysFromNow(-1) });
    const cls = await makeClass(db);
    await expectTrpcError(callerFor(db, user).bookings.book({ classId: cls.id }), "FORBIDDEN");
  });

  it("ignores a frozen or cancelled membership", async () => {
    const user = await makeUser(db);
    await makeMembership(db, user.id, { status: "frozen" });
    const cls = await makeClass(db);
    await expectTrpcError(callerFor(db, user).bookings.book({ classId: cls.id }), "FORBIDDEN");
  });

  it("refuses when credits remaining are below the class cost", async () => {
    const user = await makeUser(db);
    await makeMembership(db, user.id, { creditsRemaining: 1 });
    const cls = await makeClass(db, { creditCost: 2 });
    await expectTrpcError(callerFor(db, user).bookings.book({ classId: cls.id }), "FORBIDDEN");
  });

  it("picks the membership with the furthest end date when a member has several", async () => {
    const user = await makeUser(db);
    await makeMembership(db, user.id, { endDate: daysFromNow(5), creditsRemaining: 4 });
    const later = await makeMembership(db, user.id, { endDate: daysFromNow(60), creditsRemaining: 9 });
    const cls = await makeClass(db, { creditCost: 1 });

    const booking = await callerFor(db, user).bookings.book({ classId: cls.id });

    expect(booking.membershipId).toBe(later.id);
    expect((await readMembership(db, later.id))!.creditsRemaining).toBe(8);
  });

  it("requires a signed in user", async () => {
    const cls = await makeClass(db);
    await expectTrpcError(callerFor(db, null).bookings.book({ classId: cls.id }), "UNAUTHORIZED");
  });

  it("counts only confirmed bookings toward capacity, so cancellations free a spot", async () => {
    const cls = await makeClass(db, { capacity: 1 });
    const other = await makeUser(db);
    await seedBooking(db, { classId: cls.id, userId: other.id, status: "cancelled" });

    const user = await makeUser(db);
    await makeMembership(db, user.id);

    const booking = await callerFor(db, user).bookings.book({ classId: cls.id });
    expect(booking.status).toBe("booked");
  });
});

describe("bookings.cancel", () => {
  it("refunds the credit when cancelling 12 or more hours before the class", async () => {
    const user = await makeUser(db);
    const membership = await makeMembership(db, user.id, { creditsRemaining: 10 });
    const cls = await makeClass(db, { startsAt: hoursFromNow(13), creditCost: 2 });
    const booking = await callerFor(db, user).bookings.book({ classId: cls.id });
    expect((await readMembership(db, membership.id))!.creditsRemaining).toBe(8);

    const result = await callerFor(db, user).bookings.cancel({ bookingId: booking.id });

    expect(result).toEqual({ ok: true, refunded: true });
    expect((await readMembership(db, membership.id))!.creditsRemaining).toBe(10);
    const after = await readBooking(db, booking.id);
    expect(after!.status).toBe("cancelled");
    expect(after!.cancelledAt).not.toBeNull();
  });

  it("forfeits the credit when cancelling inside the 12 hour window", async () => {
    const user = await makeUser(db);
    const membership = await makeMembership(db, user.id, { creditsRemaining: 10 });
    const cls = await makeClass(db, { startsAt: hoursFromNow(11), creditCost: 2 });
    const booking = await callerFor(db, user).bookings.book({ classId: cls.id });

    const result = await callerFor(db, user).bookings.cancel({ bookingId: booking.id });

    expect(result).toEqual({ ok: true, refunded: false });
    expect((await readMembership(db, membership.id))!.creditsRemaining).toBe(8);
    expect((await readBooking(db, booking.id))!.status).toBe("cancelled");
  });

  it("does not refund an unlimited membership", async () => {
    const user = await makeUser(db);
    const membership = await makeMembership(db, user.id, { creditsRemaining: 999 });
    const cls = await makeClass(db, { startsAt: hoursFromNow(48), creditCost: 1 });
    const booking = await callerFor(db, user).bookings.book({ classId: cls.id });

    // refunded reports true because creditsUsed was recorded, but the balance
    // is deliberately left alone for unlimited plans.
    const result = await callerFor(db, user).bookings.cancel({ bookingId: booking.id });

    expect(result.refunded).toBe(true);
    expect((await readMembership(db, membership.id))!.creditsRemaining).toBe(999);
  });

  it("reports refunded false when the booking spent no credits", async () => {
    const cls = await makeClass(db, { capacity: 1, startsAt: hoursFromNow(48) });
    const holder = await makeUser(db);
    await seedBooking(db, { classId: cls.id, userId: holder.id, status: "booked", creditsUsed: 1 });

    const user = await makeUser(db);
    await makeMembership(db, user.id);
    const waitlisted = await callerFor(db, user).bookings.book({ classId: cls.id });
    expect(waitlisted.status).toBe("waitlisted");

    const result = await callerFor(db, user).bookings.cancel({ bookingId: waitlisted.id });
    expect(result.refunded).toBe(false);
  });

  it("promotes the longest waiting member when a confirmed spot is freed", async () => {
    const cls = await makeClass(db, { capacity: 1, creditCost: 1, startsAt: hoursFromNow(48) });

    const holder = await makeUser(db);
    await makeMembership(db, holder.id);
    const holderBooking = await callerFor(db, holder).bookings.book({ classId: cls.id });

    const waiterA = await makeUser(db);
    const waiterAMs = await makeMembership(db, waiterA.id, { creditsRemaining: 10 });
    const waitA = await seedBooking(db, {
      classId: cls.id,
      userId: waiterA.id,
      membershipId: waiterAMs.id,
      status: "waitlisted",
      creditsUsed: 0,
      bookedAt: "2020-01-01T00:00:00.000Z",
    });

    const waiterB = await makeUser(db);
    const waiterBMs = await makeMembership(db, waiterB.id);
    const waitB = await seedBooking(db, {
      classId: cls.id,
      userId: waiterB.id,
      membershipId: waiterBMs.id,
      status: "waitlisted",
      creditsUsed: 0,
      bookedAt: "2021-01-01T00:00:00.000Z",
    });

    await callerFor(db, holder).bookings.cancel({ bookingId: holderBooking.id });

    expect((await readBooking(db, waitA.id))!.status).toBe("booked");
    expect((await readBooking(db, waitA.id))!.creditsUsed).toBe(1);
    expect((await readBooking(db, waitB.id))!.status).toBe("waitlisted");
    // The promoted member is charged at promotion time.
    expect((await readMembership(db, waiterAMs.id))!.creditsRemaining).toBe(9);
  });

  it("does not promote anyone when a waitlisted booking is cancelled", async () => {
    const cls = await makeClass(db, { capacity: 1, startsAt: hoursFromNow(48) });
    const holder = await makeUser(db);
    await seedBooking(db, { classId: cls.id, userId: holder.id, status: "booked", creditsUsed: 1 });

    const waiterA = await makeUser(db);
    await makeMembership(db, waiterA.id);
    const waitA = await callerFor(db, waiterA).bookings.book({ classId: cls.id });

    const waiterB = await makeUser(db);
    const bMs = await makeMembership(db, waiterB.id);
    const waitB = await seedBooking(db, {
      classId: cls.id,
      userId: waiterB.id,
      membershipId: bMs.id,
      status: "waitlisted",
      bookedAt: "2030-01-01T00:00:00.000Z",
    });

    await callerFor(db, waiterA).bookings.cancel({ bookingId: waitA.id });

    expect((await readBooking(db, waitB.id))!.status).toBe("waitlisted");
  });

  it("NOTE finding 1: promotion charges the waitlisted member even with too few credits, clamping at zero", async () => {
    const cls = await makeClass(db, { capacity: 1, creditCost: 5, startsAt: hoursFromNow(48) });

    const holder = await makeUser(db);
    await makeMembership(db, holder.id);
    const holderBooking = await callerFor(db, holder).bookings.book({ classId: cls.id });

    const waiter = await makeUser(db);
    const poorMs = await makeMembership(db, waiter.id, { creditsRemaining: 1 });
    const wait = await seedBooking(db, {
      classId: cls.id,
      userId: waiter.id,
      membershipId: poorMs.id,
      status: "waitlisted",
      creditsUsed: 0,
    });

    await callerFor(db, holder).bookings.cancel({ bookingId: holderBooking.id });

    expect((await readBooking(db, wait.id))!.status).toBe("booked");
    expect((await readBooking(db, wait.id))!.creditsUsed).toBe(5);
    // 1 - 5 would be negative, so it silently becomes 0 and the member gets a
    // class they could not afford.
    expect((await readMembership(db, poorMs.id))!.creditsRemaining).toBe(0);
  });

  it("lets staff cancel someone else's booking", async () => {
    const user = await makeUser(db);
    await makeMembership(db, user.id);
    const cls = await makeClass(db);
    const booking = await callerFor(db, user).bookings.book({ classId: cls.id });

    const admin = await makeAdmin(db);
    await expect(
      callerFor(db, admin).bookings.cancel({ bookingId: booking.id }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("stops a member cancelling someone else's booking", async () => {
    const user = await makeUser(db);
    await makeMembership(db, user.id);
    const cls = await makeClass(db);
    const booking = await callerFor(db, user).bookings.book({ classId: cls.id });

    const stranger = await makeUser(db);
    await expectTrpcError(
      callerFor(db, stranger).bookings.cancel({ bookingId: booking.id }),
      "FORBIDDEN",
    );
  });

  it("refuses to cancel a booking that is not active", async () => {
    const user = await makeUser(db);
    const cls = await makeClass(db);
    const booking = await seedBooking(db, {
      classId: cls.id,
      userId: user.id,
      status: "attended",
    });
    await expectTrpcError(
      callerFor(db, user).bookings.cancel({ bookingId: booking.id }),
      "BAD_REQUEST",
    );
  });

  it("rejects an unknown booking", async () => {
    const user = await makeUser(db);
    await expectTrpcError(callerFor(db, user).bookings.cancel({ bookingId: 9999 }), "NOT_FOUND");
  });
});

describe("bookings.mine", () => {
  it("returns only future bookings by default, oldest class first", async () => {
    const user = await makeUser(db);
    const past = await makeClass(db, { startsAt: hoursFromNow(-48) });
    const soon = await makeClass(db, { startsAt: hoursFromNow(2) });
    const later = await makeClass(db, { startsAt: hoursFromNow(72) });
    for (const c of [past, later, soon]) {
      await seedBooking(db, { classId: c.id, userId: user.id, status: "booked" });
    }

    const mine = await callerFor(db, user).bookings.mine();

    expect(mine.map((b) => b.classId)).toEqual([soon.id, later.id]);
  });

  it("includes past bookings when asked", async () => {
    const user = await makeUser(db);
    const past = await makeClass(db, { startsAt: hoursFromNow(-48) });
    await seedBooking(db, { classId: past.id, userId: user.id, status: "booked" });

    const mine = await callerFor(db, user).bookings.mine({ includePast: true });
    expect(mine).toHaveLength(1);
  });

  it("includes cancelled bookings, which the dashboard then filters by status", async () => {
    const user = await makeUser(db);
    const cls = await makeClass(db);
    await seedBooking(db, { classId: cls.id, userId: user.id, status: "cancelled" });

    const mine = await callerFor(db, user).bookings.mine();
    expect(mine).toHaveLength(1);
    expect(mine[0].status).toBe("cancelled");
  });

  it("does not leak other members' bookings", async () => {
    const user = await makeUser(db);
    const other = await makeUser(db);
    const cls = await makeClass(db);
    await seedBooking(db, { classId: cls.id, userId: other.id, status: "booked" });

    expect(await callerFor(db, user).bookings.mine()).toEqual([]);
  });
});

describe("bookings.waitlisted", () => {
  it("reports a one-based queue position ordered by when each member joined", async () => {
    const cls = await makeClass(db, { capacity: 1 });
    const holder = await makeUser(db);
    await seedBooking(db, { classId: cls.id, userId: holder.id, status: "booked" });

    const first = await makeUser(db);
    await seedBooking(db, {
      classId: cls.id,
      userId: first.id,
      status: "waitlisted",
      bookedAt: "2020-01-01T00:00:00.000Z",
    });

    const second = await makeUser(db);
    await seedBooking(db, {
      classId: cls.id,
      userId: second.id,
      status: "waitlisted",
      bookedAt: "2021-01-01T00:00:00.000Z",
    });

    expect((await callerFor(db, first).bookings.waitlisted())[0].position).toBe(1);
    expect((await callerFor(db, second).bookings.waitlisted())[0].position).toBe(2);
  });

  it("includes waitlisted entries for classes that have already happened", async () => {
    const user = await makeUser(db);
    const past = await makeClass(db, { startsAt: hoursFromNow(-48) });
    await seedBooking(db, { classId: past.id, userId: user.id, status: "waitlisted" });

    expect(await callerFor(db, user).bookings.waitlisted()).toHaveLength(1);
  });
});

describe("bookings.markAttended", () => {
  it("marks the booking attended and records a checkin with the given source", async () => {
    const user = await makeUser(db);
    const cls = await makeClass(db);
    const booking = await seedBooking(db, {
      classId: cls.id,
      userId: user.id,
      status: "booked",
    });
    const admin = await makeAdmin(db);

    await callerFor(db, admin).bookings.markAttended({ bookingId: booking.id, source: "kiosk" });

    expect((await readBooking(db, booking.id))!.status).toBe("attended");
    const { count } = await callerFor(db, admin).bookings.checkinCountFor({ classId: cls.id });
    expect(count).toBe(1);
  });

  it("refuses to check in a waitlisted booking", async () => {
    const user = await makeUser(db);
    const cls = await makeClass(db);
    const booking = await seedBooking(db, {
      classId: cls.id,
      userId: user.id,
      status: "waitlisted",
    });
    const admin = await makeAdmin(db);

    await expectTrpcError(
      callerFor(db, admin).bookings.markAttended({ bookingId: booking.id }),
      "BAD_REQUEST",
    );
  });

  it("is staff only", async () => {
    const user = await makeUser(db);
    const cls = await makeClass(db);
    const booking = await seedBooking(db, { classId: cls.id, userId: user.id, status: "booked" });

    await expectTrpcError(
      callerFor(db, user).bookings.markAttended({ bookingId: booking.id }),
      "FORBIDDEN",
    );
  });
});

describe("bookings.upcomingForMember", () => {
  it("returns confirmed bookings inside the requested window only", async () => {
    const admin = await makeAdmin(db);
    const user = await makeUser(db);

    const inWindow = await makeClass(db, { startsAt: hoursFromNow(1) });
    const outsideWindow = await makeClass(db, { startsAt: hoursFromNow(5) });
    const alreadyStarted = await makeClass(db, { startsAt: hoursFromNow(-1) });
    const cancelledClass = await makeClass(db, { startsAt: hoursFromNow(1), cancelled: true });

    for (const c of [inWindow, outsideWindow, alreadyStarted, cancelledClass]) {
      await seedBooking(db, { classId: c.id, userId: user.id, status: "booked" });
    }
    const waitlistedClass = await makeClass(db, { startsAt: hoursFromNow(1) });
    await seedBooking(db, { classId: waitlistedClass.id, userId: user.id, status: "waitlisted" });

    const rows = await callerFor(db, admin).bookings.upcomingForMember({
      userId: user.id,
      hoursAhead: 2,
    });

    expect(rows.map((r) => r.classId)).toEqual([inWindow.id]);
  });
});

describe("bookings.rosterFor", () => {
  it("lists every booking for the class in join order, whatever its status", async () => {
    const admin = await makeAdmin(db);
    const cls = await makeClass(db);
    const a = await makeUser(db);
    const b = await makeUser(db);

    await seedBooking(db, {
      classId: cls.id, userId: b.id, status: "cancelled", bookedAt: "2021-01-01T00:00:00.000Z",
    });
    await seedBooking(db, {
      classId: cls.id, userId: a.id, status: "booked", bookedAt: "2020-01-01T00:00:00.000Z",
    });

    const roster = await callerFor(db, admin).bookings.rosterFor({ classId: cls.id });

    expect(roster.map((r) => r.memberId)).toEqual([a.id, b.id]);
    expect(roster.map((r) => r.status)).toEqual(["booked", "cancelled"]);
  });
});
