import { readFile } from 'node:fs/promises'

import type { ArtifactTurnOwner } from '../acp/artifact-turn-owner'
import type { ArtifactProvenanceRepository } from '../artifacts/provenance-repository'
import type { SessionPersistenceCoordinator } from '../session-persistence/coordinator'
import { SessionRuntimeContextRevisionConflictError } from '../session-persistence/coordinator'
import { PlanService, type PlanServiceDependencies } from './plan-service'
import { SessionPlanInteractionOwner } from './session-plan-interaction-owner'

type ProductionPlanServiceDependencies = Readonly<{
  interactions?: SessionPlanInteractionOwner
  artifactTurns: Pick<ArtifactTurnOwner, 'handleForExecution' | 'write'>
  provenance: Pick<ArtifactProvenanceRepository, 'resolveVersionContent'>
  sessions: Pick<
    SessionPersistenceCoordinator,
    'readSessionRuntimeContext' | 'patchSessionRuntimeContext' | 'appendUserMessageToInteraction'
  >
  onApprovalRequested?: PlanServiceDependencies['onApprovalRequested']
  onApprovalSettled?: PlanServiceDependencies['onApprovalSettled']
}>

const createProductionPlanService = ({
  interactions = new SessionPlanInteractionOwner(),
  artifactTurns,
  provenance,
  sessions,
  onApprovalRequested,
  onApprovalSettled
}: ProductionPlanServiceDependencies): PlanService =>
  new PlanService({
    interactions,
    writeArtifactForExecution: (executionId, input) =>
      artifactTurns.write(artifactTurns.handleForExecution(executionId), input),
    readArtifactVersion: async ({ projectId, sessionId, artifactId, artifactVersionId }) => {
      const resolved = await provenance.resolveVersionContent({
        projectId,
        appSessionId: sessionId,
        artifactId,
        versionId: artifactVersionId
      })
      if (!resolved.checksum) throw new Error('Artifact Version has no checksum.')
      return { content: await readFile(resolved.path, 'utf8'), checksum: resolved.checksum }
    },
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

export { createProductionPlanService }
export type { ProductionPlanServiceDependencies }
