import { describe, expect, it } from 'vitest'

import { formatDateTime } from './format-datetime'

// A fixed instant, constructed in UTC so the assertions below don't depend on the runner's zone.
const INSTANT = Date.UTC(2026, 7, 13, 7, 14, 0)

describe('formatDateTime', () => {
  it('writes the timestamp in the script of the requested locale', () => {
    const english = formatDateTime(INSTANT, 'en')
    const simplified = formatDateTime(INSTANT, 'zh-Hans')
    const traditional = formatDateTime(INSTANT, 'zh-Hant')

    // The point of the module: the same instant reads as a month name in English and as 月/日 in
    // Chinese, rather than leaking "Aug" into a Chinese interface.
    expect(english).toMatch(/Aug/u)
    expect(simplified).toMatch(/月/u)
    expect(simplified).not.toMatch(/Aug/u)
    expect(traditional).toMatch(/月/u)
    expect(traditional).not.toMatch(/Aug/u)
  })

  it('keeps each locale on its own clock convention', () => {
    // zh-Hans uses a 24-hour clock while en and zh-Hant use a 12-hour one. This is CLDR data, not a
    // choice we get to make, and it is the reason the module defers to Intl instead of a format string.
    expect(new Intl.DateTimeFormat('zh-Hans', { hour: 'numeric' }).resolvedOptions().hour12).toBe(
      false
    )
    expect(formatDateTime(INSTANT, 'en')).toMatch(/AM|PM/u)
    expect(formatDateTime(INSTANT, 'zh-Hans')).not.toMatch(/AM|PM/u)
  })

  it('varies the output by style', () => {
    const timestamp = formatDateTime(INSTANT, 'en', 'timestamp')
    const full = formatDateTime(INSTANT, 'en', 'full')
    const dateOnly = formatDateTime(INSTANT, 'en', 'date')

    // 'full' spells the weekday and month out; 'timestamp' abbreviates; 'date' drops the clock.
    expect(full).toMatch(/August/u)
    expect(full.length).toBeGreaterThan(timestamp.length)
    expect(dateOnly).not.toMatch(/AM|PM/u)
  })

  it('accepts a Date, epoch millis, and an ISO string alike', () => {
    const fromMillis = formatDateTime(INSTANT, 'en')

    expect(formatDateTime(new Date(INSTANT), 'en')).toBe(fromMillis)
    expect(formatDateTime(new Date(INSTANT).toISOString(), 'en')).toBe(fromMillis)
  })

  it('renders an unparseable value as empty rather than "Invalid Date"', () => {
    expect(formatDateTime(Number.NaN, 'en')).toBe('')
    expect(formatDateTime('not a date', 'en')).toBe('')
  })

  it('reuses one formatter per locale and style', () => {
    // Cheap guard on the cache: repeated calls must stay consistent, and a second locale must not
    // inherit the first one's formatter.
    expect(formatDateTime(INSTANT, 'en')).toBe(formatDateTime(INSTANT, 'en'))
    expect(formatDateTime(INSTANT, 'zh-Hans')).not.toBe(formatDateTime(INSTANT, 'en'))
  })
})
