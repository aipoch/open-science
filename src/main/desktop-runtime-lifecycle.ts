import { waitForLifecycleSettlement } from './lifecycle-settlement'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { ActiveSessionInfo } from '../shared/storage'
import type { ShutdownStepOutcome } from './lifecycle-shutdown'

// Process-local quit coordination. This token describes observed work, not persisted ownership;
// only the desktop holding the actual started child requests preparation or shutdown.
export const desktopLifecycleRequestSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('inspect') }).strict(),
  z.object({ operation: z.literal('cancel-migration') }).strict(),
  z.object({ operation: z.literal('hold') }).strict(),
  z
    .object({ operation: z.literal('prepare'), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) })
    .strict(),
  z.object({ operation: z.literal('abort') }).strict(),
  z.object({ operation: z.literal('release') }).strict()
])
export type DesktopLifecycleRequest = z.infer<typeof desktopLifecycleRequestSchema>
export type DesktopShutdownWork = {
  sessions: ActiveSessionInfo[]
  reviewerActive: boolean
  settingsInstallId?: string
  migrationActive: boolean
  packageTransferActive: boolean
  fingerprint: string
}

export function createDesktopRuntimeLifecycle(deps: {
  detectActiveSessions(): ActiveSessionInfo[]
  hasActiveReviewerWork(): boolean
  getActiveSettingsInstallId(): string | undefined
  isMigrationInProgress(): boolean
  cancelMigrationForQuit?(): Promise<void>
  hasActivePackageTransfer(): boolean
  holdSettingsInstallAdmission(): () => void
  prepareForQuit(): Promise<Extract<ShutdownStepOutcome, 'completed' | 'timeout' | 'failed'>>
  abortQuitPreparation(): void
}): { request(operation: DesktopLifecycleRequest): Promise<unknown>; disconnect(): Promise<void> } {
  let releaseAdmission: (() => void) | undefined
  let preparing = false
  let prepared = false
  let disconnected = false
  let inFlight: Promise<unknown> | undefined
  const inspect = (): DesktopShutdownWork => {
    const state = {
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
    releaseAdmission?.()
    releaseAdmission = undefined
  }
  const abort = (): void => {
    if (prepared || preparing) deps.abortQuitPreparation()
    prepared = false
    release()
  }
  return {
    disconnect: async () => {
      disconnected = true
      await inFlight?.catch(() => undefined)
      await waitForLifecycleSettlement()
      abort()
    },
    request: (operation) => {
      if (inFlight && operation.operation !== 'inspect')
        return Promise.reject(new Error('Desktop lifecycle operation is still running.'))
      const run = async (): Promise<unknown> => {
        const request = desktopLifecycleRequestSchema.parse(operation)
        if (disconnected) throw new Error('Desktop lifecycle attachment is closed.')
        switch (request.operation) {
          case 'cancel-migration':
            if (!deps.cancelMigrationForQuit)
              throw new Error('Migration cancellation is unavailable.')
            await deps.cancelMigrationForQuit()
            return null
          case 'inspect':
            return inspect()
          case 'hold':
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
            const work = inspect()
            if (work.fingerprint !== request.fingerprint)
              throw new Error(
                'Running work changed after quit confirmation. Review the current work before trying again.'
              )
            if (work.migrationActive || work.packageTransferActive)
              throw new Error(
                'Wait for the data move or Session package transfer to finish before quitting.'
              )
            releaseAdmission ??= deps.holdSettingsInstallAdmission()
            preparing = true
            try {
              const result = await deps.prepareForQuit()
              prepared = true
              if (disconnected) throw new Error('Desktop disconnected during quit preparation.')
              return result
            } finally {
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
