/**
 * Characterization tests for rescheduling.
 *
 * reschedule() and validateReschedule() apply the same eight rules in the same
 * order, one by throwing and one by returning { valid, reason }. Every rule is
 * pinned from both sides so the pair cannot drift apart when they are merged.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";
import {
  freshDb,
  callerFor,
  makeUser,
  makeMembership,
  makeClass,
  seedBooking,
  readBooking,
  readMembership,
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

/** A member holding a confirmed booking, plus a same-name class to move to. */
async function bookedMember(opts: { creditCost?: number; fromHours?: number; toHours?: number } = {}) {
  const { creditCost = 1, fromHours = 48, toHours = 72 } = opts;
  const user = await makeUser(db);
  const membership = await makeMembership(db, user.id, { creditsRemaining: 10 });
  const from = await makeClass(db, {
    name: "Yoga",
    creditCost,
    startsAt: hoursFromNow(fromHours),
  });
  const to = await makeClass(db, {
    name: "Yoga",
    creditCost,
    startsAt: hoursFromNow(toHours),
  });
  const booking = await callerFor(db, user).bookings.book({ classId: from.id });
  return { user, membership, from, to, booking };
}

describe("reschedules.reschedule", () => {
  it("moves the member to the target class, cancels the original and keeps the credits", async () => {
    const { user, membership, from, to, booking } = await bookedMember({ creditCost: 3 });
    expect((await readMembership(db, membership.id))!.creditsRemaining).toBe(7);

    const result = await callerFor(db, user).reschedules.reschedule({
      fromBookingId: booking.id,
      toClassId: to.id,
    });

    expect(result.ok).toBe(true);
    expect(result.newStatus).toBe("booked");
    expect(result.newBooking.classId).toBe(to.id);
    expect(result.newBooking.creditsUsed).toBe(3);
    expect(result.newBooking.membershipId).toBe(membership.id);

    const original = await readBooking(db, booking.id);
    expect(original!.status).toBe("cancelled");
    expect(original!.cancelledAt).not.toBeNull();

    // Rescheduling is free: no second charge and no refund of the original.
    expect((await readMembership(db, membership.id))!.creditsRemaining).toBe(7);
    void from;
  });

  it("records the move in the reschedule history", async () => {
    const { user, from, to, booking } = await bookedMember();

    await callerFor(db, user).reschedules.reschedule({
      fromBookingId: booking.id,
      toClassId: to.id,
    });

    const rows = await db.select().from(schema.reschedules);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: user.id,
      fromBookingId: booking.id,
      fromClassId: from.id,
      toClassId: to.id,
    });

    const history = await callerFor(db, user).reschedules.history();
    expect(history).toHaveLength(1);
    expect(history[0].fromClassName).toBe("Yoga");
    expect(history[0].toClassName).toBe("Yoga");
  });

  it("waitlists into a full target class while still cancelling the original", async () => {
    const { user, to, booking } = await bookedMember();
    await db.update(schema.classes).set({ capacity: 1 }).where(
      (await import("drizzle-orm")).eq(schema.classes.id, to.id),
    );
    const filler = await makeUser(db);
    await seedBooking(db, { classId: to.id, userId: filler.id, status: "booked" });

    const result = await callerFor(db, user).reschedules.reschedule({
      fromBookingId: booking.id,
      toClassId: to.id,
    });

    expect(result.newStatus).toBe("waitlisted");
    expect((await readBooking(db, booking.id))!.status).toBe("cancelled");
  });

  it("NOTE finding 6: leaves the vacated seat empty instead of promoting the waitlist", async () => {
    const user = await makeUser(db);
    await makeMembership(db, user.id);
    const from = await makeClass(db, { name: "Yoga", capacity: 1, startsAt: hoursFromNow(48) });
    const to = await makeClass(db, { name: "Yoga", startsAt: hoursFromNow(72) });
    const booking = await callerFor(db, user).bookings.book({ classId: from.id });

    const waiter = await makeUser(db);
    const waiterMs = await makeMembership(db, waiter.id);
    const wait = await seedBooking(db, {
      classId: from.id,
      userId: waiter.id,
      membershipId: waiterMs.id,
      status: "waitlisted",
      creditsUsed: 0,
    });

    await callerFor(db, user).reschedules.reschedule({
      fromBookingId: booking.id,
      toClassId: to.id,
    });

    // bookings.cancel would have promoted this member. Rescheduling does not,
    // so the seat sits empty and the waitlist never moves.
    expect((await readBooking(db, wait.id))!.status).toBe("waitlisted");
  });

  it("allows rescheduling a waitlisted booking", async () => {
    const user = await makeUser(db);
    const membership = await makeMembership(db, user.id);
    const from = await makeClass(db, { name: "Yoga", capacity: 1, startsAt: hoursFromNow(48) });
    const to = await makeClass(db, { name: "Yoga", startsAt: hoursFromNow(72) });
    const filler = await makeUser(db);
    await seedBooking(db, { classId: from.id, userId: filler.id, status: "booked" });
    const booking = await callerFor(db, user).bookings.book({ classId: from.id });
    expect(booking.status).toBe("waitlisted");

    const result = await callerFor(db, user).reschedules.reschedule({
      fromBookingId: booking.id,
      toClassId: to.id,
    });

    // A waitlisted booking spent no credits, so the new confirmed booking
    // carries creditsUsed 0 and the member gets the class without paying.
    expect(result.newStatus).toBe("booked");
    expect(result.newBooking.creditsUsed).toBe(0);
    expect((await readMembership(db, membership.id))!.creditsRemaining).toBe(10);
  });

  describe("rules, enforced identically by reschedule and validateReschedule", () => {
    it("rejects an unknown booking", async () => {
      const { user, to } = await bookedMember();
      await expectTrpcError(
        callerFor(db, user).reschedules.reschedule({ fromBookingId: 9999, toClassId: to.id }),
        "NOT_FOUND",
      );
      expect(
        await callerFor(db, user).reschedules.validateReschedule({
          fromBookingId: 9999,
          toClassId: to.id,
        }),
      ).toEqual({ valid: false, reason: "Booking not found." });
    });

    it("rejects a booking owned by someone else", async () => {
      const { to, booking } = await bookedMember();
      const stranger = await makeUser(db);
      await expectTrpcError(
        callerFor(db, stranger).reschedules.reschedule({
          fromBookingId: booking.id,
          toClassId: to.id,
        }),
        "FORBIDDEN",
      );
      expect(
        await callerFor(db, stranger).reschedules.validateReschedule({
          fromBookingId: booking.id,
          toClassId: to.id,
        }),
      ).toEqual({ valid: false, reason: "You cannot reschedule this booking." });
    });

    it("rejects a booking that is no longer active", async () => {
      const { user, to, booking } = await bookedMember();
      await callerFor(db, user).bookings.cancel({ bookingId: booking.id });

      await expectTrpcError(
        callerFor(db, user).reschedules.reschedule({
          fromBookingId: booking.id,
          toClassId: to.id,
        }),
        "BAD_REQUEST",
      );
      expect(
        await callerFor(db, user).reschedules.validateReschedule({
          fromBookingId: booking.id,
          toClassId: to.id,
        }),
      ).toEqual({ valid: false, reason: "This booking is no longer active." });
    });

    it("rejects a move inside 4 hours of the original class", async () => {
      const { user, to, booking } = await bookedMember({ fromHours: 3 });
      await expectTrpcError(
        callerFor(db, user).reschedules.reschedule({
          fromBookingId: booking.id,
          toClassId: to.id,
        }),
        "BAD_REQUEST",
      );
      const check = await callerFor(db, user).reschedules.validateReschedule({
        fromBookingId: booking.id,
        toClassId: to.id,
      });
      expect(check.valid).toBe(false);
      expect(check.reason).toContain("4 hours");
    });

    it("allows a move at exactly 4 hours", async () => {
      const { user, to, booking } = await bookedMember({ fromHours: 4.01 });
      expect(
        await callerFor(db, user).reschedules.validateReschedule({
          fromBookingId: booking.id,
          toClassId: to.id,
        }),
      ).toEqual({ valid: true, targetIsFull: false });
    });

    it("rejects an unknown target class", async () => {
      const { user, booking } = await bookedMember();
      await expectTrpcError(
        callerFor(db, user).reschedules.reschedule({
          fromBookingId: booking.id,
          toClassId: 9999,
        }),
        "NOT_FOUND",
      );
      expect(
        await callerFor(db, user).reschedules.validateReschedule({
          fromBookingId: booking.id,
          toClassId: 9999,
        }),
      ).toEqual({ valid: false, reason: "Target class not found." });
    });

    it("only allows a target class with the same name", async () => {
      const { user, booking } = await bookedMember();
      const other = await makeClass(db, { name: "Pilates", startsAt: hoursFromNow(72) });

      await expectTrpcError(
        callerFor(db, user).reschedules.reschedule({
          fromBookingId: booking.id,
          toClassId: other.id,
        }),
        "BAD_REQUEST",
      );
      expect(
        await callerFor(db, user).reschedules.validateReschedule({
          fromBookingId: booking.id,
          toClassId: other.id,
        }),
      ).toEqual({
        valid: false,
        reason: "You can only reschedule to a class with the same name.",
      });
    });

    it("rejects rescheduling onto the same class", async () => {
      const { user, from, booking } = await bookedMember();
      await expectTrpcError(
        callerFor(db, user).reschedules.reschedule({
          fromBookingId: booking.id,
          toClassId: from.id,
        }),
        "BAD_REQUEST",
      );
      expect(
        await callerFor(db, user).reschedules.validateReschedule({
          fromBookingId: booking.id,
          toClassId: from.id,
        }),
      ).toEqual({ valid: false, reason: "You are already booked for this class." });
    });

    it("rejects a target class that has started", async () => {
      const { user, booking } = await bookedMember();
      const past = await makeClass(db, { name: "Yoga", startsAt: hoursFromNow(-1) });
      await expectTrpcError(
        callerFor(db, user).reschedules.reschedule({
          fromBookingId: booking.id,
          toClassId: past.id,
        }),
        "BAD_REQUEST",
      );
      expect(
        await callerFor(db, user).reschedules.validateReschedule({
          fromBookingId: booking.id,
          toClassId: past.id,
        }),
      ).toEqual({ valid: false, reason: "This class has already started." });
    });

    it("rejects a cancelled target class", async () => {
      const { user, booking } = await bookedMember();
      const dead = await makeClass(db, {
        name: "Yoga",
        startsAt: hoursFromNow(72),
        cancelled: true,
      });
      await expectTrpcError(
        callerFor(db, user).reschedules.reschedule({
          fromBookingId: booking.id,
          toClassId: dead.id,
        }),
        "BAD_REQUEST",
      );
      expect(
        await callerFor(db, user).reschedules.validateReschedule({
          fromBookingId: booking.id,
          toClassId: dead.id,
        }),
      ).toEqual({ valid: false, reason: "This class has been cancelled." });
    });

    it("rejects a target the member is already on the list for", async () => {
      const { user, to, booking } = await bookedMember();
      await seedBooking(db, { classId: to.id, userId: user.id, status: "booked" });

      await expectTrpcError(
        callerFor(db, user).reschedules.reschedule({
          fromBookingId: booking.id,
          toClassId: to.id,
        }),
        "CONFLICT",
      );
      expect(
        await callerFor(db, user).reschedules.validateReschedule({
          fromBookingId: booking.id,
          toClassId: to.id,
        }),
      ).toEqual({
        valid: false,
        reason: "You already have an active booking for this class.",
      });
    });

    it("reports targetIsFull without blocking the move", async () => {
      const { user, to, booking } = await bookedMember();
      await db.update(schema.classes).set({ capacity: 1 }).where(
        (await import("drizzle-orm")).eq(schema.classes.id, to.id),
      );
      const filler = await makeUser(db);
      await seedBooking(db, { classId: to.id, userId: filler.id, status: "booked" });

      expect(
        await callerFor(db, user).reschedules.validateReschedule({
          fromBookingId: booking.id,
          toClassId: to.id,
        }),
      ).toEqual({ valid: true, targetIsFull: true });
    });
  });
});

describe("reschedules.history", () => {
  it("returns newest first and only for the signed in member", async () => {
    const { user, to, booking } = await bookedMember();
    await callerFor(db, user).reschedules.reschedule({
      fromBookingId: booking.id,
      toClassId: to.id,
    });

    const stranger = await makeUser(db);
    expect(await callerFor(db, stranger).reschedules.history()).toEqual([]);
    expect(await callerFor(db, user).reschedules.history()).toHaveLength(1);
  });
});
