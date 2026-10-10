import { createHash } from 'node:crypto'
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RunObservationSnapshot, RunObservationTarget } from '../../shared/run-observation'
import { parseRunObservationArchive } from '../../shared/run-observation-archive'
import { DurableJsonRecoveryBarrierError } from '../storage/durable-json-file'
import { RunObservationRecorder, type RunObservationRecorderDependencies } from './recorder'

const target: RunObservationTarget = {
  projectId: 'project-a',
  sessionId: 'session-a',
  operationId: 'operation-a',
  executionInvocationId: 'invocation-a'
}
function snapshot(sequence = 0, completed = false): RunObservationSnapshot {
  return {
    identity: { ...target, runId: 'run-a', environmentId: 'environment-a' },
    cursor: { epoch: 'epoch-a', sequence },
    observedAt: 200 + sequence,
    stepId: 'run:run-a',
    phase: completed ? 'completed' : 'running',
    artifacts: [],
    artifactsTruncated: false,
    run: {
      runId: 'run-a',
      executionInvocationId: target.executionInvocationId,
      kernelKind: 'bash',
      status: completed ? 'completed' : 'running',
      startedAt: 100,
      ...(completed ? { endedAt: 200 + sequence, exitCode: 0 } : {}),
      logs: {
        stdout: { text: `actual output ${sequence}`, truncated: false, redacted: false },
        stderr: { text: '', truncated: false, redacted: false },
        traceback: { text: '', truncated: false, redacted: false }
      }
    }
  }
}
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}
const roots: string[] = []
const owners: RunObservationRecorder[] = []
async function setup(
  overrides: Partial<RunObservationRecorderDependencies> = {}
): Promise<{ owner: RunObservationRecorder; dataRoot: string }> {
  const dataRoot = overrides.dataRoot ?? (await mkdtemp(join(tmpdir(), 'observation-recorder-')))
  if (!roots.includes(dataRoot)) roots.push(dataRoot)
  const owner = new RunObservationRecorder({
    dataRoot,
    read: async () => snapshot(),
    intervalMs: 60_000,
    now: () => 300,
    ...overrides
  })
  owners.push(owner)
  return { owner, dataRoot }
}
function file(dataRoot: string, recordingId: string): string {
  return join(dataRoot, 'managed-run-observations', `${recordingId}.json`)
}
afterEach(async () => {
  await Promise.all(owners.splice(0).map((owner) => owner.close().catch(() => undefined)))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('durable Main observation recorder', () => {
  it('writes real running samples privately before finish and exports only sampled source evidence', async () => {
    let source: RunObservationSnapshot | undefined
    const { owner, dataRoot } = await setup({ read: async () => source })
    const handle = await owner.start(target)
    await handle.sample()
    source = snapshot()
    await handle.sample()
    const running = JSON.parse(await readFile(file(dataRoot, handle.recordingId), 'utf8'))
    expect(running.status).toBe('recording')
    expect(running.history.snapshots).toEqual([source])
    expect(running.unavailableSamples).toBe(1)
    if (process.platform !== 'win32')
      expect((await stat(file(dataRoot, handle.recordingId))).mode & 0o777).toBe(0o600)
    await handle.sample()
    source = snapshot(1, true)
    const archive = await handle.finish()
    expect(archive?.records).toHaveLength(2)
    expect(archive?.coverage).toMatchObject({
      stopReason: 'run-ended',
      terminalRunObserved: true,
      includesPreObservationHistory: false
    })
    expect(archive?.records[0].sourceEvidence.identity.runId).toBe('run-a')
    expect(archive?.records[0].run).not.toHaveProperty('runId')
    expect(parseRunObservationArchive(JSON.stringify(archive))).toEqual(archive)
    expect(await handle.finish()).toEqual(archive)
    expect((await owner.load(target))?.status).toBe('finished')
  })

  it('never creates an archive for a run that was never observed', async () => {
    const { owner } = await setup({ read: async () => undefined })
    const handle = await owner.start(target)
    expect(await handle.finish()).toBeUndefined()
    expect((await owner.load(target))?.history.snapshots).toEqual([])
    await expect(owner.markPublished(target, { versionId: 'version-a' })).rejects.toThrow(
      'no sampled evidence'
    )
  })

  it('restarts from the actual crash sidecar as partial history, without resuming or inventing a new epoch', async () => {
    const first = await setup()
    const handle = await first.owner.start(target)
    await handle.sample()
    const second = await setup({ read: vi.fn(async () => snapshot(1, true)) })
    await mkdir(join(second.dataRoot, 'managed-run-observations'))
    await copyFile(
      file(first.dataRoot, handle.recordingId),
      file(second.dataRoot, handle.recordingId)
    )
    const recovered = await second.owner.load(target)
    expect(recovered).toMatchObject({
      recovered: true,
      status: 'interrupted',
      publication: { state: 'unpublished' }
    })
    expect(recovered?.archive?.coverage).toMatchObject({
      stopReason: 'app-exit',
      terminalRunObserved: false
    })
    expect(recovered?.history.snapshots).toEqual([snapshot()])
    const restarted = await second.owner.start(target)
    expect(await restarted.finish()).toEqual(recovered?.archive)
    expect((await second.owner.load(target))?.recovered).toBe(false)
  })

  it('binds persistent scope and source identity, with no alias through an incomplete or foreign target', async () => {
    const { owner } = await setup()
    const handle = await owner.start(target)
    expect(await owner.start(target)).toBe(handle)
    await expect(owner.load({ ...target, operationId: 'operation-b' })).rejects.toThrow(
      'original scope'
    )
    await expect(owner.load({ ...target, operationId: undefined })).rejects.toThrow(
      'original scope'
    )
    expect(await owner.load({ ...target, sessionId: 'session-b' })).toBeUndefined()
    await expect(
      owner.start({ projectId: target.projectId, sessionId: target.sessionId, runId: 'run-a' })
    ).rejects.toThrow()
  })

  it('stops on a source epoch or Run substitution and preserves the actual earlier recording', async () => {
    let source = snapshot()
    const onSampleError = vi.fn()
    const { owner } = await setup({ read: async () => source, onSampleError })
    const handle = await owner.start(target)
    await handle.sample()
    source = { ...snapshot(1), cursor: { epoch: 'replacement', sequence: 1 } }
    await handle.sample()
    const archive = await handle.finish()
    expect(archive?.records).toHaveLength(1)
    expect(archive?.coverage).toMatchObject({ stopReason: 'capture-failed', samplingFailures: 1 })
    expect(onSampleError).toHaveBeenCalledWith(target, 'source-changed')
    expect((await owner.load(target))?.status).toBe('interrupted')
  })

  it('stops at the sample limit without dropping early evidence or claiming the later Run ended', async () => {
    let source = snapshot()
    const { owner } = await setup({ read: async () => source, limits: { snapshots: 2 } })
    const handle = await owner.start(target)
    await handle.sample()
    source = snapshot(2)
    await handle.sample()
    source = snapshot(5, true)
    const archive = await handle.finish()
    expect(archive?.records.map((item) => item.sourceEvidence.cursor.sequence)).toEqual([0, 2])
    expect(archive?.coverage).toMatchObject({
      droppedEarlierObservations: false,
      sourceCursorGaps: 1,
      stopReason: 'capacity',
      capacityLimit: 'snapshots',
      terminalRunObserved: false
    })
  })

  it('caps total bytes, active recordings and record count without deleting unexported evidence', async () => {
    const { owner, dataRoot } = await setup({ limits: { active: 1, records: 1 } })
    const handle = await owner.start(target)
    const second = { ...target, executionInvocationId: 'invocation-b' }
    await expect(owner.start(second)).rejects.toThrow('active recording limit')
    await handle.finish()
    await expect(owner.start(second)).rejects.toThrow('durable recording capacity')
    expect(await readdir(join(dataRoot, 'managed-run-observations'))).toEqual([
      `${handle.recordingId}.json`
    ])
    const byteLimited = await setup({
      limits: { totalBytes: 2048 },
      read: async () => ({
        ...snapshot(),
        run: {
          ...snapshot().run!,
          logs: {
            ...snapshot().run!.logs,
            stdout: { text: 'x'.repeat(3000), redacted: false, truncated: false }
          }
        }
      })
    })
    const byteHandle = await byteLimited.owner.start(target)
    await byteHandle.sample()
    expect((await byteLimited.owner.load(target))?.capacityLimit).toBe('global-bytes')
    expect((await byteLimited.owner.load(target))?.history.snapshots).toEqual([])
    expect(
      (await stat(file(byteLimited.dataRoot, byteHandle.recordingId))).size
    ).toBeLessThanOrEqual(2048)
  })

  it('stops at actual UTF-8 bytes, preserving the beginning instead of a tail', async () => {
    let source = snapshot()
    const read = vi.fn(async () => source)
    const { owner } = await setup({ limits: { recordBytes: 4096 }, read })
    const handle = await owner.start(target)
    for (let index = 0; index < 8; index++) {
      source = snapshot(index)
      await handle.sample()
    }
    const recorded = await owner.load(target)
    expect(recorded?.history.truncated).toBe(false)
    expect(recorded?.history.snapshots[0]?.cursor.sequence).toBe(0)
    expect(recorded?.history.snapshots.length).toBeLessThan(8)
    expect(recorded?.archive?.coverage).toMatchObject({
      stopReason: 'capacity',
      capacityLimit: 'record-bytes'
    })
    const reads = read.mock.calls.length
    source = snapshot(99, true)
    await handle.sample()
    expect(await handle.finish()).toEqual(recorded?.archive)
    expect(read).toHaveBeenCalledTimes(reads)

    const oversized = await setup({
      limits: { recordBytes: 4096 },
      read: async () => ({
        ...snapshot(),
        run: {
          ...snapshot().run!,
          logs: {
            ...snapshot().run!.logs,
            stdout: { text: '字'.repeat(1400), truncated: false, redacted: false }
          }
        }
      })
    })
    const large = await oversized.owner.start(target)
    await large.sample()
    expect(await large.finish()).toBeUndefined()
    expect(await oversized.owner.load(target)).toMatchObject({
      status: 'interrupted',
      capacityLimit: 'record-bytes',
      history: { snapshots: [] }
    })
  })

  it('keeps the previous atomic file after failed replacement and records the subsequent observation gap', async () => {
    let fail = false
    let source = snapshot()
    const { owner, dataRoot } = await setup({
      read: async () => source,
      durableFileDependencies: {
        rename: async (a, b) => {
          if (fail) throw new Error('injected disk failure')
          await rename(a, b)
        }
      }
    })
    const handle = await owner.start(target)
    await handle.sample()
    const before = await readFile(file(dataRoot, handle.recordingId), 'utf8')
    fail = true
    source = snapshot(1)
    await expect(handle.sample()).rejects.toThrow('could not be persisted')
    expect(await readFile(file(dataRoot, handle.recordingId), 'utf8')).toBe(before)
    fail = false
    source = snapshot(2, true)
    const archive = await handle.finish()
    expect(archive?.records.map((item) => item.sourceEvidence.cursor.sequence)).toEqual([0, 2])
    expect(archive?.coverage).toMatchObject({ sourceCursorGaps: 1, samplingFailures: 1 })
    expect(await readdir(join(dataRoot, 'managed-run-observations'))).toEqual([
      `${handle.recordingId}.json`
    ])
  })

  it('adopts the actual renamed file when directory fsync reports failure, without rolling evidence back', async () => {
    let fail = false
    let source = snapshot()
    const { owner } = await setup({
      read: async () => source,
      durableFileDependencies: {
        syncDirectory: async () => {
          if (fail) throw new Error('fsync failed after rename')
        }
      }
    })
    const handle = await owner.start(target)
    await handle.sample()
    source = snapshot(1)
    fail = true
    await expect(handle.sample()).rejects.toThrow('could not be persisted')
    fail = false
    source = snapshot(2, true)
    const archive = await handle.finish()
    expect(archive?.records.map((item) => item.sourceEvidence.cursor.sequence)).toEqual([0, 1, 2])
    expect(archive?.coverage.sourceCursorGaps).toBe(0)
  })

  it('stops after a timed out source read rather than accumulating unresolved background reads', async () => {
    const pending = deferred<RunObservationSnapshot>()
    const read = vi.fn(() => pending.promise)
    const { owner } = await setup({ read, intervalMs: 10, readTimeoutMs: 20 })
    await owner.start(target)
    await vi.waitFor(async () => expect((await owner.load(target))?.status).toBe('interrupted'))
    expect(read).toHaveBeenCalledOnce()
    expect((await owner.load(target))?.archive).toBeUndefined()
    pending.resolve(snapshot())
    expect((await owner.load(target))?.history.snapshots).toEqual([])
  })

  it('makes concurrent finish and close settle on one truthful partial archive with no late samples', async () => {
    let sourceRead = 0
    const pending = deferred<RunObservationSnapshot>()
    const read = vi.fn(async () => (++sourceRead === 1 ? snapshot() : pending.promise))
    const { owner, dataRoot } = await setup({ read })
    const handle = await owner.start(target)
    await handle.sample()
    const finishing = handle.finish()
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2))
    const closing = owner.close()
    const archive = await finishing
    await closing
    expect(archive?.records).toHaveLength(1)
    expect(archive?.coverage.stopReason).toBe('app-exit')
    const before = await readFile(file(dataRoot, handle.recordingId), 'utf8')
    pending.resolve(snapshot(1, true))
    expect(await handle.finish()).toEqual(archive)
    expect(await readFile(file(dataRoot, handle.recordingId), 'utf8')).toBe(before)
  })

  it('preserves future or corrupted durable files behind a recovery barrier', async () => {
    const { owner, dataRoot } = await setup()
    const handle = await owner.start(target)
    await handle.abort()
    const path = file(dataRoot, handle.recordingId)
    const text = await readFile(path, 'utf8')
    const future = JSON.stringify({ ...JSON.parse(text), schemaVersion: 99 })
    await writeFile(path, future)
    await expect(owner.start(target)).rejects.toBeInstanceOf(DurableJsonRecoveryBarrierError)
    expect(await readFile(path, 'utf8')).toBe(future)
    await writeFile(path, '{invalid')
    await expect(owner.load(target)).rejects.toBeInstanceOf(DurableJsonRecoveryBarrierError)
    expect(await readFile(path, 'utf8')).toBe('{invalid')
  })

  it('does not retain a grant, launch environment, private path or raw error metadata', async () => {
    let source: unknown = {
      ...snapshot(),
      grant: 'credential-secret',
      cwd: '/private/work',
      shellEnv: { TOKEN: 'secret' }
    }
    const { owner, dataRoot } = await setup({ read: async () => source as RunObservationSnapshot })
    const handle = await owner.start(target)
    await handle.sample()
    source = snapshot(1, true)
    await handle.finish()
    const text = await readFile(file(dataRoot, handle.recordingId), 'utf8')
    expect(text).not.toMatch(/credential-secret|private\/work|shellEnv|TOKEN/)
    expect((await owner.load(target))?.archive?.coverage.samplingFailures).toBe(1)
  })

  it('checks scope again after a pending read, discarding evidence revoked mid-read', async () => {
    let authorized = true
    const pending = deferred<RunObservationSnapshot>()
    const read = vi.fn(() => pending.promise)
    const { owner } = await setup({
      read,
      authorize: async () => {
        if (!authorized) throw new Error('/private/deleted-scope')
      }
    })
    const handle = await owner.start(target)
    const sample = handle.sample()
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce())
    authorized = false
    pending.resolve(snapshot())
    await expect(sample).rejects.toThrow('sample could not be persisted')
    await expect(owner.load(target)).rejects.toThrow('scope is no longer available')
    authorized = true
    expect((await owner.load(target))?.history.snapshots).toEqual([])
  })

  it('aborts pending reads on close and prevents late writes without cancelling the actual Run', async () => {
    const pending = deferred<RunObservationSnapshot>()
    let signal: AbortSignal | undefined
    const read = vi.fn((_target, received: AbortSignal) => {
      signal = received
      return pending.promise
    })
    const { owner, dataRoot } = await setup({ read })
    const handle = await owner.start(target)
    const sample = handle.sample()
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce())
    await owner.close()
    expect(signal?.aborted).toBe(true)
    const before = await readFile(file(dataRoot, handle.recordingId), 'utf8')
    expect(JSON.parse(before)).toMatchObject({ status: 'interrupted', stopReason: 'app-exit' })
    pending.resolve(snapshot())
    await sample
    expect(await readFile(file(dataRoot, handle.recordingId), 'utf8')).toBe(before)
    await expect(owner.start(target)).rejects.toThrow('closed')
  })

  it('runs periodic sampling independently of viewers with at most one source read in flight', async () => {
    const pending = deferred<RunObservationSnapshot>()
    const read = vi.fn(() => pending.promise)
    const { owner } = await setup({ read, intervalMs: 10 })
    const handle = await owner.start(target)
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce())
    const a = handle.sample()
    const b = handle.sample()
    expect(a).toBe(b)
    expect(read).toHaveBeenCalledOnce()
    pending.resolve(snapshot())
    await a
    await vi.waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(1))
    await handle.abort()
    expect((await owner.load(target))?.archive?.coverage.stopReason).toBe('manual')
  })

  it('retains a save receipt before publication verification and idempotently promotes only exact finalized content', async () => {
    let published = false
    let throwVerifier = true
    const { owner } = await setup({
      read: async () => snapshot(0, true),
      isPublished: async () => {
        if (throwVerifier) throw new Error('publication pending')
        return published
      }
    })
    const handle = await owner.start(target)
    const archive = await handle.finish()
    await expect(owner.markPublished(target, { versionId: 'archive-version' })).rejects.toThrow(
      'publication pending'
    )
    expect((await owner.load(target))?.publication).toMatchObject({
      state: 'saved',
      versionId: 'archive-version'
    })
    throwVerifier = false
    const saved = await owner.markPublished(target, { versionId: 'archive-version' })
    expect(saved.state).toBe('saved')
    published = true
    const result = await owner.markPublished(target, { versionId: 'archive-version' })
    expect(result).toMatchObject({
      state: 'published',
      versionId: 'archive-version',
      checksum: createHash('sha256').update(JSON.stringify(archive)).digest('hex')
    })
    expect(await owner.markPublished(target, { versionId: 'archive-version' })).toEqual(result)
    await expect(owner.markPublished(target, { versionId: 'different-version' })).rejects.toThrow(
      'different save receipt'
    )
    await expect(
      owner.markPublished(target, { versionId: 'archive-version', checksum: '0'.repeat(64) })
    ).rejects.toThrow('content does not match')
    expect((await owner.load(target))?.archive).toEqual(archive)
  })

  it('stores portable media hashes and retained step bindings without claiming the observed Run produced them', async () => {
    let source = snapshot()
    const { owner } = await setup({ read: async () => source, limits: { snapshots: 1 } })
    const handle = await owner.start(target)
    await handle.sample()
    const media = {
      mediaKey: 'frame-a',
      name: 'frame-a.png',
      mimeType: 'image/png',
      checksum: 'a'.repeat(64),
      sizeBytes: 10,
      sourceVersionId: 'image-version',
      stepKeys: ['observation-0']
    }
    await handle.appendMedia(media)
    await handle.appendMedia(media)
    await expect(
      handle.appendMedia({ ...media, mediaKey: 'wrong-frame', stepKeys: ['observation-99'] })
    ).rejects.toThrow('retained observations')
    source = snapshot(1, true)
    const archive = await handle.finish()
    expect(archive?.media).toEqual([media])
    expect(archive?.media[0]).not.toHaveProperty('producerRunId')
    await expect(handle.appendMedia(media)).rejects.toThrow('stopped')
  })
  it('seals real disk segments and restores all 300 samples and early media after a crash, read-only', async () => {
    let source = snapshot()
    const { owner, dataRoot } = await setup({ read: async () => source })
    const handle = await owner.start(target)
    for (let index = 0; index < 300; index++) {
      source = snapshot(index)
      await handle.sample()
    }
    const media = {
      mediaKey: 'first-and-middle',
      name: 'frame.png',
      mimeType: 'image/png',
      checksum: 'a'.repeat(64),
      sizeBytes: 20,
      sourceVersionId: 'capture-version',
      stepKeys: ['observation-0', 'observation-128', 'observation-299']
    }
    await handle.appendMedia(media)
    const index = JSON.parse(await readFile(file(dataRoot, handle.recordingId), 'utf8'))
    expect(index.schemaVersion).toBe(2)
    expect(index.segments).toHaveLength(2)
    expect(index.history.snapshots).toHaveLength(44)
    expect(index.segments.map((ref: { snapshotCount: number }) => ref.snapshotCount)).toEqual([
      128, 128
    ])
    for (const ref of index.segments) {
      const segmentPath = join(
        dataRoot,
        'managed-run-observations',
        `${handle.recordingId}.segment-${String(ref.ordinal).padStart(2, '0')}.json`
      )
      const bytes = await readFile(segmentPath)
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(ref.checksum)
      expect(bytes.byteLength).toBe(ref.sizeBytes)
      if (process.platform !== 'win32') expect((await stat(segmentPath)).mode & 0o777).toBe(0o600)
    }
    const other = await setup({ read: vi.fn(async () => snapshot(301, true)) })
    const directory = join(other.dataRoot, 'managed-run-observations')
    await cp(join(dataRoot, 'managed-run-observations'), directory, { recursive: true })
    const names = await readdir(directory)
    const before = await Promise.all(names.map((name) => readFile(join(directory, name), 'utf8')))
    const recovered = await other.owner.load(target)
    expect(recovered?.recovered).toBe(true)
    expect(recovered?.history.snapshots.map((item) => item.cursor.sequence)).toEqual(
      Array.from({ length: 300 }, (_, i) => i)
    )
    expect(recovered?.archive?.coverage).toMatchObject({
      stopReason: 'app-exit',
      droppedEarlierObservations: false,
      sourceCursorGaps: 0
    })
    expect(recovered?.archive?.media).toEqual([media])
    expect(await Promise.all(names.map((name) => readFile(join(directory, name), 'utf8')))).toEqual(
      before
    )
    expect((await other.owner.load(target))?.archive).toEqual(recovered?.archive)
    source = snapshot(300, true)
    const archive = await handle.finish()
    expect(archive?.records).toHaveLength(301)
    expect(archive?.media).toEqual([media])
    expect(archive?.coverage).toMatchObject({
      stopReason: 'run-ended',
      droppedEarlierObservations: false
    })
    expect((await owner.load(target))?.archive).toEqual(archive)
    expect(parseRunObservationArchive(JSON.stringify(archive))).toEqual(archive)
    await owner.markPublished(target, { versionId: 'long-archive' })
    expect((await owner.load(target))?.archive).toEqual(archive)
  }, 30_000)

  it('recovers an interrupted segment/index commit without duplicating or rewriting a sealed segment', async () => {
    let source = snapshot()
    let failIndex = false
    let writes = 0
    const { owner, dataRoot } = await setup({
      read: async () => source,
      durableFileDependencies: {
        rename: async (a, b) => {
          if (String(b).includes('.segment-')) writes++
          else if (failIndex) throw new Error('index rename failed after segment fsync')
          await rename(a, b)
        }
      }
    })
    const handle = await owner.start(target)
    for (let i = 0; i < 128; i++) {
      source = snapshot(i)
      await handle.sample()
    }
    failIndex = true
    source = snapshot(128)
    await expect(handle.sample()).rejects.toThrow('could not be persisted')
    const segmentPath = join(
      dataRoot,
      'managed-run-observations',
      `${handle.recordingId}.segment-00.json`
    )
    const segment = await readFile(segmentPath, 'utf8')
    expect((await owner.load(target))?.history.snapshots).toHaveLength(128)
    failIndex = false
    source = snapshot(129, true)
    const archive = await handle.finish()
    expect(archive?.records).toHaveLength(129)
    expect(archive?.records[0].sourceEvidence.cursor.sequence).toBe(0)
    expect(archive?.records.at(-1)?.sourceEvidence.cursor.sequence).toBe(129)
    expect(archive?.coverage).toMatchObject({
      sourceCursorGaps: 1,
      samplingFailures: 1,
      droppedEarlierObservations: false
    })
    expect(writes).toBe(1)
    expect(await readFile(segmentPath, 'utf8')).toBe(segment)
  }, 30_000)

  it('rejects missing, tampered and foreign-scope sealed evidence while preserving the index', async () => {
    let source = snapshot()
    const { owner, dataRoot } = await setup({ read: async () => source })
    const handle = await owner.start(target)
    for (let i = 0; i < 129; i++) {
      source = snapshot(i)
      await handle.sample()
    }
    await handle.abort()
    const indexPath = file(dataRoot, handle.recordingId)
    const before = await readFile(indexPath, 'utf8')
    const segmentPath = join(
      dataRoot,
      'managed-run-observations',
      `${handle.recordingId}.segment-00.json`
    )
    const segment = JSON.parse(await readFile(segmentPath, 'utf8'))
    segment.target.sessionId = 'foreign-session'
    const changed = JSON.stringify(segment)
    await writeFile(segmentPath, changed)
    await expect(owner.load(target)).rejects.toBeInstanceOf(DurableJsonRecoveryBarrierError)
    const index = JSON.parse(before)
    index.segments[0].checksum = createHash('sha256').update(changed).digest('hex')
    index.segments[0].sizeBytes = Buffer.byteLength(changed)
    await writeFile(indexPath, JSON.stringify(index))
    await expect(owner.load(target)).rejects.toBeInstanceOf(DurableJsonRecoveryBarrierError)
    await writeFile(indexPath, before)
    await rm(segmentPath)
    await expect(owner.load(target)).rejects.toBeInstanceOf(DurableJsonRecoveryBarrierError)
    expect(await readFile(indexPath, 'utf8')).toBe(before)
  }, 30_000)

  it('reads existing v1 inline sidecars without changing their evidence or requiring a migration', async () => {
    const { owner, dataRoot } = await setup({ read: async () => snapshot(0, true) })
    const handle = await owner.start(target)
    const archive = await handle.finish()
    const path = file(dataRoot, handle.recordingId)
    const legacy = JSON.parse(await readFile(path, 'utf8'))
    legacy.schemaVersion = 1
    delete legacy.segments
    const text = JSON.stringify(legacy)
    await writeFile(path, text)
    expect((await owner.load(target))?.archive).toEqual(archive)
    expect(await readFile(path, 'utf8')).toBe(text)
  })
})
