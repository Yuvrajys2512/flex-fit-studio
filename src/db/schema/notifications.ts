/** Messages shown to a member in the app. */
import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { users } from "./identity";

export const notifications = sqliteTable("notifications", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  /**
   * Only `announcement` is ever written. The other three are declared, are
   * rendered by the notifications page, and no code path produces them.
   * See documents/findings.md, finding 21.
   */
  type: text("type", {
    enum: ["waitlist_promotion", "class_cancelled", "membership_expiring", "announcement"],
  }).notNull(),
  title: text("title").notNull(),
  message: text("message").notNull(),
  read: integer("read", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export type Notification = typeof notifications.$inferSelect;
