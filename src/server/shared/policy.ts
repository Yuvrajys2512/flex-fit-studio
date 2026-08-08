/**
 * Studio policy, in one place.
 *
 * These numbers used to live in three separate router files, which made it
 * impossible to notice that they disagree with each other. Gathering them here
 * changes nothing about how the app behaves — the values are exactly as they
 * were — but it makes the disagreement visible to whoever reads them next.
 *
 * See documents/findings.md, finding 25.
 */

/**
 * A member cancelling this many hours or more before the class starts gets
 * their credits back. Cancelling later still frees the seat but forfeits them.
 */
export const FREE_CANCELLATION_HOURS = 12;

/**
 * The same rule for corporate bookings, against the company credit pool.
 *
 * Deliberately stricter than the personal window above. Nothing in the code or
 * its history explains why, and a member and a corporate member cancelling the
 * same class at 20 hours notice get different outcomes.
 */
export const CORPORATE_FREE_CANCELLATION_HOURS = 24;

/**
 * A member may move to another sitting of the same class up to this many hours
 * before the original starts. More generous than either cancellation window,
 * so between 4 and 12 hours out, rescheduling keeps credits that cancelling
 * would forfeit.
 */
export const FREE_RESCHEDULE_HOURS = 4;

/**
 * A membership holding this many credits or more is treated as unlimited: it is
 * never decremented on booking and never credited on refund.
 *
 * This is a sentinel value rather than a flag on the plan, so a member who
 * legitimately accumulates 999 credits becomes unlimited by accident. Preserved
 * as-is; changing it would alter who can book what.
 */
export const UNLIMITED_CREDITS = 999;

/** How long a session cookie and its database row stay valid. */
export const SESSION_DAYS = 30;

/** Window used by the admin expiring-memberships report. */
export const EXPIRING_SOON_DAYS = 14;

/** Look-back window shared by the admin activity reports. */
export const REPORT_WINDOW_DAYS = 14;
