import { describe, expect, it } from 'vitest'
import type { RecordedBrowserPayload } from '../../../../shared/browser-recording'
import {
  REPLAY_GENERATOR_VERSION,
  REPLAY_PRESENTATION_VERSION,
  type ReplayDocument,
  type ReplayStep
} from '../../../../shared/replay'
import { createBrowserRecordingReplayTimeline, createResearchReplayTimeline } from './recorded-time'

const step = (id: string, recordedAt?: number): ReplayStep => ({
  id,
  kind: 'message',
  branchId: 'main',
  recordedAt,
  startMs: 0,
  endMs: 2500,
  durationMs: 2500,
  evidence: [],
  activities: [],
  runs: [],
  resourceIds: [],
  issues: []
})
const document = (): ReplayDocument => ({
  generatorVersion: REPLAY_GENERATOR_VERSION,
  presentationVersion: REPLAY_PRESENTATION_VERSION,
  source: {
    projectId: 'project',
    sessionId: 'session',
    title: 'Research',
    fingerprint: 'revision'
  },
  defaultBranchId: 'main',
  branches: [
    {
      id: 'main',
      kind: 'conversation',
      durationMs: 7500,
      steps: [step('first', 1000), step('second', 21000), step('last', 41000)]
    }
  ],
  resources: [],
  issues: []
})
const payload = (): Pick<RecordedBrowserPayload, 'receiving' | 'recording'> => ({
  receiving: { projectId: 'project', sessionId: 'session', artifactId: 'index', versionId: 'v1' },
  recording: {
    format: 'open-science-web-recording',
    version: 1,
    recordingId: 'recording',
    source: { projectId: 'project', sessionId: 'session', operationId: 'operation' },
    startedAt: 20000,
    durationMs: 10000,
    media: [],
    segments: [],
    events: [],
    coverage: { stopReason: 'finished', gaps: [], droppedFrames: 0 }
  }
})

describe('recorded research clock', () => {
  it('keeps recording infrastructure as attachments without changing research duration or source', () => {
    const source = document()
    const technical = {
      id: 'checkpoint',
      name: 'checkpoint.json',
      projectId: 'project',
      sessionId: 'session',
      artifactId: 'index',
      versionId: 'checkpoint-version',
      availability: 'recorded' as const
    }
    source.resources = [technical]
    source.branches[0].steps[1] = {
      ...step('checkpoint-step', 21000),
      kind: 'artifact',
      resourceIds: ['checkpoint']
    }
    const result = createResearchReplayTimeline(source, [], ['checkpoint'])
    expect(result.document.branches[0].steps.map((item) => item.id)).toEqual(['first', 'last'])
    expect(result.document.branches[0].durationMs).toBe(40000)
    expect(result.document.resources).toEqual([technical])
    expect(source.branches[0].steps).toHaveLength(3)
  })
  it('builds the research clock before any recording is selected', () => {
    const source = document()
    const result = createResearchReplayTimeline(source)
    expect(result.recordedTimeOrigins).toEqual({ main: 1000 })
    expect(result.document.branches[0].durationMs).toBe(40000)
    expect(result.unalignedBranchIds).toEqual([])
    expect(source.branches[0].durationMs).toBe(7500)
  })

  it('uses all associated coverage with no dependency on selection or catalog order', () => {
    const first = payload()
    const second = payload()
    second.recording.recordingId = 'later'
    second.recording.startedAt = 50000
    second.recording.durationMs = 20000
    second.recording.segments = [
      {
        segmentId: 'segment',
        mediaKey: 'video',
        startMs: 28,
        endMs: 12000,
        width: 952,
        height: 626,
        codec: 'vp8',
        frameRate: 15
      }
    ]
    const a = createResearchReplayTimeline(document(), [first, second])
    const b = createResearchReplayTimeline(document(), [second, first])
    expect(a.document).toEqual(b.document)
    expect(a.document.branches[0].durationMs).toBe(69000)
    expect(a.timelineCoverage.main).toEqual([{ startedAt: 50028, endedAt: 62000 }])
  })

  it('never extends source research with another local execution or ambiguous branch', () => {
    const other = payload()
    other.receiving.sessionId = 'local-copy'
    other.recording.durationMs = 100000
    const result = createResearchReplayTimeline(document(), [other])
    expect(result.document.branches[0].durationMs).toBe(40000)
    expect(result.coverage.main).toEqual([])
  })

  it('keeps missing-time branches in their original presentation mode', () => {
    const source = document()
    source.branches[0].steps[1].recordedAt = undefined
    source.branches.push({
      id: 'complete',
      kind: 'conversation',
      durationMs: 5000,
      steps: [{ ...step('known', 1000), branchId: 'complete' }]
    })
    const result = createResearchReplayTimeline(source)
    expect(result.document.branches[0]).toBe(source.branches[0])
    expect(result.unalignedBranchIds).toEqual(['main'])
    expect(result.recordedTimeOrigins).toEqual({ complete: 1000 })
    expect(result.document.branches[1].durationMs).toBe(0)
  })

  it('preserves overlapping operations rather than serializing their actual end times', () => {
    const source = document()
    source.branches[0].steps[0].recordedEndAt = 35000
    const result = createResearchReplayTimeline(source)
    expect(result.document.branches[0].steps[0].endMs).toBe(34000)
    expect(result.document.branches[0].steps[1].startMs).toBe(20000)
  })

  it('identifies only exact receiving media as supporting resources', () => {
    const source = document()
    const mediaResource = {
      id: 'media',
      name: 'part.webm',
      projectId: 'project',
      sessionId: 'session',
      artifactId: 'media-artifact',
      versionId: 'media-version',
      availability: 'recorded' as const
    }
    source.resources = [mediaResource, { ...mediaResource, id: 'foreign', sessionId: 'other' }]
    const recording = {
      ...payload(),
      media: [
        {
          mediaKey: 'm',
          artifactId: 'media-artifact',
          versionId: 'media-version',
          checksum: 'a'.repeat(64),
          sizeBytes: 100
        }
      ]
    }
    expect(createResearchReplayTimeline(source, [recording]).supportingResourceIds).toEqual([
      'media'
    ])
  })

  it('replaces compressed presentation durations with actual elapsed time without mutating evidence', () => {
    const source = document()
    const result = createBrowserRecordingReplayTimeline(source, 'main', payload())!
    expect(result.startedAt).toBe(1000)
    expect(result.endedAt).toBe(41000)
    expect(result.document.branches[0].durationMs).toBe(40000)
    expect(
      result.document.branches[0].steps.map((item) => [item.startMs, item.durationMs])
    ).toEqual([
      [0, 20000],
      [20000, 20000],
      [40000, 0]
    ])
    expect(result.timestampAt(19000)).toBe(20000)
    expect(result.positionAt(20000)).toBe(19000)
    expect(result.document.source).toBe(source.source)
    expect(source.branches[0].durationMs).toBe(7500)
    expect(source.branches[0].steps[0].durationMs).toBe(2500)
  })

  it('holds only the known recorded points across time without inventing intermediate steps', () => {
    const source = document()
    const result = createBrowserRecordingReplayTimeline(source, 'main', payload())!
    expect(result.document.branches[0].steps.map((item) => item.recordedAt)).toEqual([
      1000, 21000, 41000
    ])
    expect(result.document.branches[0].steps.map((item) => item.recordedEndAt)).toEqual([
      undefined,
      undefined,
      undefined
    ])
    expect(result.timestampAt(-1)).toBeUndefined()
    expect(result.timestampAt(40001)).toBeUndefined()
    expect(result.timestampAt(NaN)).toBeUndefined()
    expect(result.positionAt(999)).toBeUndefined()
    expect(result.positionAt(Infinity)).toBeUndefined()
  })

  it('retains actual completion times and recording coverage beyond the last session point', () => {
    const source = document()
    source.branches[0].steps[1].recordedEndAt = 26000
    const recording = payload()
    recording.recording.durationMs = 30000
    const result = createBrowserRecordingReplayTimeline(source, 'main', recording)!
    expect(result.endedAt).toBe(50000)
    expect(result.document.branches[0].steps[1].endMs).toBe(25000)
    expect(result.document.branches[0].steps[1].durationMs).toBe(5000)
    expect(result.document.branches[0].steps[2].durationMs).toBe(9000)
  })

  it('preserves simultaneous point records without making up a millisecond of elapsed time', () => {
    const source = document()
    source.branches[0].steps[1].recordedAt = 1000
    const result = createBrowserRecordingReplayTimeline(source, 'main', payload())!
    expect(result.document.branches[0].steps[0].durationMs).toBe(0)
    expect(result.document.branches[0].steps[1].startMs).toBe(0)
  })

  it.each([undefined, NaN, -1, 0.5])('rejects a missing or invalid timestamp: %s', (time) => {
    const source = document()
    source.branches[0].steps[1].recordedAt = time
    expect(createBrowserRecordingReplayTimeline(source, 'main', payload())).toBeUndefined()
  })

  it('projects publication-grouped Tuanzi records chronologically with real recording offsets', () => {
    // Timing-only regression from the local exported/imported acceptance, without chat content,
    // project paths, execution credentials, or retained local identities.
    const source = document()
    const requestedAt = 1791374285806
    source.branches[0].steps = [
      step('request', requestedAt),
      { ...step('answer', 1791374505009), recordedEndAt: 1791374505205 },
      step('first-recording-segment', 1791374371248),
      step('same-time-result', 1791374371248),
      step('final-index', 1791374504946),
      { ...step('notebook', 1791374286381), kind: 'notebook', recordedEndAt: 1791374502408 }
    ]
    const recording = payload()
    recording.recording.startedAt = 1791374368145
    recording.recording.durationMs = 96560
    const result = createBrowserRecordingReplayTimeline(source, 'main', recording)!
    expect(result.document.branches[0].steps.map((item) => item.id)).toEqual([
      'request',
      'notebook',
      'first-recording-segment',
      'same-time-result',
      'final-index',
      'answer'
    ])
    expect(source.branches[0].steps[1].id).toBe('answer')
    expect(source.branches[0].steps.at(-1)!.id).toBe('notebook')
    expect(result.startedAt).toBe(requestedAt)
    expect(result.endedAt - result.startedAt).toBe(219399)
    expect(result.positionAt(recording.recording.startedAt)).toBe(82339)
    expect(result.positionAt(recording.recording.startedAt + recording.recording.durationMs)).toBe(
      178899
    )
    expect(result.timestampAt(82339)).toBe(recording.recording.startedAt)
    expect(result.document.branches[0].steps[2].durationMs).toBe(0)
  })

  it('rejects invalid completions and recording end overflow', () => {
    const source = document()
    source.branches[0].steps[1].recordedEndAt = 20000
    expect(createBrowserRecordingReplayTimeline(source, 'main', payload())).toBeUndefined()
    const recording = payload()
    recording.recording.startedAt = Number.MAX_SAFE_INTEGER
    expect(createBrowserRecordingReplayTimeline(document(), 'main', recording)).toBeUndefined()
  })

  it('does not align another local execution or a recording merely copied into source files', () => {
    const recording = payload()
    recording.receiving.sessionId = 'different-local-run'
    expect(createBrowserRecordingReplayTimeline(document(), 'main', recording)).toBeUndefined()
    recording.receiving.sessionId = 'session'
    recording.recording.source!.sessionId = 'different-source'
    expect(createBrowserRecordingReplayTimeline(document(), 'main', recording)).toBeUndefined()
    delete recording.recording.source
    expect(createBrowserRecordingReplayTimeline(document(), 'main', recording)).toBeUndefined()
  })

  it('matches imported author source identity while keeping receiver scope exact', () => {
    const source = document()
    source.source.packageOrigin = {
      importId: 'import',
      sourceProjectId: 'sender-project',
      sourceSessionId: 'sender-session',
      importedAt: 50000,
      manifestChecksum: 'a'.repeat(64)
    }
    const recording = payload()
    recording.recording.source = { projectId: 'sender-project', sessionId: 'sender-session' }
    expect(createBrowserRecordingReplayTimeline(source, 'main', recording)).toBeDefined()
    recording.receiving.sessionId = 'sender-session'
    expect(createBrowserRecordingReplayTimeline(source, 'main', recording)).toBeUndefined()
  })

  it('requires an explicit execution association for branched research', () => {
    const source = document()
    source.branches.push({ ...source.branches[0], id: 'other', steps: [step('other', 1000)] })
    expect(createBrowserRecordingReplayTimeline(source, 'main', payload())).toBeUndefined()
    const recording = payload()
    recording.recording.source!.runId = 'run'
    source.branches[0].steps[1].runs.push({
      runId: 'run',
      cellId: 'cell',
      source: 'user',
      kernelKind: 'bash',
      status: 'completed',
      startedAt: 1000
    })
    const result = createBrowserRecordingReplayTimeline(source, 'main', recording)!
    expect(result).toBeDefined()
    expect(result.document.branches[1]).toBe(source.branches[1])
    expect(createBrowserRecordingReplayTimeline(source, 'other', recording)).toBeUndefined()
  })

  it('can associate remapped imports through a unique exact published index Version', () => {
    const source = document()
    source.branches.push({ ...source.branches[0], id: 'other', steps: [step('other', 1000)] })
    source.resources.push({
      id: 'index-resource',
      name: 'recording.json',
      projectId: 'project',
      sessionId: 'session',
      artifactId: 'index',
      versionId: 'v1',
      availability: 'recorded'
    })
    source.branches[0].steps[2].resourceIds = ['index-resource']
    expect(createBrowserRecordingReplayTimeline(source, 'main', payload())).toBeDefined()
    expect(createBrowserRecordingReplayTimeline(source, 'other', payload())).toBeUndefined()
    source.branches[1].steps[0].resourceIds = ['index-resource']
    expect(createBrowserRecordingReplayTimeline(source, 'main', payload())).toBeUndefined()
  })
})
