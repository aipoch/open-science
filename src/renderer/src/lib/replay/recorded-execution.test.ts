import { describe, expect, it } from 'vitest'
import type { ReplayDocument } from '../../../../shared/replay'
import type { RecordedObservationPayload } from '../../../../shared/run-observation-recorded'
import type { ResearchReplayObservationBinding } from '../../../../shared/research-replay'
import { validateRunObservationArchive } from '../../../../shared/run-observation-archive'
import {
  buildRecordedExecutionTracks,
  recordedExecutionAt,
  recordedExecutionTimes
} from './recorded-execution'
import { advanceResearchReplay } from '../../pages/workspace/replay/replay-recorded-gaps'

const target = { projectId: 'p', sessionId: 's', artifactId: 'archive', versionId: 'version' }
const fixture = (): {
  document: ReplayDocument
  payload: RecordedObservationPayload
  binding: ResearchReplayObservationBinding
} => ({
  document: {
    generatorVersion: 3,
    presentationVersion: 2,
    source: { projectId: 'p', sessionId: 's', title: 'Research', fingerprint: 'f' },
    defaultBranchId: 'branch',
    issues: [],
    resources: [
      {
        source: 'artifact',
        id: 'version',
        ...target,
        name: 'archive.json',
        checksum: 'a'.repeat(64),
        availability: 'recorded'
      }
    ],
    branches: [
      {
        id: 'branch',
        label: 'Main',
        kind: 'conversation',
        durationMs: 10000,
        steps: [
          {
            id: 'execution',
            branchId: 'branch',
            kind: 'notebook',
            startMs: 0,
            endMs: 10000,
            durationMs: 10000,
            recordedAt: 1000,
            recordedEndAt: 11000,
            activities: [],
            resourceIds: [],
            evidence: [],
            issues: [],
            runs: [
              {
                runId: 'receiver-run',
                cellId: 'cell',
                source: 'agent',
                kernelKind: 'bash',
                status: 'completed',
                startedAt: 1000,
                endedAt: 11000
              }
            ]
          }
        ]
      }
    ]
  },
  payload: {
    receiving: target,
    media: [],
    archive: validateRunObservationArchive({
      format: 'open-science-run-observation',
      version: 1,
      recordingId: 'archive-id',
      capturedAt: 11000,
      coverage: {
        kind: 'sampled-observations',
        includesPreObservationHistory: false,
        firstObservedAt: 1200,
        lastObservedAt: 9000,
        droppedEarlierObservations: false,
        terminalRunObserved: false,
        stopReason: 'manual',
        logTruncation: true,
        redactedContent: true,
        missingMediaKeys: []
      },
      records: [1200, 4000, 9000].map((observedAt, index) => ({
        stepKey: `sample-${index}`,
        observedAt,
        phase: 'running',
        sourceEvidence: {
          identity: { projectId: 'sender-p', sessionId: 'sender-s', runId: 'sender-run' },
          cursor: { epoch: 'epoch', sequence: index },
          stepId: 'sender-step'
        },
        run: {
          kernelKind: 'bash',
          status: 'running',
          startedAt: 1000,
          logs: {
            stdout: {
              text: ['ready', 'ready\nactions done', 'rotated tail'][index],
              truncated: index === 2,
              redacted: index === 2
            },
            stderr: { text: '', truncated: false, redacted: false },
            traceback: { text: '', truncated: false, redacted: false }
          }
        },
        artifactEvidence: [],
        artifactsTruncated: false
      })),
      media: []
    })
  },
  binding: {
    target,
    recordingId: 'archive-id',
    archiveChecksum: 'a'.repeat(64),
    runId: 'receiver-run',
    branchIds: ['branch'],
    basis: 'import-receipt'
  }
})

describe('saved execution track projection', () => {
  it('uses host-verified receiving Run identity without rewriting research steps', () => {
    const { document, payload, binding } = fixture()
    const before = structuredClone(document)
    const [track] = buildRecordedExecutionTracks(document, [payload], [binding], { branch: 1000 })
    expect(track).toMatchObject({
      runId: 'receiver-run',
      stepId: 'execution',
      branchId: 'branch',
      origin: 1000
    })
    expect(document).toEqual(before)
    expect(recordedExecutionTimes([track], 'branch')).toEqual([1200, 4000, 9000])
    expect(recordedExecutionTimes([track], 'foreign')).toEqual([])
  })
  it('reveals only sampled history at exact boundaries, rewinds, and reuses unchanged states', () => {
    const { document, payload, binding } = fixture()
    const [track] = buildRecordedExecutionTracks(document, [payload], [binding], { branch: 1000 })
    expect(recordedExecutionAt(track, 1199).snapshot).toBeUndefined()
    const first = recordedExecutionAt(track, 1200)
    expect(first.snapshot?.run?.logs.stdout.text).toBe('ready')
    expect(recordedExecutionAt(track, 3999)).toBe(first)
    expect(recordedExecutionAt(track, 4000).snapshot?.run?.logs.stdout.text).toBe(
      'ready\nactions done'
    )
    expect(recordedExecutionAt(track, 9500).snapshot?.run?.logs.stdout).toEqual({
      text: 'rotated tail',
      truncated: true,
      redacted: true
    })
    expect(recordedExecutionAt(track, 1500)).toBe(first)
    expect(track.select(first.snapshot!).record).toEqual(payload.archive.records[0])
  })
  it('freezes projected evidence against later source mutation', () => {
    const { document, payload, binding } = fixture()
    const [track] = buildRecordedExecutionTracks(document, [payload], [binding], { branch: 1000 })
    payload.archive.records[0].run!.logs.stdout.text = 'mutated'
    expect(recordedExecutionAt(track, 1200).snapshot?.run?.logs.stdout.text).toBe('ready')
    expect(track.select(track.snapshots[0]).record.run?.logs.stdout.text).toBe('ready')
  })
  it.each([
    'unknown-clock',
    'foreign-run',
    'foreign-receiver',
    'foreign-branch',
    'wrong-checksum',
    'wrong-recording'
  ])('does not guess an association for %s', (reason) => {
    const { document, payload, binding } = fixture()
    if (reason === 'foreign-run') binding.runId = 'other'
    if (reason === 'foreign-receiver') binding.target = { ...target, projectId: 'other' }
    if (reason === 'foreign-branch') binding.branchIds = ['other']
    if (reason === 'wrong-checksum') binding.archiveChecksum = 'b'.repeat(64)
    if (reason === 'wrong-recording') binding.recordingId = 'other'
    expect(
      buildRecordedExecutionTracks(
        document,
        [payload],
        [binding],
        reason === 'unknown-clock' ? {} : { branch: 1000 }
      )
    ).toEqual([])
  })
  it('rejects competing archives for one run rather than mixing their log snapshots', () => {
    const { document, payload, binding } = fixture()
    const second = structuredClone(payload)
    second.receiving.versionId = 'second'
    second.archive.recordingId = 'second'
    const other = { ...binding, target: second.receiving, recordingId: 'second' }
    expect(
      buildRecordedExecutionTracks(document, [payload, second], [binding, other], { branch: 1000 })
    ).toEqual([])
  })
  it('keeps status boundaries when optionally skipping quiet intervals', () => {
    const result = advanceResearchReplay({
      positionMs: 3500,
      elapsedMs: 200,
      durationMs: 20000,
      origin: 1000,
      steps: [],
      ranges: [],
      skip: true,
      observationTimes: [10000, 15000]
    })
    expect(result.positionMs).toBe(9000)
    expect(
      advanceResearchReplay({
        positionMs: 9000,
        elapsedMs: 100,
        durationMs: 20000,
        origin: 1000,
        steps: [],
        ranges: [],
        skip: true,
        observationTimes: [10000, 15000]
      }).positionMs
    ).toBe(9100)
  })
})
