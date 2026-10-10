import { describe, expect, it } from 'vitest'
import type { ResearchRecordingCoverage } from '@/lib/replay/recorded-time'
import { recordingAtTime } from './recording-timeline-follow'

const coverage = (id: string, start: number, end: number): ResearchRecordingCoverage => ({
  recordingId: id,
  target: { projectId: 'p', sessionId: 's', artifactId: id, versionId: `${id}-v1` },
  startedAt: start,
  endedAt: end,
  ranges: [{ startedAt: start, endedAt: end }]
})

describe('recording selection from verified coverage', () => {
  const first = coverage('first', 1000, 2000)
  const second = coverage('second', 2000, 3000)
  it('follows sequential recordings in both directions and prefers the new interval at a boundary', () => {
    for (const [time, target] of [
      [1500, first.target],
      [2000, second.target],
      [3000, second.target],
      [1000, first.target]
    ] as const)
      expect(recordingAtTime([first, second], time)).toEqual({ kind: 'recording', target })
  })
  it('never guesses across gaps, missing time anchors or recording overlaps', () => {
    expect(recordingAtTime([first, second], 500)).toEqual({ kind: 'gap' })
    expect(recordingAtTime([first, second], 3500)).toEqual({ kind: 'gap' })
    expect(recordingAtTime([first, second], undefined)).toEqual({ kind: 'unaligned' })
    expect(recordingAtTime([first, second], NaN)).toEqual({ kind: 'unaligned' })
    expect(recordingAtTime([first, coverage('other', 1200, 2200)], 1500)).toEqual({
      kind: 'ambiguous'
    })
    const interrupted = {
      ...first,
      ranges: [
        { startedAt: 1000, endedAt: 1200 },
        { startedAt: 1800, endedAt: 2000 }
      ]
    }
    expect(recordingAtTime([interrupted], 1500)).toEqual({ kind: 'gap' })
  })
  it('deduplicates exact targets but never conflates different versions or receiving sessions', () => {
    expect(recordingAtTime([first, { ...first }], 1500)).toEqual({
      kind: 'recording',
      target: first.target
    })
    for (const target of [
      { ...first.target, versionId: 'other' },
      { ...first.target, sessionId: 'other' }
    ])
      expect(recordingAtTime([first, { ...first, target }], 1500)).toEqual({ kind: 'ambiguous' })
  })
})
