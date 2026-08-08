/**
 * Seats in a class, and the record of turning up.
 *
 * `bookings` and `corporate_bookings` are the same table twice, differing only
 * in whether the seat is paid for by a membership or a company credit pool.
 * Everything the booking rules read and write is declared identically on both,
 * which is what lets server/modules/booking drive them with one engine.
 */
import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { users } from "./identity";
import { memberships } from "./membership";
import { classes } from "./scheduling";
import { companies } from "./corporate";

const seatStatus = {
  enum: ["booked", "cancelled", "attended", "no_show", "waitlisted"],
} as const;

export const bookings = sqliteTable("bookings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  classId: integer("class_id")
    .notNull()
    .references(() => classes.id),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  membershipId: integer("membership_id").references(() => memberships.id),
  status: text("status", seatStatus).notNull().default("booked"),
  creditsUsed: integer("credits_used").notNull().default(0),
  bookedAt: text("booked_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  cancelledAt: text("cancelled_at"),
});

export const corporateBookings = sqliteTable("corporate_bookings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  classId: integer("class_id")
    .notNull()
    .references(() => classes.id),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  companyId: integer("company_id")
    .notNull()
    .references(() => companies.id),
  status: text("status", seatStatus).notNull().default("booked"),
  creditsUsed: integer("credits_used").notNull().default(0),
  bookedAt: text("booked_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  cancelledAt: text("cancelled_at"),
});

export const checkins = sqliteTable("checkins", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  /**
   * Points at `bookings` only, so a corporate check-in cannot be linked and is
   * stored as null. See documents/findings.md, finding 4.
   */
  bookingId: integer("booking_id").references(() => bookings.id),
  checkedInAt: text("checked_in_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  source: text("source", { enum: ["front_desk", "kiosk", "app"] })
    .notNull()
    .default("front_desk"),
});

/** An audit trail of members moving between sittings of the same class. */
export const reschedules = sqliteTable("reschedules", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  fromBookingId: integer("from_booking_id")
    .notNull()
    .references(() => bookings.id),
  toBookingId: integer("to_booking_id")
    .notNull()
    .references(() => bookings.id),
  fromClassId: integer("from_class_id")
    .notNull()
    .references(() => classes.id),
  toClassId: integer("to_class_id")
    .notNull()
    .references(() => classes.id),
  rescheduledAt: text("rescheduled_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export type Booking = typeof bookings.$inferSelect;
export type CorporateBooking = typeof corporateBookings.$inferSelect;
export type Checkin = typeof checkins.$inferSelect;
export type Reschedule = typeof reschedules.$inferSelect;
