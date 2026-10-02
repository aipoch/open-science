import { describe, expect, it } from 'vitest'
import type { ReplayStep } from '../../../../../shared/replay'
import {
  formatReplayTime,
  replayChapterBreaks,
  replayStepAtTime,
  replayStepExcerpt,
  replayStepFailure
} from './replay-navigation'

const step = (startMs: number, title = ''): ReplayStep => ({
  id: String(startMs),
  branchId: 'branch',
  kind: 'message',
  startMs,
  durationMs: 1,
  endMs: startMs + 1,
  title,
  evidence: [],
  activities: [],
  runs: [],
  resourceIds: [],
  issues: []
})

describe('replay navigation', () => {
  it('bounds decorative chapter divisions while preserving exact time lookup', () => {
    const steps = Array.from({ length: 10000 }, (_, index) => step(index))
    for (const width of [320, 375, 414, 768, 1280]) {
      const breaks = replayChapterBreaks(steps, 10000, width)
      expect(breaks.length).toBeLessThanOrEqual(Math.floor(width / 8))
      breaks.forEach((percent, index) => {
        expect(((percent - (breaks[index - 1] ?? 0)) / 100) * width).toBeGreaterThanOrEqual(7.999)
        expect(((100 - percent) / 100) * width).toBeGreaterThanOrEqual(7.999)
      })
    }
    expect(replayStepAtTime(steps, 1)).toBe(1)
    expect(replayStepAtTime(steps, 9999)).toBe(9999)
    expect(replayStepAtTime(steps, 10000)).toBe(9999)
  })
  it('handles empty, zero-duration and coincident chapter boundaries', () => {
    expect(replayChapterBreaks([], 1000, 320)).toEqual([])
    expect(replayChapterBreaks([step(0)], 0, 320)).toEqual([])
    expect(replayChapterBreaks([step(0)], 1000, 0)).toEqual([])
    expect(replayChapterBreaks([step(0), step(500), step(500), step(1000)], 1000, 320)).toEqual([
      50
    ])
    expect(replayStepAtTime([], 0)).toBe(-1)
    expect(replayStepAtTime([step(0), step(500)], 499)).toBe(0)
    expect(replayStepAtTime([step(0), step(500)], 500)).toBe(1)
  })
  it('does not report missing source material as an execution failure', () => {
    const item = step(0)
    item.issues = [{ code: 'artifact-unavailable', detail: 'Missing file' }]
    expect(replayStepFailure(item)).toBeUndefined()
    item.status = 'error'
    expect(replayStepFailure(item)).toBe('error')
  })
  it('uses bounded source text rather than inventing titles', () => {
    expect(replayStepExcerpt(step(0, '## **Saved** [sin.png](artifact://private)\nResult'))).toBe(
      'Saved sin.png Result'
    )
    expect(replayStepExcerpt(step(0, 'x'.repeat(100000)))).toHaveLength(100)
    expect(replayStepExcerpt(step(0))).toBe('')
    expect(replayStepExcerpt(step(0, 'sin_plot_r.png'))).toBe('sin_plot_r.png')
    expect(replayStepExcerpt(step(0, 'x * y'))).toBe('x * y')
    expect(formatReplayTime(77000)).toBe('1:17')
  })
})
