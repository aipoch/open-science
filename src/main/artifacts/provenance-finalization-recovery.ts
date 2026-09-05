import type { PrismaClient } from '@prisma/client'

import type {
  ArtifactVersionFile,
  FinalizeArtifactVersionsRequest
} from '../../shared/artifact-provenance'
import { resolveMessageBranchPath } from '../../shared/conversation-graph'
import {
  materializeSessionConversationGraph,
  type PersistedChatSession
} from '../../shared/session-persistence'
import {
  ArtifactFinalizationProofError,
  ArtifactOwnershipPersistenceRaceError,
  ArtifactProvenanceMessageFinalizer,
  validateDurableMessageOwnership
} from './provenance-message-finalization'
import type { ArtifactRepository, PendingArtifactRunPublication } from './repository'
import { requireAgentArtifactVersion } from './provenance-version-kind'

type ArtifactProjectReconciliationState = {
  readonly projectId: string
  readonly unfinishedCompatibilityPublications: readonly PendingArtifactRunPublication[]
}

const artifactProjectReconciliationState = Symbol('artifactProjectReconciliationState')

// Opaque outside this module: callers may route a Project-scoped snapshot but cannot inspect or
// construct its publication state. This keeps compatibility layout knowledge inside Provenance.
type ArtifactProjectReconciliationSnapshot = {
  readonly [artifactProjectReconciliationState]: ArtifactProjectReconciliationState
}

type PreparedArtifactFinalizationContext = Pick<
  FinalizeArtifactVersionsRequest,
  'rootFrameId' | 'agentFrameId' | 'messageBranchId' | 'runtimeSegmentId' | 'promptMessageId'
>

type ArtifactFinalizationRecoveryResult = {
  recoveredVersionIds: string[]
  recoveredMessageArtifacts: Array<{ messageId: string; artifacts: ArtifactVersionFile[] }>
  nativeFinalizationRunIds: string[]
  unresolvedNativeFinalizationRunIds: string[]
  invalidProofNativeFinalizationRunIds?: string[]
}

type ArtifactProvenanceFinalizationRecoveryOptions = {
  getClient: () => Promise<PrismaClient>
  compatibilityRepository?: Pick<
    ArtifactRepository,
    'listPendingRunPublications' | 'findRunFinalizationMarker' | 'finalizeRunArtifacts'
  >
  messageFinalizer: Pick<
    ArtifactProvenanceMessageFinalizer,
    'finalizeRunWithDurableSession' | 'activateFinalizedRunWithDurableSession'
  >
}

// Resolves the agent message owning the prepared prompt turn's output. It deliberately considers
// only messages before the next user prompt on the declared Branch and Runtime Segment; choosing a
// latest message (or accepting multiple candidates) could attach a crashed run to a later turn.
const inferDurableFinalizationMessageId = (
  session: PersistedChatSession,
  context: PreparedArtifactFinalizationContext,
  versionIds: readonly string[]
): string | undefined => {
  const graph = materializeSessionConversationGraph(session).conversationGraph!
  if (graph.rootFrameId !== context.rootFrameId) return undefined
  const frame = graph.frames.find((candidate) => candidate.id === context.agentFrameId)
  const branch = graph.branches.find((candidate) => candidate.id === context.messageBranchId)
  const segment = graph.runtimeSegments.find(
    (candidate) =>
      candidate.id === context.runtimeSegmentId && candidate.agentFrameId === context.agentFrameId
  )
  if (!frame || !branch || branch.agentFrameId !== frame.id || !segment) return undefined

  const path = resolveMessageBranchPath(graph, context.messageBranchId)
  const promptIndex = path.findIndex((message) => message.id === context.promptMessageId)
  if (promptIndex < 0) return undefined
  const followingUserOffset = path
    .slice(promptIndex + 1)
    .findIndex((message) => message.role === 'user')
  const turnEnd = followingUserOffset < 0 ? path.length : promptIndex + 1 + followingUserOffset
  const candidates = path
    .slice(promptIndex + 1, turnEnd)
    .filter(
      (message) =>
        message.role === 'agent' &&
        message.agentFrameId === context.agentFrameId &&
        message.introducedOnBranchId === context.messageBranchId &&
        message.runtimeSegmentId === context.runtimeSegmentId
    )
  let message = candidates.length === 1 ? candidates[0] : undefined
  if (candidates.length > 1) {
    // A turn may contain commentary before its result. Use durable attachments to distinguish the
    // owner, but reject even a partial competing claim anywhere in the Session graph/projection.
    const claimedMessageIds = new Set(
      [...session.messages, ...(session.conversationGraph?.messages ?? [])]
        .filter((candidate) => candidate.artifactIds?.some((id) => versionIds.includes(id)))
        .map((candidate) => candidate.id)
    )
    if (claimedMessageIds.size !== 1) return undefined
    message = candidates.find((candidate) => claimedMessageIds.has(candidate.id))
    if (
      !message ||
      !versionIds.every((id) => isArtifactLinkedToDurableMessage(session, message!.id, id))
    ) {
      return undefined
    }
  }
  if (!message) return undefined

  validateDurableMessageOwnership(session, { ...context, messageId: message.id })
  return message.id
}

// Require Session metadata and every persisted owner projection to carry ArtifactFile.id.
const isArtifactLinkedToDurableMessage = (
  session: PersistedChatSession,
  messageId: string,
  versionId: string
): boolean => {
  const owners = [
    session.messages.find((message) => message.id === messageId),
    session.conversationGraph?.messages.find((message) => message.id === messageId)
  ].filter((message): message is NonNullable<typeof message> => !!message)

  return (
    owners.length > 0 &&
    owners.every((message) => message.artifactIds?.includes(versionId)) &&
    !!session.artifacts?.some((artifact) => artifact.id === versionId)
  )
}

class ArtifactProvenanceFinalizationRecovery {
  constructor(private readonly options: ArtifactProvenanceFinalizationRecoveryOptions) {}

  async prepareProjectReconciliation(
    projectId: string
  ): Promise<ArtifactProjectReconciliationSnapshot> {
    const unfinishedCompatibilityPublications = this.options.compatibilityRepository
      ? await this.options.compatibilityRepository.listPendingRunPublications(projectId)
      : []
    return {
      [artifactProjectReconciliationState]: {
        projectId,
        unfinishedCompatibilityPublications
      }
    }
  }

  validateProjectReconciliation(
    projectId: string,
    snapshot?: ArtifactProjectReconciliationSnapshot
  ): void {
    const prepared = snapshot?.[artifactProjectReconciliationState]
    if (snapshot && !prepared) {
      throw new Error('Artifact Project reconciliation snapshot is invalid.')
    }
    if (prepared && prepared.projectId !== projectId) {
      throw new Error('Artifact Project reconciliation snapshot belongs to another Project.')
    }
  }

  async reconcileSession(
    projectId: string,
    appSessionId: string,
    durableSession?: PersistedChatSession,
    snapshot?: ArtifactProjectReconciliationSnapshot,
    artifactRunIds?: readonly string[],
    artifactVersionIds?: readonly string[]
  ): Promise<ArtifactFinalizationRecoveryResult> {
    this.validateProjectReconciliation(projectId, snapshot)
    const result: ArtifactFinalizationRecoveryResult = {
      recoveredVersionIds: [],
      recoveredMessageArtifacts: [],
      nativeFinalizationRunIds: [],
      unresolvedNativeFinalizationRunIds: []
    }
    const compatibilityRepository = this.options.compatibilityRepository
    if (
      !durableSession ||
      durableSession.projectId !== projectId ||
      durableSession.id !== appSessionId ||
      !compatibilityRepository
    ) {
      return result
    }

    const client = await this.options.getClient()
    const allFinalizationVersions = (
      await client.artifactVersion.findMany({
        where: {
          originKind: 'agent_generated',
          state: { in: ['pending', 'finalized'] },
          artifact: { is: { projectId, sessionId: appSessionId } }
        }
      })
    ).map(requireAgentArtifactVersion)
    const requestedRunIds = artifactRunIds ? new Set(artifactRunIds) : undefined
    const requestedVersionIds = artifactVersionIds ? new Set(artifactVersionIds) : undefined
    const isScopedRetry = requestedRunIds !== undefined || requestedVersionIds !== undefined
    const candidateVersions = allFinalizationVersions.filter(
      (version) =>
        (!isScopedRetry ||
          requestedRunIds?.has(version.artifactRunId) ||
          requestedVersionIds?.has(version.id)) &&
        (isScopedRetry ||
          version.state === 'pending' ||
          (version.messageId !== null &&
            !isArtifactLinkedToDurableMessage(durableSession, version.messageId, version.id)))
    )
    result.nativeFinalizationRunIds = [
      ...new Set(candidateVersions.map((version) => version.artifactRunId))
    ]
    const unresolvedNativeFinalizationRunIds = new Set(result.nativeFinalizationRunIds)
    const invalidProofNativeFinalizationRunIds = new Set<string>()
    // Native Session linkage proves only that immutable Provenance content is attached. A single
    // project scan adds the much narrower set whose compatibility publication is physically
    // unfinished, without replaying every historical finalized run or rescanning Sessions per run.
    // Direct callers deliberately get a fresh scan. Startup supplies one opaque Project snapshot
    // to every Session, avoiding repeated scans without persisting stale repository state.
    const prepared = snapshot?.[artifactProjectReconciliationState]
    const unfinishedCompatibilityPublications = isScopedRetry
      ? []
      : (prepared?.unfinishedCompatibilityPublications ??
        (await compatibilityRepository.listPendingRunPublications(projectId)))
    const publicationByRunId = new Map(
      unfinishedCompatibilityPublications.map((publication) => [publication.runId, publication])
    )
    const runIds = [
      ...new Set([
        ...candidateVersions.map((version) => version.artifactRunId),
        ...unfinishedCompatibilityPublications.map((publication) => publication.runId)
      ])
    ]
    for (const artifactRunId of runIds) {
      const unfinishedPublication = publicationByRunId.get(artifactRunId)
      const marker = unfinishedPublication
        ? unfinishedPublication.marker
          ? {
              ...unfinishedPublication.marker,
              sourceSessionId: unfinishedPublication.sourceSessionId
            }
          : undefined
        : await compatibilityRepository.findRunFinalizationMarker(projectId, artifactRunId)
      const markerContext = marker?.provenanceContext
      if (!marker || marker.sessionId !== appSessionId || !markerContext) continue
      // Exact-set proof covers the whole pending/finalized run, including Versions already linked
      // to Session JSON. The candidate subset decides whether recovery is needed, not what the run
      // owns; otherwise a partially linked run would look like it contained unexpected Versions.
      const runVersions = allFinalizationVersions.filter(
        (version) => version.artifactRunId === artifactRunId
      )
      if (
        runVersions.length === 0 ||
        runVersions.some(
          (version) =>
            version.rootFrameId !== markerContext.rootFrameId ||
            version.agentFrameId !== markerContext.agentFrameId ||
            version.messageBranchId !== markerContext.messageBranchId ||
            version.runtimeSegmentId !== markerContext.runtimeSegmentId ||
            version.promptMessageId !== markerContext.promptMessageId
        )
      ) {
        continue
      }
      let proof: { messageId: string } | undefined
      try {
        const messageId =
          marker.messageId ??
          inferDurableFinalizationMessageId(
            durableSession,
            markerContext,
            runVersions.map((version) => version.id)
          )
        if (messageId) {
          validateDurableMessageOwnership(durableSession, {
            ...markerContext,
            messageId
          })
          proof = { messageId }
        }
      } catch (error) {
        if (
          error instanceof ArtifactFinalizationProofError &&
          !(error instanceof ArtifactOwnershipPersistenceRaceError)
        ) {
          invalidProofNativeFinalizationRunIds.add(artifactRunId)
        }
        // Leave the pending Version visible and retryable; an unproven marker is never guessed.
      }
      if (!proof) continue

      const pendingVersionIds = new Set(
        runVersions.filter((version) => version.state === 'pending').map((version) => version.id)
      )
      // Markers created before exact-set publication shipped have no frozen ids. Preserve that
      // on-disk compatibility by deriving the whole run once; every new marker carries ids and is
      // consumed verbatim, so recovery can never widen or narrow a modern runtime claim.
      const markerVersionIds = marker.artifactVersionIds ?? runVersions.map((version) => version.id)
      const finalizationRequest: FinalizeArtifactVersionsRequest = {
        projectId,
        appSessionId,
        artifactRunId,
        ...markerContext,
        messageId: proof.messageId,
        artifactVersionIds: markerVersionIds
      }
      let finalized: ArtifactVersionFile[]
      try {
        // Commit complete ownership and execution proof before the irreversible compatibility move.
        // A crash or I/O failure after this point leaves a finalized-but-unlinked Version, which the
        // candidate selector above deliberately retries on the next startup.
        finalized = await this.options.messageFinalizer.finalizeRunWithDurableSession(
          finalizationRequest,
          durableSession
        )
      } catch (error) {
        if (error instanceof ArtifactFinalizationProofError) {
          if (!(error instanceof ArtifactOwnershipPersistenceRaceError)) {
            invalidProofNativeFinalizationRunIds.add(artifactRunId)
          }
          continue
        }
        throw error
      }
      // Replay unconditionally after the durable Version commit: a bound marker may have survived a
      // crash before pending bytes moved. Operational compatibility failures escape and keep startup
      // incomplete without exposing the not-yet-attached Version in Session JSON.
      await compatibilityRepository.finalizeRunArtifacts({
        projectId: projectId,
        sourceSessionId: marker.sourceSessionId,
        sessionId: appSessionId,
        runId: artifactRunId,
        messageId: proof.messageId,
        artifactVersionIds: markerVersionIds,
        provenanceContext: markerContext
      })
      finalized = await this.options.messageFinalizer.activateFinalizedRunWithDurableSession(
        finalizationRequest,
        durableSession
      )
      result.recoveredVersionIds.push(
        ...finalized
          .filter((version) => pendingVersionIds.has(version.versionId!))
          .map((version) => version.versionId!)
      )
      if (finalized.length > 0) {
        result.recoveredMessageArtifacts.push({
          messageId: proof.messageId,
          artifacts: finalized
        })
      }
      unresolvedNativeFinalizationRunIds.delete(artifactRunId)
    }
    result.unresolvedNativeFinalizationRunIds = [...unresolvedNativeFinalizationRunIds]
    if (invalidProofNativeFinalizationRunIds.size > 0) {
      result.invalidProofNativeFinalizationRunIds = [...invalidProofNativeFinalizationRunIds]
    }
    return result
  }
}

export {
  ArtifactProvenanceFinalizationRecovery,
  type ArtifactFinalizationRecoveryResult,
  type ArtifactProjectReconciliationSnapshot
}
