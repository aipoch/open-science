import { app, dialog } from 'electron'
import { getDefaultPermissionProfile } from '../../shared/permission-profiles'
import type { SensitiveContentEvidence } from '../../shared/session-diagnostics'
import { createAcpRuntime } from '../acp/runtime-composition'
import type { ApplicationEvents } from '../application-events'
import { type ApplicationModuleBuilder } from '../application-runtime'
import { ArchiveCoordinator } from '../archive/coordinator'
import { startDiagnosticOperation, type DiagnosticOperation } from '../diagnostics/operation'
import { createLogger } from '../logger'
import {
  createDefaultPreviewStateRepository,
  createDefaultProjectRepository
} from '../projects/ipc'
import { getProjectDbClient } from '../projects/prisma-client'
import { createSessionPackageDesktop } from '../session-package/desktop-composition'
import { SessionPackageHeadless } from '../session-package/headless'
import { createPackageInspector } from '../session-package/inspection-worker'
import createInspectionWorker from '../session-package/inspection-worker-entry?nodeWorker'
import { installSessionPackageQuitGuard } from '../session-package/quit-guard'
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
import {
  runDataRootStartupRecovery,
  withDataRootWrite,
  isMigrationInProgress,
  isMigrationPending
} from '../storage/migration-state'
import { normalizeLegacyDataPaths } from '../storage/normalize-legacy-paths'
import { createDefaultUploadRepository } from '../uploads/ipc'

export async function composeSessionPackages({
  settingsRepository,
  settingsService,
  storedSettings,
  storageLog,
  uploadRepository,
  sessionRepository,
  getDetectSessionExportBlockingSessions,
  modules
}: {
  settingsRepository: SettingsRepository
  settingsService: SettingsService
  storedSettings: import('../settings/types').StoredSettings
  storageLog: ReturnType<typeof createLogger>
  uploadRepository: ReturnType<typeof createDefaultUploadRepository>
  sessionRepository: ReturnType<typeof createDefaultSessionRepository>
  getDetectSessionExportBlockingSessions: () => () => ReturnType<typeof detectActiveSessions>
  modules: ApplicationModuleBuilder
}): Promise<{
  projectRepository: ReturnType<typeof createDefaultProjectRepository>
  sessionPackageDesktopLifecycle: { close: () => Promise<void>; isActive: () => boolean }
  packageHandoffHeld: { current: boolean }
  packagePublicationOwner: {
    current?: Pick<SessionPersistenceCommands, 'adoptPublishedSession'>
  }
  sessionPackageService: import('../session-package/service').SessionPackageService
  previewStateRepository: ReturnType<typeof createDefaultPreviewStateRepository>
}> {
  const projectRepository = createDefaultProjectRepository()
  const sessionPackageDesktopLifecycle = {
    close: async (): Promise<void> => undefined,
    isActive: () => false
  }
  const packageHandoffHeld: { current: boolean } = { current: false }
  // Startup package recovery precedes catalog construction. After construction every live
  // publication must update the same owner consulted by resume/save admission.
  const packagePublicationOwner: {
    current?: Pick<SessionPersistenceCommands, 'adoptPublishedSession'>
  } = {}
  const sessionPackageService = await modules.add(undefined, () => {
    const service = new SessionPackageService({
      getDefaultPermissionProfile: async () =>
        getDefaultPermissionProfile(await settingsRepository.getSettings()),
      onSessionPublished: async ({ projectId, sessionId }, publication) => {
        await packagePublicationOwner.current?.adoptPublishedSession(
          projectId,
          sessionId,
          publication
        )
      },
      inspectPackage: createPackageInspector(createInspectionWorker),
      configRoot: resolveConfigRoot(),
      storageRoot: resolveDataRoot(),
      getClient: () => getProjectDbClient(resolveConfigRoot()),
      isSessionActive: (projectId, sessionId) =>
        getDetectSessionExportBlockingSessions()().some(
          (item) => item.projectId === projectId && item.sessionId === sessionId
        )
    })
    return {
      name: 'session-package',
      capability: service,
      dispose: async () => {
        // Surface owners cancel and drain transfers before their backing service is closed.
        await sessionPackageDesktopLifecycle.close()
        await service.close()
      }
    }
  })
  // Finish or roll back private imports before any renderer or background owner hydrates catalogs.
  let beforePackageHydration = true
  await runDataRootStartupRecovery(() =>
    sessionPackageService.recover({ collectDeletedPackages: beforePackageHydration })
  )
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
    previewStateRepository
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
  sessionPersistenceCoordinator,
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
  sessionPersistenceCoordinator: Pick<SessionPersistenceCommands, 'reserveSessionExport'>
  archiveCoordinator: ArchiveCoordinator
  runtime: ReturnType<typeof createAcpRuntime>
  translate: import('../locale/main-process-messages').NativeTranslator
}): {
  conversationExportService: ReturnType<typeof createConversationExportService>
  sessionPackageDesktop: ReturnType<typeof createSessionPackageDesktop>
  sessionPackageHeadless: SessionPackageHeadless
} {
  const conversationExportService = createConversationExportService({
    translate,
    reserveExport: async (projectId, sessionId) => {
      let releasePersistence: (() => void) | undefined
      try {
        const releaseAdmission = await archiveCoordinator.reserveSessionExport(
          projectId,
          sessionId,
          async () => {
            releasePersistence = await sessionPersistenceCoordinator.reserveSessionExport(
              projectId,
              sessionId
            )
          }
        )
        return () => {
          releasePersistence?.()
          releaseAdmission()
        }
      } catch (error) {
        releasePersistence?.()
        throw error
      }
    },
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
    sessionPersistenceCoordinator,
    applicationEvents,
    projectRepository,
    sessionRepository,
    isPackageHandoffHeld: () =>
      packageHandoffHeld.current || sessionPackageHeadless.hasActiveTransfer(),
    onSensitiveContentFailure: rememberSensitiveContentFailure
  })
  const sessionPackageHeadless = new SessionPackageHeadless({
    service: sessionPackageService,
    withDataRootWrite,
    assertCanStart: () => {
      if (
        packageHandoffHeld.current ||
        isMigrationInProgress() ||
        isMigrationPending() ||
        sessionPackageDesktop.hasActiveTransfer()
      )
        throw new Error('Wait for the current package transfer or application handoff to finish.')
    },
    reserveImport: (projectId, signal) =>
      archiveCoordinator.reserveProjectImport(projectId, signal),
    reserveExport: async (request, signal) => {
      let releasePersistence: (() => void) | undefined
      try {
        const releaseAdmission = await archiveCoordinator.reserveSessionExport(
          request.projectId,
          request.sessionId,
          async () => {
            releasePersistence = await sessionPersistenceCoordinator.reserveSessionExport(
              request.projectId,
              request.sessionId
            )
            await sessionPackageService.assertExportIdle(request)
          },
          signal
        )
        return () => {
          releasePersistence?.()
          releaseAdmission()
        }
      } catch (error) {
        releasePersistence?.()
        throw error
      }
    },
    afterImport: async (identity, originClientId, projectCreated) => {
      const [project, session] = await Promise.all([
        projectRepository.get(identity.projectId),
        sessionRepository.loadSession(identity.projectId, identity.sessionId)
      ])
      if (project && projectCreated) applicationEvents.publish('project:created', project)
      if (session) applicationEvents.publish('session:created', { session, originClientId })
    }
  })
  sessionPackageDesktopLifecycle.isActive = () =>
    sessionPackageDesktop.operations.active || sessionPackageHeadless.hasActiveTransfer()
  const removePackageQuitGuard = installSessionPackageQuitGuard(
    app,
    () => sessionPackageDesktop.hasActiveTransfer(),
    () => {
      dialog.showMessageBoxSync({
        type: 'info',
        title: translate('Session package operation in progress'),
        message: translate(
          'Wait for the package operation to finish, or cancel it from the progress window before quitting.'
        ),
        buttons: [translate('OK')]
      })
    }
  )
  sessionPackageDesktopLifecycle.close = async () => {
    removePackageQuitGuard()
    const results = await Promise.allSettled([
      sessionPackageHeadless.close(),
      sessionPackageDesktop.close()
    ])
    const failures = results.filter((result) => result.status === 'rejected')
    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason),
        'Session package transfers did not finish closing.'
      )
  }
  return { conversationExportService, sessionPackageDesktop, sessionPackageHeadless }
}
