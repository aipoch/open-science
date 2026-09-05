import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { PrismaClient } from '@prisma/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/home/user', isPackaged: true },
  ipcMain: { handle: vi.fn() },
  shell: { openPath: vi.fn() }
}))

import { createLinearConversationGraph } from '../../shared/conversation-graph'
import {
  ARTIFACT_FINALIZATION_INVALID_PROOF,
  type ReconcilePendingArtifactsRequest
} from '../../shared/artifacts'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { createPngBytes, createPngInlineSource } from '../artifacts/artifact-test-fixtures'
import { ProvenanceMessageSnapshotRepository } from '../artifacts/provenance-message-snapshot'
import { ArtifactProvenanceRepository } from '../artifacts/provenance-repository'
import { requireAgentArtifactVersion } from '../artifacts/provenance-version-kind'
import { ArtifactRepository } from '../artifacts/repository'
import { createArtifactHandlers } from '../artifacts/ipc'
import { ArtifactRunRegistry } from '../artifacts/run-registry'
import { ManagedPreviewResources } from '../managed-preview-resources'
import { ManagedFileVersionService } from '../managed-file-versions/service'
import { ManagedFileIndexRepository } from '../project-files/repository'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { SessionPersistenceCoordinator } from './coordinator'
import { SessionRepository } from './repository'
import { UploadRepository } from '../uploads/repository'

const PROJECT_ID = 'project-1'
const SESSION_ID = 'session-1'
const STORAGE_SESSION_ID = 'artifact-session-1'
const RUN_ID = 'artifact-run-1'

describe('artifact finalization startup recovery', () => {
  let storageRoot: string
  let client: PrismaClient
  let sessions: SessionRepository
  let files: ManagedFileIndexRepository

  beforeEach(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-artifact-finalization-recovery-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    sessions = new SessionRepository(storageRoot)
    files = new ManagedFileIndexRepository(
      () => Promise.resolve(client),
      storageRoot,
      new ManagedFileVersionService({
        storageRoot,
        getClient: () => Promise.resolve(client)
      }),
      new UploadRepository(storageRoot, { getClient: () => Promise.resolve(client) })
    )
  })

  afterEach(async () => {
    await client.$disconnect()
    await rm(storageRoot, { recursive: true, force: true })
  })

  it('retries durable finalization in the current Session and remains idempotent', async () => {
    const compatibility = new ArtifactRepository(storageRoot)
    const { provenance, version } = await prepareRecovery(compatibility)
    const coordinator = new SessionPersistenceCoordinator(
      sessions,
      files,
      undefined,
      undefined,
      undefined,
      provenance
    )
    const request = {
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      messageId: 'message-1',
      pendingPaths: [],
      artifactVersionIds: [version.versionId]
    }

    const recovery = await coordinator.retryArtifactFinalization(request)
    const finalized = recovery?.artifacts

    expect(finalized).toEqual([
      expect.objectContaining({
        id: version.versionId,
        isPublished: true,
        artifactId: version.artifactId,
        versionId: version.versionId,
        projectId: PROJECT_ID,
        sessionId: SESSION_ID
      })
    ])
    await expect(
      client.artifactVersion.findUniqueOrThrow({ where: { id: version.versionId } })
    ).resolves.toMatchObject({ state: 'finalized', messageId: 'message-1' })
    const durableSession = await sessions.loadSession(PROJECT_ID, SESSION_ID)
    expect(durableSession?.messages[1].artifactIds).toBeUndefined()
    expect(durableSession?.artifacts).toBeUndefined()

    await expect(coordinator.retryArtifactFinalization(request)).resolves.toEqual(recovery)
  })

  const prepareAttachedRecovery = async (
    outputCount = 1,
    earlierMessage = true
  ): Promise<
    Awaited<ReturnType<typeof prepareRecovery>> & {
      compatibility: ArtifactRepository
      session: PersistedChatSession
      coordinator: SessionPersistenceCoordinator
      handlers: ReturnType<typeof createArtifactHandlers>
      resources: ManagedPreviewResources
      request: ReconcilePendingArtifactsRequest
    }
  > => {
    const compatibility = new ArtifactRepository(storageRoot)
    const fixture = await prepareRecovery(compatibility, outputCount)
    const { versions, provenance } = fixture
    await client.project.create({ data: { id: PROJECT_ID, name: 'Recovery project' } })
    const session = (await sessions.loadSession(PROJECT_ID, SESSION_ID))!
    session.messages[1].artifactIds = versions.map((version) => version.versionId)
    session.artifacts = versions.map((version) => ({
      id: version.versionId,
      artifactId: version.artifactId,
      versionId: version.versionId,
      versionNumber: version.versionNumber,
      kind: 'managed-file',
      path: version.path,
      fileUrl: version.fileUrl,
      name: version.name,
      mimeType: version.mimeType,
      size: version.size,
      mtimeMs: version.mtimeMs,
      sha256: version.checksum
    }))
    if (earlierMessage) {
      session.messages.splice(1, 0, {
        id: 'assistant-preface',
        role: 'agent',
        status: 'complete',
        content: 'I will generate the result.',
        eventIds: [],
        createdAt: 2,
        updatedAt: 2
      })
    }
    session.conversationGraph = createLinearConversationGraph({
      sessionId: SESSION_ID,
      messages: session.messages.map(
        ({ id, role, content, status, eventIds, createdAt, updatedAt, artifactIds }) => ({
          id,
          role,
          content,
          status,
          eventIds,
          createdAt,
          updatedAt,
          artifactIds
        })
      ),
      frameworkId: 'codex',
      createdAt: 1,
      updatedAt: 2
    })
    await sessions.saveSession(session)
    const coordinator = new SessionPersistenceCoordinator(
      sessions,
      files,
      undefined,
      undefined,
      undefined,
      provenance
    )
    const managedVersions = new ManagedFileVersionService({
      storageRoot,
      getClient: () => Promise.resolve(client)
    })
    const handlers = createArtifactHandlers(compatibility, new ArtifactRunRegistry(), {
      openLatestManagedFile: (request) =>
        managedVersions.openLatest({
          projectId: request.projectId!,
          source: 'artifact',
          fileId: request.fileId!
        }),
      openManagedFileVersion: (request) =>
        managedVersions.openVersion(
          {
            projectId: request.projectId!,
            source: 'artifact',
            fileId: request.fileId!
          },
          request.versionId
        )
    })
    const resources = new ManagedPreviewResources({
      resolvePath: async () => {
        throw new Error('Public previews must use managed Versions.')
      },
      openLatestManagedFile: (source, request) =>
        managedVersions.openLatest({ ...request, source }),
      openManagedFileVersion: (source, request) =>
        managedVersions.openVersion({ ...request, source }, request.versionId)
    })
    const request = {
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      messageId: 'message-1',
      pendingPaths: [],
      artifactVersionIds: versions.map((version) => version.versionId)
    }
    return { ...fixture, compatibility, session, coordinator, handlers, resources, request }
  }

  it.each([
    { earlierMessage: false, outputCount: 1, restart: false },
    { earlierMessage: true, outputCount: 1, restart: false },
    { earlierMessage: true, outputCount: 2, restart: true }
  ])(
    'publishes durably attached pending Versions: %j',
    async ({ earlierMessage, outputCount, restart }) => {
      const { versions, coordinator, handlers, resources, request } = await prepareAttachedRecovery(
        outputCount,
        earlierMessage
      )
      const first = versions[0]
      const identity = {
        projectId: PROJECT_ID,
        source: 'artifact' as const,
        fileId: first.artifactId
      }
      const unavailable = {
        code: 'VERSION_NOT_FOUND',
        message: 'Managed file has no published version.'
      }
      await expect(handlers.readPreview({ path: first.path, ...identity })).rejects.toMatchObject(
        unavailable
      )
      await expect(resources.acquire(1, identity)).rejects.toMatchObject(unavailable)
      if (restart) {
        await coordinator.loadAll()
        await expect(
          handlers.readPreview({ path: first.path, ...identity, encoding: 'base64' })
        ).resolves.toMatchObject({ content: createPngBytes('recovered bytes').toString('base64') })
      }
      const recovered = await coordinator.retryArtifactFinalization(request)
      expect(recovered?.artifacts.map((artifact) => artifact.versionId).sort()).toEqual(
        versions.map((version) => version.versionId).sort()
      )
      await expect(coordinator.retryArtifactFinalization(request)).resolves.toEqual(recovered)
      for (const version of versions) {
        await expect(
          client.artifactLineage.findUniqueOrThrow({ where: { id: version.artifactId } })
        ).resolves.toMatchObject({ currentVersionId: version.versionId })
        await expect(
          client.artifactVersion.findUniqueOrThrow({ where: { id: version.versionId } })
        ).resolves.toMatchObject({
          state: 'finalized',
          messageId: 'message-1',
          managedVisibleAt: expect.any(Date)
        })
        const expected = createPngBytes('recovered bytes')
        for (const versionId of [undefined, version.versionId]) {
          await expect(
            handlers.readPreview({
              path: version.path,
              projectId: PROJECT_ID,
              fileId: version.artifactId,
              versionId,
              encoding: 'base64'
            })
          ).resolves.toMatchObject({ content: expected.toString('base64'), truncated: false })
          const resource = await resources.acquire(1, {
            projectId: PROJECT_ID,
            source: 'artifact',
            fileId: version.artifactId,
            versionId
          })
          try {
            const range = await resources.readRange(1, {
              resourceId: resource.id,
              begin: 0,
              end: expected.length
            })
            expect(Buffer.from(range.data)).toEqual(expected)
          } finally {
            resources.release(1, { resourceId: resource.id })
          }
        }
      }
    }
  )

  it.each([
    'missing-metadata',
    'partial-run',
    'competing-owner',
    'missing-projection',
    'later-turn'
  ] as const)('keeps ambiguous recovery unpublished with %s', async (scenario) => {
    const { session, versions, provenance, compatibility } = await prepareAttachedRecovery(2)
    const graph = session.conversationGraph!
    const owner = graph.messages.find((message) => message.id === 'message-1')!
    if (scenario === 'missing-metadata') session.artifacts = []
    if (scenario === 'partial-run') {
      owner.artifactIds = [versions[0].versionId]
      session.messages.at(-1)!.artifactIds = owner.artifactIds
    }
    if (scenario === 'competing-owner') graph.messages[1].artifactIds = [versions[0].versionId]
    if (scenario === 'missing-projection') session.messages.at(-1)!.artifactIds = []
    if (scenario === 'later-turn') {
      graph.messages.push(
        {
          ...owner,
          id: 'next-prompt',
          role: 'user',
          status: 'complete',
          artifactIds: undefined,
          revisionRootMessageId: 'next-prompt',
          parentMessageId: owner.id
        },
        {
          ...owner,
          id: 'later-owner',
          revisionRootMessageId: 'later-owner',
          parentMessageId: 'next-prompt'
        }
      )
      graph.branches[0].headMessageId = 'later-owner'
      owner.artifactIds = []
      session.messages.at(-1)!.artifactIds = []
    }
    const result = await provenance.reconcileSession(PROJECT_ID, SESSION_ID, session)
    expect(result.unresolvedNativeFinalizationRunIds).toContain(RUN_ID)
    for (const version of versions) {
      await expect(
        client.artifactLineage.findUniqueOrThrow({ where: { id: version.artifactId } })
      ).resolves.toMatchObject({ currentVersionId: null })
    }
    for (const version of versions) {
      await expect(
        client.artifactVersion.findUniqueOrThrow({ where: { id: version.versionId } })
      ).resolves.toMatchObject({ state: 'pending', messageId: null, managedVisibleAt: null })
    }
    const pending = await compatibility.listPendingRunFiles({
      projectId: PROJECT_ID,
      sessionId: STORAGE_SESSION_ID,
      runId: RUN_ID
    })
    expect(pending).toHaveLength(2)
    for (const file of pending)
      expect(await readFile(file.path)).toEqual(createPngBytes('recovered bytes'))
  })

  it('uses the attached owner even when another assistant message follows it', async () => {
    const { session, coordinator, request, versions } = await prepareAttachedRecovery()
    const ownerId = 'assistant-preface'
    for (const message of [...session.messages, ...session.conversationGraph!.messages]) {
      message.artifactIds = message.id === ownerId ? [versions[0].versionId] : undefined
    }
    await sessions.saveSession(session)
    await expect(
      coordinator.retryArtifactFinalization({ ...request, messageId: ownerId })
    ).resolves.toMatchObject({
      artifacts: [expect.objectContaining({ versionId: versions[0].versionId })]
    })
    await expect(
      client.artifactVersion.findUniqueOrThrow({ where: { id: versions[0].versionId } })
    ).resolves.toMatchObject({ messageId: ownerId, state: 'finalized' })
  })

  it.each([false, true])(
    'recovers an inactive Branch unless another Branch claims its Version: %s',
    async (competingClaim) => {
      const { session, versions, provenance } = await prepareAttachedRecovery()
      const graph = session.conversationGraph!
      const activeBranchId = 'other-branch'
      const activeMessage = {
        id: 'other-message',
        role: 'user' as const,
        content: 'other branch',
        status: 'complete' as const,
        eventIds: [],
        createdAt: 3,
        updatedAt: 3,
        artifactIds: competingClaim ? [versions[0].versionId] : undefined
      }
      graph.frames[0].activeBranchId = activeBranchId
      graph.branches.push({
        id: activeBranchId,
        agentFrameId: graph.rootFrameId,
        headMessageId: activeMessage.id,
        createdAt: 3,
        updatedAt: 3
      })
      graph.messages.push({
        ...activeMessage,
        agentFrameId: graph.rootFrameId,
        introducedOnBranchId: activeBranchId,
        revisionRootMessageId: activeMessage.id,
        runtimeSegmentId: graph.runtimeSegments[0].id
      })
      session.messages = [activeMessage]
      await sessions.saveSession(session)
      const durable = (await sessions.loadSession(PROJECT_ID, SESSION_ID))!
      const result = await provenance.reconcileSession(PROJECT_ID, SESSION_ID, durable)
      expect(result.unresolvedNativeFinalizationRunIds).toEqual(competingClaim ? [RUN_ID] : [])
      await expect(
        client.artifactVersion.findUniqueOrThrow({ where: { id: versions[0].versionId } })
      ).resolves.toMatchObject(
        competingClaim
          ? { state: 'pending', messageId: null, managedVisibleAt: null }
          : { state: 'finalized', messageId: 'message-1', managedVisibleAt: expect.any(Date) }
      )
    }
  )

  it('retains exact marker Version-set validation after resolving the durable owner', async () => {
    const { coordinator, request, versions } = await prepareAttachedRecovery(2)
    const markerPath = join(
      storageRoot,
      'artifacts',
      PROJECT_ID,
      STORAGE_SESSION_ID,
      '.runs',
      `${RUN_ID}.json`
    )
    const marker = JSON.parse(await readFile(markerPath, 'utf8'))
    await writeFile(
      markerPath,
      JSON.stringify({ ...marker, artifactVersionIds: [versions[0].versionId] })
    )
    await expect(coordinator.retryArtifactFinalization(request)).rejects.toMatchObject({
      code: ARTIFACT_FINALIZATION_INVALID_PROOF
    })
    for (const version of versions) {
      await expect(
        client.artifactVersion.findUniqueOrThrow({ where: { id: version.versionId } })
      ).resolves.toMatchObject({ state: 'pending', messageId: null, managedVisibleAt: null })
    }
  })

  it('retries the multi-message run after its durable attachment arrives', async () => {
    const { session, versions, coordinator, request } = await prepareAttachedRecovery()
    const linked = structuredClone(session)
    session.artifacts = []
    for (const message of [...session.messages, ...session.conversationGraph!.messages])
      message.artifactIds = []
    await sessions.saveSession(session)
    await expect(coordinator.retryArtifactFinalization(request)).rejects.toThrow(
      'Native Artifact finalization remains unresolved.'
    )
    await sessions.saveSession(linked)
    await expect(coordinator.retryArtifactFinalization(request)).resolves.toMatchObject({
      artifacts: [expect.objectContaining({ versionId: versions[0].versionId })]
    })
  })

  it('replays an explicitly requested finalized Version that is already linked', async () => {
    const compatibility = new ArtifactRepository(storageRoot)
    const { provenance, version } = await prepareRecovery(compatibility)
    await client.artifactVersion.update({
      where: { id: version.versionId },
      data: { state: 'finalized', messageId: 'message-1' }
    })
    const linked = (await sessions.loadSession(PROJECT_ID, SESSION_ID))!
    linked.messages[1] = {
      ...linked.messages[1],
      status: 'complete',
      artifactIds: [version.versionId]
    }
    const graphMessage = linked.conversationGraph?.messages.find(
      (message) => message.id === 'message-1'
    )
    if (graphMessage) {
      graphMessage.status = 'complete'
      graphMessage.artifactIds = [version.versionId]
    }
    linked.artifacts = [
      {
        id: version.versionId,
        artifactId: version.artifactId,
        versionId: version.versionId,
        versionNumber: version.versionNumber,
        kind: 'managed-file',
        path: version.path,
        fileUrl: version.fileUrl,
        name: version.name,
        mimeType: version.mimeType,
        size: version.size,
        createdAt: Date.parse(version.createdAt),
        mtimeMs: version.mtimeMs,
        sha256: version.checksum
      }
    ]
    await sessions.saveSession(linked)
    const coordinator = new SessionPersistenceCoordinator(
      sessions,
      files,
      undefined,
      undefined,
      undefined,
      provenance
    )

    await expect(
      coordinator.retryArtifactFinalization({
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
        messageId: 'message-1',
        pendingPaths: [],
        artifactVersionIds: [version.versionId]
      })
    ).resolves.toMatchObject({
      artifacts: [expect.objectContaining({ versionId: version.versionId })],
      nativeRunIds: [RUN_ID]
    })
    await expect(
      compatibility.listPendingRunFiles({
        projectId: PROJECT_ID,
        sessionId: STORAGE_SESSION_ID,
        runId: RUN_ID
      })
    ).resolves.toEqual([])
    await expect(
      client.artifactLineage.findUniqueOrThrow({ where: { id: version.artifactId } })
    ).resolves.toMatchObject({ currentVersionId: version.versionId })
  })

  it('persists an inspectable Message snapshot with the recovered Session attachment', async () => {
    const compatibility = new ArtifactRepository(storageRoot)
    const { provenance, version } = await prepareRecovery(compatibility)
    const snapshots = new ProvenanceMessageSnapshotRepository({
      storageRoot,
      getClient: () => Promise.resolve(client)
    })
    const coordinator = new SessionPersistenceCoordinator(
      sessions,
      files,
      undefined,
      snapshots,
      undefined,
      provenance
    )

    const loaded = await coordinator.loadAll()

    expect(loaded.sessions[0].messages[1].artifactIds).toEqual([version.versionId])
    await expect(sessions.loadSession(PROJECT_ID, SESSION_ID)).resolves.toMatchObject({
      messages: [expect.anything(), { artifactIds: [version.versionId] }],
      artifacts: [expect.objectContaining({ id: version.versionId })]
    })
    await expect(
      client.artifactVersion.findUniqueOrThrow({ where: { id: version.versionId } })
    ).resolves.toMatchObject({ messageSnapshotId: expect.any(String) })
    await expect(
      provenance.getVersionMessages({
        projectId: PROJECT_ID,
        appSessionId: SESSION_ID,
        artifactId: version.artifactId,
        versionId: version.versionId
      })
    ).resolves.toMatchObject({
      messages: {
        state: 'available',
        items: expect.arrayContaining([expect.objectContaining({ id: 'message-1' })])
      }
    })
  })

  it('repairs a missing ready Message snapshot after restoring its Session artifact attachment', async () => {
    const compatibility = new ArtifactRepository(storageRoot)
    const prepared = await prepareRecovery(compatibility)
    const originalSession = (await sessions.loadSession(PROJECT_ID, SESSION_ID))!
    const snapshots = new ProvenanceMessageSnapshotRepository({
      storageRoot,
      getClient: () => Promise.resolve(client)
    })
    const coordinator = new SessionPersistenceCoordinator(
      sessions,
      files,
      undefined,
      snapshots,
      undefined,
      prepared.provenance
    )

    await coordinator.loadAll()
    const snapshot = await client.artifactMessageSnapshot.findFirstOrThrow({
      where: { projectId: PROJECT_ID, sessionId: SESSION_ID, state: 'ready' }
    })
    await rm(join(storageRoot, ...snapshot.storageKey.split('/')))
    // Model a crash after the snapshot and Artifact Version commit but before recovered artifact
    // metadata reached Session JSON.
    await sessions.saveSession(originalSession)

    const recovered = await coordinator.loadAll()

    expect(recovered.sessions[0].messages[1].artifactIds).toEqual([prepared.version.versionId])
    await expect(
      prepared.provenance.getVersionMessages({
        projectId: PROJECT_ID,
        appSessionId: SESSION_ID,
        artifactId: prepared.version.artifactId,
        versionId: prepared.version.versionId
      })
    ).resolves.toMatchObject({ messages: { state: 'available' } })
  })

  it('moves pending compatibility bytes when a bound marker survived without its file move', async () => {
    const compatibility = new ArtifactRepository(storageRoot)
    const { provenance, context, version } = await prepareRecovery(compatibility)
    // Legacy markers from before exact-set publication remain recoverable from the whole DB run.
    await writeFile(
      join(storageRoot, 'artifacts', PROJECT_ID, STORAGE_SESSION_ID, '.runs', `${RUN_ID}.json`),
      `${JSON.stringify({ sessionId: SESSION_ID, messageId: 'message-1', provenanceContext: context })}\n`,
      'utf8'
    )
    const coordinator = new SessionPersistenceCoordinator(
      sessions,
      files,
      undefined,
      undefined,
      undefined,
      provenance
    )

    await coordinator.loadAll()

    await expect(
      compatibility.listPendingRunFiles({
        projectId: PROJECT_ID,
        sessionId: STORAGE_SESSION_ID,
        runId: RUN_ID
      })
    ).resolves.toEqual([])
    await expect(
      compatibility.listMessageFiles({
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
        messageId: 'message-1'
      })
    ).resolves.toEqual([expect.objectContaining({ name: 'result.png' })])
    await expect(
      compatibility.findRunFinalizationMarker(PROJECT_ID, RUN_ID)
    ).resolves.toMatchObject({ artifactVersionIds: [version.versionId] })
  })

  it('keeps pending compatibility bytes in place when execution proof is corrupt', async () => {
    const compatibility = new ArtifactRepository(storageRoot)
    const { provenance, version } = await prepareRecovery(compatibility)
    await client.artifactVersion.update({
      where: { id: version.versionId },
      data: {
        executionSnapshotJson: '{"schemaVersion":2}',
        executionSnapshotChecksum: '0'.repeat(64),
        executionSnapshotStorageKey: 'corrupt-execution.json',
        executionSnapshotSchemaVersion: 2
      }
    })
    const coordinator = new SessionPersistenceCoordinator(
      sessions,
      files,
      undefined,
      undefined,
      undefined,
      provenance
    )

    const loaded = await coordinator.loadAll()

    expect(loaded.sessions[0].messages[1].artifactIds).toBeUndefined()
    expect(loaded.sessions[0].artifacts).toBeUndefined()
    await expect(
      coordinator.retryArtifactFinalization({
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
        messageId: 'message-1',
        pendingPaths: [
          join(
            storageRoot,
            'artifacts',
            PROJECT_ID,
            STORAGE_SESSION_ID,
            '.pending',
            RUN_ID,
            'result.png'
          )
        ]
      })
    ).rejects.toMatchObject({ code: ARTIFACT_FINALIZATION_INVALID_PROOF })
    await expect(
      compatibility.findRunFinalizationMarker(PROJECT_ID, RUN_ID)
    ).resolves.toMatchObject({
      sourceSessionId: STORAGE_SESSION_ID,
      sessionId: SESSION_ID
    })
    await expect(
      compatibility.findRunFinalizationMarker(PROJECT_ID, RUN_ID)
    ).resolves.not.toHaveProperty('messageId')
    await expect(
      compatibility.listPendingRunFiles({
        projectId: PROJECT_ID,
        sessionId: STORAGE_SESSION_ID,
        runId: RUN_ID
      })
    ).resolves.toEqual([expect.objectContaining({ name: 'result.png' })])
    await expect(
      compatibility.listMessageFiles({
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
        messageId: 'message-1'
      })
    ).resolves.toEqual([])
    await expect(
      client.artifactVersion.findUniqueOrThrow({ where: { id: version.versionId } })
    ).resolves.toMatchObject({ state: 'pending', messageId: null })
  })

  it('leaves an unmarked compatibility publication ownerless', async () => {
    const compatibility = new ArtifactRepository(storageRoot)
    const { provenance, version } = await prepareRecovery(compatibility)
    await rm(
      join(storageRoot, 'artifacts', PROJECT_ID, STORAGE_SESSION_ID, '.runs', `${RUN_ID}.json`)
    )
    const coordinator = new SessionPersistenceCoordinator(
      sessions,
      files,
      undefined,
      undefined,
      undefined,
      provenance
    )

    const loaded = await coordinator.loadAll()

    expect(loaded.sessions[0].messages[1].artifactIds).toBeUndefined()
    await expect(
      compatibility.listPendingRunFiles({
        projectId: PROJECT_ID,
        sessionId: STORAGE_SESSION_ID,
        runId: RUN_ID
      })
    ).resolves.toEqual([expect.objectContaining({ name: 'result.png' })])
    await expect(
      client.artifactVersion.findUniqueOrThrow({ where: { id: version.versionId } })
    ).resolves.toMatchObject({ state: 'pending', messageId: null })
  })

  it('leaves a compatibility publication without DB authority ownerless', async () => {
    const compatibility = new ArtifactRepository(storageRoot)
    const { provenance, version } = await prepareRecovery(compatibility)
    await client.artifactVersion.delete({ where: { id: version.versionId } })
    await rm(dirname(version.path), { recursive: true, force: true })
    const coordinator = new SessionPersistenceCoordinator(
      sessions,
      files,
      undefined,
      undefined,
      undefined,
      provenance
    )

    const loaded = await coordinator.loadAll()

    expect(loaded.sessions[0].messages[1].artifactIds).toBeUndefined()
    await expect(
      compatibility.listPendingRunFiles({
        projectId: PROJECT_ID,
        sessionId: STORAGE_SESSION_ID,
        runId: RUN_ID
      })
    ).resolves.toEqual([expect.objectContaining({ name: 'result.png' })])
    await expect(
      client.artifactVersion.findUnique({ where: { id: version.versionId } })
    ).resolves.toBeNull()
  })

  it('keeps pending bytes in place when producer evidence is available but its snapshot is missing', async () => {
    const compatibility = new ArtifactRepository(storageRoot)
    const { provenance, version } = await prepareRecovery(compatibility)
    const persisted = requireAgentArtifactVersion(
      await client.artifactVersion.findUniqueOrThrow({ where: { id: version.versionId } })
    )
    const evidence = JSON.stringify({
      ...(JSON.parse(persisted.evidenceJson) as object),
      producer: { state: 'available' }
    })
    await client.artifactVersion.update({
      where: { id: version.versionId },
      data: {
        evidenceJson: evidence,
        evidenceChecksum: createHash('sha256').update(evidence).digest('hex'),
        notebookSessionId: null,
        producerRunId: null,
        producerRunIndex: null,
        executionSnapshotJson: null,
        executionSnapshotChecksum: null,
        executionSnapshotStorageKey: null,
        executionSnapshotSchemaVersion: null
      }
    })
    const coordinator = new SessionPersistenceCoordinator(
      sessions,
      files,
      undefined,
      undefined,
      undefined,
      provenance
    )

    const loaded = await coordinator.loadAll()

    expect(loaded.sessions[0].messages[1].artifactIds).toBeUndefined()
    await expect(
      compatibility.listPendingRunFiles({
        projectId: PROJECT_ID,
        sessionId: STORAGE_SESSION_ID,
        runId: RUN_ID
      })
    ).resolves.toEqual([expect.objectContaining({ name: 'result.png' })])
    await expect(
      client.artifactVersion.findUniqueOrThrow({ where: { id: version.versionId } })
    ).resolves.toMatchObject({ state: 'pending', messageId: null })

    // Even with unavailable producer evidence, a corrupt persisted snapshot bundle must not be
    // interpreted as the legitimate no-producer case.
    await client.artifactVersion.update({
      where: { id: version.versionId },
      data: {
        evidenceJson: persisted.evidenceJson,
        evidenceChecksum: persisted.evidenceChecksum,
        executionSnapshotJson: '{}',
        executionSnapshotChecksum: '0'.repeat(64),
        executionSnapshotStorageKey: 'missing-execution.json',
        executionSnapshotSchemaVersion: 2
      }
    })
    await coordinator.loadAll()
    await expect(
      client.artifactVersion.findUniqueOrThrow({ where: { id: version.versionId } })
    ).resolves.toMatchObject({ state: 'pending', messageId: null })

    const malformedEvidence = JSON.parse(persisted.evidenceJson) as Record<string, unknown>
    delete malformedEvidence.execution_status
    const malformedEvidenceJson = JSON.stringify(malformedEvidence)
    await client.artifactVersion.update({
      where: { id: version.versionId },
      data: {
        evidenceJson: malformedEvidenceJson,
        evidenceChecksum: createHash('sha256').update(malformedEvidenceJson).digest('hex'),
        executionSnapshotJson: null,
        executionSnapshotChecksum: null,
        executionSnapshotStorageKey: null,
        executionSnapshotSchemaVersion: null
      }
    })
    await coordinator.loadAll()
    await expect(
      client.artifactVersion.findUniqueOrThrow({ where: { id: version.versionId } })
    ).resolves.toMatchObject({ state: 'pending', messageId: null })
  })

  it('replays a finalized-but-unlinked Version after compatibility finalization recovers', async () => {
    let failDirectorySync = false
    const compatibility = new ArtifactRepository(storageRoot, {
      syncFile: async () => undefined,
      syncDirectory: async () => {
        if (failDirectorySync) throw new Error('compatibility storage is read-only')
      }
    })
    const { provenance, version } = await prepareRecovery(compatibility)
    failDirectorySync = true
    const coordinator = new SessionPersistenceCoordinator(
      sessions,
      files,
      undefined,
      undefined,
      undefined,
      provenance
    )

    const first = await coordinator.loadAll()

    expect(first.sessions[0].messages[1].artifactIds).toBeUndefined()
    await expect(files.getOverview(PROJECT_ID)).resolves.toMatchObject({
      artifactCount: 0,
      isIndexComplete: false
    })
    await expect(
      client.artifactVersion.findUniqueOrThrow({ where: { id: version.versionId } })
    ).resolves.toMatchObject({ state: 'finalized', messageId: 'message-1' })
    await expect(
      compatibility.listPendingRunFiles({
        projectId: PROJECT_ID,
        sessionId: STORAGE_SESSION_ID,
        runId: RUN_ID
      })
    ).resolves.toEqual([expect.objectContaining({ name: 'result.png' })])

    failDirectorySync = false
    const retried = await coordinator.loadAll()

    expect(retried.sessions[0].messages[1].artifactIds).toEqual([version.versionId])
    await expect(
      compatibility.listPendingRunFiles({
        projectId: PROJECT_ID,
        sessionId: STORAGE_SESSION_ID,
        runId: RUN_ID
      })
    ).resolves.toEqual([])
    await expect(
      compatibility.listMessageFiles({
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
        messageId: 'message-1'
      })
    ).resolves.toEqual([expect.objectContaining({ name: 'result.png' })])
  })

  it('keeps an existing Files tile on its visible head until compatibility finalization succeeds', async () => {
    let failDirectorySync = false
    const compatibility = new ArtifactRepository(storageRoot, {
      syncFile: async () => undefined,
      syncDirectory: async () => {
        if (failDirectorySync) throw new Error('compatibility storage is read-only')
      }
    })
    const visibleBytes = Buffer.from('previous visible artifact')
    const visibleVersionId = 'artifact-visible-v1'
    const visibleStorageKey =
      'artifacts/project-1/session-1/.provenance/artifact-visible/versions/artifact-visible-v1/content'
    const visiblePath = join(storageRoot, ...visibleStorageKey.split('/'))
    await mkdir(dirname(visiblePath), { recursive: true })
    await writeFile(visiblePath, visibleBytes)
    // Seed the visible Version before the real writer allocates the pending Version.
    const artifactId = 'existing-artifact'
    await client.fileOriginSession.create({
      data: { projectId: PROJECT_ID, sessionId: SESSION_ID }
    })
    await client.artifactLineage.create({
      data: {
        id: artifactId,
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
        filename: 'result.png',
        normalizedFilename: 'result.png'
      }
    })
    await client.artifactVersion.create({
      data: {
        id: visibleVersionId,
        artifactId,
        versionNumber: 1,
        filename: 'result.png',
        originKind: 'legacy',
        state: 'finalized',
        contentStorageKey: visibleStorageKey,
        sizeBytes: BigInt(visibleBytes.byteLength),
        checksum: createHash('sha256').update(visibleBytes).digest('hex')
      }
    })
    await client.artifactLineage.update({
      where: { id: artifactId },
      data: { currentVersionId: visibleVersionId }
    })
    const { provenance, version } = await prepareRecovery(compatibility)
    expect(version.versionNumber).toBe(2)
    await client.managedFile.create({
      data: {
        source: 'artifact',
        sourceFileId: version.artifactId,
        sourceVersionId: visibleVersionId,
        checksum: createHash('sha256').update(visibleBytes).digest('hex'),
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
        displayName: 'result.png',
        storageKey: visibleStorageKey,
        sizeBytes: BigInt(visibleBytes.byteLength),
        mtimeMs: BigInt(1),
        sortAtMs: BigInt(1)
      }
    })
    failDirectorySync = true
    const coordinator = new SessionPersistenceCoordinator(
      sessions,
      files,
      undefined,
      undefined,
      undefined,
      provenance
    )

    await coordinator.loadAll()

    await expect(
      client.artifactLineage.findUniqueOrThrow({ where: { id: version.artifactId } })
    ).resolves.toMatchObject({ currentVersionId: visibleVersionId })
    await expect(
      client.managedFile.findUniqueOrThrow({
        where: {
          projectId_source_sourceFileId: {
            projectId: PROJECT_ID,
            source: 'artifact',
            sourceFileId: version.artifactId
          }
        }
      })
    ).resolves.toMatchObject({ sourceVersionId: visibleVersionId })

    failDirectorySync = false
    await coordinator.loadAll()

    await expect(
      client.artifactLineage.findUniqueOrThrow({ where: { id: version.artifactId } })
    ).resolves.toMatchObject({ currentVersionId: version.versionId })
    await expect(
      client.managedFile.findUniqueOrThrow({
        where: {
          projectId_source_sourceFileId: {
            projectId: PROJECT_ID,
            source: 'artifact',
            sourceFileId: version.artifactId
          }
        }
      })
    ).resolves.toMatchObject({ sourceVersionId: version.versionId })
  })

  it('moves compatibility bytes for a finalized Version already linked to the active Message', async () => {
    const compatibility = new ArtifactRepository(storageRoot)
    const { provenance, version, context } = await prepareRecovery(compatibility)
    await finalizeAndLinkVersion({ provenance, version, context })
    const coordinator = new SessionPersistenceCoordinator(
      sessions,
      files,
      undefined,
      undefined,
      undefined,
      provenance
    )

    await coordinator.loadAll()

    await expect(
      compatibility.listPendingRunFiles({
        projectId: PROJECT_ID,
        sessionId: STORAGE_SESSION_ID,
        runId: RUN_ID
      })
    ).resolves.toEqual([])
    await expect(
      compatibility.listMessageFiles({
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
        messageId: 'message-1'
      })
    ).resolves.toEqual([expect.objectContaining({ name: 'result.png' })])
  })

  it('moves compatibility metadata left pending after its byte reached the Message directory', async () => {
    const compatibility = new ArtifactRepository(storageRoot)
    const { provenance, version, context } = await prepareRecovery(compatibility)
    await finalizeAndLinkVersion({ provenance, version, context })
    const [pending] = await compatibility.listPendingRunFiles({
      projectId: PROJECT_ID,
      sessionId: STORAGE_SESSION_ID,
      runId: RUN_ID
    })
    const messageDirectory = join(storageRoot, 'artifacts', PROJECT_ID, SESSION_ID, 'message-1')
    await mkdir(messageDirectory, { recursive: true })
    await rename(pending.path, join(messageDirectory, pending.name))
    await expect(
      compatibility.listMessageFiles({
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
        messageId: 'message-1'
      })
    ).resolves.toEqual([expect.not.objectContaining({ versionId: version.versionId })])
    const coordinator = new SessionPersistenceCoordinator(
      sessions,
      files,
      undefined,
      undefined,
      undefined,
      provenance
    )

    await coordinator.loadAll()

    await expect(
      compatibility.listMessageFiles({
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
        messageId: 'message-1'
      })
    ).resolves.toEqual([
      expect.objectContaining({ name: 'result.png', versionId: version.versionId })
    ])
  })

  it('moves compatibility bytes for a finalized Version linked only on an inactive Branch', async () => {
    const compatibility = new ArtifactRepository(storageRoot)
    const { provenance, version, context } = await prepareRecovery(compatibility)
    await finalizeAndLinkVersion({ provenance, version, context, makeLinkedMessageInactive: true })
    const coordinator = new SessionPersistenceCoordinator(
      sessions,
      files,
      undefined,
      undefined,
      undefined,
      provenance
    )

    const loaded = await coordinator.loadAll()

    expect(loaded.sessions[0].messages).not.toContainEqual(
      expect.objectContaining({ id: 'message-1' })
    )
    expect(
      loaded.sessions[0].conversationGraph?.messages.find(({ id }) => id === 'message-1')
        ?.artifactIds
    ).toEqual([version.versionId])
    await expect(
      compatibility.listPendingRunFiles({
        projectId: PROJECT_ID,
        sessionId: STORAGE_SESSION_ID,
        runId: RUN_ID
      })
    ).resolves.toEqual([])
    await expect(
      compatibility.listMessageFiles({
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
        messageId: 'message-1'
      })
    ).resolves.toEqual([expect.objectContaining({ name: 'result.png' })])
  })

  it('reuses explicit Project reconciliation discovery across Session reconciliation calls', async () => {
    const compatibility = new ArtifactRepository(storageRoot)
    const { provenance } = await prepareRecovery(compatibility)
    const discover = vi.spyOn(compatibility, 'listPendingRunPublications')
    const durableSession = await sessions.loadSession(PROJECT_ID, SESSION_ID)
    if (!durableSession) throw new Error('Recovery fixture Session is missing.')
    const projectReconciliation = await provenance.prepareProjectReconciliation(PROJECT_ID)

    await provenance.reconcileSession(PROJECT_ID, SESSION_ID, durableSession, {
      projectReconciliation
    })
    await provenance.reconcileSession(PROJECT_ID, SESSION_ID, durableSession, {
      projectReconciliation
    })

    expect(discover).toHaveBeenCalledOnce()
  })

  it('performs fresh publication discovery for direct reconciliation calls', async () => {
    const compatibility = new ArtifactRepository(storageRoot)
    const { provenance } = await prepareRecovery(compatibility)
    const discover = vi.spyOn(compatibility, 'listPendingRunPublications')
    const durableSession = await sessions.loadSession(PROJECT_ID, SESSION_ID)
    if (!durableSession) throw new Error('Recovery fixture Session is missing.')

    await provenance.reconcileSession(PROJECT_ID, SESSION_ID, durableSession)
    await provenance.reconcileSession(PROJECT_ID, SESSION_ID, durableSession)

    expect(discover).toHaveBeenCalledTimes(2)
  })

  it('recovers a pending Version when another Version from the same run is already linked', async () => {
    const compatibility = new ArtifactRepository(storageRoot)
    const { provenance, version: linkedVersion, context } = await prepareRecovery(compatibility)
    const coordinator = new SessionPersistenceCoordinator(
      sessions,
      files,
      undefined,
      undefined,
      undefined,
      provenance
    )
    await coordinator.loadAll()

    await compatibility.writePendingFile({
      projectId: PROJECT_ID,
      sessionId: STORAGE_SESSION_ID,
      runId: RUN_ID,
      filename: 'second.png',
      source: createPngInlineSource('second recovered bytes')
    })
    const pendingVersion = await provenance.createVersion({
      projectId: PROJECT_ID,
      appSessionId: SESSION_ID,
      artifactStorageSessionId: STORAGE_SESSION_ID,
      artifactRunId: RUN_ID,
      writeOperationId: 'write-2',
      writeRequestChecksum: 'b'.repeat(64),
      ...context,
      filename: 'second.png'
    })

    // The new Version appeared after the prepared marker froze its exact set. Recovery must not
    // silently recompute a wider claim from SQLite.
    const withheld = await coordinator.loadAll()
    expect(withheld.sessions[0].messages[1].artifactIds).toEqual([linkedVersion.versionId])
    await expect(
      client.artifactVersion.findUniqueOrThrow({ where: { id: pendingVersion.versionId } })
    ).resolves.toMatchObject({ state: 'pending', messageId: null })

    // Model the valid partial-link crash state: the durable marker originally froze both Versions,
    // while Session JSON persisted only the first attachment before the process exited.
    await writeFile(
      join(storageRoot, 'artifacts', PROJECT_ID, STORAGE_SESSION_ID, '.runs', `${RUN_ID}.json`),
      `${JSON.stringify({
        sessionId: SESSION_ID,
        messageId: 'message-1',
        artifactVersionIds: [linkedVersion.versionId, pendingVersion.versionId].sort(),
        provenanceContext: context
      })}\n`,
      'utf8'
    )
    const recovered = await coordinator.loadAll()

    expect(recovered.sessions[0].messages[1].artifactIds).toEqual([
      linkedVersion.versionId,
      pendingVersion.versionId
    ])
    await expect(
      client.artifactVersion.findUniqueOrThrow({ where: { id: pendingVersion.versionId } })
    ).resolves.toMatchObject({ state: 'finalized', messageId: 'message-1' })
  })

  it('marks Files incomplete when a run marker cannot be read from storage', async () => {
    let failMarkerRead = false
    const compatibility = new ArtifactRepository(storageRoot, {
      syncFile: async () => undefined,
      syncDirectory: async () => undefined,
      readMarkerFile: async (path) => {
        if (failMarkerRead && path.endsWith(`${RUN_ID}.json`)) {
          throw Object.assign(new Error('marker read failed'), { code: 'EIO' })
        }
        return readFile(path, 'utf8')
      }
    })
    const { provenance, version } = await prepareRecovery(compatibility)
    failMarkerRead = true
    const coordinator = new SessionPersistenceCoordinator(
      sessions,
      files,
      undefined,
      undefined,
      undefined,
      provenance
    )

    const loaded = await coordinator.loadAll()

    expect(loaded.sessions[0].messages[1].artifactIds).toBeUndefined()
    await expect(files.getOverview(PROJECT_ID)).resolves.toMatchObject({
      artifactCount: 0,
      isIndexComplete: false
    })
    await expect(
      client.artifactVersion.findUniqueOrThrow({ where: { id: version.versionId } })
    ).resolves.toMatchObject({ state: 'pending', messageId: null })
  })

  const finalizeAndLinkVersion = async (input: {
    provenance: ArtifactProvenanceRepository
    version: Awaited<ReturnType<ArtifactProvenanceRepository['createVersion']>>
    context: {
      rootFrameId: string
      agentFrameId: string
      messageBranchId: string
      runtimeSegmentId: string
      promptMessageId: string
    }
    makeLinkedMessageInactive?: boolean
  }): Promise<void> => {
    const [finalized] = await input.provenance.finalizeRun({
      projectId: PROJECT_ID,
      appSessionId: SESSION_ID,
      artifactRunId: RUN_ID,
      artifactVersionIds: [input.version.versionId],
      ...input.context,
      messageId: 'message-1'
    })
    const session = await sessions.loadSession(PROJECT_ID, SESSION_ID)
    if (!session?.conversationGraph) throw new Error('Recovery fixture Session graph is missing.')
    const linkMessage = <T extends { id: string; artifactIds?: string[] }>(message: T): T =>
      message.id === 'message-1' ? { ...message, artifactIds: [input.version.versionId] } : message
    const activeBranchId = 'message-branch-active-replacement'
    const activeMessage = {
      id: 'active-replacement-prompt',
      role: 'user' as const,
      content: 'continue on another branch',
      status: 'complete' as const,
      eventIds: [],
      createdAt: 3,
      updatedAt: 3
    }
    const conversationGraph = input.makeLinkedMessageInactive
      ? {
          ...session.conversationGraph,
          frames: session.conversationGraph.frames.map((frame) =>
            frame.id === session.conversationGraph!.rootFrameId
              ? { ...frame, activeBranchId }
              : frame
          ),
          branches: [
            ...session.conversationGraph.branches,
            {
              id: activeBranchId,
              agentFrameId: session.conversationGraph.rootFrameId,
              headMessageId: activeMessage.id,
              createdAt: 3,
              updatedAt: 3
            }
          ],
          messages: [
            ...session.conversationGraph.messages.map(linkMessage),
            {
              ...activeMessage,
              agentFrameId: session.conversationGraph.rootFrameId,
              introducedOnBranchId: activeBranchId,
              revisionRootMessageId: activeMessage.id,
              runtimeSegmentId: session.conversationGraph.runtimeSegments[0].id
            }
          ]
        }
      : {
          ...session.conversationGraph,
          messages: session.conversationGraph.messages.map(linkMessage)
        }
    await sessions.saveSession({
      ...session,
      messages: input.makeLinkedMessageInactive
        ? [activeMessage]
        : session.messages.map(linkMessage),
      conversationGraph,
      artifacts: [
        {
          id: finalized.versionId,
          artifactId: finalized.artifactId,
          versionId: finalized.versionId,
          versionNumber: finalized.versionNumber,
          kind: 'managed-file',
          path: finalized.path,
          fileUrl: finalized.fileUrl,
          name: finalized.name,
          mimeType: finalized.mimeType,
          size: finalized.size,
          mtimeMs: finalized.mtimeMs,
          sha256: finalized.checksum
        }
      ]
    })
    await writeFile(
      join(storageRoot, 'artifacts', PROJECT_ID, STORAGE_SESSION_ID, '.runs', `${RUN_ID}.json`),
      `${JSON.stringify({
        sessionId: SESSION_ID,
        messageId: 'message-1',
        artifactVersionIds: [input.version.versionId],
        provenanceContext: input.context
      })}\n`,
      'utf8'
    )
  }

  const prepareRecovery = async (
    compatibility: ArtifactRepository,
    outputCount = 1
  ): Promise<{
    versions: Awaited<ReturnType<ArtifactProvenanceRepository['createVersion']>>[]
    provenance: ArtifactProvenanceRepository
    version: Awaited<ReturnType<ArtifactProvenanceRepository['createVersion']>>
    context: {
      rootFrameId: string
      agentFrameId: string
      messageBranchId: string
      runtimeSegmentId: string
      promptMessageId: string
    }
  }> => {
    const provenance = new ArtifactProvenanceRepository({
      storageRoot,
      getClient: () => Promise.resolve(client),
      compatibilityRepository: compatibility,
      loadSession: (projectId, sessionId) => sessions.loadSession(projectId, sessionId)
    })
    const prompt = {
      id: 'prompt-1',
      role: 'user' as const,
      content: 'create an image',
      status: 'complete' as const,
      eventIds: [],
      createdAt: 1,
      updatedAt: 1
    }
    const message = {
      id: 'message-1',
      role: 'agent' as const,
      content: 'done',
      status: 'streaming' as const,
      eventIds: [],
      createdAt: 2,
      updatedAt: 2
    }
    const conversationGraph = createLinearConversationGraph({
      sessionId: SESSION_ID,
      messages: [prompt, message],
      frameworkId: 'codex',
      createdAt: 1,
      updatedAt: 2
    })
    const context = {
      rootFrameId: conversationGraph.rootFrameId,
      agentFrameId: conversationGraph.activeFrameId,
      messageBranchId: conversationGraph.branches[0].id,
      runtimeSegmentId: conversationGraph.runtimeSegments[0].id,
      promptMessageId: prompt.id
    }
    const versions: Awaited<ReturnType<ArtifactProvenanceRepository['createVersion']>>[] = []
    for (let index = 0; index < outputCount; index += 1) {
      const filename = index === 0 ? 'result.png' : `result-${index}.png`
      await compatibility.writePendingFile({
        projectId: PROJECT_ID,
        sessionId: STORAGE_SESSION_ID,
        runId: RUN_ID,
        filename,
        source: createPngInlineSource('recovered bytes')
      })
      versions.push(
        await provenance.createVersion({
          projectId: PROJECT_ID,
          appSessionId: SESSION_ID,
          artifactStorageSessionId: STORAGE_SESSION_ID,
          artifactRunId: RUN_ID,
          writeOperationId: `write-${index + 1}`,
          writeRequestChecksum: 'a'.repeat(64),
          ...context,
          filename
        })
      )
    }
    const version = versions[0]
    await compatibility.prepareRunFinalization({
      projectId: PROJECT_ID,
      sourceSessionId: STORAGE_SESSION_ID,
      sessionId: SESSION_ID,
      runId: RUN_ID,
      artifactVersionIds: versions.map((version) => version.versionId),
      provenanceContext: context
    })
    const session: PersistedChatSession = {
      id: SESSION_ID,
      projectId: PROJECT_ID,
      title: 'Recovery',
      cwd: '/workspace',
      status: 'idle',
      messages: [prompt, message],
      conversationGraph,
      filesRevision: 1,
      createdAt: 1,
      updatedAt: 2
    }
    await sessions.saveSession(session)
    return { provenance, version, versions, context }
  }
})
