/**
 * Rules about a class that hold however the seat is being paid for.
 *
 * Both the personal and the corporate booking flow ran through this same
 * sequence of checks, in the same order, with the same messages. It lives here
 * once so the two cannot drift apart again.
 */
import { TRPCError } from "@trpc/server";
import { and, eq, inArray, sql } from "drizzle-orm";
import { bookings, classes, type GymClass } from "@/db/schema";
import { hoursUntil } from "@/server/shared/time";
import type { Db } from "@/server/shared/db";

/**
 * A table that can hold a seat in a class.
 *
 * `bookings` and `corporate_bookings` declare identical columns for everything
 * these rules touch — id, classId, userId, status, creditsUsed, bookedAt,
 * cancelledAt — and differ only in how ownership is recorded (membershipId
 * versus companyId), which callers supply separately. Typing against one of
 * them keeps Drizzle's inference intact inside this module; the single cast
 * that admits the other lives in index.ts, where it is visible.
 */
export type SeatTable = typeof bookings;

/** Statuses that occupy a place on the list, confirmed or waiting. */
export const ACTIVE_STATUSES = ["booked", "waitlisted"] as const;

export async function findClass(db: Db, classId: number): Promise<GymClass | undefined> {
  return db.select().from(classes).where(eq(classes.id, classId)).get();
}

/**
 * Loads a class and refuses it if it cannot take a new booking.
 *
 * Order matters and is preserved from the original: missing, then cancelled,
 * then already started. A caller passing a cancelled class that has also
 * started sees the cancellation message, as it always did.
 */
export async function loadBookableClass(db: Db, classId: number): Promise<GymClass> {
  const cls = await findClass(db, classId);

  if (!cls) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Class not found." });
  }
  if (cls.cancelled) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "This class has been cancelled.",
    });
  }
  if (hoursUntil(cls.startsAt) <= 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "This class has already started.",
    });
  }

  return cls;
}

/**
 * Refuses a member who already holds a booked or waitlisted place.
 *
 * Cancelled, attended and no-show rows are ignored, so a member who cancelled
 * can book the same class again.
 */
export async function assertNotAlreadyListed(
  db: Db,
  table: SeatTable,
  classId: number,
  userId: number,
): Promise<void> {
  const existing = await db
    .select()
    .from(table)
    .where(
      and(
        eq(table.classId, classId),
        eq(table.userId, userId),
        inArray(table.status, [...ACTIVE_STATUSES]),
      ),
    )
    .get();

  if (existing) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "You are already on the list for this class.",
    });
  }
}

/**
 * How many confirmed seats this table holds for the class.
 *
 * Note that each table is counted on its own, which is why a class can be
 * filled twice over. Preserved deliberately: see documents/findings.md,
 * finding 2. When that is fixed, this is the one function that changes.
 */
export async function countConfirmedSeats(
  db: Db,
  table: SeatTable,
  classId: number,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(table)
    .where(and(eq(table.classId, classId), eq(table.status, "booked")));

  return Number(row?.count ?? 0);
}

/** Whether a new booking would have to go on the waitlist. */
export async function isAtCapacity(
  db: Db,
  table: SeatTable,
  cls: Pick<GymClass, "id" | "capacity">,
): Promise<boolean> {
  return (await countConfirmedSeats(db, table, cls.id)) >= cls.capacity;
}
