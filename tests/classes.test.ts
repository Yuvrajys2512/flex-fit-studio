/**
 * Characterization tests for the class catalogue and admin reporting.
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
  makeMembership,
  makeClass,
  makeCompany,
  linkToCompany,
  seedBooking,
  seedCorporateBooking,
  readBooking,
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

describe("classes.list", () => {
  it("is public and hides cancelled classes by default", async () => {
    const live = await makeClass(db);
    await makeClass(db, { cancelled: true });

    const rows = await callerFor(db, null).classes.list();

    expect(rows.map((r) => r.id)).toEqual([live.id]);
  });

  it("includes cancelled classes when asked", async () => {
    await makeClass(db);
    await makeClass(db, { cancelled: true });
    expect(await callerFor(db, null).classes.list({ includeCancelled: true })).toHaveLength(2);
  });

  it("filters on a date range and orders by start time", async () => {
    const early = await makeClass(db, { startsAt: hoursFromNow(1) });
    const middle = await makeClass(db, { startsAt: hoursFromNow(24) });
    const late = await makeClass(db, { startsAt: hoursFromNow(96) });

    const all = await callerFor(db, null).classes.list();
    expect(all.map((r) => r.id)).toEqual([early.id, middle.id, late.id]);

    const window = await callerFor(db, null).classes.list({
      from: hoursFromNow(12),
      to: hoursFromNow(48),
    });
    expect(window.map((r) => r.id)).toEqual([middle.id]);
  });

  it("derives spotsLeft and full from confirmed bookings only", async () => {
    const cls = await makeClass(db, { capacity: 2 });
    const a = await makeUser(db);
    const b = await makeUser(db);
    await seedBooking(db, { classId: cls.id, userId: a.id, status: "booked" });
    await seedBooking(db, { classId: cls.id, userId: b.id, status: "cancelled" });

    const [row] = await callerFor(db, null).classes.list();
    expect(row.booked).toBe(1);
    expect(row.spotsLeft).toBe(1);
    expect(row.full).toBe(false);
  });

  it("clamps spotsLeft at zero when a class is over capacity", async () => {
    const cls = await makeClass(db, { capacity: 1 });
    for (let i = 0; i < 3; i++) {
      const u = await makeUser(db);
      await seedBooking(db, { classId: cls.id, userId: u.id, status: "booked" });
    }

    const [row] = await callerFor(db, null).classes.list();
    expect(row.spotsLeft).toBe(0);
    expect(row.full).toBe(true);
  });

  it("NOTE finding 2: corporate bookings do not count toward the advertised spots", async () => {
    const cls = await makeClass(db, { capacity: 2 });
    const user = await makeUser(db);
    const company = await makeCompany(db);
    await linkToCompany(db, user.id, company.id);
    await seedCorporateBooking(db, {
      classId: cls.id,
      userId: user.id,
      companyId: company.id,
      status: "booked",
    });

    const [row] = await callerFor(db, null).classes.list();
    // The seat is taken, but the schedule still advertises two free.
    expect(row.spotsLeft).toBe(2);
  });

  it("shows the trainer name, or null when unassigned", async () => {
    const trainer = await makeTrainer(db, { name: "Arjun Mehta" });
    await makeClass(db, { trainerId: trainer.id, startsAt: hoursFromNow(1) });
    await makeClass(db, { trainerId: null, startsAt: hoursFromNow(2) });

    const rows = await callerFor(db, null).classes.list();
    expect(rows[0].trainerName).toBe("Arjun Mehta");
    expect(rows[1].trainerName).toBeNull();
  });
});

describe("classes.byId", () => {
  it("returns the class with its roster", async () => {
    const cls = await makeClass(db);
    const user = await makeUser(db, { name: "Sana" });
    await seedBooking(db, { classId: cls.id, userId: user.id, status: "booked" });

    const result = await callerFor(db, null).classes.byId({ id: cls.id });

    expect(result.id).toBe(cls.id);
    expect(result.roster).toHaveLength(1);
    expect(result.roster[0].memberName).toBe("Sana");
  });

  it("NOTE finding 7: the roster is public, exposing member names and emails to anyone", async () => {
    const cls = await makeClass(db);
    const user = await makeUser(db, { name: "Sana", email: "sana@private.test" });
    await seedBooking(db, { classId: cls.id, userId: user.id, status: "booked" });

    const result = await callerFor(db, null).classes.byId({ id: cls.id });
    expect(result.roster[0].memberEmail).toBe("sana@private.test");
  });

  it("rejects an unknown class", async () => {
    await expectTrpcError(callerFor(db, null).classes.byId({ id: 9999 }), "NOT_FOUND");
  });
});

describe("classes.create and update", () => {
  it("lets staff create a class", async () => {
    const trainer = await makeTrainer(db);
    const created = await callerFor(db, trainer).classes.create({
      name: "HIIT",
      room: "Studio B",
      capacity: 12,
      startsAt: hoursFromNow(24),
    });

    expect(created).toMatchObject({
      name: "HIIT",
      capacity: 12,
      durationMin: 60,
      creditCost: 1,
      cancelled: false,
    });
  });

  it("blocks members from creating classes", async () => {
    const user = await makeUser(db);
    await expectTrpcError(
      callerFor(db, user).classes.create({
        name: "HIIT",
        room: "B",
        capacity: 5,
        startsAt: hoursFromNow(24),
      }),
      "FORBIDDEN",
    );
  });

  it("NOTE finding 8: capacity can be lowered below the number already booked", async () => {
    const admin = await makeAdmin(db);
    const cls = await makeClass(db, { capacity: 10 });
    for (let i = 0; i < 3; i++) {
      const u = await makeUser(db);
      await seedBooking(db, { classId: cls.id, userId: u.id, status: "booked" });
    }

    const updated = await callerFor(db, admin).classes.update({ id: cls.id, capacity: 1 });

    // Three confirmed members now sit in a one-person room and nothing warns.
    expect(updated.capacity).toBe(1);
  });

  it("rejects updating an unknown class", async () => {
    const admin = await makeAdmin(db);
    await expectTrpcError(
      callerFor(db, admin).classes.update({ id: 9999, name: "x" }),
      "NOT_FOUND",
    );
  });
});

describe("classes.cancel", () => {
  it("marks the class cancelled and cancels its confirmed bookings", async () => {
    const admin = await makeAdmin(db);
    const cls = await makeClass(db);
    const user = await makeUser(db);
    const booking = await seedBooking(db, {
      classId: cls.id,
      userId: user.id,
      status: "booked",
      creditsUsed: 2,
    });

    const result = await callerFor(db, admin).classes.cancel({ id: cls.id });

    expect(result.cancelled).toBe(true);
    const after = await readBooking(db, booking.id);
    expect(after!.status).toBe("cancelled");
    expect(after!.cancelledAt).not.toBeNull();
  });

  it("NOTE finding 9: cancelling a class refunds nobody", async () => {
    const admin = await makeAdmin(db);
    const user = await makeUser(db);
    const membership = await makeMembership(db, user.id, { creditsRemaining: 10 });
    const cls = await makeClass(db, { creditCost: 3 });
    await callerFor(db, user).bookings.book({ classId: cls.id });

    await callerFor(db, admin).classes.cancel({ id: cls.id });

    const after = await db
      .select()
      .from(schema.memberships)
      .where(eq(schema.memberships.id, membership.id))
      .get();
    // The member paid 3 credits for a class the gym cancelled and keeps losing them.
    expect(after!.creditsRemaining).toBe(7);
  });

  it("NOTE finding 9: cancelling a class notifies nobody, though the notification type exists", async () => {
    const admin = await makeAdmin(db);
    const user = await makeUser(db);
    const cls = await makeClass(db);
    await seedBooking(db, { classId: cls.id, userId: user.id, status: "booked" });

    await callerFor(db, admin).classes.cancel({ id: cls.id });

    expect(await db.select().from(schema.notifications)).toEqual([]);
  });

  it("NOTE finding 10: leaves waitlisted bookings active and never touches corporate bookings", async () => {
    const admin = await makeAdmin(db);
    const cls = await makeClass(db, { capacity: 1 });

    const waiter = await makeUser(db);
    const wait = await seedBooking(db, {
      classId: cls.id,
      userId: waiter.id,
      status: "waitlisted",
    });

    const corp = await makeUser(db);
    const company = await makeCompany(db);
    await linkToCompany(db, corp.id, company.id);
    const corpBooking = await seedCorporateBooking(db, {
      classId: cls.id,
      userId: corp.id,
      companyId: company.id,
      status: "booked",
    });

    await callerFor(db, admin).classes.cancel({ id: cls.id });

    expect((await readBooking(db, wait.id))!.status).toBe("waitlisted");
    const corpAfter = await db
      .select()
      .from(schema.corporateBookings)
      .where(eq(schema.corporateBookings.id, corpBooking.id))
      .get();
    expect(corpAfter!.status).toBe("booked");
  });

  it("is admin only, not staff", async () => {
    const trainer = await makeTrainer(db);
    const cls = await makeClass(db);
    await expectTrpcError(callerFor(db, trainer).classes.cancel({ id: cls.id }), "FORBIDDEN");
  });
});

describe("admin.stats", () => {
  it("summarises members, memberships, classes, revenue and checkins", async () => {
    const admin = await makeAdmin(db);
    const m1 = await makeUser(db);
    const m2 = await makeUser(db);
    await makeMembership(db, m1.id);
    await makeMembership(db, m2.id, { status: "expired" });
    await makeClass(db, { startsAt: hoursFromNow(24) });
    await makeClass(db, { startsAt: hoursFromNow(-24) });

    await db.insert(schema.payments).values([
      { userId: m1.id, amountCents: 50_000, method: "card", status: "paid" },
      { userId: m1.id, amountCents: 10_000, method: "cash", status: "pending" },
    ]);
    await db.insert(schema.checkins).values({ userId: m1.id });

    const stats = await callerFor(db, admin).admin.stats();

    expect(stats).toEqual({
      totalMembers: 2,
      activeMemberships: 1,
      upcomingClasses: 1,
      revenueCents: 50_000,
      totalCheckins: 1,
      pendingPayments: 1,
    });
  });

  it("counts only users with the member role, excluding staff", async () => {
    const admin = await makeAdmin(db);
    await makeTrainer(db);
    await makeUser(db);

    expect((await callerFor(db, admin).admin.stats()).totalMembers).toBe(1);
  });

  it("is admin only", async () => {
    const trainer = await makeTrainer(db);
    await expectTrpcError(callerFor(db, trainer).admin.stats(), "FORBIDDEN");
  });
});

describe("admin reporting queries", () => {
  it("NOTE finding 11: classUtilisation reports the same wrong count for every class", async () => {
    const admin = await makeAdmin(db);
    const a = await makeClass(db, { name: "A", capacity: 3 });
    const b = await makeClass(db, { name: "B", capacity: 3 });

    // Every confirmed booking is on class B. Class A is empty.
    for (let i = 0; i < 3; i++) {
      const u = await makeUser(db);
      await seedBooking(db, { classId: b.id, userId: u.id, status: "booked" });
    }

    const rows = await callerFor(db, admin).admin.classUtilisation();

    // The correlated subquery renders its columns unqualified, so
    // "class_id" = "id" binds to bookings.id rather than classes.id. The
    // result is a per-class figure that does not depend on the class at all:
    // it counts bookings whose id happens to equal their own class_id.
    expect(rows.map((r) => r.name)).toEqual(["A", "B"]);
    expect(rows.map((r) => r.booked)).toEqual([1, 1]);
    // The empty class reports a third full; the full class reports the same.
    expect(rows[0].utilisation).toBeCloseTo(1 / 3);
    expect(rows[1].utilisation).toBeCloseTo(1 / 3);
  });

  it("classes.list counts correctly, because its join forces qualified columns", async () => {
    const a = await makeClass(db, { name: "A", capacity: 3, startsAt: hoursFromNow(1) });
    const b = await makeClass(db, { name: "B", capacity: 3, startsAt: hoursFromNow(2) });
    for (let i = 0; i < 3; i++) {
      const u = await makeUser(db);
      await seedBooking(db, { classId: b.id, userId: u.id, status: "booked" });
    }

    const rows = await callerFor(db, null).classes.list();

    expect(rows.map((r) => ({ name: r.name, booked: Number(r.booked), full: r.full }))).toEqual([
      { name: "A", booked: 0, full: false },
      { name: "B", booked: 3, full: true },
    ]);
    void a;
  });

  it("revenueByMethod groups paid payments and ignores the rest", async () => {
    const admin = await makeAdmin(db);
    const user = await makeUser(db);
    await db.insert(schema.payments).values([
      { userId: user.id, amountCents: 30_000, method: "card", status: "paid" },
      { userId: user.id, amountCents: 20_000, method: "card", status: "paid" },
      { userId: user.id, amountCents: 90_000, method: "upi", status: "refunded" },
    ]);

    const rows = await callerFor(db, admin).admin.revenueByMethod();
    expect(rows).toEqual([{ method: "card", totalCents: 50_000, count: 2 }]);
  });

  it("expiringMemberships covers active memberships ending in the next 14 days", async () => {
    const admin = await makeAdmin(db);
    const soon = await makeUser(db);
    const later = await makeUser(db);
    const { daysFromNow } = await import("./helpers/harness");
    await makeMembership(db, soon.id, { endDate: daysFromNow(7) });
    await makeMembership(db, later.id, { endDate: daysFromNow(40) });

    const rows = await callerFor(db, admin).admin.expiringMemberships();
    expect(rows.map((r) => r.memberId)).toEqual([soon.id]);
  });

  it("refundCount counts refunded payments", async () => {
    const admin = await makeAdmin(db);
    const user = await makeUser(db);
    await db.insert(schema.payments).values([
      { userId: user.id, amountCents: 1, method: "card", status: "refunded" },
      { userId: user.id, amountCents: 1, method: "card", status: "paid" },
    ]);

    expect(await callerFor(db, admin).admin.refundCount()).toEqual({ count: 1 });
  });

  it("noShowList reports recent no shows with their trainer", async () => {
    const admin = await makeAdmin(db);
    const trainer = await makeTrainer(db, { name: "Arjun" });
    const cls = await makeClass(db, { trainerId: trainer.id, startsAt: hoursFromNow(-24) });
    const user = await makeUser(db);
    await seedBooking(db, { classId: cls.id, userId: user.id, status: "no_show" });

    const rows = await callerFor(db, admin).admin.noShowList();
    expect(rows).toHaveLength(1);
    expect(rows[0].trainerName).toBe("Arjun");
  });

  it("topTrainers ranks by attended bookings in the last 14 days", async () => {
    const admin = await makeAdmin(db);
    const busy = await makeTrainer(db, { name: "Busy" });
    const quiet = await makeTrainer(db, { name: "Quiet" });
    const busyClass = await makeClass(db, { trainerId: busy.id, startsAt: hoursFromNow(-24) });
    const quietClass = await makeClass(db, { trainerId: quiet.id, startsAt: hoursFromNow(-24) });

    for (let i = 0; i < 2; i++) {
      const u = await makeUser(db);
      await seedBooking(db, { classId: busyClass.id, userId: u.id, status: "attended" });
    }
    const u = await makeUser(db);
    await seedBooking(db, { classId: quietClass.id, userId: u.id, status: "attended" });

    const rows = await callerFor(db, admin).admin.topTrainers();
    expect(rows.map((r) => r.trainerName)).toEqual(["Busy", "Quiet"]);
    expect(rows[0].attendedCount).toBe(2);
  });
});
