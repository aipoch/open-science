// Absolute date/time formatting in the interface language.
//
// Unlike prose, these strings need no catalog: Intl already carries CLDR data for every locale we
// ship, and it knows things a translator would have to hand-maintain — that zh-Hans writes
// "8月13日 15:14" on a 24-hour clock while zh-Hant writes "8月13日 下午3:14" on a 12-hour one. The bug
// this module fixes is only ever the locale argument.
//
// Two wrong shapes existed before it. `new Intl.DateTimeFormat('en-US', …)` pinned English no matter
// what the user picked. `new Intl.DateTimeFormat(undefined, …)` followed the host OS instead of the
// app, so a Chinese interface on an English macOS still read "Aug 13" — and in the web build the
// backend's OS has nothing to do with the reader at all.
//
// Formatters are cached because constructing one is the expensive part of Intl; formatting is cheap.
// The cache is keyed by locale so a language switch builds a new one rather than reusing the old.

import type { Locale } from '../../../shared/locale'

// The presets in use, named for intent rather than for their field list so call sites don't restate
// the options and drift apart.
export type DateTimeStyleName =
  // Compact stamp for dense transcript rows: "Aug 13, 3:14 PM" / "8月13日 15:14".
  | 'timestamp'
  // Unabbreviated, for the tooltip behind a compact stamp.
  | 'full'
  // Date and clock for list rows that are not as tight as the transcript.
  | 'dateTime'
  // Date alone, where a clock would be noise (a credential's expiry).
  | 'date'

const STYLE_OPTIONS: Record<DateTimeStyleName, Intl.DateTimeFormatOptions> = {
  timestamp: { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' },
  full: { dateStyle: 'full', timeStyle: 'long' },
  dateTime: { dateStyle: 'medium', timeStyle: 'short' },
  date: { dateStyle: 'medium' }
}

const formatterCache = new Map<string, Intl.DateTimeFormat>()

const getFormatter = (locale: Locale, style: DateTimeStyleName): Intl.DateTimeFormat => {
  const cacheKey = `${locale}:${style}`
  const cached = formatterCache.get(cacheKey)

  if (cached) return cached

  const formatter = new Intl.DateTimeFormat(locale, STYLE_OPTIONS[style])

  formatterCache.set(cacheKey, formatter)

  return formatter
}

// Formats a Date, epoch-millis value, or ISO string in the given locale. Invalid dates return an
// empty string so a bad timestamp renders as nothing rather than "Invalid Date" — persisted
// provenance records carry timestamps as strings that were parsed out of untyped JSON.
export const formatDateTime = (
  value: Date | number | string,
  locale: Locale,
  style: DateTimeStyleName = 'timestamp'
): string => {
  const date = value instanceof Date ? value : new Date(value)

  if (Number.isNaN(date.getTime())) return ''

  return getFormatter(locale, style).format(date)
}
