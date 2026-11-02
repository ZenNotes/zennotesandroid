import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

// A zone with daylight saving, so a week across the change is counted in days.
process.env.TZ = 'America/Chicago'

const { isoDaysAfter, weekStep } = await import('./calendar-week.ts')

/** Core's November 2026 grid with Monday first: six rows, Oct 26 to Dec 6. */
const NOVEMBER_2026 = Array.from({ length: 42 }, (_, i) => isoDaysAfter('2026-10-26', i))

describe('Week mode on the Tasks calendar', () => {
  it('counts days on the calendar, across months, years and daylight saving', () => {
    assert.equal(isoDaysAfter('2026-11-30', 7), '2026-12-07')
    assert.equal(isoDaysAfter('2026-01-01', -7), '2025-12-25')
    assert.equal(isoDaysAfter('2026-11-01', -7), '2026-10-25')
    assert.equal(isoDaysAfter('2026-03-08', 7), '2026-03-15')
    assert.equal(isoDaysAfter('2028-02-26', 7), '2028-03-04')
  })

  it('goes a week, not a month, and picks the day from the grid when it is there', () => {
    assert.equal(NOVEMBER_2026[41], '2026-12-06')
    assert.deepEqual(weekStep(NOVEMBER_2026, '2026-11-01', 1), { kind: 'day', iso: '2026-11-08' })
    assert.deepEqual(weekStep(NOVEMBER_2026, '2026-11-08', -1), { kind: 'day', iso: '2026-11-01' })
    // The grid's last row runs into December; a day there is still a tap away.
    assert.deepEqual(weekStep(NOVEMBER_2026, '2026-11-26', 1), { kind: 'day', iso: '2026-12-03' })
  })

  it('brings in the month first for a week past either end of the grid', () => {
    assert.deepEqual(weekStep(NOVEMBER_2026, '2026-11-30', 1), { kind: 'month', iso: '2026-12-07' })
    assert.deepEqual(weekStep(NOVEMBER_2026, '2026-10-28', -1), { kind: 'month', iso: '2026-10-21' })
  })

  it("keeps core's month arrows from hearing a Week-mode tap", () => {
    const shell = readFileSync(new URL('./MobileShell.tsx', import.meta.url), 'utf8')
    const hook = shell.slice(shell.indexOf('function useCalendarWeekMode('), shell.indexOf('const RIGHT_PANEL_SELECTOR'))
    assert.match(shell, /const CAL_PREV_ARROW = "\[data-tasks-toolbar\] button\[title\^='Previous month'\]"/)
    assert.match(shell, /const CAL_NEXT_ARROW = "\[data-tasks-toolbar\] button\[title\^='Next month'\]"/)
    assert.match(hook, /if \(passMonthArrow \|\| scope\(\) !== 'week'\) return/)
    assert.match(hook, /e\.preventDefault\(\)\n\s+e\.stopPropagation\(\)/)
    assert.match(hook, /document\.addEventListener\('click', onArrow, true\)/)
    assert.match(hook, /document\.removeEventListener\('click', onArrow, true\)/)
  })

  it('reads the arrows and day cells core draws', () => {
    const calendar = readFileSync(
      new URL('../../node_modules/@zennotes/app-core/dist/components/TasksCalendar.js', import.meta.url),
      'utf8'
    )
    assert.match(calendar, /"data-tasks-toolbar": true/)
    assert.match(calendar, /onClick: \(\) => goToMonth\(-1\), title: "Previous month \(\[\)"/)
    assert.match(calendar, /onClick: \(\) => goToMonth\(1\), title: "Next month \(\]\)"/)
    // A tapped day is selected, and a day of another month brings its month in.
    assert.match(
      calendar,
      /"data-cal-day": cellIso, onClick: \(\) => \{\s+setSelectedDate\(cellIso\);\s+if \(isOtherMonth\)\s+setMonthAnchor\(toIsoDateLocal\(firstOfMonth\(cell\)\)\);/
    )
  })
})
