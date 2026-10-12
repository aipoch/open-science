import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi, type Mock } from 'vitest'
import {
  BrowserRecordingOwner,
  type BrowserRecordingDriverInput,
  type BrowserRecordingDriver,
  type BrowserRecordingStatus
} from './owner'
import { createElectronCallerContext } from '../caller-context'
import {
  saveAuxiliaryOutput,
  type AuxiliaryOutput,
  type AuxiliaryOutputResult
} from '../notebook/managed-auxiliary-output'
import { createProvenanceTestFixture } from '../artifacts/provenance-test-fixtures'
import { createManagedExecutionOutputWriter } from '../notebook/managed-execution-output'
import { SessionRepository } from '../session-persistence/repository'
import { initDataRoot } from '../storage-root'
import { parseBrowserRecording } from '../../shared/browser-recording'

vi.mock('electron', () => ({
  app: { getPath: () => '/home/user', isPackaged: true },
  safeStorage: { isEncryptionAvailable: () => false }
}))

const target = {
  projectId: 'project',
  sessionId: 'session',
  operationId: 'operation',
  executionInvocationId: 'execution'
}
const host = {
  caller: createElectronCallerContext(1),
  viewerOrigin: 'http://viewer-test.localhost:1234',
  projectOrigin: 'http://rv-test.localhost:1234'
}
function fixture(
  options: {
    maxBytes?: number
    failIndex?: boolean
    dataRoot?: string
    save?: (output: AuxiliaryOutput) => Promise<AuxiliaryOutputResult>
  } = {}
): {
  owner: BrowserRecordingOwner
  registration: ReturnType<BrowserRecordingOwner['register']>
  saved: AuxiliaryOutput[]
  save: Mock<(output: AuxiliaryOutput) => Promise<AuxiliaryOutputResult>>
  start: (requestId?: string, viewerId?: string) => Promise<BrowserRecordingStatus>
  startDriver: Mock<(value: BrowserRecordingDriverInput) => Promise<BrowserRecordingDriver>>
  stop: Mock<() => Promise<undefined>>
  source: AbortController
  segment: (startMs?: number, endMs?: number) => Promise<void>
  input: () => BrowserRecordingDriverInput
} {
  let input!: BrowserRecordingDriverInput
  const saved: AuxiliaryOutput[] = []
  const stop = vi.fn(async () => undefined)
  const source = new AbortController()
  const save = vi.fn(async (output: AuxiliaryOutput): Promise<AuxiliaryOutputResult> => {
    if (options.failIndex && output.filename.endsWith('.json'))
      return { status: 'failed', code: 'artifact-save-failed' }
    if (options.save) {
      const result = await options.save(output)
      if (result.status === 'saved') saved.push(output)
      return result
    }
    saved.push(output)
    return {
      status: 'saved',
      artifact: {
        artifactId: `artifact-${saved.length}`,
        versionId: `version-${saved.length}`
      }
    } as AuxiliaryOutputResult
  })
  const startDriver = vi.fn(async (value: BrowserRecordingDriverInput) => {
    input = value
    return { pause: vi.fn(async () => undefined), resume: vi.fn(async () => undefined), stop }
  })
  const owner = new BrowserRecordingOwner({
    startDriver,
    maxBytes: options.maxBytes,
    dataRoot: options.dataRoot
  })
  const registration = owner.register({
    target,
    signal: source.signal,
    assertCurrent: () => source.signal.throwIfAborted(),
    save
  })
  const start = (
    requestId: string = randomUUID(),
    viewerId = 'viewer'
  ): Promise<BrowserRecordingStatus> =>
    owner.start({
      target,
      viewerId,
      host,
      request: { requestId },
      assertAuthorized: () => undefined
    })
  const segment = (startMs = 0, endMs = 1000): Promise<void> =>
    input.onSegment({
      bytes: new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]),
      startMs,
      endMs,
      width: 1280,
      height: 720,
      codec: 'vp8',
      frameRate: 10
    })
  return {
    owner,
    registration,
    saved,
    save,
    start,
    startDriver,
    stop,
    source,
    segment,
    input: () => input
  }
}

describe('browser recording evidence owner', () => {
  it('publishes multiple checkpoints and one final index through the real managed writer', async () => {
    const real = await createProvenanceTestFixture()
    initDataRoot(real.storageRoot)
    await real.client.project.create({ data: { id: target.projectId, name: 'Browser evidence' } })
    await new SessionRepository(real.storageRoot).saveSession({
      id: target.sessionId,
      projectId: target.projectId,
      title: 'Browser evidence',
      cwd: '',
      status: 'idle',
      messages: [],
      createdAt: 1,
      updatedAt: 1
    })
    const writer = createManagedExecutionOutputWriter(
      {
        dataRoot: real.storageRoot,
        artifacts: real.repository,
        notebooks: real.notebookRepository
      },
      {
        projectId: target.projectId,
        sessionId: target.sessionId,
        operationId: target.operationId,
        workspaceCwd: '',
        artifactRunId: 'ordinary-turn-artifacts',
        artifactStorageSessionId: target.sessionId,
        writeNamespace: 'recording-test',
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
    const f = fixture({
      dataRoot: real.storageRoot,
      save: (output) => saveAuxiliaryOutput(output, writer.saveOutput)
    })
    try {
      const recording = await f.start()
      await f.segment(0, 1000)
      const checkpointTarget = f.owner.status('viewer').target!
      await f.segment(1000, 2000)
      expect(f.owner.status('viewer')).toMatchObject({ state: 'recording', segments: 2 })
      await f.registration.close('finished')
      await f.registration.close('finished')
      const completed = f.owner.status('viewer')
      expect(completed).toMatchObject({ state: 'finalized', segments: 2 })
      expect(completed.error).toBeUndefined()
      expect(completed.target!.artifactId).not.toBe(checkpointTarget.artifactId)
      const indexes = f.saved.filter((output) => output.filename.endsWith('.json'))
      expect(indexes.map((output) => output.filename)).toEqual([
        `web-recording-${recording.recordingId}-checkpoint-1.json`,
        `web-recording-${recording.recordingId}-checkpoint-2.json`,
        `web-recording-${recording.recordingId}.json`
      ])
      const versions = await real.client.artifactVersion.findMany()
      expect(versions).toHaveLength(5)
      expect(
        versions.every((version) => !version.producerRunId && !version.notebookSessionId)
      ).toBe(true)
      expect(
        await real.notebookRepository.readSessionDocuments(target.projectId, target.sessionId)
      ).toEqual([])
      const finalVersion = versions.find((version) => version.id === completed.target!.versionId)!
      const final = parseBrowserRecording(
        await readFile(join(real.storageRoot, finalVersion.contentStorageKey), 'utf8')
      )
      expect(final.segments).toHaveLength(2)
      expect(final.coverage.stopReason).toBe('finished')
      for (const media of final.media) {
        const version = versions.find((entry) => entry.id === media.sourceVersionId)!
        const bytes = await readFile(join(real.storageRoot, version.contentStorageKey))
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(media.checksum)
        expect(bytes.byteLength).toBe(media.sizeBytes)
      }
      const firstVersion = versions.find((version) => version.id === checkpointTarget.versionId)!
      expect(
        parseBrowserRecording(
          await readFile(join(real.storageRoot, firstVersion.contentStorageKey), 'utf8')
        ).segments
      ).toHaveLength(1)
      // The fix must preserve the existing writer's rejection of changed content at one identity.
      expect(
        await saveAuxiliaryOutput(
          { ...indexes[0], source: { kind: 'inline', content: 'changed' } },
          writer.saveOutput
        )
      ).toEqual({ status: 'failed', code: 'artifact-save-failed' })
      expect(await real.client.artifactVersion.count()).toBe(5)
    } finally {
      await f.owner.close()
      await real.dispose()
    }
  })

  it('retains exact native media attestation across restart without trusting imported sender IDs', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'browser-recording-receipts-'))
    const f = fixture({ dataRoot })
    try {
      await f.start()
      await f.segment(0, 1000)
      await f.segment(1000, 2000)
      await f.registration.close('finished')
      const target = f.owner.status('viewer').target!
      const content = f.saved.at(-1)!.source.content
      const identity = {
        checksum: createHash('sha256').update(content).digest('hex'),
        sizeBytes: Buffer.byteLength(content)
      }
      await f.owner.close()
      const restarted = new BrowserRecordingOwner({ dataRoot, startDriver: f.startDriver })
      const mapping = await restarted.readNativeSourceVersionMapping(target, identity)
      const recording = parseBrowserRecording(content)
      expect(mapping).toEqual(
        Object.fromEntries(
          recording.media.map((media) => [media.sourceVersionId, media.sourceVersionId])
        )
      )
      expect(recording.media[0].checksum).toBe(recording.media[1].checksum)
      expect(recording.media[0].sourceVersionId).not.toBe(recording.media[1].sourceVersionId)
      expect(
        await restarted.readNativeSourceVersionMapping(
          { ...target, sessionId: 'imported-session' },
          identity
        )
      ).toBeUndefined()
      expect(
        await restarted.readNativeSourceVersionMapping(target, {
          ...identity,
          checksum: '0'.repeat(64)
        })
      ).toBeUndefined()
      expect(f.startDriver).toHaveBeenCalledTimes(1)
      await restarted.close()
    } finally {
      await f.owner.close()
      await rm(dataRoot, { recursive: true, force: true })
    }
  })
  it('starts once and checkpoints exact immutable media versions without any Notebook', async () => {
    const f = fixture()
    try {
      const requestId = randomUUID()
      const [first, repeated] = await Promise.all([f.start(requestId), f.start(requestId)])
      expect(first.recordingId).toBe(repeated.recordingId)
      expect(f.startDriver).toHaveBeenCalledTimes(1)
      await f.segment()
      expect(f.saved[1].filename).toBe(`web-recording-${first.recordingId}-checkpoint-1.json`)
      const checkpoint = parseBrowserRecording(f.saved[1].source.content)
      expect(checkpoint.coverage.stopReason).toBe('interrupted')
      expect(checkpoint.media[0].sourceVersionId).toBe('version-1')
      expect(checkpoint.segments[0]).toMatchObject({ startMs: 0, endMs: 1000, codec: 'vp8' })
      const request = { requestId: randomUUID(), recordingId: first.recordingId }
      const [closed, duplicate] = await Promise.all([
        f.owner.control('stop', 'viewer', request),
        f.owner.control('stop', 'viewer', request)
      ])
      expect(closed).toEqual(duplicate)
      expect(closed.state).toBe('finalized')
      expect(f.stop).toHaveBeenCalledTimes(1)
      const final = parseBrowserRecording(f.saved.at(-1)!.source.content)
      expect(f.saved.at(-1)!.filename).toBe(`web-recording-${first.recordingId}.json`)
      expect(f.saved.filter((output) => output.filename === f.saved.at(-1)!.filename)).toHaveLength(
        1
      )
      expect(final.coverage.stopReason).toBe('stopped')
      expect(final.media).toEqual(checkpoint.media)
    } finally {
      await f.owner.close()
    }
  })

  it('does not grant another viewer control or allow a second recording of the same surface', async () => {
    const f = fixture()
    try {
      const recording = await f.start()
      await expect(f.start(randomUUID(), 'other-viewer')).rejects.toThrow('already being recorded')
      await expect(
        f.owner.control('stop', 'other-viewer', {
          requestId: randomUUID(),
          recordingId: recording.recordingId
        })
      ).rejects.toThrow('outside this viewer')
      expect(() => f.owner.status('other-viewer', recording.recordingId)).toThrow(
        'outside this viewer'
      )
      expect(f.stop).not.toHaveBeenCalled()
    } finally {
      await f.owner.close()
    }
  })

  it('finishes inside the admitted publication lifetime and drains the encoder final segment', async () => {
    const f = fixture()
    await f.start()
    f.stop.mockImplementation(async () => {
      await f.segment(0, 1500)
    })
    await f.registration.close('finished')
    expect(f.owner.status('viewer')).toMatchObject({ state: 'finalized', segments: 1 })
    expect(f.owner.inspect(target)).toBe(false)
    f.source.abort()
    expect(parseBrowserRecording(f.saved.at(-1)!.source.content).coverage.stopReason).toBe(
      'finished'
    )
    await expect(f.start()).rejects.toThrow('source is unavailable')
    await f.owner.close()
  })

  it('retains honest gaps and browser event provenance on an interrupted recording', async () => {
    const f = fixture()
    await f.start()
    await f.segment(0, 1000)
    f.input().onGap({ startMs: 1000, endMs: 2000, reason: 'hidden' })
    f.input().onEvent({ offsetMs: 2100, kind: 'click', source: 'browser-observed', x: 23, y: 47 })
    await f.segment(2000, 3000)
    await f.registration.close('interrupted')
    const recording = parseBrowserRecording(f.saved.at(-1)!.source.content)
    expect(recording.coverage.gaps).toEqual([{ startMs: 1000, endMs: 2000, reason: 'hidden' }])
    expect(recording.events[0]).toMatchObject({ source: 'browser-observed', offsetMs: 2100 })
    expect(f.owner.status('viewer').state).toBe('partial')
    await f.owner.close()
  })

  it('bounds media without treating capture capacity as experiment failure', async () => {
    const f = fixture({ maxBytes: 4 })
    await f.start()
    await f.segment()
    await f.segment(1000, 2000)
    await vi.waitFor(() => expect(f.owner.status('viewer').state).toBe('partial'))
    expect(f.saved.filter((output) => output.filename.endsWith('.webm'))).toHaveLength(1)
    expect(f.owner.status('viewer').error).toBe('capacity')
    await f.owner.close()
  })

  it('fails locally when the optional index cannot publish', async () => {
    const f = fixture({ failIndex: true })
    await f.start()
    await f.segment()
    await vi.waitFor(() => expect(f.owner.status('viewer').state).toBe('failed'))
    expect(f.owner.status('viewer').error).toBe('publication-failed')
    expect(f.source.signal.aborted).toBe(false)
    await f.owner.close()
  })
})
