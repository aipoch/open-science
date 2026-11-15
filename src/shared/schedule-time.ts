import type { ScheduleDraft, ScheduleRule } from './session-schedules'

export function scheduleEndExtended(previous: ScheduleDraft, next: ScheduleDraft): boolean {
  return previous.endAt !== undefined && (next.endAt === undefined || next.endAt > previous.endAt)
}

const dayMs = 86_400_000
const minuteMs = 60_000

// Calendar arithmetic uses a UTC scalar for the wall clock. Offsets are resolved
// on both sides of a transition so a repeated local minute has a single identity.
function wallClock(formatter: Intl.DateTimeFormat, instant: number): number {
  const fields = Object.fromEntries(
    formatter.formatToParts(instant).map((part) => [part.type, part.value])
  )
  return Date.UTC(
    Number(fields.year),
    Number(fields.month) - 1,
    Number(fields.day),
    Number(fields.hour),
    Number(fields.minute)
  )
}

function calendarFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}
export function formatScheduleLocalDateTime(instant: number, zone: string): string {
  return new Date(wallClock(calendarFormatter(zone), instant)).toISOString().slice(0, 16)
}
export function scheduleLocalInstants(local: string, zone: string): number[] {
  const wall = Date.parse(local + 'Z')
  if (!Number.isFinite(wall)) return []
  try {
    return matchingInstants(calendarFormatter(zone), wall)
  } catch {
    return []
  }
}
function matchingInstants(formatter: Intl.DateTimeFormat, wall: number): number[] {
  const matches = []
  for (const probe of [wall - dayMs, wall, wall + dayMs]) {
    const candidate = wall - (wallClock(formatter, probe) - probe)
    if (wallClock(formatter, candidate) === wall) matches.push(candidate)
  }
  return [...new Set(matches)].sort((a, b) => a - b)
}

// Strictly after the supplied instant. Used by both editor previews and dispatch.
export function nextScheduleTime(rule: ScheduleRule, after: number): number | null {
  if (rule.kind === 'once') return rule.at > after ? rule.at : null
  if (rule.kind === 'interval') {
    const period = rule.minutes * minuteMs
    return rule.anchor + Math.max(0, Math.floor((after - rule.anchor) / period) + 1) * period
  }
  const formatter = calendarFormatter(rule.timeZone)
  const [hour, minute] = rule.time.split(':').map(Number)
  const today = Math.floor(wallClock(formatter, after) / dayMs) * dayMs
  // Two weeks includes a skipped DST day followed by the next weekly slot.
  for (let delta = 0; delta <= 14; delta++) {
    const day = today + delta * dayMs
    if (rule.kind === 'weekly' && !rule.weekdays.includes(new Date(day).getUTCDay())) continue
    const [due] = matchingInstants(formatter, day + (hour * 60 + minute) * minuteMs)
    if (due !== undefined && due > after) return due
  }
  return null
}
