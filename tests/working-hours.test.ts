import { describe, expect, it } from "vitest";
import {
  addWorkingMinutes,
  DEFAULT_HOURS,
  isWorkingTime,
  nextWorkingStart,
  planReminder,
  workingMinutesBetween,
} from "@/lib/working-hours";

/** IST wall-clock helper: ist("2026-10-09 17:30") */
const ist = (s: string) => new Date(`${s.replace(" ", "T")}:00+05:30`);
const show = (d: Date) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);

// 2026-10-09 is a Friday. 2026-10-10 Saturday. 2026-10-11 Sunday. 2026-10-12 Monday.

describe("isWorkingTime", () => {
  it("is inclusive at 09:00 and exclusive at 18:00", () => {
    expect(isWorkingTime(ist("2026-10-09 09:00"))).toBe(true);
    expect(isWorkingTime(ist("2026-10-09 08:59"))).toBe(false);
    expect(isWorkingTime(ist("2026-10-09 17:59"))).toBe(true);
    expect(isWorkingTime(ist("2026-10-09 18:00"))).toBe(false);
  });
  it("treats Saturday as working and Sunday as not", () => {
    expect(isWorkingTime(ist("2026-10-10 11:00"))).toBe(true);
    expect(isWorkingTime(ist("2026-10-11 11:00"))).toBe(false);
  });
  it("respects holidays", () => {
    const cfg = { ...DEFAULT_HOURS, holidays: ["2026-10-09"] };
    expect(isWorkingTime(ist("2026-10-09 11:00"), cfg)).toBe(false);
  });
});

describe("addWorkingMinutes (1 working hour SLA)", () => {
  it("in hours: 10:00 -> 11:00 same day", () => {
    expect(show(addWorkingMinutes(ist("2026-10-09 10:00"), 60))).toBe(show(ist("2026-10-09 11:00")));
  });
  it("spec example: call at 17:30 is due 09:30 next working day", () => {
    expect(addWorkingMinutes(ist("2026-10-08 17:30"), 60).getTime()).toBe(ist("2026-10-09 09:30").getTime());
  });
  it("boundary: call at 17:00 is due exactly 18:00 same day", () => {
    expect(addWorkingMinutes(ist("2026-10-09 17:00"), 60).getTime()).toBe(ist("2026-10-09 18:00").getTime());
  });
  it("boundary: call at exactly 18:00 is after hours, due 10:00 next working day", () => {
    expect(addWorkingMinutes(ist("2026-10-08 18:00"), 60).getTime()).toBe(ist("2026-10-09 10:00").getTime());
  });
  it("Saturday 17:30 rolls over Sunday to Monday 09:30", () => {
    expect(addWorkingMinutes(ist("2026-10-10 17:30"), 60).getTime()).toBe(ist("2026-10-12 09:30").getTime());
  });
  it("Friday 17:45 rolls to Saturday 09:45 (Saturday is a working day)", () => {
    expect(addWorkingMinutes(ist("2026-10-09 17:45"), 60).getTime()).toBe(ist("2026-10-10 09:45").getTime());
  });
  it("Sunday arrival starts counting Monday 09:00", () => {
    expect(addWorkingMinutes(ist("2026-10-11 14:00"), 60).getTime()).toBe(ist("2026-10-12 10:00").getTime());
  });
  it("early morning arrival starts counting at 09:00", () => {
    expect(addWorkingMinutes(ist("2026-10-09 06:15"), 60).getTime()).toBe(ist("2026-10-09 10:00").getTime());
  });
  it("handles SLAs longer than a day", () => {
    // 9h working day. 600 min from Fri 09:00 = 9h Fri + 1h Sat -> Sat 10:00
    expect(addWorkingMinutes(ist("2026-10-09 09:00"), 600).getTime()).toBe(ist("2026-10-10 10:00").getTime());
  });
  it("skips holidays", () => {
    const cfg = { ...DEFAULT_HOURS, holidays: ["2026-10-09"] };
    expect(addWorkingMinutes(ist("2026-10-08 17:30"), 60, cfg).getTime()).toBe(ist("2026-10-10 09:30").getTime());
  });
  it("follows changed working hours (10:00-19:00)", () => {
    const cfg = { ...DEFAULT_HOURS, workStart: "10:00", workEnd: "19:00" };
    expect(addWorkingMinutes(ist("2026-10-09 18:30"), 60, cfg).getTime()).toBe(ist("2026-10-10 10:30").getTime());
  });
});

describe("nextWorkingStart", () => {
  it("returns the same instant when already working", () => {
    const d = ist("2026-10-09 12:34");
    expect(nextWorkingStart(d).getTime()).toBe(d.getTime());
  });
  it("Saturday evening -> Monday 09:00", () => {
    expect(nextWorkingStart(ist("2026-10-10 19:00")).getTime()).toBe(ist("2026-10-12 09:00").getTime());
  });
});

describe("planReminder", () => {
  it("in-hours call gets an SLA reminder at the due time", () => {
    const p = planReminder(ist("2026-10-09 10:30"), 60);
    expect(p.afterHours).toBe(false);
    expect(p.kind).toBe("sla");
    expect(p.runAt.getTime()).toBe(ist("2026-10-09 11:30").getTime());
    expect(p.dueAt.getTime()).toBe(p.runAt.getTime());
  });
  it("after-hours call is a digest at 09:00 next working day", () => {
    const p = planReminder(ist("2026-10-09 21:10"), 60);
    expect(p.afterHours).toBe(true);
    expect(p.kind).toBe("digest");
    expect(p.runAt.getTime()).toBe(ist("2026-10-10 09:00").getTime());
    expect(p.dueAt.getTime()).toBe(ist("2026-10-10 10:00").getTime());
  });
  it("Saturday-night call is a digest on Monday 09:00", () => {
    const p = planReminder(ist("2026-10-10 22:00"), 60);
    expect(p.runAt.getTime()).toBe(ist("2026-10-12 09:00").getTime());
  });
  it("Sunday call is a digest on Monday 09:00", () => {
    const p = planReminder(ist("2026-10-11 12:00"), 60);
    expect(p.afterHours).toBe(true);
    expect(p.runAt.getTime()).toBe(ist("2026-10-12 09:00").getTime());
  });
  it("17:30 in-hours call: SLA reminder at 09:30 next day", () => {
    const p = planReminder(ist("2026-10-08 17:30"), 60);
    expect(p.afterHours).toBe(false);
    expect(p.runAt.getTime()).toBe(ist("2026-10-09 09:30").getTime());
  });
});

describe("workingMinutesBetween", () => {
  it("counts only working time across a night", () => {
    // Thu 17:00 -> Fri 10:00 = 60 + 60
    expect(workingMinutesBetween(ist("2026-10-08 17:00"), ist("2026-10-09 10:00"))).toBe(120);
  });
  it("ignores Sunday", () => {
    // Sat 17:00 -> Mon 09:30 = 60 + 30
    expect(workingMinutesBetween(ist("2026-10-10 17:00"), ist("2026-10-12 09:30"))).toBe(90);
  });
});
