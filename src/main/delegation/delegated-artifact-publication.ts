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
  await commands.attachDelegatedMessageArtifacts(scope.session, {
    ...owner,
    artifacts: finalized
  })
  return finalized
}

export { finalizeDelegatedArtifactPublication }
export type { FinalizeDelegatedArtifactPublicationInput }
