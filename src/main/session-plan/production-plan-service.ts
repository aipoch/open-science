import type { ArtifactTurnOwner } from '../acp/artifact-turn-owner'
import type { ManagedFileVersionService } from '../managed-file-versions/service'
import type {
  SessionMutation,
  SessionRuntimeContextCommands
} from '../session-persistence/coordinator'
import { SessionRuntimeContextRevisionConflictError } from '../session-persistence/coordinator'
import { PlanService, type PlanServiceDependencies } from './plan-service'
import { SessionPlanInteractionOwner } from './session-plan-interaction-owner'

type ProductionPlanServiceDependencies = Readonly<{
  interactions?: SessionPlanInteractionOwner
  artifactTurns: Pick<ArtifactTurnOwner, 'handleForExecution' | 'write'>
  managedFileVersions: Pick<ManagedFileVersionService, 'openUnpublishedVersion'>
  sessions: SessionRuntimeContextCommands & SessionMutation
  onApprovalRequested?: PlanServiceDependencies['onApprovalRequested']
  onApprovalSettled?: PlanServiceDependencies['onApprovalSettled']
}>

type PlanArtifactVersionRequest = {
  projectId: string
  sessionId: string
  artifactId: string
  artifactVersionId: string
}

// The Plan document is read back while its Artifact Version is still pending message finalization
// (write-then-verify after generate, and again during approval feedback), so this uses the
// producer read instead of the published-version read.
const readManagedArtifactVersion = async (
  managedFileVersions: Pick<ManagedFileVersionService, 'openUnpublishedVersion'>,
  request: PlanArtifactVersionRequest
): Promise<{ content: string; checksum: string }> => {
  const lease = await managedFileVersions.openUnpublishedVersion(
    { source: 'artifact', projectId: request.projectId, fileId: request.artifactId },
    request.artifactVersionId
  )
  try {
    if (lease.logicalFile.sessionId !== request.sessionId) {
      throw new Error('Artifact Version belongs to a different Session.')
    }
    const bytes = await lease.readRange(0, lease.size)
    await lease.verifyUnchanged()
    return {
      content: Buffer.from(bytes).toString('utf8'),
      checksum: lease.version.checksum
    }
  } finally {
    await lease.close()
  }
}

const createProductionPlanService = ({
  interactions = new SessionPlanInteractionOwner(),
  artifactTurns,
  managedFileVersions,
  sessions,
  onApprovalRequested,
  onApprovalSettled
}: ProductionPlanServiceDependencies): PlanService =>
  new PlanService({
    interactions,
    writeArtifactForExecution: (executionId, input) =>
      artifactTurns.write(artifactTurns.handleForExecution(executionId), input),
    readArtifactVersion: (request) => readManagedArtifactVersion(managedFileVersions, request),
    readRuntimeContext: (projectId, sessionId) =>
      sessions.readSessionRuntimeContext(projectId, sessionId),
    patchRuntimeContext: ({
      projectId,
      sessionId,
      expectedRevision,
      plan,
      sessionStatus,
      beforePersist
    }) =>
      sessions.patchSessionRuntimeContext({
        projectId,
        sessionId,
        expectedRevision,
        patch: { plan },
        sessionStatus,
        ...(beforePersist ? { beforePersist } : {})
      }),
    persistUserMessage: (input) =>
      sessions.appendUserMessageToInteraction({
        projectId: input.projectId,
        sessionId: input.sessionId,
        interactionId: input.interactionId,
        content: input.content,
        ...(input.beforePersist ? { beforePersist: input.beforePersist } : {}),
        ...(input.markPlanReview
          ? {
              runtimeContextPatch: {
                expectedRevision: input.markPlanReview.expectedRevision,
                patch: (message) => ({
                  plan: {
                    ...input.markPlanReview!.plan,
                    reviewFeedbackMessageId: message.id,
                    continuation: {
                      commandId: input.markPlanReview!.commandId,
                      kind: 'review-feedback' as const,
                      state: 'queued' as const,
                      originatingPromptMessageId: message.id,
                      createdAt: input.markPlanReview!.createdAt
                    }
                  }
                }),
                sessionStatus: 'waiting-plan-approval' as const
              }
            }
          : {})
      }),
    isRevisionConflict: (error) => error instanceof SessionRuntimeContextRevisionConflictError,
    onApprovalRequested,
    onApprovalSettled
  })

export { createProductionPlanService, readManagedArtifactVersion }
export type { ProductionPlanServiceDependencies }
