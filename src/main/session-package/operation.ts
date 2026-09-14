import { randomUUID } from 'node:crypto'
import { createLogger } from '../logger'
import {
  startDiagnosticOperation,
  type DiagnosticOperation,
  type DiagnosticFields
} from '../diagnostics/operation'
import {
  PACKAGE_DEFAULT_IO_BYTES_PER_SECOND,
  PACKAGE_MAX_FILE_BYTES,
  formatPackageBytes
} from '../../shared/session-package'
import type {
  PackageOperationRequest,
  PackageOperationSnapshot,
  PackageProgress,
  PackageSelectableFile,
  PackageSelectionSummary,
  SessionPackageRequest,
  SessionPackageImportRequest
} from '../../shared/session-package'

// One native package operation owns cancellation and presentation, independently of renderer lifetime.
export class SessionPackageOperation {
  private diagnostic?: DiagnosticOperation
  private diagnosticSnapshot?: Pick<
    PackageOperationSnapshot,
    'state' | 'progress' | 'cleanupPending'
  >
  private current?: PackageOperationSnapshot
  private controller?: AbortController
  private importResponse?: (target?: SessionPackageImportRequest) => void
  private pendingImports: NonNullable<PackageOperationSnapshot['pendingImports']> = []
  private importQueueFull = false
  private selection?: (keys: readonly string[]) => void
  private lastProgressAt = 0
  private completion: Promise<unknown> = Promise.resolve()
  async close(): Promise<void> {
    this.cancel()
    await this.completion
  }
  constructor(
    private readonly changed: (snapshot: PackageOperationSnapshot) => void = () => undefined
  ) {}

  get snapshot(): PackageOperationSnapshot | null {
    return this.current
      ? structuredClone({
          ...this.current,
          pendingImports: this.pendingImports,
          importQueueFull: this.importQueueFull
        })
      : null
  }
  get active(): boolean {
    return this.controller !== undefined
  }

  get transferBytesPerSecond(): number {
    return this.current?.transferBytesPerSecond ?? PACKAGE_DEFAULT_IO_BYTES_PER_SECOND
  }

  reportIo = (ioBytesPerSecond: number): void => {
    if (!this.current || !this.controller) return
    this.current = { ...this.current, ioBytesPerSecond }
    if (Date.now() - this.lastProgressAt >= 150) {
      this.lastProgressAt = Date.now()
      this.publish()
    }
  }

  private publish(): void {
    this.observeDiagnostics()
    // Presentation delivery cannot change the result or ownership of a durable operation.
    try {
      if (this.current) this.changed(this.snapshot!)
    } catch {
      /* snapshot remains queryable */
    }
  }
  report = (progress: PackageProgress): void => {
    if (!this.current || !this.controller) return
    const phaseChanged = progress.phase !== this.current.progress.phase
    this.current = { ...this.current, progress }
    this.observeDiagnostics()
    if (phaseChanged || Date.now() - this.lastProgressAt >= 150) {
      this.lastProgressAt = Date.now()
      this.publish()
    }
  }

  private observeDiagnostics(): void {
    if (!this.diagnostic || !this.current) return
    const { state, progress, cleanupPending } = this.current
    const previous = this.diagnosticSnapshot
    if (
      !previous ||
      previous.state !== state ||
      previous.progress.phase !== progress.phase ||
      previous.cleanupPending !== cleanupPending
    ) {
      this.diagnostic.phase(progress.phase, {
        ...this.diagnosticFields(),
        previousPhase: previous?.progress.phase,
        previousCompletedBytes: previous?.progress.completedBytes,
        previousTotalBytes: previous?.progress.totalBytes,
        previousCompletedFiles: previous?.progress.completedFiles,
        previousTotalFiles: previous?.progress.totalFiles
      })
    }
    // Keep the latest counters without writing every buffer or UI progress update to disk.
    this.diagnosticSnapshot = { state, progress, cleanupPending }
  }

  private diagnosticFields(): DiagnosticFields {
    const current = this.current!
    return {
      state: current.state,
      cleanupPending: Boolean(current.cleanupPending),
      completedBytes: current.progress.completedBytes,
      totalBytes: current.progress.totalBytes,
      completedFiles: current.progress.completedFiles,
      totalFiles: current.progress.totalFiles
    }
  }

  present(): void {
    if (!this.current) return
    this.current = {
      ...this.current,
      presentationRevision: (this.current.presentationRevision ?? 0) + 1
    }
    this.publish()
  }

  setPendingImports(
    files: NonNullable<PackageOperationSnapshot['pendingImports']>,
    full = this.importQueueFull
  ): void {
    const previousPendingCount = this.pendingImports.length
    const changed = files.length !== previousPendingCount || full !== this.importQueueFull
    this.pendingImports = files
    this.importQueueFull = full
    if (changed) {
      try {
        createLogger('session-package').info('Package import queue changed', {
          pendingCount: files.length,
          previousPendingCount,
          full
        })
      } catch {
        // Diagnostics must not suppress queue delivery or alter import ownership.
      }
    }
    this.publish()
  }

  setImportSource(requestId: string, filename: string, target: SessionPackageImportRequest): void {
    if (!this.controller || this.current?.kind !== 'import')
      throw new Error('No active import operation.')
    this.current = {
      ...this.current,
      importRequestId: requestId,
      importFilename: filename,
      importTarget: { ...target }
    }
    this.publish()
  }

  waitForImport = (
    input: {
      requestId?: string
      filename?: string
      preview?: PackageOperationSnapshot['importPreview']
    },
    budgetSignal?: AbortSignal
  ): Promise<SessionPackageImportRequest | undefined> => {
    if (!this.controller || !this.current || this.current.kind !== 'import')
      throw new Error('No active import operation.')
    const signal = AbortSignal.any([
      this.controller.signal,
      ...(budgetSignal ? [budgetSignal] : [])
    ])
    signal.throwIfAborted()
    const pending = new Promise<SessionPackageImportRequest | undefined>((resolve, reject) => {
      const abort = (): void => {
        this.importResponse = undefined
        reject(signal.reason)
      }
      signal.addEventListener('abort', abort, { once: true })
      this.importResponse = (target) => {
        signal.removeEventListener('abort', abort)
        this.importResponse = undefined
        resolve(target)
      }
    })
    this.current = {
      ...this.current,
      importRequestId: input.requestId ?? this.current.importRequestId,
      importFilename: input.filename ?? this.current.importFilename,
      importPreview: input.preview,
      state: 'awaiting-selection',
      progress: { phase: input.preview ? 'confirming' : 'selecting' }
    }
    this.publish()
    return pending
  }

  selectFiles = (
    files: PackageSelectableFile[],
    budgetSignal?: AbortSignal,
    summary?: PackageSelectionSummary
  ): Promise<readonly string[]> => {
    const signal =
      this.controller &&
      AbortSignal.any([this.controller.signal, ...(budgetSignal ? [budgetSignal] : [])])
    if (!signal || !this.current) throw new Error('No active package operation.')
    signal.throwIfAborted()
    const selected = new Promise<readonly string[]>((resolve, reject) => {
      const abort = (): void => {
        this.selection = undefined
        reject(signal.reason)
      }
      signal.addEventListener('abort', abort, { once: true })
      this.selection = (keys) => {
        signal.removeEventListener('abort', abort)
        this.selection = undefined
        resolve(keys)
      }
    })
    this.current = {
      ...this.current,
      state: 'awaiting-selection',
      files,
      summary,
      progress: { phase: 'selecting' }
    }
    this.publish()
    return selected
  }

  respond(request: PackageOperationRequest): PackageOperationSnapshot | null {
    if (request.action === 'snapshot') return this.snapshot
    if (
      [
        'reveal',
        'retry-cleanup',
        'discard-import',
        'next-import',
        'retry-import',
        'dismiss-queue-warning'
      ].includes(request.action)
    )
      throw new Error('This action must be handled by the desktop owner.')
    if (!this.current || request.operationId !== this.current.id || !this.controller)
      throw new Error('The package operation is no longer active.')
    if (request.action === 'set-speed') {
      if (
        !Number.isInteger(request.bytesPerSecond) ||
        request.bytesPerSecond < 1024 ** 2 ||
        request.bytesPerSecond > 64 * 1024 ** 2
      )
        throw new Error('Invalid package transfer rate.')
      this.current = { ...this.current, transferBytesPerSecond: request.bytesPerSecond }
      this.publish()
    } else if (request.action === 'cancel') {
      this.current = { ...this.current, state: 'cancelling' }
      this.publish()
      this.controller.abort(new Error('Package operation cancelled.'))
    } else if (request.action === 'select-project' || request.action === 'confirm-import') {
      if (
        this.current.kind !== 'import' ||
        this.current.state !== 'awaiting-selection' ||
        !this.importResponse ||
        (request.action === 'confirm-import') !== Boolean(this.current.importPreview)
      )
        throw new Error('The import choice is no longer available.')
      this.current = {
        ...this.current,
        state: 'running',
        importPreview: undefined,
        importTarget:
          request.action === 'select-project' ? request.target : this.current.importTarget
      }
      this.importResponse(request.action === 'select-project' ? request.target : undefined)
      this.publish()
    } else if (request.action === 'select') {
      if (this.current.state !== 'awaiting-selection' || !this.selection)
        throw new Error('The package selection is no longer available.')
      const keys = new Set(request.excludedStorageKeys)
      const files = this.current.files ?? []
      if (
        keys.size !== request.excludedStorageKeys.length ||
        [...keys].some((key) => !files.some((file) => file.storageKey === key))
      )
        throw new Error('Invalid package selection.')
      if (
        files.some((file) => file.sizeBytes > PACKAGE_MAX_FILE_BYTES && !keys.has(file.storageKey))
      )
        throw new Error(
          `Exclude files larger than ${formatPackageBytes(PACKAGE_MAX_FILE_BYTES)} before exporting.`
        )
      if (files.some((file) => file.requiredForEvidence && keys.has(file.storageKey)))
        throw new Error('Invalid package selection.')
      this.current = { ...this.current, state: 'running', files: undefined, summary: undefined }
      this.selection([...keys])
      this.publish()
    }
    return this.snapshot
  }

  setCleanupPending(pending: boolean): void {
    if (!this.current) return
    this.current = { ...this.current, cleanupPending: pending }
    this.publish()
  }

  async retryCleanup(
    work: (signal: AbortSignal) => Promise<void>
  ): Promise<PackageOperationSnapshot | null> {
    if (!this.current?.cleanupPending || this.controller)
      throw new Error('Package cleanup is not available.')
    const previous = this.current
    this.controller = new AbortController()
    this.diagnostic = startDiagnosticOperation(createLogger('session-package'), {
      operation: 'session-package.cleanup',
      operationId: previous.id,
      fields: { kind: previous.kind, transferOutcome: previous.state }
    })
    let settled!: () => void
    this.completion = new Promise<void>((resolve) => {
      settled = resolve
    })
    this.current = { ...previous, state: 'running', progress: { phase: 'cleaning' } }
    this.publish()
    try {
      await work(this.controller.signal)
      this.diagnostic.complete({ cleanupPending: false })
      this.current = { ...previous, cleanupPending: false }
    } catch (error) {
      if (this.controller.signal.aborted) this.diagnostic.cancel({ cleanupPending: true })
      else this.diagnostic.fail(error, { cleanupPending: true })
      this.current = previous
      throw error
    } finally {
      this.diagnostic = undefined
      this.diagnosticSnapshot = undefined
      this.controller = undefined
      this.publish()
      settled()
    }
    return this.snapshot
  }

  completeResult(result: NonNullable<PackageOperationSnapshot['result']>): void {
    if (this.current && this.controller) this.current = { ...this.current, result }
  }

  cancel(): void {
    if (this.current && this.controller)
      this.respond({ action: 'cancel', operationId: this.current.id })
  }

  async run<T>(
    kind: 'export' | 'import',
    session: SessionPackageRequest | undefined,
    work: (signal: AbortSignal) => Promise<T>,
    importTarget?: PackageOperationSnapshot['importTarget']
  ): Promise<T> {
    if (this.controller) throw new Error('A Session package operation is already in progress.')
    const controller = new AbortController()
    this.controller = controller
    this.current = {
      id: randomUUID(),
      kind,
      session,
      importTarget,
      state: 'running',
      progress: { phase: 'preparing' }
    }
    this.diagnostic = startDiagnosticOperation(createLogger('session-package'), {
      operation: `session-package.${kind}`,
      operationId: this.current.id
    })
    this.publish()
    let settled!: () => void
    this.completion = new Promise<void>((resolve) => {
      settled = resolve
    })
    try {
      const result = await work(controller.signal)
      this.current = {
        ...this.current!,
        state: 'succeeded',
        files: undefined,
        summary: undefined,
        importPreview: undefined
      }
      this.diagnostic.complete(this.diagnosticFields())
      return result
    } catch (error) {
      this.current = {
        ...this.current!,
        state: controller.signal.aborted ? 'cancelled' : 'failed',
        files: undefined,
        summary: undefined,
        importPreview: undefined,
        error: controller.signal.aborted
          ? undefined
          : error instanceof Error
            ? error.message
            : String(error)
      }
      if (controller.signal.aborted) this.diagnostic.cancel(this.diagnosticFields())
      else this.diagnostic.fail(error, this.diagnosticFields())
      throw error
    } finally {
      this.diagnostic = undefined
      this.diagnosticSnapshot = undefined
      this.selection = undefined
      this.importResponse = undefined
      this.controller = undefined
      this.publish()
      settled()
    }
  }
}
