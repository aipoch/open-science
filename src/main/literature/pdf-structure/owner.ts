import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, rmdir } from 'node:fs/promises'
import { join } from 'node:path'

import type { LocalModelOwner, LocalModelUse } from '../../local-models/owner'
import { acquireDataRootWriter } from '../../storage/migration-state'
import { resolveDataRoot } from '../../storage-root'
import type { ResolvedSessionPdfVersion } from '../session-pdf-source-resolver'
import {
  parsePdfStructureResult,
  type PdfStructureIdentity,
  type PdfStructureResult
} from './result'
import { PdfStructureSourceAuthority, type PdfStructureSourceRequest } from './source'
import { PdfStructureCache, type PdfStructureCacheClearResult } from './cache'

export type PdfStructureProgress = Readonly<{
  state: 'queued' | 'running'
  phase?: string
  requestedPages: readonly number[]
  processedPages: readonly number[]
}>

// start must return the handle synchronously, before asynchronous startup. stop resolves only
// after the owned worker and its descendants are gone; a rejection retains files and model use.
export type PdfStructureEngine = {
  describe(): Promise<{ fingerprint: string; modelRevision: string }>
  start(request: {
    inputPath: string
    model: Omit<LocalModelUse, 'release'>
    identity: PdfStructureIdentity
    signal: AbortSignal
    onProgress: (progress: { phase: string; processedPages: number[] }) => void
  }): {
    result: Promise<unknown>
    thumbnails: ReadonlyMap<string, Uint8Array>
    stop(): Promise<void>
  }
}

type Dependencies = {
  sources: PdfStructureSourceAuthority
  models: Pick<LocalModelOwner, 'acquireUse'>
  engine: PdfStructureEngine
  dataRoot?: () => string
  acquireWriter?: () => () => void
}
type Consumer = {
  request: PdfStructureSourceRequest
  source: ResolvedSessionPdfVersion
  progress?: (progress: PdfStructureProgress) => void
  resolve: (result: PdfStructureResult) => void
  reject: (error: unknown) => void
}
type Job = {
  key: string
  identity: PdfStructureIdentity
  modelRevision: string
  controller: AbortController
  consumers: Set<Consumer>
  accepting: boolean
  progress: PdfStructureProgress
  settled: Promise<void>
  finish: () => void
}
const cancelled = (): Error => new DOMException('PDF parsing was cancelled.', 'AbortError')

export type PdfStructureOwner = {
  acquire(
    request: PdfStructureSourceRequest,
    pages: readonly number[],
    options?: {
      signal?: AbortSignal
      onProgress?: (progress: PdfStructureProgress) => void
    }
  ): { result: Promise<PdfStructureResult>; release(): void }
  close(): Promise<void>
  clearCache(): Promise<PdfStructureCacheClearResult>
  readThumbnail(
    request: PdfStructureSourceRequest,
    pages: readonly number[],
    extractionId: string,
    thumbnailId: string,
    signal?: AbortSignal
  ): Promise<Buffer | undefined>
}

// One concrete FIFO owner. Pending work deduplicates, authorization and cancellation never do.
export const createPdfStructureOwner = (dependencies: Dependencies): PdfStructureOwner => {
  const acquireWriter = dependencies.acquireWriter ?? acquireDataRootWriter
  const root = dependencies.dataRoot ?? resolveDataRoot
  const cache = new PdfStructureCache({ dataRoot: root })
  const jobs = new Map<string, Job>()
  const queue: Job[] = []
  const requests = new Map<AbortController, Promise<void>>()
  const retained = new Set<() => Promise<void>>()
  const reads = new Set<Promise<void>>()
  let running = false
  let closed = false
  let closing: Promise<void> | undefined
  let clearing: Promise<PdfStructureCacheClearResult> | undefined

  const admit = (): void => {
    if (closed) throw new Error('PDF structure owner is closed.')
    if (clearing) throw new Error('PDF structure cache is being cleared.')
    if (retained.size)
      throw new Error('PDF worker cleanup must finish before more parsing can start.')
  }
  const withWriter = async <T>(operation: () => Promise<T>): Promise<T> => {
    const release = acquireWriter()
    try {
      return await operation()
    } finally {
      release()
    }
  }
  const notify = (consumer: Consumer, progress: PdfStructureProgress): void => {
    // A view callback must not terminate shared work or mutate another consumer's progress.
    try {
      consumer.progress?.(structuredClone(progress))
    } catch {
      /* detached view */
    }
  }
  const cancelJob = (job: Job): void => {
    job.controller.abort(cancelled())
    const index = queue.indexOf(job)
    if (index !== -1) {
      queue.splice(index, 1)
      jobs.delete(job.key)
      for (const consumer of job.consumers) consumer.reject(cancelled())
      job.finish()
    }
  }
  const stagingDirectory = async (): Promise<string> => {
    let directory = root()
    for (const part of ['pdf-structure', 'v1', 'staging']) {
      directory = join(directory, part)
      await mkdir(directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error
      })
      const entry = await lstat(directory)
      if (!entry.isDirectory() || entry.isSymbolicLink())
        throw new Error('Unsafe PDF staging directory.')
    }
    return mkdtemp(join(directory, 'job-'))
  }
  const execute = async (job: Job): Promise<void> => {
    job.controller.signal.throwIfAborted()
    // No outer writer here: the model use acquires the single long-lived migration reservation.
    const model = await dependencies.models.acquireUse()
    let directory: string | undefined
    let copy: ReturnType<PdfStructureSourceAuthority['stage']> | undefined
    let worker: ReturnType<PdfStructureEngine['start']> | undefined
    let stopped = false
    const stop = async (): Promise<void> => {
      if (worker && !stopped) {
        await worker.stop()
        stopped = true
      }
    }
    const cleanupFiles = async (): Promise<void> => {
      if (directory) {
        await copy?.dispose()
        // Never recursively delete files an unexpected worker/user may have added.
        await rmdir(directory)
        directory = undefined
      }
    }
    const cleanup = async (): Promise<void> => {
      await stop()
      await cleanupFiles()
      model.release()
      retained.delete(cleanup)
    }
    try {
      job.controller.signal.throwIfAborted()
      if (model.revision !== job.modelRevision) {
        throw new Error(PDF_MODEL_CHANGED)
      }
      directory = await stagingDirectory()
      const inputPath = join(directory, 'input.pdf')
      let copied = false
      let sourceError: unknown = new Error('No authorized PDF consumer remains.')
      for (const consumer of job.consumers) {
        job.controller.signal.throwIfAborted()
        copy = dependencies.sources.stage(
          consumer.request,
          consumer.source,
          inputPath,
          job.controller.signal
        )
        try {
          await copy.ready
          copied = true
          break
        } catch (error) {
          sourceError = error
          await copy.dispose()
          copy = undefined
        }
      }
      if (!copied) throw sourceError
      job.controller.signal.throwIfAborted()
      worker = dependencies.engine.start({
        inputPath,
        model: { revision: model.revision, assets: model.assets.map((asset) => ({ ...asset })) },
        identity: structuredClone(job.identity),
        signal: job.controller.signal,
        onProgress: ({ phase, processedPages }) => {
          if (job.controller.signal.aborted) return
          if (
            new Set(processedPages).size !== processedPages.length ||
            processedPages.some((page) => !job.identity.requestedPages.includes(page)) ||
            job.progress.processedPages.some((page) => !processedPages.includes(page))
          )
            return
          job.progress = {
            state: 'running',
            phase,
            requestedPages: job.identity.requestedPages,
            processedPages: [...processedPages].sort((a, b) => a - b)
          }
          for (const consumer of job.consumers) notify(consumer, job.progress)
        }
      })
      let abortListener!: () => void
      const aborted = new Promise<never>((_, reject) => {
        abortListener = () => reject(job.controller.signal.reason)
        job.controller.signal.addEventListener('abort', abortListener, { once: true })
        if (job.controller.signal.aborted) abortListener()
      })
      let output: unknown
      try {
        output = await Promise.race([worker.result, aborted])
      } finally {
        job.controller.signal.removeEventListener('abort', abortListener)
      }
      // Parsing the result and delivering it only happens after confirmed process teardown.
      await stop()
      job.controller.signal.throwIfAborted()
      const result = await cache.publish(
        parsePdfStructureResult(output, job.identity),
        worker.thumbnails,
        job.controller.signal
      )
      job.accepting = false
      await cleanupFiles()
      // The admitted model use still owns the writer. Reentering the migration gate here would
      // reject an already running job when a migration starts waiting for that very job.
      for (const consumer of job.consumers) {
        try {
          await dependencies.sources.reauthorize(consumer.request, consumer.source)
          job.controller.signal.throwIfAborted()
          // Deliver each result immediately after its own recheck. Another consumer's slow
          // authorization must not extend the lifetime of this consumer's access decision.
          consumer.resolve(structuredClone(result))
        } catch (error) {
          consumer.reject(error)
        }
      }
    } finally {
      if (stopped && !directory) model.release()
      else
        await cleanup().catch((error: unknown) => {
          retained.add(cleanup)
          throw error
        })
    }
  }
  const pump = async (): Promise<void> => {
    if (running) return
    running = true
    try {
      while (queue.length) {
        const job = queue.shift()!
        try {
          if (retained.size) throw new Error('PDF worker cleanup is pending.')
          job.controller.signal.throwIfAborted()
          job.progress = { ...job.progress, state: 'running' }
          for (const consumer of job.consumers) notify(consumer, job.progress)
          await execute(job)
        } catch (error) {
          for (const consumer of job.consumers) consumer.reject(error)
        } finally {
          jobs.delete(job.key)
          job.finish()
        }
      }
    } finally {
      running = false
    }
  }
  const acquire = (
    request: PdfStructureSourceRequest,
    pages: readonly number[],
    options: { signal?: AbortSignal; onProgress?: Consumer['progress'] } = {}
  ): { result: Promise<PdfStructureResult>; release(): void } => {
    const sourceRequest = structuredClone(request)
    const requestedPages = [...new Set(pages)].sort((a, b) => a - b)
    const controller = new AbortController()
    let job: Job | undefined
    let consumer: Consumer | undefined
    const detach = (): void => {
      if (!job || !consumer) return
      consumer.reject(controller.signal.reason ?? cancelled())
      job.consumers.delete(consumer)
      consumer = undefined
      if (!job.consumers.size) cancelJob(job)
    }
    const release = (): void => {
      controller.abort(cancelled())
      detach()
    }
    options.signal?.addEventListener('abort', release, { once: true })
    if (options.signal?.aborted) release()
    const operation = (async (): Promise<PdfStructureResult> => {
      admit()
      controller.signal.throwIfAborted()
      if (
        !requestedPages.length ||
        requestedPages.some((page) => !Number.isSafeInteger(page) || page <= 0)
      ) {
        throw new Error('PDF parsing requires positive physical page numbers.')
      }
      const source = await withWriter(() => dependencies.sources.resolve(sourceRequest))
      controller.signal.throwIfAborted()
      if (source.sizeBytes > 50 * 1024 ** 2)
        throw new Error('PDF source exceeds the 50 MiB parsing limit.')
      const recipe = await dependencies.engine.describe()
      if (!/^[a-f0-9]{64}$/.test(recipe.fingerprint) || !recipe.modelRevision) {
        throw new Error('PDF engine recipe is invalid.')
      }
      const cacheKey = {
        sourceChecksum: source.checksum,
        sourceSizeBytes: source.sizeBytes,
        engineFingerprint: recipe.fingerprint,
        requestedPages
      }
      const readCached = (): Promise<PdfStructureResult | undefined> =>
        withWriter(async () => {
          controller.signal.throwIfAborted()
          const result = await cache.read(cacheKey)
          if (result) await dependencies.sources.reauthorize(sourceRequest, source)
          controller.signal.throwIfAborted()
          return result
        })
      const cached = await readCached()
      if (cached) return cached
      const key = createHash('sha256')
        .update(
          JSON.stringify([
            source.checksum,
            source.sizeBytes,
            recipe.fingerprint,
            recipe.modelRevision,
            requestedPages
          ])
        )
        .digest('hex')
      let waited = false
      while (
        jobs.has(key) &&
        (!jobs.get(key)!.accepting || jobs.get(key)!.controller.signal.aborted)
      ) {
        await jobs.get(key)!.settled
        waited = true
      }
      admit()
      controller.signal.throwIfAborted()
      if (waited) {
        const cached = await readCached()
        if (cached) return cached
      }
      job = jobs.get(key)
      if (!job) {
        let finish!: Job['finish']
        const settled = new Promise<void>((yes) => {
          finish = yes
        })
        job = {
          key,
          modelRevision: recipe.modelRevision,
          controller: new AbortController(),
          consumers: new Set(),
          accepting: true,
          identity: {
            extractionId: randomUUID(),
            sourceChecksum: source.checksum,
            sourceSizeBytes: source.sizeBytes,
            engineFingerprint: recipe.fingerprint,
            requestedPages
          },
          progress: { state: 'queued', requestedPages, processedPages: [] },
          settled,
          finish
        }
        jobs.set(key, job)
        queue.push(job)
      }
      let resolve!: Consumer['resolve']
      let reject!: Consumer['reject']
      const completion = new Promise<PdfStructureResult>((yes, no) => {
        resolve = yes
        reject = no
      })
      consumer = { request: sourceRequest, source, progress: options.onProgress, resolve, reject }
      job.consumers.add(consumer)
      notify(consumer, job.progress)
      void pump()
      const result = await completion
      controller.signal.throwIfAborted()
      return result
    })()
    let abortListener!: () => void
    const aborted = new Promise<never>((_, reject) => {
      abortListener = () => reject(controller.signal.reason)
      controller.signal.addEventListener('abort', abortListener, { once: true })
      if (controller.signal.aborted) abortListener()
    })
    const finished = operation
      .then(
        () => undefined,
        () => undefined
      )
      .finally(() => {
        detach()
        requests.delete(controller)
        options.signal?.removeEventListener('abort', release)
        controller.signal.removeEventListener('abort', abortListener)
      })
    requests.set(controller, finished)
    const result = Promise.race([operation, aborted])
    // Release is allowed before the consumer starts awaiting its result.
    void result.catch(() => undefined)
    return { result, release }
  }
  const stopJobs = (): void => {
    for (const controller of requests.keys()) controller.abort(cancelled())
    for (const job of jobs.values()) cancelJob(job)
  }
  let draining: Promise<void> | undefined
  const drain = (): Promise<void> => {
    if (draining) return draining
    draining = (async () => {
      await Promise.all([
        ...requests.values(),
        ...reads,
        ...[...jobs.values()].map(({ settled }) => settled)
      ])
      const failures = await Promise.allSettled([...retained].map((cleanup) => cleanup()))
      const errors = failures.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []
      )
      if (errors.length) throw new AggregateError(errors, 'PDF worker cleanup is incomplete.')
    })().finally(() => {
      draining = undefined
    })
    return draining
  }
  const clearCache = (): Promise<PdfStructureCacheClearResult> => {
    if (closed) return Promise.reject(new Error('PDF structure owner is closed.'))
    if (clearing) return clearing
    const operation = Promise.resolve()
      .then(async () => {
        stopJobs()
        await drain()
        return withWriter(() => cache.clear())
      })
      .finally(() => {
        if (clearing === operation) clearing = undefined
      })
    clearing = operation
    return operation
  }
  const readThumbnail: PdfStructureOwner['readThumbnail'] = (
    request,
    pages,
    extractionId,
    thumbnailId,
    signal
  ) => {
    const sourceRequest = structuredClone(request)
    const requestedPages = [...new Set(pages)].sort((a, b) => a - b)
    const operation = (async () => {
      admit()
      signal?.throwIfAborted()
      const recipe = await dependencies.engine.describe()
      return withWriter(async () => {
        admit()
        signal?.throwIfAborted()
        const source = await dependencies.sources.resolve(sourceRequest)
        const bytes = await cache.readThumbnail(
          {
            sourceChecksum: source.checksum,
            sourceSizeBytes: source.sizeBytes,
            engineFingerprint: recipe.fingerprint,
            requestedPages
          },
          extractionId,
          thumbnailId
        )
        await dependencies.sources.reauthorize(sourceRequest, source)
        signal?.throwIfAborted()
        if (closed) throw new Error('PDF structure owner is closed.')
        return bytes
      })
    })()
    const finished = operation
      .then(
        () => undefined,
        () => undefined
      )
      .finally(() => {
        reads.delete(finished)
      })
    reads.add(finished)
    return operation
  }
  const close = (): Promise<void> => {
    closed = true
    if (closing) return closing
    stopJobs()
    closing = (async () => {
      const results = await Promise.allSettled([drain(), ...(clearing ? [clearing] : [])])
      const errors = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []
      )
      if (errors.length) throw new AggregateError(errors, 'PDF worker cleanup is incomplete.')
    })().finally(() => {
      closing = undefined
    })
    return closing
  }
  return { acquire, close, clearCache, readThumbnail }
}
import { PDF_MODEL_CHANGED } from '../../../shared/local-models'
