import { describe, expect, it } from 'vitest'
import {
  advanceResearchReplay,
  formatReplayRecordedTime,
  replayRecordedCoverage
} from './replay-recorded-gaps'
import type { ReplayStep } from '../../../../../shared/replay'
const step = (recordedAt: number): ReplayStep => ({ recordedAt }) as ReplayStep
const base = {
  positionMs: 3000,
  elapsedMs: 16,
  durationMs: 100000,
  origin: 1000,
  steps: [step(1000), step(85000)],
  ranges: [],
  skip: true
}
describe('optional gaps in a research clock', () => {
  it('preserves real time unless explicitly enabled and known', () => {
    expect(advanceResearchReplay({ ...base, skip: false })).toEqual({ positionMs: 3016 })
    expect(advanceResearchReplay({ ...base, origin: undefined })).toEqual({ positionMs: 3016 })
  })
  it('keeps readable point records and reports the real interval when skipping', () => {
    expect(advanceResearchReplay({ ...base, positionMs: 0 })).toEqual({ positionMs: 16 })
    expect(advanceResearchReplay(base)).toEqual({
      positionMs: 84000,
      skipped: { from: 3016, to: 84000 }
    })
  })
  it('never skips footage, even when no conversation record arrives', () => {
    expect(
      advanceResearchReplay({ ...base, ranges: [{ startedAt: 1000, endedAt: 86000 }] })
    ).toEqual({ positionMs: 3016 })
  })
  it('does not skip over a short recording between animation frames', () => {
    expect(
      advanceResearchReplay({
        ...base,
        elapsedMs: 200,
        ranges: [{ startedAt: 4100, endedAt: 4150 }]
      })
    ).toEqual({ positionMs: 3100 })
  })
  it('does not invent time past the last event or skip brief gaps', () => {
    expect(advanceResearchReplay({ ...base, steps: [step(1000)] })).toEqual({ positionMs: 3016 })
    expect(advanceResearchReplay({ ...base, steps: [step(1000), step(8000)] })).toEqual({
      positionMs: 3016
    })
  })
})

describe('actual footage coverage', () => {
  it('retains small encoder gaps and formats their distinct millisecond boundaries', () => {
    const coverage = replayRecordedCoverage(
      [
        { startedAt: 183000, endedAt: 185435 },
        { startedAt: 185551, endedAt: 187000 }
      ],
      100000,
      90000
    )
    expect(coverage.gaps).toEqual([{ startMs: 85435, endMs: 85551 }])
    expect(formatReplayRecordedTime(coverage.gaps[0].startMs)).toBe('1:25.435')
    expect(formatReplayRecordedTime(coverage.gaps[0].endMs)).toBe('1:25.551')
    expect(formatReplayRecordedTime(85400)).toBe('1:25.4')
    expect(formatReplayRecordedTime(85040)).toBe('1:25.04')
    expect(formatReplayRecordedTime(85000)).toBe('1:25')
    expect(formatReplayRecordedTime(59999.7)).toBe('1:00')
  })
  it('merges overlapping sources and retains only actual interior gaps', () => {
    expect(
      replayRecordedCoverage(
        [
          { startedAt: 7000, endedAt: 9000 },
          { startedAt: 2000, endedAt: 4000 },
          { startedAt: 3500, endedAt: 5000 },
          { startedAt: 5000, endedAt: 6000 }
        ],
        1000,
        10000
      )
    ).toEqual({
      footage: [
        { startMs: 1000, endMs: 5000 },
        { startMs: 6000, endMs: 8000 }
      ],
      gaps: [{ startMs: 5000, endMs: 6000 }]
    })
  })

  it('clips to the selected branch and rejects malformed or zero-length ranges', () => {
    const ranges = [
      { startedAt: -100, endedAt: 1500 },
      { startedAt: 3500, endedAt: 6000 },
      { startedAt: 0, endedAt: 500 },
      { startedAt: 1700, endedAt: 1700 },
      { startedAt: 3000, endedAt: 2000 },
      { startedAt: NaN, endedAt: 2500 }
    ]
    expect(replayRecordedCoverage(ranges, 1000, 3000)).toEqual({
      footage: [
        { startMs: 0, endMs: 500 },
        { startMs: 2500, endMs: 3000 }
      ],
      gaps: [{ startMs: 500, endMs: 2500 }]
    })
    expect(replayRecordedCoverage(ranges, undefined, 3000)).toEqual({ footage: [], gaps: [] })
    expect(replayRecordedCoverage(ranges, 1000, NaN)).toEqual({ footage: [], gaps: [] })
  })
})
