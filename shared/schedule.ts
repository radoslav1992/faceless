import { z } from "zod";

// A series' posting rhythm: daily times in its own time zone on chosen weekdays. The series makes an episode for every
// slot, ahead of time, and posts it at that slot.
export const scheduleSchema = z.object({
  timezone: z.string().min(1).max(64).default("UTC"),
  /** "HH:MM", 24-hour, in `timezone`. */
  times: z.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)).min(1).max(6).default(["18:00"]),
  /** 0 = Sunday … 6 = Saturday. */
  days: z.array(z.number().int().min(0).max(6)).min(1).max(7).default([0, 1, 2, 3, 4, 5, 6]),
});
export type Schedule = z.infer<typeof scheduleSchema>;
/** Slots a schedule has in an average month (for "this needs N videos a month"). */
export const videosPerMonth = (s: Pick<Schedule, "times" | "days">) => Math.round((new Set(s.times).size * new Set(s.days).size * 30.44) / 7);

/** Whether `tz` is a time zone this runtime knows. */
export function validZone(tz: string) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}
/** The wall-clock parts of a moment in a time zone. */
function parts(at: number, tz: string) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short" });
  const p = Object.fromEntries(f.formatToParts(new Date(at * 1000)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute, s: +p.second, weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday) };
}
/** Unix seconds of a wall-clock time in a time zone (handles DST by correcting the offset once). */
export function zonedTime(y: number, m: number, d: number, h: number, min: number, tz: string) {
  const guess = Date.UTC(y, m - 1, d, h, min) / 1000;
  const p = parts(guess, tz);
  const offset = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) / 1000 - guess;
  const first = guess - offset;
  const q = parts(first, tz);
  const offset2 = Date.UTC(q.y, q.m - 1, q.d, q.h, q.min, q.s) / 1000 - first;
  return guess - offset2;
}
/**
 * The posting slots from `from` (unix seconds) on, in order, for `days` days ahead: every chosen time on every chosen
 * weekday in the schedule's time zone.
 */
export function slots(schedule: Schedule, from: number, days = 60) {
  const tz = validZone(schedule.timezone) ? schedule.timezone : "UTC";
  const out: number[] = [];
  const start = parts(from, tz);
  const times = [...schedule.times].sort();
  for (let i = 0; i <= days && times.length && schedule.days.length; i++) {
    const date = new Date(Date.UTC(start.y, start.m - 1, start.d + i));
    if (!schedule.days.includes(date.getUTCDay())) continue;
    for (const t of times) {
      const [h, min] = t.split(":").map(Number);
      const at = zonedTime(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), h, min, tz);
      if (at > from) out.push(at);
    }
  }
  return out;
}
/** The first slot after `from` that no scheduled post already takes (within 10 minutes). */
export function nextFreeSlot(schedule: Schedule, from: number, taken: number[]) {
  return slots(schedule, from).find((s) => !taken.some((t) => Math.abs(t - s) < 600)) ?? null;
}
