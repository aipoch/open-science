import type { ImageTask, ImageTaskScope } from '../../shared/image-task'
import { resolveReviewedWebPolicy } from '../session-package/web-evidence'
import { createLiteraturePackageSource } from '../literature/package-source'
import { desktopInteraction } from '../desktop-interaction'
import { join } from 'node:path'
import { BrowserPackageImport } from '../session-package/browser-import'
import { getDefaultPermissionProfile } from '../../shared/permission-profiles'
import type { SensitiveContentEvidence } from '../../shared/session-diagnostics'
import type { SessionPackageRequest } from '../../shared/session-package'
import { createAcpRuntime } from '../acp/runtime-composition'
import type { ApplicationEvents } from '../application-events'
import { type ApplicationModuleBuilder } from '../application-runtime'
import { ArchiveCoordinator } from '../archive/coordinator'
import { startDiagnosticOperation, type DiagnosticOperation } from '@aipoch/diagnostics/node'
import { createLogger } from '@aipoch/diagnostics/node'
import {
  createDefaultPreviewStateRepository,
  createDefaultProjectRepository
} from '../projects/ipc'
import { getProjectDbClient } from '../projects/prisma-client'
import { createSessionPackageDesktop } from '../session-package/desktop-composition'
import { createPackageInspector } from '../session-package/inspection-worker'
import createInspectionWorker from '../session-package/inspection-worker-entry?nodeWorker'
import type { PackageSensitiveContentSource } from '../session-package/sensitive-content'
import { SessionPackageService } from '../session-package/service'
import {
  createConversationExportService,
  registerConversationExportIpcHandler
} from '../session-persistence/conversation-export'
import type { SessionPersistenceCommands } from '../session-persistence/coordinator'
import { createDefaultSessionRepository } from '../session-persistence/ipc'
import { SettingsRepository } from '../settings/repository'
import { SettingsService } from '../settings/service'
import { resolveConfigRoot, resolveDataRoot } from '../storage-root'
import { detectActiveSessions } from '../storage/detect-active'
import { runDataRootStartupRecovery } from '../storage/migration-state'
import { normalizeLegacyDataPaths } from '../storage/normalize-legacy-paths'
import { createDefaultUploadRepository } from '../uploads/ipc'
import type { NotebookRuntimeService } from '../notebook/runtime-service'
import { getWebSnapshotStore } from '../web/snapshot-store'
import { WebEvidenceLifecycle, webEvidenceScope } from '../web/evidence-lifecycle'
import { getWebInvocationStore } from '../web/invocation-store'

type SessionExportReservation = (
  request: SessionPackageRequest,
  signal?: AbortSignal
) => Promise<() => void>

export async function composeSessionPackages({
  settingsRepository,
  settingsService,
  storedSettings,
  storageLog,
  uploadRepository,
  sessionRepository,
  getDetectSessionExportBlockingSessions,
  getSessionExportOwners,
  readImageTasks,
  modules
}: {
  settingsRepository: SettingsRepository
  settingsService: SettingsService
  storedSettings: import('../settings/types').StoredSettings
  storageLog: ReturnType<typeof createLogger>
  uploadRepository: ReturnType<typeof createDefaultUploadRepository>
  sessionRepository: ReturnType<typeof createDefaultSessionRepository>
  getDetectSessionExportBlockingSessions: () => () => ReturnType<typeof detectActiveSessions>
  getSessionExportOwners: () => {
    archiveCoordinator: Pick<ArchiveCoordinator, 'reserveSessionExport'>
    sessionPersistenceCoordinator: Pick<SessionPersistenceCommands, 'reserveSessionExport'>
    notebookService: Pick<NotebookRuntimeService, 'waitForSessionTeardown'>
  }
  readImageTasks: (scope: ImageTaskScope) => Promise<ImageTask[]>
  modules: ApplicationModuleBuilder
}): Promise<{
  projectRepository: ReturnType<typeof createDefaultProjectRepository>
  sessionPackageDesktopLifecycle: { close: () => Promise<void>; isActive: () => boolean }
  packageHandoffHeld: { current: boolean }
  packagePublicationOwner: {
    current?: Pick<SessionPersistenceCommands, 'adoptPublishedSession' | 'runSessionMutation'>
  }
  sessionPackageService: import('../session-package/service').SessionPackageService
  reserveSessionExport: SessionExportReservation
  previewStateRepository: ReturnType<typeof createDefaultPreviewStateRepository>
  webEvidenceLifecycle: WebEvidenceLifecycle
}> {
  const webSnapshotStore = getWebSnapshotStore(join(resolveDataRoot(), 'web-evidence'))
  const webEvidenceLifecycle = new WebEvidenceLifecycle(
    webSnapshotStore,
    async (projectId, sessionId) => {
      const loaded = await sessionRepository.loadSessionWithDiagnostics(projectId, sessionId, {
        mode: 'read-only',
        preserveRuntimeState: true
      })
      if (loaded.status === 'found') return loaded.session
      if (loaded.status === 'missing') return undefined
      throw new Error('Web evidence Session authority is unreadable.')
    },
    (binding) =>
      getWebInvocationStore(join(resolveDataRoot(), 'web-invocations')).deleteSession(binding),
    () => getWebInvocationStore(join(resolveDataRoot(), 'web-invocations')).ownedSessions()
  )
  const projectRepository = createDefaultProjectRepository()
  const sessionPackageDesktopLifecycle = {
    close: async (): Promise<void> => undefined,
    isActive: () => false
  }
  const packageHandoffHeld: { current: boolean } = { current: false }
  // Startup package recovery precedes catalog construction. After construction every live
  // publication must update the same owner consulted by resume/save admission.
  const packagePublicationOwner: {
    current?: Pick<SessionPersistenceCommands, 'adoptPublishedSession' | 'runSessionMutation'>
  } = {}
  // Package recovery precedes the Notebook runtime. Resolve live owners only for an export.
  const reserveSessionExport = async (
    request: SessionPackageRequest,
    signal?: AbortSignal,
    prepare?: () => Promise<void>
  ): Promise<() => void> => {
    const { archiveCoordinator, sessionPersistenceCoordinator, notebookService } =
      getSessionExportOwners()
    let releasePersistence: (() => void) | undefined
    let releaseAdmission: (() => void) | undefined
    try {
      releaseAdmission = await archiveCoordinator.reserveSessionExport(
        request.projectId,
        request.sessionId,
        async () => {
          signal?.throwIfAborted()
          const teardown = notebookService.waitForSessionTeardown(request)
          if (signal) {
            // Cancelling this observer must not cancel an already committed cleanup.
            await new Promise<void>((resolve, reject) => {
              const abort = (): void => {
                signal.removeEventListener('abort', abort)
                reject(signal.reason)
              }
              signal.addEventListener('abort', abort, { once: true })
              void teardown.then(
                () => {
                  signal.removeEventListener('abort', abort)
                  resolve()
                },
                (error: unknown) => {
                  signal.removeEventListener('abort', abort)
                  reject(error)
                }
              )
              if (signal.aborted) abort()
            })
          } else await teardown
          signal?.throwIfAborted()
          if (prepare) {
            await prepare()
            signal?.throwIfAborted()
          }
          releasePersistence = await sessionPersistenceCoordinator.reserveSessionExport(
            request.projectId,
            request.sessionId
          )
          signal?.throwIfAborted()
        },
        signal
      )
      signal?.throwIfAborted()
      return () => {
        releasePersistence?.()
        releaseAdmission?.()
      }
    } catch (error) {
      releasePersistence?.()
      releaseAdmission?.()
      throw error
    }
  }
  const sessionPackageService = await modules.add(undefined, () => {
    const service = new SessionPackageService({
      readImageTasks,
      webEvidence: {
        resolvePolicy: resolveReviewedWebPolicy,
        loadSnapshot: async (session, snapshotId, activity) => {
          const branchId = activity.messageBranchId
          if (session.conversationGraph && !branchId) return undefined
          if (branchId) await webEvidenceLifecycle.ensureBranchOwnership(session, branchId)
          return webSnapshotStore.readCommitted(
            webEvidenceScope(session.projectId, session.id, branchId),
            snapshotId
          )
        }
      },
      literatureSource: createLiteraturePackageSource(() =>
        getProjectDbClient(resolveConfigRoot())
      ),
      getDefaultPermissionProfile: async () =>
        getDefaultPermissionProfile(await settingsRepository.getSettings()),
      runSessionPublication: async (projectId, sessionId, work) => {
        const owner = packagePublicationOwner.current
        return owner ? owner.runSessionMutation(projectId, sessionId, work) : work()
      },
      onSessionPublished: async (publication) => {
        await webEvidenceLifecycle.confirmPublication(publication.session)
        await packagePublicationOwner.current?.adoptPublishedSession(publication)
      },
      onForkPrepared: (source, child) => webEvidenceLifecycle.prepareFork(source, child),
      onForkAborted: (child) => webEvidenceLifecycle.abortFork(child),
      inspectPackage: createPackageInspector(createInspectionWorker),
      configRoot: resolveConfigRoot(),
      storageRoot: resolveDataRoot(),
      getClient: () => getProjectDbClient(resolveConfigRoot()),
      reserveExport: (request, signal) =>
        reserveSessionExport(request, signal, () => service.prepareExport(request)),
      isSessionActive: (projectId, sessionId) =>
        getDetectSessionExportBlockingSessions()().some(
          (item) => item.projectId === projectId && item.sessionId === sessionId
        )
    })
    return {
      name: 'session-package',
      capability: service,
      dispose: async () => {
        await Promise.all([service.close(), sessionPackageDesktopLifecycle.close()])
      }
    }
  })
  // Finish or roll back private imports before any renderer or background owner hydrates catalogs.
  let beforePackageHydration = true
  await runDataRootStartupRecovery(() =>
    sessionPackageService.recover({ collectDeletedPackages: beforePackageHydration })
  )
  await runDataRootStartupRecovery(() => webEvidenceLifecycle.recover(), {
    reportFailure: () =>
      storageLog.warn('Web evidence startup recovery remains incomplete', {
        operation: 'web-evidence-recovery',
        outcome: 'retained'
      })
  })
  // Reconnecting a missing data root can replay this callback after runtimes exist. Import
  // recovery still runs behind its write gate, but package collection waits for the next launch.
  beforePackageHydration = false
  const previewStateRepository = createDefaultPreviewStateRepository()

  // One-time conversion of any legacy absolute data-root paths on disk (pre-$DATA-sentinel installs)
  // into the portable "$DATA/..." form, guarded so it only ever runs once. Never allowed to block
  // startup on failure: an error is logged and the marker stays unset, so the pass simply retries on
  // the next launch.
  if (!storedSettings.pathsNormalizedAt) {
    let normalizationOperation: DiagnosticOperation | undefined
    await runDataRootStartupRecovery(
      async () => {
        normalizationOperation = startDiagnosticOperation(storageLog, {
          operation: 'legacy-data-root-normalization',
          fields: { mode: 'legacy-normalize' }
        })
        normalizationOperation.phase('rewrite-paths')
        await normalizeLegacyDataPaths({
          sessionRepository,
          sessionUploads: uploadRepository,
          previewStateRepository,
          projectRepository,
          dataRoot: resolveDataRoot()
        })
        normalizationOperation.phase('persist-marker')
        await settingsService.markPathsNormalized()
        normalizationOperation.complete()
      },
      {
        reportFailure: (error) => normalizationOperation?.fail(error)
      }
    )
  }
  return {
    projectRepository,
    sessionPackageDesktopLifecycle,
    packageHandoffHeld,
    packagePublicationOwner,
    sessionPackageService,
    reserveSessionExport,
    previewStateRepository,
    webEvidenceLifecycle
  }
}

export function composeSessionPackageSurfaces({
  declareElectronAdapter,
  applicationEvents,
  sessionRepository,
  rememberSensitiveContentFailure,
  projectRepository,
  sessionPackageDesktopLifecycle,
  packageHandoffHeld,
  sessionPackageService,
  reserveSessionExport,
  archiveCoordinator,
  runtime,
  translate
}: {
  declareElectronAdapter: (name: string, install: () => void | (() => void)) => void
  applicationEvents: ApplicationEvents
  sessionRepository: ReturnType<typeof createDefaultSessionRepository>
  rememberSensitiveContentFailure: (
    request: { projectId: string; sessionId: string },
    evidence: SensitiveContentEvidence[],
    sources: PackageSensitiveContentSource[]
  ) => void
  projectRepository: ReturnType<typeof createDefaultProjectRepository>
  sessionPackageDesktopLifecycle: { close: () => Promise<void>; isActive: () => boolean }
  packageHandoffHeld: { current: boolean }
  sessionPackageService: import('../session-package/service').SessionPackageService
  reserveSessionExport: SessionExportReservation
  archiveCoordinator: ArchiveCoordinator
  runtime: ReturnType<typeof createAcpRuntime>
  translate: import('../locale/main-process-messages').NativeTranslator
}): {
  conversationExportService: ReturnType<typeof createConversationExportService>
  sessionPackageDesktop: ReturnType<typeof createSessionPackageDesktop>
  browserPackageImport: BrowserPackageImport
  registerExternalTransferCheck: (check: () => boolean) => () => void
} {
  const conversationExportService = createConversationExportService({
    translate,
    reserveExport: (projectId, sessionId) => reserveSessionExport({ projectId, sessionId }),
    loadSession: (projectId, sessionId) => sessionRepository.loadSession(projectId, sessionId),
    isSessionActive: (projectId, sessionId) =>
      runtime
        .getActivePromptSessions()
        .some(
          (activeSession) =>
            activeSession.projectId === projectId && activeSession.sessionId === sessionId
        )
  })
  declareElectronAdapter('conversation-export', () =>
    registerConversationExportIpcHandler(conversationExportService)
  )
  const sessionPackageDesktop = createSessionPackageDesktop({
    sessionPackageService,
    translate,
    archiveCoordinator,
    applicationEvents,
    projectRepository,
    sessionRepository,
    isPackageHandoffHeld: () => packageHandoffHeld.current,
    cancelBrowserTransfer: (id) => browserPackageImport.cancel(id),
    onSensitiveContentFailure: rememberSensitiveContentFailure
  })
  const browserPackageImport = new BrowserPackageImport({
    root: join(resolveConfigRoot(), 'browser-package-imports'),
    receive: (path, consumed) => sessionPackageDesktop.enqueueFile(path, consumed, true),
    onChanged: (transfers) => sessionPackageDesktop.operations.setBrowserTransfers(transfers),
    cancelReceived: (path) => sessionPackageDesktop.cancelReceivedFile(path)
  })
  const externalTransferChecks = new Set<() => boolean>()
  const hasExternalActiveTransfer = (): boolean =>
    Array.from(externalTransferChecks).some((check) => check())
  // Browser receipt precedes the desktop queue and must survive quit/update preparation too.
  sessionPackageDesktopLifecycle.isActive = () =>
    browserPackageImport.active ||
    sessionPackageDesktop.operations.active ||
    hasExternalActiveTransfer()
  declareElectronAdapter('session-package-quit-guard', () =>
    desktopInteraction('Session package quit confirmation').installPackageQuitGuard(
      () =>
        browserPackageImport.active ||
        sessionPackageDesktop.hasActiveTransfer() ||
        hasExternalActiveTransfer(),
      () => {
        desktopInteraction('Confirm desktop action').confirmSync({
          type: 'info',
          title: translate('Session package operation in progress'),
          message: translate(
            'Wait for the package operation to finish, or cancel it from the progress window before quitting.'
          ),
          buttons: [translate('OK')]
        })
      }
    )
  )
  sessionPackageDesktopLifecycle.close = async () => {
    browserPackageImport.stop()
    await sessionPackageDesktop.close()
    await browserPackageImport.close()
  }
  return {
    conversationExportService,
    sessionPackageDesktop,
    browserPackageImport,
    registerExternalTransferCheck: (check: () => boolean): (() => void) => {
      externalTransferChecks.add(check)
      return () => {
        externalTransferChecks.delete(check)
      }
    }
  }
}
