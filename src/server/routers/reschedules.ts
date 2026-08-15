/**
 * Rescheduling: transport only.
 *
 * The rules live in server/modules/reschedule. This file decides what to do
 * with the answer — throw, or report it.
 */
import { z } from "zod";
import { desc, eq, sql } from "drizzle-orm";
import { reschedules, bookings, classes } from "@/db/schema";
import { router, protectedProcedure } from "../trpc";
import { evaluateReschedule, toTRPCError } from "../modules/reschedule/rules";
import { personalSeats } from "../modules/booking";

const rescheduleInput = z.object({
  fromBookingId: z.number(),
  toClassId: z.number(),
});

export const reschedulesRouter = router({
  reschedule: protectedProcedure
    .input(rescheduleInput)
    .mutation(async ({ ctx, input }) => {
      const check = await evaluateReschedule(
        ctx.db,
        ctx.user.id,
        input.fromBookingId,
        input.toClassId,
      );

      if (!check.valid) throw toTRPCError(check);

      const { booking, originalClass, targetClass, targetIsFull } = check;

      // The credits already spent carry across, so the move itself is free.
      // A waitlisted booking spent nothing, so it stays free even when the
      // move confirms a seat.
      const newBooking = await ctx.db
        .insert(bookings)
        .values({
          classId: targetClass.id,
          userId: ctx.user.id,
          membershipId: booking.membershipId,
          status: targetIsFull ? "waitlisted" : "booked",
          creditsUsed: booking.creditsUsed,
        })
        .returning()
        .get();

      await ctx.db
        .update(bookings)
        .set({ status: "cancelled", cancelledAt: new Date().toISOString() })
        .where(eq(bookings.id, booking.id));

      // Fixed: finding 6. Releasing a confirmed seat here now promotes the
      // waitlist the same way bookings.cancel does — only a `booked` (not
      // `waitlisted`) original was occupying a seat worth passing on.
      if (booking.status === "booked") {
        await personalSeats.promoteNextInLine(ctx.db, originalClass);
      }

      await ctx.db.insert(reschedules).values({
        userId: ctx.user.id,
        fromBookingId: booking.id,
        toBookingId: newBooking.id,
        fromClassId: originalClass.id,
        toClassId: targetClass.id,
      });

      return {
        ok: true,
        newBooking,
        newStatus: targetIsFull ? "waitlisted" : "booked",
      };
    }),

  /** Same rules, reported rather than thrown, so the modal can grey out options. */
  validateReschedule: protectedProcedure
    .input(rescheduleInput)
    .query(async ({ ctx, input }) => {
      const check = await evaluateReschedule(
        ctx.db,
        ctx.user.id,
        input.fromBookingId,
        input.toClassId,
      );

      return check.valid
        ? { valid: true, targetIsFull: check.targetIsFull }
        : { valid: false, reason: check.reason };
    }),

  history: protectedProcedure.query(({ ctx }) =>
    ctx.db
      .select({
        id: reschedules.id,
        rescheduledAt: reschedules.rescheduledAt,
        fromClassName: classes.name,
        fromClassTime: sql<string>`(
          SELECT ${classes.startsAt} FROM ${classes}
          WHERE ${classes.id} = ${reschedules.fromClassId}
        )`,
        fromClassRoom: sql<string>`(
          SELECT ${classes.room} FROM ${classes}
          WHERE ${classes.id} = ${reschedules.fromClassId}
        )`,
        toClassName: sql<string>`(
          SELECT ${classes.name} FROM ${classes}
          WHERE ${classes.id} = ${reschedules.toClassId}
        )`,
        toClassTime: sql<string>`(
          SELECT ${classes.startsAt} FROM ${classes}
          WHERE ${classes.id} = ${reschedules.toClassId}
        )`,
        toClassRoom: sql<string>`(
          SELECT ${classes.room} FROM ${classes}
          WHERE ${classes.id} = ${reschedules.toClassId}
        )`,
      })
      .from(reschedules)
      .innerJoin(classes, eq(reschedules.fromClassId, classes.id))
      .where(eq(reschedules.userId, ctx.user.id))
      .orderBy(desc(reschedules.rescheduledAt)),
  ),
});
