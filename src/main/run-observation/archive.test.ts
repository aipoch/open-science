import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { RunObservationHistory, RunObservationSnapshot } from '../../shared/run-observation'
import {
  buildRunObservationArchive,
  parseRunObservationArchive,
  resolveRunObservationMedia,
  verifyRunObservationMediaBytes,
  type RunObservationArchive,
  type RunObservationArchiveMedia,
  type RunObservationMediaCandidate
} from './archive'

const bytes = Buffer.from('captured screenshot bytes')
const checksum = createHash('sha256').update(bytes).digest('hex')
const media: RunObservationArchiveMedia = {
  mediaKey: 'screen-a',
  name: 'screen-a.png',
  mimeType: 'image/png',
  checksum,
  sizeBytes: bytes.length,
  sourceVersionId: 'sender-image',
  stepKeys: ['observation-0']
}
const snapshot: RunObservationSnapshot = {
  identity: {
    projectId: 'sender-project',
    sessionId: 'sender-session',
    operationId: 'sender-operation',
    environmentId: 'sender-environment',
    executionInvocationId: 'sender-invocation',
    runId: 'sender-run'
  },
  cursor: { epoch: 'sender-epoch', sequence: 0 },
  observedAt: 200,
  phase: 'completed',
  stepId: 'run:sender-run',
  artifactsTruncated: false,
  artifacts: [
    {
      versionId: 'sender-output',
      name: 'output.json',
      producerRunId: 'sender-run',
      checksum,
      sizeBytes: bytes.length
    }
  ],
  run: {
    runId: 'sender-run',
    executionInvocationId: 'sender-invocation',
    kernelKind: 'bash',
    status: 'completed',
    startedAt: 100,
    endedAt: 190,
    exitCode: 0,
    logs: {
      stdout: { text: 'done', truncated: false, redacted: false },
      stderr: { text: '', truncated: false, redacted: false },
      traceback: { text: '', truncated: false, redacted: false }
    }
  }
}
const history: RunObservationHistory = {
  coverage: 'process-local',
  truncated: false,
  snapshots: [snapshot]
}
const scope = { projectId: 'receiver-project', sessionId: 'receiver-session' }
const candidate: RunObservationMediaCandidate = {
  ...scope,
  versionId: 'receiver-image',
  name: media.name,
  checksum,
  sizeBytes: bytes.length,
  state: 'finalized',
  isPublished: true
}
function archive(): RunObservationArchive {
  return buildRunObservationArchive({
    recordingId: 'recording-a',
    history,
    capturedAt: 210,
    stopReason: 'run-ended',
    media: [media]
  })
}

describe('ordinary Artifact observation archive', () => {
  it('round-trips exact content without rewriting sender identities or inventing a screenshot producer', () => {
    const original = archive()
    const json = JSON.stringify(original)
    const imported = parseRunObservationArchive(json)
    expect(JSON.stringify(imported)).toBe(json)
    expect(imported.records[0].sourceEvidence.identity.runId).toBe('sender-run')
    expect(imported.records[0].run).not.toHaveProperty('runId')
    expect(imported.records[0].artifactEvidence[0]).toMatchObject({
      sourceVersionId: 'sender-output',
      sourceProducerRunId: 'sender-run'
    })
    expect(imported.media[0]).not.toHaveProperty('producerRunId')
    expect(imported.coverage).toMatchObject({
      kind: 'sampled-observations',
      includesPreObservationHistory: false,
      terminalRunObserved: true
    })
    expect(
      resolveRunObservationMedia(imported, scope, [candidate], { 'sender-image': 'receiver-image' })
    ).toEqual([{ mediaKey: 'screen-a', status: 'available', versionId: 'receiver-image' }])
    expect(JSON.stringify(imported)).toBe(json)
  })

  it('resolves the same immutable media after a second import without using sender IDs as local identities', () => {
    const importedAgain = parseRunObservationArchive(JSON.stringify(archive()))
    const destination = { projectId: 'third-project', sessionId: 'third-session' }
    expect(
      resolveRunObservationMedia(importedAgain, destination, [
        candidate,
        { ...candidate, ...destination, versionId: 'third-image' }
      ])
    ).toEqual([{ mediaKey: 'screen-a', status: 'available', versionId: 'third-image' }])
    expect(importedAgain.media[0].sourceVersionId).toBe('sender-image')
  })

  it('does not cross authorization scope, accept pending versions, or trust incorrect mappings/checksums', () => {
    const wrongCandidates = [
      { ...candidate, projectId: 'other-project' },
      { ...candidate, sessionId: 'other-session' },
      { ...candidate, isPublished: false },
      { ...candidate, state: 'pending' },
      { ...candidate, checksum: '0'.repeat(64) },
      { ...candidate, sizeBytes: bytes.length + 1 }
    ]
    expect(
      resolveRunObservationMedia(archive(), scope, wrongCandidates, {
        'sender-image': 'receiver-image'
      })
    ).toEqual([{ mediaKey: 'screen-a', status: 'missing' }])
  })

  it('reports missing and ambiguous media and uses a trusted mapping only after content checks', () => {
    expect(resolveRunObservationMedia(archive(), scope, [])).toEqual([
      { mediaKey: 'screen-a', status: 'missing' }
    ])
    const duplicate = { ...candidate, versionId: 'duplicate-image' }
    expect(resolveRunObservationMedia(archive(), scope, [candidate, duplicate])).toEqual([
      { mediaKey: 'screen-a', status: 'ambiguous' }
    ])
    expect(
      resolveRunObservationMedia(archive(), scope, [candidate, duplicate], {
        'sender-image': 'duplicate-image'
      })
    ).toEqual([{ mediaKey: 'screen-a', status: 'available', versionId: 'duplicate-image' }])
    expect(verifyRunObservationMediaBytes(media, bytes)).toBe(true)
    expect(verifyRunObservationMediaBytes(media, Buffer.from('changed screenshot bytes'))).toBe(
      false
    )
    expect(verifyRunObservationMediaBytes(media, Buffer.concat([bytes, bytes]))).toBe(false)
  })

  it('records truncation, redaction and known missing captures rather than claiming complete replay', () => {
    const partial = structuredClone(snapshot)
    ;(partial.cursor as { sequence: number }).sequence = 12
    ;(partial.run!.logs.stdout as { truncated: boolean; redacted: boolean }).truncated = true
    ;(partial.run!.logs.stdout as { redacted: boolean }).redacted = true
    const result = buildRunObservationArchive({
      recordingId: 'partial',
      history: { coverage: 'process-local', truncated: true, snapshots: [partial] },
      capturedAt: 210,
      stopReason: 'app-exit',
      missingMediaKeys: ['lost-screen']
    })
    expect(result.coverage).toMatchObject({
      droppedEarlierObservations: true,
      logTruncation: true,
      redactedContent: true,
      missingMediaKeys: ['lost-screen']
    })
    expect(result.records[0].stepKey).toBe('observation-12')
  })

  it('rejects false terminal/coverage claims, invented gaps and cross-execution records', () => {
    const valid = archive()
    for (const mutate of [
      (value: typeof valid) => {
        value.coverage.firstObservedAt = 999
      },
      (value: typeof valid) => {
        value.coverage.terminalRunObserved = false
      },
      (value: typeof valid) => {
        value.records[0].sourceEvidence.cursor.sequence = 8
      },
      (value: typeof valid) => {
        value.records[0].run!.status = 'running'
        value.coverage.terminalRunObserved = false
      },
      (value: typeof valid) => {
        value.media[0].stepKeys = ['unknown-step']
      },
      (value: typeof valid) => {
        value.coverage.missingMediaKeys = ['screen-a']
      },
      (value: typeof valid) => {
        value.records.push({
          ...value.records[0],
          stepKey: 'other',
          sourceEvidence: {
            ...value.records[0].sourceEvidence,
            identity: { ...value.records[0].sourceEvidence.identity, runId: 'other-run' },
            cursor: { epoch: 'sender-epoch', sequence: 1 }
          }
        })
      }
    ]) {
      const changed = structuredClone(valid)
      mutate(changed)
      expect(() => parseRunObservationArchive(JSON.stringify(changed))).toThrow()
    }
  })

  it('rejects schema additions that would smuggle live URLs or arbitrary source fields', () => {
    expect(() =>
      parseRunObservationArchive(JSON.stringify({ ...archive(), liveUrl: 'http://localhost:9999' }))
    ).toThrow()
    const value = archive()
    expect(() =>
      parseRunObservationArchive(
        JSON.stringify({ ...value, media: [{ ...media, path: '/private/file.png' }] })
      )
    ).toThrow()
    expect(() =>
      buildRunObservationArchive({
        recordingId: 'none',
        history: { ...history, snapshots: [] },
        capturedAt: 210,
        stopReason: 'manual'
      })
    ).toThrow('No recorded observations')
  })
})
