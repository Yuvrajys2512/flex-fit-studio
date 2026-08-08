/**
 * Personal bookings: transport only.
 *
 * The booking and cancellation rules live in server/modules/booking. What is
 * left here is input validation, the queries that feed a specific screen, and
 * the mapping from one to the other.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, sql } from "drizzle-orm";
import { bookings, classes, checkins, users } from "@/db/schema";
import { router, protectedProcedure, staffProcedure } from "../trpc";
import { personalSeats } from "../modules/booking";

export const bookingsRouter = router({
  /** Everything this member has booked. Past classes are excluded by default. */
  mine: protectedProcedure
    .input(z.object({ includePast: z.boolean().default(false) }).default({}))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db
        .select({
          id: bookings.id,
          status: bookings.status,
          creditsUsed: bookings.creditsUsed,
          bookedAt: bookings.bookedAt,
          classId: classes.id,
          className: classes.name,
          room: classes.room,
          startsAt: classes.startsAt,
          durationMin: classes.durationMin,
          cancelled: classes.cancelled,
        })
        .from(bookings)
        .innerJoin(classes, eq(bookings.classId, classes.id))
        .where(eq(bookings.userId, ctx.user.id))
        .orderBy(asc(classes.startsAt));

      const now = new Date();
      return rows.filter((r) => (input.includePast ? true : new Date(r.startsAt) >= now));
    }),

  book: protectedProcedure
    .input(z.object({ classId: z.number() }))
    .mutation(({ ctx, input }) => personalSeats.book(ctx.db, ctx.user.id, input.classId)),

  cancel: protectedProcedure
    .input(z.object({ bookingId: z.number() }))
    .mutation(({ ctx, input }) => personalSeats.cancel(ctx.db, ctx.user, input.bookingId)),

  /** Front desk and kiosk check-in. */
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
        .from(bookings)
        .where(eq(bookings.id, input.bookingId))
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
        .update(bookings)
        .set({ status: "attended" })
        .where(eq(bookings.id, booking.id));

      await ctx.db.insert(checkins).values({
        userId: booking.userId,
        bookingId: booking.id,
        source: input.source,
      });

      return { ok: true };
    }),

  /** Everyone on the list for a class, in the order they joined. */
  rosterFor: staffProcedure
    .input(z.object({ classId: z.number() }))
    .query(({ ctx, input }) =>
      ctx.db
        .select({
          bookingId: bookings.id,
          status: bookings.status,
          memberId: users.id,
          memberName: users.name,
          memberEmail: users.email,
          bookedAt: bookings.bookedAt,
        })
        .from(bookings)
        .innerJoin(users, eq(bookings.userId, users.id))
        .where(eq(bookings.classId, input.classId))
        .orderBy(asc(bookings.bookedAt)),
    ),

  /** Drives the kiosk: what this member could be checked in to right now. */
  upcomingForMember: staffProcedure
    .input(z.object({ userId: z.number(), hoursAhead: z.number().default(2) }))
    .query(({ ctx, input }) => {
      const now = new Date().toISOString();
      const until = new Date(Date.now() + input.hoursAhead * 3600_000).toISOString();

      return ctx.db
        .select({
          bookingId: bookings.id,
          bookingStatus: bookings.status,
          classId: classes.id,
          className: classes.name,
          room: classes.room,
          startsAt: classes.startsAt,
          durationMin: classes.durationMin,
          capacity: classes.capacity,
          trainerId: classes.trainerId,
          trainerName: users.name,
        })
        .from(bookings)
        .innerJoin(classes, eq(bookings.classId, classes.id))
        .leftJoin(users, eq(classes.trainerId, users.id))
        .where(
          and(
            eq(bookings.userId, input.userId),
            eq(bookings.status, "booked"),
            sql`${classes.startsAt} >= ${now}`,
            sql`${classes.startsAt} <= ${until}`,
            eq(classes.cancelled, false),
          ),
        )
        .orderBy(classes.startsAt);
    }),

  /**
   * Check-ins recorded against this class.
   *
   * Joins through bookings, so corporate check-ins are not counted. Finding 4.
   */
  checkinCountFor: staffProcedure
    .input(z.object({ classId: z.number() }))
    .query(async ({ ctx, input }) => {
      const [result] = await ctx.db
        .select({ count: sql<number>`count(*)` })
        .from(checkins)
        .innerJoin(bookings, eq(checkins.bookingId, bookings.id))
        .where(eq(bookings.classId, input.classId));

      return { count: Number(result?.count ?? 0) };
    }),

  /** This member's waitlisted places, each with its position in the queue. */
  waitlisted: protectedProcedure.query(async ({ ctx }) => {
    const waiting = await ctx.db
      .select({
        bookingId: bookings.id,
        classId: classes.id,
        className: classes.name,
        room: classes.room,
        startsAt: classes.startsAt,
        durationMin: classes.durationMin,
        capacity: classes.capacity,
        bookedAt: bookings.bookedAt,
      })
      .from(bookings)
      .innerJoin(classes, eq(bookings.classId, classes.id))
      .where(and(eq(bookings.userId, ctx.user.id), eq(bookings.status, "waitlisted")))
      .orderBy(asc(classes.startsAt));

    return Promise.all(
      waiting.map(async (entry) => {
        const [{ ahead }] = await ctx.db
          .select({ ahead: sql<number>`count(*)` })
          .from(bookings)
          .where(
            and(
              eq(bookings.classId, entry.classId),
              eq(bookings.status, "waitlisted"),
              sql`${bookings.bookedAt} < ${entry.bookedAt}`,
            ),
          );

        return { ...entry, position: Number(ahead) + 1 };
      }),
    );
  }),
});
