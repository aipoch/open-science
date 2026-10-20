import { recoverInstallationAfterSystemRestart } from './update/installation-reboot-recovery'
import type { DebSystemdGate } from './update/deb-systemd-gate'
import { resumeBoundInstallationExecutor } from './update/installation-executor'
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { UpdateLifecycleError, type UpdateApplyOptions, type UpdateStatus } from '../shared/update'
import type { DesktopRuntimeClient } from './desktop-runtime-client'
import type { RuntimeStartupOptions } from './desktop-runtime-info'
import type { RuntimeDirectoryLease } from './runtime-ownership'
import { RuntimeStopError, isRuntimeProcessAlive } from './runtime-stop-confirmation'
import type { CreateStrategyOptions } from './update/create-strategy'
import {
  advanceInstallationUpdate,
  advanceInstallationUpdateAsync,
  beginInstallationUpdateAsync,
  checkInstallationResultAsync,
  finishInstallationRecoveryAsync,
  completeInstallationStartupAsync,
  inspectInstallationUpdate,
  inspectInstallationAvailability,
  installationRecoveryStatus,
  installationRootForEntry,
  type InstallationLocation,
  type InstallationManifest,
  type InstallationUpdateRecord
} from './update/installation-protection'
import type { InstallReadiness } from './update/strategy'

/** A cancelled read must not keep its caller or a subsequent recovery action waiting. */
async function boundedRead<T>(read: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  try {
    return await Promise.race([
      read,
      new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason)
        signal.addEventListener('abort', onAbort, { once: true })
        timer = setTimeout(
          () => reject(new Error('The service readiness check timed out.')),
          15_000
        )
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}

/** Owns the reversible service stop separately from irreversible installer handoff. */
export function createDesktopUpdateIntegration(options: {
  location: InstallationLocation
  client(): DesktopRuntimeClient
  currentVersion: string
  allowedProcessIds(): number[]
  verifyArtifact(status: UpdateStatus, signal?: AbortSignal): Promise<InstallationManifest>
  // True when the downloaded channel lacks supervised-replacement acceptance. Such installs keep
  // the pre-supervision electron-updater handoff behind the same runtime stop and occupancy checks.
  legacyInstall?(status: UpdateStatus): boolean
  preparedDebGate?(): DebSystemdGate | undefined
  verifyInstallerReady?(): Promise<void>
  flushRenderer?(phase: 'preflight' | 'final'): Promise<void>
  validateConfiguration(config: RuntimeStartupOptions): void
  setClosing(value: boolean): void
  retainLease(lease: RuntimeDirectoryLease): void
  restart(config: RuntimeStartupOptions): Promise<void>
  reconnectOriginal?(): Promise<void>
  onHandoff(): void
  onStopped(): void
  onProgress?(status: Partial<UpdateStatus>): void
}): Pick<
  CreateStrategyOptions,
  | 'prepareInstall'
  | 'installGate'
  | 'beforeInstallHandoff'
  | 'cancelInstall'
  | 'recoverInstall'
  | 'recheckInstall'
  | 'releaseInstallHandoff'
> {
  let record: InstallationUpdateRecord | undefined = inspectInstallationUpdate(options.location)
  let legacy: { config: RuntimeStartupOptions; stopped: boolean } | undefined
  let consent: { token: string; generation: string } | undefined
  let pending: Promise<unknown> | undefined
  let cancellation = new AbortController()
  let cancelRequested = false
  const checkCancellation = (): void => {
    if (cancelRequested)
      throw new UpdateLifecycleError('user-cancelled', 'Installation was cancelled before handoff.')
  }
  let pendingRestart:
    | {
        config: RuntimeStartupOptions
        outcome: UpdateStatus['outcome']
        state: UpdateStatus['state']
        operationId: string
      }
    | undefined
  const recovery = (): ReturnType<typeof installationRecoveryStatus> | undefined =>
    record && installationRecoveryStatus(record)
  const exclusive = async <T>(run: () => Promise<T>): Promise<T> => {
    if (pending)
      throw new UpdateLifecycleError(
        'installation-busy',
        'An installation action is still running.',
        recovery()
      )
    const operation = run()
    pending = operation
    try {
      return await operation
    } finally {
      if (pending === operation) pending = undefined
    }
  }
  const publish = (): void => {
    options.onProgress?.({ recovery: recovery() })
  }
  const reset: Partial<UpdateStatus> = {
    error: undefined,
    outcome: undefined,
    diagnostics: undefined,
    reason: undefined,
    recovery: undefined,
    cliConfirmation: undefined,
    blockedBy: undefined,
    blockedTasks: undefined,
    canForce: undefined
  }
  const recover = (cancel: boolean): Promise<Partial<UpdateStatus>> =>
    exclusive(async () => {
      if (pendingRestart) {
        await options.restart(pendingRestart.config)
        await completeInstallationStartupAsync(options.location, pendingRestart.operationId)
        const result = { ...reset, state: pendingRestart.state, outcome: pendingRestart.outcome }
        pendingRestart = undefined
        options.setClosing(false)
        return result
      }
      if (!record) {
        consent = undefined
        if (legacy) {
          const active = legacy
          legacy = undefined
          try {
            if (active.stopped) await options.restart(active.config)
            else await options.client().invokeHost('desktop:update-abort')
          } finally {
            options.setClosing(false)
          }
        }
        return { ...reset, state: 'ready', outcome: 'cancelled' }
      }
      options.onProgress?.({
        recovery: {
          ...installationRecoveryStatus(record),
          phase: cancel ? 'cancelling' : 'recovering'
        }
      })
      const old = record
      const reboot = await recoverInstallationAfterSystemRestart(
        options.location,
        old.operationId,
        {
          version: options.currentVersion,
          allowedProcessIds: options.allowedProcessIds
        }
      )
      let result: 'unchanged' | 'verified' | 'incomplete'
      let intent: 'cancel' | 'complete'
      let config: RuntimeStartupOptions
      let liveRecovered = false
      if (reboot) {
        result = reboot.intent === 'complete' ? 'verified' : 'unchanged'
        intent = reboot.intent
        config = reboot.startupOptions
      } else {
        result = await checkInstallationResultAsync(options.location).catch(async (error) => {
          if (old.phase !== 'handoff' || !old.executor) throw error
          await resumeBoundInstallationExecutor(options.location, old.operationId)
          return checkInstallationResultAsync(options.location)
        })
        if (result === 'incomplete')
          return {
            reason: 'install-failed',
            recovery: {
              ...installationRecoveryStatus(old),
              installation: result,
              canCancel: false,
              canRetryInstall: false
            }
          }
        if (old.phase === 'stopping' && isRuntimeProcessAlive(old.runtime.pid)) {
          if (!options.reconnectOriginal)
            throw new UpdateLifecycleError(
              'runtime-stop-timeout',
              'The original service is still alive. Reconnect to it and finish its pending shutdown before recovering.',
              recovery()
            )
          await options.reconnectOriginal()
          const active = options.client()
          const info = await active.refreshControl()
          if (
            active.processId() !== old.runtime.pid ||
            info.generation !== old.runtime.generation ||
            info.control !== 'granted' ||
            JSON.stringify(info.startupOptions) !== JSON.stringify(old.startupOptions)
          )
            throw new UpdateLifecycleError(
              'runtime-not-controlled',
              'The original service identity or control could not be recovered.',
              recovery()
            )
          // Server rejects this during shutdown or unsettled lifecycle operations, including on a new socket.
          await active.invokeHost('desktop:update-abort')
          liveRecovered = true
        }
        if (old.phase === 'stopping' && !liveRecovered) {
          // A stop timeout is not a permanent verdict: repeat the generation/PID/lock proof.
          // Failed or missing exit evidence stays protected; no automatic task replay or PID kill.
          let lease: RuntimeDirectoryLease
          try {
            lease = await options.client().waitForStopped()
          } catch (cause) {
            if (!(cause instanceof RuntimeStopError)) throw cause
            options.onProgress?.({
              diagnostics: JSON.stringify(
                { code: cause.code, message: cause.message, evidence: cause.evidence },
                null,
                2
              )
            })
            throw new UpdateLifecycleError(
              cause.code,
              'The service exited without verified clean shutdown. Do not install or restart it while child processes or pending work remain. Close the original clients, inspect the Runtime shutdown logs and remaining processes, and repair the incomplete shutdown before checking again.',
              {
                ...installationRecoveryStatus(old),
                runtime: cause.code === 'runtime-stop-unclean' ? 'stopped-unclean' : 'unknown',
                canRetryInstall: false,
                canRecover: true
              },
              { cause }
            )
          }
          options.retainLease(lease)
          record = advanceInstallationUpdate(options.location, old.operationId, 'stopped', true)
          options.onStopped()
        }
        // Abort the still-live task gate before clearing protection. A stopped host must never be called.
        if (old.phase === 'preparing') await options.client().invokeHost('desktop:update-abort')
        intent = result === 'verified' && !cancel ? 'complete' : 'cancel'
        config = await finishInstallationRecoveryAsync(options.location, old.operationId, intent)
      }
      record = undefined
      pendingRestart = {
        config,
        operationId: old.operationId,
        state: intent === 'complete' ? 'up-to-date' : 'ready',
        outcome: intent === 'complete' ? 'installed' : cancel ? 'cancelled' : 'recovered'
      }
      if (reboot || (old.phase !== 'preparing' && !liveRecovered)) {
        try {
          await options.restart(config)
        } catch (cause) {
          throw new UpdateLifecycleError(
            'install-failed',
            'The installation was verified, but the service or original data is not ready.',
            {
              phase: 'recovering',
              runtime: 'unknown',
              installation: result,
              canCancel: false,
              canRetryInstall: false,
              canRecover: true
            },
            { cause }
          )
        }
      }
      await completeInstallationStartupAsync(options.location, old.operationId)
      const resultStatus = {
        ...reset,
        state: pendingRestart.state,
        outcome: pendingRestart.outcome
      }
      pendingRestart = undefined
      options.setClosing(false)
      return resultStatus
    })
  const legacyGate = async (
    active: NonNullable<typeof legacy>,
    apply: UpdateApplyOptions | undefined
  ): Promise<InstallReadiness> => {
    options.setClosing(true)
    try {
      await options.flushRenderer?.('preflight')
      checkCancellation()
      const result = (await options
        .client()
        .invokeHost('desktop:update-gate', [apply ?? {}])) as InstallReadiness
      if (!result.completed || !result.reaped) {
        options.setClosing(false)
        return result
      }
      checkCancellation()
      await options.flushRenderer?.('final')
      checkCancellation()
      options.onProgress?.({
        recovery: {
          phase: 'stopping',
          runtime: 'running',
          installation: 'unchanged',
          canCancel: false,
          canRecover: false,
          canRetryInstall: false
        }
      })
      const lease = await options.client().stopRuntime()
      options.retainLease(lease)
      active.stopped = true
      options.onStopped()
      return result
    } catch (error) {
      if (!active.stopped) {
        await options
          .client()
          .invokeHost('desktop:update-abort')
          .catch(() => undefined)
        options.setClosing(false)
      }
      if (error instanceof RuntimeStopError) {
        options.onProgress?.({
          diagnostics: JSON.stringify(
            { code: error.code, message: error.message, evidence: error.evidence },
            null,
            2
          )
        })
        throw new UpdateLifecycleError(error.code, error.message, undefined, { cause: error })
      }
      throw error
    }
  }
  return {
    prepareInstall: (status, apply = {}) =>
      exclusive(async () => {
        cancelRequested = false
        cancellation = new AbortController()
        legacy = undefined
        if (pendingRestart)
          return {
            reason: 'install-failed',
            recovery: {
              phase: 'recovering',
              runtime: 'unknown',
              installation: 'unchanged',
              canCancel: false,
              canRecover: true,
              canRetryInstall: false
            }
          }
        if (record) {
          if (record.phase === 'handoff') return { reason: 'install-failed', recovery: recovery() }
          if (record.phase === 'stopping')
            return { reason: 'runtime-stop-unclean', recovery: recovery() }
          if (record.phase === 'preparing') {
            const active = options.client()
            const current = active.runtimeInfo()
            if (
              current.control !== 'granted' ||
              current.generation !== record.runtime.generation ||
              active.processId() !== record.runtime.pid ||
              JSON.stringify(current.startupOptions) !== JSON.stringify(record.startupOptions)
            )
              throw new UpdateLifecycleError(
                'runtime-not-controlled',
                'The confirmed service configuration has changed.',
                recovery()
              )
            options.validateConfiguration(current.startupOptions)
          }
          return undefined
        }
        const client = options.client()
        const info = client.runtimeInfo()
        if (info.control !== 'granted')
          throw new UpdateLifecycleError(
            'runtime-not-controlled',
            'Another Desktop controls this service.',
            {
              phase: 'preparing',
              runtime: 'running',
              installation: 'unchanged',
              canCancel: true,
              canRecover: false,
              canRetryInstall: false,
              detail:
                info.controlReason === 'operation-pending' ? 'operation-pending' : 'controller-held'
            }
          )
        options.validateConfiguration(info.startupOptions)
        if (info.launch === 'cli') {
          if (
            !consent ||
            consent.generation !== info.generation ||
            apply.cliConsentToken !== consent.token
          ) {
            consent = { token: randomUUID(), generation: info.generation }
            return {
              cliConfirmation: {
                token: consent.token,
                pid: client.processId(),
                port: info.startupOptions.port,
                source:
                  realpathSync(installationRootForEntry(info.entryPath)) ===
                  realpathSync(options.location.installationRoot)
                    ? 'this-installation'
                    : 'another-installation',
                entryPath: info.entryPath
              }
            }
          }
        }
        if (!status.latest)
          throw new UpdateLifecycleError('install-failed', 'The target version is unavailable.')
        options.onProgress?.({
          cliConfirmation: undefined,
          recovery: {
            phase: 'preparing',
            runtime: 'running',
            installation: 'unchanged',
            canCancel: true,
            canRecover: false,
            canRetryInstall: false
          }
        })
        if (options.legacyInstall?.(status)) {
          // Same occupancy proof as a supervised install: never replace files another runtime uses.
          await inspectInstallationAvailability(
            {
              ...options.location,
              runtime: {
                pid: client.processId(),
                generation: info.generation,
                configRoot: info.startupOptions.configRoot
              },
              allowedProcessIds: options.allowedProcessIds()
            },
            cancellation.signal
          )
          checkCancellation()
          legacy = { config: info.startupOptions, stopped: false }
          return undefined
        }
        const targetManifest = await options.verifyArtifact(status, cancellation.signal)
        checkCancellation()
        record = await beginInstallationUpdateAsync(
          {
            ...options.location,
            currentVersion: options.currentVersion,
            targetVersion: status.latest,
            targetManifest,
            preparedDebGate: options.preparedDebGate?.(),
            runtime: {
              pid: client.processId(),
              generation: info.generation,
              configRoot: info.startupOptions.configRoot
            },
            startupOptions: info.startupOptions,
            allowedProcessIds: options.allowedProcessIds()
          },
          cancellation.signal
        )
        consent = undefined
        publish()
        return undefined
      }),
    installGate: (apply) =>
      exclusive(async () => {
        checkCancellation()
        if (legacy) return legacyGate(legacy, apply)
        if (!record)
          throw new UpdateLifecycleError('install-failed', 'Installation protection is missing.')
        if (record.phase === 'stopped' && record.stoppedClean)
          return { completed: true, reaped: true, recovery: recovery() }
        if (record.phase !== 'preparing')
          throw new UpdateLifecycleError(
            'install-failed',
            'The installation requires recovery.',
            recovery()
          )
        await options.verifyInstallerReady?.()
        checkCancellation()
        options.setClosing(true)
        let stopped = false
        try {
          await options.flushRenderer?.('preflight')
          checkCancellation()
          const result = (await options
            .client()
            .invokeHost('desktop:update-gate', [apply ?? {}])) as InstallReadiness
          if (!result.completed || !result.reaped) {
            options.setClosing(false)
            return { ...result, recovery: recovery() }
          }
          checkCancellation()
          await options.flushRenderer?.('final')
          checkCancellation()
          record = advanceInstallationUpdate(options.location, record.operationId, 'stopping')
          publish()
          const lease = await options.client().stopRuntime()
          options.retainLease(lease)
          record = advanceInstallationUpdate(options.location, record.operationId, 'stopped', true)
          stopped = true
          options.onStopped()
          publish()
          return { ...result, recovery: recovery() }
        } catch (error) {
          // Any failure before a confirmed stop must not leave the app locked in its closing state.
          if (!stopped) options.setClosing(false)
          if (error instanceof RuntimeStopError) {
            options.onProgress?.({
              diagnostics: JSON.stringify(
                { code: error.code, message: error.message, evidence: error.evidence },
                null,
                2
              )
            })
            throw new UpdateLifecycleError(error.code, error.message, recovery(), { cause: error })
          }
          throw error
        }
      }),
    beforeInstallHandoff: async () => {
      checkCancellation()
      return exclusive(async () => {
        checkCancellation()
        if (legacy) {
          options.onProgress?.({
            recovery: {
              phase: 'handoff',
              runtime: 'stopped-clean',
              installation: 'unchanged',
              canCancel: false,
              canRecover: false,
              canRetryInstall: false
            }
          })
          options.onHandoff()
          return
        }
        if (!record)
          throw new UpdateLifecycleError('install-failed', 'Installation protection is missing.')
        record = await advanceInstallationUpdateAsync(
          options.location,
          record.operationId,
          'handoff',
          undefined,
          { allowedProcessIds: options.allowedProcessIds(), signal: cancellation.signal }
        )
        options.onHandoff()
        publish()
      })
    },
    cancelInstall: async () => {
      cancelRequested = true
      cancellation.abort()
      // Teardown cannot be undone while still settling. Wait for its proof, then restore service.
      while (pending) {
        await pending.catch(() => undefined)
        await Promise.resolve()
      }
      return recover(true)
    },
    recoverInstall: () => recover(false),
    recheckInstall: () =>
      exclusive(async () => {
        cancellation = new AbortController()
        const checking = cancellation.signal
        options.onProgress?.({
          outcome: undefined,
          recovery: {
            phase: 'checking',
            runtime: record?.stoppedClean ? 'stopped-clean' : 'running',
            installation: 'unchanged',
            canCancel: record?.phase !== 'handoff',
            canRetryInstall: false,
            canRecover: Boolean(record)
          }
        })
        try {
          if (pendingRestart)
            return {
              reason: 'install-failed',
              recovery: {
                phase: 'recovering',
                runtime: 'unknown',
                installation: 'unchanged',
                canCancel: false,
                canRetryInstall: false,
                canRecover: true
              }
            }
          if (record && record.phase !== 'preparing') {
            if (record.phase === 'stopping' && !isRuntimeProcessAlive(record.runtime.pid)) {
              try {
                const lease = await options.client().waitForStopped()
                options.retainLease(lease)
                record = advanceInstallationUpdate(
                  options.location,
                  record.operationId,
                  'stopped',
                  true
                )
                options.onStopped()
              } catch (error) {
                if (!(error instanceof RuntimeStopError)) throw error
                checking.throwIfAborted()
                return {
                  ...reset,
                  reason: error.code,
                  diagnostics: JSON.stringify(
                    { code: error.code, message: error.message, evidence: error.evidence },
                    null,
                    2
                  ),
                  recovery: {
                    ...installationRecoveryStatus(record),
                    runtime: 'stopped-unclean',
                    canRetryInstall: false
                  }
                }
              }
            }
            await inspectInstallationAvailability(
              {
                ...options.location,
                ...(record.phase === 'stopping' ? { runtime: record.runtime } : {}),
                allowedProcessIds: options.allowedProcessIds()
              },
              checking
            )
            const installation = await checkInstallationResultAsync(options.location, checking)
            checking.throwIfAborted()
            return {
              ...reset,
              reason:
                installation === 'incomplete'
                  ? 'install-failed'
                  : record.phase === 'stopping'
                    ? 'runtime-stop-timeout'
                    : undefined,
              recovery: { ...installationRecoveryStatus(record), installation }
            }
          }
          const client = options.client()
          const info = await boundedRead(client.refreshControl(), checking)
          checking.throwIfAborted()
          if (info.control !== 'granted')
            return {
              ...reset,
              reason: 'runtime-not-controlled',
              recovery: {
                phase: 'preparing',
                runtime: 'running',
                installation: 'unchanged',
                canCancel: true,
                canRecover: false,
                canRetryInstall: false,
                detail:
                  info.controlReason === 'operation-pending'
                    ? 'operation-pending'
                    : 'controller-held'
              }
            }
          if (
            record &&
            (record.runtime.pid !== client.processId() ||
              record.runtime.generation !== info.generation ||
              JSON.stringify(record.startupOptions) !== JSON.stringify(info.startupOptions))
          )
            throw new UpdateLifecycleError(
              'runtime-not-controlled',
              'The confirmed service changed; cancel this update before checking a replacement service.'
            )
          options.validateConfiguration(info.startupOptions)
          await inspectInstallationAvailability(
            {
              ...options.location,
              runtime: {
                pid: client.processId(),
                generation: info.generation,
                configRoot: info.startupOptions.configRoot
              },
              allowedProcessIds: options.allowedProcessIds()
            },
            checking
          )
          const current = (await boundedRead(
            client.invokeHost('desktop:update-inspect'),
            checking
          )) as InstallReadiness
          checking.throwIfAborted()
          return {
            ...reset,
            reason: current.reason ?? (current.blockedBy?.length ? 'active-work' : undefined),
            blockedBy: current.blockedBy,
            blockedTasks: current.blockedTasks,
            canForce: current.canForce === true,
            recovery: {
              ...(recovery() ?? {
                phase: 'preparing' as const,
                runtime: 'running' as const,
                installation: 'unchanged' as const,
                canCancel: true,
                canRecover: false
              }),
              canRetryInstall: !current.reason && !current.blockedBy?.length
            }
          }
        } catch (error) {
          checking.throwIfAborted()
          return {
            ...reset,
            reason: error instanceof UpdateLifecycleError ? error.reason : 'runtime-not-controlled',
            error:
              error instanceof Error ? error.message : 'The current service could not be checked.',
            recovery:
              error instanceof UpdateLifecycleError && error.recovery
                ? error.recovery
                : {
                    ...(recovery() ?? {
                      phase: 'preparing',
                      runtime: 'running',
                      installation: 'unchanged',
                      canCancel: true,
                      canRecover: false
                    }),
                    canRetryInstall: false
                  }
          }
        }
      }),
    releaseInstallHandoff: () => {
      if (legacy && !record) {
        const active = legacy
        legacy = undefined
        const release = exclusive(async () => {
          try {
            if (active.stopped) await options.restart(active.config)
            else await options.client().invokeHost('desktop:update-abort')
            options.onProgress?.({
              recovery: active.stopped
                ? undefined
                : {
                    phase: 'preparing',
                    runtime: 'running',
                    installation: 'unchanged',
                    canCancel: true,
                    canRecover: false,
                    canRetryInstall: false
                  }
            })
          } finally {
            options.setClosing(false)
          }
        })
        void release.catch((error: unknown) =>
          options.onProgress?.({
            reason: 'runtime-not-controlled',
            error: error instanceof Error ? error.message : 'The live service could not resume.',
            recovery: undefined
          })
        )
        return
      }
      if (record?.phase !== 'preparing' || pending) return
      // Restore live admission after a refused gate; the durable installation marker remains.
      const abort = exclusive(async () => {
        try {
          await options.client().invokeHost('desktop:update-abort')
        } finally {
          options.setClosing(false)
        }
      })
      void abort.catch((error: unknown) =>
        options.onProgress?.({
          reason: 'runtime-not-controlled',
          error: error instanceof Error ? error.message : 'The live service could not resume.',
          recovery: recovery()
        })
      )
    }
  }
}
