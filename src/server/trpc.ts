import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { sessions, users, type User } from "@/db/schema";

export const SESSION_COOKIE = "flexfit_session";

export async function createContext() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;

  let user: User | null = null;

  if (token) {
    const row = await db
      .select({ session: sessions, user: users })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(eq(sessions.token, token))
      .get();

    if (row && new Date(row.session.expiresAt) > new Date()) {
      user = row.user;
    }
  }

  return { db, user, token };
}

export type Context = Awaited<ReturnType<typeof createContext>>;

const t = initTRPC.context<Context>().create({ transformer: superjson });

export const router = t.router;
export const publicProcedure = t.procedure;

export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Sign in required." });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

/** Anyone who works here: trainers and admins. */
export const staffProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== "admin" && ctx.user.role !== "trainer") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Staff only." });
  }
  return next({ ctx });
});

export const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Admins only." });
  }
  return next({ ctx });
});

/**
 * Trainers only, excluding admins.
 *
 * Note this is deliberately *not* staffProcedure. The trainer routes guard a
 * trainer's own schedule and availability, and the original refused admins on
 * all four. That rule is preserved here rather than quietly widened; the point
 * of moving it is that whoever decides admins should be let in now changes one
 * line instead of four. See documents/findings.md, finding 17.
 */
export const trainerProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== "trainer") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Only trainers can access this." });
  }
  return next({ ctx });
});
