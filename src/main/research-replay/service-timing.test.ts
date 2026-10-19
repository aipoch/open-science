import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { ReplayDocument, ReplayResource, ReplayStep } from '../../shared/replay'
import type { RecordedEvidencePayload } from '../../shared/run-observation-recorded'
import type { NotebookRunInputFile } from '../../shared/notebook'
import {
  validateBrowserRecording,
  type BrowserRecording,
  type RecordedBrowserPayload
} from '../../shared/browser-recording'
import * as replaySource from '../../renderer/src/lib/replay/source'
import { browserRecordedFixture } from '../run-observation/browser-recorded.test-support'
import { recordedFixture } from '../run-observation/recorded-viewer.test-support'
import { researchReplayHarness } from './test-support'

function step(
  id: string,
  branchId: string,
  recordedAt: number,
  resourceIds: string[] = []
): ReplayStep {
  return {
    id,
    branchId,
    recordedAt,
    kind: resourceIds.length ? 'artifact' : 'message',
    activities: [],
    runs: [],
    evidence: [],
    resourceIds,
    issues: [],
    startMs: 0,
    endMs: 1,
    durationMs: 1
  }
}
function setup(
  payload: RecordedEvidencePayload
): ReturnType<typeof researchReplayHarness> & { document: ReplayDocument } {
  const h = researchReplayHarness(),
    index = Buffer.from(JSON.stringify('archive' in payload ? payload.archive : payload.recording)),
    result = Buffer.from('scientific report'),
    indexChecksum = createHash('sha256').update(index).digest('hex'),
    resultChecksum = createHash('sha256').update(result).digest('hex')
  const resource = (
    id: string,
    versionId: string,
    checksum: string,
    size: number
  ): ReplayResource => ({
    id: `artifact-version:${versionId}`,
    name: `${id}.json`,
    projectId: h.target.projectId,
    sessionId: h.target.sessionId,
    artifactId: id,
    versionId,
    checksum,
    size,
    availability: 'recorded'
  })
  const indexResource = resource('artifact', 'version', indexChecksum, index.length),
    resultResource = resource('result', 'result-v', resultChecksum, result.length)
  const document: ReplayDocument = {
    generatorVersion: 3,
    presentationVersion: 2,
    source: { ...h.target, title: 'Study', fingerprint: 'frozen-source' },
    defaultBranchId: 'a',
    branches: [
      {
        id: 'a',
        kind: 'conversation',
        durationMs: 2,
        steps: [step('message-a', 'a', 1000), step('index', 'a', 5000, [indexResource.id])]
      },
      {
        id: 'b',
        kind: 'conversation',
        durationMs: 2,
        steps: [
          step('message-b', 'b', 1000),
          step('scientific-result', 'b', 3000, [resultResource.id])
        ]
      }
    ],
    resources: [indexResource, resultResource],
    issues: []
  }
  vi.mocked(h.dependencies.immutable.resolveVersion).mockImplementation(async (request) => {
    const saved = request.inputFileVersionId === 'version' ? indexResource : resultResource
    return {
      sourceKind: 'artifact-version',
      sourceProjectId: h.target.projectId,
      sourceSessionId: h.target.sessionId,
      sourceFileId: saved.artifactId!,
      inputFileVersionId: saved.versionId!,
      sourceVersionNumber: 1,
      filename: saved.name,
      sizeBytes: saved.size!,
      checksum: saved.checksum!,
      storageKey: saved.id,
      association: 'turn-attached'
    }
  })
  vi.mocked(h.dependencies.immutable.openContent).mockImplementation(
    async (input) =>
      ({
        readRange: async () => (input.inputFileVersionId === 'version' ? index : result),
        verifyUnchanged: async () => undefined,
        close: async () => undefined
      }) as never
  )
  vi.mocked(h.dependencies.recordings.readBrowser).mockResolvedValue(payload as never)
  vi.mocked(h.dependencies.recordings.read).mockResolvedValue(payload as never)
  return { ...h, document }
}

describe('authoritative research timing and supporting files', () => {
  it('retains branch association and trailing duration after hiding the only index publication step', async () => {
    const fixture = browserRecordedFixture(),
      receiving = {
        projectId: 'project',
        sessionId: 'session',
        artifactId: 'artifact',
        versionId: 'version'
      }
    const payload = {
      ...fixture.payload,
      receiving,
      recording: {
        ...fixture.payload.recording,
        source: { projectId: 'project', sessionId: 'session' },
        startedAt: 2000,
        durationMs: 2000
      }
    }
    const h = setup(payload),
      read = vi.spyOn(replaySource, 'loadReplayDocument').mockResolvedValue(h.document)
    try {
      const view = await h.service.open(h.target, h.caller),
        research = await h.service.document(view.viewerId, h.caller)
      expect(research.document.branches[0].steps.map((item) => item.id)).toEqual(['message-a'])
      expect(research.document.branches[0].durationMs).toBe(4000)
      expect(research.timing.recordedTimeOrigins.a).toBe(1000)
      expect(research.timing.coverage.a).toHaveLength(1)
      expect(research.timing.coverage.b).toEqual([])
      expect(research.timing.coverage.a[0].target).toEqual(receiving)
      // This metadata travels with the already-projected document. Removing the index must
      // neither make the browser recompute a zero-length branch nor detach valid footage.
      expect(
        (await h.service.read(view.viewerId, { kind: 'overview' }, h.caller)) as object
      ).toMatchObject({
        branches: [
          { id: 'a', durationMs: 4000 },
          { id: 'b', durationMs: 2000 }
        ]
      })
    } finally {
      read.mockRestore()
      h.service.close()
    }
  })
  it('keeps a declared scientific report visible instead of classifying every archive attachment as technical', async () => {
    const fixture = recordedFixture(),
      receiving = {
        projectId: 'project',
        sessionId: 'session',
        artifactId: 'artifact',
        versionId: 'version'
      }
    const payload = {
      ...fixture.payload,
      receiving,
      media: fixture.payload.media.map((media) => ({
        ...media,
        artifactId: 'result',
        versionId: 'result-v'
      }))
    }
    const h = setup(payload),
      read = vi.spyOn(replaySource, 'loadReplayDocument').mockResolvedValue(h.document)
    try {
      const view = await h.service.open(h.target, h.caller),
        research = await h.service.document(view.viewerId, h.caller)
      expect(research.supportingResourceIds).toContain('artifact-version:version')
      expect(research.supportingResourceIds).not.toContain('artifact-version:result-v')
      expect(
        research.document.branches[1].steps.some((item) => item.id === 'scientific-result')
      ).toBe(true)
    } finally {
      read.mockRestore()
      h.service.close()
    }
  })
})

describe('verified observation bindings in the research read model', () => {
  it('exposes Main-resolved bindings without changing ordinary recorded payloads', async () => {
    const payload = recordedFixture().payload
    const h = setup(payload)
    const binding = {
      target: payload.receiving,
      recordingId: payload.archive.recordingId,
      archiveChecksum: h.document.resources[0].checksum!,
      runId: 'receiver-run',
      branchIds: ['a'],
      basis: 'import-receipt' as const
    }
    h.dependencies.observationBindings = vi.fn(async () => [binding])
    vi.spyOn(replaySource, 'loadReplayDocument').mockResolvedValueOnce(h.document)
    const view = await h.service.open(h.target, h.caller)
    expect(h.dependencies.observationBindings).toHaveBeenCalledWith(h.document, [payload])
    expect((await h.service.document(view.viewerId, h.caller)).observationBindings).toEqual([
      binding
    ])
    expect(await h.service.read(view.viewerId, { kind: 'overview' }, h.caller)).toMatchObject({
      observationBindings: [binding]
    })
    binding.runId = 'changed-outside'
    // The bindings join the same immutable viewer snapshot as the saved source document.
    expect((await h.service.document(view.viewerId, h.caller)).observationBindings?.[0].runId).toBe(
      'receiver-run'
    )
  })
  it('keeps the ordinary Replay readable when an optional binding cannot be established', async () => {
    const h = setup(recordedFixture().payload)
    h.dependencies.observationBindings = vi.fn(async () => {
      throw new Error('receipt unavailable')
    })
    vi.spyOn(replaySource, 'loadReplayDocument').mockResolvedValueOnce(h.document)
    const view = await h.service.open(h.target, h.caller)
    expect((await h.service.document(view.viewerId, h.caller)).observationBindings).toEqual([])
  })
})

function browserIndex(segments: number, group = 'a'): BrowserRecording {
  const bytes = Buffer.from('video')
  const checksum = createHash('sha256').update(bytes).digest('hex')
  return validateBrowserRecording({
    format: 'open-science-web-recording',
    version: 1,
    recordingId: group,
    title: 'Recorded experiment',
    startedAt: 1000,
    durationMs: segments * 1100,
    // Imported recordings retain their original source, not the receiving project/session.
    source: {
      projectId: 'author-project',
      sessionId: 'author-session',
      operationId: `operation-${group}`,
      executionInvocationId: `invocation-${group}`,
      runId: `run-${group}`
    },
    media: Array.from({ length: segments }, (_, index) => ({
      mediaKey: `segment-${index}`,
      name: `segment-${index}.webm`,
      mimeType: 'video/webm',
      checksum,
      sizeBytes: bytes.length,
      sourceVersionId: `author-${group}-${index}`
    })),
    segments: Array.from({ length: segments }, (_, index) => ({
      segmentId: `segment-${index}`,
      mediaKey: `segment-${index}`,
      startMs: index * 1100,
      endMs: index * 1100 + 1000,
      width: 640,
      height: 480,
      codec: 'vp8',
      frameRate: 10
    })),
    events: Array.from({ length: segments }, (_, index) => ({
      eventId: `event-${index}`,
      offsetMs: index * 1100 + 50,
      kind: 'click',
      source: 'browser-observed',
      x: 10,
      y: 20
    })),
    coverage: {
      stopReason: 'stopped',
      gaps: Array.from({ length: segments }, (_, index) => ({
        startMs: index * 1100 + 1000,
        endMs: (index + 1) * 1100,
        reason: 'paused'
      })),
      droppedFrames: segments
    }
  })
}

type BrowserIndexFixture = {
  versionId: string
  name: string
  recording: BrowserRecording
  unavailable?: boolean
  resolvedMedia?: RecordedBrowserPayload['media']
}

function finalIndex(segments = 3, group = 'a'): BrowserIndexFixture {
  return {
    versionId: `final-${group}`,
    name: `web-recording-${group}.json`,
    recording: browserIndex(segments, group)
  }
}

function checkpointIndex(segments = 1, group = 'a'): BrowserIndexFixture {
  const recording = browserIndex(segments, group)
  recording.coverage.stopReason = 'interrupted'
  return {
    versionId: `checkpoint-${group}-${segments}`,
    name: `web-recording-${group}-checkpoint-${segments}.json`,
    recording
  }
}

function browserCheckpointHarness(indices: BrowserIndexFixture[]): ReturnType<typeof setup> & {
  bodies: Map<string, Buffer>
} {
  const h = setup(browserRecordedFixture().payload)
  h.document.resources = []
  const bodies = new Map<string, Buffer>()
  const addResource = (versionId: string, name: string, body: Buffer, mimeType: string): void => {
    if (bodies.has(versionId)) return
    bodies.set(versionId, body)
    h.document.resources.push({
      id: `artifact-version:${versionId}`,
      name,
      ...h.target,
      artifactId: `artifact-${versionId}`,
      versionId,
      versionNumber: 1,
      checksum: createHash('sha256').update(body).digest('hex'),
      size: body.length,
      mimeType,
      availability: 'recorded'
    })
  }
  for (const index of indices) {
    addResource(
      index.versionId,
      index.name,
      Buffer.from(JSON.stringify(index.recording)),
      'application/json'
    )
    for (const media of index.recording.media)
      addResource(
        `receiving-${media.sourceVersionId}`,
        media.name,
        Buffer.from('video'),
        'video/webm'
      )
  }
  addResource(
    'report',
    'report.json',
    Buffer.from('{"finding":"saved result"}'),
    'application/json'
  )
  h.document.branches = [
    {
      id: 'a',
      kind: 'conversation',
      durationMs: 2,
      steps: [
        step('message', 'a', 1000),
        ...h.document.resources.map((resource) => step(resource.id, 'a', 5000, [resource.id]))
      ]
    }
  ]
  vi.mocked(h.dependencies.immutable.resolveVersion).mockImplementation(async (request) => {
    const saved = h.document.resources.find((item) => item.versionId === request.inputFileVersionId)
    if (!saved) return undefined
    return {
      sourceKind: 'artifact-version',
      sourceProjectId: h.target.projectId,
      sourceSessionId: h.target.sessionId,
      sourceFileId: saved.artifactId!,
      inputFileVersionId: saved.versionId!,
      sourceVersionNumber: 1,
      filename: saved.name,
      sizeBytes: saved.size!,
      checksum: saved.checksum!,
      storageKey: saved.id,
      association: 'turn-attached'
    }
  })
  vi.mocked(h.dependencies.immutable.openContent).mockImplementation(
    async (input) =>
      ({
        readRange: async () => bodies.get(input.inputFileVersionId)!,
        verifyUnchanged: async () => undefined,
        close: async () => undefined
      }) as never
  )
  vi.mocked(h.dependencies.recordings.readBrowser).mockImplementation(async (receiving) => {
    const index = indices.find((item) => item.versionId === receiving.versionId)
    if (!index || index.unavailable) throw new Error('Index mapping unavailable')
    return {
      receiving,
      recording: structuredClone(index.recording),
      indexChecksum: createHash('sha256').update(bodies.get(index.versionId)!).digest('hex'),
      media:
        index.resolvedMedia ??
        index.recording.media.map((media) => ({
          mediaKey: media.mediaKey,
          artifactId: `artifact-receiving-${media.sourceVersionId}`,
          versionId: `receiving-${media.sourceVersionId}`,
          checksum: media.checksum,
          sizeBytes: media.sizeBytes
        }))
    }
  })
  vi.spyOn(replaySource, 'loadReplayDocument').mockImplementation(async () => h.document)
  return { ...h, bodies }
}

describe('verified browser checkpoint deduplication', () => {
  it('resolves cumulative imported media only once while checking every immutable index', async () => {
    const indices = [
      finalIndex(120),
      ...Array.from({ length: 120 }, (_, index) => checkpointIndex(index + 1))
    ]
    const h = browserCheckpointHarness(indices)
    const view = await h.service.open(h.target, h.caller)
    const research = await h.service.document(view.viewerId, h.caller)
    expect(h.dependencies.recordings.readBrowser).toHaveBeenCalledTimes(1)
    expect(h.dependencies.recordings.readBrowser).toHaveBeenCalledWith({
      ...h.target,
      artifactId: 'artifact-final-a',
      versionId: 'final-a'
    })
    // This used to resolve 7,380 cumulative media entries, instead of the final 120.
    expect(h.dependencies.immutable.openContent).toHaveBeenCalledTimes(indices.length + 1)
    expect(h.dependencies.immutable.resolveVersion).toHaveBeenCalledTimes((indices.length + 1) * 2)
    expect(research.recordings.map((item) => item.id)).toEqual(['artifact-version:final-a'])
    expect(new Set(research.supportingResourceIds)).toEqual(
      new Set(
        h.document.resources.filter((item) => item.versionId !== 'report').map((item) => item.id)
      )
    )
    expect(research.unavailableRecordingIds).toEqual([])
    expect(research.document.branches[0].steps.map((item) => item.id)).toEqual([
      'message',
      'artifact-version:report'
    ])
    await expect(
      h.service.read(
        view.viewerId,
        { kind: 'recording', recordingId: 'artifact-version:checkpoint-a-120' },
        h.caller
      )
    ).rejects.toMatchObject({ code: 'not-found' })
  })

  it('does not infer final identity from a file name or skip a different recording', async () => {
    const namedFinal = finalIndex()
    namedFinal.name = 'saved-browser-index.json'
    const checkpoint = checkpointIndex()
    checkpoint.name = 'saved-browser-checkpoint.json'
    const h = browserCheckpointHarness([
      namedFinal,
      checkpoint,
      finalIndex(2, 'b'),
      checkpointIndex(1, 'b')
    ])
    const view = await h.service.open(h.target, h.caller)
    expect(h.dependencies.recordings.readBrowser).toHaveBeenCalledTimes(2)
    expect((await h.service.document(view.viewerId, h.caller)).recordings).toHaveLength(2)
  })

  it('keeps the original latest-checkpoint fallback when the final cannot be mapped', async () => {
    const final = finalIndex()
    final.unavailable = true
    const h = browserCheckpointHarness([final, checkpointIndex(1), checkpointIndex(2)])
    const view = await h.service.open(h.target, h.caller)
    const research = await h.service.document(view.viewerId, h.caller)
    expect(h.dependencies.recordings.readBrowser).toHaveBeenCalledTimes(3)
    expect(research.recordings.map((item) => item.id)).toEqual(['artifact-version:checkpoint-a-2'])
    expect(research.unavailableRecordingIds).toEqual(['artifact-version:final-a'])
  })

  it.each(['missing', 'checksum', 'size'] as const)(
    'does not reuse a final with %s receiving media evidence',
    async (failure) => {
      const final = finalIndex(1)
      final.resolvedMedia = []
      if (failure !== 'missing')
        final.resolvedMedia.push({
          mediaKey: final.recording.media[0].mediaKey,
          artifactId: 'artifact-receiving-author-a-0',
          versionId: 'receiving-author-a-0',
          checksum: failure === 'checksum' ? '0'.repeat(64) : final.recording.media[0].checksum,
          sizeBytes: failure === 'size' ? 1 : final.recording.media[0].sizeBytes
        })
      const h = browserCheckpointHarness([final, checkpointIndex(1)])
      await h.service.open(h.target, h.caller)
      expect(h.dependencies.recordings.readBrowser).toHaveBeenCalledTimes(2)
    }
  )

  it.each<[string, (recording: BrowserRecording) => void]>([
    [
      'source version identity',
      (item) => {
        item.media[0].sourceVersionId = 'other-version'
      }
    ],
    [
      'source scope',
      (item) => {
        item.source!.sessionId = 'other-session'
      }
    ],
    [
      'operation',
      (item) => {
        item.source!.operationId = 'other-operation'
      }
    ],
    [
      'invocation',
      (item) => {
        item.source!.executionInvocationId = 'other-invocation'
      }
    ],
    [
      'run',
      (item) => {
        item.source!.runId = 'other-run'
      }
    ],
    [
      'absent source',
      (item) => {
        delete item.source
      }
    ],
    [
      'start time',
      (item) => {
        item.startedAt++
      }
    ],
    [
      'title',
      (item) => {
        item.title = 'Other recording'
      }
    ],
    [
      'duration',
      (item) => {
        item.durationMs = 10000
      }
    ],
    [
      'segment dimensions',
      (item) => {
        item.segments[0].height++
      }
    ],
    [
      'segment timing',
      (item) => {
        item.segments[0].endMs--
      }
    ],
    [
      'media bytes',
      (item) => {
        item.media[0].checksum = '0'.repeat(64)
      }
    ],
    [
      'events',
      (item) => {
        item.events[0].x = 11
      }
    ],
    [
      'gaps',
      (item) => {
        item.coverage.gaps[0].reason = 'capture-failed'
      }
    ],
    [
      'dropped frames',
      (item) => {
        item.coverage.droppedFrames = 10000
      }
    ],
    [
      'finalized status',
      (item) => {
        item.coverage.stopReason = 'stopped'
      }
    ]
  ])('uses the full reader for a checkpoint with changed %s', async (_label, mutate) => {
    const checkpoint = checkpointIndex(1)
    mutate(checkpoint.recording)
    validateBrowserRecording(checkpoint.recording)
    checkpoint.unavailable = true
    const h = browserCheckpointHarness([finalIndex(), checkpoint])
    const view = await h.service.open(h.target, h.caller)
    expect(h.dependencies.recordings.readBrowser).toHaveBeenCalledTimes(2)
    const research = await h.service.document(view.viewerId, h.caller)
    expect(research.unavailableRecordingIds).toEqual(['artifact-version:checkpoint-a-1'])
    expect(research.supportingResourceIds).not.toContain('artifact-version:checkpoint-a-1')
  })

  it('rejects invalid checkpoint schemas instead of hiding them as verified supporting files', async () => {
    const checkpoint = checkpointIndex()
    checkpoint.recording.segments[0].endMs = 10000
    const h = browserCheckpointHarness([finalIndex(), checkpoint])
    const view = await h.service.open(h.target, h.caller)
    const research = await h.service.document(view.viewerId, h.caller)
    expect(h.dependencies.recordings.readBrowser).toHaveBeenCalledTimes(1)
    expect(research.unavailableRecordingIds).toEqual(['artifact-version:checkpoint-a-1'])
    expect(research.supportingResourceIds).not.toContain('artifact-version:checkpoint-a-1')
  })

  it('checks checkpoint bytes even after its final has passed, and never caches across opens', async () => {
    const h = browserCheckpointHarness([finalIndex(), checkpointIndex()])
    const view = await h.service.open(h.target, h.caller)
    expect((await h.service.document(view.viewerId, h.caller)).supportingResourceIds).toContain(
      'artifact-version:checkpoint-a-1'
    )
    h.bodies.set('checkpoint-a-1', Buffer.from('{}'))
    const reopened = await h.service.open(h.target, h.caller)
    expect(
      (await h.service.document(reopened.viewerId, h.caller)).supportingResourceIds
    ).not.toContain('artifact-version:checkpoint-a-1')
    expect(h.dependencies.recordings.readBrowser).toHaveBeenCalledTimes(2)
  })
})

describe('browser media reads from the private research snapshot', () => {
  it('reads only the requested media and exact index regardless of the recording length', async () => {
    const h = browserCheckpointHarness([finalIndex(120)])
    const view = await h.service.open(h.target, h.caller)
    vi.mocked(h.dependencies.immutable.openContent).mockClear()
    vi.mocked(h.dependencies.immutable.resolveVersion).mockClear()
    for (const mediaKey of ['segment-0', 'segment-119']) {
      expect(
        await h.service.media(view.viewerId, 'artifact-version:final-a', mediaKey, h.caller)
      ).toEqual({
        body: Buffer.from('video'),
        mimeType: 'video/webm'
      })
    }
    expect(h.dependencies.recordings.readBrowser).toHaveBeenCalledTimes(1)
    expect(h.dependencies.recordings.readBrowserMedia).not.toHaveBeenCalled()
    expect(h.dependencies.immutable.openContent).toHaveBeenCalledTimes(6)
    expect(h.dependencies.immutable.resolveVersion).toHaveBeenCalledTimes(12)
    expect(
      vi
        .mocked(h.dependencies.immutable.openContent)
        .mock.calls.map(([input]) => input.inputFileVersionId)
    ).toEqual([
      'final-a',
      'receiving-author-a-0',
      'final-a',
      'final-a',
      'receiving-author-a-119',
      'final-a'
    ])
  })

  it.each(['missing', 'checksum', 'size', 'artifact', 'version'] as const)(
    'rejects %s media mapping evidence without guessing a replacement',
    async (failure) => {
      const index = finalIndex(1)
      const media = index.recording.media[0]
      index.resolvedMedia =
        failure === 'missing'
          ? []
          : [
              {
                mediaKey: media.mediaKey,
                checksum: failure === 'checksum' ? '0'.repeat(64) : media.checksum,
                sizeBytes: failure === 'size' ? 1 : media.sizeBytes,
                artifactId:
                  failure === 'artifact' ? 'wrong-artifact' : 'artifact-receiving-author-a-0',
                versionId: failure === 'version' ? 'wrong-version' : 'receiving-author-a-0'
              }
            ]
      const h = browserCheckpointHarness([index])
      const view = await h.service.open(h.target, h.caller)
      await expect(
        h.service.media(view.viewerId, 'artifact-version:final-a', 'segment-0', h.caller)
      ).rejects.toThrow()
      expect(h.dependencies.recordings.readBrowserMedia).not.toHaveBeenCalled()
    }
  )

  it('rejects unknown media keys without reading arbitrary resources', async () => {
    const h = browserCheckpointHarness([finalIndex(1)])
    const view = await h.service.open(h.target, h.caller)
    vi.mocked(h.dependencies.immutable.openContent).mockClear()
    for (const mediaKey of ['unknown', '../private'])
      await expect(
        h.service.media(view.viewerId, 'artifact-version:final-a', mediaKey, h.caller)
      ).rejects.toMatchObject({ code: 'not-found' })
    expect(h.dependencies.immutable.openContent).not.toHaveBeenCalled()
  })

  it('rejects a snapshot whose receiving identity differs from its index', async () => {
    const h = browserCheckpointHarness([finalIndex(1)])
    const read = vi.mocked(h.dependencies.recordings.readBrowser).getMockImplementation()!
    vi.mocked(h.dependencies.recordings.readBrowser).mockImplementation(async (...args) => ({
      ...(await read(...args)),
      receiving: { ...args[0], sessionId: 'foreign-session' }
    }))
    const view = await h.service.open(h.target, h.caller)
    await expect(
      h.service.media(view.viewerId, 'artifact-version:final-a', 'segment-0', h.caller)
    ).rejects.toMatchObject({ code: 'unavailable' })
  })

  it.each(['final-a', 'receiving-author-a-0'])(
    'rejects changed immutable %s bytes after the viewer opened',
    async (versionId) => {
      const h = browserCheckpointHarness([finalIndex(1)])
      const view = await h.service.open(h.target, h.caller)
      h.bodies.set(versionId, Buffer.from('other'))
      await expect(
        h.service.media(view.viewerId, 'artifact-version:final-a', 'segment-0', h.caller)
      ).rejects.toMatchObject({ code: 'unavailable' })
    }
  )

  it.each(['final-a', 'receiving-author-a-0'])(
    'rejects a no-longer-published %s after the viewer opened',
    async (versionId) => {
      const h = browserCheckpointHarness([finalIndex(1)])
      const view = await h.service.open(h.target, h.caller)
      const resolve = vi.mocked(h.dependencies.immutable.resolveVersion).getMockImplementation()!
      vi.mocked(h.dependencies.immutable.resolveVersion).mockImplementation(async (request) =>
        request.inputFileVersionId === versionId ? undefined : resolve(request)
      )
      await expect(
        h.service.media(view.viewerId, 'artifact-version:final-a', 'segment-0', h.caller)
      ).rejects.toMatchObject({ code: 'not-found' })
    }
  )

  it.each<[string, (input: NotebookRunInputFile) => void]>([
    [
      'source kind',
      (input) => {
        input.sourceKind = 'upload-version'
      }
    ],
    [
      'project',
      (input) => {
        input.sourceProjectId = 'foreign-project'
      }
    ],
    [
      'session',
      (input) => {
        input.sourceSessionId = 'foreign-session'
      }
    ],
    [
      'artifact',
      (input) => {
        input.sourceFileId = 'foreign-artifact'
      }
    ],
    [
      'version',
      (input) => {
        input.inputFileVersionId = 'foreign-version'
      }
    ],
    [
      'checksum',
      (input) => {
        input.checksum = '0'.repeat(64)
      }
    ],
    [
      'size',
      (input) => {
        input.sizeBytes++
      }
    ],
    [
      'storage key',
      (input) => {
        input.storageKey = 'other-file'
      }
    ]
  ])('rejects a media %s rebound during its read', async (_label, mutate) => {
    const h = browserCheckpointHarness([finalIndex(1)])
    const view = await h.service.open(h.target, h.caller)
    const resolve = vi.mocked(h.dependencies.immutable.resolveVersion).getMockImplementation()!
    let mediaChecks = 0
    vi.mocked(h.dependencies.immutable.resolveVersion).mockImplementation(async (request) => {
      const input = await resolve(request)
      if (request.inputFileVersionId === 'receiving-author-a-0' && ++mediaChecks === 2)
        mutate(input!)
      return input
    })
    await expect(
      h.service.media(view.viewerId, 'artifact-version:final-a', 'segment-0', h.caller)
    ).rejects.toMatchObject({ code: 'unavailable' })
  })

  it.each(['index-bytes', 'caller', 'scope', 'viewer'] as const)(
    'rejects %s changes while the requested media is being read',
    async (change) => {
      const h = browserCheckpointHarness([finalIndex(1)])
      const view = await h.service.open(h.target, h.caller)
      const open = vi.mocked(h.dependencies.immutable.openContent).getMockImplementation()!
      vi.mocked(h.dependencies.immutable.openContent).mockImplementation(async (input) => {
        const lease = await open(input)
        if (input.inputFileVersionId !== 'receiving-author-a-0') return lease
        return {
          ...lease,
          readRange: async (...args) => {
            const body = await lease.readRange(...args)
            if (change === 'index-bytes') h.bodies.set('final-a', Buffer.from('{}'))
            else if (change === 'caller') h.setCurrent(false)
            else if (change === 'scope')
              vi.mocked(h.dependencies.authorize).mockRejectedValue(new Error('Session deleted'))
            else h.service.discard(view.viewerId)
            return body
          }
        }
      })
      await expect(
        h.service.media(view.viewerId, 'artifact-version:final-a', 'segment-0', h.caller)
      ).rejects.toThrow()
    }
  )

  it.each([16 * 1024 * 1024, 16 * 1024 * 1024 + 1])(
    'enforces the independent segment limit for %i bytes with matching declared size and checksum',
    async (size) => {
      const index = finalIndex(1)
      const body = Buffer.alloc(size, 1)
      const checksum = createHash('sha256').update(body).digest('hex')
      // The oversized case deliberately supplies an unexpected reader payload: the service
      // must enforce its own limit, not just rely on the reader's ordinary schema validation.
      index.recording.media[0].sizeBytes = size
      index.recording.media[0].checksum = checksum
      const h = browserCheckpointHarness([index])
      h.bodies.set('receiving-author-a-0', body)
      const media = h.document.resources.find((item) => item.versionId === 'receiving-author-a-0')!
      media.size = size
      media.checksum = checksum
      const view = await h.service.open(h.target, h.caller)
      vi.mocked(h.dependencies.immutable.openContent).mockClear()
      const result = h.service.media(
        view.viewerId,
        'artifact-version:final-a',
        'segment-0',
        h.caller
      )
      if (size <= 16 * 1024 * 1024) {
        expect((await result).body.byteLength).toBe(size)
        expect(h.dependencies.immutable.openContent).toHaveBeenCalledTimes(3)
      } else {
        await expect(result).rejects.toMatchObject({ code: 'not-found' })
        expect(h.dependencies.immutable.openContent).toHaveBeenCalledTimes(1)
      }
    }
  )

  it('keeps non-browser recording media on its existing reader', async () => {
    const payload = recordedFixture().payload
    const h = setup(payload)
    vi.spyOn(replaySource, 'loadReplayDocument').mockResolvedValueOnce(h.document)
    const expected = { body: Buffer.from('saved image'), mimeType: 'image/png' }
    vi.mocked(h.dependencies.recordings.readMedia).mockResolvedValue(expected)
    const view = await h.service.open(h.target, h.caller)
    expect(
      await h.service.media(view.viewerId, 'artifact-version:version', 'image', h.caller)
    ).toEqual(expected)
    expect(h.dependencies.recordings.readMedia).toHaveBeenCalledWith(
      { ...h.target, artifactId: 'artifact', versionId: 'version' },
      'image'
    )
  })
})
