import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import type { PrismaClient } from '@prisma/client'

import {
  materializeSessionConversationGraph,
  sanitizeActivityGroup,
  sanitizeToolActivity,
  type PersistedChatSession
} from '../../shared/session-persistence'
import {
  resolveMessageBranchPath,
  type PersistedMessageNode
} from '../../shared/conversation-graph'
import type {
  ArtifactMessageSnapshotFile,
  ProvenanceMessage,
  ProvenanceMessagePart
} from '../../shared/artifact-provenance'

type ProvenanceMessageSnapshotOptions = {
  storageRoot: string
  getClient: () => Promise<PrismaClient>
  createId?: () => string
  now?: () => Date
}

type SessionDeletionReceipt =
  | { kind: 'ordinary'; projectId: string; sessionId: string }
  | { kind: 'retained'; projectId: string; sessionId: string; operationId: string }

const storageKey = (...segments: string[]): string => segments.join('/')
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')
const resolveStorageKey = (root: string, key: string): string => {
  if (!key || isAbsolute(key) || key.includes('\\')) {
    throw new Error('Invalid Provenance Message storage key.')
  }
  const segments = key.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('Invalid Provenance Message storage key.')
  }
  const candidate = resolve(root, ...segments)
  const fromRoot = relative(resolve(root), candidate)
  if (!fromRoot || fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) {
    throw new Error('Invalid Provenance Message storage key.')
  }
  return candidate
}

const projectParts = (node: PersistedMessageNode): ProvenanceMessagePart[] | undefined => {
  const parts = node.parts?.flatMap((part): ProvenanceMessagePart[] => {
    if (part.type === 'text') return [{ type: 'text', text: part.text }]
    if (part.type === 'skill') return [{ type: 'skill', name: part.name }]
    return [
      {
        type: 'artifact',
        name: part.name,
        ...('versionId' in part && part.versionId ? { versionId: part.versionId } : {})
      }
    ]
  })
  return parts && parts.length > 0 ? parts : undefined
}

const projectMessage = (
  session: PersistedChatSession,
  node: PersistedMessageNode
): ProvenanceMessage => {
  const segment = session.conversationGraph?.runtimeSegments.find(
    (candidate) => candidate.id === node.runtimeSegmentId
  )
  const artifacts = (node.artifactIds ?? []).flatMap((versionId) => {
    const artifact = session.artifacts?.find(
      (candidate) => candidate.versionId === versionId || candidate.id === versionId
    )
    return artifact
      ? [{ versionId, name: artifact.name ?? artifact.path.split(/[\\/]/u).at(-1) ?? versionId }]
      : []
  })
  const parts = projectParts(node)
  return {
    id: node.id,
    role: node.role,
    content: node.content,
    createdAt: node.createdAt,
    ...(node.parentMessageId ? { parentMessageId: node.parentMessageId } : {}),
    ...(node.supersedesMessageId ? { supersedesMessageId: node.supersedesMessageId } : {}),
    ...(parts ? { parts } : {}),
    ...(artifacts.length > 0 ? { artifacts } : {}),
    ...((node.images?.length ?? 0) > 0 || (node.uploads?.length ?? 0) > 0
      ? { hasOmittedMedia: true }
      : {}),
    ...(segment
      ? {
          agentAttribution: {
            frameworkId: segment.frameworkId,
            ...(segment.agentName ? { agentName: segment.agentName } : {}),
            ...(segment.model ? { model: segment.model } : {})
          }
        }
      : {})
  }
}

class ProvenanceMessageSnapshotRepository {
  private readonly createId: () => string
  private readonly now: () => Date

  constructor(private readonly options: ProvenanceMessageSnapshotOptions) {
    this.createId = options.createId ?? randomUUID
    this.now = options.now ?? (() => new Date())
  }

  async captureFinalizedMessages(input: PersistedChatSession): Promise<void> {
    const session = materializeSessionConversationGraph(input)
    const graph = session.conversationGraph
    if (!graph) throw new Error('Session conversation graph is unavailable.')
    const client = await this.options.getClient()
    const versions = await client.artifactVersion.findMany({
      where: {
        state: 'finalized',
        messageId: { not: null },
        messageSnapshotId: null,
        artifact: { is: { projectId: session.projectId, sessionId: session.id } }
      }
    })
    const scopes = new Map<string, (typeof versions)[number]>()
    for (const version of versions) {
      if (!version.messageId) continue
      scopes.set(
        [
          version.rootFrameId,
          version.agentFrameId,
          version.messageBranchId,
          version.messageId
        ].join('\0'),
        version
      )
    }

    for (const version of scopes.values()) {
      if (!version.messageId) continue
      await this.captureScope(session, version)
    }
  }

  async prepareSessionDeletion(input: PersistedChatSession): Promise<SessionDeletionReceipt> {
    const session = materializeSessionConversationGraph(input)
    const client = await this.options.getClient()
    const [lineageCount, uploadCount, incomingInputCount] = await Promise.all([
      client.artifactLineage.count({
        where: { projectId: session.projectId, sessionId: session.id }
      }),
      client.uploadFile.count({ where: { projectId: session.projectId, sessionId: session.id } }),
      client.artifactVersionInput.count({
        where: { sourceProjectId: session.projectId, sourceSessionId: session.id }
      })
    ])
    if (lineageCount + uploadCount + incomingInputCount === 0) {
      return { kind: 'ordinary', projectId: session.projectId, sessionId: session.id }
    }

    // The live graph is the final opportunity to freeze branch-scoped Messages. Deletion fails
    // closed if any finalized output cannot be linked to immutable Message evidence.
    await this.captureFinalizedMessages(session)
    const finalizedVersions = await client.artifactVersion.findMany({
      where: {
        state: 'finalized',
        artifact: { is: { projectId: session.projectId, sessionId: session.id } }
      },
      include: { messageSnapshot: true }
    })
    if (finalizedVersions.some((version) => !version.messageSnapshot)) {
      throw new Error(
        'Session deletion requires Message snapshots for every finalized Artifact Version.'
      )
    }
    for (const version of finalizedVersions) {
      if (!version.messageSnapshot) continue
      await this.verifyReadySnapshot(version.messageSnapshot, {
        rootFrameId: version.rootFrameId,
        agentFrameId: version.agentFrameId,
        messageBranchId: version.messageBranchId,
        terminalMessageId: version.messageId ?? ''
      })
    }

    const [survivingVersions, sessionReviews] = await Promise.all([
      client.artifactVersion.findMany({
        where: {
          state: { in: ['pending', 'finalized'] },
          artifact: { is: { projectId: session.projectId, sessionId: session.id } }
        },
        select: { id: true, messageId: true }
      }),
      client.review.findMany({
        where: { projectId: session.projectId, sessionId: session.id },
        orderBy: { createdAt: 'asc' }
      })
    ])
    const versionIds = new Set(survivingVersions.map((version) => version.id))
    const versionMessageIds = new Set(
      survivingVersions.flatMap((version) => (version.messageId ? [version.messageId] : []))
    )
    const seedTurnIds = new Set(
      sessionReviews.flatMap((review) => {
        let scopeVersionIds: unknown = []
        try {
          scopeVersionIds = (JSON.parse(review.scope) as { artifactVersionIds?: unknown })
            .artifactVersionIds
        } catch {
          // A corrupt scope cannot prove a direct binding; the independently scoped message fallback
          // below remains available for legacy rows.
        }
        const directlyBound =
          Array.isArray(scopeVersionIds) && scopeVersionIds.some((id) => versionIds.has(String(id)))
        return directlyBound || versionMessageIds.has(review.turnMessageId)
          ? [review.turnMessageId]
          : []
      })
    )
    const retainedReviewIds = new Set(
      sessionReviews
        .filter((review) => seedTurnIds.has(review.turnMessageId))
        .map((review) => review.id)
    )
    const findingRows = await client.finding.findMany({
      where: { reviewId: { in: sessionReviews.map((review) => review.id) } },
      select: { id: true, reviewId: true }
    })
    const findingReview = new Map(findingRows.map((finding) => [finding.id, finding.reviewId]))
    const dispositions = await client.reviewFindingDisposition.findMany({
      where: { sourceFindingId: { in: findingRows.map((finding) => finding.id) } }
    })
    let closureChanged = true
    while (closureChanged) {
      closureChanged = false
      for (const disposition of dispositions) {
        const sourceReviewId = findingReview.get(disposition.sourceFindingId)
        const causeReviewId = disposition.causeReviewId ?? undefined
        if (
          (sourceReviewId && retainedReviewIds.has(sourceReviewId)) ||
          (causeReviewId && retainedReviewIds.has(causeReviewId))
        ) {
          for (const reviewId of [sourceReviewId, causeReviewId]) {
            if (reviewId && !retainedReviewIds.has(reviewId)) {
              retainedReviewIds.add(reviewId)
              closureChanged = true
            }
          }
        }
      }
    }
    const retainedReviews = sessionReviews.filter((review) => retainedReviewIds.has(review.id))
    const scopeSnapshots = await client.reviewScopeSnapshot.findMany({
      where: { reviewId: { in: retainedReviews.map((review) => review.id) } }
    })
    for (const snapshot of scopeSnapshots) {
      if (snapshot.state !== 'ready' || sha256(snapshot.snapshotJson) !== snapshot.checksum) {
        throw new Error(`Review scope snapshot is not ready or valid: ${snapshot.reviewId}`)
      }
    }
    // Missing snapshot rows are legacy Reviews. They remain readable at their current summary level;
    // new Reviews always create a row before their reviewer process starts.

    const operationId = this.createId()
    const updated = await client.fileOriginSession.updateMany({
      where: { projectId: session.projectId, sessionId: session.id, state: 'active' },
      data: {
        titleSnapshot: session.title,
        state: 'deleting',
        deletedAt: null,
        deletionOperationId: operationId,
        retainedReviewIdsJson: JSON.stringify(retainedReviews.map((review) => review.id))
      }
    })
    if (updated.count !== 1) {
      throw new Error('Artifact origin Session is not active and cannot be deleted.')
    }
    return {
      kind: 'retained',
      projectId: session.projectId,
      sessionId: session.id,
      operationId
    }
  }

  async completeSessionDeletion(receipt: SessionDeletionReceipt): Promise<void> {
    if (receipt.kind === 'ordinary') {
      await this.deleteReviewsOutsideClosure(receipt.projectId, receipt.sessionId, [])
      return
    }
    const client = await this.options.getClient()
    const origin = await client.fileOriginSession.findUnique({
      where: {
        projectId_sessionId: { projectId: receipt.projectId, sessionId: receipt.sessionId }
      }
    })
    const retainedReviewIds = this.parseRetainedReviewIds(origin?.retainedReviewIdsJson)
    await this.deleteReviewsOutsideClosure(receipt.projectId, receipt.sessionId, retainedReviewIds)
    const updated = await client.fileOriginSession.updateMany({
      where: {
        projectId: receipt.projectId,
        sessionId: receipt.sessionId,
        state: 'deleting',
        deletionOperationId: receipt.operationId
      },
      data: {
        state: 'deleted',
        deletedAt: this.now(),
        deletionOperationId: null,
        retainedReviewIdsJson: null
      }
    })
    if (updated.count !== 1) throw new Error('Session deletion receipt is stale or invalid.')
  }

  async abortSessionDeletion(receipt: SessionDeletionReceipt): Promise<void> {
    if (receipt.kind === 'ordinary') return
    const client = await this.options.getClient()
    const updated = await client.fileOriginSession.updateMany({
      where: {
        projectId: receipt.projectId,
        sessionId: receipt.sessionId,
        state: 'deleting',
        deletionOperationId: receipt.operationId
      },
      data: {
        state: 'active',
        deletedAt: null,
        deletionOperationId: null,
        retainedReviewIdsJson: null
      }
    })
    if (updated.count !== 1) throw new Error('Session deletion receipt is stale or invalid.')
  }

  async reconcileSessionDeletions(activeSessions: PersistedChatSession[]): Promise<void> {
    const client = await this.options.getClient()
    await this.recoverStagingMessageSnapshots()
    const activeKeys = new Set(
      activeSessions.map((session) => `${session.projectId}\0${session.id}`)
    )
    const deletingOrigins = await client.fileOriginSession.findMany({
      where: { state: 'deleting' }
    })
    const [reviewSessions, origins] = await Promise.all([
      client.review.findMany({
        select: { projectId: true, sessionId: true },
        distinct: ['projectId', 'sessionId']
      }),
      client.fileOriginSession.findMany({ select: { projectId: true, sessionId: true } })
    ])
    const originKeys = new Set(origins.map((origin) => `${origin.projectId}\0${origin.sessionId}`))

    // An ordinary Session has no FileOriginSession tombstone. If the JSON disappeared after its
    // delete committed but before Review cleanup, startup can still identify and remove the orphan.
    for (const reviewSession of reviewSessions) {
      const key = `${reviewSession.projectId}\0${reviewSession.sessionId}`
      if (!activeKeys.has(key) && !originKeys.has(key)) {
        await this.deleteReviewsOutsideClosure(reviewSession.projectId, reviewSession.sessionId, [])
      }
    }

    for (const origin of deletingOrigins) {
      if (!activeKeys.has(`${origin.projectId}\0${origin.sessionId}`)) {
        await this.deleteReviewsOutsideClosure(
          origin.projectId,
          origin.sessionId,
          this.parseRetainedReviewIds(origin.retainedReviewIdsJson)
        )
      }
    }

    await client.$transaction(async (transaction) => {
      for (const origin of deletingOrigins) {
        const sessionStillExists = activeKeys.has(`${origin.projectId}\0${origin.sessionId}`)
        await transaction.fileOriginSession.update({
          where: {
            projectId_sessionId: {
              projectId: origin.projectId,
              sessionId: origin.sessionId
            }
          },
          data: sessionStillExists
            ? {
                state: 'active',
                deletedAt: null,
                deletionOperationId: null,
                retainedReviewIdsJson: null
              }
            : {
                state: 'deleted',
                deletedAt: this.now(),
                deletionOperationId: null,
                retainedReviewIdsJson: null
              }
        })
      }
    })
  }

  private async recoverStagingMessageSnapshots(): Promise<void> {
    const client = await this.options.getClient()
    const staging = await client.artifactMessageSnapshot.findMany({
      where: { state: 'staging' }
    })
    for (const snapshot of staging) {
      try {
        // Reuse the same immutable-file validation as normal reads. The temporary state override is
        // local to validation; SQLite remains staging until the promotion transaction commits.
        await this.verifyReadySnapshot(
          { ...snapshot, state: 'ready' },
          {
            rootFrameId: snapshot.rootFrameId,
            agentFrameId: snapshot.agentFrameId,
            messageBranchId: snapshot.messageBranchId,
            terminalMessageId: snapshot.terminalMessageId
          }
        )
        await client.$transaction(async (transaction) => {
          const promoted = await transaction.artifactMessageSnapshot.updateMany({
            where: { id: snapshot.id, state: 'staging' },
            data: { state: 'ready' }
          })
          if (promoted.count !== 1) {
            throw new Error(`Artifact Message snapshot recovery raced: ${snapshot.id}`)
          }
          await transaction.artifactVersion.updateMany({
            where: {
              state: 'finalized',
              rootFrameId: snapshot.rootFrameId,
              agentFrameId: snapshot.agentFrameId,
              messageBranchId: snapshot.messageBranchId,
              messageId: snapshot.terminalMessageId,
              artifact: {
                is: { projectId: snapshot.projectId, sessionId: snapshot.sessionId }
              }
            },
            data: { messageSnapshotId: snapshot.id }
          })
        })
      } catch {
        const deleted = await client.artifactMessageSnapshot.deleteMany({
          where: { id: snapshot.id, state: 'staging' }
        })
        if (deleted.count !== 1) continue
        const stagingPath = join(
          this.options.storageRoot,
          'artifacts',
          snapshot.projectId,
          snapshot.sessionId,
          '.provenance',
          '.staging',
          'messages',
          `${snapshot.id}.json`
        )
        await Promise.all([
          rm(resolveStorageKey(this.options.storageRoot, snapshot.storageKey), {
            force: true
          }).catch(() => undefined),
          rm(stagingPath, { force: true }).catch(() => undefined)
        ])
      }
    }
  }

  private parseRetainedReviewIds(value: string | null | undefined): string[] {
    try {
      const parsed = JSON.parse(value ?? '[]') as unknown
      return Array.isArray(parsed) && parsed.every((id) => typeof id === 'string') ? parsed : []
    } catch {
      return []
    }
  }

  private async deleteReviewsOutsideClosure(
    projectId: string,
    sessionId: string,
    retainedReviewIds: string[]
  ): Promise<void> {
    const client = await this.options.getClient()
    const reviews = await client.review.findMany({
      where: {
        projectId,
        sessionId,
        ...(retainedReviewIds.length > 0 ? { id: { notIn: retainedReviewIds } } : {})
      },
      select: { id: true, scopeSnapshot: { select: { storageKey: true } } }
    })
    if (reviews.length === 0) return
    const reviewIds = reviews.map((review) => review.id)
    // SQLite is the authoritative ownership index. Commit its Review closure atomically first so a
    // filesystem failure can never leave a discoverable Review whose immutable evidence was already
    // removed. Sidecars are storage garbage after commit and are therefore cleaned up best-effort.
    await client.$transaction(async (tx) => {
      await tx.finding.deleteMany({ where: { reviewId: { in: reviewIds } } })
      await tx.review.deleteMany({ where: { id: { in: reviewIds } } })
    })
    await Promise.all(
      reviews.map(async (review) => {
        if (!review.scopeSnapshot) return
        await rm(resolveStorageKey(this.options.storageRoot, review.scopeSnapshot.storageKey), {
          force: true
        }).catch(() => undefined)
      })
    )
  }

  private async captureScope(
    session: PersistedChatSession,
    version: {
      rootFrameId: string
      agentFrameId: string
      messageBranchId: string
      messageId: string | null
    }
  ): Promise<void> {
    if (!version.messageId || !session.conversationGraph) return
    if (session.conversationGraph.rootFrameId !== version.rootFrameId) {
      throw new Error('Artifact Message snapshot root Frame does not match the Session graph.')
    }
    const branch = session.conversationGraph.branches.find(
      (candidate) =>
        candidate.id === version.messageBranchId && candidate.agentFrameId === version.agentFrameId
    )
    if (!branch) throw new Error('Artifact Message snapshot Branch is unavailable.')
    const fullPath = resolveMessageBranchPath(session.conversationGraph, branch.id)
    const terminalIndex = fullPath.findIndex((message) => message.id === version.messageId)
    if (terminalIndex < 0) throw new Error('Artifact-owning Message is outside its bound Branch.')
    if (fullPath[terminalIndex]?.status === 'streaming') {
      // Artifact finalization may precede the assistant's final text chunks. Session autosave runs
      // during that window, but an immutable snapshot must wait for the owning Message to reach a
      // terminal state so a later save can freeze the complete response.
      return
    }
    const messages = fullPath
      .slice(0, terminalIndex + 1)
      .map((message) => projectMessage(session, message))
    const scopedMessageIds = new Set(
      fullPath.slice(0, terminalIndex + 1).map((message) => message.id)
    )
    const activities = session.conversationGraph.activities.flatMap((activity) => {
      if (
        activity.agentFrameId !== version.agentFrameId ||
        !scopedMessageIds.has(activity.promptMessageId)
      ) {
        return []
      }
      const projected = sanitizeToolActivity(activity)
      return projected ? [projected] : []
    })
    const activityIds = new Set(activities.map((activity) => activity.id))
    const activityGroups = session.conversationGraph.activityGroups.flatMap((group) => {
      if (
        group.agentFrameId !== version.agentFrameId ||
        !scopedMessageIds.has(group.promptMessageId)
      ) {
        return []
      }
      const projected = sanitizeActivityGroup(group)
      if (!projected) return []
      const scopedActivityIds = projected.activityIds.filter((id) => activityIds.has(id))
      return scopedActivityIds.length > 0 ? [{ ...projected, activityIds: scopedActivityIds }] : []
    })
    const client = await this.options.getClient()
    const unique = {
      projectId: session.projectId,
      sessionId: session.id,
      agentFrameId: version.agentFrameId,
      messageBranchId: version.messageBranchId,
      terminalMessageId: version.messageId
    }
    let snapshot = await client.artifactMessageSnapshot.findUnique({
      where: {
        projectId_sessionId_agentFrameId_messageBranchId_terminalMessageId: unique
      }
    })
    if (snapshot?.state === 'ready') {
      await this.verifyReadySnapshot(snapshot, {
        rootFrameId: version.rootFrameId,
        agentFrameId: version.agentFrameId,
        messageBranchId: version.messageBranchId,
        terminalMessageId: version.messageId
      })
      await this.linkVersions(snapshot.id, unique)
      return
    }

    const snapshotId = snapshot?.id ?? this.createId()
    const finalStorageKey = storageKey(
      'artifacts',
      session.projectId,
      session.id,
      '.provenance',
      'message-snapshots',
      `${snapshotId}.json`
    )
    const payload: ArtifactMessageSnapshotFile = {
      schemaVersion: 3,
      snapshotId,
      rootFrameId: version.rootFrameId,
      agentFrameId: version.agentFrameId,
      messageBranchId: version.messageBranchId,
      terminalMessageId: version.messageId,
      createdAt: snapshot?.createdAt.toISOString() ?? this.now().toISOString(),
      messages,
      activities,
      activityGroups
    }
    const serialized = `${JSON.stringify(payload, null, 2)}\n`
    const checksum = sha256(serialized)
    if (!snapshot) {
      snapshot = await client.artifactMessageSnapshot.create({
        data: {
          id: snapshotId,
          ...unique,
          rootFrameId: version.rootFrameId,
          state: 'staging',
          storageKey: finalStorageKey,
          checksum,
          messageCount: messages.length,
          createdAt: new Date(payload.createdAt)
        }
      })
    }

    const stagingPath = join(
      this.options.storageRoot,
      'artifacts',
      session.projectId,
      session.id,
      '.provenance',
      '.staging',
      'messages',
      `${snapshotId}.json`
    )
    const finalPath = join(this.options.storageRoot, ...finalStorageKey.split('/'))
    await mkdir(dirname(stagingPath), { recursive: true })
    await mkdir(dirname(finalPath), { recursive: true })
    await writeFile(stagingPath, serialized, 'utf8')
    await rename(stagingPath, finalPath)
    await client.$transaction(async (transaction) => {
      await transaction.artifactMessageSnapshot.update({
        where: { id: snapshotId },
        data: { state: 'ready', checksum, messageCount: messages.length }
      })
      await transaction.artifactVersion.updateMany({
        where: {
          state: 'finalized',
          rootFrameId: version.rootFrameId,
          agentFrameId: version.agentFrameId,
          messageBranchId: version.messageBranchId,
          messageId: version.messageId,
          artifact: { is: { projectId: session.projectId, sessionId: session.id } }
        },
        data: { messageSnapshotId: snapshotId }
      })
    })
  }

  private async linkVersions(
    snapshotId: string,
    scope: {
      projectId: string
      sessionId: string
      agentFrameId: string
      messageBranchId: string
      terminalMessageId: string
    }
  ): Promise<void> {
    const client = await this.options.getClient()
    await client.artifactVersion.updateMany({
      where: {
        state: 'finalized',
        agentFrameId: scope.agentFrameId,
        messageBranchId: scope.messageBranchId,
        messageId: scope.terminalMessageId,
        artifact: { is: { projectId: scope.projectId, sessionId: scope.sessionId } }
      },
      data: { messageSnapshotId: snapshotId }
    })
  }

  private async verifyReadySnapshot(
    snapshot: {
      id: string
      state: string
      storageKey: string
      checksum: string
      messageCount: number
      rootFrameId: string
      agentFrameId: string
      messageBranchId: string
      terminalMessageId: string
    },
    expected: {
      rootFrameId: string
      agentFrameId: string
      messageBranchId: string
      terminalMessageId: string
    }
  ): Promise<void> {
    if (snapshot.state !== 'ready') {
      throw new Error(`Artifact Message snapshot is not ready: ${snapshot.id}`)
    }
    const serialized = await readFile(
      resolveStorageKey(this.options.storageRoot, snapshot.storageKey),
      'utf8'
    ).catch((error: unknown) => {
      throw new Error(
        `Artifact Message snapshot is unavailable: ${snapshot.id}: ${error instanceof Error ? error.message : String(error)}`
      )
    })
    const checksum = sha256(serialized)
    if (snapshot.checksum && snapshot.checksum !== checksum) {
      throw new Error(`Artifact Message snapshot checksum mismatch: ${snapshot.id}`)
    }

    let payload: ArtifactMessageSnapshotFile
    try {
      payload = JSON.parse(serialized) as ArtifactMessageSnapshotFile
    } catch {
      throw new Error(`Artifact Message snapshot is malformed: ${snapshot.id}`)
    }
    const hasValidPath =
      Array.isArray(payload.messages) &&
      payload.messages.every(
        (message, index) =>
          index === 0 || message.parentMessageId === payload.messages[index - 1]?.id
      )
    if (
      (payload.schemaVersion !== 2 && payload.schemaVersion !== 3) ||
      payload.snapshotId !== snapshot.id ||
      payload.rootFrameId !== snapshot.rootFrameId ||
      payload.agentFrameId !== snapshot.agentFrameId ||
      payload.messageBranchId !== snapshot.messageBranchId ||
      payload.terminalMessageId !== snapshot.terminalMessageId ||
      payload.rootFrameId !== expected.rootFrameId ||
      payload.agentFrameId !== expected.agentFrameId ||
      payload.messageBranchId !== expected.messageBranchId ||
      payload.terminalMessageId !== expected.terminalMessageId ||
      !Array.isArray(payload.messages) ||
      payload.messages.length !== snapshot.messageCount ||
      payload.messages.at(-1)?.id !== snapshot.terminalMessageId ||
      !hasValidPath ||
      (payload.schemaVersion === 3 &&
        (!Array.isArray(payload.activities) || !Array.isArray(payload.activityGroups)))
    ) {
      throw new Error(`Artifact Message snapshot identity mismatch: ${snapshot.id}`)
    }

    if (!snapshot.checksum) {
      const client = await this.options.getClient()
      const updated = await client.artifactMessageSnapshot.updateMany({
        where: { id: snapshot.id, state: 'ready', checksum: '' },
        data: { checksum }
      })
      if (updated.count !== 1) {
        throw new Error(`Artifact Message snapshot checksum backfill raced: ${snapshot.id}`)
      }
    }
  }
}

export { ProvenanceMessageSnapshotRepository }
export type { ProvenanceMessageSnapshotOptions, SessionDeletionReceipt }
