import type { ReplayStep } from '../../../../../shared/replay'

export type ReplayRecordedRange = Readonly<{ startedAt: number; endedAt: number }>

export type ReplayCoverageRange = Readonly<{ startMs: number; endMs: number }>

/** Evidence boundaries keep millisecond precision, without padding whole-second positions. */
export function formatReplayRecordedTime(milliseconds: number): string {
  const time = Number.isFinite(milliseconds) ? Math.max(0, Math.round(milliseconds)) : 0
  const seconds = Math.floor(time / 1000)
  const remainder = time % 1000
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}${remainder ? `.${String(remainder).padStart(3, '0').replace(/0+$/, '')}` : ''}`
}

/** Union actual segment coverage on the research clock, independent of playback progress.
 * Only holes between saved segments are gaps; leading/trailing time is outside coverage. */
export function replayRecordedCoverage(
  ranges: readonly ReplayRecordedRange[],
  origin: number | undefined,
  durationMs: number
): { footage: ReplayCoverageRange[]; gaps: ReplayCoverageRange[] } {
  if (
    origin === undefined ||
    !Number.isFinite(origin) ||
    !Number.isFinite(durationMs) ||
    durationMs <= 0
  )
    return { footage: [], gaps: [] }
  const sorted = ranges
    .filter((range) => Number.isFinite(range.startedAt) && Number.isFinite(range.endedAt))
    .map((range) => ({
      startMs: Math.max(0, range.startedAt - origin),
      endMs: Math.min(durationMs, range.endedAt - origin)
    }))
    .filter((range) => range.endMs > range.startMs)
    .sort((a, b) => a.startMs - b.startMs)
  const footage: ReplayCoverageRange[] = []
  for (const range of sorted) {
    const previous = footage.at(-1)
    if (previous && range.startMs <= previous.endMs)
      footage[footage.length - 1] = { ...previous, endMs: Math.max(previous.endMs, range.endMs) }
    else footage.push(range)
  }
  return {
    footage,
    gaps: footage
      .slice(1)
      .map((range, index) => ({ startMs: footage[index].endMs, endMs: range.startMs }))
  }
}

/** Skipping is optional presentation, not a claim that the experiment was idle. */
export function advanceResearchReplay(input: {
  positionMs: number
  elapsedMs: number
  durationMs: number
  origin?: number
  steps: readonly ReplayStep[]
  ranges: readonly ReplayRecordedRange[]
  skip: boolean
  /** Saved observation boundaries share the clock without becoming research steps. */
  observationTimes?: readonly number[]
}): { positionMs: number; skipped?: { from: number; to: number } } {
  const positionMs = Math.min(input.durationMs, input.positionMs + Math.max(0, input.elapsedMs))
  if (!input.skip || input.origin === undefined || !Number.isFinite(input.origin))
    return { positionMs }
  const origin = input.origin
  // A short reading hold preserves point records. It does not extend their recorded duration.
  const ranges = [
    ...(input.observationTimes ?? [])
      .filter(Number.isFinite)
      .map((time) => ({ start: time - origin, end: time - origin + 3000 })),
    ...input.steps.flatMap((step) =>
      [step.recordedAt, step.recordedEndAt].flatMap((time) =>
        time !== undefined && Number.isFinite(time)
          ? [{ start: time - origin, end: time - origin + 3000 }]
          : []
      )
    ),
    ...input.ranges
      .filter(
        (range) =>
          Number.isFinite(range.startedAt) &&
          Number.isFinite(range.endedAt) &&
          range.endedAt >= range.startedAt
      )
      .map((range) => ({ start: range.startedAt - origin, end: range.endedAt - origin }))
  ].sort((a, b) => a.start - b.start)
  if (ranges.some((range) => range.start <= positionMs && range.end > positionMs))
    return { positionMs }
  // Do not skip across a short recorded segment between animation frames (including 4× playback).
  const crossed = ranges.find(
    (range) => range.start > input.positionMs && range.start <= positionMs
  )
  if (crossed) return { positionMs: crossed.start }
  const next = ranges.find((range) => range.start > positionMs)
  if (!next || next.start - positionMs < 5000 || next.start > input.durationMs)
    return { positionMs }
  return { positionMs: next.start, skipped: { from: positionMs, to: next.start } }
}
