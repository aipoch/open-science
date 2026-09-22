import type { ArtifactTurnPublication } from '../acp/artifact-turn-owner'
import type { ArtifactHandlers } from '../artifacts/ipc'
import type { ArtifactFile } from '../../shared/artifacts'
import type { DelegatedArtifactScope } from './durable-delegated-work'
import type { DelegatedWorkRecordCommands } from './session-records'

type FinalizeDelegatedArtifactPublicationInput = Readonly<{
  publication: ArtifactTurnPublication
  terminalMessageId: string
  scope: DelegatedArtifactScope
  commands: DelegatedWorkRecordCommands
  handlers: Pick<ArtifactHandlers, 'finalizeRunArtifacts'>
}>

type DelegatedArtifactPublicationCommitState = Readonly<{
  projectId: string
  sessionId: string
  runId: string
  messageId: string
  artifactVersionIds: string[]
  artifactFinalization: 'committed'
  sessionAttachment: 'unconfirmed'
  artifacts: ArtifactFile[]
}>

class DelegatedArtifactPublicationError extends Error {
  constructor(
    readonly committed: DelegatedArtifactPublicationCommitState,
    cause: unknown
  ) {
    super(
      `Delegated Artifact finalization committed for Project ${committed.projectId}, Session ${committed.sessionId}, run ${committed.runId}, Message ${committed.messageId}, Versions [${committed.artifactVersionIds.join(', ')}], but Session attachment is unconfirmed.`,
      { cause }
    )
    this.name = 'DelegatedArtifactPublicationError'
  }
}

/**
 * Publishes one child Turn's immutable Artifact Versions through the same durable ownership and
 * finalization boundary used by the production IPC composition.
 */
const finalizeDelegatedArtifactPublication = async ({
  publication,
  terminalMessageId,
  scope,
  commands,
  handlers
}: FinalizeDelegatedArtifactPublicationInput): Promise<ArtifactFile[]> => {
  const owner = {
    frameId: scope.agentFrameId,
    attemptId: scope.attemptId,
    messageId: terminalMessageId
  }
  // Provenance validates the durable prompt/final-message path and Runtime Segment without requiring
  // visible Artifact ownership. Publish first so a rejected finalization cannot leak a placement.
  const finalized = await handlers.finalizeRunArtifacts({
    claimId: publication.artifactClaimId,
    messageId: terminalMessageId
  })
  // One durable mutation publishes only finalized immutable Versions and their final locators.
  try {
    await commands.attachDelegatedMessageArtifacts(scope.session, {
      ...owner,
      artifacts: finalized
    })
  } catch (cause) {
    throw new DelegatedArtifactPublicationError(
      {
        projectId: scope.session.projectId,
        sessionId: scope.session.sessionId,
        runId: publication.runId,
        messageId: terminalMessageId,
        artifactVersionIds: finalized.map(({ versionId, id }) => versionId ?? id),
        artifactFinalization: 'committed',
        sessionAttachment: 'unconfirmed',
        artifacts: finalized.map((artifact) => ({ ...artifact }))
      },
      cause
    )
  }
  return finalized
}

export { DelegatedArtifactPublicationError, finalizeDelegatedArtifactPublication }
export type { DelegatedArtifactPublicationCommitState, FinalizeDelegatedArtifactPublicationInput }
