import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createLinearConversationGraph } from '../../../shared/conversation-graph'
import type { PersistedChatSession } from '../../../shared/session-persistence'
import type { ImmutableInputContentLease } from '../../immutable-input-authority'
import { createLocalModelOwner, type LocalModelUse } from '../../local-models/owner'
import {
  acquireDataRootWriter,
  beginMigration,
  endMigration,
  waitForDataRootWriters
} from '../../storage/migration-state'
import type { LiteratureAttachmentAuthority } from '../attachment-authority'
import type { ResolvedSessionPdfVersion } from '../session-pdf-source-resolver'
import { createPdfStructureOwner, type PdfStructureEngine } from './owner'
import {
  parsePdfStructureResult,
  type PdfStructureIdentity,
  type PdfStructureResult
} from './result'
import { PdfStructureSourceAuthority, type PdfStructureSourceRequest } from './source'

vi.mock('electron', () => ({
  net: {},
  app: { isPackaged: false, getPath: () => tmpdir() },
  dialog: {}
}))

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void }
const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const content = Buffer.from('%PDF-1.7\nimmutable test source\n')
const checksum = createHash('sha256').update(content).digest('hex')
const fingerprint = 'b'.repeat(64)
const reading: PdfStructureSourceRequest = { kind: 'literature', attachmentVersionId: 'version-1' }
const agent: PdfStructureSourceRequest = {
  kind: 'session',
  projectId: 'project-1',
  sessionId: 'session-1',
  promptMessageId: 'prompt-1',
  bindingId: 'binding-1'
}
const resultFor = (identity: PdfStructureIdentity): PdfStructureResult => ({
  schemaVersion: 1,
  ...structuredClone(identity),
  pageCount: 10,
  processedPages: [...identity.requestedPages],
  pages: identity.requestedPages.map((page) => ({ page, width: 600, height: 800, rotation: 0 })),
  elements: [],
  thumbnails: [],
  navigation: [],
  issues: []
})

let root: string
let source: ResolvedSessionPdfVersion
let session: PersistedChatSession
let authority: PdfStructureSourceAuthority
let literature: ReturnType<typeof vi.fn<LiteratureAttachmentAuthority['resolveVersion']>>
const owners: ReturnType<typeof createPdfStructureOwner>[] = []

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pdf-structure-owner-'))
  const path = join(root, 'source.pdf')
  await writeFile(path, content)
  source = {
    sourceKind: 'literature-attachment-version',
    sourceFileId: 'attachment-1',
    sourceVersionId: 'version-1',
    filename: 'paper.pdf',
    contentType: 'application/pdf',
    sizeBytes: content.length,
    checksum,
    path
  }
  session = {
    id: 'session-1',
    projectId: 'project-1',
    title: 'Reading',
    cwd: root,
    status: 'idle',
    createdAt: 1,
    updatedAt: 1,
    messages: [
      {
        id: 'prompt-1',
        role: 'user',
        content: 'Read this PDF.',
        status: 'complete',
        eventIds: [],
        createdAt: 1,
        updatedAt: 1,
        pdfContext: {
          version: 1,
          bindings: [
            {
              version: 1,
              bindingId: 'binding-1',
              sourceKind: 'literature-attachment-version',
              sourceFileId: source.sourceFileId,
              sourceVersionId: source.sourceVersionId,
              name: source.filename,
              mimeType: 'application/pdf',
              sizeBytes: source.sizeBytes,
              checksum,
              linkedAt: 1
            }
          ]
        }
      }
    ]
  }
  literature = vi.fn(async () => ({
    itemId: 'item-1',
    attachmentId: source.sourceFileId,
    versionId: source.sourceVersionId,
    versionNumber: 1,
    filename: source.filename,
    contentType: 'application/pdf',
    sizeBytes: source.sizeBytes,
    checksum: source.checksum,
    storageKey: 'content/test',
    path: source.path
  }))
  authority = new PdfStructureSourceAuthority({
    literature: { resolveVersion: literature },
    sources: { resolveVersion: async () => source },
    sessions: { loadSessionForContinuation: async () => session }
  })
})
afterEach(async () => {
  for (const owner of owners.splice(0)) await owner.close()
  endMigration()
  await rm(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

type Run = {
  request: Parameters<PdfStructureEngine['start']>[0]
  output: Deferred<unknown>
  thumbnails: Map<string, Uint8Array>
  stop: ReturnType<typeof vi.fn<() => Promise<void>>>
}
type Setup = {
  owner: ReturnType<typeof createPdfStructureOwner>
  engine: PdfStructureEngine
  runs: Run[]
  acquireUse: ReturnType<typeof vi.fn<() => Promise<LocalModelUse>>>
  acquireWriter: ReturnType<typeof vi.fn<() => () => void>>
  writers(): number
  uses(): number
  migrate(): void
  update(): void
}
const setup = (modelOwner?: ReturnType<typeof createLocalModelOwner>): Setup => {
  let writers = 0
  let uses = 0
  let migrationPending = false
  let modelRevision = 'revision-1'
  const acquireWriter = vi.fn(() => {
    if (migrationPending) throw new Error('Migration is pending.')
    writers++
    let released = false
    return () => {
      if (!released) {
        released = true
        writers--
      }
    }
  })
  const acquireUse = vi.fn(async () => {
    const releaseWriter = acquireWriter()
    uses++
    let released = false
    return {
      revision: modelRevision,
      assets: [],
      release: vi.fn(() => {
        if (!released) {
          released = true
          uses--
          releaseWriter()
        }
      })
    }
  })
  const runs: Run[] = []
  const engine: PdfStructureEngine = {
    describe: vi.fn(async () => ({ fingerprint, modelRevision })),
    start: vi.fn((request) => {
      const output = deferred<unknown>()
      const stop = vi.fn(async () => undefined)
      const thumbnails = new Map<string, Uint8Array>()
      runs.push({ request, output, stop, thumbnails })
      return { result: output.promise, thumbnails, stop }
    })
  }
  const owner = createPdfStructureOwner({
    sources: authority,
    models: modelOwner ?? { acquireUse },
    engine,
    dataRoot: () => root,
    acquireWriter: modelOwner ? acquireDataRootWriter : acquireWriter
  })
  owners.push(owner)
  return {
    owner,
    runs,
    engine,
    acquireUse,
    acquireWriter,
    writers: () => writers,
    uses: () => uses,
    migrate: () => {
      migrationPending = true
    },
    update: () => {
      modelRevision = 'revision-2'
    }
  }
}
const started = async (test: Setup, count = 1): Promise<Run> => {
  await vi.waitFor(() => expect(test.runs).toHaveLength(count))
  return test.runs[count - 1]
}

describe('shared PDF parsing lifecycle', () => {
  it('reads persisted results without starting inference on either cache hit or miss', async () => {
    const test = setup()
    expect(await test.owner.readCached(reading, [1])).toBeUndefined()
    expect(test.engine.start).not.toHaveBeenCalled()
    expect(test.acquireUse).not.toHaveBeenCalled()
    const task = test.owner.acquire(reading, [1])
    const run = await started(test)
    run.output.resolve(resultFor(run.request.identity))
    const parsed = await task.result
    task.release()
    const reopened = setup()
    expect(await reopened.owner.readCached(reading, [1])).toEqual(parsed)
    expect(await reopened.owner.readCached(reading, [2])).toBeUndefined()
    vi.mocked(reopened.engine.describe).mockResolvedValue({
      fingerprint: 'c'.repeat(64),
      modelRevision: 'revision-2'
    })
    expect(await reopened.owner.readCached(reading, [1])).toBeUndefined()
    expect(reopened.engine.start).not.toHaveBeenCalled()
    expect(reopened.acquireUse).not.toHaveBeenCalled()
    expect(reopened.writers()).toBe(0)
  })

  it('rechecks source authorization and releases the writer after a cache read', async () => {
    const test = setup()
    vi.spyOn(authority, 'reauthorize').mockRejectedValue(new Error('source revoked'))
    await expect(test.owner.readCached(reading, [1])).rejects.toThrow('source revoked')
    expect(test.engine.start).not.toHaveBeenCalled()
    expect(test.writers()).toBe(0)
  })

  it('shares canonical pages across Reading and Agent while cancellation stays consumer-local', async () => {
    const test = setup()
    const first = test.owner.acquire(reading, [2, 1, 2])
    const second = test.owner.acquire(agent, [1, 2])
    const run = await started(test)
    expect(await readFile(run.request.inputPath)).toEqual(content)
    expect(run.request.model).not.toHaveProperty('release')
    first.release()
    first.release()
    await expect(first.result).rejects.toMatchObject({ name: 'AbortError' })
    expect(run.request.signal.aborted).toBe(false)
    run.output.resolve(resultFor(run.request.identity))
    await expect(second.result).resolves.toMatchObject({ processedPages: [1, 2] })
    expect(test.acquireUse).toHaveBeenCalledTimes(1)
    expect(run.stop).toHaveBeenCalledTimes(1)
    expect(test.uses()).toBe(0)
    expect(test.writers()).toBe(0)
    expect(await readdir(join(root, 'pdf-structure', 'v1', 'staging'))).toEqual([])
  })

  it('stops a noncooperative worker on last release and waits before same-key retry', async () => {
    const test = setup()
    const first = test.owner.acquire(reading, [1])
    const run = await started(test)
    const stopped = deferred<void>()
    run.stop.mockImplementation(() => stopped.promise)
    first.release()
    await expect(first.result).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(run.stop).toHaveBeenCalledTimes(1))
    const next = test.owner.acquire(reading, [1])
    expect(test.uses()).toBe(1)
    expect(await readFile(run.request.inputPath)).toEqual(content)
    expect(test.runs).toHaveLength(1)
    stopped.resolve()
    const nextRun = await started(test, 2)
    expect(nextRun.request.inputPath).not.toBe(run.request.inputPath)
    nextRun.output.resolve(resultFor(nextRun.request.identity))
    await expect(next.result).resolves.toMatchObject({ sourceChecksum: checksum })
  })

  it('removes cancelled queued work immediately without reserving a model', async () => {
    const test = setup()
    const first = test.owner.acquire(reading, [1])
    const run = await started(test)
    const queuedProgress = vi.fn()
    const queued = test.owner.acquire(reading, [2], { onProgress: queuedProgress })
    await vi.waitFor(() =>
      expect(queuedProgress).toHaveBeenCalledWith(expect.objectContaining({ state: 'queued' }))
    )
    queued.release()
    await expect(queued.result).rejects.toMatchObject({ name: 'AbortError' })
    const retry = test.owner.acquire(reading, [2])
    run.output.resolve(resultFor(run.request.identity))
    await first.result
    const nextRun = await started(test, 2)
    nextRun.output.resolve(resultFor(nextRun.request.identity))
    await retry.result
    expect(test.acquireUse).toHaveBeenCalledTimes(2)
  })

  it('checks each consumer on delivery, even if another consumer still authorizes the same bytes', async () => {
    const test = setup()
    const first = test.owner.acquire(agent, [1])
    const second = test.owner.acquire(reading, [1])
    const run = await started(test)
    session.conversationGraph = createLinearConversationGraph({
      sessionId: 'session-1',
      messages: [],
      createdAt: 1,
      updatedAt: 2
    })
    // The stale flat prompt remains; it must not grant access after switching graph branches.
    run.output.resolve(resultFor(run.request.identity))
    await expect(first.result).rejects.toThrow('NO_LINKED_PDF_CONTEXT')
    await expect(second.result).resolves.toMatchObject({ sourceChecksum: checksum })
  })

  it('delivers after each individual recheck and authorizes cached arrivals independently', async () => {
    const test = setup()
    const first = test.owner.acquire(agent, [1])
    const run = await started(test)
    // Source authorization is asynchronous: explicitly establish A's admission before B joins.
    const joined = vi.fn()
    const second = test.owner.acquire(reading, [1], { onProgress: joined })
    await vi.waitFor(() => expect(joined).toHaveBeenCalled())
    const paused = deferred<void>()
    const gate = deferred<void>()
    const reauthorize = authority.reauthorize.bind(authority)
    let pausedOnce = false
    vi.spyOn(authority, 'reauthorize').mockImplementation(async (request, expected) => {
      if (request.kind === 'literature' && run.stop.mock.calls.length && !pausedOnce) {
        pausedOnce = true
        paused.resolve()
        await gate.promise
      }
      return reauthorize(request, expected)
    })
    let delivered = false
    void first.result.then(
      () => {
        delivered = true
      },
      () => undefined
    )
    run.output.resolve(resultFor(run.request.identity))
    await paused.promise
    try {
      // This failed under batched authorization: A waited for B with a stale access decision.
      await vi.waitFor(() => expect(delivered).toBe(true))
      expect(test.uses()).toBe(1)
      session.conversationGraph = createLinearConversationGraph({
        sessionId: 'session-1',
        messages: [],
        createdAt: 1,
        updatedAt: 2
      })
      const next = test.owner.acquire(reading, [1])
      await vi.waitFor(() => expect(test.engine.describe).toHaveBeenCalledTimes(3))
      expect(test.runs).toHaveLength(1)
      await expect(next.result).resolves.toMatchObject({
        extractionId: run.request.identity.extractionId
      })
      gate.resolve()
      await second.result
      expect(test.runs).toHaveLength(1)
    } finally {
      gate.resolve()
    }
  })

  it('rejects deleted sources at delivery and never reuses a failed promise', async () => {
    const test = setup()
    const first = test.owner.acquire(reading, [1])
    const run = await started(test)
    literature.mockResolvedValueOnce(undefined)
    run.output.resolve(resultFor(run.request.identity))
    await expect(first.result).rejects.toThrow('LINKED_PDF_UNAVAILABLE')
    literature.mockResolvedValueOnce(undefined)
    await expect(test.owner.acquire(reading, [1]).result).rejects.toThrow('LINKED_PDF_UNAVAILABLE')
    await expect(test.owner.acquire(reading, [1]).result).resolves.toMatchObject({
      extractionId: run.request.identity.extractionId
    })
    expect(test.runs).toHaveLength(1)
    const next = test.owner.acquire(reading, [2])
    const nextRun = await started(test, 2)
    nextRun.output.reject(new Error('Inference failed'))
    await expect(next.result).rejects.toThrow('Inference failed')
    const retry = test.owner.acquire(reading, [2])
    const retryRun = await started(test, 3)
    retryRun.output.resolve(resultFor(retryRun.request.identity))
    await expect(retry.result).resolves.toMatchObject({ sourceChecksum: checksum })
  })

  it('serves authorized completed results without acquiring a model use', async () => {
    const test = setup()
    const first = test.owner.acquire(reading, [1])
    const run = await started(test)
    run.output.resolve(resultFor(run.request.identity))
    const original = await first.result
    test.acquireUse.mockRejectedValue(new Error('Model removed'))
    await expect(test.owner.acquire(agent, [1]).result).resolves.toEqual(original)
    expect(test.acquireUse).toHaveBeenCalledTimes(1)
    expect(test.runs).toHaveLength(1)
    session.conversationGraph = createLinearConversationGraph({
      sessionId: 'session-1',
      messages: [],
      createdAt: 1,
      updatedAt: 2
    })
    await expect(test.owner.acquire(agent, [1]).result).rejects.toThrow('NO_LINKED_PDF_CONTEXT')
    await expect(test.owner.acquire(reading, [2]).result).rejects.toThrow('Model removed')
  })

  it('coalesces clear, stops active work before deletion and permits a fresh retry', async () => {
    const test = setup()
    const first = test.owner.acquire(reading, [1])
    const run = await started(test)
    run.output.resolve(resultFor(run.request.identity))
    await first.result
    const next = test.owner.acquire(reading, [2])
    const running = await started(test, 2)
    const gate = deferred<void>()
    running.stop.mockImplementation(() => gate.promise)
    const clear = test.owner.clearCache()
    expect(test.owner.clearCache()).toBe(clear)
    let cleared = false
    void clear.then(() => {
      cleared = true
    })
    try {
      await expect(next.result).rejects.toMatchObject({ name: 'AbortError' })
      await vi.waitFor(() => expect(running.stop).toHaveBeenCalled())
      expect(cleared).toBe(false)
      await expect(test.owner.acquire(reading, [1]).result).rejects.toThrow('being cleared')
      expect(test.uses()).toBe(1)
    } finally {
      gate.resolve()
    }
    const report = await clear
    expect(report.removedBytes).toBeGreaterThan(0)
    expect(report.retained).toEqual([])
    running.output.resolve(resultFor(running.request.identity))
    const retry = test.owner.acquire(reading, [1])
    const retried = await started(test, 3)
    retried.output.resolve(resultFor(retried.request.identity))
    await expect(retry.result).resolves.toMatchObject({
      extractionId: retried.request.identity.extractionId
    })
  })

  it('joins one retained cleanup when clear and close run concurrently', async () => {
    const test = setup()
    const handle = test.owner.acquire(reading, [1])
    const run = await started(test)
    run.stop.mockRejectedValue(new Error('Worker still alive'))
    handle.release()
    await expect(handle.result).rejects.toMatchObject({ name: 'AbortError' })
    await expect(test.owner.clearCache()).rejects.toThrow('cleanup is incomplete')
    const before = run.stop.mock.calls.length
    const gate = deferred<void>()
    run.stop.mockImplementation(() => gate.promise)
    const clear = test.owner.clearCache()
    const close = test.owner.close()
    await vi.waitFor(() => expect(run.stop).toHaveBeenCalledTimes(before + 1))
    gate.resolve()
    await expect(clear).resolves.toMatchObject({ retained: [] })
    await expect(close).resolves.toBeUndefined()
    expect(run.stop).toHaveBeenCalledTimes(before + 1)
    expect(test.uses()).toBe(0)
    await expect(test.owner.acquire(reading, [1]).result).rejects.toThrow('closed')
  })

  it('authorizes exact thumbnail references and drains reads before clear or close', async () => {
    const test = setup()
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC',
      'base64'
    )
    const first = test.owner.acquire(reading, [1])
    const run = await started(test)
    const output = resultFor(run.request.identity)
    output.elements = [
      {
        id: 'figure-1',
        kind: 'figure',
        thumbnailId: 'image-1',
        regions: [{ page: 1, x: 0, y: 0, width: 0.5, height: 0.5 }],
        issues: []
      }
    ]
    output.thumbnails = [
      {
        id: 'image-1',
        mimeType: 'image/png',
        width: 1,
        height: 1,
        sizeBytes: png.length,
        sha256: createHash('sha256').update(png).digest('hex')
      }
    ]
    run.thumbnails.set('image-1', png)
    run.output.resolve(output)
    const original = await first.result
    const read = (): Promise<Buffer | undefined> =>
      test.owner.readThumbnail(agent, [1], original.extractionId, 'image-1')
    await expect(read()).resolves.toEqual(png)
    await expect(
      test.owner.readThumbnail(agent, [1], 'old-result', 'image-1')
    ).resolves.toBeUndefined()
    const paused = deferred<void>()
    const gate = deferred<void>()
    const reauthorize = authority.reauthorize.bind(authority)
    vi.spyOn(authority, 'reauthorize').mockImplementation(async (request, expected) => {
      paused.resolve()
      await gate.promise
      return reauthorize(request, expected)
    })
    const pendingRead = read()
    await paused.promise
    let cleared = false
    const clear = test.owner.clearCache().then((report) => {
      cleared = true
      return report
    })
    const close = test.owner.close()
    expect(cleared).toBe(false)
    session.conversationGraph = createLinearConversationGraph({
      sessionId: 'session-1',
      messages: [],
      createdAt: 1,
      updatedAt: 2
    })
    gate.resolve()
    await expect(pendingRead).rejects.toThrow('NO_LINKED_PDF_CONTEXT')
    await expect(clear).resolves.toMatchObject({ retained: [] })
    await close
    expect(test.writers()).toBe(0)
    await expect(read()).rejects.toThrow('closed')
  })

  it('retains source, model and writer until failed teardown can be retried', async () => {
    const test = setup()
    const handle = test.owner.acquire(reading, [1])
    const run = await started(test)
    run.stop.mockRejectedValue(new Error('Worker still alive'))
    handle.release()
    await expect(handle.result).rejects.toMatchObject({ name: 'AbortError' })
    await expect(test.owner.close()).rejects.toThrow('cleanup is incomplete')
    expect(test.uses()).toBe(1)
    expect(test.writers()).toBe(1)
    expect(await readFile(run.request.inputPath)).toEqual(content)
    run.stop.mockResolvedValue(undefined)
    await test.owner.close()
    expect(test.uses()).toBe(0)
    expect(test.writers()).toBe(0)
    await expect(test.owner.acquire(reading, [1]).result).rejects.toThrow('closed')
  })

  it('keeps the original migration reservation through final authorization', async () => {
    const test = setup()
    const handle = test.owner.acquire(reading, [1])
    const run = await started(test)
    expect(test.writers()).toBe(1)
    test.migrate()
    run.output.resolve(resultFor(run.request.identity))
    await expect(handle.result).resolves.toMatchObject({ sourceChecksum: checksum })
    expect(test.writers()).toBe(0)
    expect(test.acquireWriter).toHaveBeenCalledTimes(3) // source, cache lookup, then model use
    await expect(test.owner.acquire(reading, [1]).result).rejects.toThrow('Migration is pending')
  })

  it('drains the real migration gate only after the real model lease and final source checks finish', async () => {
    const folder = join(root, 'models', 'pdf-tables', 'revisions', 'revision-1')
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, 'detection.onnx'), content)
    await writeFile(
      join(root, 'models', 'pdf-tables', 'active.json'),
      JSON.stringify({ schemaVersion: 1, revision: 'revision-1', installedAt: 1 })
    )
    const models = createLocalModelOwner({
      dataRoot: () => root,
      revisions: [
        {
          revision: 'revision-1',
          assets: [
            {
              file: 'detection.onnx',
              size: content.length,
              sha256: checksum,
              url: 'https://example.invalid/model'
            }
          ]
        }
      ]
    })
    const test = setup(models)
    const handle = test.owner.acquire(reading, [1])
    const run = await started(test)
    expect((await models.getSnapshot()).inUse).toBe(true)
    beginMigration()
    let drained = false
    const drain = waitForDataRootWriters().then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)
    run.output.resolve(resultFor(run.request.identity))
    await expect(handle.result).resolves.toMatchObject({ sourceChecksum: checksum })
    await drain
    expect((await models.getSnapshot()).inUse).toBe(false)
    await test.owner.close()
    await models.close()
  })

  it('retains and retries a failed content-lease close without losing the staged input ownership', async () => {
    const file = await open(source.path, 'r')
    const close = vi.fn(async () => {
      await file.close()
    })
    close.mockRejectedValueOnce(new Error('Close failed once'))
    const lease: ImmutableInputContentLease = {
      path: source.path,
      size: content.length,
      versionToken: 1,
      snapshot: { dev: 1n, ino: 1n, size: BigInt(content.length), mtimeNs: 1n },
      read: (buffer, offset, length, position) => file.read(buffer, offset, length, position),
      readRange: vi.fn(async (begin: number, end: number) => {
        const buffer = Buffer.alloc(end - begin)
        const { bytesRead } = await file.read(buffer, 0, buffer.length, begin)
        return buffer.subarray(0, bytesRead)
      }),
      copyTo: vi.fn(),
      verifyUnchanged: vi.fn(async () => undefined),
      close
    }
    source = {
      ...source,
      sourceKind: 'upload-version',
      sourceSessionId: 'origin-session',
      openContent: async () => lease
    }
    session.messages[0].pdfContext = {
      version: 1,
      bindings: [
        {
          ...session.messages[0].pdfContext!.bindings[0],
          sourceKind: 'upload-version',
          sourceSessionId: 'origin-session'
        }
      ]
    }
    const test = setup()
    await expect(test.owner.acquire(agent, [1]).result).rejects.toThrow('Close failed once')
    expect(close).toHaveBeenCalledTimes(2)
    expect(await readdir(join(root, 'pdf-structure', 'v1', 'staging'))).toEqual([])
    expect(test.uses()).toBe(0)
    expect(test.writers()).toBe(0)
    // A fresh request can run after cleanup; no permanent rejected job or cleanup barrier remains.
    source = {
      sourceKind: 'literature-attachment-version',
      sourceFileId: 'attachment-1',
      sourceVersionId: 'version-1',
      filename: 'paper.pdf',
      contentType: 'application/pdf',
      sizeBytes: content.length,
      checksum,
      path: join(root, 'source.pdf')
    }
    const retry = test.owner.acquire(reading, [1])
    const run = await started(test)
    run.output.resolve(resultFor(run.request.identity))
    await retry.result
  })

  it('fails queued stale model recipes without running or mislabeling output', async () => {
    const test = setup()
    const first = test.owner.acquire(reading, [1])
    const run = await started(test)
    const progress = vi.fn()
    const queued = test.owner.acquire(reading, [2], { onProgress: progress })
    await vi.waitFor(() => expect(progress).toHaveBeenCalled())
    test.update()
    run.output.resolve(resultFor(run.request.identity))
    await first.result
    await expect(queued.result).rejects.toThrow('PDF_MODEL_CHANGED')
    expect(test.runs).toHaveLength(1)
    expect(test.uses()).toBe(0)
  })

  it('isolates callback mutations/errors and ignores invalid or regressing progress', async () => {
    const test = setup()
    const progress = vi.fn()
    const first = test.owner.acquire(reading, [1, 2], {
      onProgress: (value) => {
        ;(value.processedPages as number[]).push(99)
        throw new Error('View unmounted')
      }
    })
    const second = test.owner.acquire(agent, [1, 2], { onProgress: progress })
    const run = await started(test)
    run.request.onProgress({ phase: 'tables', processedPages: [1] })
    run.request.onProgress({ phase: 'tables', processedPages: [] })
    run.request.onProgress({ phase: 'tables', processedPages: [1, 99] })
    expect(progress.mock.lastCall?.[0]).toMatchObject({ processedPages: [1], phase: 'tables' })
    run.output.resolve(resultFor(run.request.identity))
    const [a, b] = await Promise.all([first.result, second.result])
    a.processedPages.push(99)
    expect(b.processedPages).toEqual([1, 2])
  })

  it('joins pending authorization on shutdown without starting a late worker', async () => {
    const pending = deferred<ResolvedSessionPdfVersion>()
    vi.spyOn(authority, 'resolve').mockReturnValue(pending.promise)
    const test = setup()
    const handle = test.owner.acquire(reading, [1])
    const close = test.owner.close()
    await expect(handle.result).rejects.toMatchObject({ name: 'AbortError' })
    pending.resolve(source)
    await close
    expect(test.engine.start).not.toHaveBeenCalled()
    expect(test.writers()).toBe(0)
  })

  it('stops and cleans up invalid worker results before rejecting them', async () => {
    const test = setup()
    const handle = test.owner.acquire(reading, [1])
    const run = await started(test)
    run.output.resolve({ ...resultFor(run.request.identity), processedPages: [2] })
    await expect(handle.result).rejects.toThrow('page coverage')
    expect(run.stop).toHaveBeenCalledOnce()
    expect(test.uses()).toBe(0)
    await expect(readFile(run.request.inputPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a linked staging parent and preserves unrelated files', async () => {
    const outside = join(root, 'unrelated')
    await mkdir(outside)
    await writeFile(join(outside, 'sentinel'), 'keep')
    await symlink(outside, join(root, 'pdf-structure'), 'junction')
    const test = setup()
    await expect(test.owner.acquire(reading, [1]).result).rejects.toThrow('Unsafe PDF cache')
    expect(await readdir(outside)).toEqual(['sentinel'])
    expect(await readFile(join(outside, 'sentinel'), 'utf8')).toBe('keep')
    expect(test.engine.start).not.toHaveBeenCalled()
    expect(test.uses()).toBe(0)
  })

  it.each([[], [0], [NaN], [Infinity], [1.5]].map((pages) => ({ pages })))(
    'rejects invalid page requests $pages before reading files',
    async ({ pages }) => {
      const test = setup()
      await expect(test.owner.acquire(reading, pages).result).rejects.toThrow('physical page')
      expect(test.acquireWriter).not.toHaveBeenCalled()
    }
  )
})

describe('immutable PDF staging', () => {
  it('rejects changed bytes despite unchanged metadata and removes only its own copy', async () => {
    const expected = await authority.resolve(reading)
    await writeFile(source.path, Buffer.alloc(content.length, 0))
    const target = join(root, 'input.pdf')
    const stage = authority.stage(reading, expected, target, new AbortController().signal)
    await expect(stage.ready).rejects.toThrow('LINKED_PDF_UNAVAILABLE')
    await stage.dispose()
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
    const sentinel = Buffer.from('unrelated file')
    await writeFile(target, sentinel)
    const collision = authority.stage(reading, expected, target, new AbortController().signal)
    await expect(collision.ready).rejects.toMatchObject({ code: 'EEXIST' })
    await collision.dispose()
    expect(await readFile(target)).toEqual(sentinel)
  })

  it.each(['artifact-version', 'upload-version'] as const)(
    'uses the %s content lease and retries failed source close',
    async (sourceKind) => {
      const file = await open(source.path, 'r')
      const close = vi.fn(async () => {
        await file.close()
      })
      close.mockRejectedValueOnce(new Error('Lease close temporarily failed'))
      const lease: ImmutableInputContentLease = {
        path: source.path,
        size: content.length,
        versionToken: 1,
        snapshot: { dev: 1n, ino: 1n, size: BigInt(content.length), mtimeNs: 1n },
        read: (buffer, offset, length, position) => file.read(buffer, offset, length, position),
        readRange: vi.fn(async (begin: number, end: number) => {
          const buffer = Buffer.alloc(end - begin)
          const { bytesRead } = await file.read(buffer, 0, buffer.length, begin)
          return buffer.subarray(0, bytesRead)
        }),
        copyTo: vi.fn(),
        verifyUnchanged: vi.fn(async () => undefined),
        close
      }
      source = {
        ...source,
        sourceKind,
        sourceSessionId: 'origin-session',
        path: join(root, 'not-a-readable-path'),
        openContent: async () => lease
      }
      const binding = session.messages[0].pdfContext!.bindings[0]
      session.messages[0].pdfContext = {
        version: 1,
        bindings: [{ ...binding, sourceKind, sourceSessionId: 'origin-session' }]
      }
      const stage = authority.stage(
        agent,
        source,
        join(root, 'input.pdf'),
        new AbortController().signal
      )
      await expect(stage.ready).rejects.toThrow('Lease close temporarily failed')
      expect(lease.verifyUnchanged).toHaveBeenCalledOnce()
      await stage.dispose()
      await stage.dispose()
      expect(close).toHaveBeenCalledTimes(2)
      await expect(readFile(join(root, 'input.pdf'))).rejects.toMatchObject({ code: 'ENOENT' })
    }
  )

  it('reauthorizes after copying and refuses a removed binding', async () => {
    const resolve = vi.spyOn(authority, 'resolve')
    resolve.mockResolvedValueOnce(source).mockRejectedValueOnce(new Error('Binding removed'))
    const stage = authority.stage(
      reading,
      source,
      join(root, 'input.pdf'),
      new AbortController().signal
    )
    await expect(stage.ready).rejects.toThrow('Binding removed')
    await stage.dispose()
    await expect(readFile(join(root, 'input.pdf'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('PDF result boundary', () => {
  const identity: PdfStructureIdentity = {
    extractionId: 'extraction-1',
    sourceChecksum: checksum,
    sourceSizeBytes: content.length,
    engineFingerprint: fingerprint,
    requestedPages: [1]
  }
  it('accepts sparse/merged cells without filling missing content', () => {
    const result = resultFor(identity)
    result.elements.push({
      id: 'table-1',
      kind: 'table',
      regions: [{ page: 1, x: 0, y: 0, width: 1, height: 1 }],
      table: {
        rowCount: 1000000,
        columnCount: 1000000,
        cells: [{ row: 0, column: 0, rowSpan: 2, columnSpan: 2, text: '', regions: [] }],
        unassignedText: [{ text: 'unplaced', regions: [] }],
        issues: []
      },
      issues: []
    })
    expect(parsePdfStructureResult(result, identity).elements[0].table).toEqual(
      result.elements[0].table
    )
  })
  it.each(['coverage', 'identity', 'geometry', 'overlap', 'duplicate', 'page', 'path'] as const)(
    'rejects invalid %s',
    (kind) => {
      const result = resultFor(identity)
      result.elements.push({
        id: 'table-1',
        kind: 'table',
        regions: [{ page: 1, x: 0, y: 0, width: 1, height: 1 }],
        table: {
          rowCount: 1,
          columnCount: 1,
          cells: [{ row: 0, column: 0, rowSpan: 1, columnSpan: 1, text: 'a', regions: [] }],
          unassignedText: [],
          issues: []
        },
        issues: []
      })
      if (kind === 'coverage') result.processedPages = [2]
      if (kind === 'identity') result.sourceChecksum = 'f'.repeat(64)
      if (kind === 'geometry') result.elements[0].regions[0].x = 0.5
      if (kind === 'page') result.elements[0].regions[0].page = 2
      if (kind === 'overlap')
        result.elements[0].table!.cells.push(structuredClone(result.elements[0].table!.cells[0]))
      if (kind === 'duplicate') result.elements.push(structuredClone(result.elements[0]))
      if (kind === 'path') Object.assign(result.elements[0], { path: '../outside.png' })
      expect(() => parsePdfStructureResult(result, identity)).toThrow()
    }
  )
  it('rejects oversized, deeply nested and cyclic values before schema refinement', () => {
    for (const value of [Array(8193).fill(null), 'x'.repeat(262145)]) {
      expect(() => parsePdfStructureResult({ value }, identity)).toThrow('budget')
    }
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => parsePdfStructureResult(cyclic, identity)).toThrow('JSON tree')
    expect(() => parsePdfStructureResult({ cells: Array(2049).fill(null) }, identity)).toThrow(
      'budget'
    )
    let nested: unknown = null
    for (let i = 0; i < 34; i++) nested = { nested }
    expect(() => parsePdfStructureResult(nested, identity)).toThrow('budget')
  })
})
