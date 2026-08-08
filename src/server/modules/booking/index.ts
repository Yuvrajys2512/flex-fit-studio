/**
 * The two seat flows, configured.
 *
 * Everything that separates a personal booking from a corporate one is on
 * these two lines: which table the seat is recorded in, and which ledger pays
 * for it.
 */
import { bookings, corporateBookings } from "@/db/schema";
import { createSeatFlow } from "./service";
import { membershipLedger, companyPoolLedger } from "./ledger";
import type { SeatTable } from "./rules";

export const personalSeats = createSeatFlow(bookings, membershipLedger);

// The one cast in the module. corporate_bookings carries the same columns the
// seat flow reads and writes; the ownership column it does not share is
// supplied by companyPoolLedger.ownerColumns. See the note on SeatTable.
export const corporateSeats = createSeatFlow(
  corporateBookings as unknown as SeatTable,
  companyPoolLedger,
);

export { activeMembershipFor, companyFor } from "./ledger";
export * from "./rules";
