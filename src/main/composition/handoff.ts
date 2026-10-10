import {
  registerStorageIpcHandlers,
  registerUpdateIpcHandlers
} from '../desktop-surface-declarations'
import type { UpdateBlocker } from '../../shared/update'
import { createAcpRuntime } from '../acp/runtime-composition'
import { type ApplicationModuleBuilder } from '../application-runtime'
import { withReproducibilityNotebookLifecycle } from '../artifacts/reproducibility-notebook-lifecycle'
import { BackendShutdownCoordinator, UPDATE_SHUTDOWN_BUDGET_MS } from '../lifecycle-shutdown'
import { createLogger } from '../logger'
import { createProductionMicromambaRunner } from '../notebook/windows-micromamba-runner'
import {
  createWebSessionPersistenceFlush,
  rendererSessionPersistenceFlushBlocksShutdown,
  type RendererSessionPersistenceTarget
} from '../session-persistence/flush-protocol'
import { SettingsService } from '../settings/service'
import { SideChatRuntimeOwner } from '../side-chat/runtime-owner'
import { createStorageCommandOwner } from '../storage/command-owner'
import { DataRootCleanupJournal, createDataRootSourceCleanup } from '../storage/data-root-cleanup'
import { detectActiveSessions } from '../storage/detect-active'

import { isMigrationInProgress, isMigrationPending } from '../storage/migration-state'
import { createRuntimeUpdateStrategy } from '../update/runtime-strategy'
import { createUpdateCommandOwner } from '../update/command-owner'
import { startUpdateScheduler } from '../update/scheduler'
import {
  createActiveResearchSafeInstallGate,
  createDataRootResearchSafeInstallGate,
  createDurableInstallGate,
  type InstallReadiness
} from '../update/strategy'
import { type ReviewerRuntimeShutdownOwner } from './reviewer'

export async function composeHandoff({
  managedExecution,
  declareElectronAdapter,
  webSessionPersistenceFlush,
  settingsService,
  sessionPackageDesktopLifecycle,
  packageHandoffHeld,
  getActiveDelegatedSessions,
  getActiveSideChatSessions,
  notebookLifecycle,
  runtime,
  sideChatRuntime,
  translate,
  confirmRendererDurability,
  notifyRendererDurabilityAborted,
  modules
}: {
  managedExecution?: import('./managed-execution').ManagedExecutionComposition
  declareElectronAdapter: (name: string, install: () => void | (() => void)) => void
  webSessionPersistenceFlush: ReturnType<typeof createWebSessionPersistenceFlush>
  settingsService: SettingsService
  sessionPackageDesktopLifecycle: { close: () => Promise<void>; isActive: () => boolean }
  packageHandoffHeld: { current: boolean }
  getActiveDelegatedSessions: () => { projectId: string; sessionId: string }[]
  getActiveSideChatSessions: () => { projectId: string; sessionId: string }[]
  notebookLifecycle: ReturnType<typeof withReproducibilityNotebookLifecycle>
  runtime: ReturnType<typeof createAcpRuntime>
  sideChatRuntime: SideChatRuntimeOwner
  translate: import('../locale/main-process-messages').NativeTranslator
  confirmRendererDurability: (
    policy?:
      | import('../session-persistence/flush-protocol').RendererSessionPersistenceFlushPolicy
      | undefined,
    surface?:
      import('../session-persistence/flush-protocol').RendererSessionPersistenceSurface | undefined
  ) => Promise<boolean>
  notifyRendererDurabilityAborted: () => void
  modules: ApplicationModuleBuilder
}): Promise<{
  reviewerModelRuntimeShutdown: { current: ReviewerRuntimeShutdownOwner | undefined }
  shutdownCoordinator: BackendShutdownCoordinator
  durableDataRootHandoffGate: (
    target: RendererSessionPersistenceTarget,
    confirmedInterruption: boolean
  ) => Promise<InstallReadiness>
  updateCommandOwner: ReturnType<typeof createUpdateCommandOwner>
  prepareDesktopUpdate: import('../update/strategy').InstallGate
  abortDesktopUpdate: () => void
}> {
  // Single shared teardown owner for both the before-quit handler (index.ts) and the pre-update-install
  // gate. Update handling is deliberately constructed below, after this dependency is complete.
  const reviewerModelRuntimeShutdown: { current: ReviewerRuntimeShutdownOwner | undefined } = {
    current: undefined
  }
  const shutdownCoordinator = new BackendShutdownCoordinator({
    runtime: {
      shutdownForQuit: async () => {
        const [main, reviewer] = await Promise.all([
          runtime.shutdownForQuit(),
          reviewerModelRuntimeShutdown.current
            ? reviewerModelRuntimeShutdown.current.shutdown()
            : Promise.resolve({ reaped: true })
        ])
        return { reaped: main.reaped && reviewer.reaped }
      },
      shutdownForUpdateGate: async () => {
        const [main, reviewer] = await Promise.all([
          runtime.shutdownForUpdateGate(),
          reviewerModelRuntimeShutdown.current
            ? reviewerModelRuntimeShutdown.current.shutdownForUpdateGate()
            : Promise.resolve({ reaped: true })
        ])
        return { reaped: main.reaped && reviewer.reaped }
      }
    },
    notebook: notebookLifecycle,
    sideChat: {
      shutdown: () => sideChatRuntime.shutdown(),
      suspendAll: (options) => sideChatRuntime.suspendAll(options)
    },
    log: createLogger('shutdown')
  })
  const durableBackendHandoffGate = createDurableInstallGate(
    (options) =>
      shutdownCoordinator.runForUpdateGate(UPDATE_SHUTDOWN_BUDGET_MS, {
        holdSideChatAdmission: true,
        legacyShellRecoveryToken: options?.legacyShellRecoveryToken
      }),
    () => confirmRendererDurability()
  )
  const detectResearchBlockers = (): UpdateBlocker[] => {
    const blockers: UpdateBlocker[] = detectActiveSessions({
      runtime: { getActivePromptSessions: () => runtime.getQuitBlockingPromptSessions() },
      sideChat: { getActivePromptSessions: getActiveSideChatSessions },
      delegated: { getActiveDelegatedSessions },
      notebook: notebookLifecycle
    }).map((session) => session.kind)
    if (reviewerModelRuntimeShutdown.current?.hasActiveWork()) blockers.push('reviewer')
    if (settingsService.hasActiveInstall()) blockers.push('settings-install')
    return blockers
  }
  const durableDataRootHandoffGate = (
    target: RendererSessionPersistenceTarget,
    confirmedInterruption: boolean
  ): Promise<InstallReadiness> =>
    createDurableInstallGate(
      createDataRootResearchSafeInstallGate(
        detectResearchBlockers,
        async () => {
          await managedExecution?.quiesce()
          await managedExecution?.environments.prepareForDataRootHandoff()
          return shutdownCoordinator.runForUpdateGate(UPDATE_SHUTDOWN_BUDGET_MS, {
            holdSideChatAdmission: true
          })
        },
        confirmedInterruption
      ),
      async () => {
        if (target.surface !== 'web-renderer') {
          return confirmRendererDurability('data-root-handoff', target.surface)
        }
        const outcome = await webSessionPersistenceFlush.flush(target.lifecycleClientId)
        const blocked = rendererSessionPersistenceFlushBlocksShutdown(outcome, 'data-root-handoff')
        if (blocked) webSessionPersistenceFlush.notifyAborted()
        return !blocked
      }
    )()
  // Construct update handling only after its backend-shutdown gate exists. The in-place strategy owns
  // this immutable dependency from construction; the manifest fallback ignores it because it does not
  // quit the running app to install.
  let releaseSettingsInstallAdmission: (() => void) | undefined
  const abortUpdateHandoff = (): void => {
    managedExecution?.resume()
    packageHandoffHeld.current = false
    const releaseAdmission = releaseSettingsInstallAdmission
    releaseSettingsInstallAdmission = undefined
    releaseAdmission?.()
    try {
      sideChatRuntime.resumeAfterHandoff()
    } finally {
      notifyRendererDurabilityAborted()
    }
  }
  const updateInstallGate = createActiveResearchSafeInstallGate(
    detectResearchBlockers,
    durableBackendHandoffGate,
    () => isMigrationInProgress() || isMigrationPending()
  )
  const prepareDesktopUpdate: import('../update/strategy').InstallGate = async (options) => {
    packageHandoffHeld.current = true
    if (sessionPackageDesktopLifecycle.isActive())
      throw new Error('Wait for the Session package operation to finish before updating.')
    releaseSettingsInstallAdmission ??= settingsService.holdInstallAdmission()
    return updateInstallGate(options)
  }
  const updateStrategy = createRuntimeUpdateStrategy(process.platform, {
    translate,
    installGate: prepareDesktopUpdate,
    releaseInstallHandoff: abortUpdateHandoff
  })
  const updateCommandOwner = createUpdateCommandOwner(updateStrategy)
  let stopUpdateScheduler: (() => void) | undefined
  await modules.add(undefined, () => ({
    name: 'update-scheduler',
    capability: undefined,
    dispose: () => stopUpdateScheduler?.()
  }))
  declareElectronAdapter('update', () => {
    registerUpdateIpcHandlers(updateStrategy, updateCommandOwner)
    stopUpdateScheduler = startUpdateScheduler(updateStrategy)
  })
  return {
    reviewerModelRuntimeShutdown,
    shutdownCoordinator,
    durableDataRootHandoffGate,
    updateCommandOwner,
    prepareDesktopUpdate,
    abortDesktopUpdate: abortUpdateHandoff
  }
}

export function composeStorageHandoff({
  resumeManagedExecution,
  declareElectronAdapter,
  webSessionPersistenceFlush,
  settingsService,
  dataRootCleanupJournal,
  cleanupDataRootSources,
  sessionPackageDesktopLifecycle,
  getActiveDelegatedSessions,
  getActiveSideChatSessions,
  micromambaRunner,
  notebookLifecycle,
  runtime,
  sideChatRuntime,
  reviewerModelRuntimeShutdown,
  durableDataRootHandoffGate,
  notifyRendererDurabilityAborted
}: {
  resumeManagedExecution?: () => void
  declareElectronAdapter: (name: string, install: () => void | (() => void)) => void
  webSessionPersistenceFlush: ReturnType<typeof createWebSessionPersistenceFlush>
  settingsService: SettingsService
  dataRootCleanupJournal: DataRootCleanupJournal
  cleanupDataRootSources: ReturnType<typeof createDataRootSourceCleanup>
  sessionPackageDesktopLifecycle: { close: () => Promise<void>; isActive: () => boolean }
  getActiveDelegatedSessions: () => { projectId: string; sessionId: string }[]
  getActiveSideChatSessions: () => { projectId: string; sessionId: string }[]
  micromambaRunner: ReturnType<typeof createProductionMicromambaRunner>
  notebookLifecycle: ReturnType<typeof withReproducibilityNotebookLifecycle>
  runtime: ReturnType<typeof createAcpRuntime>
  sideChatRuntime: SideChatRuntimeOwner
  reviewerModelRuntimeShutdown: { current: ReviewerRuntimeShutdownOwner | undefined }
  durableDataRootHandoffGate: (
    target: RendererSessionPersistenceTarget,
    confirmedInterruption: boolean
  ) => Promise<InstallReadiness>
  notifyRendererDurabilityAborted: () => void
}): { storageCommandOwner: ReturnType<typeof createStorageCommandOwner> } {
  // Registered after the acp/notebook handlers exist: migration needs to interrupt both runtimes.
  let releaseDataRootInstallAdmission: (() => void) | undefined
  const abortDataRootInstallAdmission = (): void => {
    const releaseAdmission = releaseDataRootInstallAdmission
    releaseDataRootInstallAdmission = undefined
    releaseAdmission?.()
  }

  const storageCommandOwner = createStorageCommandOwner({
    hasActivePackageOperation: () => sessionPackageDesktopLifecycle.isActive(),
    runtime,
    notebook: notebookLifecycle,
    getActivePromptSessions: () => runtime.getActivePromptSessions(),
    getActiveSideChatSessions,
    getActiveDelegatedSessions,
    hasActiveReviewerWork: () => reviewerModelRuntimeShutdown.current?.hasActiveWork() ?? false,
    settingsService,
    micromambaRunner,
    acknowledgeWebRendererFlush: webSessionPersistenceFlush.acknowledge,
    notifyDataRootHandoffAborted: () => {
      resumeManagedExecution?.()
      abortDataRootInstallAdmission()
      try {
        sideChatRuntime.resumeAfterHandoff()
      } finally {
        try {
          notifyRendererDurabilityAborted()
        } finally {
          webSessionPersistenceFlush.notifyAborted()
        }
      }
    },
    prepareDataRootHandoff: async (target, confirmedInterruption) => {
      let prepared = false
      releaseDataRootInstallAdmission ??= settingsService.holdInstallAdmission()
      try {
        const readiness = await durableDataRootHandoffGate(target, confirmedInterruption)
        prepared = readiness.completed && readiness.reaped
        return prepared
      } finally {
        if (!prepared) {
          resumeManagedExecution?.()
          abortDataRootInstallAdmission()
          sideChatRuntime.resumeAfterHandoff()
        }
      }
    },
    cleanupJournal: dataRootCleanupJournal,
    deleteSources: cleanupDataRootSources
  })
  declareElectronAdapter('storage', () =>
    registerStorageIpcHandlers(
      {
        runtime,
        notebook: notebookLifecycle,
        getActivePromptSessions: () => runtime.getActivePromptSessions(),
        getActiveSideChatSessions,
        getActiveDelegatedSessions,
        hasActiveReviewerWork: () => reviewerModelRuntimeShutdown.current?.hasActiveWork() ?? false,
        settingsService
      },
      storageCommandOwner
    )
  )
  return { storageCommandOwner }
}
