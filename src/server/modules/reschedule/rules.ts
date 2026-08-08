/**
 * Whether a member may move from one booking to another sitting of the class.
 *
 * These ten rules were written out twice in reschedules.ts: once in the
 * mutation, which threw a TRPCError, and once in the query, which returned
 * `{ valid, reason }`. Same checks, same order, same wording, maintained in
 * parallel by hand.
 *
 * They are evaluated once here and returned as data. The mutation turns a
 * failure into a throw, the query reports it. Neither can drift from the other
 * because there is only one copy.
 */
import { TRPCError } from "@trpc/server";
import { and, eq, sql } from "drizzle-orm";
import { bookings, classes, type Booking, type GymClass } from "@/db/schema";
import { hoursUntil } from "@/server/shared/time";
import { FREE_RESCHEDULE_HOURS } from "@/server/shared/policy";
import type { Db } from "@/server/shared/db";

type FailureCode = "NOT_FOUND" | "FORBIDDEN" | "BAD_REQUEST" | "CONFLICT";

export type RescheduleCheck =
  | {
      valid: false;
      /** The code the mutation throws. The query reports only `reason`. */
      code: FailureCode;
      reason: string;
    }
  | {
      valid: true;
      booking: Booking;
      originalClass: GymClass;
      targetClass: GymClass;
      /** The move is still allowed when full; the member lands on the waitlist. */
      targetIsFull: boolean;
    };

const fail = (code: FailureCode, reason: string): RescheduleCheck => ({
  valid: false,
  code,
  reason,
});

/**
 * Runs the rules in their original order.
 *
 * The order is load-bearing: a caller passing a booking that is both
 * unowned and inactive gets the ownership message, as it always did.
 */
export async function evaluateReschedule(
  db: Db,
  userId: number,
  fromBookingId: number,
  toClassId: number,
): Promise<RescheduleCheck> {
  const original = await db
    .select({ booking: bookings, cls: classes })
    .from(bookings)
    .innerJoin(classes, eq(bookings.classId, classes.id))
    .where(eq(bookings.id, fromBookingId))
    .get();

  if (!original) {
    return fail("NOT_FOUND", "Booking not found.");
  }

  const { booking, cls: originalClass } = original;

  if (booking.userId !== userId) {
    return fail("FORBIDDEN", "You cannot reschedule this booking.");
  }

  if (booking.status !== "booked" && booking.status !== "waitlisted") {
    return fail("BAD_REQUEST", "This booking is no longer active.");
  }

  if (hoursUntil(originalClass.startsAt) < FREE_RESCHEDULE_HOURS) {
    return fail(
      "BAD_REQUEST",
      `You can only reschedule up to ${FREE_RESCHEDULE_HOURS} hours before the class starts.`,
    );
  }

  const targetClass = await db
    .select()
    .from(classes)
    .where(eq(classes.id, toClassId))
    .get();

  if (!targetClass) {
    return fail("NOT_FOUND", "Target class not found.");
  }

  // Matching on the name is what makes this a reschedule rather than a swap
  // for something else. It also means two unrelated classes that happen to
  // share a name are interchangeable.
  if (targetClass.name !== originalClass.name) {
    return fail("BAD_REQUEST", "You can only reschedule to a class with the same name.");
  }

  if (targetClass.id === originalClass.id) {
    return fail("BAD_REQUEST", "You are already booked for this class.");
  }

  if (hoursUntil(targetClass.startsAt) <= 0) {
    return fail("BAD_REQUEST", "This class has already started.");
  }

  if (targetClass.cancelled) {
    return fail("BAD_REQUEST", "This class has been cancelled.");
  }

  const clash = await db
    .select()
    .from(bookings)
    .where(
      and(
        eq(bookings.classId, targetClass.id),
        eq(bookings.userId, userId),
        sql`${bookings.status} in ('booked', 'waitlisted')`,
      ),
    )
    .get();

  if (clash) {
    return fail("CONFLICT", "You already have an active booking for this class.");
  }

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(bookings)
    .where(and(eq(bookings.classId, targetClass.id), eq(bookings.status, "booked")));

  return {
    valid: true,
    booking,
    originalClass,
    targetClass,
    targetIsFull: Number(count) >= targetClass.capacity,
  };
}

/** Turns a failed check into the error the mutation raises. */
export function toTRPCError(check: Extract<RescheduleCheck, { valid: false }>): TRPCError {
  return new TRPCError({ code: check.code, message: check.reason });
}
