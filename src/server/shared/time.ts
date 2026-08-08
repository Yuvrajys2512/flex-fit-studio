/**
 * Time helpers shared by the booking, reschedule and membership rules.
 *
 * Every timestamp in this app is an ISO 8601 string and every date-only value
 * is a `YYYY-MM-DD` string, both stored as SQLite text. These functions are the
 * only place that assumption is written down.
 */

/** Hours between now and `iso`. Negative once `iso` is in the past. */
export function hoursUntil(iso: string, now: Date = new Date()): number {
  return (new Date(iso).getTime() - now.getTime()) / 36e5;
}

/** Today as `YYYY-MM-DD`, the format membership start and end dates use. */
export function today(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** `YYYY-MM-DD`, `days` after the given date. */
export function addDays(dateIso: string, days: number): string {
  const d = new Date(dateIso);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/** An ISO timestamp `days` before now, used by the 14 day admin reports. */
export function daysAgoIso(days: number, now: Date = new Date()): string {
  const d = new Date(now);
  d.setDate(d.getDate() - days);
  return d.toISOString();
}
