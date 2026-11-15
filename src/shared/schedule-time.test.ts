import { expect, it } from 'vitest'
import { nextScheduleTime, scheduleLocalInstants } from './schedule-time'

it('resolves southern-hemisphere gaps, valid transition-day times and repeated minutes', () => {
  const timeZone = 'Australia/Sydney'
  const spring = Date.parse('2026-10-03T00:00Z')
  expect(scheduleLocalInstants('2026-10-04T02:30', timeZone)).toEqual([])
  expect(nextScheduleTime({ kind: 'daily', time: '02:30', timeZone }, spring)).toBe(
    Date.parse('2026-10-04T15:30Z')
  )
  expect(nextScheduleTime({ kind: 'daily', time: '03:30', timeZone }, spring)).toBe(
    Date.parse('2026-10-03T16:30Z')
  )
  const repeated = [Date.parse('2026-04-04T15:30Z'), Date.parse('2026-04-04T16:30Z')]
  expect(scheduleLocalInstants('2026-04-05T02:30', timeZone)).toEqual(repeated)
  const fall = { kind: 'daily', time: '02:30', timeZone } as const
  expect(nextScheduleTime(fall, repeated[0] - 1)).toBe(repeated[0])
  expect(nextScheduleTime(fall, repeated[0])).toBe(Date.parse('2026-04-05T16:30Z'))
})

it('skips a nonexistent weekly time and consumes a repeated time only once', () => {
  const rule = {
    kind: 'weekly',
    weekdays: [0],
    timeZone: 'America/New_York',
    time: '02:30'
  } as const
  const weekly = { ...rule, weekdays: [...rule.weekdays] }
  expect(nextScheduleTime(weekly, Date.parse('2026-03-08T05:00Z'))).toBe(
    Date.parse('2026-03-15T06:30Z')
  )
  const fall = { ...weekly, time: '01:30' }
  const first = Date.parse('2026-11-01T05:30Z')
  expect(nextScheduleTime(fall, first - 1)).toBe(first)
  expect(nextScheduleTime(fall, first)).toBe(Date.parse('2026-11-08T06:30Z'))
})

it('keeps interval phase after downtime and never reschedules a consumed one-shot', () => {
  expect(
    nextScheduleTime({ kind: 'interval', anchor: 100, minutes: 10, timeZone: 'UTC' }, 1_200_101)
  ).toBe(1_800_100)
  expect(nextScheduleTime({ kind: 'once', at: 100, timeZone: 'UTC' }, 100)).toBeNull()
})
