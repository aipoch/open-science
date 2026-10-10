import { describe, expect, it, vi } from 'vitest'
import { buildRunObservationArchive } from '../main/run-observation/archive'
import type { RunObservationSnapshot } from './run-observation'
import { parseRunObservationArchive } from './run-observation-archive'

const first: RunObservationSnapshot = {
  identity: {
    projectId: 'project-a',
    sessionId: 'session-a',
    executionInvocationId: 'invocation-a'
  },
  cursor: { epoch: 'epoch-a', sequence: 0 },
  observedAt: 100,
  phase: 'preparing',
  stepId: 'operation:invocation-a',
  run: null,
  artifacts: [],
  artifactsTruncated: false
}

describe('browser-safe observation archive parser', () => {
  it('parses bounded portable content without a Node Buffer global', () => {
    const archive = buildRunObservationArchive({
      recordingId: 'capture-a',
      history: { coverage: 'process-local', truncated: false, snapshots: [first] },
      capturedAt: 110,
      stopReason: 'app-exit'
    })
    const text = JSON.stringify(archive)
    let parsed: unknown
    vi.stubGlobal('Buffer', undefined)
    try {
      parsed = parseRunObservationArchive(text)
    } finally {
      vi.unstubAllGlobals()
    }
    expect(parsed).toEqual(archive)
  })

  it('requires explicit truthful gap coverage, while accepting old contiguous version-1 archives', () => {
    const archive = buildRunObservationArchive({
      recordingId: 'capture-a',
      history: {
        coverage: 'process-local',
        truncated: false,
        snapshots: [
          first,
          { ...first, observedAt: 103, cursor: { epoch: first.cursor.epoch, sequence: 3 } }
        ]
      },
      capturedAt: 110,
      stopReason: 'app-exit'
    })
    expect(archive.coverage.sourceCursorGaps).toBe(2)
    expect(parseRunObservationArchive(JSON.stringify(archive))).toEqual(archive)
    delete archive.coverage.sourceCursorGaps
    expect(() => parseRunObservationArchive(JSON.stringify(archive))).toThrow('capture coverage')
    archive.records.pop()
    archive.coverage.lastObservedAt = first.observedAt
    delete archive.coverage.samplingFailures
    delete archive.coverage.unavailableSamples
    expect(parseRunObservationArchive(JSON.stringify(archive)).records).toHaveLength(1)
  })
  it('accepts up to 4096 historical samples and retains portable media references across them', () => {
    const archive = buildRunObservationArchive({
      recordingId: 'long-capture',
      history: {
        coverage: 'process-local',
        truncated: false,
        snapshots: Array.from({ length: 4096 }, (_, sequence) => ({
          ...first,
          cursor: { epoch: first.cursor.epoch, sequence },
          observedAt: first.observedAt + sequence
        }))
      },
      capturedAt: 4195,
      stopReason: 'capacity',
      capacityLimit: 'snapshots',
      media: [
        {
          mediaKey: 'all-steps',
          name: 'reference.png',
          mimeType: 'image/png',
          checksum: 'a'.repeat(64),
          sizeBytes: 10,
          stepKeys: Array.from({ length: 4096 }, (_, i) => `observation-${i}`)
        }
      ]
    })
    const parsed = parseRunObservationArchive(JSON.stringify(archive))
    expect(parsed.records).toHaveLength(4096)
    expect(parsed.records[0].sourceEvidence.cursor.sequence).toBe(0)
    expect(parsed.records[2048].sourceEvidence.cursor.sequence).toBe(2048)
    expect(parsed.records[4095].sourceEvidence.cursor.sequence).toBe(4095)
    expect(parsed.media[0].stepKeys).toHaveLength(4096)
    archive.records.push({ ...archive.records[4095], stepKey: 'observation-4096' })
    expect(() => parseRunObservationArchive(JSON.stringify(archive))).toThrow()
  })

  it('requires an explicit capacity reason and does not confuse capacity with discarded earlier observations', () => {
    const archive = buildRunObservationArchive({
      recordingId: 'capacity-capture',
      history: { coverage: 'process-local', truncated: false, snapshots: [first] },
      capturedAt: 110,
      stopReason: 'capacity',
      capacityLimit: 'record-bytes'
    })
    expect(archive.coverage).toMatchObject({
      droppedEarlierObservations: false,
      terminalRunObserved: false,
      stopReason: 'capacity',
      capacityLimit: 'record-bytes'
    })
    delete archive.coverage.capacityLimit
    expect(() => parseRunObservationArchive(JSON.stringify(archive))).toThrow('capture coverage')
    archive.coverage.capacityLimit = 'snapshots'
    archive.coverage.stopReason = 'app-exit'
    expect(() => parseRunObservationArchive(JSON.stringify(archive))).toThrow('capture coverage')
  })
})
