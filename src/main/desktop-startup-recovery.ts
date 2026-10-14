import { recoverInstallationAfterSystemRestart } from './update/installation-reboot-recovery'
import { resumeBoundInstallationExecutor } from './update/installation-executor'
import { acquireRuntimeDirectorySync } from './runtime-ownership'
import { waitForRuntimeStopped } from './runtime-stop-confirmation'
import type { RuntimeStartupIssue } from '../shared/runtime-startup'
import type { RuntimeStartupOptions } from './desktop-runtime-info'
import type { DesktopRuntimeClient } from './desktop-runtime-client'
import { RuntimeStoppingError, waitForDesktopRuntimeControl } from './desktop-runtime-recovery'
import {
  checkInstallationResultAsync,
  finishInstallationRecoveryAsync,
  inspectInstallationUpdate,
  inspectInstallationStartupAsync,
  completeInstallationStartupAsync,
  type InstallationLocation
} from './update/installation-protection'

/** Carries display-safe state; authenticated handles and credentials stay in the closure. */
export class DesktopRuntimeStartupError extends Error {
  private stopOperation?: Promise<void>
  constructor(
    readonly issue: RuntimeStartupIssue,
    message: string,
    private readonly stop?: () => Promise<void>,
    private readonly recheck?: () => Promise<void>,
    readonly startupOptions?: RuntimeStartupOptions
  ) {
    super(message)
    this.name = 'DesktopRuntimeStartupError'
  }

  withRetryDiagnostics(diagnostics: string): DesktopRuntimeStartupError {
    return new DesktopRuntimeStartupError(
      {
        ...this.issue,
        diagnostics
      },
      'Startup recovery was not confirmed.',
      () => this.stopAndContinue(),
      () => this.recover(),
      this.startupOptions
    )
  }

  async recover(): Promise<void> {
    if (!this.issue.canRecover || !this.recheck) throw this
    await this.recheck()
  }

  async stopAndContinue(): Promise<void> {
    if (!this.issue.canStop || !this.stop) throw this
    this.stopOperation ??= this.stop().catch((error) => {
      this.stopOperation = undefined
      throw error
    })
    await this.stopOperation
  }
}

/** Retry the original endpoint only; a failed attachment never authorizes a replacement service. */
export async function connectDesktopRuntimeForStartup(options: {
  connect(signal: AbortSignal): Promise<DesktopRuntimeClient>
  version: string
  timeoutMs?: number
  // Replaces a Runtime that is stopping with a fresh one. Without it, a stopping Runtime is only
  // reported as a recoverable failure.
  replaceRuntime?: () => Promise<void>
}): Promise<DesktopRuntimeClient> {
  let candidate: DesktopRuntimeClient | undefined
  let needsReplacement = false
  const attempt = async (): Promise<DesktopRuntimeClient> => {
    const signal = AbortSignal.timeout(options.timeoutMs ?? 12_000)
    candidate = await options.connect(signal)
    await waitForDesktopRuntimeControl(candidate, signal)
    return candidate
  }
  const replace = async (): Promise<void> => {
    if (!options.replaceRuntime) throw new Error('The Runtime is shutting down.')
    await options.replaceRuntime()
  }
  try {
    try {
      return await attempt()
    } catch (error) {
      // A Runtime that already began shutting down is never reused: stop it and launch a fresh one.
      if (!(error instanceof RuntimeStoppingError) || !options.replaceRuntime) throw error
      needsReplacement = true
      candidate?.close()
      candidate = undefined
      await replace()
      return await attempt()
    }
  } catch (error) {
    candidate?.close()
    throw new DesktopRuntimeStartupError(
      {
        reason: 'startup-recovery-required',
        desktopVersion: options.version,
        canStop: false,
        canRecover: true,
        diagnostics: error instanceof Error ? error.message : 'Desktop attachment failed.'
      },
      'The Runtime connection or control could not be confirmed.',
      undefined,
      // Recovery does real work: replace a stopping Runtime; the startup owner then re-verifies.
      async () => {
        if (needsReplacement || error instanceof RuntimeStoppingError) await replace()
      }
    )
  }
}

export async function resolveDesktopInstallationStartup(
  options: InstallationLocation & { version: string; allowedProcessIds?: () => number[] }
): Promise<
  | {
      startupOptions: RuntimeStartupOptions
      operationId: string
      outcome: 'installed' | 'recovered'
      completeBeforeLaunch(): Promise<void>
      completeAfterReady(): Promise<void>
    }
  | undefined
> {
  const blocked = (diagnostics: string): DesktopRuntimeStartupError =>
    new DesktopRuntimeStartupError(
      {
        reason: 'startup-recovery-required',
        desktopVersion: options.version,
        canStop: false,
        canRecover: true,
        diagnostics
      },
      'The installation needs recovery before Open-Science can start.',
      undefined,
      async () => {
        const record = inspectInstallationUpdate(options)
        if (!record) {
          await resolveDesktopInstallationStartup(options)
          return
        }
        if (
          await recoverInstallationAfterSystemRestart(options, record.operationId, {
            version: options.version,
            allowedProcessIds: options.allowedProcessIds
          })
        )
          return
        const result = await checkInstallationResultAsync(options).catch(async (error) => {
          if (record.phase !== 'handoff' || !record.executor) throw error
          await resumeBoundInstallationExecutor(options, record.operationId)
          return checkInstallationResultAsync(options)
        })
        if (
          record.phase === 'handoff' &&
          result === 'verified' &&
          record.targetVersion === options.version
        )
          return
        if (result !== 'unchanged') throw blocked(diagnostics)
        // Cancel only after an exact clean stop. A dead PID alone cannot settle old teardown.
        const lease =
          record.phase === 'handoff' && record.stoppedClean
            ? acquireRuntimeDirectorySync(record.runtime.configRoot)
            : await waitForRuntimeStopped({
                configRoot: record.runtime.configRoot,
                generation: record.runtime.generation,
                pid: record.runtime.pid
              })
        try {
          await finishInstallationRecoveryAsync(options, record.operationId, 'cancel')
        } finally {
          lease.release()
        }
      }
    )
  // Launch-time verification failures are recoverable startup states, never fatal errors.
  const recoverable = async (verify: () => Promise<void>): Promise<void> => {
    try {
      await verify()
    } catch (error) {
      if (error instanceof DesktopRuntimeStartupError) throw error
      throw blocked(
        error instanceof Error
          ? `The installation could not be verified before launch: ${error.message}`
          : 'The installation could not be verified before launch.'
      )
    }
  }
  try {
    const record = inspectInstallationUpdate(options)
    if (!record) {
      const ticket = await inspectInstallationStartupAsync(options)
      if (!ticket) return undefined
      if (ticket.manifest.version !== options.version)
        throw blocked('The verified startup belongs to a different application version.')
      return {
        startupOptions: ticket.startupOptions,
        operationId: ticket.operationId,
        outcome: ticket.intent === 'complete' ? 'installed' : 'recovered',
        completeBeforeLaunch: () =>
          recoverable(async () => {
            await inspectInstallationStartupAsync(options)
          }),
        completeAfterReady: () => completeInstallationStartupAsync(options, ticket.operationId)
      }
    }
    // An accepted handoff alone proves neither file integrity nor service readiness.
    if (
      record.phase !== 'handoff' ||
      record.targetVersion !== options.version ||
      (await checkInstallationResultAsync(options)) !== 'verified'
    )
      throw blocked(
        'Installation replacement is incomplete or unverified. Repair this installation with its original installer before starting it.'
      )
    return {
      startupOptions: record.startupOptions,
      operationId: record.operationId,
      outcome: 'installed',
      completeBeforeLaunch: () =>
        recoverable(async () => {
          // Re-check the exact operation and the complete target manifest at launch time.
          await finishInstallationRecoveryAsync(options, record.operationId, 'complete')
        }),
      completeAfterReady: () => completeInstallationStartupAsync(options, record.operationId)
    }
  } catch (error) {
    if (error instanceof DesktopRuntimeStartupError) throw error
    throw blocked(
      'The installation recovery record or installed files could not be verified. No service was started.'
    )
  }
}
