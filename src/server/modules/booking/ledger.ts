/**
 * Who pays for a seat, and how.
 *
 * A personal booking spends credits from the member's own membership; a
 * corporate booking spends them from their company's shared pool. That is the
 * only real difference between the two booking flows — everything else in
 * bookings.ts and corporate-bookings.ts was the same code twice.
 *
 * The two implementations below are deliberately kept next to each other,
 * because they do **not** agree with one another and pretending otherwise was
 * how the original drifted. Each disagreement is marked. Behaviour is preserved
 * exactly as it was found; see documents/findings.md, findings 1, 3 and 25.
 */
import { TRPCError } from "@trpc/server";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  memberships,
  companies,
  companyMembers,
  type Membership,
  type Company,
  type Booking,
  type CorporateBooking,
} from "@/db/schema";
import { today } from "@/server/shared/time";
import {
  FREE_CANCELLATION_HOURS,
  CORPORATE_FREE_CANCELLATION_HOURS,
  UNLIMITED_CREDITS,
} from "@/server/shared/policy";
import type { Db } from "@/server/shared/db";

/**
 * The contract the booking service works against. `TAccount` is whatever the
 * ledger needs to identify a payer; `TBooking` is the row it settles against.
 */
export interface SeatLedger<TAccount, TBooking> {
  /** Hours of notice required for a cancellation to be refunded. */
  readonly freeCancellationHours: number;

  /** Finds the account that will pay, refusing with this flow's own message. */
  requireAccount(db: Db, userId: number): Promise<TAccount>;

  /** Refuses when the account cannot cover the class, with its own message. */
  assertCanAfford(account: TAccount, creditCost: number): void;

  /** The owner column this flow writes on the booking row. */
  ownerColumns(account: TAccount): Record<string, number>;

  /** Takes payment for a seat that was confirmed immediately. */
  debitOnBook(db: Db, account: TAccount, creditCost: number): Promise<void>;

  /** Returns credits for a cancellation made in good time. */
  refund(db: Db, booking: TBooking): Promise<void>;

  /** Takes payment when this booking is promoted off the waitlist. */
  debitOnPromotion(db: Db, booking: TBooking, creditCost: number): Promise<void>;
}

// ---------------------------------------------------------------------------
// Personal memberships
// ---------------------------------------------------------------------------

/**
 * The active membership with the furthest end date.
 *
 * A member can hold more than one at a time (finding 14), and this is the rule
 * that silently decides which one pays.
 */
export async function activeMembershipFor(
  db: Db,
  userId: number,
): Promise<Membership | undefined> {
  return db
    .select()
    .from(memberships)
    .where(
      and(
        eq(memberships.userId, userId),
        eq(memberships.status, "active"),
        sql`${memberships.endDate} >= ${today()}`,
      ),
    )
    .orderBy(desc(memberships.endDate))
    .get();
}

const isUnlimited = (m: Pick<Membership, "creditsRemaining">) =>
  m.creditsRemaining >= UNLIMITED_CREDITS;

export const membershipLedger: SeatLedger<Membership, Booking> = {
  freeCancellationHours: FREE_CANCELLATION_HOURS,

  async requireAccount(db, userId) {
    const membership = await activeMembershipFor(db, userId);
    if (!membership) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "An active membership is required to book classes.",
      });
    }
    return membership;
  },

  assertCanAfford(membership, creditCost) {
    if (!isUnlimited(membership) && membership.creditsRemaining < creditCost) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Not enough class credits remaining.",
      });
    }
  },

  ownerColumns: (membership) => ({ membershipId: membership.id }),

  async debitOnBook(db, membership, creditCost) {
    // An unlimited membership is never decremented.
    if (isUnlimited(membership)) return;

    await db
      .update(memberships)
      .set({ creditsRemaining: membership.creditsRemaining - creditCost })
      .where(eq(memberships.id, membership.id));
  },

  async refund(db, booking) {
    if (!booking.membershipId) return;

    const membership = await db
      .select()
      .from(memberships)
      .where(eq(memberships.id, booking.membershipId))
      .get();

    if (!membership || isUnlimited(membership)) return;

    await db
      .update(memberships)
      .set({ creditsRemaining: membership.creditsRemaining + booking.creditsUsed })
      .where(eq(memberships.id, membership.id));
  },

  async debitOnPromotion(db, booking, creditCost) {
    if (!booking.membershipId) return;

    const membership = await db
      .select()
      .from(memberships)
      .where(eq(memberships.id, booking.membershipId))
      .get();

    if (!membership || isUnlimited(membership)) return;

    // Divergence from the corporate ledger below: there is no affordability
    // check here, so a member who cannot cover the class is charged anyway and
    // the balance is clamped at zero. Finding 1.
    await db
      .update(memberships)
      .set({ creditsRemaining: Math.max(0, membership.creditsRemaining - creditCost) })
      .where(eq(memberships.id, membership.id));
  },
};

// ---------------------------------------------------------------------------
// Corporate credit pools
// ---------------------------------------------------------------------------

/** The active company this member books against, if any. */
export async function companyFor(db: Db, userId: number): Promise<Company | undefined> {
  const row = await db
    .select()
    .from(companyMembers)
    .innerJoin(companies, eq(companyMembers.companyId, companies.id))
    .where(and(eq(companyMembers.userId, userId), eq(companies.active, true)))
    .get();

  return row?.companies;
}

async function readCompany(db: Db, id: number): Promise<Company | undefined> {
  return db.select().from(companies).where(eq(companies.id, id)).get();
}

export const companyPoolLedger: SeatLedger<Company, CorporateBooking> = {
  // Stricter than the personal window, for reasons nobody wrote down.
  freeCancellationHours: CORPORATE_FREE_CANCELLATION_HOURS,

  async requireAccount(db, userId) {
    const company = await companyFor(db, userId);
    if (!company) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "You are not linked to an active company.",
      });
    }
    return company;
  },

  assertCanAfford(company, creditCost) {
    if (company.creditPoolBalance < creditCost) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Your company does not have enough credits.",
      });
    }
  },

  ownerColumns: (company) => ({ companyId: company.id }),

  async debitOnBook(db, company, creditCost) {
    // Divergence: pools have no unlimited sentinel, so a pool sitting on 999
    // credits is charged where an equivalent membership would not be.
    await db
      .update(companies)
      .set({ creditPoolBalance: company.creditPoolBalance - creditCost })
      .where(eq(companies.id, company.id));
  },

  async refund(db, booking) {
    const company = await readCompany(db, booking.companyId);
    if (!company) return;

    await db
      .update(companies)
      .set({ creditPoolBalance: company.creditPoolBalance + booking.creditsUsed })
      .where(eq(companies.id, company.id));
  },

  async debitOnPromotion(db, booking, creditCost) {
    const company = await readCompany(db, booking.companyId);

    // Divergence from the membership ledger: this one *does* check the balance
    // first, but the promotion has already happened by the time it runs. A
    // company that cannot cover the class gets the seat without paying, which
    // is the opposite failure to finding 1. Finding 3.
    if (!company || company.creditPoolBalance < creditCost) return;

    await db
      .update(companies)
      .set({ creditPoolBalance: Math.max(0, company.creditPoolBalance - creditCost) })
      .where(eq(companies.id, company.id));
  },
};
