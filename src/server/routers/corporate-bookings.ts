/**
 * Corporate bookings: transport only.
 *
 * book and cancel are the same operations as the personal flow, configured
 * with the corporate table and the company credit pool. See
 * server/modules/booking.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { asc, eq } from "drizzle-orm";
import { corporateBookings, classes, companies, checkins, users } from "@/db/schema";
import { router, protectedProcedure, staffProcedure } from "../trpc";
import { corporateSeats } from "../modules/booking";

export const corporateBookingsRouter = router({
  mine: protectedProcedure
    .input(z.object({ includePast: z.boolean().default(false) }).default({}))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db
        .select({
          id: corporateBookings.id,
          status: corporateBookings.status,
          creditsUsed: corporateBookings.creditsUsed,
          bookedAt: corporateBookings.bookedAt,
          classId: classes.id,
          className: classes.name,
          room: classes.room,
          startsAt: classes.startsAt,
          durationMin: classes.durationMin,
          cancelled: classes.cancelled,
          companyName: companies.name,
        })
        .from(corporateBookings)
        .innerJoin(classes, eq(corporateBookings.classId, classes.id))
        .innerJoin(companies, eq(corporateBookings.companyId, companies.id))
        .where(eq(corporateBookings.userId, ctx.user.id))
        .orderBy(asc(classes.startsAt));

      const now = new Date();
      return rows.filter((r) => (input.includePast ? true : new Date(r.startsAt) >= now));
    }),

  book: protectedProcedure
    .input(z.object({ classId: z.number() }))
    .mutation(({ ctx, input }) => corporateSeats.book(ctx.db, ctx.user.id, input.classId)),

  cancel: protectedProcedure
    .input(z.object({ bookingId: z.number() }))
    .mutation(({ ctx, input }) => corporateSeats.cancel(ctx.db, ctx.user, input.bookingId)),

  markAttended: staffProcedure
    .input(
      z.object({
        bookingId: z.number(),
        source: z.enum(["front_desk", "kiosk", "app"]).default("front_desk"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const booking = await ctx.db
        .select()
        .from(corporateBookings)
        .where(eq(corporateBookings.id, input.bookingId))
        .get();

      if (!booking) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Booking not found." });
      }
      if (booking.status !== "booked") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Only confirmed bookings can be checked in.",
        });
      }

      await ctx.db
        .update(corporateBookings)
        .set({ status: "attended" })
        .where(eq(corporateBookings.id, booking.id));

      // checkins.bookingId is a foreign key into `bookings`, so a corporate
      // booking id cannot be stored here and the link is dropped. `source` is
      // accepted above and then ignored. Both preserved: finding 4.
      await ctx.db.insert(checkins).values({
        userId: booking.userId,
        bookingId: null,
      });

      return { ok: true };
    }),

  rosterFor: staffProcedure
    .input(z.object({ classId: z.number() }))
    .query(({ ctx, input }) =>
      ctx.db
        .select({
          bookingId: corporateBookings.id,
          status: corporateBookings.status,
          memberId: users.id,
          memberName: users.name,
          memberEmail: users.email,
          bookedAt: corporateBookings.bookedAt,
          companyName: companies.name,
        })
        .from(corporateBookings)
        .innerJoin(users, eq(corporateBookings.userId, users.id))
        .innerJoin(companies, eq(corporateBookings.companyId, companies.id))
        .where(eq(corporateBookings.classId, input.classId))
        .orderBy(asc(corporateBookings.bookedAt)),
    ),
});
