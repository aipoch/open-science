import { randomUUID } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { redactSensitiveText } from '../../shared/diagnostic-redaction'
import {
  PACKAGE_MAX_BYTES,
  sessionPackageImportRequestSchema,
  sessionPackageRequestSchema,
  type SessionPackageImportRequest,
  type SessionPackagePreview,
  type SessionPackageRequest
} from '../../shared/session-package'
import type { CallerContext } from '../caller-context'
import { publishUserFile } from '../user-file-publisher'
import {
  SessionPackageExternalError,
  type SessionPackageExternalMethod,
  type SessionPackageExternalPort
} from '../session-package-external-port'
import { PackageCleanupPendingError } from './cleanup'
import type { SessionPackageService } from './service'

const packagePath = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (path) =>
      isAbsolute(path) && !path.includes('\0') && extname(path).toLowerCase() === '.science',
    'An absolute .science file path is required.'
  )
const preflightSchema = z
  .object({
    filePath: packagePath,
    target: sessionPackageImportRequestSchema.refine(
      (target) => Boolean(target.projectId || target.projectName),
      'Choose the import Project explicitly.'
    )
  })
  .strict()
const tokenSchema = z.object({ preflightId: z.string().uuid() }).strict()
const exportSchema = sessionPackageRequestSchema
  .extend({
    filePath: packagePath,
    excludedStorageKeys: z.array(z.string().max(2048)).max(10000).default([]),
    includePdfNotes: z.boolean().default(false)
  })
  .strict()
export type HeadlessPackageImportPreview = {
  preflightId: string
  filename: string
  target: SessionPackageImportRequest
  preview: SessionPackagePreview
  expiresAt: number
}
export type SessionPackageHeadlessDependencies = {
  service: Pick<SessionPackageService, 'importFrom' | 'exportTo'>
  assertCanStart(): void
  withDataRootWrite<T>(operation: () => Promise<T>): Promise<T>
  reserveExport(request: SessionPackageRequest, signal: AbortSignal): Promise<() => void>
  reserveImport(projectId: string, signal: AbortSignal): Promise<() => void>
  afterImport(
    identity: SessionPackageRequest,
    originClientId: string,
    projectCreated: boolean
  ): Promise<void>
  /** Trusted Main configuration, never a request field. */
  previewLifetimeMs?: number
  now?: () => number
}
type PendingImport = {
  id: string
  caller: CallerContext
  controller: AbortController
  state: 'inspecting' | 'reviewing' | 'committing' | 'completed' | 'cancelled' | 'failed'
  expiresAt: number
  approve(): void
  completion: Promise<SessionPackageRequest>
  timer?: ReturnType<typeof setTimeout>
}
const error = (code: SessionPackageExternalError['code'], message: string): never => {
  throw new SessionPackageExternalError(code, message)
}
const assertCaller = (caller?: CallerContext): CallerContext => {
  if (!caller?.isAuthorizationCurrent())
    return error('unauthorized', 'Current caller authorization is required.')
  if (caller.location !== 'local')
    return error(
      'unsupported_location',
      'Package paths are only available on the receiving local device.'
    )
  return caller
}
const sameCaller = (left: CallerContext, right: CallerContext): boolean =>
  left.clientId === right.clientId &&
  left.leaseId === right.leaseId &&
  left.surface === right.surface &&
  left.principalKind === right.principalKind

/** Shares the existing package inspection/staging/commit owner. Waiting for explicit commit stays
 * at its confirm callback: no imported Project/Session is published during preflight.
 */
export class SessionPackageHeadless implements SessionPackageExternalPort {
  private readonly shutdown = new AbortController()
  private readonly imports = new Map<string, PendingImport>()
  private readonly pendingCleanup = new Set<() => Promise<void>>()
  private transfer?: Promise<unknown>
  private readonly lifetime: number

  constructor(private readonly dependencies: SessionPackageHeadlessDependencies) {
    this.lifetime = dependencies.previewLifetimeMs ?? 10 * 60_000
    if (!Number.isSafeInteger(this.lifetime) || this.lifetime < 1 || this.lifetime > 30 * 60_000)
      throw new Error('Invalid package preview lifetime.')
  }

  hasActiveTransfer(): boolean {
    return this.transfer !== undefined
  }

  async close(): Promise<void> {
    this.shutdown.abort(new Error('Package transfers are closing.'))
    for (const pending of this.imports.values()) clearTimeout(pending.timer)
    await this.transfer?.catch(() => undefined)
    await this.retryCleanup()
    this.imports.clear()
  }

  async call(
    method: SessionPackageExternalMethod,
    payload: unknown,
    caller?: CallerContext
  ): Promise<unknown> {
    const context = assertCaller(caller)
    try {
      this.shutdown.signal.throwIfAborted()
      switch (method) {
        case 'preflightImport':
          return await this.preflightImport(preflightSchema.parse(payload), context)
        case 'commitImport':
          return await this.commitImport(tokenSchema.parse(payload).preflightId, context)
        case 'cancelImport':
          return await this.cancelImport(tokenSchema.parse(payload).preflightId, context)
        case 'export':
          return await this.export(exportSchema.parse(payload), context)
        default:
          return error('invalid_request', 'Unknown package transfer method.')
      }
    } catch (failure) {
      if (failure instanceof SessionPackageExternalError) throw failure
      if (failure instanceof z.ZodError)
        return error('invalid_request', 'Invalid package transfer request.')
      return error(
        'conflict',
        redactSensitiveText(
          failure instanceof Error ? failure.message : 'Package transfer failed.'
        ).slice(0, 1500)
      )
    }
  }

  private async retryCleanup(): Promise<void> {
    for (const cleanup of this.pendingCleanup) {
      await cleanup()
      this.pendingCleanup.delete(cleanup)
    }
  }

  private async acceptCleanup<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (failure) {
      if (!(failure instanceof PackageCleanupPendingError)) throw failure
      this.pendingCleanup.add(failure.retryCleanup)
      if ('error' in failure.outcome) throw failure.outcome.error
      return failure.outcome.value as T
    }
  }

  private assertCanStart(): void {
    this.shutdown.signal.throwIfAborted()
    this.dependencies.assertCanStart()
    if (this.transfer) error('conflict', 'Finish or cancel the current package transfer first.')
  }

  private async preflightImport(
    request: z.output<typeof preflightSchema>,
    caller: CallerContext
  ): Promise<HeadlessPackageImportPreview> {
    this.assertCanStart()
    const id = randomUUID()
    const controller = new AbortController()
    const signal = AbortSignal.any([this.shutdown.signal, controller.signal])
    let present!: (preview: HeadlessPackageImportPreview) => void
    let failPreview!: (reason: unknown) => void
    const preview = new Promise<HeadlessPackageImportPreview>((resolve, reject) => {
      present = resolve
      failPreview = reject
    })
    let approve!: () => void
    const approved = new Promise<void>((resolve) => {
      approve = resolve
    })
    const pending: PendingImport = {
      id,
      caller,
      controller,
      state: 'inspecting',
      expiresAt: 0,
      approve,
      completion: Promise.resolve({ projectId: '', sessionId: '' })
    }
    const completion = Promise.resolve().then(async () => {
      let release: (() => void) | undefined
      try {
        await this.retryCleanup()
        assertCaller(caller)
        const file = await lstat(request.filePath)
        if (!file.isFile() || file.size > PACKAGE_MAX_BYTES)
          error(
            'invalid_request',
            'Package source must be a regular file within the archive limit.'
          )
        if (request.target.projectId)
          release = await this.dependencies.reserveImport(request.target.projectId, signal)
        signal.throwIfAborted()
        const imported = await this.dependencies.withDataRootWrite(() =>
          this.acceptCleanup(() =>
            this.dependencies.service.importFrom(
              request.filePath,
              signal,
              undefined,
              async (inspected, budgetSignal) => {
                assertCaller(caller)
                const confirmationSignal = AbortSignal.any([signal, budgetSignal])
                confirmationSignal.throwIfAborted()
                pending.state = 'reviewing'
                pending.expiresAt = (this.dependencies.now?.() ?? Date.now()) + this.lifetime
                pending.timer = setTimeout(
                  () =>
                    controller.abort(new Error('Package preview expired; inspect the file again.')),
                  this.lifetime
                )
                pending.timer.unref?.()
                present({
                  preflightId: id,
                  filename: basename(request.filePath),
                  target: structuredClone(request.target),
                  preview: structuredClone(inspected),
                  expiresAt: pending.expiresAt
                })
                let abort!: () => void
                try {
                  await Promise.race([
                    approved,
                    new Promise<never>((_resolve, reject) => {
                      abort = () => reject(confirmationSignal.reason)
                      confirmationSignal.addEventListener('abort', abort, { once: true })
                    })
                  ])
                  confirmationSignal.throwIfAborted()
                  assertCaller(caller)
                } finally {
                  confirmationSignal.removeEventListener('abort', abort)
                }
              },
              request.target
            )
          )
        )
        pending.state = 'completed'
        try {
          await this.dependencies.afterImport(
            imported,
            caller.lifecycleClientId,
            !request.target.projectId
          )
        } catch {
          /* Notification transport cannot undo a committed package import. */
        }
        return imported
      } catch (failure) {
        pending.state = signal.aborted ? 'cancelled' : 'failed'
        failPreview(failure)
        throw failure
      } finally {
        clearTimeout(pending.timer)
        release?.()
        if (this.transfer === completion) this.transfer = undefined
      }
    })
    pending.completion = completion
    void completion.catch(() => undefined)
    this.transfer = completion
    this.imports.set(id, pending)
    // Keep bounded completed handles for transport retries; a completed handle never imports again.
    for (const [key, old] of this.imports) {
      if (this.imports.size <= 32) break
      if (old !== pending && !['inspecting', 'reviewing', 'committing'].includes(old.state))
        this.imports.delete(key)
    }
    return preview
  }

  private findImport(id: string, caller: CallerContext): PendingImport {
    const pending = this.imports.get(id)
    if (!pending || !sameCaller(pending.caller, caller))
      return error('not_found', 'Package preflight was not found for this caller.')
    assertCaller(pending.caller)
    return pending
  }

  private async commitImport(id: string, caller: CallerContext): Promise<unknown> {
    const pending = this.findImport(id, caller)
    if (pending.state === 'reviewing') {
      if ((this.dependencies.now?.() ?? Date.now()) >= pending.expiresAt) {
        pending.controller.abort(new Error('Package preview expired.'))
        return error('conflict', 'Package preview expired; inspect the file again.')
      }
      this.dependencies.assertCanStart()
      pending.state = 'committing'
      clearTimeout(pending.timer)
      pending.approve()
    } else if (!['committing', 'completed'].includes(pending.state)) {
      return error('conflict', 'Package preflight is not ready for commit.')
    }
    const imported = await pending.completion
    assertCaller(caller)
    return { ...imported, cleanupPending: this.pendingCleanup.size > 0 }
  }

  private async cancelImport(id: string, caller: CallerContext): Promise<{ cancelled: boolean }> {
    const pending = this.findImport(id, caller)
    if (pending.state === 'completed') return { cancelled: false }
    if (pending.state === 'committing')
      return error('conflict', 'Package import is already committing.')
    pending.controller.abort(new Error('Package preflight was cancelled.'))
    await pending.completion.catch(() => undefined)
    return { cancelled: true }
  }

  private async export(
    request: z.output<typeof exportSchema>,
    caller: CallerContext
  ): Promise<unknown> {
    this.assertCanStart()
    const operation = Promise.resolve().then(async () => {
      await this.retryCleanup()
      assertCaller(caller)
      const parent = await realpath(dirname(request.filePath))
      const parentIdentity = await lstat(parent)
      const destination = join(parent, basename(request.filePath))
      const existing = await lstat(destination).catch((failure: NodeJS.ErrnoException) => {
        if (failure.code === 'ENOENT') return undefined
        throw failure
      })
      if (existing)
        return error('conflict', 'Export destination already exists; choose a new file.')
      const signal = this.shutdown.signal
      const scope = { projectId: request.projectId, sessionId: request.sessionId }
      const release = await this.dependencies.reserveExport(scope, signal)
      try {
        let preview: SessionPackagePreview | undefined
        await this.dependencies.withDataRootWrite(() =>
          publishUserFile(
            destination,
            async (temporary) => {
              assertCaller(caller)
              preview = await this.acceptCleanup(() =>
                this.dependencies.service.exportTo(scope, temporary, {
                  signal,
                  selectFiles: async () => ({
                    excludedStorageKeys: request.excludedStorageKeys,
                    includePdfNotes: request.includePdfNotes
                  })
                })
              )
            },
            {
              exclusive: true,
              validateDestination: async () => {
                signal.throwIfAborted()
                assertCaller(caller)
                const current = await lstat(parent)
                if (
                  (await realpath(dirname(request.filePath))) !== parent ||
                  current.dev !== parentIdentity.dev ||
                  current.ino !== parentIdentity.ino
                )
                  throw new Error('Export directory changed during transfer.')
              }
            }
          )
        )
        return { filePath: destination, preview, cleanupPending: this.pendingCleanup.size > 0 }
      } finally {
        release()
      }
    })
    this.transfer = operation
    try {
      return await operation
    } finally {
      if (this.transfer === operation) this.transfer = undefined
    }
  }
}
