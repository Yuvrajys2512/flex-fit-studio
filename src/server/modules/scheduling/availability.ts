/**
 * Time arithmetic for trainer availability.
 *
 * Pulled out of the router so the comparisons can be read, and tested, without
 * a database. The UTC handling below is preserved exactly as it was found and
 * is wrong for a studio that is not on UTC — see documents/findings.md,
 * findings 18 and 19.
 */

export interface Slot {
  start: Date;
  end: Date;
  /** Weekday of the start, read in UTC. */
  dayOfWeek: number;
  /** `HH:MM` of the start and end, read in UTC. */
  startTime: string;
  endTime: string;
}

const hhmm = (d: Date): string =>
  `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;

/**
 * Describes a proposed class as a slot.
 *
 * The weekday and the clock times are read in UTC while a trainer's declared
 * window is local wall-clock text, so the two are not comparable outside UTC.
 */
export function utcWeekdayAndTimes(startsAt: string, durationMin: number): Slot {
  const start = new Date(startsAt);
  const end = new Date(start.getTime() + durationMin * 60_000);

  return {
    start,
    end,
    dayOfWeek: start.getUTCDay(),
    startTime: hhmm(start),
    endTime: hhmm(end),
  };
}

/** Whether the slot sits inside a declared availability window. */
export function withinWindow(
  slot: Pick<Slot, "startTime" | "endTime">,
  window: { startTime: string; endTime: string },
): boolean {
  // Zero-padded HH:MM sorts correctly as a string.
  return slot.startTime >= window.startTime && slot.endTime <= window.endTime;
}

/** Whether the slot overlaps an existing class. Touching at the edge is fine. */
export function overlaps(
  slot: Pick<Slot, "start" | "end">,
  other: { startsAt: string; durationMin: number },
): boolean {
  const otherStart = new Date(other.startsAt);
  const otherEnd = new Date(otherStart.getTime() + other.durationMin * 60_000);

  return slot.start < otherEnd && slot.end > otherStart;
}
