/**
 * Characterization tests for trainer availability, notifications and the
 * corporate company admin.
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
  makeClass,
  makeCompany,
  linkToCompany,
  seedCorporateBooking,
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

describe("trainers.upcomingClasses", () => {
  it("returns the trainer's own future, uncancelled classes", async () => {
    const trainer = await makeTrainer(db);
    const other = await makeTrainer(db);

    const mine = await makeClass(db, { trainerId: trainer.id, startsAt: hoursFromNow(24) });
    await makeClass(db, { trainerId: trainer.id, startsAt: hoursFromNow(-24) });
    await makeClass(db, { trainerId: trainer.id, startsAt: hoursFromNow(24), cancelled: true });
    await makeClass(db, { trainerId: other.id, startsAt: hoursFromNow(24) });

    const rows = await callerFor(db, trainer).trainers.upcomingClasses();
    expect(rows.map((r) => r.id)).toEqual([mine.id]);
  });

  it("NOTE finding 17: rejects admins, because the role check is trainer-only", async () => {
    const admin = await makeAdmin(db);
    // Every other staff surface treats admin as a superset of trainer. These
    // four procedures hand-roll the check and lock admins out instead.
    await expectTrpcError(callerFor(db, admin).trainers.upcomingClasses(), "FORBIDDEN");
    await expectTrpcError(callerFor(db, admin).trainers.availability(), "FORBIDDEN");
    await expectTrpcError(
      callerFor(db, admin).trainers.setAvailability({
        dayOfWeek: 1,
        startTime: "09:00",
        endTime: "17:00",
      }),
      "FORBIDDEN",
    );
    await expectTrpcError(
      callerFor(db, admin).trainers.removeAvailability({ dayOfWeek: 1 }),
      "FORBIDDEN",
    );
  });

  it("rejects members", async () => {
    const member = await makeUser(db);
    await expectTrpcError(callerFor(db, member).trainers.upcomingClasses(), "FORBIDDEN");
  });
});

describe("trainers.setAvailability", () => {
  it("inserts one row per weekday and overwrites on a repeat call", async () => {
    const trainer = await makeTrainer(db);
    const caller = callerFor(db, trainer);

    await caller.trainers.setAvailability({ dayOfWeek: 1, startTime: "09:00", endTime: "17:00" });
    await caller.trainers.setAvailability({ dayOfWeek: 1, startTime: "06:00", endTime: "12:00" });
    await caller.trainers.setAvailability({ dayOfWeek: 2, startTime: "09:00", endTime: "17:00" });

    const rows = await caller.trainers.availability();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ dayOfWeek: 1, startTime: "06:00", endTime: "12:00" });
  });

  it("does not validate that the end time is after the start time", async () => {
    const trainer = await makeTrainer(db);
    await expect(
      callerFor(db, trainer).trainers.setAvailability({
        dayOfWeek: 3,
        startTime: "18:00",
        endTime: "09:00",
      }),
    ).resolves.toMatchObject({ startTime: "18:00", endTime: "09:00" });
  });

  it("removeAvailability is a no-op when nothing is set", async () => {
    const trainer = await makeTrainer(db);
    await expect(
      callerFor(db, trainer).trainers.removeAvailability({ dayOfWeek: 5 }),
    ).resolves.toEqual({ success: true });
  });
});

describe("trainers.checkAvailability", () => {
  /** Builds an ISO timestamp at a given UTC weekday and hour. */
  function atUtc(dayOfWeek: number, hour: number): string {
    const d = new Date();
    d.setUTCHours(hour, 0, 0, 0);
    const shift = (dayOfWeek - d.getUTCDay() + 7) % 7 || 7;
    d.setUTCDate(d.getUTCDate() + shift);
    return d.toISOString();
  }

  it("says unavailable when the trainer has set nothing for that day", async () => {
    const admin = await makeAdmin(db);
    const trainer = await makeTrainer(db);

    expect(
      await callerFor(db, admin).trainers.checkAvailability({
        trainerId: trainer.id,
        startsAt: atUtc(2, 10),
        durationMin: 60,
      }),
    ).toEqual({ available: false, reason: "No availability set for this day" });
  });

  it("accepts a class that sits inside the declared window", async () => {
    const admin = await makeAdmin(db);
    const trainer = await makeTrainer(db);
    await db.insert(schema.trainerAvailability).values({
      trainerId: trainer.id,
      dayOfWeek: 2,
      startTime: "09:00",
      endTime: "17:00",
    });

    expect(
      await callerFor(db, admin).trainers.checkAvailability({
        trainerId: trainer.id,
        startsAt: atUtc(2, 10),
        durationMin: 60,
      }),
    ).toEqual({ available: true });
  });

  it("rejects a class that runs past the end of the window", async () => {
    const admin = await makeAdmin(db);
    const trainer = await makeTrainer(db);
    await db.insert(schema.trainerAvailability).values({
      trainerId: trainer.id,
      dayOfWeek: 2,
      startTime: "09:00",
      endTime: "11:00",
    });

    expect(
      await callerFor(db, admin).trainers.checkAvailability({
        trainerId: trainer.id,
        startsAt: atUtc(2, 10),
        durationMin: 120,
      }),
    ).toEqual({ available: false, reason: "Outside availability hours" });
  });

  it("detects an overlap with a class the trainer already has", async () => {
    const admin = await makeAdmin(db);
    const trainer = await makeTrainer(db);
    await db.insert(schema.trainerAvailability).values({
      trainerId: trainer.id,
      dayOfWeek: 2,
      startTime: "00:00",
      endTime: "23:59",
    });
    await makeClass(db, {
      trainerId: trainer.id,
      startsAt: atUtc(2, 10),
      durationMin: 60,
    });

    expect(
      await callerFor(db, admin).trainers.checkAvailability({
        trainerId: trainer.id,
        startsAt: atUtc(2, 10),
        durationMin: 60,
      }),
    ).toEqual({ available: false, reason: "Trainer already has a class at this time" });
  });

  it("NOTE finding 18: the window comparison is done in UTC, not the studio's timezone", async () => {
    const admin = await makeAdmin(db);
    const trainer = await makeTrainer(db);

    // A 09:00-17:00 window means 09:00-17:00 India time to whoever typed it,
    // but checkAvailability reads the class start with getUTCHours(). A class
    // at 09:30 IST is 04:00 UTC and is refused as outside the window.
    await db.insert(schema.trainerAvailability).values({
      trainerId: trainer.id,
      dayOfWeek: 2,
      startTime: "09:00",
      endTime: "17:00",
    });

    const result = await callerFor(db, admin).trainers.checkAvailability({
      trainerId: trainer.id,
      startsAt: atUtc(2, 4),
      durationMin: 60,
    });

    expect(result).toEqual({ available: false, reason: "Outside availability hours" });
  });

  it("NOTE finding 19: nothing calls it, so classes.create never checks availability", async () => {
    const admin = await makeAdmin(db);
    const trainer = await makeTrainer(db);
    await makeClass(db, { trainerId: trainer.id, startsAt: hoursFromNow(24), durationMin: 60 });

    // Double-booking the same trainer at the same moment is accepted.
    await expect(
      callerFor(db, admin).classes.create({
        name: "Clash",
        room: "Studio B",
        capacity: 10,
        trainerId: trainer.id,
        startsAt: hoursFromNow(24),
        durationMin: 60,
      }),
    ).resolves.toMatchObject({ name: "Clash" });
  });

  it("lets any trainer inspect any other trainer's availability", async () => {
    const snooper = await makeTrainer(db);
    const subject = await makeTrainer(db);

    await expect(
      callerFor(db, snooper).trainers.checkAvailability({
        trainerId: subject.id,
        startsAt: hoursFromNow(24),
        durationMin: 60,
      }),
    ).resolves.toMatchObject({ available: false });
  });
});

describe("notifications", () => {
  it("lists only the signed in member's notifications, newest first", async () => {
    const user = await makeUser(db);
    const other = await makeUser(db);
    await db.insert(schema.notifications).values([
      { userId: user.id, type: "announcement", title: "Mine", message: "m" },
      { userId: other.id, type: "announcement", title: "Theirs", message: "m" },
    ]);

    const rows = await callerFor(db, user).notifications.list();
    expect(rows.map((r) => r.title)).toEqual(["Mine"]);
  });

  it("counts unread and clears them all at once", async () => {
    const user = await makeUser(db);
    await db.insert(schema.notifications).values([
      { userId: user.id, type: "announcement", title: "a", message: "m" },
      { userId: user.id, type: "announcement", title: "b", message: "m", read: true },
    ]);

    expect(await callerFor(db, user).notifications.unreadCount()).toBe(1);
    await callerFor(db, user).notifications.markAllAsRead();
    expect(await callerFor(db, user).notifications.unreadCount()).toBe(0);
  });

  it("broadcast writes one announcement per member and skips staff", async () => {
    const admin = await makeAdmin(db);
    await makeUser(db);
    await makeUser(db);
    await makeTrainer(db);

    const result = await callerFor(db, admin).notifications.broadcast({
      title: "Closed Monday",
      message: "The studio is shut for maintenance.",
    });

    expect(result).toEqual({ ok: true, count: 2 });
    const rows = await db.select().from(schema.notifications);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.type === "announcement")).toBe(true);
  });

  it("NOTE finding 20: broadcast reaches deactivated members despite the variable name", async () => {
    const admin = await makeAdmin(db);
    await makeUser(db, { active: true });
    await makeUser(db, { active: false });

    // The query is named activeMembers but filters on role only.
    const result = await callerFor(db, admin).notifications.broadcast({
      title: "t",
      message: "m",
    });
    expect(result.count).toBe(2);
  });

  it("broadcast is admin only", async () => {
    const trainer = await makeTrainer(db);
    await expectTrpcError(
      callerFor(db, trainer).notifications.broadcast({ title: "t", message: "m" }),
      "FORBIDDEN",
    );
  });

  it("NOTE finding 21: no procedure ever writes the three non-announcement types", async () => {
    // waitlist_promotion, class_cancelled and membership_expiring are declared
    // in the schema and rendered by the notifications page, but broadcast is
    // the only writer in the app and it always sends "announcement".
    const admin = await makeAdmin(db);
    const user = await makeUser(db);
    const cls = await makeClass(db, { capacity: 1 });
    await db
      .insert(schema.bookings)
      .values({ classId: cls.id, userId: user.id, status: "booked" });

    await callerFor(db, admin).classes.cancel({ id: cls.id });

    expect(await db.select().from(schema.notifications)).toEqual([]);
  });
});

describe("adminCompanies", () => {
  it("creates a company, tops it up and links a member", async () => {
    const admin = await makeAdmin(db);
    const caller = callerFor(db, admin);

    const company = await caller.adminCompanies.create({
      name: "Acme",
      contactEmail: "hr@acme.test",
      creditPoolBalance: 50,
    });
    expect(company).toMatchObject({ name: "Acme", creditPoolBalance: 50, active: true });

    expect((await caller.adminCompanies.topUp({ id: company.id, amount: 25 })).creditPoolBalance)
      .toBe(75);

    const member = await makeUser(db);
    await caller.adminCompanies.linkMember({ companyId: company.id, userId: member.id });

    const detail = await caller.adminCompanies.getById({ id: company.id });
    expect(detail.members.map((m) => m.id)).toEqual([member.id]);
  });

  it("refuses to link a non-member or link the same member twice", async () => {
    const admin = await makeAdmin(db);
    const caller = callerFor(db, admin);
    const company = await makeCompany(db);
    const trainer = await makeTrainer(db);

    await expectTrpcError(
      caller.adminCompanies.linkMember({ companyId: company.id, userId: trainer.id }),
      "BAD_REQUEST",
    );

    const member = await makeUser(db);
    await caller.adminCompanies.linkMember({ companyId: company.id, userId: member.id });
    await expectTrpcError(
      caller.adminCompanies.linkMember({ companyId: company.id, userId: member.id }),
      "CONFLICT",
    );
  });

  it("NOTE finding 22: a member can be linked to several companies at once", async () => {
    const admin = await makeAdmin(db);
    const caller = callerFor(db, admin);
    const a = await makeCompany(db);
    const b = await makeCompany(db);
    const member = await makeUser(db);

    await caller.adminCompanies.linkMember({ companyId: a.id, userId: member.id });
    await caller.adminCompanies.linkMember({ companyId: b.id, userId: member.id });

    // The uniqueness check is per pair, so nothing stops a second link.
    // getCompanyForMember then picks whichever row comes back first and bills
    // that company, with no rule saying which one it should be.
    const links = await db
      .select()
      .from(schema.companyMembers)
      .where(eq(schema.companyMembers.userId, member.id));
    expect(links).toHaveLength(2);
  });

  it("NOTE finding 23: deactivating a company strands its members' existing bookings", async () => {
    const admin = await makeAdmin(db);
    const company = await makeCompany(db);
    const member = await makeUser(db);
    await linkToCompany(db, member.id, company.id);
    const cls = await makeClass(db, { startsAt: hoursFromNow(48) });
    const booking = await seedCorporateBooking(db, {
      classId: cls.id,
      userId: member.id,
      companyId: company.id,
      status: "booked",
      creditsUsed: 1,
    });

    await callerFor(db, admin).adminCompanies.updateActive({ id: company.id, active: false });

    // The booking stays confirmed, but the member can no longer cancel it for
    // a refund through the corporate flow, because that path needs an active
    // company. The seat is held and the credit is unrecoverable.
    const after = await db
      .select()
      .from(schema.corporateBookings)
      .where(eq(schema.corporateBookings.id, booking.id))
      .get();
    expect(after!.status).toBe("booked");
  });

  it("unlinking a member leaves their past corporate bookings in place", async () => {
    const admin = await makeAdmin(db);
    const company = await makeCompany(db);
    const member = await makeUser(db);
    const link = await linkToCompany(db, member.id, company.id);
    const cls = await makeClass(db);
    await seedCorporateBooking(db, {
      classId: cls.id,
      userId: member.id,
      companyId: company.id,
      status: "attended",
    });

    await callerFor(db, admin).adminCompanies.unlinkMember({ companyMemberId: link.id });

    const detail = await callerFor(db, admin).adminCompanies.getById({ id: company.id });
    expect(detail.members).toEqual([]);
    expect(detail.recentBookings).toHaveLength(1);
  });

  it("is admin only", async () => {
    const trainer = await makeTrainer(db);
    await expectTrpcError(callerFor(db, trainer).adminCompanies.list(), "FORBIDDEN");
  });
});
