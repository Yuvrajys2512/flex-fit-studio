import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "@/db/schema";
import { appRouter } from "@/server/routers/_app";
import { hashPassword } from "@/lib/password";
import type { User } from "@/db/schema";

export type TestDb = ReturnType<typeof drizzle<typeof schema>>;

const MIGRATIONS_DIR = join(process.cwd(), "drizzle");

let cachedDdl: string[] | null = null;

/**
 * The generated migration SQL is the single source of truth for the schema, so
 * the tests cannot drift from src/db/schema.ts without someone noticing.
 */
function ddlStatements(): string[] {
  if (cachedDdl) return cachedDdl;

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  cachedDdl = files
    .flatMap((f) => readFileSync(join(MIGRATIONS_DIR, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);

  return cachedDdl;
}

/** A schema-complete, totally empty database that lives only for this test. */
export async function freshDb(): Promise<TestDb> {
  const client = createClient({ url: "file::memory:" });
  for (const statement of ddlStatements()) {
    await client.execute(statement);
  }
  return drizzle(client, { schema });
}

/** Calls procedures as `user` (or signed out, when user is null). */
export function callerFor(db: TestDb, user: User | null) {
  return appRouter.createCaller({
    db: db as unknown as typeof import("@/db").db,
    user,
    token: user ? `test-token-${user.id}` : undefined,
  });
}

// ---------------------------------------------------------------------------
// Fixtures
//
// Deliberately explicit: a characterization test is only trustworthy if you can
// read the setup and know exactly what state the assertion runs against.
// ---------------------------------------------------------------------------

let sequence = 0;
const nextSeq = () => ++sequence;

export function hoursFromNow(h: number): string {
  return new Date(Date.now() + h * 3600_000).toISOString();
}

export function daysFromNow(d: number): string {
  return new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
}

export async function makeUser(
  db: TestDb,
  overrides: Partial<typeof schema.users.$inferInsert> = {},
): Promise<User> {
  const n = nextSeq();
  return db
    .insert(schema.users)
    .values({
      email: `user${n}@test.local`,
      passwordHash: hashPassword("password123"),
      name: `Test User ${n}`,
      phone: `+91 90000 0${String(n).padStart(4, "0")}`,
      role: "member",
      active: true,
      ...overrides,
    })
    .returning()
    .get();
}

export const makeAdmin = (db: TestDb, o: Partial<typeof schema.users.$inferInsert> = {}) =>
  makeUser(db, { role: "admin", ...o });

export const makeTrainer = (db: TestDb, o: Partial<typeof schema.users.$inferInsert> = {}) =>
  makeUser(db, { role: "trainer", ...o });

export async function makePlan(
  db: TestDb,
  overrides: Partial<typeof schema.membershipPlans.$inferInsert> = {},
) {
  const n = nextSeq();
  return db
    .insert(schema.membershipPlans)
    .values({
      name: `Plan ${n}`,
      description: "A plan",
      priceCents: 500_000,
      durationDays: 30,
      classCredits: 10,
      active: true,
      ...overrides,
    })
    .returning()
    .get();
}

/** An active membership with credits, valid from a month ago to a month out. */
export async function makeMembership(
  db: TestDb,
  userId: number,
  overrides: Partial<typeof schema.memberships.$inferInsert> = {},
) {
  const planId = overrides.planId ?? (await makePlan(db)).id;
  return db
    .insert(schema.memberships)
    .values({
      userId,
      planId,
      startDate: daysFromNow(-30),
      endDate: daysFromNow(30),
      creditsRemaining: 10,
      status: "active",
      ...overrides,
    })
    .returning()
    .get();
}

export async function makeClass(
  db: TestDb,
  overrides: Partial<typeof schema.classes.$inferInsert> = {},
) {
  const n = nextSeq();
  return db
    .insert(schema.classes)
    .values({
      name: `Class ${n}`,
      description: "A class",
      trainerId: null,
      room: "Studio A",
      capacity: 10,
      startsAt: hoursFromNow(48),
      durationMin: 60,
      creditCost: 1,
      cancelled: false,
      ...overrides,
    })
    .returning()
    .get();
}

export async function makeCompany(
  db: TestDb,
  overrides: Partial<typeof schema.companies.$inferInsert> = {},
) {
  const n = nextSeq();
  return db
    .insert(schema.companies)
    .values({
      name: `Company ${n}`,
      contactEmail: `hr${n}@company.test`,
      creditPoolBalance: 100,
      active: true,
      ...overrides,
    })
    .returning()
    .get();
}

export async function linkToCompany(db: TestDb, userId: number, companyId: number) {
  return db
    .insert(schema.companyMembers)
    .values({ userId, companyId })
    .returning()
    .get();
}

/**
 * Inserts a booking directly, bypassing the booking rules. Used to build the
 * "before" state a test wants to act on, never to assert booking behaviour.
 */
export async function seedBooking(
  db: TestDb,
  values: typeof schema.bookings.$inferInsert,
) {
  return db.insert(schema.bookings).values(values).returning().get();
}

export async function seedCorporateBooking(
  db: TestDb,
  values: typeof schema.corporateBookings.$inferInsert,
) {
  return db.insert(schema.corporateBookings).values(values).returning().get();
}

/** Reads a row back so a test can assert on persisted state, not return values. */
export async function readBooking(db: TestDb, id: number) {
  const { eq } = await import("drizzle-orm");
  return db.select().from(schema.bookings).where(eq(schema.bookings.id, id)).get();
}

export async function readMembership(db: TestDb, id: number) {
  const { eq } = await import("drizzle-orm");
  return db.select().from(schema.memberships).where(eq(schema.memberships.id, id)).get();
}

export async function readCompany(db: TestDb, id: number) {
  const { eq } = await import("drizzle-orm");
  return db.select().from(schema.companies).where(eq(schema.companies.id, id)).get();
}

export { schema };
