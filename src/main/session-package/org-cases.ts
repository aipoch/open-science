import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DownloadChecksumError,
  DownloadSourceError,
  resilientDownload
} from '@aipoch/resilient-download'
import type { LabView } from '../../shared/lab'
import {
  buildLabConnectionKey,
  isAllowedOrgCaseDownloadUrl,
  isValidOrgCaseId,
  type CancelOrgCaseImportResult,
  type GetOrgCaseDetailResult,
  type ImportOrgCaseResult,
  type ListOrgCasesQuery,
  type ListOrgCasesResult,
  type OrgCaseDetail,
  type OrgCaseDownloadSnapshot,
  type OrgCaseDownloadTicket,
  type OrgCaseErrorCode,
  type OrgCasesPage
} from '../../shared/org-cases'
import { PACKAGE_MAX_BYTES } from '../../shared/session-package'
import type { UploadOrgCaseInput } from '../settings/lab-api'
import { assertPackageCapacity, PackageCapacityError } from './capacity'

type LabErrorShape = Error & {
  code?: string
  status?: number
  reason?: string
}

export type OrgCaseServiceOptions = {
  getLabView: () => LabView
  listLabCases: (query: ListOrgCasesQuery, signal?: AbortSignal) => Promise<OrgCasesPage>
  getLabCase: (caseId: string, signal?: AbortSignal) => Promise<OrgCaseDetail>
  getLabCaseDownload: (caseId: string, signal?: AbortSignal) => Promise<OrgCaseDownloadTicket>
  uploadLabCase?: (input: UploadOrgCaseInput, signal?: AbortSignal) => Promise<OrgCaseDetail>
  enqueuePackageFile: (
    path: string,
    onReleased?: () => void,
    validateBeforeTarget?: boolean
  ) => Promise<boolean>
  isImportBusy?: () => boolean
  cancelQueuedFile?: (path: string) => Promise<void> | void
  publishDownloadChanged?: (snapshot: OrgCaseDownloadSnapshot | null) => void
  downloadFetch?: typeof fetch
  download?: typeof resilientDownload
  assertCapacity?: typeof assertPackageCapacity
  tempRootDir?: string
  now?: () => number
}

export class OrgCaseFailure extends Error {
  constructor(
    readonly errorCode: OrgCaseErrorCode,
    message?: string
  ) {
    super(message ?? errorCode)
    this.name = 'OrgCaseFailure'
  }
}

type ActiveDownload = {
  caseId: string
  serverUrl?: string
  epoch: number
  controller: AbortController
  userCancelled?: boolean
  tempDir?: string
  handedOff: boolean
  name: string
  code: string
  snapshot: OrgCaseDownloadSnapshot
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.name === 'AbortError') return true
  return (error as LabErrorShape).code === 'cancelled'
}

function asLabError(error: unknown): LabErrorShape | null {
  if (!(error instanceof Error)) return null
  const shape = error as LabErrorShape
  if (typeof shape.code === 'string' || typeof shape.status === 'number') {
    return shape
  }
  return null
}

function mapAuthUnavailableCode(view: LabView): OrgCaseErrorCode {
  if (view.state === 'unconfigured') return 'unconfigured'
  if (view.state === 'expired') return 'expired'
  if (view.state === 'unreachable') return 'network'
  if (view.state === 'blocked') {
    const code = view.error?.code
    if (
      code === 'license-inactive' ||
      code === 'seat-required' ||
      code === 'org-inactive' ||
      code === 'account-disabled'
    ) {
      return code
    }
    return 'signed-out'
  }
  return 'signed-out'
}

function buildSafePackageFilename(name: string, code: string, caseId: string): string {
  const sanitizedCode = code.replace(/[^A-Za-z0-9_-]/g, '')
  const sanitizedName = Array.from(name)
    .map((char) => (char.charCodeAt(0) < 32 ? ' ' : char))
    .join('')
    .replace(/[<>:"/\\|?*]+/g, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/^\.+/, '')
    .slice(0, 48)
    .replace(/-+$/, '')
  const stem = [sanitizedName, sanitizedCode].filter(Boolean).join('-') || `org-case-${caseId}`
  return `${stem}.science`
}

function createAnonymousDownloadFetch(baseFetch: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const headers = new Headers(input instanceof Request ? input.headers : undefined)
    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => headers.set(key, value))
    }
    headers.delete('authorization')
    headers.delete('cookie')
    const response = await baseFetch(url, {
      ...init,
      headers,
      credentials: 'omit',
      redirect: 'error'
    })
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      throw new DownloadSourceError('Presigned download must not redirect')
    }
    if (!response.url) {
      try {
        Object.defineProperty(response, 'url', {
          value: url,
          configurable: true
        })
      } catch {
        // Ignore read-only URL properties on custom Response objects.
      }
    }
    return response
  }
}

export class OrgCaseService {
  private connectionKey: string
  private connectionEpoch = 0
  private disposed = false
  private activeListController: AbortController | null = null
  private readonly detailControllers = new Set<AbortController>()
  private readonly uploadControllers = new Set<AbortController>()
  private activeDownload: ActiveDownload | null = null

  constructor(private readonly options: OrgCaseServiceOptions) {
    this.connectionKey = buildLabConnectionKey(options.getLabView())
  }

  handleLabViewChanged(view: LabView = this.options.getLabView()): void {
    const nextKey = buildLabConnectionKey(view)
    if (nextKey === this.connectionKey) return
    this.connectionKey = nextKey
    this.connectionEpoch += 1
    this.abortAllOperations()
  }

  hasActiveDownload(): boolean {
    return this.activeDownload !== null
  }

  async listCases(query: ListOrgCasesQuery = {}): Promise<ListOrgCasesResult> {
    this.syncConnectionState()
    if (this.disposed) return { ok: false, errorCode: 'cancelled' }

    const view = this.options.getLabView()
    if (view.state !== 'authenticated') {
      return { ok: false, errorCode: mapAuthUnavailableCode(view) }
    }

    const startServerUrl = view.serverUrl
    this.activeListController?.abort()
    const controller = new AbortController()
    this.activeListController = controller
    const epoch = this.connectionEpoch

    try {
      const page = await this.options.listLabCases(query, controller.signal)
      this.syncConnectionState()
      const currentView = this.options.getLabView()
      if (
        !this.disposed &&
        currentView.state === 'expired' &&
        currentView.serverUrl === startServerUrl
      ) {
        return { ok: false, errorCode: 'expired' }
      }
      if (this.disposed || epoch !== this.connectionEpoch || controller.signal.aborted) {
        return { ok: false, errorCode: 'cancelled' }
      }
      return { ok: true, page }
    } catch (error) {
      this.syncConnectionState()
      const currentView = this.options.getLabView()
      if (
        !this.disposed &&
        currentView.state === 'expired' &&
        currentView.serverUrl === startServerUrl
      ) {
        return { ok: false, errorCode: 'expired' }
      }
      if (this.disposed || epoch !== this.connectionEpoch || controller.signal.aborted) {
        return { ok: false, errorCode: 'cancelled' }
      }
      return { ok: false, errorCode: this.mapLabError(error) }
    } finally {
      if (this.activeListController === controller) {
        this.activeListController = null
      }
    }
  }

  async getCase(caseId: string): Promise<GetOrgCaseDetailResult> {
    this.syncConnectionState()
    if (this.disposed) return { ok: false, errorCode: 'cancelled' }
    if (!isValidOrgCaseId(caseId)) {
      return { ok: false, errorCode: 'not-found' }
    }

    const view = this.options.getLabView()
    if (view.state !== 'authenticated') {
      return { ok: false, errorCode: mapAuthUnavailableCode(view) }
    }

    const startServerUrl = view.serverUrl
    const controller = new AbortController()
    this.detailControllers.add(controller)
    const epoch = this.connectionEpoch

    try {
      const detail = await this.options.getLabCase(caseId, controller.signal)
      this.syncConnectionState()
      const currentView = this.options.getLabView()
      if (
        !this.disposed &&
        currentView.state === 'expired' &&
        currentView.serverUrl === startServerUrl
      ) {
        return { ok: false, errorCode: 'expired' }
      }
      if (this.disposed || epoch !== this.connectionEpoch || controller.signal.aborted) {
        return { ok: false, errorCode: 'cancelled' }
      }
      return { ok: true, case: detail }
    } catch (error) {
      this.syncConnectionState()
      const currentView = this.options.getLabView()
      if (
        !this.disposed &&
        currentView.state === 'expired' &&
        currentView.serverUrl === startServerUrl
      ) {
        return { ok: false, errorCode: 'expired' }
      }
      if (this.disposed || epoch !== this.connectionEpoch || controller.signal.aborted) {
        return { ok: false, errorCode: 'cancelled' }
      }
      return { ok: false, errorCode: this.mapLabError(error) }
    } finally {
      this.detailControllers.delete(controller)
    }
  }

  async uploadCase(input: UploadOrgCaseInput, signal?: AbortSignal): Promise<OrgCaseDetail> {
    this.syncConnectionState()
    if (this.disposed || signal?.aborted) {
      throw new OrgCaseFailure('cancelled')
    }

    const view = this.options.getLabView()
    if (view.state !== 'authenticated') {
      throw new OrgCaseFailure(mapAuthUnavailableCode(view))
    }
    if (!this.options.uploadLabCase) {
      throw new OrgCaseFailure('unconfigured')
    }

    const startServerUrl = view.serverUrl
    const controller = new AbortController()
    this.uploadControllers.add(controller)
    const epoch = this.connectionEpoch
    const combinedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal

    try {
      const detail = await this.options.uploadLabCase(input, combinedSignal)
      this.syncConnectionState()
      const currentView = this.options.getLabView()
      if (
        !this.disposed &&
        currentView.state === 'expired' &&
        currentView.serverUrl === startServerUrl
      ) {
        throw new OrgCaseFailure('expired')
      }
      if (this.disposed || epoch !== this.connectionEpoch || combinedSignal.aborted) {
        throw new OrgCaseFailure('cancelled')
      }
      return detail
    } catch (error) {
      this.syncConnectionState()
      if (signal?.aborted) {
        throw new OrgCaseFailure('cancelled')
      }
      const currentView = this.options.getLabView()
      if (
        !this.disposed &&
        currentView.state === 'expired' &&
        currentView.serverUrl === startServerUrl
      ) {
        throw new OrgCaseFailure('expired')
      }
      if (
        !this.disposed &&
        epoch !== this.connectionEpoch &&
        currentView.state !== 'authenticated'
      ) {
        throw new OrgCaseFailure(mapAuthUnavailableCode(currentView))
      }
      if (this.disposed || epoch !== this.connectionEpoch || controller.signal.aborted) {
        throw new OrgCaseFailure('cancelled')
      }
      throw new OrgCaseFailure(this.mapLabError(error))
    } finally {
      this.uploadControllers.delete(controller)
    }
  }

  async importCase(caseId: string): Promise<ImportOrgCaseResult> {
    this.syncConnectionState()
    if (this.disposed) return { status: 'cancelled', caseId }
    if (!isValidOrgCaseId(caseId)) {
      return { status: 'failed', caseId, errorCode: 'not-found' }
    }

    const view = this.options.getLabView()
    if (view.state !== 'authenticated') {
      return { status: 'failed', caseId, errorCode: mapAuthUnavailableCode(view) }
    }

    if (this.activeDownload || (this.options.isImportBusy?.() ?? false)) {
      return { status: 'failed', caseId, errorCode: 'import-busy' }
    }

    const epoch = this.connectionEpoch
    const controller = new AbortController()
    const run: ActiveDownload = {
      caseId,
      serverUrl: view.serverUrl,
      epoch,
      controller,
      handedOff: false,
      name: caseId,
      code: '',
      snapshot: {
        caseId,
        name: caseId,
        code: '',
        state: 'preparing',
        completedBytes: 0
      }
    }
    this.activeDownload = run
    this.publish(run.snapshot)

    let ticket: OrgCaseDownloadTicket | undefined

    try {
      ticket = await this.options.getLabCaseDownload(caseId, controller.signal)
      this.ensureDownloadStillCurrent(run)

      run.name = ticket.name
      run.code = ticket.code
      run.snapshot = {
        caseId,
        name: ticket.name,
        code: ticket.code,
        state: 'preparing',
        completedBytes: 0,
        totalBytes: ticket.size_bytes
      }
      this.publish(run.snapshot)

      if (!isAllowedOrgCaseDownloadUrl(ticket.url)) {
        throw new OrgCaseFailure('invalid-response')
      }

      const now = this.options.now ?? Date.now
      const expiresAtMs = Date.parse(ticket.expires_at)
      if (!Number.isFinite(expiresAtMs)) {
        throw new OrgCaseFailure('invalid-response')
      }
      if (now() >= expiresAtMs) {
        throw new OrgCaseFailure('url-expired')
      }

      if (ticket.size_bytes <= 0) {
        throw new OrgCaseFailure('invalid-response')
      }
      if (ticket.size_bytes > PACKAGE_MAX_BYTES) {
        throw new OrgCaseFailure('capacity')
      }

      const tempDir = await mkdtemp(
        join(this.options.tempRootDir ?? tmpdir(), 'open-science-org-case-')
      )
      run.tempDir = tempDir
      this.ensureDownloadStillCurrent(run)

      const checkCapacity = this.options.assertCapacity ?? assertPackageCapacity
      await checkCapacity(tempDir, ticket.size_bytes)
      this.ensureDownloadStillCurrent(run)

      const destPath = join(tempDir, buildSafePackageFilename(ticket.name, ticket.code, caseId))
      const anonymousFetch = createAnonymousDownloadFetch(
        this.options.downloadFetch ?? globalThis.fetch
      )
      const downloadFile = this.options.download ?? resilientDownload

      run.snapshot = {
        caseId,
        name: ticket.name,
        code: ticket.code,
        state: 'downloading',
        completedBytes: 0,
        totalBytes: ticket.size_bytes
      }
      this.publish(run.snapshot)

      let lastReportedBytes = -1
      await downloadFile(ticket.url, destPath, {
        expectedSha256: ticket.sha256,
        expectedSize: ticket.size_bytes,
        expectedOrigin: new URL(ticket.url).origin,
        maxRetries: 0,
        signal: controller.signal,
        fetchImpl: anonymousFetch,
        onProgress: (progress) => {
          if (this.disposed || epoch !== this.connectionEpoch || controller.signal.aborted) return
          const completedBytes = Math.min(Math.max(0, progress.transferred), ticket!.size_bytes)
          const nextState = completedBytes >= ticket!.size_bytes ? 'verifying' : 'downloading'
          if (completedBytes === lastReportedBytes && run.snapshot.state === nextState) return
          lastReportedBytes = completedBytes
          run.snapshot = {
            caseId,
            name: ticket!.name,
            code: ticket!.code,
            state: nextState,
            completedBytes,
            totalBytes: ticket!.size_bytes
          }
          this.publish(run.snapshot)
        }
      })

      this.ensureDownloadStillCurrent(run)

      run.snapshot = {
        caseId,
        name: ticket.name,
        code: ticket.code,
        state: 'verifying',
        completedBytes: ticket.size_bytes,
        totalBytes: ticket.size_bytes
      }
      this.publish(run.snapshot)

      const fileStat = await stat(destPath)
      if (fileStat.size !== ticket.size_bytes) {
        throw new OrgCaseFailure('verification-failed')
      }

      this.ensureDownloadStillCurrent(run)
      if (this.options.isImportBusy?.()) {
        throw new OrgCaseFailure('import-busy')
      }

      const releaseTempDir = (): Promise<void> =>
        rm(tempDir, { recursive: true, force: true }).catch(() => undefined)

      const accepted = await this.options.enqueuePackageFile(destPath, releaseTempDir, true)
      if (!accepted) {
        await releaseTempDir()
        if (this.disposed || epoch !== this.connectionEpoch || controller.signal.aborted) {
          throw new OrgCaseFailure('cancelled')
        }
        throw new OrgCaseFailure('import-busy')
      }

      this.syncConnectionState()
      if (this.disposed || run.epoch !== this.connectionEpoch || run.controller.signal.aborted) {
        await this.options.cancelQueuedFile?.(destPath)
        await releaseTempDir()
        throw new OrgCaseFailure('cancelled')
      }

      run.handedOff = true
      if (this.activeDownload === run) {
        this.activeDownload = null
      }
      this.publish({
        caseId,
        name: ticket.name,
        code: ticket.code,
        state: 'handed-off',
        completedBytes: ticket.size_bytes,
        totalBytes: ticket.size_bytes
      })
      return { status: 'handed-off', caseId }
    } catch (error) {
      const errorCode = this.mapDownloadError(error, run, ticket)
      if (this.activeDownload === run) {
        this.activeDownload = null
      }
      if (!run.handedOff && run.tempDir) {
        await rm(run.tempDir, { recursive: true, force: true }).catch(() => undefined)
        run.tempDir = undefined
      }
      if (errorCode === 'cancelled') {
        if (epoch === this.connectionEpoch && !this.disposed) {
          this.publish({
            caseId,
            name: run.name,
            code: run.code,
            state: 'cancelled',
            completedBytes: run.snapshot.completedBytes,
            ...(run.snapshot.totalBytes !== undefined
              ? { totalBytes: run.snapshot.totalBytes }
              : {})
          })
        }
        return { status: 'cancelled', caseId }
      }
      if (epoch === this.connectionEpoch && !this.disposed) {
        this.publish({
          caseId,
          name: run.name,
          code: run.code,
          state: 'failed',
          completedBytes: run.snapshot.completedBytes,
          ...(run.snapshot.totalBytes !== undefined ? { totalBytes: run.snapshot.totalBytes } : {}),
          errorCode
        })
      }
      return { status: 'failed', caseId, errorCode }
    } finally {
      if (this.activeDownload === run) {
        this.activeDownload = null
      }
      if (!run.handedOff && run.tempDir) {
        await rm(run.tempDir, { recursive: true, force: true }).catch(() => undefined)
        run.tempDir = undefined
      }
    }
  }

  cancelImport(caseId?: string): CancelOrgCaseImportResult {
    const active = this.activeDownload
    if (!active) return { cancelled: false }
    if (caseId && active.caseId !== caseId) return { cancelled: false }
    active.userCancelled = true
    active.controller.abort()
    return { cancelled: true }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.connectionEpoch += 1
    this.abortAllOperations()
  }

  private syncConnectionState(): void {
    this.handleLabViewChanged(this.options.getLabView())
  }

  private abortAllOperations(): void {
    this.activeListController?.abort()
    this.activeListController = null

    for (const controller of this.detailControllers) {
      controller.abort()
    }
    this.detailControllers.clear()

    for (const controller of this.uploadControllers) {
      controller.abort()
    }
    this.uploadControllers.clear()

    const active = this.activeDownload
    if (active) {
      active.controller.abort()
      if (this.disposed && !active.handedOff && active.tempDir) {
        const dir = active.tempDir
        active.tempDir = undefined
        void rm(dir, { recursive: true, force: true }).catch(() => undefined)
      }
      this.activeDownload = null
    }
    this.publish(null)
  }

  private ensureDownloadStillCurrent(run: ActiveDownload): void {
    this.syncConnectionState()
    if (this.disposed || run.epoch !== this.connectionEpoch || run.controller.signal.aborted) {
      throw new OrgCaseFailure('cancelled')
    }
  }

  private publish(snapshot: OrgCaseDownloadSnapshot | null): void {
    this.options.publishDownloadChanged?.(snapshot)
  }

  private mapLabError(error: unknown): OrgCaseErrorCode {
    if (error instanceof OrgCaseFailure) return error.errorCode
    if (isAbortError(error)) return 'cancelled'

    const labError = asLabError(error)
    if (!labError) return 'unknown'

    const reason = labError.reason?.toUpperCase()
    if (reason === 'STORAGE_NOT_CONFIGURED') return 'storage-not-configured'
    if (reason === 'STORAGE_UNAVAILABLE') return 'storage-unavailable'
    if (reason === 'CASE_NOT_FOUND' || reason === 'INVALID_ID') return 'not-found'
    if (reason === 'NO_ORGANIZATION') return 'no-organization'
    if (reason === 'ROLE_REQUIRED') return 'forbidden'
    if (reason === 'LICENSE_INACTIVE') return 'license-inactive'
    if (reason === 'SEAT_REQUIRED') return 'seat-required'
    if (reason === 'ORG_INACTIVE') return 'org-inactive'
    if (reason === 'ACCOUNT_DISABLED') return 'account-disabled'
    if (reason === 'UNAUTHENTICATED' || reason === 'SESSION_INVALID') return 'expired'
    if (reason === 'UPLOAD_IN_PROGRESS') return 'upload-in-progress'
    if (reason === 'UPLOAD_TIMEOUT') return 'upload-timeout'
    if (reason === 'PACKAGE_TOO_LARGE' || reason === 'REQUEST_TOO_LARGE') return 'package-too-large'
    if (reason === 'UNSUPPORTED_PACKAGE') return 'unsupported-package'
    if (reason === 'PACKAGE_INVALID' || reason === 'INVALID_REQUEST') return 'package-invalid'

    if (labError.status === 400) return 'invalid-response'
    if (labError.status === 403) return 'forbidden'
    if (labError.status === 404) return 'not-found'
    if (labError.status === 408) return 'upload-timeout'
    if (labError.status === 413) return 'package-too-large'
    if (labError.status === 422) return 'unsupported-package'
    if (labError.status === 429) return 'rate-limited'
    if (labError.status === 503) return 'storage-unavailable'
    if (labError.status === 401 || labError.code === 'unauthorized') {
      const view = this.options.getLabView()
      if (view.state === 'unconfigured') return 'unconfigured'
      if (view.state === 'signedOut' || view.state === 'signingIn') return 'signed-out'
      return 'expired'
    }

    switch (labError.code) {
      case 'forbidden':
      case 'license-inactive':
      case 'seat-required':
      case 'org-inactive':
      case 'account-disabled':
      case 'rate-limited':
      case 'network':
      case 'timeout':
      case 'cancelled':
      case 'invalid-response':
        return labError.code
      default:
        return 'unknown'
    }
  }

  private mapDownloadError(
    error: unknown,
    run: ActiveDownload,
    ticket?: OrgCaseDownloadTicket
  ): OrgCaseErrorCode {
    this.syncConnectionState()
    const currentView = this.options.getLabView()
    if (
      !this.disposed &&
      !run.userCancelled &&
      currentView.state === 'expired' &&
      currentView.serverUrl === run.serverUrl
    ) {
      return 'expired'
    }
    if (this.disposed || run.epoch !== this.connectionEpoch || run.controller.signal.aborted) {
      return 'cancelled'
    }
    if (error instanceof OrgCaseFailure) return error.errorCode
    if (error instanceof PackageCapacityError) return 'capacity'
    if (error instanceof DownloadChecksumError) return 'verification-failed'
    if (isAbortError(error)) return 'cancelled'

    if (error instanceof DownloadSourceError) {
      const causeMessage = error.cause instanceof Error ? error.cause.message : ''
      const details = `${error.message} ${causeMessage}`
      if (/redirect|origin/i.test(details)) {
        return 'invalid-response'
      }
      const now = this.options.now ?? Date.now
      const expiresAtMs = ticket ? Date.parse(ticket.expires_at) : Number.NaN
      if ((Number.isFinite(expiresAtMs) && now() >= expiresAtMs) || /\b403\b/.test(details)) {
        return 'url-expired'
      }
      if (/\b404\b/.test(details)) {
        return 'not-found'
      }
      if (/\b5\d\d\b/.test(details)) {
        return 'storage-unavailable'
      }
      if (/short read|checksum|sha-?256|size|content-length/i.test(details)) {
        return 'verification-failed'
      }
      if (/stalled|timeout/i.test(details)) {
        return 'timeout'
      }
      return 'network'
    }
    if (error instanceof Error && /short read/i.test(error.message)) {
      return 'verification-failed'
    }

    return this.mapLabError(error)
  }
}
