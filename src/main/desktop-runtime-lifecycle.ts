import { ApplicationCommandError } from '../shared/application-command-contract'
import { hasPendingLifecycleSettlement, waitForLifecycleSettlement } from './lifecycle-settlement'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { ActiveSessionInfo } from '../shared/storage'
import type { ShutdownStepOutcome } from './lifecycle-shutdown'
import { LOCAL_SERVICE_STOP_ESCALATION_MS, serviceStopDeadline } from './local-service-lifetime'

// Installation update authority is deliberately separate from the exclusive lifecycle controller.
export const installationUpdateRequestSchema = z
  .object({
    operationId: z.string().uuid(),
    shutdownDeadlineAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
  })
  .strict()

// Process-local quit coordination. This token describes observed work, not persisted ownership;
// only the desktop holding the actual started child requests preparation or shutdown.
export const desktopLifecycleRequestSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('inspect') }).strict(),
  z.object({ operation: z.literal('cancel-migration') }).strict(),
  z.object({ operation: z.literal('hold') }).strict(),
  z
    .object({
      operation: z.literal('prepare'),
      fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      preserveService: z.boolean().optional(),
      deadlineAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
      attemptId: z.string().uuid().optional()
    })
    .strict(),
  z.object({ operation: z.literal('abort'), attemptId: z.string().uuid().optional() }).strict(),
  z.object({ operation: z.literal('release') }).strict()
])
const DISCONNECT_WAIT_MS = 10_000
export type DesktopLifecycleRequest = z.infer<typeof desktopLifecycleRequestSchema>
export type DesktopShutdownWork = {
  preserveService?: boolean
  sessions: ActiveSessionInfo[]
  reviewerActive: boolean
  settingsInstallId?: string
  migrationActive: boolean
  packageTransferActive: boolean
  fingerprint: string
}

/** Consent covers interruption of work, not every later change to the task rows. */
export function desktopQuitImpactChanged(
  previous: DesktopShutdownWork | undefined,
  next: DesktopShutdownWork
): boolean {
  if (!previous || Boolean(previous.preserveService) !== Boolean(next.preserveService)) return true
  if (next.settingsInstallId !== undefined && previous.settingsInstallId !== next.settingsInstallId)
    return true
  const active = (work: DesktopShutdownWork): boolean =>
    work.sessions.length > 0 || work.reviewerActive
  return !active(previous) && active(next)
}

export function createDesktopRuntimeLifecycle(
  deps: {
    detectActiveSessions(): ActiveSessionInfo[]
    hasActiveReviewerWork(): boolean
    getActiveSettingsInstallId(): string | undefined
    isMigrationInProgress(): boolean
    cancelMigrationForQuit?(): Promise<void>
    hasActivePackageTransfer(): boolean
    holdSettingsInstallAdmission(): () => void
    prepareForQuit(): Promise<Extract<ShutdownStepOutcome, 'completed' | 'timeout' | 'failed'>>
    abortQuitPreparation(): void
  },
  options: { disconnectWaitMs?: number } = {}
): {
  request(
    operation: DesktopLifecycleRequest,
    options?: { preserveService?: boolean }
  ): Promise<unknown>
  disconnect(): Promise<void>
} {
  let releaseAdmission: (() => void) | undefined
  let preparing = false
  let prepared = false
  let inspectedWork: DesktopShutdownWork | undefined
  let disconnected = false
  let inFlight: Promise<unknown> | undefined
  const inspect = (preserveService = false): DesktopShutdownWork => {
    const state = {
      preserveService,
      sessions: deps.detectActiveSessions(),
      reviewerActive: deps.hasActiveReviewerWork(),
      settingsInstallId: deps.getActiveSettingsInstallId(),
      migrationActive: deps.isMigrationInProgress(),
      packageTransferActive: deps.hasActivePackageTransfer()
    }
    return {
      ...state,
      fingerprint: createHash('sha256').update(JSON.stringify(state)).digest('hex')
    }
  }
  const release = (): void => {
    // A timeout only ends the Desktop's wait. Keep installations fenced until the underlying
    // cleanup settles, and capture this hold so late release cannot reopen a newer quit's hold.
    const releaseCurrent = releaseAdmission
    releaseAdmission = undefined
    if (!releaseCurrent) return
    if (hasPendingLifecycleSettlement()) void waitForLifecycleSettlement().then(releaseCurrent)
    else releaseCurrent()
  }
  const abort = (): void => {
    if (prepared || preparing) deps.abortQuitPreparation()
    prepared = false
    release()
  }
  return {
    disconnect: async () => {
      disconnected = true
      // Cleanup is bounded: an operation that never settles must not keep the Desktop fenced out.
      const wait = options.disconnectWaitMs ?? DISCONNECT_WAIT_MS
      const deadlineAt = Date.now() + wait
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        inFlight?.catch(() => undefined),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, wait)
          timer.unref?.()
        })
      ])
      clearTimeout(timer)
      await waitForLifecycleSettlement({ timeoutMs: Math.max(0, deadlineAt - Date.now()) })
      abort()
    },
    request: (operation, requestOptions) => {
      if (inFlight && !['inspect', 'abort', 'release'].includes(operation.operation))
        return Promise.reject(new Error('Desktop lifecycle operation is still running.'))
      const run = async (): Promise<unknown> => {
        const request = desktopLifecycleRequestSchema.parse(operation)
        if (disconnected) throw new Error('Desktop lifecycle attachment is closed.')
        switch (request.operation) {
          case 'cancel-migration':
            if (requestOptions?.preserveService) return null
            if (!deps.cancelMigrationForQuit)
              throw new Error('Migration cancellation is unavailable.')
            await deps.cancelMigrationForQuit()
            return null
          case 'inspect':
            return (inspectedWork = inspect(requestOptions?.preserveService))
          case 'hold':
            if (requestOptions?.preserveService) return null
            releaseAdmission ??= deps.holdSettingsInstallAdmission()
            return null
          case 'release':
            release()
            return null
          case 'abort':
            abort()
            return null
          case 'prepare': {
            if (preparing) throw new Error('Desktop quit preparation is already running.')
            if (requestOptions?.preserveService) return 'completed'
            // A decision to leave tasks running cannot authorize stopping them after a hold or
            // another App disappears. Return before producer cleanup; Desktop refreshes and confirms.
            if (request.preserveService ?? inspectedWork?.preserveService) return 'scope-changed'
            const work = inspect()
            if (
              work.settingsInstallId &&
              (inspectedWork?.fingerprint !== request.fingerprint ||
                inspectedWork.settingsInstallId !== work.settingsInstallId)
            )
              throw new ApplicationCommandError(
                'command-unavailable',
                'Wait for the settings installation to finish before quitting.'
              )
            if (work.migrationActive || work.packageTransferActive)
              throw new ApplicationCommandError(
                'command-unavailable',
                'Wait for the data move or Session package transfer to finish before quitting.'
              )
            releaseAdmission ??= deps.holdSettingsInstallAdmission()
            preparing = true
            // Preparation can close ACP admission and then reject. That attempt still needs an
            // abort, just like a timeout or a completed preparation followed by a refused quit.
            prepared = true
            let timer: ReturnType<typeof setTimeout> | undefined
            try {
              const preparation = deps.prepareForQuit()
              const result =
                request.deadlineAt === undefined
                  ? await preparation
                  : await Promise.race([
                      preparation,
                      new Promise<'timeout'>((resolve) => {
                        timer = setTimeout(
                          () => resolve('timeout'),
                          Math.max(
                            0,
                            serviceStopDeadline(request.deadlineAt) -
                              LOCAL_SERVICE_STOP_ESCALATION_MS -
                              Date.now()
                          )
                        )
                        timer.unref?.()
                      })
                    ])
              if (disconnected) throw new Error('Desktop disconnected during quit preparation.')
              return result
            } finally {
              clearTimeout(timer)
              preparing = false
            }
          }
        }
      }
      const result = run()
      if (operation.operation !== 'inspect') {
        inFlight = result
        void result
          .finally(() => {
            if (inFlight === result) inFlight = undefined
          })
          .catch(() => undefined)
      }
      return result
    }
  }
}
