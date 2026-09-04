import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { PrismaClient } from '@prisma/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/home/user', isPackaged: true }
}))

import { createLinearConversationGraph } from '../../shared/conversation-graph'
import { ARTIFACT_FINALIZATION_INVALID_PROOF } from '../../shared/artifacts'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { createPngInlineSource } from '../artifacts/artifact-test-fixtures'
import { ProvenanceMessageSnapshotRepository } from '../artifacts/provenance-message-snapshot'
import { ArtifactProvenanceRepository } from '../artifacts/provenance-repository'
import { requireAgentArtifactVersion } from '../artifacts/provenance-version-kind'
import { ArtifactRepository } from '../artifacts/repository'
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
    const { provenance, version } = await prepareRecovery(compatibility)
    const visibleBytes = Buffer.from('previous visible artifact')
    const visibleVersionId = 'artifact-visible-v0'
    const visibleStorageKey =
      'artifacts/project-1/session-1/.provenance/artifact-visible/versions/artifact-visible-v0/content'
    const visiblePath = join(storageRoot, ...visibleStorageKey.split('/'))
    await mkdir(dirname(visiblePath), { recursive: true })
    await writeFile(visiblePath, visibleBytes)
    await client.artifactVersion.create({
      data: {
        id: visibleVersionId,
        artifactId: version.artifactId,
        versionNumber: 0,
        filename: 'result.png',
        originKind: 'legacy',
        state: 'finalized',
        contentStorageKey: visibleStorageKey,
        sizeBytes: BigInt(visibleBytes.byteLength),
        checksum: createHash('sha256').update(visibleBytes).digest('hex')
      }
    })
    await client.artifactLineage.update({
      where: { id: version.artifactId },
      data: { currentVersionId: visibleVersionId }
    })
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
    compatibility: ArtifactRepository
  ): Promise<{
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
    await compatibility.writePendingFile({
      projectId: PROJECT_ID,
      sessionId: STORAGE_SESSION_ID,
      runId: RUN_ID,
      filename: 'result.png',
      source: createPngInlineSource('recovered bytes')
    })
    const version = await provenance.createVersion({
      projectId: PROJECT_ID,
      appSessionId: SESSION_ID,
      artifactStorageSessionId: STORAGE_SESSION_ID,
      artifactRunId: RUN_ID,
      writeOperationId: 'write-1',
      writeRequestChecksum: 'a'.repeat(64),
      ...context,
      filename: 'result.png'
    })
    await compatibility.prepareRunFinalization({
      projectId: PROJECT_ID,
      sourceSessionId: STORAGE_SESSION_ID,
      sessionId: SESSION_ID,
      runId: RUN_ID,
      artifactVersionIds: [version.versionId],
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
    return { provenance, version, context }
  }
})
