import { describe, expect, it } from 'vitest'
import { browserRecordedFixture } from '../main/run-observation/browser-recorded.test-support'
import {
  browserRecordingMomentSchema,
  parseBrowserRecording,
  validateBrowserRecording
} from './browser-recording'
import { validateProjectRecording } from './project-recording'

describe('independent browser recording content', () => {
  it('keeps relative time, bounded independently playable media, and no Notebook identity', () => {
    const { payload } = browserRecordedFixture()
    expect(parseBrowserRecording(JSON.stringify(payload.recording))).toEqual(payload.recording)
    expect(() => validateProjectRecording(payload.recording)).toThrow()
    expect(payload.recording).not.toHaveProperty('notebook')
  })
  it('rejects executable extensions, overlapping media, oversized segments, and evidence inside gaps', () => {
    const source = browserRecordedFixture().payload.recording
    for (const change of [
      { ...source, script: 'run()' },
      { ...source, version: 2 },
      { ...source, media: [{ ...source.media[0], sizeBytes: 16 * 1024 * 1024 + 1 }] },
      { ...source, media: [{ ...source.media[0], mimeType: 'text/html' }] },
      { ...source, segments: [...source.segments, { ...source.segments[0], segmentId: 'second' }] },
      { ...source, segments: [{ ...source.segments[0], endMs: 4000 }] },
      {
        ...source,
        coverage: { ...source.coverage, gaps: [{ startMs: 500, endMs: 1000, reason: 'hidden' }] }
      },
      { ...source, events: [{ ...source.events[0], source: 'author-declared' }] }
    ])
      expect(() => validateBrowserRecording(change)).toThrow()
  })
  it('accepts explicit gaps and rejects a moment from a different receiving session', () => {
    const { payload, moment } = browserRecordedFixture()
    const recording = {
      ...payload.recording,
      durationMs: 4000,
      coverage: {
        ...payload.recording.coverage,
        gaps: [{ startMs: 3000, endMs: 4000, reason: 'paused' }]
      }
    }
    expect(() => validateBrowserRecording(recording)).not.toThrow()
    expect(browserRecordingMomentSchema.parse(moment)).toEqual(moment)
    expect(() =>
      browserRecordingMomentSchema.parse({
        ...moment,
        resource: { ...moment.resource, sessionId: 'other-session' }
      })
    ).toThrow()
  })
})
