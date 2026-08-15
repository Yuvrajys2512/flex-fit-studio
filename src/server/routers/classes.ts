import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, gte, lte, sql } from "drizzle-orm";
import { classes, bookings, notifications, users } from "@/db/schema";
import { router, publicProcedure, staffProcedure, adminProcedure } from "../trpc";
import { membershipLedger } from "../modules/booking/ledger";

export const classesRouter = router({
  list: publicProcedure
    .input(
      z
        .object({
          from: z.string().optional(),
          to: z.string().optional(),
          includeCancelled: z.boolean().default(false),
        })
        .default({}),
    )
    .query(async ({ ctx, input }) => {
      const filters = [];
      if (input.from) filters.push(gte(classes.startsAt, input.from));
      if (input.to) filters.push(lte(classes.startsAt, input.to));
      if (!input.includeCancelled) filters.push(eq(classes.cancelled, false));

      const rows = await ctx.db
        .select({
          id: classes.id,
          name: classes.name,
          description: classes.description,
          room: classes.room,
          capacity: classes.capacity,
          startsAt: classes.startsAt,
          durationMin: classes.durationMin,
          creditCost: classes.creditCost,
          cancelled: classes.cancelled,
          trainerName: users.name,
          booked: sql<number>`(
            select count(*) from ${bookings}
            where ${bookings.classId} = ${classes.id}
              and ${bookings.status} = 'booked'
          )`.as("booked"),
        })
        .from(classes)
        .leftJoin(users, eq(classes.trainerId, users.id))
        .where(filters.length ? and(...filters) : undefined)
        .orderBy(asc(classes.startsAt));

      return rows.map((r) => ({
        ...r,
        spotsLeft: Math.max(0, r.capacity - Number(r.booked)),
        full: Number(r.booked) >= r.capacity,
      }));
    }),

  byId: publicProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ ctx, input }) => {
      const cls = await ctx.db
        .select()
        .from(classes)
        .where(eq(classes.id, input.id))
        .get();

      if (!cls) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Class not found." });
      }

      // Fixed: finding 7. The class itself (name, room, time) stays public —
      // that's the schedule. The roster is member names and emails, which is
      // exactly what bookings.rosterFor already gates behind staffProcedure;
      // this endpoint had grown a second, ungated copy of the same data.
      const isStaff = ctx.user?.role === "admin" || ctx.user?.role === "trainer";
      const roster = isStaff
        ? await ctx.db
            .select({
              bookingId: bookings.id,
              status: bookings.status,
              memberName: users.name,
              memberEmail: users.email,
            })
            .from(bookings)
            .innerJoin(users, eq(bookings.userId, users.id))
            .where(eq(bookings.classId, cls.id))
        : [];

      return { ...cls, roster };
    }),

  create: staffProcedure
    .input(
      z.object({
        name: z.string().min(1),
        description: z.string().optional(),
        trainerId: z.number().optional(),
        room: z.string().min(1),
        capacity: z.number().int().positive(),
        startsAt: z.string(),
        durationMin: z.number().int().positive().default(60),
        creditCost: z.number().int().min(0).default(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.db
        .insert(classes)
        .values({
          ...input,
          description: input.description ?? null,
          trainerId: input.trainerId ?? null,
        })
        .returning()
        .get();
    }),

  update: staffProcedure
    .input(
      z.object({
        id: z.number(),
        name: z.string().min(1).optional(),
        room: z.string().min(1).optional(),
        capacity: z.number().int().positive().optional(),
        startsAt: z.string().optional(),
        trainerId: z.number().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...patch } = input;
      const updated = await ctx.db
        .update(classes)
        .set(patch)
        .where(eq(classes.id, id))
        .returning()
        .get();

      if (!updated) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Class not found." });
      }
      return updated;
    }),

  cancel: adminProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const cls = await ctx.db
        .update(classes)
        .set({ cancelled: true })
        .where(eq(classes.id, input.id))
        .returning()
        .get();

      if (!cls) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Class not found." });
      }

      // Fixed: finding 9. Same scope as before — confirmed personal bookings
      // only, same as the cancellation this already performed (finding 10,
      // waitlisted and corporate bookings, is left alone: that is about which
      // bookings get touched at all, a separate decision from what happens to
      // the ones that were already being touched here).
      const affected = await ctx.db
        .select()
        .from(bookings)
        .where(and(eq(bookings.classId, input.id), eq(bookings.status, "booked")));

      await ctx.db
        .update(bookings)
        .set({ status: "cancelled", cancelledAt: new Date().toISOString() })
        .where(
          and(eq(bookings.classId, input.id), eq(bookings.status, "booked")),
        );

      for (const booking of affected) {
        await membershipLedger.refund(ctx.db, booking);
      }

      if (affected.length > 0) {
        await ctx.db.insert(notifications).values(
          affected.map((booking) => ({
            userId: booking.userId,
            type: "class_cancelled" as const,
            title: "Class cancelled",
            message: `${cls.name} on ${cls.startsAt} was cancelled by the studio. Your credits have been refunded.`,
          })),
        );
      }

      return cls;
    }),
});
