/**
 * Booking and cancelling a seat.
 *
 * bookings.ts and corporate-bookings.ts ran the same two routines against
 * different tables and different credit sources. Both now call the functions
 * here, configured with a table and a ledger. The behaviour of each flow is
 * unchanged, including the places where the two disagree — those live in
 * ledger.ts, where they can be read side by side.
 */
import { TRPCError } from "@trpc/server";
import { and, asc, eq } from "drizzle-orm";
import { classes, type GymClass, type User } from "@/db/schema";
import { hoursUntil } from "@/server/shared/time";
import type { Db } from "@/server/shared/db";
import type { SeatLedger } from "./ledger";
import {
  loadBookableClass,
  assertNotAlreadyListed,
  isAtCapacity,
  type SeatTable,
} from "./rules";

/** A booking row, in whichever of the two shapes this flow uses. */
type SeatRow = {
  id: number;
  classId: number;
  userId: number;
  status: string;
  creditsUsed: number;
};

export interface SeatFlow<TAccount, TBooking> {
  /** Puts the member in the class, or on the waitlist when it is full. */
  book(db: Db, userId: number, classId: number): Promise<TBooking>;
  /** Releases a seat, settling credits and promoting the waitlist. */
  cancel(
    db: Db,
    actor: Pick<User, "id" | "role">,
    bookingId: number,
  ): Promise<{ ok: true; refunded: boolean }>;
}

/**
 * Builds the pair of operations for one kind of seat.
 *
 * `table` decides which rows are read and written; `ledger` decides who pays.
 * Nothing else differs between the personal and corporate flows.
 */
export function createSeatFlow<TAccount, TBooking extends SeatRow>(
  table: SeatTable,
  ledger: SeatLedger<TAccount, TBooking>,
): SeatFlow<TAccount, TBooking> {
  /**
   * Confirms the member who has waited longest, if there is one.
   *
   * Only called when a *confirmed* seat is released — releasing a waitlisted
   * place moves nobody, because no seat was freed.
   */
  async function promoteNextInLine(db: Db, cls: Pick<GymClass, "id" | "creditCost">) {
    const next = (await db
      .select()
      .from(table)
      .where(and(eq(table.classId, cls.id), eq(table.status, "waitlisted")))
      .orderBy(asc(table.bookedAt))
      .get()) as TBooking | undefined;

    if (!next) return;

    await db
      .update(table)
      .set({ status: "booked", creditsUsed: cls.creditCost })
      .where(eq(table.id, next.id));

    // The seat is granted before payment is attempted, and each ledger handles
    // an unaffordable promotion differently. Findings 1 and 3.
    await ledger.debitOnPromotion(db, next, cls.creditCost);
  }

  return {
    async book(db, userId, classId) {
      const cls = await loadBookableClass(db, classId);
      await assertNotAlreadyListed(db, table, cls.id, userId);

      const account = await ledger.requireAccount(db, userId);
      ledger.assertCanAfford(account, cls.creditCost);

      const full = await isAtCapacity(db, table, cls);

      const created = (await db
        .insert(table)
        .values({
          classId: cls.id,
          userId,
          ...ledger.ownerColumns(account),
          status: full ? "waitlisted" : "booked",
          // A waitlisted place costs nothing until it is promoted.
          creditsUsed: full ? 0 : cls.creditCost,
        })
        .returning()
        .get()) as unknown as TBooking;

      if (!full) {
        await ledger.debitOnBook(db, account, cls.creditCost);
      }

      return created;
    },

    async cancel(db, actor, bookingId) {
      const row = (await db
        .select({ booking: table, cls: classes })
        .from(table)
        .innerJoin(classes, eq(table.classId, classes.id))
        .where(eq(table.id, bookingId))
        .get()) as { booking: TBooking; cls: GymClass } | undefined;

      if (!row) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Booking not found." });
      }

      const isOwner = row.booking.userId === actor.id;
      const isStaff = actor.role === "admin" || actor.role === "trainer";
      if (!isOwner && !isStaff) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You cannot cancel this booking.",
        });
      }

      if (row.booking.status !== "booked" && row.booking.status !== "waitlisted") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "This booking is no longer active.",
        });
      }

      const refunded =
        hoursUntil(row.cls.startsAt) >= ledger.freeCancellationHours &&
        row.booking.creditsUsed > 0;

      await db
        .update(table)
        .set({ status: "cancelled", cancelledAt: new Date().toISOString() })
        .where(eq(table.id, row.booking.id));

      if (refunded) {
        await ledger.refund(db, row.booking);
      }

      // Only a confirmed booking was occupying a seat worth passing on.
      if (row.booking.status === "booked") {
        await promoteNextInLine(db, row.cls);
      }

      return { ok: true as const, refunded };
    },
  };
}
