import type { ArtifactTurnOwner, ArtifactTurnPublication } from '../acp/artifact-turn-owner'
import type {
  DelegatedArtifactEvidence,
  DelegatedArtifactProjectionScope,
  DelegatedArtifactScope
} from './durable-delegated-work'

type DelegatedArtifactEvidenceOptions = Readonly<{
  turns: Pick<
    ArtifactTurnOwner,
    | 'openExecution'
    | 'finalize'
    | 'dispose'
    | 'handleForExecution'
    | 'handoffFile'
    | 'publishHandoff'
  >
  artifactStorageSessionId(session: DelegatedArtifactScope['session']): string
  finalizePublication(
    publication: ArtifactTurnPublication,
    terminalMessageId: string,
    scope: DelegatedArtifactScope
  ): Promise<void>
  project(
    scope: DelegatedArtifactProjectionScope
  ): Promise<Awaited<ReturnType<DelegatedArtifactEvidence['project']>>>
}>

const createDelegatedArtifactEvidence = (
  options: DelegatedArtifactEvidenceOptions
): DelegatedArtifactEvidence => ({
  async open(scope) {
    const handle = await options.turns.openExecution({
      executionId: scope.executionId,
      appSessionId: scope.session.sessionId,
      artifactStorageSessionId: options.artifactStorageSessionId(scope.session),
      projectId: scope.session.projectId,
      agentName: scope.agentName,
      provenanceContext: {
        rootFrameId: scope.rootFrameId,
        agentFrameId: scope.agentFrameId,
        messageBranchId: scope.messageBranchId,
        runtimeSegmentId: scope.runtimeSegmentId,
        promptMessageId: scope.promptMessageId
      }
    })
    return Object.freeze({
      execution: Object.freeze({ currentRunFile: options.turns.handoffFile(handle) }),
      activateAt: (currentRunFile: string) => options.turns.publishHandoff(handle, currentRunFile),
      async finalize(terminalMessageId: string) {
        const publication = await options.turns.finalize(handle)
        if (publication) {
          await options.finalizePublication(publication, terminalMessageId, scope)
        }
      },
      dispose: () => options.turns.dispose(handle)
    })
  },
  async revoke(scope) {
    let handle
    try {
      handle = options.turns.handleForExecution(scope.executionId)
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('No active Artifact turn')) return
      throw error
    }
    await options.turns.dispose(handle)
  },
  project: options.project
})

export { createDelegatedArtifactEvidence }
export type { DelegatedArtifactEvidenceOptions }
