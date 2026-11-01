/**
 * The Tasks calendar's Week scope (MobileShell's useCalendarWeekMode) shows
 * one row of core's six-row month grid, under core's own month arrows. In
 * Week mode those arrows move a week: the shell picks the day a week before
 * or after the selected one, as a tap on that day would. A day the grid does
 * not show (a week past its sixth row or before its first) needs the month
 * that holds it brought in first, with core's month arrow.
 */

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** The `YYYY-MM-DD` day `days` after `iso`, counted on the calendar. Local
 *  noon, so a daylight saving change never skips or repeats a day. */
export function isoDaysAfter(iso: string, days: number): string {
  const [year, month, day] = iso.split('-').map(Number)
  const date = new Date(year, month - 1, day + days, 12)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export type WeekStep =
  /** Pick this day in the grid on screen. */
  | { kind: 'day'; iso: string }
  /** The grid does not show this day: bring in the next or previous month
   *  with core's arrow, then pick it. */
  | { kind: 'month'; iso: string }

/** Where a Week-mode arrow goes from the week of `fromIso` (the selected day):
 *  the same weekday a week before or after, in the grid when it is there. */
export function weekStep(gridDays: readonly string[], fromIso: string, direction: -1 | 1): WeekStep {
  const iso = isoDaysAfter(fromIso, 7 * direction)
  return gridDays.includes(iso) ? { kind: 'day', iso } : { kind: 'month', iso }
}
