// Weekly pay period: Saturday–Friday (BR-16), Friday cutoff, payday Saturday afternoon (BR-24).
import { addDays, isoDow, parseDate } from './time';

/** The Sat–Fri period containing a date. */
export function payWeekOf(date: string): { start: string; end: string; weekNo: number; yr: number } {
  const dow = isoDow(date);                // Sat = 6
  const back = (dow - 6 + 7) % 7;
  const start = addDays(date, -back);
  const end = addDays(start, 6);
  const yr = parseDate(end).getUTCFullYear();
  // Week number = count of Fridays from 1 Jan of the year to the period's Friday (week 1 ends on the first Friday).
  const jan1 = `${yr}-01-01`;
  const firstFriday = addDays(jan1, (5 - isoDow(jan1) + 7) % 7);
  const weekNo = Math.floor((parseDate(end).getTime() - parseDate(firstFriday).getTime()) / (7 * 86_400_000)) + 1;
  return { start, end, weekNo, yr };
}

/** The period that ended on the most recent Friday before `today` (what the Saturday 06:00 job computes). */
export function lastCompletedPayWeek(today: string) {
  const back = ((isoDow(today) - 5 + 7) % 7) || 7;   // most recent Friday strictly before today
  return payWeekOf(addDays(today, -back));
}
