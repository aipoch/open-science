import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  createLinearConversationGraph,
  projectConversationMessage,
  synchronizeActiveConversationActivities
} from '../../shared/conversation-graph'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { createProjectDbClient, ensureProjectSchema } from '../projects/prisma-client'
import { ReviewRepository } from '../reviewer/repository'
import { createPngInlineSource } from './artifact-test-fixtures'
import { ArtifactRepository } from './repository'
import { ArtifactProvenanceRepository } from './provenance-repository'
import { ProvenanceMessageSnapshotRepository } from './provenance-message-snapshot'

let storageRoot: string | undefined
let disconnect: (() => Promise<void>) | undefined

afterEach(async () => {
  await disconnect?.()
  disconnect = undefined
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
  storageRoot = undefined
})

describe('Provenance Message snapshots', () => {
  it('freezes the exact Artifact Branch path without upload paths or image bytes', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-provenance-messages-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await ensureProjectSchema(client)
    const compatibilityRepository = new ArtifactRepository(storageRoot)
    const durableSessionAuthority: { current?: PersistedChatSession } = {}
    const provenance = new ArtifactProvenanceRepository({
      storageRoot,
      getClient: () => Promise.resolve(client),
      compatibilityRepository,
      loadSession: async () => durableSessionAuthority.current
    })
    const graph = synchronizeActiveConversationActivities(
      createLinearConversationGraph({
        sessionId: 'session-1',
        messages: [
          {
            id: 'prompt-1',
            role: 'user',
            content: 'plot sin',
            status: 'complete',
            eventIds: [],
            uploads: [
              {
                id: 'upload-1',
                versionId: 'upload-version-1',
                sessionId: 'session-1',
                name: 'input.csv',
                originalName: 'input.csv',
                path: '/secret/input.csv',
                size: 12
              }
            ],
            createdAt: 1,
            updatedAt: 1
          },
          {
            id: 'message-1',
            role: 'agent',
            content: 'saved sin.png',
            status: 'complete',
            eventIds: [],
            images: [{ id: 'image-1', mimeType: 'image/png', data: 'aGVsbG8=', byteLength: 5 }],
            createdAt: 2,
            updatedAt: 2
          }
        ],
        frameworkId: 'codex',
        model: 'gpt-5',
        createdAt: 1,
        updatedAt: 2
      }),
      [
        {
          id: 'activity-1',
          kind: 'tool',
          title: 'Notebook cell',
          activityGroupId: 'activity-group-1',
          status: 'completed',
          sortIndex: 1,
          eventIds: ['event-1'],
          providerToolName: 'mcp__open-science-notebook__notebook_execute',
          toolKind: 'execute',
          rawInput: { code: 'plot(sin(x))' },
          rawOutput: { status: 'completed' },
          createdAt: 1.5,
          updatedAt: 1.75
        }
      ],
      [
        {
          id: 'activity-group-1',
          title: 'Notebook execution',
          sortIndex: 1,
          activityIds: ['activity-1'],
          createdAt: 1.5,
          updatedAt: 1.75,
          completedAt: 1.75
        }
      ]
    )
    const context = {
      rootFrameId: graph.rootFrameId,
      agentFrameId: graph.activeFrameId,
      messageBranchId: graph.branches[0].id,
      runtimeSegmentId: graph.runtimeSegments[0].id,
      promptMessageId: 'prompt-1'
    }
    await compatibilityRepository.writePendingFile({
      projectName: 'project-1',
      sessionId: 'artifact-session-1',
      runId: 'artifact-run-1',
      filename: 'sin.png',
      source: createPngInlineSource('plot bytes')
    })
    const version = await provenance.createVersion({
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-1',
      artifactRunId: 'artifact-run-1',
      writeOperationId: 'write-1',
      writeRequestChecksum: 'a'.repeat(64),
      filename: 'sin.png',
      ...context
    })
    const session: PersistedChatSession = {
      id: 'session-1',
      projectId: 'project-1',
      title: 'Sine',
      cwd: '/secret/workspace',
      status: 'idle',
      messages: graph.messages.map(projectConversationMessage),
      conversationGraph: graph,
      createdAt: 1,
      updatedAt: 2
    }
    durableSessionAuthority.current = session
    await provenance.finalizeRun({
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactRunId: 'artifact-run-1',
      messageId: 'message-1',
      ...context
    })
    const snapshots = new ProvenanceMessageSnapshotRepository({
      storageRoot,
      getClient: () => Promise.resolve(client)
    })

    const streamingSession = structuredClone(session)
    const streamingMessage = streamingSession.conversationGraph?.messages.find(
      (message) => message.id === 'message-1'
    )
    if (!streamingMessage || !streamingSession.conversationGraph) {
      throw new Error('Expected the Artifact-owning Message in the conversation graph.')
    }
    streamingMessage.status = 'streaming'
    streamingMessage.content = 'saved'
    streamingSession.messages = streamingSession.conversationGraph.messages.map(
      projectConversationMessage
    )

    await snapshots.captureFinalizedMessages(streamingSession)

    await expect(
      client.artifactVersion.findUniqueOrThrow({ where: { id: version.versionId } })
    ).resolves.toMatchObject({ messageSnapshotId: null })

    await snapshots.captureFinalizedMessages(session)

    const row = await client.artifactVersion.findUniqueOrThrow({
      where: { id: version.versionId },
      include: { messageSnapshot: true }
    })
    expect(row.messageSnapshot).toMatchObject({
      state: 'ready',
      messageCount: 2,
      checksum: expect.stringMatching(/^[a-f0-9]{64}$/u)
    })
    const read = await provenance.getVersionProvenance({
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactId: version.artifactId,
      versionId: version.versionId
    })
    expect(read.messages).toMatchObject({
      state: 'available',
      items: [
        { id: 'prompt-1', hasOmittedMedia: true },
        {
          id: 'message-1',
          content: 'saved sin.png',
          hasOmittedMedia: true,
          agentAttribution: { frameworkId: 'codex', model: 'gpt-5' }
        }
      ],
      activities: [
        {
          id: 'activity-1',
          providerToolName: 'mcp__open-science-notebook__notebook_execute',
          rawInput: { code: 'plot(sin(x))' }
        }
      ],
      activityGroups: [
        {
          id: 'activity-group-1',
          activityIds: ['activity-1']
        }
      ]
    })
    const snapshotPath = join(storageRoot, ...row.messageSnapshot!.storageKey.split('/'))
    const snapshotPayload = JSON.parse(await readFile(snapshotPath, 'utf8')) as Record<
      string,
      unknown
    > & { schemaVersion: number }
    expect(snapshotPayload.schemaVersion).toBe(3)

    // Previously captured v2 snapshots remain readable; they simply have no process timeline.
    const legacyPayload: Record<string, unknown> = { ...snapshotPayload, schemaVersion: 2 }
    delete legacyPayload.activities
    delete legacyPayload.activityGroups
    await client.artifactMessageSnapshot.update({
      where: { id: row.messageSnapshot!.id },
      data: { checksum: '' }
    })
    await writeFile(snapshotPath, `${JSON.stringify(legacyPayload, null, 2)}\n`, 'utf8')
    await expect(
      provenance.getVersionProvenance({
        projectId: 'project-1',
        appSessionId: 'session-1',
        artifactId: version.artifactId,
        versionId: version.versionId
      })
    ).resolves.toMatchObject({
      messages: { state: 'available', activities: [], activityGroups: [] }
    })
    await writeFile(snapshotPath, `${JSON.stringify(snapshotPayload, null, 2)}\n`, 'utf8')
    await client.artifactMessageSnapshot.update({
      where: { id: row.messageSnapshot!.id },
      data: { checksum: '' }
    })
    expect(JSON.stringify(read.messages)).not.toContain('/secret')
    expect(JSON.stringify(read.messages)).not.toContain('aGVsbG8=')

    // A legacy empty checksum is backfilled from structurally valid bytes. Once established, a
    // same-shape content edit must fail deletion instead of silently retaining corrupted evidence.
    await provenance.getVersionMessages({
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactId: version.artifactId,
      versionId: version.versionId
    })
    const tamperedPayload = structuredClone(snapshotPayload) as typeof snapshotPayload & {
      messages: Array<Record<string, unknown>>
    }
    tamperedPayload.messages[0] = {
      ...tamperedPayload.messages[0],
      content: 'tampered after capture'
    }
    await writeFile(snapshotPath, `${JSON.stringify(tamperedPayload, null, 2)}\n`, 'utf8')
    await expect(snapshots.prepareSessionDeletion(session)).rejects.toThrow(
      /Message snapshot checksum mismatch/u
    )
    await writeFile(snapshotPath, `${JSON.stringify(snapshotPayload, null, 2)}\n`, 'utf8')

    const deletion = await snapshots.prepareSessionDeletion(session)
    expect(deletion).toMatchObject({ kind: 'retained' })
    await expect(
      client.fileOriginSession.findUniqueOrThrow({
        where: { projectId_sessionId: { projectId: 'project-1', sessionId: 'session-1' } }
      })
    ).resolves.toMatchObject({
      state: 'deleting',
      titleSnapshot: 'Sine',
      deletionOperationId: deletion.kind === 'retained' ? deletion.operationId : undefined
    })

    if (deletion.kind !== 'retained') throw new Error('Expected retained deletion receipt.')
    await snapshots.completeSessionDeletion(deletion)

    const deletedOrigin = await client.fileOriginSession.findUniqueOrThrow({
      where: { projectId_sessionId: { projectId: 'project-1', sessionId: 'session-1' } }
    })
    expect(deletedOrigin).toMatchObject({
      state: 'deleted',
      titleSnapshot: 'Sine',
      deletionOperationId: null
    })
    expect(deletedOrigin.deletedAt).toBeInstanceOf(Date)
    await expect(
      provenance.getLineage({
        projectId: 'project-1',
        appSessionId: 'session-1',
        artifactId: version.artifactId
      })
    ).resolves.toMatchObject({
      originSession: { sessionId: 'session-1', state: 'deleted', title: 'Sine' }
    })
    await expect(
      provenance.getVersionProvenance({
        projectId: 'project-1',
        appSessionId: 'session-1',
        artifactId: version.artifactId,
        versionId: version.versionId
      })
    ).resolves.toMatchObject({ messages: { state: 'available' } })
  })

  it('does not retain an origin tombstone for a Session without durable files', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-provenance-empty-session-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await ensureProjectSchema(client)
    const snapshots = new ProvenanceMessageSnapshotRepository({
      storageRoot,
      getClient: () => Promise.resolve(client)
    })
    const session: PersistedChatSession = {
      id: 'session-empty',
      projectId: 'project-1',
      title: 'Empty',
      cwd: '/workspace',
      status: 'idle',
      messages: [],
      createdAt: 1,
      updatedAt: 1
    }

    const reviews = new ReviewRepository(() => Promise.resolve(client), {
      snapshotStorageRoot: storageRoot
    })
    const review = await reviews.createReview({
      projectId: 'project-1',
      sessionId: 'session-empty',
      turnMessageId: 'turn-1',
      scope: { turnMessageId: 'turn-1', blocks: [], artifactVersionIds: [] },
      scopeSnapshot: []
    })
    const reviewSnapshot = await client.reviewScopeSnapshot.findUniqueOrThrow({
      where: { reviewId: review.id }
    })
    const receipt = await snapshots.prepareSessionDeletion(session)
    expect(receipt).toEqual({
      kind: 'ordinary',
      projectId: 'project-1',
      sessionId: 'session-empty'
    })
    await snapshots.completeSessionDeletion(receipt)
    await expect(client.review.findUnique({ where: { id: review.id } })).resolves.toBeNull()
    await expect(
      readFile(join(storageRoot, ...reviewSnapshot.storageKey.split('/')))
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      client.fileOriginSession.findUnique({
        where: { projectId_sessionId: { projectId: 'project-1', sessionId: 'session-empty' } }
      })
    ).resolves.toBeNull()
  })

  it('retains only the Review closure reachable from surviving Artifact Versions', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-provenance-review-retention-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await ensureProjectSchema(client)
    const compatibilityRepository = new ArtifactRepository(storageRoot)
    const provenance = new ArtifactProvenanceRepository({
      storageRoot,
      getClient: () => Promise.resolve(client),
      compatibilityRepository
    })
    const graph = createLinearConversationGraph({
      sessionId: 'session-1',
      messages: [
        {
          id: 'prompt-1',
          role: 'user',
          content: 'plot sin',
          status: 'complete',
          eventIds: [],
          createdAt: 1,
          updatedAt: 1
        }
      ],
      frameworkId: 'codex',
      createdAt: 1,
      updatedAt: 1
    })
    const context = {
      rootFrameId: graph.rootFrameId,
      agentFrameId: graph.activeFrameId,
      messageBranchId: graph.branches[0].id,
      runtimeSegmentId: graph.runtimeSegments[0].id,
      promptMessageId: 'prompt-1'
    }
    await compatibilityRepository.writePendingFile({
      projectName: 'project-1',
      sessionId: 'artifact-session-1',
      runId: 'artifact-run-1',
      filename: 'sin.png',
      source: createPngInlineSource('plot bytes')
    })
    const version = await provenance.createVersion({
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-1',
      artifactRunId: 'artifact-run-1',
      writeOperationId: 'write-1',
      writeRequestChecksum: 'a'.repeat(64),
      filename: 'sin.png',
      ...context
    })
    const reviews = new ReviewRepository(() => Promise.resolve(client), {
      snapshotStorageRoot: storageRoot
    })
    const direct = await reviews.createReview({
      projectId: 'project-1',
      sessionId: 'session-1',
      turnMessageId: 'prompt-1',
      scope: {
        turnMessageId: 'prompt-1',
        blocks: [],
        artifactVersionIds: [version.versionId]
      },
      lifecycle: 'complete',
      outcome: 'flagged',
      scopeSnapshot: []
    })
    await reviews.addChecks(direct.id, [
      {
        status: 'warn',
        claim: 'The label is ambiguous.',
        evidence: 'The plotted line has no unit.',
        artifactVersionId: version.versionId
      }
    ])
    const [directWithCheck] = await reviews.getReviewsForProjectSession('project-1', 'session-1')
    const correction = await reviews.createReview({
      projectId: 'project-1',
      sessionId: 'session-1',
      turnMessageId: 'prompt-1',
      scope: { turnMessageId: 'correction-1', blocks: [], artifactVersionIds: [] },
      lifecycle: 'complete',
      outcome: 'pass',
      scopeSnapshot: []
    })
    await reviews.appendFindingDisposition({
      eventId: 'review-disposition-1',
      sourceFindingId: directWithCheck.checks[0]!.id,
      causeReviewId: correction.id,
      trigger: 'review_submission',
      outcome: 'resolved'
    })
    const unrelated = await reviews.createReview({
      projectId: 'project-1',
      sessionId: 'session-1',
      turnMessageId: 'unrelated-turn',
      scope: { turnMessageId: 'unrelated-turn', blocks: [], artifactVersionIds: [] },
      lifecycle: 'complete',
      outcome: 'pass',
      scopeSnapshot: []
    })
    const unrelatedSnapshot = await client.reviewScopeSnapshot.findUniqueOrThrow({
      where: { reviewId: unrelated.id }
    })
    const directSnapshot = await client.reviewScopeSnapshot.findUniqueOrThrow({
      where: { reviewId: direct.id }
    })
    await client.reviewScopeSnapshot.update({
      where: { reviewId: direct.id },
      data: { state: 'staging' }
    })

    const session: PersistedChatSession = {
      id: 'session-1',
      projectId: 'project-1',
      title: 'Sine',
      cwd: '/workspace',
      status: 'idle',
      messages: graph.messages.map(projectConversationMessage),
      conversationGraph: graph,
      createdAt: 1,
      updatedAt: 1
    }
    const snapshots = new ProvenanceMessageSnapshotRepository({
      storageRoot,
      getClient: () => Promise.resolve(client)
    })
    await expect(snapshots.prepareSessionDeletion(session)).rejects.toThrow(
      `Review scope snapshot is not ready or valid: ${direct.id}`
    )
    await client.reviewScopeSnapshot.update({
      where: { reviewId: direct.id },
      data: { state: 'ready', checksum: directSnapshot.checksum }
    })

    const receipt = await snapshots.prepareSessionDeletion(session)
    expect(receipt.kind).toBe('retained')
    await snapshots.completeSessionDeletion(receipt)

    const retained = await reviews.getReviewsForProjectSession('project-1', 'session-1')
    expect(new Set(retained.map((review) => review.id))).toEqual(
      new Set([direct.id, correction.id])
    )
    await expect(
      client.reviewFindingDisposition.count({
        where: { sourceFindingId: directWithCheck.checks[0]!.id }
      })
    ).resolves.toBe(1)
    await expect(
      readFile(join(storageRoot, ...unrelatedSnapshot.storageKey.split('/')), 'utf8')
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('removes orphan Reviews when startup confirms an ordinary Session JSON is gone', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-provenance-review-recovery-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await ensureProjectSchema(client)
    const reviews = new ReviewRepository(() => Promise.resolve(client), {
      snapshotStorageRoot: storageRoot
    })
    const review = await reviews.createReview({
      projectId: 'project-1',
      sessionId: 'ordinary-session',
      turnMessageId: 'turn-1',
      scope: { turnMessageId: 'turn-1', blocks: [], artifactVersionIds: [] },
      scopeSnapshot: []
    })
    const snapshots = new ProvenanceMessageSnapshotRepository({
      storageRoot,
      getClient: () => Promise.resolve(client)
    })

    await snapshots.reconcileSessionDeletions([])

    await expect(client.review.findUnique({ where: { id: review.id } })).resolves.toBeNull()
  })

  it('commits ordinary Review deletion even when sidecar cleanup cannot complete', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-provenance-review-sidecar-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await ensureProjectSchema(client)
    const reviews = new ReviewRepository(() => Promise.resolve(client), {
      snapshotStorageRoot: storageRoot
    })
    const review = await reviews.createReview({
      projectId: 'project-1',
      sessionId: 'ordinary-session',
      turnMessageId: 'turn-1',
      scope: { turnMessageId: 'turn-1', blocks: [], artifactVersionIds: [] },
      scopeSnapshot: []
    })
    const snapshot = await client.reviewScopeSnapshot.findUniqueOrThrow({
      where: { reviewId: review.id }
    })
    const sidecarPath = join(storageRoot, ...snapshot.storageKey.split('/'))
    await rm(sidecarPath)
    await mkdir(sidecarPath)
    await writeFile(join(sidecarPath, 'undeletable-without-recursive.txt'), 'leftover', 'utf8')
    const snapshots = new ProvenanceMessageSnapshotRepository({
      storageRoot,
      getClient: () => Promise.resolve(client)
    })

    await expect(snapshots.reconcileSessionDeletions([])).resolves.toBeUndefined()

    await expect(client.review.findUnique({ where: { id: review.id } })).resolves.toBeNull()
  })

  it('recovers valid staging Message snapshots and removes corrupt staging rows at startup', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-provenance-message-recovery-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await ensureProjectSchema(client)
    await client.fileOriginSession.create({
      data: { projectId: 'project-1', sessionId: 'session-1' }
    })
    const createStagingSnapshot = async (id: string, corruptChecksum = false): Promise<void> => {
      const storageKey = `artifacts/project-1/session-1/.provenance/message-snapshots/${id}.json`
      const terminalMessageId = `message-${id}`
      const payload = {
        schemaVersion: 3,
        snapshotId: id,
        rootFrameId: 'root-frame-1',
        agentFrameId: 'agent-frame-1',
        messageBranchId: 'branch-1',
        terminalMessageId,
        createdAt: '2026-07-27T12:00:00.000Z',
        messages: [
          {
            id: terminalMessageId,
            role: 'agent',
            content: 'saved artifact',
            createdAt: 1
          }
        ],
        activities: [],
        activityGroups: []
      }
      const serialized = `${JSON.stringify(payload, null, 2)}\n`
      const path = join(storageRoot!, ...storageKey.split('/'))
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, serialized, 'utf8')
      await client.artifactMessageSnapshot.create({
        data: {
          id,
          projectId: 'project-1',
          sessionId: 'session-1',
          rootFrameId: 'root-frame-1',
          agentFrameId: 'agent-frame-1',
          messageBranchId: 'branch-1',
          terminalMessageId,
          state: 'staging',
          storageKey,
          checksum: corruptChecksum
            ? 'f'.repeat(64)
            : createHash('sha256').update(serialized).digest('hex'),
          messageCount: 1
        }
      })
    }
    await createStagingSnapshot('snapshot-valid-1')
    await createStagingSnapshot('snapshot-corrupt-1', true)
    const snapshots = new ProvenanceMessageSnapshotRepository({
      storageRoot,
      getClient: () => Promise.resolve(client)
    })

    await snapshots.reconcileSessionDeletions([])

    await expect(
      client.artifactMessageSnapshot.findUniqueOrThrow({ where: { id: 'snapshot-valid-1' } })
    ).resolves.toMatchObject({ state: 'ready' })
    await expect(
      client.artifactMessageSnapshot.findUnique({ where: { id: 'snapshot-corrupt-1' } })
    ).resolves.toBeNull()
  })

  it('recovers a deleting origin from authoritative Session JSON presence', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-provenance-delete-recovery-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await ensureProjectSchema(client)
    const snapshots = new ProvenanceMessageSnapshotRepository({
      storageRoot,
      getClient: () => Promise.resolve(client),
      now: () => new Date('2026-07-27T13:00:00.000Z')
    })
    const session: PersistedChatSession = {
      id: 'session-1',
      projectId: 'project-1',
      title: 'Recovery',
      cwd: '/workspace',
      status: 'idle',
      messages: [],
      createdAt: 1,
      updatedAt: 1
    }
    await client.fileOriginSession.create({
      data: {
        projectId: 'project-1',
        sessionId: 'session-1',
        state: 'deleting',
        deletionOperationId: 'delete-1',
        retainedReviewIdsJson: '[]'
      }
    })

    await snapshots.reconcileSessionDeletions([session])
    await expect(
      client.fileOriginSession.findUniqueOrThrow({
        where: { projectId_sessionId: { projectId: 'project-1', sessionId: 'session-1' } }
      })
    ).resolves.toMatchObject({ state: 'active', deletionOperationId: null, deletedAt: null })

    await client.fileOriginSession.update({
      where: { projectId_sessionId: { projectId: 'project-1', sessionId: 'session-1' } },
      data: {
        state: 'deleting',
        deletionOperationId: 'delete-2',
        retainedReviewIdsJson: '[]'
      }
    })
    await snapshots.reconcileSessionDeletions([])
    await expect(
      client.fileOriginSession.findUniqueOrThrow({
        where: { projectId_sessionId: { projectId: 'project-1', sessionId: 'session-1' } }
      })
    ).resolves.toMatchObject({
      state: 'deleted',
      deletionOperationId: null,
      retainedReviewIdsJson: null,
      deletedAt: new Date('2026-07-27T13:00:00.000Z')
    })
  })
})
