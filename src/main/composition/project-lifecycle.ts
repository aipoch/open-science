import { reserveAcpSessionStorageCleanup } from '../acp/session-registry'
import type { ImageTaskOwner } from '../image-model/tasks'
import type { PromptOptimizationService } from '../projects/prompt-optimization'
import { join } from 'node:path'
import { HarnessStorageCleanup } from '../harness-acp/storage-cleanup'
import type { ComputeJobOwnerLiveness } from '@aipoch/compute/node'
import type { ResearchFilmLifecycle } from '../research-video/lifecycle'
import { createLogger, diagnosticErrorFields } from '@aipoch/diagnostics/node'
import { LIFECYCLE_CHANNELS } from '../../shared/lifecycle-events'
import { createAcpRuntime } from '../acp/runtime-composition'
import { SideChatRelayOwner } from '../acp/side-chat-relay-owner'
import { VisionEvidenceRepository } from '../acp/vision-evidence-repository'
import type { ApplicationEvents } from '../application-events'
import { type ApplicationModuleBuilder } from '../application-runtime'
import { ArchiveCoordinator } from '../archive/coordinator'
import { ArtifactReproducibilityAttemptOwner } from '../artifacts/artifact-reproducibility-lifecycle'
import { ArtifactProvenanceRepository } from '../artifacts/provenance-repository'
import { BackgroundResultDeliveryOwner } from '../background-result-delivery/owner'
import { BookmarkRepository } from '../bookmarks/repository'
import { SessionEnabledComputeHostsOwner } from '../compute/session-enabled-hosts-owner'
import { registerSideChatIpcHandlers } from '../desktop-surface-declarations'
import {
  createManagedFileVersionCommandOwner,
  createManagedFileVersionHandlers
} from '../managed-file-versions/ipc'
import { ManagedFileVersionService } from '../managed-file-versions/service'
import type { NotebookRuntimeService } from '../notebook/runtime-service'
import { createNotificationInboxController } from '../notifications/notification-inbox-controller'
import { bindNotificationInboxDeletionRuntime } from '../notifications/notification-inbox-runtime'
import { createPermissionGrantRegistry } from '../permission-grants/registry'
import { createProjectFilesHandlers } from '../project-files/ipc'
import { createManagedFileIndexRepository } from '../project-files/repository'
import {
  ProjectDeletionCoordinator,
  ProjectDeletionRecoveryLoop,
  recoverDeletionWork
} from '../projects/deletion-coordinator'
import { createDefaultProjectRepository, createProjectHandlers } from '../projects/ipc'
import { getProjectDbClient } from '../projects/prisma-client'
import { ProjectRuntimeQuiescenceOwner } from '../projects/project-runtime-quiescence-owner'
import { broadcastToRenderers } from '../renderer-broadcast'
import { ReviewerProjectRuntimeOwner } from '../reviewer/project-runtime-owner'
import type { SessionPersistenceCommands } from '../session-persistence/coordinator'
import {
  createDefaultReviewRepository,
  createDefaultSessionRepository
} from '../session-persistence/ipc'
import { createSideChatCommandOwner, type SideChatCommandOwner } from '../side-chat/command-owner'

import { createMainPromptSideChatRelay } from '../side-chat/main-prompt-relay'
import { SideChatRuntimeOwner } from '../side-chat/runtime-owner'
import { resolveConfigRoot, resolveDataRoot } from '../storage-root'
import { detectActiveSessions } from '../storage/detect-active'
import { withDataRootWrite } from '../storage/migration-state'
import { createUploadCommandOwner } from '../uploads/command-owner'
import { createDefaultUploadRepository } from '../uploads/ipc'

export function composeProjectLifecycle({
  imageTasks,
  promptOptimization,
  applicationEvents,
  notificationInbox,
  uploadRepository,
  managedFileVersionService,
  runtimeRef,
  scheduleRepository,
  backgroundResultDelivery,
  sideChatOwnerRef,
  projectRepository,
  artifactProvenanceRepository,
  bookmarkRepository,
  reviewerProjectRuntime,
  notebookActivityRef,
  configRoot,
  permissionGrantRegistry,
  projectFilesRepository,
  computeJobActivityRef,
  projectRuntimeQuiescenceRef,
  artifactReproducibilityAttemptOwnerRef,
  computeJobDeletionPort,
  getActiveDelegatedSessions,
  getActiveSideChatSessions,
  sessionPersistenceCoordinator,
  researchFilmLifecycle,
  clearSessionCredentials,
  getNotebookService
}: {
  imageTasks?: Pick<ImageTaskOwner, 'isBusy' | 'cancelSessions' | 'cancelProject'>
  promptOptimization?: PromptOptimizationService
  applicationEvents: ApplicationEvents
  notificationInbox: ReturnType<typeof createNotificationInboxController>
  researchFilmLifecycle: ResearchFilmLifecycle
  uploadRepository: ReturnType<typeof createDefaultUploadRepository>
  managedFileVersionService: ManagedFileVersionService
  runtimeRef: { current: ReturnType<typeof createAcpRuntime> | undefined }
  scheduleRepository?: import('../schedules/repository').ScheduleRepository
  backgroundResultDelivery: BackgroundResultDeliveryOwner
  sideChatOwnerRef: { current: SideChatRuntimeOwner | undefined }
  projectRepository: ReturnType<typeof createDefaultProjectRepository>
  artifactProvenanceRepository: ArtifactProvenanceRepository
  bookmarkRepository: BookmarkRepository
  reviewerProjectRuntime: ReviewerProjectRuntimeOwner
  notebookActivityRef: {
    current: { getActiveNotebookSessions(): { projectId: string; sessionId: string }[] } | undefined
  }
  configRoot: ReturnType<typeof resolveConfigRoot>
  permissionGrantRegistry: Awaited<ReturnType<typeof createPermissionGrantRegistry>>
  projectFilesRepository: ReturnType<typeof createManagedFileIndexRepository>
  computeJobActivityRef: {
    current?: {
      findNonTerminal(): Promise<Array<{ project_id: string }>>
      countNonTerminalBySession(sessionId: string): Promise<number>
    }
  }
  projectRuntimeQuiescenceRef: { current?: ProjectRuntimeQuiescenceOwner }
  artifactReproducibilityAttemptOwnerRef: {
    current?: ArtifactReproducibilityAttemptOwner
  }
  computeJobDeletionPort: {
    restoreProjectJobDeletion: (projectId: string) => Promise<void>
    prepareSessionJobDeletion: (projectId: string, sessionId: string) => Promise<void>
    commitSessionJobDeletion: (projectId: string, sessionId: string) => Promise<void>
    prepareProjectJobDeletion: (projectId: string) => Promise<void>
    commitProjectJobDeletion: (projectId: string) => Promise<void>
    abortSessionJobDeletion: (projectId: string, sessionId: string) => Promise<void>
    abortProjectJobDeletion: (projectId: string) => Promise<void>
  }
  getActiveDelegatedSessions: () => { projectId: string; sessionId: string }[]
  getActiveSideChatSessions: () => { projectId: string; sessionId: string }[]
  sessionPersistenceCoordinator: Pick<
    SessionPersistenceCommands,
    | 'assertProjectArchivable'
    | 'assertSessionAvailable'
    | 'commitSideChatRelays'
    | 'completeProjectSessionDeletion'
    | 'deleteProjectSessions'
    | 'getProjectSessionDeletionState'
    | 'listLegacyProjectSessionTombstones'
    | 'repairProjectFiles'
    | 'runSessionMutation'
    | 'sessionProjectId'
    | 'setSessionDeletionHandlers'
    | 'updateArchive'
  >
  getNotebookService: () => NotebookRuntimeService
  clearSessionCredentials: (sessionId: string) => void
}): {
  sideChatRelay: SideChatRelayOwner
  mainPromptSideChatRelay: ReturnType<typeof createMainPromptSideChatRelay>
  uploadCommandOwner: ReturnType<typeof createUploadCommandOwner>
  reviewRepository: ReturnType<typeof createDefaultReviewRepository>
  projectDeletionCoordinator: ProjectDeletionCoordinator
  detectSessionExportBlockingSessions: () => ReturnType<typeof detectActiveSessions>
  archiveCoordinator: ArchiveCoordinator
  sessionEnabledComputeHostsOwnerRef: { current?: SessionEnabledComputeHostsOwner }
  visionEvidenceRepository: VisionEvidenceRepository
  projectHandlers: ReturnType<typeof createProjectHandlers>
  projectFilesHandlers: ReturnType<typeof createProjectFilesHandlers>
  managedFileVersionHandlers: ReturnType<typeof createManagedFileVersionCommandOwner>
} {
  const schedulesChanged = (projectId: string, sessionId: string | null): void => {
    applicationEvents.publish('schedules:changed', { projectId, sessionId })
  }
  const sideChatRelay = new SideChatRelayOwner({
    targetState: (parentSessionId) => {
      const runtime = runtimeRef.current
      if (!runtime) return 'completed'
      const snapshot = runtime.getSnapshot()
      if (snapshot.promptInFlightSessionIds.includes(parentSessionId)) {
        return runtime.hasPendingSideChatInteraction(parentSessionId) ? 'waiting' : 'running'
      }
      return runtime.liveSessionProjectId(parentSessionId) ? 'idle' : 'completed'
    }
  })
  const mainPromptSideChatRelay = createMainPromptSideChatRelay({
    relay: sideChatRelay,
    steerAdvisory: async (request) =>
      runtimeRef.current
        ? runtimeRef.current.steerSideChatAdvisory(request)
        : Object.freeze({ injected: false }),
    commitSideChatRelays: (command) => sessionPersistenceCoordinator.commitSideChatRelays(command),
    onDelivered: (event) => broadcastToRenderers('side-chat:relay-delivered', event)
  })
  const uploadCommandOwner = createUploadCommandOwner(uploadRepository, {
    openLatestManagedFile: (request) =>
      managedFileVersionService.openLatest({
        source: 'upload',
        projectId: request.projectId!,
        fileId: request.fileId!
      }),
    openManagedFileVersion: (request) =>
      managedFileVersionService.openVersion(
        { source: 'upload', projectId: request.projectId!, fileId: request.fileId! },
        request.versionId
      ),
    withSessionMutation: (projectId, sessionId, mutation) =>
      sessionPersistenceCoordinator.runSessionMutation(projectId, sessionId, mutation)
  })
  const reviewRepository = createDefaultReviewRepository()
  const projectDeletionCoordinator = new ProjectDeletionCoordinator(
    projectRepository,
    sessionPersistenceCoordinator,
    reviewRepository,
    artifactProvenanceRepository,
    permissionGrantRegistry,
    {
      beforeProjectDelete: async (projectId) => {
        const owner = projectRuntimeQuiescenceRef.current
        if (!owner) throw new Error('Project runtime cleanup is not initialized.')
        await archiveCoordinator.withProjectDeletion(projectId, async () => {
          imageTasks?.cancelProject(projectId)
          getNotebookService().beginProjectDeletion(projectId)
          await artifactReproducibilityAttemptOwnerRef.current?.cancelProject(projectId)
          await owner.quiesceProject(projectId)
        })
      },
      restoreProjectDeletion: async (projectId) => {
        await backgroundResultDelivery.prepareProjectDeletion(projectId)
        archiveCoordinator.restoreProjectDeletion(projectId)
        getNotebookService().beginProjectDeletion(projectId)
        reviewerProjectRuntime.restoreProjectDeletion(projectId)
        await computeJobDeletionPort.restoreProjectJobDeletion(projectId)
      },
      finalizeProjectDeletion: async (projectId) => {
        const owner = sideChatOwnerRef.current
        if (!owner) throw new Error('Side chat runtime cleanup is not initialized.')
        await owner.completeProjectDeletion(projectId)
        await getNotebookService().deleteProjectFileEvidence(projectId)
        await getNotebookService().deleteProjectInputs(projectId)
        await getNotebookService().finishPendingRunDeletion({ projectId })
        await backgroundResultDelivery.commitProjectDeletion(projectId)
        await scheduleRepository?.deleteTarget(projectId)
        schedulesChanged(projectId, null)
      },
      completeProjectDeletion: (projectId) => {
        const notebook = getNotebookService()
        notebook.forgetDeletedExecutionIntents({ projectId })
        archiveCoordinator.releaseProjectDeletion(projectId)
        notebook.releaseProjectDeletion(projectId)
        reviewerProjectRuntime.releaseProjectDeletion(projectId)
      },
      abortProjectDeletion: async (projectId) => {
        archiveCoordinator.releaseProjectDeletion(projectId)
        getNotebookService().releaseProjectDeletion(projectId)
        reviewerProjectRuntime.releaseProjectDeletion(projectId)
        sideChatOwnerRef.current?.restoreProject(projectId)
        backgroundResultDelivery.abortProjectDeletion(projectId)
        await computeJobDeletionPort.abortProjectJobDeletion(projectId)
      }
    },
    applicationEvents
  )
  const detectBlockingSessions = (
    includeSideChat: boolean
  ): ReturnType<typeof detectActiveSessions> =>
    detectActiveSessions({
      runtime: {
        getActivePromptSessions: () => runtimeRef.current?.getActivePromptSessions() ?? []
      },
      sideChat: {
        getActivePromptSessions: () => (includeSideChat ? getActiveSideChatSessions() : [])
      },
      delegated: { getActiveDelegatedSessions },
      notebook: {
        getActiveNotebookSessions: () =>
          notebookActivityRef.current?.getActiveNotebookSessions() ?? []
      }
    })
  const detectArchiveBlockingSessions = (): ReturnType<typeof detectActiveSessions> =>
    detectBlockingSessions(true)
  const detectSessionExportBlockingSessions = (): ReturnType<typeof detectActiveSessions> =>
    detectBlockingSessions(false)
  const archiveCoordinator = new ArchiveCoordinator(
    projectRepository,
    sessionPersistenceCoordinator,
    {
      isSessionLocallyBusy(projectId, sessionId) {
        const snapshot = runtimeRef.current?.getSnapshot()
        return (
          imageTasks?.isBusy(projectId, sessionId) === true ||
          snapshot?.pendingPermissions?.some((request) => request.sessionId === sessionId) ===
            true ||
          snapshot?.pendingElicitations?.some((request) => request.sessionId === sessionId) ===
            true ||
          sideChatOwnerRef.current?.hasForParent(sessionId) === true ||
          detectArchiveBlockingSessions().some(
            (session) => session.projectId === projectId && session.sessionId === sessionId
          )
        )
      },
      async isSessionBusy(projectId, sessionId) {
        const computeJobs = computeJobActivityRef.current
        if (!computeJobs) throw new Error('Compute Job activity is not initialized.')
        const jobs = await computeJobs.countNonTerminalBySession(sessionId)
        // Read synchronous activity after the database await so a newly active runtime is visible.
        return jobs > 0 || this.isSessionLocallyBusy!(projectId, sessionId)
      },
      getSessionExportBlocker: async (projectId, sessionId) => {
        const computeJobs = computeJobActivityRef.current
        if (!computeJobs) throw new Error('Compute Job activity is not initialized.')
        const jobs = await computeJobs.countNonTerminalBySession(sessionId)
        if (imageTasks?.isBusy(projectId, sessionId)) return 'image'
        if (jobs > 0) return 'compute'
        const activity = detectSessionExportBlockingSessions().find(
          (session) => session.projectId === projectId && session.sessionId === sessionId
        )
        if (activity?.kind === 'agent') {
          const snapshot = runtimeRef.current?.getSnapshot()
          if (snapshot?.pendingPermissions?.some((item) => item.sessionId === sessionId))
            return 'permission'
          if (snapshot?.pendingElicitations?.some((item) => item.sessionId === sessionId))
            return 'question'
        }
        return activity?.kind
      },
      isProjectBusy: async (projectId) => {
        if (
          imageTasks?.isBusy(projectId) === true ||
          reviewerProjectRuntime.isProjectBusy(projectId) ||
          detectArchiveBlockingSessions().some((session) => session.projectId === projectId)
        ) {
          return true
        }
        const computeJobs = computeJobActivityRef.current
        if (!computeJobs) throw new Error('Compute Job activity is not initialized.')
        return (await computeJobs.findNonTerminal()).some((job) => job.project_id === projectId)
      },
      liveSessionProjectId: (sessionId) => runtimeRef.current?.liveSessionProjectId(sessionId)
    },
    {
      cancelProject: async (projectId) => {
        await scheduleRepository?.pauseTarget(projectId)
        schedulesChanged(projectId, null)
        await artifactReproducibilityAttemptOwnerRef.current?.cancelProject(projectId)
      },
      cancelSession: async (projectId, sessionId) => {
        await scheduleRepository?.pauseTarget(projectId, sessionId)
        schedulesChanged(projectId, sessionId)
        await artifactReproducibilityAttemptOwnerRef.current?.cancelSession(projectId, sessionId)
      }
    }
  )
  notificationInbox.setSessionAvailability((sessionId) =>
    archiveCoordinator.isSessionAvailableById(sessionId)
  )
  archiveCoordinator.setMarkReadSessions((sessionIds) =>
    notificationInbox.markSessionsRead(sessionIds)
  )
  const sessionEnabledComputeHostsOwnerRef: { current?: SessionEnabledComputeHostsOwner } = {}
  const visionEvidenceRepository = new VisionEvidenceRepository(() =>
    getProjectDbClient(configRoot)
  )
  const harnessStorageCleanup = new HarnessStorageCleanup({
    tryClaimIdentities: reserveAcpSessionStorageCleanup,
    sessionDirectory: join(configRoot, 'open-science-agent', 'sessions'),
    receiptDirectory: () => join(resolveDataRoot(), 'open-science-agent', 'tool-receipts'),
    isLive: (projectId, sessionId) =>
      runtimeRef.current?.hasLiveSession(projectId, sessionId) ?? false
  })
  bindNotificationInboxDeletionRuntime({
    inbox: notificationInbox,
    sessionPersistenceCoordinator,
    onSessionsDeleted: async (sessionIds) => {
      getNotebookService().forgetDeletedExecutionIntents({ sessionIds })
      imageTasks?.cancelSessions(sessionIds)
      for (const sessionId of sessionIds) clearSessionCredentials(sessionId)
      const results = await Promise.allSettled([
        getNotebookService().finishPendingRunDeletion({ sessionIds }),
        sessionEnabledComputeHostsOwnerRef.current?.clear(sessionIds),
        sideChatOwnerRef.current?.invalidateParents(sessionIds),
        visionEvidenceRepository.deleteSessions(sessionIds),
        bookmarkRepository.deleteSessions(sessionIds),
        researchFilmLifecycle.deleteSessions(sessionIds),
        harnessStorageCleanup.commit(sessionIds),
        scheduleRepository?.deleteSessions(sessionIds).then((targets) => {
          for (const target of targets) schedulesChanged(target.projectId, target.sessionId)
        })
      ])
      // The coordinator must retain deleted identities until every cleanup has settled.
      const failed = results.find((result) => result.status === 'rejected')
      if (failed) throw failed.reason
    },
    onSessionsReconciled: async (sessionIds, archivedIds) => {
      await visionEvidenceRepository.reconcileSessions(sessionIds)
      const archived = new Set(archivedIds)
      for (const target of (await scheduleRepository?.sessionTargets()) ?? []) {
        if (!archived.has(target.sessionId)) continue
        await scheduleRepository!.pauseTarget(target.projectId, target.sessionId)
        schedulesChanged(target.projectId, target.sessionId)
      }
    },
    planSessionsReconciliation: async (sessionIds) => {
      const existing = new Set(sessionIds)
      return [
        ...(await researchFilmLifecycle.planSessionReconciliation(sessionIds)),
        ...(await harnessStorageCleanup.planReconciliation(sessionIds)),
        ...((await scheduleRepository?.sessionTargets(true)) ?? [])
          .filter((target) => !existing.has(target.sessionId))
          .map((target) => ({
            ...target,
            apply: async () => {
              // The catalog owner revalidates absence under the Session recovery reservation.
              await scheduleRepository!.deleteTarget(target.projectId, target.sessionId)
              schedulesChanged(target.projectId, target.sessionId)
            }
          }))
      ]
    }
  })
  const projectHandlers = createProjectHandlers(projectRepository, projectDeletionCoordinator, {
    promptOptimization,
    updateArchive: (request) => archiveCoordinator.updateProjectArchive(request),
    onAgentContextChanged: (projectId) => {
      // Runtime generations capture Project Agent Context during Session setup. Retiring them marks
      // idle Sessions for resume immediately; an in-flight turn drains before its next prompt.
      void runtimeRef.current?.requestProjectAgentContextReload(projectId)
    }
  })
  const projectFilesHandlers = createProjectFilesHandlers(
    projectFilesRepository,
    sessionPersistenceCoordinator,
    projectDeletionCoordinator,
    (file) =>
      managedFileVersionService.openVersion(
        {
          source: file.source,
          projectId: file.projectId,
          fileId: file.sourceFileId
        },
        file.sourceVersionId
      )
  )
  const managedFileVersionHandlers = createManagedFileVersionCommandOwner(
    createManagedFileVersionHandlers(managedFileVersionService, {
      withDataRootWrite,
      onChanged: (event) => broadcastToRenderers('project-files:changed', event)
    })
  )
  return {
    sideChatRelay,
    mainPromptSideChatRelay,
    uploadCommandOwner,
    reviewRepository,
    projectDeletionCoordinator,
    detectSessionExportBlockingSessions,
    archiveCoordinator,
    sessionEnabledComputeHostsOwnerRef,
    visionEvidenceRepository,
    projectHandlers,
    projectFilesHandlers,
    managedFileVersionHandlers
  }
}

export async function composeProjectRecovery({
  declareElectronAdapter,
  applicationEvents,
  sessionRepository,
  isComputeJobOwnerLive,
  projectDeletionCoordinator,
  archiveCoordinator,
  jobDeletionOwner,
  runtime,
  sideChatRuntime,
  modules
}: {
  declareElectronAdapter: (name: string, install: () => void | (() => void)) => void
  promptOptimization?: PromptOptimizationService
  applicationEvents: ApplicationEvents
  sessionRepository: ReturnType<typeof createDefaultSessionRepository>
  isComputeJobOwnerLive: ({
    projectId,
    sessionId
  }: {
    projectId: string
    sessionId: string
  }) => Promise<ComputeJobOwnerLiveness>
  projectDeletionCoordinator: ProjectDeletionCoordinator
  archiveCoordinator: ArchiveCoordinator
  jobDeletionOwner: import('@aipoch/compute/node').ComputeJobDeletionOwner
  runtime: ReturnType<typeof createAcpRuntime>
  sideChatRuntime: SideChatRuntimeOwner
  modules: ApplicationModuleBuilder
}): Promise<SideChatCommandOwner> {
  // Recovery quiesces every runtime owner, so do not start its first attempt until ACP, Delegation,
  // Notebook, Side Chat, and the composed quiescence boundary are all initialized. The bounded
  // durable barrier restoration above still runs early enough to block admission during startup.
  const projectDeletionRecovery = new ProjectDeletionRecoveryLoop(
    () =>
      recoverDeletionWork({
        recoverOrphanJobs: () => jobDeletionOwner.reconcileOrphanJobs(isComputeJobOwnerLive),
        replaySessionProjection: () => sessionRepository.reconcilePendingSessionProjection(),
        recoverProjects: () => projectDeletionCoordinator.recoverPendingDeletions()
      }),
    {
      onError: (error) =>
        createLogger('compute-job-deletion').error(
          'background deletion recovery failed; retry scheduled',
          diagnosticErrorFields(error)
        ),
      onStatusChanged: () =>
        applicationEvents.publish(LIFECYCLE_CHANNELS.projectDeletionCleanupChanged, undefined)
    }
  )
  projectDeletionCoordinator.setRecoveryLoop(projectDeletionRecovery)
  const removeProjectDeletionRecoveryWake = applicationEvents.subscribe((event) => {
    if (event.channel === 'project:deleted' && event.payload.status === 'cleanup-pending') {
      projectDeletionRecovery.wake()
    }
  })
  await modules.add(projectDeletionRecovery, (recovery) => ({
    name: 'project-deletion-recovery',
    capability: undefined,
    start: () => recovery.start(),
    dispose: async () => {
      removeProjectDeletionRecoveryWake()
      await recovery.stop()
    }
  }))
  const sideChatCommands = createSideChatCommandOwner(sideChatRuntime, {
    loadParentSession: (projectId, sessionId) =>
      sessionRepository.loadSession(projectId, sessionId),
    hasLiveParentSession: (projectId, sessionId) => runtime.hasLiveSession(projectId, sessionId),
    withParentAvailable: (sessionId, operation) =>
      archiveCoordinator.withSessionAvailableById(sessionId, operation)
  })
  declareElectronAdapter('side-chat', () => registerSideChatIpcHandlers(sideChatCommands))
  return sideChatCommands
}
