import type { Prisma, PrismaClient } from '@prisma/client'

import type {
  ArtifactVersionEvidence,
  ArtifactVersionFile,
  FinalizeArtifactVersionsRequest
} from '../../shared/artifact-provenance'
import { resolveMessageBranchPath } from '../../shared/conversation-graph'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { materializeSessionConversationGraph } from '../../shared/session-persistence'
import { sha256 } from './provenance-canonical'
import {
  parseArtifactExecutionSnapshot,
  validateArtifactExecutionSnapshot
} from './provenance-execution-evidence'
import { connectorEvidenceIsValid } from './provenance-producer-capture'
import type { PersistedVersionFileRecord } from './provenance-version-writer'
import { requireAgentArtifactVersion } from './provenance-version-kind'

const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

type ArtifactFinalizationContext = Pick<
  FinalizeArtifactVersionsRequest,
  | 'rootFrameId'
  | 'agentFrameId'
  | 'messageBranchId'
  | 'runtimeSegmentId'
  | 'promptMessageId'
  | 'messageId'
>

type ArtifactFinalizationProofRequest = FinalizeArtifactVersionsRequest & {
  messageBranchAncestry: string[]
  messageAncestry: string[]
}

type ArtifactFinalizationProofVersion = PersistedVersionFileRecord & {
  state: string
  messageId: string | null
  rootFrameId: string
  agentFrameId: string
  messageBranchId: string
  runtimeSegmentId: string
  promptMessageId: string
  notebookSessionId: string | null
  producerRunIndex: number | null
  executionSnapshotChecksum: string | null
  executionSnapshotStorageKey: string | null
  executionSnapshotSchemaVersion: number | null
  evidenceJson: string
  artifact: { projectId: string; sessionId: string }
}

type ArtifactProvenanceMessageFinalizerOptions = {
  getClient: () => Promise<PrismaClient>
  now: () => Date
  loadSession?: (
    projectId: string,
    appSessionId: string
  ) => Promise<PersistedChatSession | undefined>
  projectVersionFile: (
    version: PersistedVersionFileRecord,
    projectId: string,
    appSessionId: string
  ) => Promise<ArtifactVersionFile>
}

export type ArtifactFinalizationProofReason =
  | 'claim-context-missing'
  | 'claim-version-ids-missing'
  | 'root-frame-mismatch'
  | 'branch-frame-mismatch'
  | 'runtime-segment-missing'
  | 'prompt-ownership-mismatch'
  | 'message-not-durable'
  | 'message-ownership-mismatch'
  | 'version-ids-missing'
  | 'version-ids-duplicate'
  | 'version-not-eligible'
  | 'version-omitted-from-claim'
  | 'version-message-conflict'
  | 'version-evidence-invalid'
  | 'execution-snapshot-missing'
  | 'execution-snapshot-corrupt'
  | 'execution-outside-ancestry'
  | 'execution-snapshot-invalid'

export class ArtifactFinalizationProofError extends Error {
  constructor(
    readonly reasonCode: ArtifactFinalizationProofReason,
    message: string,
    cause?: unknown
  ) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'ArtifactFinalizationProofError'
  }
}

export class ArtifactOwnershipPersistenceRaceError extends ArtifactFinalizationProofError {
  constructor(message = 'Artifact finalization ownership is not durable yet.') {
    super('message-not-durable', message)
    this.name = 'ArtifactOwnershipPersistenceRaceError'
  }
}

const assertSafeSegment = (value: string, label: string): string => {
  if (!SAFE_SEGMENT_PATTERN.test(value)) {
    throw new Error(`Invalid ${label}: ${value}`)
  }
  return value
}

const normalizeArtifactFinalizationProofRequest = (
  request: ArtifactFinalizationProofRequest
): ArtifactFinalizationProofRequest => {
  if (!Array.isArray(request.artifactVersionIds) || request.artifactVersionIds.length === 0) {
    throw new ArtifactFinalizationProofError(
      'version-ids-missing',
      'Artifact Version ids are required for finalization.'
    )
  }
  const artifactVersionIds = request.artifactVersionIds.map((versionId) =>
    assertSafeSegment(versionId, 'artifact version id')
  )
  if (new Set(artifactVersionIds).size !== artifactVersionIds.length) {
    throw new ArtifactFinalizationProofError(
      'version-ids-duplicate',
      'Artifact Version ids must be unique.'
    )
  }

  return {
    ...request,
    artifactVersionIds,
    projectId: assertSafeSegment(request.projectId, 'project id'),
    appSessionId: assertSafeSegment(request.appSessionId, 'session id'),
    artifactRunId: assertSafeSegment(request.artifactRunId, 'artifact run id'),
    rootFrameId: assertSafeSegment(request.rootFrameId, 'root frame id'),
    agentFrameId: assertSafeSegment(request.agentFrameId, 'agent frame id'),
    messageBranchId: assertSafeSegment(request.messageBranchId, 'message branch id'),
    runtimeSegmentId: assertSafeSegment(request.runtimeSegmentId, 'runtime segment id'),
    promptMessageId: assertSafeSegment(request.promptMessageId, 'prompt message id'),
    messageId: assertSafeSegment(request.messageId, 'message id')
  }
}

const loadArtifactFinalizationProofVersions = async (
  client: Pick<PrismaClient, 'artifactVersion'>,
  request: ArtifactFinalizationProofRequest
): Promise<ArtifactFinalizationProofVersion[]> =>
  (
    await client.artifactVersion.findMany({
      where: {
        originKind: 'agent_generated',
        artifactRunId: request.artifactRunId,
        rootFrameId: request.rootFrameId,
        agentFrameId: request.agentFrameId,
        messageBranchId: request.messageBranchId,
        runtimeSegmentId: request.runtimeSegmentId,
        promptMessageId: request.promptMessageId,
        state: { in: ['pending', 'finalized'] },
        artifact: { is: { projectId: request.projectId, sessionId: request.appSessionId } }
      },
      include: { artifact: true },
      orderBy: [{ artifactId: 'asc' }, { versionNumber: 'asc' }]
    })
  ).map(requireAgentArtifactVersion)

const validateArtifactFinalizationProof = (
  matching: readonly ArtifactFinalizationProofVersion[],
  request: ArtifactFinalizationProofRequest
): void => {
  const matchingIds = new Set(matching.map((version) => version.id))
  const expectedIds = new Set(request.artifactVersionIds)
  const missingExpectedVersionId = request.artifactVersionIds.find(
    (versionId) => !matchingIds.has(versionId)
  )
  if (missingExpectedVersionId) {
    throw new ArtifactFinalizationProofError(
      'version-not-eligible',
      `Artifact Version is no longer eligible for finalization: ${missingExpectedVersionId}`
    )
  }
  const unexpectedMatchingVersion = matching.find((version) => !expectedIds.has(version.id))
  if (unexpectedMatchingVersion) {
    throw new ArtifactFinalizationProofError(
      'version-omitted-from-claim',
      `Artifact Version was omitted from the finalization claim: ${unexpectedMatchingVersion.id}`
    )
  }

  const conflicting = matching.find(
    (version) => version.messageId && version.messageId !== request.messageId
  )
  if (conflicting) {
    throw new ArtifactFinalizationProofError(
      'version-message-conflict',
      `Artifact Version ${conflicting.id} is already finalized to a different message.`
    )
  }

  const durableBranchIds = new Set(request.messageBranchAncestry)
  const durableMessageIds = new Set(request.messageAncestry)
  for (const version of matching) {
    try {
      const parsedEvidence = JSON.parse(version.evidenceJson) as Partial<ArtifactVersionEvidence>
      if (
        !parsedEvidence ||
        typeof parsedEvidence !== 'object' ||
        (parsedEvidence.producer?.state !== 'available' &&
          parsedEvidence.producer?.state !== 'unavailable')
      ) {
        throw new ArtifactFinalizationProofError(
          'version-evidence-invalid',
          `Artifact Version evidence is invalid: ${version.id}`
        )
      }
      const evidence = parsedEvidence as ArtifactVersionEvidence

      if (!version.executionSnapshotJson) {
        const hasProducerOrExecutionFields =
          version.notebookSessionId !== null ||
          version.producerRunId !== null ||
          version.producerRunIndex !== null ||
          version.executionSnapshotChecksum !== null ||
          version.executionSnapshotStorageKey !== null ||
          version.executionSnapshotSchemaVersion !== null
        const isProvenUnavailableWithoutExecution =
          evidence.producer.state === 'unavailable' &&
          evidence.execution_status?.state === 'unavailable' &&
          Array.isArray(evidence.inputs) &&
          evidence.inputs.length === 0 &&
          evidence.execution_snapshot_checksum === undefined &&
          evidence.reproduction_code === undefined
        const isProvenConnectorWithoutNotebookExecution =
          evidence.execution_status?.state === 'partial' &&
          Array.isArray(evidence.inputs) &&
          evidence.execution_snapshot_checksum === undefined &&
          evidence.reproduction_code === undefined &&
          connectorEvidenceIsValid(evidence)
        if (
          hasProducerOrExecutionFields ||
          (!isProvenUnavailableWithoutExecution && !isProvenConnectorWithoutNotebookExecution)
        ) {
          throw new ArtifactFinalizationProofError(
            'execution-snapshot-missing',
            `Artifact Version execution snapshot is missing: ${version.id}`
          )
        }
        continue
      }

      if (
        !version.executionSnapshotChecksum ||
        sha256(version.executionSnapshotJson) !== version.executionSnapshotChecksum
      ) {
        throw new ArtifactFinalizationProofError(
          'execution-snapshot-corrupt',
          `Artifact Version execution snapshot is corrupt: ${version.id}`
        )
      }
      const snapshot = parseArtifactExecutionSnapshot(version.executionSnapshotJson)
      validateArtifactExecutionSnapshot(snapshot, {
        rootFrameId: version.rootFrameId,
        agentFrameId: version.agentFrameId,
        messageBranchId: version.messageBranchId,
        promptMessageId: version.promptMessageId,
        producerRunId: version.producerRunId,
        producerRunIndex: version.producerRunIndex,
        executionSnapshotChecksum: version.executionSnapshotChecksum,
        evidence
      })
      const outsideDurableAncestry = snapshot.runs.some(
        (run) =>
          !durableBranchIds.has(run.messageBranchId) ||
          (run.promptMessageId
            ? !durableMessageIds.has(run.promptMessageId)
            : run.messageBranchId !== request.messageBranchId)
      )
      if (outsideDurableAncestry) {
        throw new ArtifactFinalizationProofError(
          'execution-outside-ancestry',
          `Artifact Version execution snapshot is outside the durable Branch ancestry: ${version.id}`
        )
      }
    } catch (error) {
      if (error instanceof ArtifactFinalizationProofError) throw error
      throw new ArtifactFinalizationProofError(
        'execution-snapshot-invalid',
        error instanceof Error
          ? error.message
          : `Artifact Version execution snapshot is invalid: ${version.id}`,
        error
      )
    }
  }
}

export const validateDurableMessageOwnership = (
  session: PersistedChatSession,
  context: ArtifactFinalizationContext
): { messageBranchAncestry: string[]; messageAncestry: string[] } => {
  const graph = materializeSessionConversationGraph(session).conversationGraph!
  if (graph.rootFrameId !== context.rootFrameId) {
    throw new ArtifactFinalizationProofError(
      'root-frame-mismatch',
      'Artifact finalization root Frame does not match the durable Session graph.'
    )
  }
  const frame = graph.frames.find((candidate) => candidate.id === context.agentFrameId)
  const branch = graph.branches.find((candidate) => candidate.id === context.messageBranchId)
  if (!frame || !branch || branch.agentFrameId !== frame.id) {
    throw new ArtifactFinalizationProofError(
      'branch-frame-mismatch',
      'Artifact finalization Branch does not belong to the declared Agent Frame.'
    )
  }
  const segment = graph.runtimeSegments.find(
    (candidate) =>
      candidate.id === context.runtimeSegmentId && candidate.agentFrameId === context.agentFrameId
  )
  if (!segment) {
    throw new ArtifactFinalizationProofError(
      'runtime-segment-missing',
      'Artifact finalization Runtime Segment is not durable.'
    )
  }
  const path = resolveMessageBranchPath(graph, context.messageBranchId)
  const promptIndex = path.findIndex((message) => message.id === context.promptMessageId)
  const finalIndex = path.findIndex((message) => message.id === context.messageId)
  const promptMessage = path[promptIndex]
  const finalMessage = path[finalIndex]
  // Message status is lifecycle state, not ownership proof. The runtime creates an Artifact claim only
  // after the provider turn terminates, while the renderer may not have applied its following stop event
  // yet; an internal disk load can also normalize that still-streaming node to error. Frame, Branch,
  // Runtime Segment, role, and ordered path identity remain the fail-closed ownership boundary.
  if (
    promptIndex < 0 ||
    !promptMessage ||
    promptMessage.role !== 'user' ||
    promptMessage.status !== 'complete' ||
    promptMessage.agentFrameId !== context.agentFrameId ||
    promptMessage.introducedOnBranchId !== context.messageBranchId ||
    promptMessage.runtimeSegmentId !== context.runtimeSegmentId
  ) {
    throw new ArtifactFinalizationProofError(
      'prompt-ownership-mismatch',
      'Artifact finalization prompt does not match the declared durable ownership.'
    )
  }
  if (finalIndex < 0 || !finalMessage) {
    throw new ArtifactOwnershipPersistenceRaceError(
      'Artifact finalization message is not durable yet.'
    )
  }
  if (
    finalIndex <= promptIndex ||
    finalMessage.role !== 'agent' ||
    finalMessage.agentFrameId !== context.agentFrameId ||
    finalMessage.introducedOnBranchId !== context.messageBranchId ||
    finalMessage.runtimeSegmentId !== context.runtimeSegmentId
  ) {
    throw new ArtifactFinalizationProofError(
      'message-ownership-mismatch',
      'Artifact finalization message does not match the declared durable ownership.'
    )
  }
  const branches = new Map(graph.branches.map((candidate) => [candidate.id, candidate]))
  const branchAncestry: string[] = []
  let current: typeof branch | undefined = branch
  while (current) {
    branchAncestry.unshift(current.id)
    current = current.parentBranchId ? branches.get(current.parentBranchId) : undefined
  }
  return {
    messageBranchAncestry: branchAncestry,
    messageAncestry: path.slice(0, finalIndex + 1).map((message) => message.id)
  }
}

export class ArtifactProvenanceMessageFinalizer {
  constructor(private readonly options: ArtifactProvenanceMessageFinalizerOptions) {}

  private async loadFinalizationSession(
    request: FinalizeArtifactVersionsRequest
  ): Promise<PersistedChatSession> {
    if (!this.options.loadSession) {
      throw new Error('Artifact finalization requires the durable Session graph authority.')
    }
    const durableSession = await this.options.loadSession(request.projectId, request.appSessionId)
    if (
      !durableSession ||
      durableSession.projectId !== request.projectId ||
      durableSession.id !== request.appSessionId
    ) {
      throw new Error('Artifact finalization durable Session graph is unavailable.')
    }
    return durableSession
  }

  async validateOwnership(request: FinalizeArtifactVersionsRequest): Promise<void> {
    const durableSession = await this.loadFinalizationSession(request)
    validateDurableMessageOwnership(durableSession, request)
  }

  async finalizeRun(request: FinalizeArtifactVersionsRequest): Promise<ArtifactVersionFile[]> {
    const durableSession = await this.loadFinalizationSession(request)
    return this.finalizeRunWithDurableSession(request, durableSession)
  }

  async finalizeRunWithDurableSession(
    request: FinalizeArtifactVersionsRequest,
    durableSession: PersistedChatSession
  ): Promise<ArtifactVersionFile[]> {
    const ancestry = validateDurableMessageOwnership(durableSession, request)
    return this.finalizeVerifiedRun({ ...request, ...ancestry })
  }

  async activateFinalizedRun(
    request: FinalizeArtifactVersionsRequest
  ): Promise<ArtifactVersionFile[]> {
    const durableSession = await this.loadFinalizationSession(request)
    return this.activateFinalizedRunWithDurableSession(request, durableSession)
  }

  async activateFinalizedRunWithDurableSession(
    request: FinalizeArtifactVersionsRequest,
    durableSession: PersistedChatSession
  ): Promise<ArtifactVersionFile[]> {
    const ancestry = validateDurableMessageOwnership(durableSession, request)
    const normalizedRequest = normalizeArtifactFinalizationProofRequest({ ...request, ...ancestry })
    const client = await this.options.getClient()
    const versions = await client.$transaction(async (transaction) => {
      const matching = await loadArtifactFinalizationProofVersions(transaction, normalizedRequest)
      validateArtifactFinalizationProof(matching, normalizedRequest)
      if (matching.some((version) => version.state !== 'finalized')) {
        throw new ArtifactFinalizationProofError(
          'version-not-eligible',
          'Artifact Versions must be finalized before their visible head can advance.'
        )
      }
      const publishedAt = this.options.now()
      await transaction.artifactVersion.updateMany({
        where: { id: { in: matching.map((version) => version.id) }, managedVisibleAt: null },
        data: { managedVisibleAt: publishedAt }
      })
      await this.activateLineageHeads(transaction, matching)
      return matching.map((version) => ({
        ...version,
        managedVisibleAt: version.managedVisibleAt ?? publishedAt
      }))
    })
    return Promise.all(
      versions.map((version) =>
        this.options.projectVersionFile(
          version,
          version.artifact.projectId,
          version.artifact.sessionId
        )
      )
    )
  }

  private async finalizeVerifiedRun(
    request: ArtifactFinalizationProofRequest
  ): Promise<ArtifactVersionFile[]> {
    const normalizedRequest = normalizeArtifactFinalizationProofRequest(request)
    const client = await this.options.getClient()
    const versions = await client.$transaction(async (transaction) => {
      const matching = await loadArtifactFinalizationProofVersions(transaction, normalizedRequest)
      // Validate the complete proof from the same transaction that commits message ownership. Recovery
      // does not touch compatibility storage until this transaction succeeds.
      validateArtifactFinalizationProof(matching, normalizedRequest)

      await transaction.artifactVersion.updateMany({
        where: {
          id: { in: matching.map((version) => version.id) },
          state: 'pending'
        },
        data: { state: 'finalized', messageId: normalizedRequest.messageId }
      })

      return (
        await transaction.artifactVersion.findMany({
          where: {
            id: { in: matching.map((version) => version.id) },
            originKind: 'agent_generated',
            state: 'finalized'
          },
          include: { artifact: true },
          orderBy: [{ artifactId: 'asc' }, { versionNumber: 'asc' }]
        })
      ).map(requireAgentArtifactVersion)
    })

    return Promise.all(
      versions.map((version) =>
        this.options.projectVersionFile(
          version,
          version.artifact.projectId,
          version.artifact.sessionId
        )
      )
    )
  }

  private async activateLineageHeads(
    transaction: Prisma.TransactionClient,
    matching: readonly ArtifactFinalizationProofVersion[]
  ): Promise<void> {
    for (const artifactId of new Set(matching.map((version) => version.artifactId))) {
      const lineage = await transaction.artifactLineage.findUniqueOrThrow({
        where: { id: artifactId },
        include: { currentVersion: true }
      })
      const latestMatching = matching
        .filter((version) => version.artifactId === artifactId)
        .reduce<ArtifactFinalizationProofVersion | undefined>(
          (latest, version) =>
            !latest || version.versionNumber > latest.versionNumber ? version : latest,
          undefined
        )
      if (!latestMatching) continue
      if (
        !lineage.currentVersion ||
        lineage.currentVersion.versionNumber < latestMatching.versionNumber
      ) {
        await transaction.artifactLineage.update({
          where: { id: artifactId },
          data: { currentVersionId: latestMatching.id }
        })
      }
    }
  }
}
