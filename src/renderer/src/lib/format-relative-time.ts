// Formats a past timestamp as a compact relative label (e.g. "5m", "17h", "3d") for dense lists.
export const formatRelativeTime = (timestamp: number, now: number = Date.now()): string => {
  const elapsedMs = Math.max(0, now - timestamp)
  const seconds = Math.floor(elapsedMs / 1000)

  if (seconds < 45) return 'now'

  const minutes = Math.floor(seconds / 60)

  if (minutes < 60) return `${Math.max(1, minutes)}m`

  const hours = Math.floor(minutes / 60)

  if (hours < 24) return `${hours}h`

  const days = Math.floor(hours / 24)

  if (days < 7) return `${days}d`

  const weeks = Math.floor(days / 7)

  if (weeks < 5) return `${weeks}w`

  const months = Math.floor(days / 30)

  // Switch to years only at a real year. Using `months < 12` here would leave 360–364 days (months === 12
  // by the /30 approximation, but still < 365) falling through to `days / 365` === 0, rendering "0y".
  if (days < 365) return `${months}mo`

  return `${Math.floor(days / 365)}y`
}
