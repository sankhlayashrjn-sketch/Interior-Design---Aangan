import { DateTime } from "luxon";

export const IST = "Asia/Kolkata";

export interface WorkingHoursConfig {
  /** "HH:MM", 24h, in `timezone`. Start is inclusive, end is exclusive for "is it working time". */
  workStart: string;
  workEnd: string;
  /** ISO weekdays, 1 = Mon ... 7 = Sun. */
  workDays: number[];
  /** "YYYY-MM-DD" dates that are never working days. */
  holidays?: string[];
  timezone?: string;
}

export const DEFAULT_HOURS: WorkingHoursConfig = {
  workStart: "09:00",
  workEnd: "18:00",
  workDays: [1, 2, 3, 4, 5, 6],
  holidays: [],
  timezone: IST,
};

function parseHM(s: string): { h: number; m: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!match) throw new Error(`Invalid time "${s}", expected HH:MM`);
  return { h: Number(match[1]), m: Number(match[2]) };
}

function zoned(d: Date, cfg: WorkingHoursConfig) {
  return DateTime.fromJSDate(d, { zone: cfg.timezone ?? IST });
}

function isWorkingDay(dt: DateTime, cfg: WorkingHoursConfig) {
  return cfg.workDays.includes(dt.weekday) && !(cfg.holidays ?? []).includes(dt.toISODate()!);
}

function dayStart(dt: DateTime, cfg: WorkingHoursConfig) {
  const { h, m } = parseHM(cfg.workStart);
  return dt.set({ hour: h, minute: m, second: 0, millisecond: 0 });
}

function dayEnd(dt: DateTime, cfg: WorkingHoursConfig) {
  const { h, m } = parseHM(cfg.workEnd);
  return dt.set({ hour: h, minute: m, second: 0, millisecond: 0 });
}

/** True if `d` is inside working hours: start <= d < end on a working day. */
export function isWorkingTime(d: Date, cfg: WorkingHoursConfig = DEFAULT_HOURS): boolean {
  const dt = zoned(d, cfg);
  return isWorkingDay(dt, cfg) && dt >= dayStart(dt, cfg) && dt < dayEnd(dt, cfg);
}

/** The earliest moment >= d that is working time (d itself if already working). */
export function nextWorkingStart(d: Date, cfg: WorkingHoursConfig = DEFAULT_HOURS): Date {
  if (cfg.workDays.length === 0) throw new Error("No working days configured");
  let dt: DateTime = zoned(d, cfg);
  for (let i = 0; i < 400; i++) {
    if (isWorkingDay(dt, cfg)) {
      const start = dayStart(dt, cfg);
      const end = dayEnd(dt, cfg);
      if (dt < start) return start.toJSDate();
      if (dt < end) return dt.toJSDate();
    }
    dt = dayStart(dt.plus({ days: 1 }), cfg);
  }
  throw new Error("No working time found within 400 days; check configuration");
}

/**
 * Add `minutes` of WORKING time to `d`. Time outside working hours does not count.
 * A deadline landing exactly on the end of the day stays on that day (17:00 + 60 = 18:00).
 */
export function addWorkingMinutes(d: Date, minutes: number, cfg: WorkingHoursConfig = DEFAULT_HOURS): Date {
  let cur = zoned(nextWorkingStart(d, cfg), cfg);
  let remaining = minutes;
  for (let i = 0; i < 4000; i++) {
    const end = dayEnd(cur, cfg);
    const available = end.diff(cur, "minutes").minutes;
    if (remaining <= available) return cur.plus({ minutes: remaining }).toJSDate();
    remaining -= available;
    cur = zoned(nextWorkingStart(end.toJSDate(), cfg), cfg);
  }
  throw new Error("addWorkingMinutes did not converge; check configuration");
}

export interface ReminderPlan {
  afterHours: boolean;
  /** When the designer should have acknowledged by. Working-time clock. */
  dueAt: Date;
  /** "sla": remind at dueAt if still unacknowledged. "digest": include in the digest sent at runAt. */
  kind: "sla" | "digest";
  runAt: Date;
}

/**
 * Decide how a call arriving at `arrival` is reminded.
 * - In hours: SLA reminder when `slaMinutes` of working time have passed.
 * - After hours: part of a single digest at the next working-day opening. Its due time is
 *   the SLA window counted from that opening.
 */
export function planReminder(arrival: Date, slaMinutes: number, cfg: WorkingHoursConfig = DEFAULT_HOURS): ReminderPlan {
  if (isWorkingTime(arrival, cfg)) {
    const dueAt = addWorkingMinutes(arrival, slaMinutes, cfg);
    return { afterHours: false, dueAt, kind: "sla", runAt: dueAt };
  }
  const open = nextWorkingStart(arrival, cfg);
  return { afterHours: true, dueAt: addWorkingMinutes(open, slaMinutes, cfg), kind: "digest", runAt: open };
}

/** Working minutes between two instants (a <= b). Used for time-to-acknowledge reporting. */
export function workingMinutesBetween(a: Date, b: Date, cfg: WorkingHoursConfig = DEFAULT_HOURS): number {
  if (b <= a) return 0;
  let cur = zoned(nextWorkingStart(a, cfg), cfg);
  const target = zoned(b, cfg);
  let total = 0;
  for (let i = 0; i < 4000 && cur < target; i++) {
    const end = dayEnd(cur, cfg);
    const stop = target < end ? target : end;
    total += stop.diff(cur, "minutes").minutes;
    cur = zoned(nextWorkingStart(end.toJSDate(), cfg), cfg);
  }
  return Math.round(total * 100) / 100;
}
