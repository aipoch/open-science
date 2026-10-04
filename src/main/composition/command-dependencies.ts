import { SessionReadingOwner } from '../session-replay/session-reading'
import type { createDefaultUploadRepository } from '../uploads/ipc'
import type { ApplicationEvents } from '../application-events'
import { SessionReplayRepository } from '../session-replay/repository'
import { SessionReplayService } from '../session-replay/service'
import { getProjectDbClient } from '../projects/prisma-client'
import { resolveConfigRoot } from '../storage-root'
import { BrowserWindow, dialog, webContents, type WebContents } from 'electron'
import { createAcpRuntime } from '../acp/runtime-composition'
import { type ApplicationCommandCompositionDependencies } from '../application-command-composition'
import type { ApplicationInvocation } from '../application-command-router'
import { createCliCommandOwner } from '../cli-install/ipc'
import { createGithubCommandOwner } from '../github-ipc'
import { createLiteratureCommandOwner } from '../literature/command-owner'
import { errorLogFields } from '../logger'
import { createLogsCommandOwner } from '../logs-ipc'
import { ManagedFileVersionService } from '../managed-file-versions/service'
import { createRuntimeWorkflows } from '../notebook/runtime-workflows'
import { TaskNotificationService } from '../notifications/task-notifications'
import { broadcastToRenderers } from '../renderer-broadcast'
import { linkPdfContextWithCapability } from '../session-persistence/pdf-context-link-workflow'
import { SETTINGS_INSTALL_LOG_CHANNEL } from '../settings/ipc'
import { withDataRootWrite } from '../storage/migration-state'
import type { composeAgentWorkflows } from './agent-completion'
import type { composeAgentRuntime } from './agent-runtime'
import type { composeArtifactSurfaces } from './artifact-surfaces'
import type { composeComputeAdmission, composeComputeServices } from './compute'
import type { composeConnectors } from './connectors'
import type { composeDelegation } from './delegation'
import type { composeDocumentReading } from './document-reading'
import type { composeHandoff, composeStorageHandoff } from './handoff'
import type { composeManagedFiles } from './managed-files'
import { registerNotebookEnvironmentComposition } from './notebook-environment'
import type { composeNotebookRuntime } from './notebook-runtime'
import type { composeProjectLifecycle } from './project-lifecycle'
import type { composeResearchCatalog } from './research-catalog'
import { registerReviewerComposition } from './reviewer'
import type { composeSessionAuthority } from './session-authority'
import type { composeSessionFoundation } from './session-foundation'
import type { composeSessionPackageSurfaces, composeSessionPackages } from './session-packages'
import type { composeSessionSurfaces } from './session-surfaces'
import type { composeSettingsBootstrap } from './settings-bootstrap'
import type { composeSettingsEffects } from './settings-effects'
import type { composeStorageStartup } from './storage-startup'

export function composeCommandDependencies({
  applicationEvents,
  settingsBootstrap,
  storageStartup,
  managedFileVersionService,
  runtimeRef,
  sessionFoundation,
  sessionPackages,
  managedFiles,
  sessionAuthority,
  documentReading,
  projectLifecycle,
  notebookRuntime,
  researchCatalog,
  taskNotifications,
  connectors,
  computeServices,
  computeAdmission,
  delegation,
  cliCommandOwner,
  githubCommandOwner,
  logsCommandOwner,
  agentRuntime,
  agentWorkflows,
  handoff,
  settingsEffects,
  sessionSurfaces,
  runtimeWorkflows,
  notebookEnvironmentLifecycle,
  storageHandoff,
  artifactSurfaces,
  sessionPackageSurfaces,
  reviewerCommandOwner,
  listAppIconPreviews
}: {
  applicationEvents: ApplicationEvents
  settingsBootstrap: Awaited<ReturnType<typeof composeSettingsBootstrap>>
  storageStartup: Awaited<ReturnType<typeof composeStorageStartup>>
  managedFileVersionService: ManagedFileVersionService
  uploadRepository: ReturnType<typeof createDefaultUploadRepository>
  runtimeRef: { current: ReturnType<typeof createAcpRuntime> | undefined }
  sessionFoundation: Awaited<ReturnType<typeof composeSessionFoundation>>
  sessionPackages: Awaited<ReturnType<typeof composeSessionPackages>>
  managedFiles: ReturnType<typeof composeManagedFiles>
  sessionAuthority: Awaited<ReturnType<typeof composeSessionAuthority>>
  documentReading: Awaited<ReturnType<typeof composeDocumentReading>>
  projectLifecycle: ReturnType<typeof composeProjectLifecycle>
  notebookRuntime: Awaited<ReturnType<typeof composeNotebookRuntime>>
  researchCatalog: Awaited<ReturnType<typeof composeResearchCatalog>>
  taskNotifications: TaskNotificationService
  connectors: Awaited<ReturnType<typeof composeConnectors>>
  computeServices: ReturnType<typeof composeComputeServices>
  computeAdmission: Awaited<ReturnType<typeof composeComputeAdmission>>
  delegation: ReturnType<typeof composeDelegation>
  cliCommandOwner: ReturnType<typeof createCliCommandOwner>
  githubCommandOwner: ReturnType<typeof createGithubCommandOwner>
  logsCommandOwner: ReturnType<typeof createLogsCommandOwner>
  agentRuntime: Awaited<ReturnType<typeof composeAgentRuntime>>
  agentWorkflows: Awaited<ReturnType<typeof composeAgentWorkflows>>
  handoff: Awaited<ReturnType<typeof composeHandoff>>
  settingsEffects: Awaited<ReturnType<typeof composeSettingsEffects>>
  sessionSurfaces: Awaited<ReturnType<typeof composeSessionSurfaces>>
  runtimeWorkflows: ReturnType<typeof createRuntimeWorkflows>
  notebookEnvironmentLifecycle: Awaited<ReturnType<typeof registerNotebookEnvironmentComposition>>
  storageHandoff: ReturnType<typeof composeStorageHandoff>
  artifactSurfaces: ReturnType<typeof composeArtifactSurfaces>
  sessionPackageSurfaces: ReturnType<typeof composeSessionPackageSurfaces>
  reviewerCommandOwner: Awaited<ReturnType<typeof registerReviewerComposition>>
  listAppIconPreviews: (() => import('../../shared/settings').AppIconPreview[]) | undefined
}): { applicationCommandDependencies: ApplicationCommandCompositionDependencies } {
  const electronSenderFor = (
    invocation: ApplicationInvocation<readonly unknown[]>
  ): WebContents => {
    const senderId = Number(invocation.callerContext.clientId)
    const sender =
      Number.isSafeInteger(senderId) && senderId > 0 ? webContents.fromId(senderId) : null
    if (!sender || sender.isDestroyed()) {
      throw new Error('Electron command caller is no longer available.')
    }
    return sender
  }
  const sessionReplay = new SessionReplayService(
    new SessionReplayRepository(() => getProjectDbClient(resolveConfigRoot())),
    {
      read: (projectId, sessionId) =>
        sessionFoundation.sessionRepository.loadSessionWithDiagnostics(projectId, sessionId, {
          mode: 'read-only',
          preserveRuntimeState: true
        }),
      list: () => sessionFoundation.sessionRepository.loadSessionSummaries(),
      setResearchMembership: (request) =>
        sessionAuthority.sessionPersistenceCoordinator.setResearchMembership(request),
      readCurrent: (projectId, sessionId) =>
        sessionAuthority.sessionPersistenceCoordinator.readSessionSnapshot(projectId, sessionId)
    },
    withDataRootWrite,
    new SessionReadingOwner(
      new SessionReplayRepository(() => getProjectDbClient(resolveConfigRoot())),
      sessionAuthority.sessionPersistenceCoordinator
    )
  )
  const applicationCommandDependencies: ApplicationCommandCompositionDependencies = {
    sessionReplay,
    specialist: sessionSurfaces.specialistApplicationOwner,
    bookmarks: documentReading.bookmarkService,
    pdfAnnotations: documentReading.pdfAnnotationService,
    acp: {
      runtime: agentRuntime.runtime,
      workflows: agentWorkflows.acpHandlerWorkflows,
      archiveAvailability: projectLifecycle.archiveCoordinator,
      respondDelegatedQuestion: (input) => {
        if (!delegation.delegatedWork.root.respondQuestion) {
          throw new Error('Delegated question response owner is unavailable.')
        }
        return delegation.delegatedWork.root.respondQuestion(input)
      }
    },
    notebook: {
      workflows: notebookRuntime.notebookCommands,
      readInputPreview: (request) => sessionAuthority.notebookInputRegistry.readPreview(request)
    },
    notebookEnvironment: notebookEnvironmentLifecycle,
    notebookRuntime: {
      workflows: runtimeWorkflows,
      pickInterpreter: async () => {
        const result = await dialog.showOpenDialog({ properties: ['openFile'] })
        return result.filePaths[0] ?? null
      }
    },
    settingsCore: {
      runtime: settingsEffects.settingsWorkflows.runtime,
      service: settingsBootstrap.settingsService,
      appearance: settingsEffects.settingsWorkflows.appearance,
      localShell: settingsEffects.settingsWorkflows.localShell,
      snapshotCommits: settingsBootstrap.settingsSnapshotCommits,
      emitInstallEvent: (event) => broadcastToRenderers(SETTINGS_INSTALL_LOG_CHANNEL, event),
      listAppIconPreviews
    },
    settingsIntegration: {
      skills: settingsEffects.settingsWorkflows.skills,
      connectors: settingsEffects.settingsWorkflows.connectors,
      snapshotCommits: settingsBootstrap.settingsSnapshotCommits,
      connectorApprovals: connectors.approvalBroker,
      skillImportApprovals: connectors.skillImportApprovalBroker
    },
    settingsRuntime: {
      workflows: settingsEffects.settingsWorkflows.runtime,
      snapshotCommits: settingsBootstrap.settingsSnapshotCommits
    },
    compute: {
      compute: computeServices.computeIpcModule.handlers,
      bookmarks: {
        get: (providerId) => settingsBootstrap.settingsService.getComputeBookmarks(providerId),
        set: (providerId, folders) =>
          settingsBootstrap.settingsService.setComputeBookmarks(providerId, folders)
      },
      enabledHosts: computeAdmission.sessionEnabledComputeHostsOwner,
      events: applicationEvents
    },
    permissionGrants: settingsEffects.permissionGrantProjection,
    tags: researchCatalog.tagService,
    literature: createLiteratureCommandOwner({
      journalAttributes: researchCatalog.journalAttributes,
      literatureBatchJobs: researchCatalog.literatureBatchJobs,
      literatureCitationStyles: researchCatalog.literatureCitationStyles,
      literatureCitationFormatter: researchCatalog.literatureCitationFormatter,
      literatureReferenceResolver: researchCatalog.literatureReferenceResolver,
      literatureMetadataEnricher: researchCatalog.literatureMetadataEnricher,
      literatureFullTextFinder: researchCatalog.literatureFullTextFinder,
      artifactProvenanceRepository: managedFiles.artifactProvenanceRepository,
      managedFileVersionService,
      literatureCitationDocument: researchCatalog.literatureCitationDocument,
      literatureCatalog: researchCatalog.literatureCatalog,
      literaturePdfImporter: researchCatalog.literaturePdfImporter,
      contentRepository: managedFiles.contentRepository
    }),
    memory: {
      snapshot: () => researchCatalog.memoryService.snapshot(),
      setEnabled: async (request) => {
        const before = await researchCatalog.memoryService.isEnabled()
        const snapshot = await researchCatalog.memoryService.setEnabled(request)
        if (before !== snapshot.enabled) await agentRuntime.runtime.requestSkillsReload()
        return snapshot
      },
      createCategory: (request) => researchCatalog.memoryService.createCategory(request),
      updateCategory: (request) => researchCatalog.memoryService.updateCategory(request),
      deleteCategory: (request) => researchCatalog.memoryService.deleteCategory(request),
      createEntry: (request) => researchCatalog.memoryService.createEntry(request),
      updateEntry: (request) => researchCatalog.memoryService.updateEntry(request),
      deleteEntry: (request) => researchCatalog.memoryService.deleteEntry(request),
      clearAll: () => researchCatalog.memoryService.clearAll()
    },
    dataContent: {
      runtimeWriter: artifactSurfaces.runtimeWriter,
      artifacts: artifactSurfaces.artifactHandlers,
      electron: {
        inspectSessionDiagnostics: (invocation) =>
          sessionFoundation.sessionDiagnosticsDesktop.inspect(invocation.args[0]),
        exportSessionDiagnostics: (invocation) =>
          sessionFoundation.sessionDiagnosticsDesktop.export(invocation.args[0]),
        cancelSessionDiagnostics: (invocation) =>
          sessionFoundation.sessionDiagnosticsDesktop.cancel(invocation.args[0]),
        sessionPackageOperation: async (invocation) =>
          sessionPackageSurfaces.sessionPackageDesktop.respond(invocation.args[0]),
        forkSession: (invocation) =>
          sessionPackageSurfaces.sessionPackageDesktop.fork(
            invocation.args[0],
            invocation.callerContext.lifecycleClientId
          ),
        exportSessionPackage: (invocation) =>
          sessionPackageSurfaces.sessionPackageDesktop.export(
            invocation.args[0],
            BrowserWindow.fromWebContents(electronSenderFor(invocation)) ?? undefined
          ),
        importSessionPackage: (invocation) =>
          sessionPackageSurfaces.sessionPackageDesktop.import(
            BrowserWindow.fromWebContents(electronSenderFor(invocation)) ?? undefined,
            invocation.callerContext.lifecycleClientId,
            invocation.args[0],
            invocation.args[1]
          ),
        exportConversationFromInvokingWindow: (invocation) => {
          const sender = electronSenderFor(invocation)
          return sessionPackageSurfaces.conversationExportService.exportConversation(
            invocation.args[0],
            BrowserWindow.fromWebContents(sender) ?? undefined
          )
        },
        stageLocalFileWithProgress: (invocation) => {
          const sender = electronSenderFor(invocation)
          return projectLifecycle.uploadCommandOwner.stageLocalFile(invocation, {
            report: (progress) => sender.send('uploads:transfer-progress', progress)
          })
        }
      },
      events: applicationEvents,
      managedPreview: managedFiles.managedPreviewOwners,
      preview: {
        load: (request) => sessionPackages.previewStateRepository.get(request.projectId),
        save: (request) =>
          sessionPackages.previewStateRepository.save(
            request.projectId,
            request.state,
            request.expectedRevision
          ),
        delete: (request) => sessionPackages.previewStateRepository.delete(request.projectId)
      },
      projectFiles: projectLifecycle.projectFilesHandlers,
      projects: projectLifecycle.projectHandlers,
      sessions: {
        ...sessionSurfaces.sessionPersistenceHandlers,
        filterPdfContextCandidates: (request) =>
          documentReading.sessionPdfContextOwner.filterCandidates(request),
        linkPdfContext: (request) =>
          linkPdfContextWithCapability({
            read: () =>
              sessionAuthority.sessionPersistenceCoordinator.readSessionRuntimeContext(
                request.projectId,
                request.sessionId
              ),
            link: () => documentReading.sessionPdfContextOwner.linkWithResult(request),
            enable: () =>
              runtimeRef.current?.enableLiteratureContext(request.sessionId) ?? Promise.resolve(),
            rollback: (linked, previous) =>
              sessionAuthority.sessionPersistenceCoordinator
                .patchSessionRuntimeContext({
                  projectId: request.projectId,
                  sessionId: request.sessionId,
                  expectedRevision: linked.revision,
                  patch: { pdfContext: previous.pdfContext }
                })
                .then(() => undefined),
            onRollbackError: (error) => {
              documentReading.literatureContextLog.error('PDF context link rollback failed', {
                sessionId: request.sessionId,
                ...errorLogFields(error)
              })
            }
          }),
        unlinkPdfContext: async (request) => {
          const context = await documentReading.sessionPdfContextOwner.unlink(request)
          if ((context.pdfContext?.bindings.length ?? 0) === 0) {
            try {
              await runtimeRef.current?.disableLiteratureContext(request.sessionId)
            } catch (error) {
              documentReading.literatureContextLog.warn(
                'Literature capability disable failed after PDF unlink',
                {
                  sessionId: request.sessionId,
                  ...errorLogFields(error)
                }
              )
            }
          }
          return context
        },
        editDetails: (request) => sessionSurfaces.sessionDetailsOwner.edit(request),
        bindTaskSession: (request) =>
          sessionAuthority.sessionPersistenceCoordinator.bindTaskSession(request),
        admitTaskTurn: (request) =>
          sessionAuthority.sessionPersistenceCoordinator.admitTaskTurn(request),
        stageTaskCompletion: (request) =>
          sessionAuthority.sessionPersistenceCoordinator.stageTaskCompletion(request),
        settleTaskCompletion: (request) =>
          sessionAuthority.sessionPersistenceCoordinator.settleTaskCompletion(request),
        failTaskRun: (request) =>
          sessionAuthority.sessionPersistenceCoordinator.failTaskRun(request),
        updateSessionConfiguration: (session, expectedRevision) =>
          sessionAuthority.sessionPersistenceCoordinator.updateSessionConfiguration(
            session,
            expectedRevision
          ),
        saveSession: async (session, options, authority) => {
          const result = authority
            ? await sessionSurfaces.sessionPersistenceHandlers.saveSession(
                session,
                options,
                authority
              )
            : await sessionSurfaces.sessionPersistenceHandlers.saveSession(session, options)
          sessionSurfaces.sessionDetailsOwner.afterSessionSaved(result.session)
          return result
        },
        deleteSession: (request) => artifactSurfaces.sessionDeletionOwner.delete(request)
      },
      uploads: projectLifecycle.uploadCommandOwner,
      withDataRootWrite
    },
    host: {
      localModels: documentReading.localModelOwner,
      pdfStructure: documentReading.pdfStructureReader,
      cli: cliCommandOwner,
      github: githubCommandOwner,
      localFs: managedFiles.localFsService,
      logs: logsCommandOwner,
      notifications: {
        getSnapshot: () => storageStartup.notificationInbox.getSnapshot(),
        markRead: (request) => storageStartup.notificationInbox.markRead(request.ids),
        markAllRead: (request) =>
          storageStartup.notificationInbox.markAllRead(request.throughSequence),
        markSessionCompletionsRead: (request) =>
          storageStartup.notificationInbox.markSessionCompletionsRead(request.sessionIds),
        peekPendingOpenSession: () => taskNotifications.peekPendingOpenSession(),
        takePendingOpenSession: (expectedToken) =>
          taskNotifications.takePendingOpenSession(expectedToken)
      },
      reviewer: reviewerCommandOwner,
      storage: storageHandoff.storageCommandOwner,
      update: handoff.updateCommandOwner
    }
  }
  return { applicationCommandDependencies }
}
