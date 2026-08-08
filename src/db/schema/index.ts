/**
 * The database schema.
 *
 * Split by what the tables are about rather than kept as one list, so that a
 * change to how bookings work does not mean scrolling past companies and
 * notifications to find it. Everything is re-exported here, so
 * `import { bookings, users } from "@/db/schema"` still works exactly as it did
 * and no calling code needed to change.
 *
 *   identity      users, sessions
 *   membership    plans, memberships, payments
 *   scheduling    classes, trainer availability
 *   booking       bookings, corporate bookings, checkins, reschedules
 *   corporate     companies and their members
 *   notifications member-facing messages
 */
export * from "./identity";
export * from "./membership";
export * from "./scheduling";
export * from "./corporate";
export * from "./booking";
export * from "./notifications";
