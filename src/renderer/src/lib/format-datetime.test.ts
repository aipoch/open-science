import { describe, expect, it } from 'vitest'

import { formatDateTime, formatRelativeTime } from './format-datetime'

// A fixed instant, constructed in UTC so the assertions below don't depend on the runner's zone.
const INSTANT = Date.UTC(2026, 7, 13, 7, 14, 0)

describe('formatDateTime', () => {
  it('writes the timestamp in the script of the requested locale', () => {
    const english = formatDateTime(INSTANT, 'en')
    const simplified = formatDateTime(INSTANT, 'zh-Hans')
    const traditional = formatDateTime(INSTANT, 'zh-Hant')
    const korean = formatDateTime(INSTANT, 'ko')
    const french = formatDateTime(INSTANT, 'fr')
    const portuguese = formatDateTime(INSTANT, 'pt-BR')
    const spanish = formatDateTime(INSTANT, 'es')

    // The point of the module: the same instant reads as a month name in English and as 月/日 in
    // Chinese, rather than leaking "Aug" into a Chinese interface.
    expect(english).toMatch(/Aug/u)
    expect(simplified).toMatch(/月/u)
    expect(simplified).not.toMatch(/Aug/u)
    expect(traditional).toMatch(/月/u)
    expect(traditional).not.toMatch(/Aug/u)
    expect(korean).toMatch(/월/u)
    expect(korean).not.toMatch(/Aug/u)
    expect(french).toMatch(/août/u)
    expect(french).not.toMatch(/Aug/u)
    expect(portuguese).toMatch(/ago\.?/iu)
    expect(portuguese).not.toMatch(/Aug/u)
    expect(spanish).toMatch(/ago\.?/iu)
    expect(spanish).not.toMatch(/Aug/u)
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
    expect(formatDateTime(INSTANT, 'ko')).not.toBe(formatDateTime(INSTANT, 'en'))
  })
})

describe('formatRelativeTime', () => {
  it('clamps anything under 45 seconds to "now" in the locale language', () => {
    expect(formatRelativeTime(INSTANT, 'en', INSTANT)).toBe('now')
    expect(formatRelativeTime(INSTANT + 30_000, 'en', INSTANT)).toBe('now')
    // Exact CLDR wording ("刚刚" vs "现在") varies by ICU build; assert the locale switched.
    expect(formatRelativeTime(INSTANT, 'zh-Hans', INSTANT)).toMatch(/刚刚|现在/u)
    expect(formatRelativeTime(INSTANT, 'fr', INSTANT)).toMatch(/maintenant|à l'instant/u)
    expect(formatRelativeTime(INSTANT, 'pt-BR', INSTANT)).toMatch(/agora/u)
    expect(formatRelativeTime(INSTANT, 'es', INSTANT)).toMatch(/ahora/u)
  })

  it('picks the coarsest sensible unit in the locale language', () => {
    expect(formatRelativeTime(INSTANT - 3 * 60_000, 'en', INSTANT)).toBe('3 minutes ago')
    expect(formatRelativeTime(INSTANT + 2 * 3_600_000, 'en', INSTANT)).toBe('in 2 hours')
    expect(formatRelativeTime(INSTANT - 3 * 60_000, 'zh-Hans', INSTANT)).toMatch(/3\s*分钟前/u)
    expect(formatRelativeTime(INSTANT - 3 * 60_000, 'fr', INSTANT)).toMatch(/il y a 3 min/u)
    expect(formatRelativeTime(INSTANT - 3 * 60_000, 'pt-BR', INSTANT)).toMatch(/há 3 min/u)
    expect(formatRelativeTime(INSTANT - 3 * 60_000, 'es', INSTANT)).toMatch(/hace 3 min/u)
    // 5 rather than 2 days: CLDR gives Japanese a dedicated word ("一昨日") for two days ago.
    expect(formatRelativeTime(INSTANT - 5 * 24 * 3_600_000, 'ja', INSTANT)).toMatch(/5\s*日前/u)
  })

  it('renders an unparseable value as empty rather than a bogus interval', () => {
    expect(formatRelativeTime(Number.NaN, 'en', INSTANT)).toBe('')
    expect(formatRelativeTime(INSTANT, 'en', 'not a date')).toBe('')
  })
})
