import {
  LIFECYCLE_CHANNELS,
  MAIN_DELEGATED_WORK_LIFECYCLE_CLIENT_ID,
  MAIN_RUNTIME_CONTEXT_LIFECYCLE_CLIENT_ID,
  MAIN_RUNTIME_TRANSCRIPT_LIFECYCLE_CLIENT_ID
} from '../../shared/lifecycle-events'
import { createAcpRuntime } from '../acp/runtime-composition'
import { ArtifactReproducibilityAttemptOwner } from '../artifacts/artifact-reproducibility-lifecycle'
import { type ArtifactHandlers } from '../artifacts/ipc'
import { ProvenanceMessageSnapshotRepository } from '../artifacts/provenance-message-snapshot'
import { ArtifactProvenanceRepository } from '../artifacts/provenance-repository'
import type { ComputeJobOwnerLiveness } from '../compute/job-deletion-owner'
import { createProductionDelegatedWorkComposition } from '../delegation/production-composition'
import { type DiagnosticOperation } from '../diagnostics/operation'
import { ImmutableInputAuthority } from '../immutable-input-authority'
import { ManagedFileVersionService } from '../managed-file-versions/service'
import { NotebookInputRegistry } from '../notebook/input-registry'
import { seedDefaultPermissionGrants } from '../permission-grants/defaults'
import { reconcilePermissionGrantOwners } from '../permission-grants/reconciliation'
import { createPermissionGrantRegistry } from '../permission-grants/registry'
import { isPermissionGrantScopeLive } from '../permission-grants/scope-liveness'
import { createManagedFileIndexRepository } from '../project-files/repository'
import { createDefaultProjectRepository } from '../projects/ipc'
import { getProjectDbClient } from '../projects/prisma-client'
import { ProjectRuntimeQuiescenceOwner } from '../projects/project-runtime-quiescence-owner'
import { broadcastToRenderers } from '../renderer-broadcast'
import { type ReviewerCommandOwner } from '../reviewer/ipc'
import { ReviewerProjectRuntimeOwner } from '../reviewer/project-runtime-owner'
import {
  SessionPersistenceCoordinator,
  type ComputeJobDeletionParticipant
} from '../session-persistence/coordinator'
import { createDefaultSessionRepository } from '../session-persistence/ipc'
import { MainMessageAttributionAuthority } from '../session-persistence/message-attribution-authority'
import { SideChatRuntimeOwner } from '../side-chat/runtime-owner'
import { resolveConfigRoot, resolveDataRoot } from '../storage-root'
import { createDelegatedActivityProjection } from '../storage/detect-active'
import {
  markManagedProjectWorkspacesRetained,
  markManagedWorkspaceRetained,
  reconcileProvisionalManagedWorkspaces,
  restoreManagedProjectWorkspacesActive,
  restoreManagedWorkspaceActive
} from '../storage/managed-workspace-ownership'
import { createDefaultUploadRepository } from '../uploads/ipc'

export async function composeSessionAuthority({
  uploadRepository,
  managedFileVersionService,
  runtimeRef,
  sideChatOwnerRef,
  sessionRepository,
  projectRepository,
  packagePublicationOwner,
  sessionPackageService,
  immutableInputAuthority,
  artifactProvenanceRepository,
  provenanceMessageSnapshots,
  getDelegatedWorkRef,
  composition
}: {
  uploadRepository: ReturnType<typeof createDefaultUploadRepository>
  managedFileVersionService: ManagedFileVersionService
  runtimeRef: { current: ReturnType<typeof createAcpRuntime> | undefined }
  sideChatOwnerRef: { current: SideChatRuntimeOwner | undefined }
  sessionRepository: ReturnType<typeof createDefaultSessionRepository>
  projectRepository: ReturnType<typeof createDefaultProjectRepository>
  packagePublicationOwner: {
    current?: Pick<SessionPersistenceCoordinator, 'adoptPublishedSession'>
  }
  sessionPackageService: import('../session-package/service').SessionPackageService
  immutableInputAuthority: ImmutableInputAuthority
  artifactProvenanceRepository: ArtifactProvenanceRepository
  provenanceMessageSnapshots: ProvenanceMessageSnapshotRepository
  getDelegatedWorkRef: () => {
    current?: ReturnType<typeof createProductionDelegatedWorkComposition>
  }
  composition: DiagnosticOperation
}): Promise<{
  artifactHandlersRef: { current: ArtifactHandlers | undefined }
  reviewerCommandOwnerRef: { current: ReviewerCommandOwner | undefined }
  reviewerProjectRuntime: ReviewerProjectRuntimeOwner
  messageAttributionAuthority: MainMessageAttributionAuthority
  notebookActivityRef: {
    current: { getActiveNotebookSessions(): { projectId: string; sessionId: string }[] } | undefined
  }
  configRoot: ReturnType<typeof resolveConfigRoot>
  permissionGrantRegistry: Awaited<ReturnType<typeof createPermissionGrantRegistry>>
  projectFilesRepository: ReturnType<typeof createManagedFileIndexRepository>
  notebookInputRegistry: NotebookInputRegistry
  isComputeJobOwnerLive: ({
    projectId,
    sessionId
  }: {
    projectId: string
    sessionId: string
  }) => Promise<ComputeJobOwnerLiveness>
  computeJobDeletionRef: {
    current?: Required<ComputeJobDeletionParticipant> & {
      reconcileProjectOrphanJobs(
        projectId: string,
        isOwnerLive: typeof isComputeJobOwnerLive
      ): Promise<void>
    }
  }
  computeJobActivityRef: {
    current?: {
      findNonTerminal(): Promise<Array<{ project_id: string }>>
      countNonTerminalBySession(sessionId: string): Promise<number>
    }
  }
  sessionCacheOwnerRef: {
    current?: {
      removeSession(projectId: string, sessionId: string): Promise<void>
      removeProject(projectId: string): Promise<void>
      reconcileActiveSessions(
        sessions: ReadonlyArray<{ projectId: string; sessionId: string }>
      ): Promise<void>
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
  sessionPersistenceCoordinator: SessionPersistenceCoordinator
}> {
  // Permission scope validation starts before the ACP coordinator is constructed. Keep the late-bound
  // reference here so a first-turn Session grant can recognize its live owner before the renderer's
  // asynchronous session persistence finishes.
  const artifactHandlersRef: { current: ArtifactHandlers | undefined } = { current: undefined }
  const reviewerCommandOwnerRef: { current: ReviewerCommandOwner | undefined } = {
    current: undefined
  }
  const reviewerProjectRuntime = new ReviewerProjectRuntimeOwner()
  const messageAttributionAuthority = new MainMessageAttributionAuthority()
  const notebookActivityRef: {
    current: { getActiveNotebookSessions(): { projectId: string; sessionId: string }[] } | undefined
  } = { current: undefined }

  // Construct one storage/index/deletion graph for every related IPC surface. Sharing these instances
  // is essential: separate coordinators would have independent queues and recovery gates.
  const configRoot = resolveConfigRoot()
  const permissionGrantRegistry = await createPermissionGrantRegistry({
    getClient: () => getProjectDbClient(configRoot),
    isScopeLive: (scope) =>
      isPermissionGrantScopeLive(scope, {
        projectExists: async (projectId) => (await projectRepository.get(projectId)) !== undefined,
        persistedSessionExists: async (projectId, sessionId) =>
          (await sessionRepository.loadSession(projectId, sessionId)) !== undefined,
        liveSessionExists: (projectId, sessionId) =>
          runtimeRef.current?.hasLiveSession(projectId, sessionId) ?? false
      })
  })
  await seedDefaultPermissionGrants(permissionGrantRegistry, await getProjectDbClient(configRoot))
  composition.phase('permission-grants')
  const projectFilesRepository = createManagedFileIndexRepository(
    getProjectDbClient,
    configRoot,
    resolveDataRoot(),
    managedFileVersionService,
    uploadRepository
  )
  const notebookInputRegistry = new NotebookInputRegistry({
    storageRoot: resolveDataRoot(),
    inputAuthority: immutableInputAuthority,
    resolveArtifactVersionIdentity: async (projectId, versionId) => {
      const [artifact] = await projectFilesRepository.readHostArtifactCatalog({
        projectId,
        versionId,
        finalizedArtifactsOnly: true
      })
      return artifact?.source === 'artifact' ? { sourceFileId: artifact.sourceFileId } : undefined
    }
  })
  const isComputeJobOwnerLive = async ({
    projectId,
    sessionId
  }: {
    projectId: string
    sessionId: string
  }): Promise<ComputeJobOwnerLiveness> => {
    if (!(await projectRepository.get(projectId))) return false
    const owner = await sessionRepository.loadSessionWithDiagnostics(projectId, sessionId)
    if (owner.status === 'unreadable') return 'unknown'
    return owner.status === 'found'
  }
  const computeJobDeletionRef: {
    current?: Required<ComputeJobDeletionParticipant> & {
      reconcileProjectOrphanJobs(
        projectId: string,
        isOwnerLive: typeof isComputeJobOwnerLive
      ): Promise<void>
    }
  } = {}
  const computeJobActivityRef: {
    current?: {
      findNonTerminal(): Promise<Array<{ project_id: string }>>
      countNonTerminalBySession(sessionId: string): Promise<number>
    }
  } = {}
  const sessionCacheOwnerRef: {
    current?: {
      removeSession(projectId: string, sessionId: string): Promise<void>
      removeProject(projectId: string): Promise<void>
      reconcileActiveSessions(
        sessions: ReadonlyArray<{ projectId: string; sessionId: string }>
      ): Promise<void>
    }
  } = {}
  const projectRuntimeQuiescenceRef: { current?: ProjectRuntimeQuiescenceOwner } = {}
  const artifactReproducibilityAttemptOwnerRef: {
    current?: ArtifactReproducibilityAttemptOwner
  } = {}
  const computeJobDeletionPort = {
    restoreProjectJobDeletion: (projectId: string): Promise<void> => {
      if (!computeJobDeletionRef.current) {
        throw new Error('Compute Job deletion is not initialized.')
      }
      return computeJobDeletionRef.current.restoreProjectJobDeletion(projectId)
    },
    prepareSessionJobDeletion: (projectId: string, sessionId: string): Promise<void> => {
      if (!computeJobDeletionRef.current) {
        throw new Error('Compute Job deletion is not initialized.')
      }
      return computeJobDeletionRef.current.prepareSessionJobDeletion(projectId, sessionId)
    },
    commitSessionJobDeletion: (projectId: string, sessionId: string): Promise<void> => {
      if (!computeJobDeletionRef.current) {
        throw new Error('Compute Job deletion is not initialized.')
      }
      return computeJobDeletionRef.current.commitSessionJobDeletion(projectId, sessionId)
    },
    prepareProjectJobDeletion: (projectId: string): Promise<void> => {
      if (!computeJobDeletionRef.current) {
        throw new Error('Compute Job deletion is not initialized.')
      }
      return computeJobDeletionRef.current.prepareProjectJobDeletion(projectId)
    },
    commitProjectJobDeletion: (projectId: string): Promise<void> => {
      if (!computeJobDeletionRef.current) {
        throw new Error('Compute Job deletion is not initialized.')
      }
      return computeJobDeletionRef.current.commitProjectJobDeletion(projectId)
    },
    abortSessionJobDeletion: (projectId: string, sessionId: string): Promise<void> => {
      if (!computeJobDeletionRef.current) {
        throw new Error('Compute Job deletion is not initialized.')
      }
      return computeJobDeletionRef.current.abortSessionJobDeletion(projectId, sessionId)
    },
    abortProjectJobDeletion: (projectId: string): Promise<void> => {
      if (!computeJobDeletionRef.current) {
        throw new Error('Compute Job deletion is not initialized.')
      }
      return computeJobDeletionRef.current.abortProjectJobDeletion(projectId)
    }
  }
  // Delegated execution can outlive its root Turn and therefore is absent from the ACP runtime's
  // active-prompt list. Keep a synchronous projection of durable delegated mutations for the
  // close/quit and storage-migration safety gates. The selector deliberately ignores active routes:
  // inactive-branch work still owns processes/files and must block disruptive operations.
  const delegatedActivity = createDelegatedActivityProjection()
  const getActiveDelegatedSessions = (): { projectId: string; sessionId: string }[] =>
    delegatedActivity.getActiveDelegatedSessions()
  // Side Chat prompts remain activity for disruptive archive, migration and shutdown operations.
  // Package export uses a narrower projection because auxiliary transcripts are excluded; delivered
  // relays already live in the main conversation graph independently of this activity projection.
  const getActiveSideChatSessions = (): { projectId: string; sessionId: string }[] =>
    (sideChatOwnerRef.current?.list().chats ?? [])
      .filter((chat) => chat.running)
      .map((chat) => ({ projectId: chat.projectId, sessionId: chat.parentSessionId }))

  const managedWorkspaceRecoveryCutoff = Date.now()
  const sessionPersistenceCoordinator = new SessionPersistenceCoordinator(
    sessionRepository,
    projectFilesRepository,
    (event) => broadcastToRenderers('project-files:changed', event),
    provenanceMessageSnapshots,
    uploadRepository,
    artifactProvenanceRepository,
    {
      reconcileSessions: async (sessions) => {
        await reconcilePermissionGrantOwners(permissionGrantRegistry, { sessions })
        await sessionCacheOwnerRef.current?.reconcileActiveSessions(sessions)
      }
    },
    undefined,
    computeJobDeletionPort,
    (session, owner) => {
      if (owner === 'runtime-context') {
        broadcastToRenderers(LIFECYCLE_CHANNELS.sessionUpdated, {
          session,
          originClientId: MAIN_RUNTIME_CONTEXT_LIFECYCLE_CLIENT_ID
        })
        return
      }
      if (owner === 'runtime-transcript') {
        broadcastToRenderers(LIFECYCLE_CHANNELS.sessionUpdated, {
          session,
          originClientId: MAIN_RUNTIME_TRANSCRIPT_LIFECYCLE_CLIENT_ID
        })
        return
      }
      delegatedActivity.recordSession(session)
      broadcastToRenderers(LIFECYCLE_CHANNELS.sessionUpdated, {
        session,
        originClientId: MAIN_DELEGATED_WORK_LIFECYCLE_CLIENT_ID
      })
    },
    (session) => {
      // Re-enabling Delegation invalidates the last admission rejection, so the Subagent
      // availability notice disappears instead of waiting for the next successful delegation.
      if (session.delegationPolicy === 'allow') {
        getDelegatedWorkRef().current?.root.clearUnavailableReason?.(session.id)
      }
    },
    {
      reconcileProvisional: (sessions) =>
        reconcileProvisionalManagedWorkspaces(sessions, managedWorkspaceRecoveryCutoff),
      markProjectRetained: markManagedProjectWorkspacesRetained,
      restoreProjectActive: restoreManagedProjectWorkspacesActive,
      markRetained: markManagedWorkspaceRetained,
      restoreActive: restoreManagedWorkspaceActive
    },
    (session) => sessionPackageService.prepareSessionDeletion(session)
  )
  packagePublicationOwner.current = sessionPersistenceCoordinator
  return {
    artifactHandlersRef,
    reviewerCommandOwnerRef,
    reviewerProjectRuntime,
    messageAttributionAuthority,
    notebookActivityRef,
    configRoot,
    permissionGrantRegistry,
    projectFilesRepository,
    notebookInputRegistry,
    isComputeJobOwnerLive,
    computeJobDeletionRef,
    computeJobActivityRef,
    sessionCacheOwnerRef,
    projectRuntimeQuiescenceRef,
    artifactReproducibilityAttemptOwnerRef,
    computeJobDeletionPort,
    getActiveDelegatedSessions,
    getActiveSideChatSessions,
    sessionPersistenceCoordinator
  }
}
