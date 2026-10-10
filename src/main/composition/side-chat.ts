import { runtimeMetadata } from '../runtime-metadata'
import { createAcpRuntime } from '../acp/runtime-composition'
import { SideChatRelayOwner } from '../acp/side-chat-relay-owner'
import { type ApplicationModuleBuilder } from '../application-runtime'
import type { ComputeJobOwnerLiveness } from '../compute/job-deletion-owner'
import { createProductionDelegatedWorkComposition } from '../delegation/production-composition'
import { type DiagnosticOperation } from '../diagnostics/operation'
import { createLogger, diagnosticErrorFields } from '../logger'
import type { NotebookRuntimeService } from '../notebook/runtime-service'
import { ProjectRuntimeQuiescenceOwner } from '../projects/project-runtime-quiescence-owner'
import { broadcastToRenderers } from '../renderer-broadcast'
import { ReviewerProjectRuntimeOwner } from '../reviewer/project-runtime-owner'
import { type SessionAuxiliaryTurnUsageRecord } from '../session-persistence/auxiliary-turn-usage'
import { type ComputeJobDeletionParticipant } from '../session-persistence/coordinator'
import { SettingsService } from '../settings/service'
import { createMainPromptSideChatRelay } from '../side-chat/main-prompt-relay'
import { SideChatRuntimeOwner } from '../side-chat/runtime-owner'
import { resolveConfigRoot } from '../storage-root'

export async function composeSideChat({
  settingsService,
  sideChatOwnerRef,
  recordAuxiliaryUsage,
  reviewerProjectRuntime,
  configRoot,
  isComputeJobOwnerLive,
  computeJobDeletionRef,
  projectRuntimeQuiescenceRef,
  sideChatRelay,
  mainPromptSideChatRelay,
  notebookService,
  delegatedWork,
  runtime,
  modules,
  composition
}: {
  settingsService: SettingsService
  sideChatOwnerRef: { current: SideChatRuntimeOwner | undefined }
  recordAuxiliaryUsage: (record: SessionAuxiliaryTurnUsageRecord) => Promise<void>
  reviewerProjectRuntime: ReviewerProjectRuntimeOwner
  configRoot: ReturnType<typeof resolveConfigRoot>
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
  projectRuntimeQuiescenceRef: { current?: ProjectRuntimeQuiescenceOwner }
  sideChatRelay: SideChatRelayOwner
  mainPromptSideChatRelay: ReturnType<typeof createMainPromptSideChatRelay>
  notebookService: NotebookRuntimeService
  delegatedWork: ReturnType<typeof createProductionDelegatedWorkComposition>
  runtime: ReturnType<typeof createAcpRuntime>
  modules: ApplicationModuleBuilder
  composition: DiagnosticOperation
}): Promise<{ sideChatRuntime: SideChatRuntimeOwner }> {
  const sideChatLog = createLogger('side-chat')
  const sideChatRuntime = await modules.add(
    {
      appVersion: runtimeMetadata().version,
      configRoot,
      captureTarget: async (selection) => {
        if (!selection) return settingsService.captureActiveExplicitAgentBackendTarget()
        const { frameworkId } = await settingsService.captureActiveAgentBackendSelection()
        return {
          frameworkId,
          providerId: selection.providerId,
          model: selection.model
            ? { kind: 'required', id: selection.model }
            : { kind: 'provider-default' },
          reasoningEffort: selection.reasoningEffort ?? 'default'
        }
      },
      resolveTarget: (target, context) =>
        settingsService.resolveExplicitAgentBackend(target, context),
      relay: sideChatRelay,
      deliverRelay: (parentSessionId, queued) =>
        mainPromptSideChatRelay.tryInject(parentSessionId, queued),
      recordUsage: recordAuxiliaryUsage,
      onEvent: (event) => broadcastToRenderers('side-chat:event', event)
    } satisfies ConstructorParameters<typeof SideChatRuntimeOwner>[0],
    (options) => {
      const owner = new SideChatRuntimeOwner(options)
      return {
        name: 'side-chat-runtime',
        capability: owner,
        dispose: () => owner.shutdown()
      }
    }
  )
  sideChatOwnerRef.current = sideChatRuntime
  projectRuntimeQuiescenceRef.current = new ProjectRuntimeQuiescenceOwner({
    acp: {
      listSessionIds: () => runtime.getOwnedSessionIds(),
      liveSessionProjectId: (sessionId) => runtime.liveSessionProjectId(sessionId),
      deleteSession: (sessionId) => runtime.deleteSession({ sessionId })
    },
    delegation: {
      deleteProject: (projectId) => delegatedWork.root.deleteProject(projectId)
    },
    notebook: {
      shutdownProject: (projectId) => notebookService.shutdownProject(projectId)
    },
    reviewer: reviewerProjectRuntime,
    sideChat: sideChatRuntime,
    compute: {
      reconcileProject: async (projectId) => {
        const deletionOwner = computeJobDeletionRef.current
        if (!deletionOwner) throw new Error('Compute Job deletion is not initialized.')
        await deletionOwner.reconcileProjectOrphanJobs(projectId, isComputeJobOwnerLive)
      }
    }
  })
  // Side chats and undelivered advisories belong to this application run only. Never scan
  // Session JSON to recover them. Profile cleanup is independent of startup readiness.
  void sideChatRuntime.sweepStaleProfiles().catch((error) => {
    sideChatLog.warn('temporary Side chat profile cleanup failed', diagnosticErrorFields(error))
  })
  composition.phase('side-chat')
  return { sideChatRuntime }
}
