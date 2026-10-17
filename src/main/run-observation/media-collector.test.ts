import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RunObservationSnapshot } from '../../shared/run-observation'
import type { RunObservationArchiveMedia } from '../../shared/run-observation-archive'
import { createProvenanceTestFixture } from '../artifacts/provenance-test-fixtures'
import { createManagedExecutionOutputWriter } from '../notebook/managed-execution-output'
import { SessionRepository } from '../session-persistence/repository'
import { initDataRoot } from '../storage-root'
import { RunObservationRecorder } from './recorder'
import { saveAuxiliaryOutput } from '../notebook/managed-auxiliary-output'
import {
  ObservationMediaCollector,
  type ObservationMediaRegistration,
  type ObservationMediaTarget
} from './media-collector'

vi.mock('electron', () => ({
  app: { getPath: () => '/home/user', isPackaged: true },
  safeStorage: { isEncryptionAvailable: () => false }
}))
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const target: ObservationMediaTarget = {
  projectId: 'project-1',
  sessionId: 'session-1',
  operationId: 'operation-1',
  executionInvocationId: 'invocation-1',
  runId: 'run-1'
}
const request = {
  source: 'project-export' as const,
  exportKey: 'frame.png',
  idempotencyKey: 'capture-1'
}
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const imageBytes = (format: 'png' | 'jpeg' | 'webp' = 'png'): Promise<Buffer> =>
  sharp({ create: { width: 10, height: 8, channels: 3, background: '#457ac1' } })
    .toFormat(format)
    .toBuffer()
const deferred = (): { promise: Promise<void>; resolve(): void } => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
// The fixture deliberately retains inferred types for its real repository and capture callbacks.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
async function setup(options: ConstructorParameters<typeof ObservationMediaCollector>[0] = {}) {
  const fixture = await createProvenanceTestFixture()
  cleanups.push(() => fixture.dispose())
  initDataRoot(fixture.storageRoot)
  await fixture.client.project.create({ data: { id: target.projectId, name: 'Media evidence' } })
  await new SessionRepository(fixture.storageRoot).saveSession({
    id: target.sessionId,
    projectId: target.projectId,
    title: 'Media evidence',
    cwd: '',
    status: 'idle',
    messages: [],
    createdAt: 1,
    updatedAt: 1
  })
  let time = 100,
    sequence = -1,
    current = true,
    authorized = true
  const now = (): number => ++time
  const snapshot = (): RunObservationSnapshot => ({
    identity: target,
    cursor: { epoch: 'epoch-1', sequence: ++sequence },
    observedAt: now(),
    phase: 'running',
    stepId: 'run:run-1',
    artifacts: [],
    artifactsTruncated: false,
    run: {
      runId: target.runId,
      executionInvocationId: target.executionInvocationId,
      kernelKind: 'bash',
      status: 'running',
      startedAt: 1,
      logs: {
        stdout: { text: `sample-${sequence}`, redacted: false, truncated: false },
        stderr: { text: '', redacted: false, truncated: false },
        traceback: { text: '', redacted: false, truncated: false }
      }
    }
  })
  const recorder = new RunObservationRecorder({
    dataRoot: fixture.storageRoot,
    read: async () => snapshot(),
    now,
    intervalMs: 60000
  })
  cleanups.push(() => recorder.close())
  const handle = await recorder.start(target)
  const writer = createManagedExecutionOutputWriter(
    {
      dataRoot: fixture.storageRoot,
      artifacts: fixture.repository,
      notebooks: fixture.notebookRepository
    },
    {
      projectId: target.projectId,
      sessionId: target.sessionId,
      operationId: target.operationId,
      workspaceCwd: '',
      artifactRunId: 'ordinary-turn-artifacts',
      artifactStorageSessionId: target.sessionId,
      writeNamespace: 'capture-test',
      messageAncestry: ['prompt-1'],
      provenanceContext: {
        rootFrameId: 'root-1',
        agentFrameId: 'root-1',
        messageBranchId: 'branch-1',
        runtimeSegmentId: 'segment-1',
        promptMessageId: 'prompt-1'
      }
    },
    new AbortController().signal
  )
  const bytes = await imageBytes()
  const savedMedia: RunObservationArchiveMedia[] = []
  const registration: ObservationMediaRegistration = {
    target,
    generationId: 'generation-1',
    recording: {
      recordingId: handle.recordingId,
      appendMedia: async (media) => {
        await handle.appendMedia(media)
        savedMedia.push(media)
      }
    },
    assertCurrent: () => {
      if (!current) throw new Error('private generation diagnostic')
    },
    sampleCurrent: vi.fn(async () => {
      await handle.sample()
      return (await recorder.load(target))!.history.snapshots.at(-1)!
    }),
    projectExports: ['frame.png', 'second.png'],
    readProjectExport: vi.fn(async () => ({ bytes })),
    saveAuxiliaryOutput: vi.fn((output) => saveAuxiliaryOutput(output, writer.saveOutput))
  }
  const collector = new ObservationMediaCollector({ now, ...options })
  const lease = collector.register(registration)
  cleanups.push(() => collector.close())
  const access = {
    assertAuthorized: () => {
      if (!authorized) throw new Error('private caller diagnostic')
    }
  }
  return {
    fixture,
    collector,
    registration,
    lease,
    recorder,
    handle,
    savedMedia,
    bytes,
    access,
    revoke: () => {
      authorized = false
    },
    stop: () => {
      current = false
    },
    snapshot
  }
}

describe('Main observation media collector', () => {
  it.each(['png', 'jpeg', 'webp'] as const)(
    'saves real %s bytes as ordinary immutable Artifact evidence at a fresh retained step',
    async (format) => {
      const h = await setup()
      const bytes = await imageBytes(format)
      vi.mocked(h.registration.readProjectExport!).mockResolvedValue({
        bytes,
        reportedCapturedAt: 20
      })
      const result = await h.collector.capture(target, request, h.access)
      expect(result).toMatchObject({
        checksum: digest(bytes),
        sizeBytes: bytes.length,
        publication: 'awaiting-publication',
        capture: {
          source: 'project-export',
          association: 'current-observation',
          reportedCapturedAt: 20,
          width: 10,
          height: 8
        }
      })
      expect(result.capture.observedAt).toBeGreaterThanOrEqual(result.capture.finishedAt)
      const version = await h.fixture.client.artifactVersion.findUniqueOrThrow({
        where: { id: result.versionId }
      })
      expect(await readFile(join(h.fixture.storageRoot, version.contentStorageKey))).toEqual(bytes)
      expect(version.producerRunId).toBeNull()
      expect(version.notebookSessionId).toBeNull()
      expect(h.savedMedia).toHaveLength(1)
      expect(h.savedMedia[0]).toMatchObject({
        sourceVersionId: result.versionId,
        stepKeys: [result.stepKey],
        capture: result.capture
      })
      const archive = await h.handle.finish()
      expect(archive?.records.some((record) => record.stepKey === result.stepKey)).toBe(true)
      expect(archive?.media[0].capture).toEqual(result.capture)
    }
  )

  it('deduplicates pending/completed retries without recapturing and rejects changed idempotency input', async () => {
    const h = await setup()
    const created = vi.fn(),
      retried = vi.fn()
    const [first, second] = await Promise.all([
      h.collector.capture(target, request, { ...h.access, onCreated: created }),
      h.collector.capture(target, request, { ...h.access, onCreated: retried })
    ])
    expect(second).toEqual(first)
    expect(await h.collector.capture(target, request, { ...h.access, onCreated: retried })).toEqual(
      first
    )
    expect(created).toHaveBeenCalledOnce()
    expect(retried).not.toHaveBeenCalled()
    expect(h.registration.readProjectExport).toHaveBeenCalledTimes(1)
    expect(h.registration.saveAuxiliaryOutput).toHaveBeenCalledTimes(1)
    await expect(
      h.collector.capture(target, { ...request, exportKey: 'second.png' }, h.access)
    ).rejects.toMatchObject({ code: 'idempotency-conflict' })
  })

  it.each(['host-view', 'project-export'] as const)(
    'retries the same %s key after a confirmed source failure without allocating another capture',
    async (source) => {
      const h = await setup({ maxCapturesPerRecording: 1 })
      const captureHostView = vi.fn(async () => ({ bytes: h.bytes }))
      const read =
        source === 'host-view' ? captureHostView : vi.mocked(h.registration.readProjectExport!)
      read.mockRejectedValueOnce(new Error(source === 'host-view' ? 'Window lost focus' : 'ENOENT'))
      const access = { ...h.access, captureHostView }
      const captureRequest =
        source === 'host-view' ? { source, idempotencyKey: request.idempotencyKey } : request
      await expect(h.collector.capture(target, captureRequest, access)).rejects.toMatchObject({
        code: 'unavailable'
      })
      expect(h.registration.saveAuxiliaryOutput).not.toHaveBeenCalled()
      const result = await h.collector.capture(target, captureRequest, access)
      expect(result.capture.source).toBe(source)
      expect(read).toHaveBeenCalledTimes(2)
      expect(h.registration.saveAuxiliaryOutput).toHaveBeenCalledOnce()
      expect(await h.fixture.client.artifactVersion.count()).toBe(1)
    }
  )

  it.each(['image', 'sample', 'metadata'] as const)(
    'releases pre-write image capacity after a %s failure and retries corrected evidence with the same key',
    async (failure) => {
      const bytes = await imageBytes()
      const h = await setup({ maxRecordingBytes: bytes.length })
      if (failure === 'image')
        vi.mocked(h.registration.readProjectExport!).mockResolvedValueOnce({
          bytes: Buffer.from('not an image')
        })
      else if (failure === 'sample')
        vi.mocked(h.registration.sampleCurrent).mockRejectedValueOnce(new Error('Read interrupted'))
      else
        vi.mocked(h.registration.readProjectExport!).mockResolvedValueOnce({
          bytes,
          reportedCapturedAt: Number.NaN
        })
      await expect(h.collector.capture(target, request, h.access)).rejects.toThrow()
      expect(h.registration.saveAuxiliaryOutput).not.toHaveBeenCalled()
      await expect(
        h.collector.capture(target, { ...request, exportKey: 'second.png' }, h.access)
      ).rejects.toMatchObject({ code: 'idempotency-conflict' })
      const result = await h.collector.capture(target, request, h.access)
      expect(result.checksum).toBe(digest(bytes))
      expect(h.registration.saveAuxiliaryOutput).toHaveBeenCalledOnce()
      expect(h.savedMedia).toHaveLength(1)
      await expect(
        h.collector.capture(target, { ...request, idempotencyKey: 'another-image' }, h.access)
      ).rejects.toMatchObject({ code: 'capacity' })
    }
  )

  it('shares a single fresh attempt across concurrent retries of a confirmed pre-write failure', async () => {
    const h = await setup({ maxPendingPerRecording: 1, maxCapturesPerRecording: 1 })
    vi.mocked(h.registration.readProjectExport!).mockRejectedValueOnce(new Error('ENOENT'))
    await expect(h.collector.capture(target, request, h.access)).rejects.toThrow()
    const entered = deferred(),
      release = deferred()
    vi.mocked(h.registration.readProjectExport!).mockImplementation(async () => {
      entered.resolve()
      await release.promise
      return { bytes: h.bytes }
    })
    const first = h.collector.capture(target, request, h.access)
    await entered.promise
    const second = h.collector.capture(target, request, h.access)
    const third = h.collector.capture(target, request, h.access)
    release.resolve()
    const results = await Promise.all([first, second, third])
    expect(results[1]).toEqual(results[0])
    expect(results[2]).toEqual(results[0])
    expect(h.registration.readProjectExport).toHaveBeenCalledTimes(2)
    expect(h.registration.saveAuxiliaryOutput).toHaveBeenCalledOnce()
    expect(h.savedMedia).toHaveLength(1)
  })

  it.each(['save', 'append'] as const)(
    'never repeats a %s attempt with an uncertain write result or releases its consumed capacity',
    async (failure) => {
      const bytes = await imageBytes()
      const h = await setup({ maxRecordingBytes: bytes.length })
      if (failure === 'save') {
        const save = vi.mocked(h.registration.saveAuxiliaryOutput).getMockImplementation()!
        vi.mocked(h.registration.saveAuxiliaryOutput).mockImplementation(async (output) => {
          await save(output)
          throw new Error('Writer response lost after persisting Artifact bytes')
        })
      } else {
        const append = h.registration.recording.appendMedia
        h.registration.recording.appendMedia = vi.fn(async (media) => {
          await append(media)
          throw new Error('Append response lost after saving archive evidence')
        })
      }
      await expect(h.collector.capture(target, request, h.access)).rejects.toThrow()
      const retried = await Promise.allSettled([
        h.collector.capture(target, request, h.access),
        h.collector.capture(target, request, h.access)
      ])
      expect(retried.map((result) => result.status)).toEqual(['rejected', 'rejected'])
      expect(h.registration.readProjectExport).toHaveBeenCalledOnce()
      expect(h.registration.saveAuxiliaryOutput).toHaveBeenCalledOnce()
      expect(await h.fixture.client.artifactVersion.count()).toBe(1)
      expect(h.savedMedia).toHaveLength(failure === 'append' ? 1 : 0)
      await expect(
        h.collector.capture(target, { ...request, idempotencyKey: 'another-image' }, h.access)
      ).rejects.toMatchObject({ code: 'capacity' })
      expect(h.registration.saveAuxiliaryOutput).toHaveBeenCalledOnce()
    }
  )

  it('reports current capabilities and returns isolated frame bytes only after successful save and association', async () => {
    const h = await setup()
    expect(h.collector.options(target, h.access)).toEqual({
      hostView: false,
      projectExports: ['frame.png', 'second.png']
    })
    expect(h.collector.options(target, { ...h.access, hostViewAvailable: true }).hostView).toBe(
      true
    )
    expect(h.collector.listFrames(target, h.access)).toEqual([])
    const result = await h.collector.capture(target, request, h.access)
    expect(h.collector.listFrames(target, h.access)).toEqual([result])
    const frame = h.collector.readFrame(target, result.captureId, h.access)!
    expect(frame.bytes).toEqual(h.bytes)
    frame.bytes.fill(0)
    const list = h.collector.listFrames(target, h.access)
    list[0].capture.width = 999
    expect(h.collector.readFrame(target, result.captureId, h.access)!.bytes).toEqual(h.bytes)
    expect(h.collector.listFrames(target, h.access)[0].capture.width).toBe(10)
    expect(
      h.collector.readFrame({ ...target, sessionId: 'another-session' }, result.captureId, h.access)
    ).toBeUndefined()
    await h.lease.close()
    expect(h.collector.options(target, h.access)).toEqual({ hostView: false, projectExports: [] })
    expect(h.collector.listFrames(target, h.access)).toEqual([])
    expect(h.collector.readFrame(target, result.captureId, h.access)).toBeUndefined()
  })

  it('hides existing frame bytes and options when original caller or Run generation becomes invalid', async () => {
    const h = await setup()
    const result = await h.collector.capture(target, request, h.access)
    h.stop()
    expect(() => h.collector.readFrame(target, result.captureId, h.access)).toThrow()
    expect(() => h.collector.listFrames(target, h.access)).toThrow()
    expect(() => h.collector.options(target, h.access)).toThrow()
    h.revoke()
    expect(() => h.collector.readFrame(target, result.captureId, h.access)).toThrow(
      'The observation image could not be captured.'
    )
  })

  it('limits queued work and removes canceled queued captures without reading or saving their source', async () => {
    const h = await setup({ maxPendingPerRecording: 2 })
    const entered = deferred(),
      release = deferred()
    vi.mocked(h.registration.readProjectExport!).mockImplementation(async () => {
      entered.resolve()
      await release.promise
      return { bytes: h.bytes }
    })
    const first = h.collector.capture(target, request, h.access)
    await entered.promise
    const controller = new AbortController()
    const second = h.collector.capture(
      target,
      { ...request, idempotencyKey: 'queued' },
      { ...h.access, signal: controller.signal }
    )
    const rejected = expect(second).rejects.toMatchObject({ code: 'unavailable' })
    await expect(
      h.collector.capture(target, { ...request, idempotencyKey: 'over-capacity' }, h.access)
    ).rejects.toMatchObject({ code: 'capacity' })
    controller.abort()
    release.resolve()
    await Promise.all([first, rejected])
    expect(h.registration.readProjectExport).toHaveBeenCalledTimes(1)
    expect(h.registration.saveAuxiliaryOutput).toHaveBeenCalledTimes(1)
  })

  it('does not accept arbitrary paths, steps, URLs, producers or undeclared exports', async () => {
    const h = await setup()
    for (const extra of [
      { path: '/private/file' },
      { url: 'http://localhost/' },
      { stepKey: 'observation-0' },
      { producerRunId: target.runId }
    ])
      await expect(
        h.collector.capture(target, { ...request, ...extra }, h.access)
      ).rejects.toMatchObject({ code: 'invalid-request' })
    await expect(
      h.collector.capture(target, { ...request, exportKey: '../../frame.png' }, h.access)
    ).rejects.toMatchObject({ code: 'invalid-request' })
    await expect(
      h.collector.capture({ ...target, runId: 'another-run' }, request, h.access)
    ).rejects.toMatchObject({ code: 'unavailable' })
    expect(h.registration.readProjectExport).not.toHaveBeenCalled()
  })

  it('requires a trusted per-invocation host capture closure and reports its actual source', async () => {
    const h = await setup()
    const request = { source: 'host-view', idempotencyKey: 'host-frame' }
    await expect(h.collector.capture(target, request, h.access)).rejects.toMatchObject({
      code: 'unavailable'
    })
    const result = await h.collector.capture(target, request, {
      ...h.access,
      captureHostView: async () => ({ bytes: h.bytes })
    })
    expect(result.capture.source).toBe('host-view')
    expect(result.capture.reportedCapturedAt).toBeUndefined()
    expect(h.registration.readProjectExport).not.toHaveBeenCalled()
  })

  it('rejects malformed, truncated, oversized and pixel-bomb images before Artifact writes', async () => {
    const h = await setup({ maxImageBytes: 1000 })
    const hugeHeader = Buffer.from(h.bytes)
    hugeHeader.writeUInt32BE(16_000_001, 16)
    for (const [index, bytes] of [
      Buffer.from('not an image'),
      h.bytes.subarray(0, 33),
      Buffer.alloc(1001),
      hugeHeader
    ].entries()) {
      vi.mocked(h.registration.readProjectExport!).mockResolvedValue({ bytes })
      await expect(
        h.collector.capture(target, { ...request, idempotencyKey: `bad-${index}` }, h.access)
      ).rejects.toMatchObject({ code: 'invalid-image' })
    }
    expect(h.registration.saveAuxiliaryOutput).not.toHaveBeenCalled()
    expect(h.savedMedia).toEqual([])
    expect(h.collector.listFrames(target, h.access)).toEqual([])
  })

  it('rechecks caller and generation after capture and drains close without appending late bytes', async () => {
    const h = await setup()
    const entered = deferred(),
      release = deferred()
    vi.mocked(h.registration.readProjectExport!).mockImplementation(async () => {
      entered.resolve()
      await release.promise
      return { bytes: h.bytes }
    })
    const created = vi.fn()
    const capturing = h.collector.capture(target, request, { ...h.access, onCreated: created })
    const failed = expect(capturing).rejects.toMatchObject({ code: 'unavailable' })
    await entered.promise
    let closed = false
    const closing = h.lease.close().then(() => {
      closed = true
    })
    await Promise.resolve()
    expect(closed).toBe(false)
    release.resolve()
    await Promise.all([failed, closing])
    expect(h.registration.saveAuxiliaryOutput).not.toHaveBeenCalled()
    expect(h.savedMedia).toEqual([])
    expect(created).not.toHaveBeenCalled()
  })

  it('rejects revoked caller authority after a source read', async () => {
    const h = await setup()
    vi.mocked(h.registration.readProjectExport!).mockImplementation(async () => {
      h.revoke()
      return { bytes: h.bytes }
    })
    await expect(h.collector.capture(target, request, h.access)).rejects.toMatchObject({
      code: 'unauthorized',
      message: 'The observation image could not be captured.'
    })
    expect(h.registration.saveAuxiliaryOutput).not.toHaveBeenCalled()
  })

  it('rejects stale or foreign observations and never appends a current image to an old selected step', async () => {
    const h = await setup()
    await h.handle.sample()
    await h.collector.capture(target, request, h.access)
    vi.mocked(h.registration.sampleCurrent).mockResolvedValue({
      ...h.snapshot(),
      cursor: { epoch: 'epoch-1', sequence: 0 }
    })
    await expect(
      h.collector.capture(target, { ...request, idempotencyKey: 'old' }, h.access)
    ).rejects.toMatchObject({
      code: 'stale-observation'
    })
    vi.mocked(h.registration.sampleCurrent).mockImplementation(async () => {
      const snapshot = h.snapshot()
      return {
        ...snapshot,
        identity: { ...target, runId: 'foreign-run' },
        run: { ...snapshot.run!, runId: 'foreign-run' }
      }
    })
    await expect(
      h.collector.capture(target, { ...request, idempotencyKey: 'foreign' }, h.access)
    ).rejects.toMatchObject({ code: 'stale-observation' })
    expect(h.registration.saveAuxiliaryOutput).toHaveBeenCalledTimes(1)
  })

  it('associates different current frames with the same retained step when observed Run content has not changed', async () => {
    const h = await setup()
    const first = await h.collector.capture(target, request, h.access)
    const unchanged = (await h.recorder.load(target))!.history.snapshots.at(-1)!
    vi.mocked(h.registration.sampleCurrent).mockResolvedValue(unchanged)
    const other = await imageBytes('jpeg')
    vi.mocked(h.registration.readProjectExport!).mockResolvedValue({ bytes: other })
    const second = await h.collector.capture(
      target,
      { ...request, idempotencyKey: 'next-frame' },
      h.access
    )
    expect(second.stepKey).toBe(first.stepKey)
    expect(second.checksum).not.toBe(first.checksum)
    expect(second.capture.startedAt).toBeGreaterThan(second.capture.observedAt)
    expect(h.savedMedia).toHaveLength(2)
  })

  it('bounds captures and does not append after a false producer or changed publication receipt', async () => {
    const h = await setup({ maxCapturesPerRecording: 1 })
    const save = h.registration.saveAuxiliaryOutput
    vi.mocked(save).mockImplementationOnce(async (output) => {
      const result = await saveAuxiliaryOutput(
        output,
        createManagedExecutionOutputWriter(
          {
            dataRoot: h.fixture.storageRoot,
            artifacts: h.fixture.repository,
            notebooks: h.fixture.notebookRepository
          },
          {
            ...target,
            workspaceCwd: '',
            artifactRunId: 'capture-turn',
            artifactStorageSessionId: target.sessionId,
            writeNamespace: 'false-producer',
            messageAncestry: ['prompt-1'],
            provenanceContext: {
              rootFrameId: 'root-1',
              agentFrameId: 'root-1',
              messageBranchId: 'branch-1',
              runtimeSegmentId: 'segment-1',
              promptMessageId: 'prompt-1'
            }
          },
          new AbortController().signal
        ).saveOutput
      )
      return result.status === 'saved'
        ? { ...result, artifact: { ...result.artifact, producerRunId: target.runId } }
        : result
    })
    await expect(h.collector.capture(target, request, h.access)).rejects.toMatchObject({
      code: 'save-failed'
    })
    expect(h.savedMedia).toEqual([])
    await expect(
      h.collector.capture(target, { ...request, idempotencyKey: 'too-many' }, h.access)
    ).rejects.toMatchObject({ code: 'capacity' })
  })
})
