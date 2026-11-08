/// <reference types="electron-vite/node" />
import type { Worker } from 'node:worker_threads'
import type { analyzeNotebookCodeRisk, NotebookCodeRisk } from '@aipoch/notebook-code-risk'
import type {
  AnalyzeNotebookSource,
  analyzeNotebookSourceFileAccess
} from '@aipoch/notebook-analysis'
import createWorker from './source-analysis-worker-entry?nodeWorker'
import { runSourceAnalysis, type SourceAnalysisRequest } from './source-analysis-request'
import { createLogger, diagnosticErrorFields } from '@aipoch/diagnostics/node'

const log = createLogger('notebook:source-analysis')

type CodeRiskArguments = Parameters<typeof analyzeNotebookCodeRisk>
type FileAccessArguments = Parameters<typeof analyzeNotebookSourceFileAccess>

// Syntax-tree walks are synchronous inside each parse. Below this size they finish within a few
// tens of milliseconds, so they stay on the event loop and avoid the worker's startup and memory.
export const SOURCE_ANALYSIS_WORKER_MIN_BYTES = 32 * 1024
const WORKER_IDLE_MS = 30_000
const WORKER_TIMEOUT_MS = 60_000

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void }

let worker: Worker | undefined
let nextId = 0
const pending = new Map<number, Pending>()
let idleTimer: ReturnType<typeof setTimeout> | undefined

const discardWorker = (failed: Worker, error: Error): void => {
  if (worker === failed) worker = undefined
  for (const [id, request] of pending) {
    pending.delete(id)
    request.reject(error)
  }
  void failed.terminate()
}

const residentWorker = (): Worker => {
  if (worker) return worker
  const created = createWorker({ execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 512 } })
  created.on(
    'message',
    ({ id, result, error }: { id: number; result?: unknown; error?: string }) => {
      const request = pending.get(id)
      if (!request) return
      pending.delete(id)
      if (error === undefined) request.resolve(result)
      else request.reject(new Error(error))
    }
  )
  created.once('error', (error) => discardWorker(created, error))
  created.once('exit', () => discardWorker(created, new Error('Source analysis worker stopped.')))
  worker = created
  return created
}

const runInWorker = <Result>(request: SourceAnalysisRequest): Promise<Result> => {
  clearTimeout(idleTimer)
  const active = residentWorker()
  active.ref()
  const id = ++nextId
  return new Promise<Result>((resolve, reject) => {
    const timeout = setTimeout(
      () => discardWorker(active, new Error('Source analysis worker timed out.')),
      WORKER_TIMEOUT_MS
    )
    timeout.unref()
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timeout)
        resolve(value as Result)
      },
      reject: (error) => {
        clearTimeout(timeout)
        reject(error)
      }
    })
    active.postMessage({ id, request })
  }).finally(() => {
    if (worker !== active || pending.size > 0) return
    active.unref()
    idleTimer = setTimeout(() => {
      if (worker === active && pending.size === 0) {
        worker = undefined
        void active.terminate()
      }
    }, WORKER_IDLE_MS)
    idleTimer.unref()
  })
}

const offloaded = (request: SourceAnalysisRequest): boolean =>
  Buffer.byteLength(request.source) >= SOURCE_ANALYSIS_WORKER_MIN_BYTES

// A worker failure never changes the decision: the same analysis runs in-process instead.
const analyze = async <Result>(
  request: SourceAnalysisRequest,
  signal?: AbortSignal
): Promise<Result> => {
  if (offloaded(request)) {
    try {
      return await runInWorker<Result>(request)
    } catch (error) {
      log.warn('source analysis worker unavailable; analyzing in-process', {
        kind: request.kind,
        language: request.language,
        sourceBytes: Buffer.byteLength(request.source),
        ...diagnosticErrorFields(error)
      })
    }
  }
  return (await runSourceAnalysis(request, signal)) as Result
}

export const analyzeNotebookCodeRiskOffMainThread = async (
  ...[language, source, context, previousSources, signal]: CodeRiskArguments
): Promise<NotebookCodeRisk[]> => {
  signal?.throwIfAborted()
  const risks = await analyze<NotebookCodeRisk[]>(
    {
      kind: 'code-risk',
      language,
      source,
      ...(context ? { context } : {}),
      ...(previousSources ? { previousSources } : {})
    },
    signal
  )
  signal?.throwIfAborted()
  return risks
}

export const analyzeNotebookSourceOffMainThread: AnalyzeNotebookSource = (
  language,
  source,
  context
) => analyze({ kind: 'dependencies', language, source, context })

export const analyzeNotebookSourceFileAccessOffMainThread = (
  ...[language, source, context]: FileAccessArguments
): ReturnType<typeof analyzeNotebookSourceFileAccess> =>
  analyze({ kind: 'file-access', language, source, ...(context ? { context } : {}) })
