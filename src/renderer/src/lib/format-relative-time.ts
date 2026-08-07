// Picks the coarsest sensible bucket for a past timestamp, for compact labels in dense lists.
//
// This stays pure and locale-free: it returns the bucket and the count, and the caller renders them
// through the catalog. English wants "5m"/"3d" with no space; Chinese wants "5 分钟前"/"3 天前" with a
// different word order — a suffix table alone can't express that, so the unit becomes a catalog key.
export type RelativeTimeUnit = 'now' | 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year'

export type RelativeTimeParts = {
  unit: RelativeTimeUnit
  // Always ≥ 1 except for 'now', where it carries no meaning and is 0.
  count: number
}

export const relativeTimeParts = (
  timestamp: number,
  now: number = Date.now()
): RelativeTimeParts => {
  const elapsedMs = Math.max(0, now - timestamp)
  const seconds = Math.floor(elapsedMs / 1000)

  if (seconds < 45) return { unit: 'now', count: 0 }

  const minutes = Math.floor(seconds / 60)

  if (minutes < 60) return { unit: 'minute', count: Math.max(1, minutes) }

  const hours = Math.floor(minutes / 60)

  if (hours < 24) return { unit: 'hour', count: hours }

  const days = Math.floor(hours / 24)

  if (days < 7) return { unit: 'day', count: days }

  const weeks = Math.floor(days / 7)

  if (weeks < 5) return { unit: 'week', count: weeks }

  const months = Math.floor(days / 30)

  // Switch to years only at a real year. Using `months < 12` here would leave 360–364 days (months === 12
  // by the /30 approximation, but still < 365) falling through to `days / 365` === 0, rendering "0y".
  if (days < 365) return { unit: 'month', count: months }

  return { unit: 'year', count: Math.floor(days / 365) }
}
