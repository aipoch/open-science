import { formatPackageBytes } from '../../shared/session-package'
import { randomUUID } from 'node:crypto'
import { dialog, shell, type BrowserWindow } from 'electron'
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join } from 'node:path'
import type {
  SessionPackageExportResult,
  SessionPackageImportResult,
  SessionPackageRequest
} from '../../shared/session-package'
import { sanitizeExportFilename } from '../../shared/conversation-export'
import type { NativeTranslator } from '../locale/main-process-messages'
import { publishUserFile } from '../user-file-publisher'
import { PACKAGE_MAX_BYTES } from '../../shared/session-package'
import type { SessionPackageService } from './service'
import { createLogger, diagnosticErrorFields } from '../logger'
import { copyFileWithinBudget } from '../bounded-file-io'
import { SessionPackageOperation } from './operation'
import { PackageCleanupPendingError, withPackageCleanup } from './cleanup'
import { assertPackageCapacity, PackageCapacityError } from './capacity'
import { withPackageTransfer } from './transfer'
import type {
  PackageOperationSnapshot,
  PackageOperationRequest
} from '../../shared/session-package'

type NativeImportFile = {
  id: string
  path: string
  filename: string
  target?: import('../../shared/session-package').SessionPackageImportRequest
  originClientId?: string
}
class PackageSourceUnavailableError extends Error {}

// Native pickers and the preload File bridge supply filesystem paths. A private archive freezes
// the bytes reviewed in the confirmation before import or external save.
export class SessionPackageDesktop {
  readonly operations: SessionPackageOperation
  private pendingFiles: NativeImportFile[] = []
  private activeFile?: NativeImportFile
  private lastImportFile?: NativeImportFile
  private enqueueing: Promise<void> = Promise.resolve()
  private busy = false
  private readonly pendingCleanup = new Set<() => Promise<void>>()
  private readonly shutdown = new AbortController()
  private operation: Promise<unknown> = Promise.resolve()
  constructor(
    private readonly options: {
      service: SessionPackageService
      translate: NativeTranslator
      withDataRootWrite: <T>(work: () => Promise<T>) => Promise<T>
      afterImport: (
        identity: SessionPackageRequest,
        originClientId: string | undefined,
        projectCreated: boolean
      ) => Promise<void>
      reserveExport?: (identity: SessionPackageRequest, signal: AbortSignal) => Promise<() => void>
      reserveImport?: (projectId: string, signal: AbortSignal) => Promise<() => void>
      onOperationChanged?: (snapshot: PackageOperationSnapshot) => void
      assertCanStart?: () => void
    }
  ) {
    this.operations = new SessionPackageOperation((snapshot) => {
      options.onOperationChanged?.(snapshot)
      // Defer until run() has completed ownership release and any active file has settled.
      if (!this.operations.active) queueMicrotask(() => this.pumpOpenFiles())
    })
  }

  reportOpenOverflow(): void {
    this.operations.setPendingImports(
      this.pendingFiles.map(({ id, filename }) => ({ id, filename })),
      true
    )
  }

  enqueueFile(path: string): void {
    this.enqueueing = this.enqueueing
      .then(async () => {
        if (this.shutdown.signal.aborted) return
        const canonical = await realpath(path).catch(() => path)
        if (this.shutdown.signal.aborted) return
        if (
          this.activeFile?.path === canonical ||
          this.pendingFiles.some((file) => file.path === canonical)
        ) {
          this.operations.setPendingImports(
            this.pendingFiles.map(({ id, filename }) => ({ id, filename }))
          )
          this.operations.present()
          return
        }
        if (this.pendingFiles.length >= 16) {
          this.operations.setPendingImports(
            this.pendingFiles.map(({ id, filename }) => ({ id, filename })),
            true
          )
          return
        }
        const startImmediately = this.pendingFiles.length === 0 && !this.operations.active
        this.pendingFiles.push({ id: randomUUID(), path: canonical, filename: basename(path) })
        this.operations.setPendingImports(
          this.pendingFiles.map(({ id, filename }) => ({ id, filename }))
        )
        this.pumpOpenFiles(startImmediately)
        this.operations.present()
      })
      .catch((error) =>
        createLogger('session-package').warn(
          'Could not receive package file',
          diagnosticErrorFields(error)
        )
      )
  }

  private pumpOpenFiles(force = false): void {
    if (
      this.shutdown.signal.aborted ||
      this.activeFile ||
      this.operations.active ||
      !this.pendingFiles.length ||
      this.operations.snapshot?.cleanupPending ||
      (!force && ['failed', 'succeeded'].includes(this.operations.snapshot?.state ?? ''))
    )
      return
    const file = this.pendingFiles.shift()!
    this.activeFile = file
    this.operations.setPendingImports(
      this.pendingFiles.map(({ id, filename }) => ({ id, filename }))
    )
    void this.import(undefined, file.originClientId, file.target ?? {}, file.path)
      .catch(() => undefined)
      .finally(() => {
        this.activeFile = undefined
        this.pumpOpenFiles()
      })
  }

  respond(
    request: PackageOperationRequest
  ): PackageOperationSnapshot | null | Promise<PackageOperationSnapshot | null> {
    if (
      request.action === 'dismiss-queue-warning' ||
      request.action === 'discard-import' ||
      request.action === 'next-import' ||
      request.action === 'retry-import'
    ) {
      if (request.operationId !== this.operations.snapshot?.id)
        throw new Error('The package operation is no longer active.')
      if (request.action === 'dismiss-queue-warning') {
        this.operations.setPendingImports(
          this.pendingFiles.map(({ id, filename }) => ({ id, filename })),
          false
        )
      } else if (request.action === 'discard-import') {
        this.pendingFiles = this.pendingFiles.filter((file) => file.id !== request.requestId)
        this.operations.setPendingImports(
          this.pendingFiles.map(({ id, filename }) => ({ id, filename }))
        )
      } else {
        if (this.activeFile || this.operations.active || this.operations.snapshot?.cleanupPending)
          throw new Error('Wait for the current package operation to finish.')
        if (request.action === 'retry-import') {
          if (
            !this.lastImportFile ||
            this.operations.snapshot?.importRequestId !== this.lastImportFile.id
          )
            throw new Error('No opened package is available.')
          this.pendingFiles = this.pendingFiles.filter(
            (file) => file.path !== this.lastImportFile!.path
          )
          this.pendingFiles.unshift(this.lastImportFile)
        }
        this.pumpOpenFiles(true)
      }
      return this.operations.snapshot
    }
    if (request.action === 'retry-cleanup') {
      this.shutdown.signal.throwIfAborted()
      if (this.operations.snapshot?.id !== request.operationId)
        throw new Error('The package operation is no longer active.')
      return this.operations.retryCleanup(async (signal) => {
        await this.options.withDataRootWrite(async () => {
          const errors: unknown[] = []
          for (const cleanup of this.pendingCleanup) {
            signal.throwIfAborted()
            try {
              await cleanup()
              this.pendingCleanup.delete(cleanup)
            } catch (error) {
              errors.push(error)
            }
          }
          if (errors.length)
            throw new AggregateError(
              errors,
              this.options.translate('Temporary files could not be removed. Try cleanup again.')
            )
        })
      })
    }
    if (request.action !== 'reveal') return this.operations.respond(request)
    const snapshot = this.operations.snapshot
    if (
      snapshot?.id !== request.operationId ||
      snapshot.state !== 'succeeded' ||
      !snapshot.result?.filePath
    )
      throw new Error('No completed export is available.')
    shell.showItemInFolder(snapshot.result.filePath)
    return snapshot
  }

  hasActiveTransfer(): boolean {
    const snapshot = this.operations.snapshot
    return (
      this.operations.active &&
      !(
        snapshot?.kind === 'import' &&
        snapshot.state === 'awaiting-selection' &&
        snapshot.progress.phase === 'selecting'
      )
    )
  }

  async close(): Promise<void> {
    this.pendingFiles = []
    this.lastImportFile = undefined
    this.operations.cancel()
    this.shutdown.abort(new Error('Session package desktop is closed.'))
    await this.operations.close()
    await this.operation
  }

  private async acceptCleanup<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work()
    } catch (error) {
      if (!(error instanceof PackageCleanupPendingError)) throw error
      this.pendingCleanup.add(error.retryCleanup)
      this.operations.setCleanupPending(true)
      createLogger('session-package').warn(
        'Session package temporary cleanup pending',
        diagnosticErrorFields(error)
      )
      if ('error' in error.outcome) throw error.outcome.error
      // This private error preserves the result type of the supplied work.
      return error.outcome.value as T
    }
  }

  private async copyArchive(
    source: string,
    destination: string,
    phase: 'copying' | 'saving',
    signal: AbortSignal
  ): Promise<void> {
    await withPackageTransfer(async (transfer) => {
      const size = (await stat(source)).size
      await assertPackageCapacity(dirname(destination), size)
      await copyFileWithinBudget(
        source,
        destination,
        PACKAGE_MAX_BYTES,
        AbortSignal.any([signal, transfer.signal]),
        (completedBytes) => this.operations.report({ phase, completedBytes, totalBytes: size })
      )
    })
  }

  private async nativeDialog<T>(pending: Promise<T>, operationSignal?: AbortSignal): Promise<T> {
    const signal = AbortSignal.any([
      this.shutdown.signal,
      ...(operationSignal ? [operationSignal] : [])
    ])
    signal.throwIfAborted()
    let onAbort = (): void => undefined
    try {
      return await withPackageTransfer((transfer) =>
        transfer.waitForUser(() =>
          Promise.race([
            pending,
            new Promise<never>((_resolve, reject) => {
              onAbort = () => reject(signal.reason)
              signal.addEventListener('abort', onAbort, { once: true })
            })
          ])
        )
      )
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  private staged<T>(work: (directory: string) => Promise<T>): Promise<T> {
    if (this.shutdown.signal.aborted) return Promise.reject(this.shutdown.signal.reason)
    if (this.busy)
      return Promise.reject(new Error('A Session package operation is already in progress.'))
    const result = withPackageTransfer(
      () => this.stagedNow(work),
      () => this.operations.transferBytesPerSecond,
      this.operations.reportIo
    )
    this.operation = result.catch(() => undefined)
    return result
  }

  private async stagedNow<T>(work: (directory: string) => Promise<T>): Promise<T> {
    this.busy = true
    try {
      const directory = await mkdtemp(join(tmpdir(), 'open-science-package-dialog-'))
      return await this.acceptCleanup(() =>
        withPackageCleanup(
          async () => {
            this.shutdown.signal.throwIfAborted()
            return work(directory)
          },
          () => rm(directory, { recursive: true, force: true })
        )
      )
    } catch (error) {
      createLogger('session-package').warn(
        'Session package operation failed',
        diagnosticErrorFields(error)
      )
      const detail = error instanceof Error ? error.message : ''
      const translate = this.options.translate
      if (error instanceof PackageSourceUnavailableError)
        throw new Error(
          translate(
            'The original package is unavailable. It may have been moved, deleted, or become unreadable. Choose another package.'
          ),
          { cause: error }
        )
      if (error instanceof PackageCapacityError)
        throw new Error(
          translate(
            'Not enough disk space at {{path}}. The next stage needs at least {{required}} available, including reserved free space; {{available}} is available. Free up at least {{shortfall}}, then try again.',
            {
              path: error.directory,
              required: formatPackageBytes(error.requiredBytes),
              available: formatPackageBytes(error.freeBytes),
              shortfall: formatPackageBytes(error.requiredBytes - error.freeBytes)
            }
          ),
          { cause: error }
        )
      if (detail.startsWith('An excluded file also exists'))
        throw new Error(
          translate(
            'An excluded file also exists in retained research evidence. Include that file to export this Session.'
          ),
          { cause: error }
        )
      if (detail.includes('Sensitive content detected'))
        throw new Error(
          translate('Sensitive content detected. Remove it before exporting the Session package.'),
          { cause: error }
        )
      if (detail.startsWith('Wait for') || detail.includes('changed during export'))
        throw new Error(
          translate('Wait for all research activity to finish, then try exporting again.'),
          { cause: error }
        )
      throw new Error(
        translate(
          'Could not complete the Session package operation. Check the package and available disk space, then try again.'
        ),
        { cause: error }
      )
    } finally {
      this.busy = false
    }
  }

  export(
    request: SessionPackageRequest,
    parent?: BrowserWindow
  ): Promise<SessionPackageExportResult> {
    let operationSignal: AbortSignal | undefined
    return this.operations
      .run('export', request, async (signal) => {
        operationSignal = signal
        this.options.assertCanStart?.()
        this.operations.setCleanupPending(this.pendingCleanup.size > 0)
        const release = await this.options.reserveExport?.(request, signal)
        try {
          return await this.staged(async (directory) => {
            const archive = join(directory, 'session.science')
            let filePath: string | undefined
            await this.options.withDataRootWrite(() =>
              this.acceptCleanup(() =>
                this.options.service.exportTo(request, archive, {
                  signal,
                  onProgress: this.operations.report,
                  selectFiles: async (files, budgetSignal, summary, title) => {
                    const excluded = await this.operations.selectFiles(files, budgetSignal, summary)
                    this.operations.report({ phase: 'choosing-location' })
                    signal.throwIfAborted()
                    const today = new Date()
                    const date = [
                      today.getFullYear(),
                      String(today.getMonth() + 1).padStart(2, '0'),
                      String(today.getDate()).padStart(2, '0')
                    ].join('-')
                    const options = {
                      title: this.options.translate('Export Session package'),
                      defaultPath: `${sanitizeExportFilename(title || 'Session', 220)}-${date}.science`,
                      filters: [{ name: 'Open Science Session', extensions: ['science'] }]
                    }
                    const selected = await this.nativeDialog(
                      parent
                        ? dialog.showSaveDialog(parent, options)
                        : dialog.showSaveDialog(options),
                      AbortSignal.any([signal, budgetSignal])
                    )
                    if (selected.canceled || !selected.filePath) {
                      this.operations.cancel()
                      signal.throwIfAborted()
                    }
                    filePath = selected.filePath
                    return excluded
                  }
                })
              )
            )
            signal.throwIfAborted()
            if (!filePath) throw new Error('No export destination was selected.')
            this.operations.report({ phase: 'saving' })
            await publishUserFile(
              filePath,
              (temporary) => this.copyArchive(archive, temporary, 'saving', signal),
              {
                validateDestination: async () => signal.throwIfAborted()
              }
            )
            this.operations.completeResult({ filePath })
            return { saved: true, filePath }
          })
        } finally {
          release?.()
        }
      })
      .catch((error) => {
        if (operationSignal?.aborted && !this.shutdown.signal.aborted) return { saved: false }
        throw error
      })
  }

  import(
    parent?: BrowserWindow,
    originClientId?: string,
    target: import('../../shared/session-package').SessionPackageImportRequest = {},
    sourcePath?: string
  ): Promise<SessionPackageImportResult> {
    let operationSignal: AbortSignal | undefined
    const rememberSource = (path: string): void => {
      const id = this.operations.snapshot?.importRequestId ?? this.activeFile?.id ?? randomUUID()
      this.lastImportFile = {
        id,
        path,
        filename: basename(path),
        target: { ...target },
        originClientId
      }
      this.operations.setImportSource(id, basename(path), target)
    }
    return this.operations
      .run(
        'import',
        undefined,
        async (signal) => {
          operationSignal = signal
          if (
            sourcePath &&
            (!isAbsolute(sourcePath) || extname(sourcePath).toLowerCase() !== '.science')
          )
            throw new Error('Invalid Session package path.')
          if (sourcePath) rememberSource(sourcePath)
          if (!sourcePath || target.projectId || target.projectName) this.options.assertCanStart?.()
          this.operations.setCleanupPending(this.pendingCleanup.size > 0)
          if (sourcePath && !target.projectId && !target.projectName) {
            const selectedTarget = await this.operations.waitForImport({
              requestId: this.operations.snapshot?.importRequestId,
              filename: basename(sourcePath)
            })
            target = selectedTarget!
            rememberSource(sourcePath)
            this.options.assertCanStart?.()
          }
          const release = target.projectId
            ? await this.options.reserveImport?.(target.projectId, signal)
            : undefined
          try {
            return await this.staged(async (directory) => {
              const options = {
                title: this.options.translate('Import Session package'),
                properties: ['openFile'] as ['openFile'],
                filters: [{ name: 'Open Science Session', extensions: ['science'] }]
              }
              const selected = sourcePath
                ? { canceled: false, filePaths: [sourcePath] }
                : await this.nativeDialog(
                    parent
                      ? dialog.showOpenDialog(parent, options)
                      : dialog.showOpenDialog(options),
                    signal
                  )
              if (selected.canceled || !selected.filePaths[0]) {
                this.operations.cancel()
                signal.throwIfAborted()
              }
              const input = selected.filePaths[0]
              rememberSource(input)
              const info = await stat(input).catch((error: NodeJS.ErrnoException) => {
                if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code ?? ''))
                  throw new PackageSourceUnavailableError('Package source is unavailable.', {
                    cause: error
                  })
                throw error
              })
              if (!info.isFile() || info.size > PACKAGE_MAX_BYTES)
                throw new Error('Session package exceeds the archive limit.')
              const archive = join(directory, 'session.science')
              await this.copyArchive(input, archive, 'copying', signal)
              this.operations.report({ phase: 'validating' })
              const result = await this.options.withDataRootWrite(() =>
                this.acceptCleanup(() =>
                  this.options.service.importFrom(
                    archive,
                    signal,
                    this.operations.report,
                    async (preview, budgetSignal) => {
                      await this.operations.waitForImport(
                        { preview, filename: basename(input) },
                        budgetSignal
                      )
                      signal.throwIfAborted()
                    },
                    target
                  )
                )
              )
              this.operations.completeResult({ imported: result })
              try {
                await this.options.afterImport(result, originClientId, !target.projectId)
              } catch (error) {
                createLogger('session-package').warn(
                  'Imported Session notification failed',
                  diagnosticErrorFields(error)
                )
              }
              return result
            })
          } finally {
            release?.()
          }
        },
        target
      )
      .catch((error) => {
        if (operationSignal?.aborted && !this.shutdown.signal.aborted) return null
        throw error
      })
  }
}
