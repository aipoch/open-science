import { constants } from 'node:fs'
import { copyFile, link, lstat, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Worker, WorkerOptions } from 'node:worker_threads'
import type {
  SessionDiagnosticExportRequest,
  SessionDiagnosticExportResult,
  SessionDiagnosticInspection,
  SessionDiagnosticRequest,
  SessionDiagnosticWorkerInput,
  SessionDiagnosticWorkerResult
} from '../../shared/session-diagnostics'

type Sources = Pick<
  SessionDiagnosticWorkerInput,
  'dataRoot' | 'configRoot' | 'logPath' | 'appVersion'
>
type Options = {
  createWorker: (options: WorkerOptions) => Worker
  resolveSources: () => Sources
  chooseDestination: (defaultName: string) => Promise<string | undefined>
  temporaryRoot?: string
  timeoutMs?: number
}
type Operation = { controller: AbortController; settled: Promise<void>; finish: () => void }
export type SessionDiagnosticsDesktop = {
  inspect(request: SessionDiagnosticRequest): Promise<SessionDiagnosticInspection>
  export(request: SessionDiagnosticExportRequest): Promise<SessionDiagnosticExportResult>
  cancel(request: { operationId: string }): Promise<void>
  close(): Promise<void>
}

const within = (root: string, path: string): boolean => {
  const part = relative(root, path)
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`))
}
const safeId = (id: unknown): id is string =>
  typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(id)
const validRequest = (request: SessionDiagnosticRequest): boolean =>
  Boolean(
    request && safeId(request.projectId) && safeId(request.sessionId) && safeId(request.operationId)
  )

// Only module-owned messages and recognized operating-system codes reach export reports.
// Error.message/stack may contain paths, credentials or user content; never copy them.
class DiagnosticError extends Error {}
const errorReport = (error: unknown): string => {
  if (error instanceof DiagnosticError) return error.message
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  const knownCodes = [
    'EACCES',
    'EPERM',
    'ENOENT',
    'ENOSPC',
    'EIO',
    'EROFS',
    'EEXIST',
    'EMFILE',
    'ENFILE',
    'EXDEV',
    'ENOTSUP',
    'EBUSY'
  ]
  return typeof code === 'string' && knownCodes.includes(code)
    ? `Diagnostic operation failed (${code}).`
    : 'Diagnostic operation failed; private error details omitted.'
}

/** Resolve existing ancestors too: a symlinked save directory must not bypass source protection. */
const canonical = async (path: string): Promise<string> => {
  const absolute = resolve(path)
  try {
    return await realpath(absolute)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const parent = dirname(absolute)
    if (parent === absolute) throw error
    return join(await canonical(parent), basename(absolute))
  }
}

const assertOutsideSources = async (path: string, sources: Sources): Promise<void> => {
  const destination = await canonical(path)
  const roots = [
    sources.dataRoot,
    sources.configRoot,
    ...(sources.logPath ? [dirname(sources.logPath)] : [])
  ]
  for (const root of roots) {
    if (within(await canonical(root), destination)) {
      throw new DiagnosticError('Choose a location outside application data and log folders.')
    }
  }
}

const assertNewDestination = async (path: string, sources: Sources): Promise<void> => {
  if (!isAbsolute(path) || !path.endsWith('.tar.gz'))
    throw new DiagnosticError('Choose a new .tar.gz file.')
  await assertOutsideSources(path, sources)
  const parent = await lstat(await realpath(dirname(path)))
  if (!parent.isDirectory()) throw new DiagnosticError('The export folder is unavailable.')
  try {
    await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  throw new DiagnosticError('The selected file already exists. Choose a new filename.')
}

const filename = ({ projectId, sessionId }: SessionDiagnosticRequest): string =>
  `${projectId}-${sessionId}-${new Date().toISOString().replace(/[-:]/g, '').replace('.', '')}.tar.gz`

const abortableDestination = async (
  destination: Promise<string | undefined>,
  signal: AbortSignal
): Promise<string | undefined> => {
  let detach = (): void => undefined
  try {
    return await Promise.race([
      destination,
      new Promise<never>((_resolve, reject) => {
        const abort = (): void => reject(new DiagnosticError('Diagnostic operation cancelled.'))
        signal.addEventListener('abort', abort, { once: true })
        detach = () => signal.removeEventListener('abort', abort)
        if (signal.aborted) abort()
      })
    ])
  } finally {
    detach()
  }
}

/** A task-local owner. No repository, runtime, logger queue or application write gate is involved. */
export const createSessionDiagnosticsDesktop = (options: Options): SessionDiagnosticsDesktop => {
  const operations = new Map<string, Operation>()
  const waiting = new Map<string, AbortController>()
  let closed = false

  const begin = async (request: SessionDiagnosticRequest): Promise<Operation> => {
    if (!validRequest(request)) throw new DiagnosticError('Invalid diagnostic request.')
    if (waiting.has(request.operationId) || operations.has(request.operationId))
      throw new DiagnosticError('Duplicate diagnostic operation.')
    const admission = new AbortController()
    waiting.set(request.operationId, admission)
    // React effect cleanup and immediate remount can arrive before worker termination finishes.
    // Wait only for already-cancelled work; a live export still keeps its admission slot.
    try {
      while (operations.size) {
        const active = [...operations.values()]
        if (active.some((operation) => !operation.controller.signal.aborted))
          throw new DiagnosticError('Another diagnostic operation is in progress.')
        await Promise.all(active.map((operation) => operation.settled))
      }
      admission.signal.throwIfAborted()
      if (closed) throw new DiagnosticError('Diagnostic export is unavailable.')
      let finish!: () => void
      const operation = {
        controller: new AbortController(),
        settled: new Promise<void>((resolve) => {
          finish = resolve
        }),
        finish: () => finish()
      }
      operations.set(request.operationId, operation)
      return operation
    } finally {
      waiting.delete(request.operationId)
    }
  }

  const runWorker = async (
    input: SessionDiagnosticWorkerInput,
    signal: AbortSignal
  ): Promise<SessionDiagnosticWorkerResult> => {
    signal.throwIfAborted()
    const worker = options.createWorker({
      workerData: input,
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 16 }
    })
    let detach = (): void => undefined
    try {
      return await new Promise((resolve, reject) => {
        const abort = (): void => reject(new DiagnosticError('Diagnostic operation cancelled.'))
        const exited = (): void =>
          reject(new DiagnosticError('Diagnostic worker stopped unexpectedly.'))
        const timeout = setTimeout(
          () => reject(new DiagnosticError('Diagnostic operation timed out.')),
          options.timeoutMs ?? (input.action === 'inspect' ? 15_000 : 60_000)
        )
        const message = (value: SessionDiagnosticWorkerResult): void => {
          if (value?.kind === 'inspection' || value?.kind === 'archive' || value?.kind === 'error')
            resolve(value)
          else reject(new DiagnosticError('Invalid diagnostic worker response.'))
        }
        signal.addEventListener('abort', abort, { once: true })
        worker.once('message', message)
        worker.once('error', reject)
        worker.once('exit', exited)
        detach = () => {
          clearTimeout(timeout)
          signal.removeEventListener('abort', abort)
          worker.off('message', message)
          worker.off('error', reject)
          worker.off('exit', exited)
        }
        if (signal.aborted) abort()
      })
    } finally {
      // Join before cleanup: worker termination does not run its finally handlers reliably.
      await worker.terminate().catch(() => undefined)
      detach()
    }
  }

  const execute = async (
    action: 'inspect' | 'export',
    request: SessionDiagnosticExportRequest | SessionDiagnosticRequest
  ): Promise<SessionDiagnosticInspection | SessionDiagnosticExportResult> => {
    let operation: Operation | undefined
    let sources: Sources | undefined
    let directory: string | undefined
    let publicationDirectory: string | undefined
    let report = ''
    let cleanupFailed = false
    let stage = 'admission'
    let result: SessionDiagnosticInspection | SessionDiagnosticExportResult
    try {
      operation = await begin(request)
      const signal = operation.controller.signal
      sources = options.resolveSources()
      let target: string | undefined
      if (action === 'export') {
        const selected = (request as SessionDiagnosticExportRequest).selectedItems
        if (
          !Array.isArray(selected) ||
          selected.length > 100 ||
          selected.some((id) => typeof id !== 'string' || id.length > 240)
        ) {
          throw new DiagnosticError('Invalid diagnostic selection.')
        }
        stage = 'destination selection'
        target = await abortableDestination(options.chooseDestination(filename(request)), signal)
        signal.throwIfAborted()
        if (!target) return { status: 'cancelled' }
        await assertNewDestination(target, sources)
      }
      const temporaryRoot = options.temporaryRoot ?? tmpdir()
      await assertOutsideSources(temporaryRoot, sources)
      signal.throwIfAborted()
      if (action === 'export')
        directory = await mkdtemp(join(temporaryRoot, 'open-science-diagnostics-'))
      stage = 'collection'
      const workerResult = await runWorker(
        {
          ...sources,
          projectId: request.projectId,
          sessionId: request.sessionId,
          action,
          directory,
          ...(action === 'export'
            ? { selectedItems: (request as SessionDiagnosticExportRequest).selectedItems }
            : {})
        },
        signal
      )
      signal.throwIfAborted()
      if (workerResult.kind === 'error') {
        report = workerResult.report.slice(0, 128_000)
        throw new DiagnosticError('Diagnostic collection failed; private error details omitted.')
      }
      if (action === 'inspect' && workerResult.kind === 'inspection') {
        result = workerResult.inspection
      } else if (action === 'export' && workerResult.kind === 'archive' && target && directory) {
        report = workerResult.report.slice(0, 128_000)
        stage = 'publication'
        await assertNewDestination(target, sources)
        signal.throwIfAborted()
        // Stage on the destination filesystem, then publish a completed file atomically and
        // exclusively. A racing existing destination is never overwritten, including symlinks.
        publicationDirectory = await mkdtemp(join(dirname(target), '.open-science-diagnostics-'))
        const staged = join(publicationDirectory, 'archive.tar.gz')
        await copyFile(join(directory, 'archive.tar.gz'), staged, constants.COPYFILE_EXCL)
        await assertNewDestination(target, sources)
        signal.throwIfAborted()
        await link(staged, target)
        result = { status: workerResult.partial ? 'partial' : 'exported', path: target }
      } else {
        throw new DiagnosticError('Unexpected diagnostic worker result.')
      }
    } catch (error) {
      const cancelled = operation?.controller.signal.aborted
      const message = errorReport(error)
      if (action === 'inspect') result = { items: [], error: cancelled ? undefined : message }
      else {
        report = `${report}\n${new Date().toISOString()} ${stage} ${cancelled ? 'cancelled' : 'failed'}: ${message}\n`
        result = cancelled ? { status: 'cancelled' } : { status: 'failed', error: message, report }
      }
    } finally {
      // Remove only this operation’s export staging; a sanitized failure report is optional.
      for (const [stage, temporary] of [
        ['collection staging', directory],
        ['publication staging', publicationDirectory]
      ] as const) {
        if (!temporary) continue
        try {
          await rm(temporary, { recursive: true, force: true })
        } catch (error) {
          cleanupFailed = true
          report += `\n${new Date().toISOString()} ${stage} cleanup failed: ${errorReport(error)}\n`
        }
      }
      if (operation) {
        operations.delete(request.operationId)
        operation.finish()
      }
    }
    if (cleanupFailed) {
      result.error = 'Temporary diagnostic files could not be fully removed.'
      if ('status' in result && result.status === 'exported') result.status = 'partial'
    }
    if ('status' in result && (result.status === 'failed' || cleanupFailed)) {
      result.report = report
      let reportFolder: string | undefined
      try {
        const root = options.temporaryRoot ?? tmpdir()
        if (sources) await assertOutsideSources(root, sources)
        reportFolder = await mkdtemp(join(root, 'open-science-diagnostic-report-'))
        const path = join(reportFolder, 'export.log')
        await writeFile(path, report, { flag: 'wx', mode: 0o600 })
        result.reportPath = path
      } catch {
        // The copyable report is still returned when every disk write is unavailable.
        if (reportFolder)
          await rm(reportFolder, { recursive: true, force: true }).catch(() => undefined)
      }
    }
    return result
  }

  return {
    inspect: (request: SessionDiagnosticRequest): Promise<SessionDiagnosticInspection> =>
      execute('inspect', request) as Promise<SessionDiagnosticInspection>,
    export: (request: SessionDiagnosticExportRequest): Promise<SessionDiagnosticExportResult> =>
      execute('export', request) as Promise<SessionDiagnosticExportResult>,
    cancel: async ({ operationId }: { operationId: string }): Promise<void> => {
      waiting.get(operationId)?.abort()
      const operation = operations.get(operationId)
      operation?.controller.abort()
      await operation?.settled
    },
    close: async (): Promise<void> => {
      closed = true
      for (const admission of waiting.values()) admission.abort()
      const active = [...operations.values()]
      for (const operation of active) operation.controller.abort()
      await Promise.all(active.map((operation) => operation.settled))
    }
  }
}
