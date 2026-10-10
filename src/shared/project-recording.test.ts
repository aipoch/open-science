import { describe, expect, it, vi } from 'vitest'
import { buildRunObservationArchive } from '../main/run-observation/archive'
import {
  isProjectRecordingValue,
  parseProjectRecording,
  projectLegacyObservationToTrack,
  projectRecordingToTrack,
  validateProjectRecording,
  type ProjectRecording
} from './project-recording'

const recording = (): ProjectRecording => ({
  format: 'open-science-project-recording',
  version: 1,
  recordingId: 'project-only',
  startedAt: 100,
  endedAt: 200,
  media: [
    {
      mediaKey: 'image',
      name: 'frame.png',
      mimeType: 'image/png',
      checksum: 'a'.repeat(64),
      sizeBytes: 42,
      sourceVersionId: 'original-version'
    }
  ],
  frames: [
    {
      frameId: 'frame-0',
      sequence: 0,
      recordedAt: 150,
      mediaKey: 'image',
      provenance: {
        kind: 'capture',
        source: 'project-export',
        startedAt: 140,
        finishedAt: 150,
        width: 20,
        height: 10
      }
    }
  ],
  states: [
    {
      stateId: 'state-0',
      sequence: 0,
      recordedAt: 150,
      source: 'author-declared',
      value: { score: 3 }
    }
  ],
  events: [
    {
      eventId: 'event-0',
      sequence: 0,
      recordedAt: 160,
      source: 'author-declared',
      name: 'move',
      data: { direction: 'left' }
    }
  ],
  coverage: {
    kind: 'sampled-project-recording',
    stopReason: 'finished',
    failures: 0,
    unchangedSamples: 0,
    droppedSamples: 0,
    missingMediaKeys: []
  }
})

describe('independent project recording', () => {
  it('round trips without a Notebook, native authority, Buffer or a live endpoint', () => {
    vi.stubGlobal('Buffer', undefined)
    try {
      const original = recording()
      const parsed = parseProjectRecording(JSON.stringify(original))
      expect(parsed).toEqual(original)
      expect(projectRecordingToTrack(parsed).source).toBeUndefined()
      expect(Object.isFrozen(projectRecordingToTrack(parsed).frames[0])).toBe(true)
    } finally {
      vi.unstubAllGlobals()
    }
  })
  it('rejects forged media identities, times, sequence and executable value shapes', () => {
    for (const change of [
      (value: ProjectRecording) => {
        value.frames[0].mediaKey = 'absent'
      },
      (value: ProjectRecording) => {
        value.frames[0].sequence = 9
      },
      (value: ProjectRecording) => {
        value.frames[0].recordedAt = 99
      },
      (value: ProjectRecording) => {
        value.media[0].checksum = 'invalid'
      },
      (value: ProjectRecording) => {
        value.media.push(value.media[0])
      },
      (value: ProjectRecording) => {
        value.frames[0].provenance = {
          kind: 'derived',
          method: 'inferred',
          sourceMediaKeys: ['image']
        }
      }
    ]) {
      const value = recording()
      change(value)
      expect(() => validateProjectRecording(value)).toThrow()
    }
    expect(() => validateProjectRecording({ ...recording(), command: 'run it' })).toThrow()
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(isProjectRecordingValue(cyclic)).toBe(false)
    expect(isProjectRecordingValue({ handler: () => 1 })).toBe(false)
    expect(isProjectRecordingValue({ value: Infinity })).toBe(false)
    expect(isProjectRecordingValue({ large: 'x'.repeat(70_000) })).toBe(false)
    expect(isProjectRecordingValue({ axes: [1, 2, null], title: 'recorded' })).toBe(true)
  })
  it('keeps derived frames explicit with fixed source media', () => {
    const value = recording()
    value.media.push({ ...value.media[0], mediaKey: 'derived', sourceVersionId: 'derived-version' })
    value.frames.push({
      frameId: 'derived-frame',
      sequence: 1,
      recordedAt: 170,
      mediaKey: 'derived',
      provenance: { kind: 'derived', method: 'Annotated saved image', sourceMediaKeys: ['image'] }
    })
    expect(projectRecordingToTrack(value).frames[1].provenance.kind).toBe('derived')
  })
  it('adapts multiple captures on one legacy observation without inventing execution steps', () => {
    const archive = buildRunObservationArchive({
      recordingId: 'legacy',
      capturedAt: 200,
      stopReason: 'app-exit',
      history: {
        coverage: 'process-local',
        truncated: false,
        snapshots: [
          {
            identity: { projectId: 'sender', sessionId: 'original', operationId: 'op' },
            cursor: { epoch: 'epoch', sequence: 0 },
            observedAt: 100,
            phase: 'preparing',
            stepId: 'operation:op',
            run: null,
            artifacts: [],
            artifactsTruncated: false
          }
        ]
      },
      media: [160, 120].map((at) => ({
        mediaKey: `image-${at}`,
        name: 'frame.png',
        mimeType: 'image/png',
        checksum: 'a'.repeat(64),
        sizeBytes: 42,
        sourceVersionId: `version-${at}`,
        stepKeys: ['observation-0'],
        capture: {
          source: 'project-export',
          association: 'current-observation',
          startedAt: at - 1,
          finishedAt: at,
          observedAt: 100,
          width: 20,
          height: 10
        }
      }))
    })
    const before = JSON.stringify(archive)
    const track = projectLegacyObservationToTrack(archive)
    expect(
      track.frames.map((frame) => [frame.sequence, frame.recordedAt, frame.sourceStepKeys])
    ).toEqual([
      [0, 120, ['observation-0']],
      [1, 160, ['observation-0']]
    ])
    expect(track.states).toEqual([])
    expect(track.events).toEqual([])
    expect(track.source?.runId).toBeUndefined()
    expect(JSON.stringify(archive)).toBe(before)
  })
})
