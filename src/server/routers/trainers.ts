/**
 * Trainer schedules and availability.
 *
 * The four hand-rolled `if (ctx.user.role !== "trainer") throw` blocks are now
 * the trainerProcedure middleware. Same rule, one copy.
 */
import { z } from "zod";
import { and, eq, gte } from "drizzle-orm";
import { classes, trainerAvailability } from "@/db/schema";
import { router, staffProcedure, trainerProcedure } from "../trpc";
import { overlaps, withinWindow, utcWeekdayAndTimes } from "../modules/scheduling/availability";

const dayOfWeek = z.number().int().min(0).max(6);

export const trainersRouter = router({
  /** The signed in trainer's own future classes. */
  upcomingClasses: trainerProcedure.query(({ ctx }) =>
    ctx.db
      .select({
        id: classes.id,
        name: classes.name,
        room: classes.room,
        startsAt: classes.startsAt,
        durationMin: classes.durationMin,
        cancelled: classes.cancelled,
      })
      .from(classes)
      .where(
        and(
          eq(classes.trainerId, ctx.user.id),
          gte(classes.startsAt, new Date().toISOString()),
          eq(classes.cancelled, false),
        ),
      )
      .orderBy(classes.startsAt),
  ),

  availability: trainerProcedure.query(({ ctx }) =>
    ctx.db
      .select()
      .from(trainerAvailability)
      .where(eq(trainerAvailability.trainerId, ctx.user.id))
      .orderBy(trainerAvailability.dayOfWeek),
  ),

  /** One window per weekday. Setting a day again replaces it. */
  setAvailability: trainerProcedure
    .input(z.object({ dayOfWeek, startTime: z.string(), endTime: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.db
        .select()
        .from(trainerAvailability)
        .where(
          and(
            eq(trainerAvailability.trainerId, ctx.user.id),
            eq(trainerAvailability.dayOfWeek, input.dayOfWeek),
          ),
        )
        .get();

      if (existing) {
        return ctx.db
          .update(trainerAvailability)
          .set({ startTime: input.startTime, endTime: input.endTime })
          .where(eq(trainerAvailability.id, existing.id))
          .returning()
          .get();
      }

      return ctx.db
        .insert(trainerAvailability)
        .values({
          trainerId: ctx.user.id,
          dayOfWeek: input.dayOfWeek,
          startTime: input.startTime,
          endTime: input.endTime,
        })
        .returning()
        .get();
    }),

  removeAvailability: trainerProcedure
    .input(z.object({ dayOfWeek }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db
        .delete(trainerAvailability)
        .where(
          and(
            eq(trainerAvailability.trainerId, ctx.user.id),
            eq(trainerAvailability.dayOfWeek, input.dayOfWeek),
          ),
        );

      return { success: true };
    }),

  /**
   * Whether a trainer could take a class at a given time.
   *
   * Staff-wide, unlike the four above — the original allowed trainer or admin
   * here and trainer only everywhere else, and both are preserved.
   *
   * Nothing in the app calls this, and its comparisons are done in UTC rather
   * than the studio's timezone. Findings 18 and 19.
   */
  checkAvailability: staffProcedure
    .input(
      z.object({
        trainerId: z.number(),
        startsAt: z.string(),
        durationMin: z.number(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const slot = utcWeekdayAndTimes(input.startsAt, input.durationMin);

      const window = await ctx.db
        .select()
        .from(trainerAvailability)
        .where(
          and(
            eq(trainerAvailability.trainerId, input.trainerId),
            eq(trainerAvailability.dayOfWeek, slot.dayOfWeek),
          ),
        )
        .get();

      if (!window) {
        return { available: false, reason: "No availability set for this day" };
      }

      if (!withinWindow(slot, window)) {
        return { available: false, reason: "Outside availability hours" };
      }

      const existing = await ctx.db
        .select()
        .from(classes)
        .where(and(eq(classes.trainerId, input.trainerId), eq(classes.cancelled, false)));

      const clashes = existing.some((cls) =>
        overlaps(slot, { startsAt: cls.startsAt, durationMin: cls.durationMin }),
      );

      if (clashes) {
        return { available: false, reason: "Trainer already has a class at this time" };
      }

      return { available: true };
    }),
});
