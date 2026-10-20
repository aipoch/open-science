import type { ReplayStep } from '../../../../../shared/replay'

export const formatReplayTime = (milliseconds: number): string => {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

// Source excerpts only: never infer the purpose of code or generate a new research claim.
export const replayStepExcerpt = (step: ReplayStep): string => {
  const source = step.title || step.message?.content || step.activities[0]?.title || ''
  return source
    .slice(0, 1000)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~|`)(.*?)\1/g, '$2')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+)/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100)
}

// Chapter dividers are decoration within one continuous slider, not tiny hit targets.
// Dense boundaries may be hidden; the directory and skip controls retain every step.
export const replayChapterBreaks = (
  steps: readonly ReplayStep[],
  durationMs: number,
  width: number
): number[] => {
  if (width < 16 || durationMs <= 0) return []
  const breaks: number[] = []
  let previous = 0
  for (const step of steps.slice(1)) {
    const x = (step.startMs / durationMs) * width
    if (x - previous < 8 || width - x < 8) continue
    breaks.push((x / width) * 100)
    previous = x
  }
  return breaks
}

export const replayStepAtTime = (steps: readonly ReplayStep[], timeMs: number): number => {
  let low = 0
  let high = steps.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (steps[middle].startMs <= timeMs) low = middle + 1
    else high = middle
  }
  return low - 1
}

// Execution failure and missing archive data are separate facts.
export const replayStepFailure = (step: ReplayStep): string | undefined =>
  [
    step.status,
    step.message?.status,
    ...step.activities.map((item) => item.status),
    ...step.runs.map((run) => run.status)
  ].find((status) => status === 'error' || status === 'failed' || status === 'timeout')
