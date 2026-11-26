import {
  ArchiveAvailabilityError,
  SessionExportBlockedError,
  sessionExportBlockerMessage
} from '../archive/availability-error'
import { downloadUseCase, UseCaseDownloadError } from './use-case-download'
import type { UseCaseSource } from '../../shared/use-cases'
import { desktopShellInteraction, desktopFileInteraction } from '../desktop-interaction'
import { ApplicationCommandError } from '../../shared/application-command-contract'
import { isInvalidPackageArchive, PACKAGE_REQUIRES_UPDATE } from './archive'
import {
  PackageSensitiveContentError,
  type PackageSensitiveContentSource
} from './sensitive-content'
import { ForkPendingApprovalError, ForkRecoveryRequiredError } from './fork-session'
import { NotebookExecutionAdmissionError } from '../notebook/execution-admission'
import { redactSensitiveText } from '@aipoch/diagnostics'
import { formatPackageBytes, packageImportPercent } from '../../shared/session-package'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, opendir, readdir, realpath, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join } from 'node:path'
import type {
  AgentPackageOperationReference,
  PackageFileDigest,
  SensitiveContentEvidence,
  SensitiveExportDecision,
  SessionPackageExportResult,
  SessionPackageImportResult,
  SessionPackageRequest,
  SessionPackageSummary
} from '../../shared/session-package'
import { sanitizeExportFilename } from '../../shared/conversation-export'
import type { NativeTranslator } from '../locale/main-process-messages'
import { publishUserFile } from '../user-file-publisher'
import { PACKAGE_MAX_BYTES } from '../../shared/session-package'
import { PackageImportRecoveryRequiredError, type SessionPackageService } from './service'
import { createLogger, diagnosticErrorFields } from '@aipoch/diagnostics/node'
import { copyFileWithinBudget, digestFileWithinBudget } from '../bounded-file-io'
import { PackageExportBlockedError, SessionPackageOperation } from './operation'
import { PackageCleanupPendingError, withPackageCleanup } from './cleanup'
import { assertPackageCapacity, PackageCapacityError, packageDiskReserveBytes } from './capacity'
import { withPackageTransfer } from './transfer'
import type { OrgCaseDetail, OrgCaseErrorCode, OrgCaseUploadMetadata } from '../../shared/org-cases'
import type { UploadOrgCaseInput } from '../settings/lab-api'
import { OrgCaseFailure } from './org-cases'
import type {
  PackageOperationSnapshot,
  PackageOperationRequest
} from '../../shared/session-package'

type OrgCaseUploader = (input: UploadOrgCaseInput, signal: AbortSignal) => Promise<OrgCaseDetail>

const formatExportArchiveFilename = (title: string): string => {
  const today = new Date()
  const date = [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, '0'),
    String(today.getDate()).padStart(2, '0')
  ].join('-')
  return `${sanitizeExportFilename(title || 'Session', 220)}-${date}.science`
}

const translateOrgCaseUploadError = (
  errorCode: OrgCaseErrorCode,
  translate: NativeTranslator
): string => {
  switch (errorCode) {
    case 'unconfigured':
    case 'signed-out':
      return translate('Sign in to Lab in Settings before uploading organization cases.')
    case 'expired':
      return translate('Your Lab session expired. Sign in again in Lab Settings and try again.')
    case 'storage-not-configured':
      return translate(
        'Object storage for organization case sharing is not configured on this Lab server.'
      )
    case 'storage-unavailable':
      return translate(
        'The organization case storage service could not be reached. Try again shortly.'
      )
    case 'license-inactive':
      return translate('Your Lab organization does not have an active license for uploading cases.')
    case 'seat-required':
      return translate('An assigned Lab seat is required before you can upload organization cases.')
    case 'org-inactive':
      return translate(
        'Your Lab organization is currently inactive. Contact your administrator before uploading.'
      )
    case 'account-disabled':
      return translate(
        'Your Lab account is disabled. Contact your Lab administrator before uploading.'
      )
    case 'no-organization':
      return translate('Join an organization in Lab before uploading shared cases.')
    case 'forbidden':
      return translate('Your Lab role does not have permission to upload organization cases.')
    case 'rate-limited':
      return translate('The Lab upload queue is busy. Wait a moment and try again.')
    case 'upload-in-progress':
      return translate(
        'This upload is still being processed by Lab. Wait a moment and check the organization case list before retrying.'
      )
    case 'package-too-large':
      return translate(
        'The Session package exceeds the maximum upload size allowed by your Lab server.'
      )
    case 'unsupported-package':
      return translate(
        'This Lab server rejected the package format as unsupported. Update your Lab server or check the package contents.'
      )
    case 'package-invalid':
      return translate(
        'Lab rejected the package or case details. Check the case name and package contents, then try again.'
      )
    case 'upload-timeout':
    case 'timeout':
      return translate(
        'Uploading the Session package to Lab timed out. Check your connection and try again.'
      )
    case 'network':
      return translate(
        'Could not connect to Lab. Check your network connection and Lab server address in Settings, then try again.'
      )
    case 'invalid-response':
      return translate('Lab returned an unexpected response while uploading the organization case.')
    case 'cancelled':
      return translate(
        'The upload was cancelled because your Lab session changed. Sign in and try again.'
      )
    default:
      return translate(
        'Could not upload the Session package to Lab. Check your connection and try again.'
      )
  }
}

type NativeImportFile = {
  id: string
  path: string
  filename: string
  target?: import('../../shared/session-package').SessionPackageImportRequest
  originClientId?: string
  onReleased?: () => void
  validateBeforeTarget?: boolean
  work?: Promise<void>
  recovery?: PackageImportRecoveryRequiredError
}
class PackageSourceUnavailableError extends Error {}
class SensitiveExportCandidateChangedError extends Error {}
const sensitiveReviewTimeoutMs = 10 * 60_000

// Exact application-owned messages only: parser and filesystem errors can contain research data.
const safeFailureMessages = new Set([
  'Legacy file references must have immutable Versions before packaging.',
  'Session or Notebook references missing file evidence.',
  'Session package exceeds the file count limit.',
  'Session package contains too many files.',
  'Execution file evidence exceeds the package limit.'
])

// Native pickers and the preload File bridge supply filesystem paths. A private archive freezes
// the bytes reviewed in the confirmation before import or external save.
export class SessionPackageDesktop {
  readonly operations: SessionPackageOperation
  private pendingFiles: NativeImportFile[] = []
  private activeFile?: NativeImportFile
  private sensitiveReview?: {
    operationId: string
    signal: AbortSignal
    resolve: (confirmed: boolean) => void
    confirming: boolean
  }
  private orgCaseUploader?: OrgCaseUploader
  private downloadDirectory?: string
  private lastImportFile?: NativeImportFile
  private pendingUseCase?: {
    requestId: string
    source: UseCaseSource
    callerId?: string
    originClientId?: string
  }
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
      onSensitiveContentFailure?: (
        request: SessionPackageRequest,
        evidence: SensitiveContentEvidence[],
        sources: PackageSensitiveContentSource[]
      ) => void
      cancelBrowserTransfer?: (id: string) => Promise<void>
      assertCanStart?: () => void
      uploadOrgCase?: OrgCaseUploader
    }
  ) {
    this.operations = new SessionPackageOperation((snapshot) => {
      options.onOperationChanged?.(snapshot)
      // Defer until run() has completed ownership release and any active file has settled.
      if (!this.operations.active) queueMicrotask(() => this.pumpOpenFiles())
    })
  }

  registerOrgCaseUploader(uploader: OrgCaseUploader): () => void {
    this.orgCaseUploader = uploader
    return () => {
      if (this.orgCaseUploader === uploader) this.orgCaseUploader = undefined
    }
  }

  private resolveOrgCaseUploader(): OrgCaseUploader | undefined {
    return this.orgCaseUploader ?? this.options.uploadOrgCase
  }

  reportOpenOverflow(): void {
    this.operations.setPendingImports(
      this.pendingFiles.map(({ id, filename }) => ({ id, filename })),
      true
    )
  }

  enqueueFile(
    path: string,
    onReleased?: () => void,
    validateBeforeTarget = false
  ): Promise<boolean> {
    const releaseSource = onReleased
    let released = false
    onReleased = releaseSource
      ? () => {
          if (released) return
          released = true
          releaseSource()
        }
      : undefined
    const enqueue = this.enqueueing
      .then(async () => {
        if (this.shutdown.signal.aborted) {
          onReleased?.()
          return false
        }
        const canonical = await realpath(path).catch(() => path)
        if (this.shutdown.signal.aborted) {
          onReleased?.()
          return false
        }
        if (
          this.activeFile?.path === canonical ||
          this.pendingFiles.some((file) => file.path === canonical)
        ) {
          this.operations.setPendingImports(
            this.pendingFiles.map(({ id, filename }) => ({ id, filename }))
          )
          this.operations.present()
          return true
        }
        if (this.pendingFiles.length >= 16) {
          onReleased?.()
          this.operations.setPendingImports(
            this.pendingFiles.map(({ id, filename }) => ({ id, filename })),
            true
          )
          return false
        }
        const startImmediately = this.pendingFiles.length === 0 && !this.operations.active
        this.pendingFiles.push({
          id: randomUUID(),
          path: canonical,
          filename: basename(path),
          onReleased,
          validateBeforeTarget
        })
        this.operations.setPendingImports(
          this.pendingFiles.map(({ id, filename }) => ({ id, filename }))
        )
        this.pumpOpenFiles(startImmediately)
        this.operations.present()
        return true
      })
      .catch((error) => {
        onReleased?.()
        createLogger('session-package').warn(
          'Could not receive package file',
          diagnosticErrorFields(error)
        )
        return false
      })
    this.enqueueing = enqueue.then(() => undefined)
    return enqueue
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
    file.work = this.import(
      undefined,
      file.originClientId,
      file.target ?? {},
      file.path,
      file.validateBeforeTarget
    )
      .then((result) => {
        if (result) file.onReleased?.()
      })
      .catch(() => undefined)
      .finally(() => {
        this.activeFile = undefined
        this.pumpOpenFiles()
      })
  }

  async cancelReceivedFile(path: string): Promise<void> {
    await this.enqueueing
    path = await realpath(path).catch(() => path)
    // Only this source is cancelled. Other pending imports and an unrelated active operation survive.
    const pending = this.pendingFiles.filter((file) => file.path === path)
    this.pendingFiles = this.pendingFiles.filter((file) => file.path !== path)
    for (const file of pending) file.onReleased?.()
    this.operations.setPendingImports(
      this.pendingFiles.map(({ id, filename }) => ({ id, filename }))
    )
    const active = this.activeFile
    if (active?.path === path) {
      this.operations.cancel()
      await active.work
      active.onReleased?.()
    }
    if (this.lastImportFile?.path === path) {
      this.lastImportFile.onReleased?.()
      this.lastImportFile = undefined
    }
  }

  respond(
    request: PackageOperationRequest,
    desktopCallerId?: string
  ): PackageOperationSnapshot | null | Promise<PackageOperationSnapshot | null> {
    if (request.action === 'agent-fork') {
      const { session, correlationId } = request
      const current = this.operations.snapshot
      if (
        this.operations.active ||
        this.lastImportFile?.recovery ||
        current?.result?.recovery ||
        current?.agent?.correlationId === correlationId
      )
        throw new ApplicationCommandError(
          'session-package-operation-conflict',
          'Resolve the current package operation before forking.'
        )
      void this.fork(session, undefined, { correlationId }).catch(() => undefined)
      return this.operations.snapshot
    }
    if (request.action === 'agent-import') {
      const { sourcePath, target, correlationId } = request
      if (!isAbsolute(sourcePath) || sourcePath.includes('\0'))
        throw new ApplicationCommandError(
          'invalid-command-arguments',
          'Use an absolute package path.'
        )
      const current = this.operations.snapshot
      if (
        this.operations.active ||
        this.lastImportFile?.recovery ||
        current?.result?.recovery ||
        current?.agent?.correlationId === correlationId
      )
        throw new ApplicationCommandError(
          'session-package-operation-conflict',
          'Resolve the current package operation before importing.'
        )
      void this.import(undefined, undefined, target, sourcePath, false, {
        nonInteractive: true,
        agent: { correlationId, sourcePath }
      }).catch(() => undefined)
      return this.operations.snapshot
    }
    if (request.action === 'agent-export') {
      const { session, destinationPath, correlationId } = request
      if (!isAbsolute(destinationPath))
        throw new ApplicationCommandError(
          'invalid-command-arguments',
          'Use an absolute export path.'
        )
      const current = this.operations.snapshot
      if (
        this.operations.active ||
        current?.result?.recovery ||
        current?.agent?.correlationId === correlationId
      )
        throw new ApplicationCommandError(
          'session-package-operation-conflict',
          'Another package operation must be resolved before starting this export.'
        )
      const agent = { correlationId, destinationPath }
      // run() admits the operation synchronously. Completion remains owned by the same
      // package operation even after this HTTP request has returned or disconnected.
      void this.exportWithPolicy(session, undefined, destinationPath, false, agent).catch(
        () => undefined
      )
      return this.operations.snapshot
    }
    if (request.action === 'cancel-browser-transfer') {
      return Promise.resolve(this.options.cancelBrowserTransfer?.(request.transferId)).then(
        () => this.operations.snapshot
      )
    }
    if (request.action === 'respond-export-review') return this.respondToExportReview(request)
    if (request.action === 'export-with-sensitive-content') {
      if (!desktopCallerId)
        throw new ApplicationCommandError(
          'command-unavailable',
          'Review and confirm this export in Open-Science Desktop.'
        )
      const snapshot = this.operations.snapshot
      const pending = this.sensitiveReview
      if (
        !snapshot?.sensitiveExportReview ||
        pending?.operationId !== request.operationId ||
        snapshot.id !== request.operationId ||
        pending.signal.aborted ||
        pending.confirming ||
        Date.now() >= snapshot.sensitiveExportReview.expiresAt
      )
        throw new Error('No pending sensitive export is available.')
      const { translate } = this.options
      const { destination, fileDigest } = snapshot.sensitiveExportReview
      // Keep the path and fingerprint visibly distinct from the warning, including when an
      // automation caller supplied an unusual filename containing control characters.
      const detail = [
        destination?.replace(/[\p{Cc}\p{Cf}]/gu, '\uFFFD').slice(0, 32000),
        `${formatPackageBytes(fileDigest.sizeBytes)} · SHA-256: ${fileDigest.checksum}`
      ]
        .filter(Boolean)
        .join('\n\n')
      const native = desktopFileInteraction()
      pending.confirming = true
      return native
        .confirm(
          {
            type: 'warning',
            message: translate(
              'This package may contain credentials or private information. Exporting anyway includes flagged content without redaction. Review the package before sharing.'
            ),
            detail,
            buttons: [translate('Cancel'), translate('Export anyway')],
            defaultId: 0,
            cancelId: 0
          },
          desktopCallerId,
          pending.signal
        )
        .then(({ response }) => {
          pending.signal.throwIfAborted()
          if (Date.now() >= snapshot.sensitiveExportReview!.expiresAt)
            throw new Error('The sensitive export review expired.')
          this.resolveSensitiveReview(pending, {
            source: 'desktop',
            decision: response === 1 ? 'approved' : 'rejected'
          })
          return this.operations.snapshot
        })
        .catch((error: unknown) => {
          pending.confirming = false
          throw error
        })
    }
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
        if (this.lastImportFile?.id === request.requestId) {
          if (
            this.operations.active ||
            this.activeFile ||
            this.lastImportFile.recovery ||
            this.operations.snapshot?.cleanupPending
          )
            throw new Error('Wait for the current package operation to finish.')
          const source = this.lastImportFile
          return Promise.resolve(source.onReleased?.()).then(() => {
            if (this.lastImportFile === source) this.lastImportFile = undefined
            return this.operations.snapshot
          })
        }
        this.pendingFiles.find((file) => file.id === request.requestId)?.onReleased?.()
        this.pendingFiles = this.pendingFiles.filter((file) => file.id !== request.requestId)
        this.operations.setPendingImports(
          this.pendingFiles.map(({ id, filename }) => ({ id, filename }))
        )
      } else {
        if (this.activeFile || this.operations.active || this.operations.snapshot?.cleanupPending)
          throw new Error('Wait for the current package operation to finish.')
        if (request.action === 'retry-import') {
          const pending = this.pendingUseCase
          if (pending && pending.requestId === this.operations.snapshot?.importRequestId) {
            return this.import(pending.callerId, pending.originClientId, {}, pending.source).then(
              () => this.operations.snapshot
            )
          }
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
    return desktopShellInteraction()
      .revealPath(snapshot.result.filePath)
      .then(() => snapshot)
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
    const sources = [...this.pendingFiles, this.lastImportFile, this.activeFile]
    this.pendingFiles = []
    this.lastImportFile = undefined
    this.operations.cancel()
    this.shutdown.abort(new Error('Session package desktop is closed.'))
    await this.operations.close()
    await this.operation
    await this.enqueueing
    for (const source of sources) await source?.onReleased?.()
    if (this.downloadDirectory) await rm(this.downloadDirectory, { recursive: true, force: true })
  }

  private respondToExportReview(
    request: Extract<PackageOperationRequest, { action: 'respond-export-review' }>
  ): PackageOperationSnapshot {
    const snapshot = this.operations.snapshot
    const review = snapshot?.sensitiveExportReview
    const recorded = snapshot?.sensitiveExportDecision
    if (
      snapshot?.id !== request.operationId ||
      snapshot.kind !== 'export' ||
      snapshot.agent?.destinationPath !== request.destinationPath ||
      request.expiresAt !== (recorded?.expiresAt ?? review?.expiresAt) ||
      request.sizeBytes !== (recorded?.sizeBytes ?? review?.fileDigest.sizeBytes) ||
      request.sha256 !== (recorded?.sha256 ?? review?.fileDigest.checksum)
    )
      throw new ApplicationCommandError(
        'session-package-review-unavailable',
        'The sensitive export review no longer matches this operation, destination, and candidate. Check the original operation.'
      )
    if (recorded?.source === request.source && recorded.decision === request.decision)
      return snapshot
    const pending = this.sensitiveReview
    if (recorded || pending?.confirming)
      throw new ApplicationCommandError(
        'session-package-operation-conflict',
        'This export already has a decision or a native confirmation in progress. Check the original operation.'
      )
    if (
      !review?.agentDetails ||
      review.destination !== request.destinationPath ||
      snapshot.state !== 'awaiting-selection' ||
      pending?.operationId !== request.operationId ||
      pending.signal.aborted ||
      Date.now() >= review.expiresAt
    )
      throw new ApplicationCommandError(
        'session-package-review-unavailable',
        'This sensitive export review expired or is no longer pending. Check the original operation.'
      )
    this.resolveSensitiveReview(pending, { source: request.source, decision: request.decision })
    return this.operations.snapshot!
  }

  private resolveSensitiveReview(
    pending: NonNullable<SessionPackageDesktop['sensitiveReview']>,
    decision: Pick<SensitiveExportDecision, 'source' | 'decision'>
  ): void {
    this.operations.finishSensitiveExportReview(decision)
    pending.resolve(decision.decision === 'approved')
  }

  private async waitForSensitiveReview(
    evidence: SensitiveContentEvidence[],
    review: Omit<NonNullable<PackageOperationSnapshot['sensitiveExportReview']>, 'expiresAt'>,
    signal: AbortSignal
  ): Promise<void> {
    const choice = Promise.withResolvers<boolean>()
    const expiresAt = Date.now() + sensitiveReviewTimeoutMs
    const timeout = AbortSignal.timeout(sensitiveReviewTimeoutMs)
    const reviewSignal = AbortSignal.any([signal, this.shutdown.signal, timeout])
    this.sensitiveReview = {
      operationId: this.operations.snapshot!.id,
      signal: reviewSignal,
      resolve: choice.resolve,
      confirming: false
    }
    try {
      const decision = this.nativeDialog(choice.promise, reviewSignal)
      this.operations.requestSensitiveExportReview({ ...review, expiresAt }, evidence)
      if (!(await decision)) this.operations.cancel()
    } catch (error) {
      if (!timeout.aborted) throw error
      this.operations.setAgentFailure('export-review-expired')
      this.operations.cancel()
    } finally {
      this.sensitiveReview = undefined
      this.operations.finishSensitiveExportReview()
    }
    signal.throwIfAborted()
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
    signal: AbortSignal,
    reservePolicy?: number | ((writeBytes: number) => number)
  ): Promise<PackageFileDigest> {
    return withPackageTransfer(async (transfer) => {
      const size = (await stat(source)).size
      await assertPackageCapacity(dirname(destination), size, reservePolicy)
      return copyFileWithinBudget(
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

  // Local Web callers hand the returned path to the renderer for a browser download, so the
  // archive lands in private per-host and per-export directories.
  private async stageDownloadPath(title: string): Promise<string> {
    const root = (this.downloadDirectory ??= await this.createDownloadDirectory())
    await this.pruneStaleDownloads(root)
    const directory = await mkdtemp(join(root, 'export-'))
    const today = new Date()
    const date = [
      today.getFullYear(),
      String(today.getMonth() + 1).padStart(2, '0'),
      String(today.getDate()).padStart(2, '0')
    ].join('-')
    const base = `${sanitizeExportFilename(title || 'Session', 220)}-${date}`
    return join(directory, `${base}.science`)
  }

  private async createDownloadDirectory(): Promise<string> {
    const parent = tmpdir()
    const uid = process.getuid?.()
    const user =
      uid ?? createHash('sha256').update(homedir().toLowerCase()).digest('hex').slice(0, 16)
    const prefix = `open-science-package-exports-v1-${user}-`
    try {
      for await (const entry of await opendir(parent)) {
        if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue
        const match = /^([1-9]\d{0,9})-[A-Za-z0-9]{6}$/.exec(entry.name.slice(prefix.length))
        if (!match) continue
        const pid = Number(match[1])
        if (pid === process.pid || pid > 0x7fff_ffff) continue
        try {
          // Hosts sharing this temp directory must also share a PID namespace.
          process.kill(pid, 0)
          continue
        } catch (error) {
          // A reused PID or an inconclusive liveness check preserves the directory.
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue
        }
        const path = join(parent, entry.name)
        try {
          const info = await lstat(path)
          if (
            info.isDirectory() &&
            (uid === undefined || (info.uid === uid && !(info.mode & 0o077)))
          )
            await rm(path, { recursive: true, force: true })
        } catch {
          // Another host may already have cleaned the directory, or a file is still open.
        }
      }
    } catch {
      // An unreadable temp listing must not block a new export.
    }
    return mkdtemp(join(parent, `${prefix}${process.pid}-`))
  }

  // Staged downloads are ephemeral: drop anything a previous caller never claimed.
  private async pruneStaleDownloads(directory: string): Promise<void> {
    try {
      const cutoff = Date.now() - 60 * 60 * 1000
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith('export-')) continue
        try {
          const path = join(directory, entry.name)
          const info = await stat(path)
          if (info.mtimeMs < cutoff) await rm(path, { recursive: true, force: true })
        } catch {
          // A racing download or unreadable entry must not block this export.
        }
      }
    } catch {
      // Best-effort cleanup: a missing or unreadable directory only delays pruning.
    }
  }

  private staged<T>(
    work: (directory: string) => Promise<T>,
    request?: SessionPackageRequest,
    temporaryRoot = tmpdir(),
    beforeStage?: () => Promise<void>
  ): Promise<T> {
    if (this.shutdown.signal.aborted) return Promise.reject(this.shutdown.signal.reason)
    if (this.busy)
      return Promise.reject(new Error('A Session package operation is already in progress.'))
    const result = withPackageTransfer(
      () => this.stagedNow(work, request, temporaryRoot, beforeStage),
      () => this.operations.transferBytesPerSecond,
      this.operations.reportIo
    )
    this.operation = result.catch(() => undefined)
    return result
  }

  private async stagedNow<T>(
    work: (directory: string) => Promise<T>,
    request?: SessionPackageRequest,
    temporaryRoot = tmpdir(),
    beforeStage?: () => Promise<void>
  ): Promise<T> {
    this.busy = true
    try {
      await beforeStage?.()
      if (temporaryRoot === this.options.service.packageTemporaryRoot)
        await this.options.service.ensurePackageTemporaryRoot()
      else await mkdir(temporaryRoot, { recursive: true, mode: 0o700 })
      const directory = await mkdtemp(join(temporaryRoot, 'open-science-package-dialog-'))
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
      this.failOperation(error, request)
    } finally {
      this.busy = false
    }
  }

  // Preflight validation and staged operations share the same user-facing error conversion.
  private failOperation(error: unknown, request?: SessionPackageRequest): never {
    if (error instanceof PackageSensitiveContentError)
      this.operations.setAgentFailure('requires-user')
    if (error instanceof SensitiveExportCandidateChangedError)
      this.operations.setAgentFailure('content-changed')
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST')
      this.operations.setAgentFailure('destination-conflict')
    if (error instanceof PackageSensitiveContentError && request && error.evidence) {
      this.operations.setSensitiveContent([error.evidence])
      this.reportSensitiveContent(request, [error.evidence], error)
    }
    const detail = error instanceof Error ? error.message : ''
    const snapshot = this.operations.snapshot
    createLogger('session-package').warn('Session package operation failed', {
      ...diagnosticErrorFields(error),
      operationId: snapshot?.id,
      phase: snapshot?.progress.phase,
      importStage: snapshot?.progress.importStage,
      ...(error instanceof SessionExportBlockedError ? { reason: error.reason } : {}),
      ...(safeFailureMessages.has(detail) ? { error: { message: detail } } : {})
    })
    const translate = this.options.translate
    const blocked = (message: string): PackageExportBlockedError =>
      new PackageExportBlockedError(message, { cause: error })
    if (error instanceof SessionExportBlockedError)
      throw blocked(sessionExportBlockerMessage(error.reason, translate))
    if (request && error instanceof ArchiveAvailabilityError)
      throw blocked(
        error.code === 'project-archived'
          ? translate('Restore the archived project, then export again.')
          : translate('Restore the archived session, then export again.')
      )
    if (detail === PACKAGE_REQUIRES_UPDATE) {
      this.operations.setAgentFailure('requires-update')
      throw new Error(
        translate(
          'This Session package requires a newer version of Open Science. Update Open Science, then try importing it again.'
        ),
        { cause: error }
      )
    }
    if (isInvalidPackageArchive(error)) {
      this.operations.setAgentFailure('invalid-archive')
      throw new ApplicationCommandError(
        'session-package-invalid-archive',
        translate('The selected file is not a valid Session package.'),
        undefined,
        { cause: error }
      )
    }
    if (error instanceof PackageSourceUnavailableError) {
      this.operations.setAgentFailure('source-unavailable')
      throw new ApplicationCommandError(
        'session-package-source-unavailable',
        translate(
          'The original package is unavailable. It may have been moved, deleted, or become unreadable. Choose another package.'
        ),
        undefined,
        { cause: error }
      )
    }
    if (error instanceof PackageCapacityError) {
      if (snapshot?.useCaseDownload)
        throw new Error(
          translate(
            'Not enough disk space to download this example ({{required}} needed, {{available}} available). Free up at least {{shortfall}}, then try again.',
            {
              required: formatPackageBytes(error.requiredBytes),
              available: formatPackageBytes(error.freeBytes),
              shortfall: formatPackageBytes(error.requiredBytes - error.freeBytes)
            }
          ),
          { cause: error }
        )
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
    }
    if (error instanceof UseCaseDownloadError) {
      switch (error.reason) {
        case 'manifest':
          throw new Error(
            translate('Could not load the example catalog. Check your connection and try again.'),
            { cause: error }
          )
        case 'unavailable':
          throw new Error(
            translate('This example is currently unavailable. Refresh the list and try again.'),
            { cause: error }
          )
        case 'timeout':
          throw new Error(
            translate('The example download timed out. Check your connection and try again.'),
            { cause: error }
          )
        case 'network':
          throw new Error(
            translate(
              'Network error while downloading this example. Check your connection or proxy, then try again.'
            ),
            { cause: error }
          )
        case 'server':
          throw new Error(translate('The example server returned an error. Try again shortly.'), {
            cause: error
          })
        case 'verification':
          throw new Error(
            translate('The downloaded example failed verification. Try again shortly.'),
            { cause: error }
          )
        case 'disk-full':
          throw new Error(
            translate(
              'Not enough disk space to download this example. Free up space and try again.'
            ),
            { cause: error }
          )
        case 'storage':
          throw new Error(
            translate(
              'Could not save the downloaded example to temporary storage. Check folder permissions and try again.'
            ),
            { cause: error }
          )
      }
    }
    if (detail === 'Wait for the application handoff to finish before transferring research.') {
      const message = translate(
        'Wait for the application handoff to finish before transferring research.'
      )
      if (request) throw blocked(message)
      throw new Error(message, { cause: error })
    }
    if (detail.startsWith('An excluded file also exists'))
      throw new Error(
        translate(
          'An excluded file also exists in retained research evidence. Include that file to export this Session.'
        ),
        { cause: error }
      )
    if (error instanceof PackageSensitiveContentError) {
      const rules = {
        field: translate('Credential-like field value'),
        assignment: translate('Credential-like assignment'),
        url: translate('Credential-like URL'),
        token: translate('Credential-like token')
      }
      throw new Error(
        translate(
          'Sensitive content detected at {{location}}. Check: {{rule}}. Review it before exporting the Session package.',
          {
            location: error.location,
            rule: rules[error.rule]
          }
        ),
        { cause: error }
      )
    }
    if (error instanceof SensitiveExportCandidateChangedError)
      throw new Error(translate('The package changed after review. No file was published.'), {
        cause: error
      })
    if (error instanceof OrgCaseFailure) {
      throw new Error(translateOrgCaseUploadError(error.errorCode, translate), { cause: error })
    }
    if (detail.includes('Sensitive content detected'))
      throw new Error(
        translate('Sensitive content detected. Remove it before exporting the Session package.'),
        { cause: error }
      )
    if (request) {
      let message: string | undefined
      switch (detail) {
        case 'Legacy file references must have immutable Versions before packaging.':
        case 'Legacy attachments must have immutable Versions before packaging.':
          throw blocked(
            translate(
              'A historical file reference in this session has no immutable version. Use Export conversation to save the messages.'
            )
          )
        case 'Session package references a missing immutable Version.':
        case 'Session or Notebook references missing file evidence.':
          throw blocked(
            translate(
              'This session refers to a file version that is unavailable. Restore the original file version from a backup, or export the conversation to save the messages.'
            )
          )
        case 'Wait for the scheduled task to finish before exporting.':
          throw blocked(translate('A scheduled task is running. Export again after it finishes.'))
        case 'Wait for the compute job to finish before exporting.':
          throw blocked(sessionExportBlockerMessage('compute', translate))
        case 'Wait for Notebook runs to finish before exporting.':
          throw blocked(sessionExportBlockerMessage('notebook', translate))
        case 'Wait for image tasks to finish before exporting this Session.':
          throw blocked(sessionExportBlockerMessage('image', translate))
        case 'Wait for file writes to finish before exporting.':
          throw blocked(
            translate(
              'A file is still being saved. Wait for the save to finish, then export again.'
            )
          )
        case 'Wait for Reviews to finish before exporting.':
          throw blocked(
            translate('A review is in progress. Export again after the review finishes.')
          )
        case 'The Session is still active.':
        case 'Wait for the Session to finish before exporting it.':
          throw blocked(sessionExportBlockerMessage('pending', translate))
        case 'Session package exceeds the file count limit.':
        case 'Session package contains too many files.':
        case 'Execution file evidence exceeds the package limit.':
          throw blocked(
            translate(
              'This session exceeds the 10,000-file package limit. Use Export conversation to save a copy of the messages.'
            )
          )
        case 'The Session changed during export. Try again.':
        case 'Research film changed during export.':
          message = translate(
            'The source files or session changed during export. Retry when edits have finished.'
          )
          break
      }
      const code = (error as NodeJS.ErrnoException | null)?.code
      if (code === 'ENOSPC' || code === 'EDQUOT')
        message = translate(
          'There is not enough space to write the package. Free up disk space and export again.'
        )
      if (
        snapshot?.progress.phase === 'saving' &&
        (code === 'EACCES' || code === 'EPERM' || code === 'EROFS')
      )
        message = translate(
          'The package could not be saved in this folder. Choose a writable folder and export again.'
        )
      throw new Error(
        message ??
          translate(
            'Could not export this session. Try again. If the problem persists, export a diagnostic package from the session menu.'
          ),
        { cause: error }
      )
    }
    if (detail.startsWith('Wait for') || detail.includes('changed during export'))
      throw new Error(
        translate('Wait for all research activity to finish, then try exporting again.'),
        { cause: error }
      )
    if (snapshot?.useCaseDownload)
      throw new Error(translate('Could not download this example. Try again.', { ns: 'common' }), {
        cause: error
      })
    throw new Error(
      translate(
        'Could not complete the Session package operation. Check the package and available disk space, then try again.'
      ),
      { cause: error }
    )
  }

  private reportSensitiveContent(
    request: SessionPackageRequest,
    evidence: SensitiveContentEvidence[],
    finding: PackageSensitiveContentError
  ): void {
    try {
      this.options.onSensitiveContentFailure?.(
        request,
        evidence,
        finding.source ? [finding.source] : []
      )
    } catch {
      // Diagnostic capture must not change the package operation result.
    }
  }

  fork(
    request: SessionPackageRequest,
    originClientId?: string,
    agent?: AgentPackageOperationReference
  ): Promise<SessionPackageRequest | null> {
    if (this.operations.snapshot?.result?.recovery)
      return Promise.reject(new Error(this.operations.snapshot.error))
    let operationSignal: AbortSignal | undefined
    return this.operations
      .run(
        'fork',
        request,
        async (signal) => {
          operationSignal = signal
          let release: (() => void) | undefined
          try {
            this.options.assertCanStart?.()
            this.operations.setCleanupPending(this.pendingCleanup.size > 0)
            release = await this.options.reserveExport?.(request, signal)
            const result = await withPackageTransfer(
              () =>
                this.options.withDataRootWrite(() =>
                  this.acceptCleanup(() =>
                    this.options.service.fork(request, signal, this.operations.report)
                  )
                ),
              () => this.operations.transferBytesPerSecond,
              this.operations.reportIo
            )
            this.operations.completeResult({ imported: result })
            try {
              await this.options.afterImport(result, originClientId, false)
            } catch (error) {
              createLogger('session-package').warn(
                'Fork published; notification failed',
                diagnosticErrorFields(error)
              )
            }
            return result
          } catch (error) {
            if (error instanceof PackageSensitiveContentError && error.evidence) {
              this.operations.setSensitiveContent([error.evidence])
              try {
                this.options.onSensitiveContentFailure?.(
                  request,
                  [error.evidence],
                  error.source ? [error.source] : []
                )
              } catch {
                // Diagnostic capture must not change the package operation result.
              }
            }
            if (error instanceof ForkRecoveryRequiredError) {
              this.operations.completeResult({ recovery: error.recovery })
              throw new Error(
                this.options.translate(
                  'Fork publication needs recovery (operation {{operationId}}, Session {{sessionId}}). Restart the app to recover this attempt before forking again.',
                  error.recovery
                ),
                { cause: error }
              )
            }
            if (error instanceof ForkPendingApprovalError)
              this.operations.setAgentFailure('fork-waiting-approval')
            if (
              error instanceof NotebookExecutionAdmissionError &&
              error.code === 'NOTEBOOK_EXECUTION_REQUIRES_USER_ACTION'
            )
              this.operations.setAgentFailure('fork-notebook-refused')
            const detail = redactSensitiveText(
              error instanceof Error ? error.message : String(error)
            )
            const reason =
              error instanceof SessionExportBlockedError ||
              detail.startsWith('Wait for') ||
              detail === 'The Session is still active.'
                ? this.options.translate(
                    'Wait for all Session activity and pending approvals to finish before forking.'
                  )
                : detail.length > 1500
                  ? `${detail.slice(0, 1500)}…`
                  : detail
            throw new Error(
              this.options.translate('Could not fork this Session: {{reason}}', { reason }),
              { cause: error }
            )
          } finally {
            release?.()
          }
        },
        undefined,
        undefined,
        undefined,
        undefined,
        agent
      )
      .catch((error) => {
        if (
          operationSignal?.aborted &&
          !this.shutdown.signal.aborted &&
          !this.operations.snapshot?.result?.recovery
        )
          return null
        throw error
      })
  }

  export(
    request: SessionPackageRequest,
    callerId?: string,
    destinationPath?: string,
    options?: { stageDownload?: boolean }
  ): Promise<SessionPackageExportResult> {
    return this.exportWithPolicy(
      request,
      callerId,
      destinationPath,
      options?.stageDownload ?? false
    )
  }

  private exportWithPolicy(
    request: SessionPackageRequest,
    callerId?: string,
    destinationPath?: string,
    stage = false,
    agent?: AgentPackageOperationReference
  ): Promise<SessionPackageExportResult> {
    let operationSignal: AbortSignal | undefined
    return this.operations
      .run(
        'export',
        request,
        async (signal) => {
          operationSignal = signal
          let release: (() => void) | undefined
          try {
            this.options.assertCanStart?.()
            this.operations.setCleanupPending(this.pendingCleanup.size > 0)
            release = await this.options.reserveExport?.(request, signal)
          } catch (error) {
            this.failOperation(error, request)
          }
          try {
            return await this.staged(async (directory) => {
              const archive = join(directory, 'session.science')
              let filePath: string | undefined = destinationPath
              let orgCaseTarget: OrgCaseUploadMetadata | undefined
              let sessionTitle: string | undefined
              let sensitiveFinding: PackageSensitiveContentError | undefined
              const evidence: SensitiveContentEvidence[] = []
              const { webOmissions, fileCount } = await this.options.withDataRootWrite(() =>
                this.acceptCleanup(() =>
                  this.options.service.exportTo(request, archive, {
                    onSensitiveContent: (finding) => {
                      sensitiveFinding ??= finding
                      if (finding.evidence && evidence.length < 20) evidence.push(finding.evidence)
                    },
                    signal,
                    onProgress: this.operations.report,
                    // Headless callers with an explicit destination include all files.
                    ...(destinationPath
                      ? {}
                      : {
                          selectFiles: async (files, budgetSignal, summary, title) => {
                            const excluded = await this.operations.selectFiles(
                              files,
                              budgetSignal,
                              summary,
                              title
                            )
                            const selectedUpload = this.operations.uploadTarget
                            if (selectedUpload) {
                              signal.throwIfAborted()
                              orgCaseTarget = selectedUpload
                              sessionTitle = title
                              this.operations.report({ phase: 'preparing' })
                              return excluded
                            }
                            if (stage) {
                              // Local Web callers download the staged archive from the renderer;
                              // a headless host has no native dialog to ask for a destination.
                              signal.throwIfAborted()
                              filePath = await this.stageDownloadPath(title)
                              this.operations.report({ phase: 'preparing' })
                              return excluded
                            }
                            this.operations.report({ phase: 'choosing-location' })
                            signal.throwIfAborted()
                            const options = {
                              title: this.options.translate('Export Session package'),
                              defaultPath: formatExportArchiveFilename(title),
                              filters: [{ name: 'Open-Science Session', extensions: ['science'] }]
                            }
                            const selected = await this.nativeDialog(
                              desktopFileInteraction().chooseSavePath(options, callerId),
                              AbortSignal.any([signal, budgetSignal])
                            )
                            if (selected.canceled || !selected.filePath) {
                              this.operations.cancel()
                              signal.throwIfAborted()
                            }
                            filePath = selected.filePath
                            this.operations.report({ phase: 'preparing' })
                            return excluded
                          }
                        })
                  })
                )
              )
              signal.throwIfAborted()
              let reviewedDigest: PackageFileDigest | undefined
              if (sensitiveFinding) {
                this.reportSensitiveContent(request, evidence, sensitiveFinding)
                reviewedDigest = await digestFileWithinBudget(archive, PACKAGE_MAX_BYTES, signal)
                await this.waitForSensitiveReview(
                  evidence,
                  {
                    destination: orgCaseTarget?.name ?? (stage ? undefined : filePath),
                    fileDigest: reviewedDigest,
                    ...(agent
                      ? {
                          agentDetails: {
                            fileScope: { fileCount, includesSessionHistory: true },
                            // Never send content snippets, storage keys or secret fingerprints to
                            // the external Agent. They are not needed to decide about these bytes.
                            findings: evidence.map(({ sourceStorageKey, location, rule }) => ({
                              source: sourceStorageKey
                                ? 'research_file'
                                : location.startsWith('session.json')
                                  ? 'session_metadata'
                                  : 'package_metadata',
                              rule
                            }))
                          }
                        }
                      : {})
                  },
                  signal
                )
              }
              const checkReviewedDigest = (actual: PackageFileDigest): void => {
                if (
                  reviewedDigest &&
                  (actual.sizeBytes !== reviewedDigest.sizeBytes ||
                    actual.checksum !== reviewedDigest.checksum)
                )
                  throw new SensitiveExportCandidateChangedError()
              }
              const omissionResult = webOmissions?.length ? { webOmissions } : {}
              if (orgCaseTarget) {
                const uploader = this.resolveOrgCaseUploader()
                if (!uploader) throw new OrgCaseFailure('unconfigured')
                let archivePath = archive
                if (reviewedDigest) {
                  // The uploader streams the path after this check; isolate the verified bytes
                  // from the candidate that was held while the user was reviewing it.
                  archivePath = join(directory, 'confirmed.science')
                  checkReviewedDigest(
                    await this.copyArchive(archive, archivePath, 'saving', signal)
                  )
                  await rm(archive)
                }
                const archiveStats = await stat(archivePath)
                signal.throwIfAborted()
                const filename = formatExportArchiveFilename(
                  orgCaseTarget.name || sessionTitle || 'Session'
                )
                this.operations.report({
                  phase: 'uploading',
                  completedBytes: 0,
                  totalBytes: archiveStats.size
                })
                const uploadSignal = AbortSignal.any([signal, this.shutdown.signal])
                const uploaded = await uploader(
                  {
                    archivePath,
                    filename,
                    name: orgCaseTarget.name,
                    description: orgCaseTarget.description,
                    clientUploadId: `upload-${this.operations.snapshot!.id}`,
                    onProgress: (completedBytes, totalBytes) => {
                      if (!uploadSignal.aborted)
                        this.operations.report({ phase: 'uploading', completedBytes, totalBytes })
                    }
                  },
                  uploadSignal
                )
                signal.throwIfAborted()
                const uploadedCase = { id: uploaded.id, name: uploaded.name, code: uploaded.code }
                this.operations.completeResult({ uploadedCase, ...omissionResult })
                return { saved: true, uploadedCase }
              }
              if (!filePath) throw new Error('No export destination was selected.')
              this.operations.report({ phase: 'saving' })
              let fileDigest: PackageFileDigest | undefined
              await publishUserFile(
                filePath,
                async (temporary) => {
                  fileDigest = await this.copyArchive(archive, temporary, 'saving', signal)
                  checkReviewedDigest(fileDigest)
                },
                {
                  exclusive: Boolean(agent),
                  signal,
                  validateDestination: async () => signal.throwIfAborted()
                }
              )
              this.operations.completeResult({
                filePath,
                ...(agent && fileDigest ? { fileDigest } : {}),
                ...omissionResult
              })
              return { saved: true, filePath }
            }, request)
          } finally {
            release?.()
          }
        },
        undefined,
        undefined,
        undefined,
        destinationPath ? 'local' : undefined,
        agent
      )
      .catch((error) => {
        if (operationSignal?.aborted && !this.shutdown.signal.aborted) return { saved: false }
        throw error
      })
  }

  import(
    callerId?: string,
    originClientId?: string,
    target: import('../../shared/session-package').SessionPackageImportRequest = {},
    source?: string | UseCaseSource,
    validateBeforeTarget = false,
    options?: {
      readonly nonInteractive?: true
      readonly onReleased?: () => Promise<void>
      readonly agent?: AgentPackageOperationReference
    }
  ): Promise<SessionPackageImportResult> {
    let sourcePath = typeof source === 'string' ? source : undefined
    const useCase = typeof source === 'object' ? source.useCase : undefined
    const nonInteractive = options?.nonInteractive === true
    let released: Promise<void> | undefined
    const releaseSource = options?.onReleased
      ? () => (released ??= options.onReleased!())
      : undefined
    let operationSignal: AbortSignal | undefined
    let importFile: NativeImportFile | undefined
    let packageSummary: SessionPackageSummary | undefined
    const rememberSource = (path: string): void => {
      const id = this.operations.snapshot?.importRequestId ?? this.activeFile?.id ?? randomUUID()
      if (this.lastImportFile?.path !== path) this.lastImportFile?.onReleased?.()
      const onReleased =
        this.activeFile?.path === path
          ? this.activeFile.onReleased
          : (releaseSource ??
            (this.lastImportFile?.path === path ? this.lastImportFile.onReleased : undefined))
      // Only a queued retry owns the previous handle. An explicit import of the same path
      // remains a new request, and changing its destination cannot inherit recovery authority.
      const recovery =
        this.activeFile?.path === path &&
        this.activeFile.target?.projectId === target.projectId &&
        this.activeFile.target?.projectName === target.projectName
          ? this.activeFile.recovery
          : undefined
      this.lastImportFile = {
        id,
        path,
        filename: basename(path),
        target: { ...target },
        originClientId,
        onReleased,
        validateBeforeTarget,
        recovery
      }
      importFile = this.lastImportFile
      this.operations.setImportSource(id, basename(path), target)
    }
    const completeImport = async (
      result: SessionPackageRequest
    ): Promise<SessionPackageRequest> => {
      this.operations.completeResult({
        imported: result,
        ...(packageSummary ? { packageSummary } : {})
      })
      try {
        await this.options.afterImport(result, originClientId, !target.projectId)
      } catch (error) {
        createLogger('session-package').warn(
          'Imported Session notification failed',
          diagnosticErrorFields(error)
        )
      }
      return result
    }
    return this.operations
      .run(
        'import',
        undefined,
        async (signal) => {
          operationSignal = signal
          // Catalog downloads share the operation lock, progress, cancellation and retry ownership.
          if (useCase) {
            try {
              this.options.assertCanStart?.()
            } catch (error) {
              this.failOperation(error)
            }
            const requestId = randomUUID()
            this.pendingUseCase = { requestId, source: { useCase }, callerId, originClientId }
            this.operations.setImportSource(requestId, `${useCase}.science`, target)
            await this.options.service.preparePackageTemporaryRoot()
            const downloaded = await downloadUseCase(
              useCase,
              signal,
              (completedBytes, totalBytes) =>
                this.operations.reportUseCaseDownload(completedBytes, totalBytes),
              this.options.service.packageTemporaryRoot ?? tmpdir()
            ).catch((error) => this.failOperation(error))
            this.pendingUseCase = undefined
            sourcePath = downloaded.path
            rememberSource(sourcePath)
            this.lastImportFile!.onReleased = () => {
              void this.acceptCleanup(() =>
                withPackageCleanup(async () => undefined, downloaded.release)
              ).catch(() => undefined)
            }
            validateBeforeTarget = true
            this.operations.finishUseCaseDownload()
          }
          if (
            sourcePath &&
            (!isAbsolute(sourcePath) || extname(sourcePath).toLowerCase() !== '.science')
          )
            throw new Error('Invalid Session package path.')
          if (nonInteractive && !sourcePath)
            throw new Error('A package path is required for non-interactive import.')
          if (sourcePath) rememberSource(sourcePath)
          if (nonInteractive || !sourcePath || target.projectId || target.projectName)
            this.options.assertCanStart?.()
          this.operations.setCleanupPending(this.pendingCleanup.size > 0)
          const recovery = importFile?.recovery
          if (recovery) {
            this.options.assertCanStart?.()
            const release = target.projectId
              ? await this.options.reserveImport?.(target.projectId, signal)
              : undefined
            try {
              this.operations.report({ phase: 'importing' })
              const result = await this.options.withDataRootWrite(() =>
                this.acceptCleanup(() =>
                  recovery.resume(signal).catch((error: unknown) => {
                    if (
                      error instanceof PackageCleanupPendingError &&
                      'value' in error.outcome &&
                      error.outcome.value === undefined
                    )
                      throw new PackageCleanupPendingError(
                        error.outcome,
                        async () => {
                          await error.retryCleanup()
                          importFile!.recovery = undefined
                        },
                        error.cause
                      )
                    throw error
                  })
                )
              )
              if (result || !this.operations.snapshot?.cleanupPending)
                importFile!.recovery = undefined
              if (!result) throw recovery
              return await completeImport(result)
            } catch (error) {
              this.failOperation(error)
            } finally {
              release?.()
            }
          }
          if (sourcePath && validateBeforeTarget) {
            const inspectionPath = sourcePath
            // Browser uploads are untrusted bytes: reuse archive inspection before target selection.
            // importFrom still revalidates the staged archive and owns packageOrigin/receipt.json.
            this.options.assertCanStart?.()
            this.operations.report({ phase: 'validating' })
            try {
              await this.acceptCleanup(() =>
                this.options.service.inspect(inspectionPath, signal, (progress) =>
                  this.operations.report({
                    ...progress,
                    overallPercent: (packageImportPercent(progress) ?? 0) / 4
                  })
                )
              )
            } catch (error) {
              this.failOperation(error)
            }
            signal.throwIfAborted()
          }
          // Headless callers name the destination up front (or accept the automatic
          // import-<uuid> Project); there is no renderer to run target selection.
          if (sourcePath && !target.projectId && !target.projectName && !nonInteractive) {
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
          let selectedInput: string | undefined
          try {
            return await this.staged(
              async (directory) => {
                const input = sourcePath ?? selectedInput!
                rememberSource(input)
                const info = await stat(input).catch((error: NodeJS.ErrnoException) => {
                  if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code ?? ''))
                    throw new PackageSourceUnavailableError('Package source is unavailable.', {
                      cause: error
                    })
                  throw error
                })
                if (!info.isFile())
                  throw new PackageSourceUnavailableError('Package source is not a file.')
                if (info.size > PACKAGE_MAX_BYTES)
                  throw new Error('Session package exceeds the archive limit.')
                const archive = join(directory, 'session.science')
                await this.copyArchive(input, archive, 'copying', signal, packageDiskReserveBytes)
                this.operations.report({ phase: 'validating' })
                let confirmed = false
                const result = await this.options.withDataRootWrite(() =>
                  this.acceptCleanup(() =>
                    this.options.service
                      .importFrom(
                        archive,
                        signal,
                        // Inspection reports before confirmation; subsequent validation belongs to import.
                        (progress) =>
                          this.operations.report({
                            ...progress,
                            phase:
                              confirmed && progress.phase === 'validating'
                                ? 'importing'
                                : progress.phase,
                            ...(validateBeforeTarget
                              ? {
                                  overallPercent:
                                    10 +
                                    (packageImportPercent(progress) ?? (confirmed ? 40 : 0)) * 0.9
                                }
                              : {})
                          }),
                        options?.agent
                          ? async ({ omissions, webOmissions, ...summary }) => {
                              confirmed = true
                              packageSummary = {
                                ...summary,
                                omissionCount: omissions.length + (webOmissions?.length ?? 0),
                                externalOmissionCount: omissions.filter(
                                  ({ kind }) => kind === 'external'
                                ).length
                              }
                            }
                          : nonInteractive
                            ? undefined
                            : async (preview, budgetSignal) => {
                                await this.operations.waitForImport(
                                  { preview, filename: basename(input) },
                                  budgetSignal
                                )
                                confirmed = true
                                signal.throwIfAborted()
                              },
                        target
                      )
                      .catch((error: unknown) => {
                        if (error instanceof PackageImportRecoveryRequiredError) {
                          importFile!.recovery = error
                          this.operations.setAgentFailure('import-unconfirmed')
                        }
                        throw error
                      })
                  )
                )
                return completeImport(result)
              },
              undefined,
              this.options.service.packageTemporaryRoot ?? tmpdir(),
              async () => {
                if (sourcePath) return
                const options = {
                  title: this.options.translate('Import Session package'),
                  properties: ['openFile'] as ['openFile'],
                  filters: [{ name: 'Open-Science Session', extensions: ['science'] }]
                }
                const selected = await this.nativeDialog(
                  desktopFileInteraction().chooseFiles(options, callerId),
                  signal
                )
                if (selected.canceled || !selected.filePaths[0]) {
                  this.operations.cancel()
                  signal.throwIfAborted()
                }
                selectedInput = selected.filePaths[0]
              }
            )
          } finally {
            release?.()
          }
        },
        target,
        () => Boolean(importFile?.recovery),
        useCase,
        undefined,
        options?.agent
      )
      .then(async (result) => {
        await importFile?.onReleased?.()
        return result
      })
      .catch(async (error) => {
        if (!importFile) await releaseSource?.()
        if (
          operationSignal?.aborted &&
          !this.shutdown.signal.aborted &&
          !this.operations.snapshot?.result?.recovery &&
          !importFile?.recovery
        ) {
          await importFile?.onReleased?.()
          return null
        }
        throw error
      })
  }
}
