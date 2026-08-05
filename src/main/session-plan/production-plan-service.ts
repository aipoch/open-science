import { readFile } from 'node:fs/promises'

import type { ArtifactTurnOwner } from '../acp/artifact-turn-owner'
import type { ArtifactProvenanceRepository } from '../artifacts/provenance-repository'
import type { SessionPersistenceCoordinator } from '../session-persistence/coordinator'
import { SessionRuntimeContextRevisionConflictError } from '../session-persistence/coordinator'
import { PlanService } from './plan-service'

type ProductionPlanServiceDependencies = Readonly<{
  artifactTurns: Pick<ArtifactTurnOwner, 'writeForActiveTurn'>
  provenance: Pick<ArtifactProvenanceRepository, 'resolveVersionContent'>
  sessions: Pick<
    SessionPersistenceCoordinator,
    'readSessionRuntimeContext' | 'patchSessionRuntimeContext' | 'appendUserMessageToInteraction'
  >
}>

const createProductionPlanService = ({
  artifactTurns,
  provenance,
  sessions
}: ProductionPlanServiceDependencies): PlanService =>
  new PlanService({
    writeArtifactForActiveTurn: (sessionId, input) =>
      artifactTurns.writeForActiveTurn(sessionId, input),
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
    patchRuntimeContext: ({ projectId, sessionId, expectedRevision, plan, sessionStatus }) =>
      sessions.patchSessionRuntimeContext({
        projectId,
        sessionId,
        expectedRevision,
        patch: { plan },
        sessionStatus
      }),
    persistUserMessage: (input) =>
      sessions.appendUserMessageToInteraction({
        projectId: input.projectId,
        sessionId: input.sessionId,
        interactionId: input.interactionId,
        content: input.content
      }),
    isRevisionConflict: (error) => error instanceof SessionRuntimeContextRevisionConflictError
  })

export { createProductionPlanService }
export type { ProductionPlanServiceDependencies }
