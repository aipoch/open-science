import { createHash } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  open as openFile,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  utimes,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ArtifactVersionFile } from '../../shared/artifact-provenance'
import { createLinearConversationGraph } from '../../shared/conversation-graph'
import type { NotebookEnvironmentManifest } from '../../shared/notebook'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { createFrameNotebookLane } from '../notebook/lane-identity'
import { NotebookRunRepository } from '../notebook/repository'
import { createPngBytes, createPngInlineSource } from './artifact-test-fixtures'
import {
  ArtifactOwnershipPersistenceRaceError,
  ArtifactProvenanceRepository
} from './provenance-repository'
import { requireAgentArtifactVersion } from './provenance-version-kind'
import { ArtifactProvenanceVersionWriter } from './provenance-version-writer'
import { ArtifactRepository } from './repository'
import { ArtifactWriteBudgetOwner } from './write-budget-owner'
import {
  NodeVersionFileOperator,
  VersionFileOperatorError
} from '../managed-file-versions/version-file-operator'

let storageRoot: string | undefined
let disconnect: (() => Promise<void>) | undefined

const createDeferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

afterEach(async () => {
  await disconnect?.()
  disconnect = undefined

  if (storageRoot) {
    await rm(storageRoot, { recursive: true, force: true })
    storageRoot = undefined
  }
})

describe('artifact provenance repository', () => {
  it('pages lineage history while resolving an old selected Version independently', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-lineage-history-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)
    await client.fileOriginSession.create({
      data: { projectId: 'project-1', sessionId: 'session-1' }
    })
    await client.artifactLineage.create({
      data: {
        id: 'history-file',
        projectId: 'project-1',
        sessionId: 'session-1',
        filename: 'notes.md',
        normalizedFilename: 'notes.md'
      }
    })
    await client.artifactVersion.createMany({
      data: Array.from({ length: 102 }, (_, index) => ({
        id: `history-v${index + 1}`,
        artifactId: 'history-file',
        versionNumber: index + 1,
        filename: 'notes.md',
        originKind: 'legacy',
        state: 'finalized',
        contentStorageKey: `artifacts/project-1/session-1/history-file/v${index + 1}/content`,
        sizeBytes: 0n,
        checksum: 'a'.repeat(64)
      }))
    })
    await client.artifactLineage.update({
      where: { id: 'history-file' },
      data: { currentVersionId: 'history-v102' }
    })
    const repository = new ArtifactProvenanceRepository({
      storageRoot,
      getClient: () => Promise.resolve(client)
    })
    const request = {
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactId: 'history-file',
      versionId: 'history-v1'
    }
    const first = await repository.getLineage(request)
    expect(first?.versions).toHaveLength(50)
    expect(first?.selectedVersion?.versionId).toBe('history-v1')
    expect(first?.headVersion?.versionId).toBe('history-v102')
    const second = await repository.getLineage({ ...request, cursor: first!.nextCursor })
    const last = await repository.getLineage({ ...request, cursor: second!.nextCursor })
    expect(second?.versions).toHaveLength(50)
    expect(last?.versions.map((version) => version.versionNumber)).toEqual([1, 2])
    expect(last?.nextCursor).toBeUndefined()
    expect(
      new Set(
        [...first!.versions, ...second!.versions, ...last!.versions].map(
          (version) => version.versionId
        )
      ).size
    ).toBe(102)
    await expect(
      repository.getLineage({ ...request, projectId: 'other-project' })
    ).resolves.toBeUndefined()
  })

  it('projects finalized user edits in lineage without inventing Agent provenance', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-artifact-user-edit-lineage-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)
    const repository = new ArtifactProvenanceRepository({
      storageRoot,
      getClient: () => Promise.resolve(client)
    })
    await client.fileOriginSession.create({
      data: { projectId: 'project-1', sessionId: 'session-1' }
    })
    await client.artifactLineage.create({
      data: {
        id: 'artifact-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        normalizedFilename: 'notes.md',
        filename: 'notes.md'
      }
    })
    const baseStorageKey = 'artifacts/project-1/session-1/version-1/content'
    const editStorageKey = 'artifacts/project-1/session-1/version-2/content'
    await mkdir(dirname(join(storageRoot, baseStorageKey)), { recursive: true })
    await mkdir(dirname(join(storageRoot, editStorageKey)), { recursive: true })
    await writeFile(join(storageRoot, baseStorageKey), 'base')
    await writeFile(join(storageRoot, editStorageKey), 'edited')
    await client.artifactVersion.create({
      data: {
        id: 'version-1',
        artifactId: 'artifact-1',
        versionNumber: 1,
        filename: 'notes.md',
        originKind: 'legacy',
        state: 'finalized',
        contentStorageKey: baseStorageKey,
        sizeBytes: 4n,
        checksum: 'a'.repeat(64)
      }
    })
    await client.artifactVersion.create({
      data: {
        id: 'version-2',
        artifactId: 'artifact-1',
        versionNumber: 2,
        filename: 'notes.md',
        originKind: 'user_edit',
        basedOnVersionId: 'version-1',
        storageTag: 'v1a2b3c4d',
        storedFilename: 'v1a2b3c4d_notes.md',
        writeOperationId: 'edit-operation-1',
        state: 'finalized',
        managedVisibleAt: new Date('2026-08-14T00:00:00.000Z'),
        contentStorageKey: editStorageKey,
        sizeBytes: 6n,
        checksum: 'c'.repeat(64),
        createdAt: new Date('2026-08-14T00:00:00.000Z')
      }
    })

    await expect(
      repository.getLineage({
        projectId: 'project-1',
        appSessionId: 'session-1',
        artifactId: 'artifact-1'
      })
    ).resolves.toMatchObject({
      versions: [
        { versionId: 'version-1', originKind: 'legacy' },
        {
          versionId: 'version-2',
          originKind: 'user_edit',
          basedOnVersionId: 'version-1'
        }
      ]
    })
    await expect(
      repository.getVersionProvenance({
        projectId: 'project-1',
        appSessionId: 'session-1',
        artifactId: 'artifact-1',
        versionId: 'version-2'
      })
    ).rejects.toThrow('Artifact Version not found: version-2')
    await expect(
      repository.getVersionProvenance({
        projectId: 'project-1',
        appSessionId: 'session-1',
        artifactId: 'artifact-1',
        versionId: 'version-1'
      })
    ).rejects.toThrow('Artifact Version not found: version-1')
  })

  it('stores reconstruction cache beside the exact owned immutable Version', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-artifact-reconstruction-cache-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)
    const repository = new ArtifactProvenanceRepository({
      storageRoot,
      getClient: () => Promise.resolve(client)
    })
    const contentStorageKey = 'artifacts/project-1/session-1/.provenance/versions/version-1/content'
    const contentPath = join(storageRoot, ...contentStorageKey.split('/'))
    await mkdir(dirname(contentPath), { recursive: true })
    await writeFile(contentPath, 'artifact bytes')
    await client.fileOriginSession.create({
      data: { projectId: 'project-1', sessionId: 'session-1' }
    })
    await client.artifactLineage.create({
      data: {
        id: 'artifact-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        normalizedFilename: 'plot.png',
        filename: 'plot.png'
      }
    })
    await client.artifactVersion.create({
      data: {
        id: 'version-1',
        artifactId: 'artifact-1',
        versionNumber: 1,
        filename: 'plot.png',
        artifactRunId: 'artifact-run-1',
        rootFrameId: 'root-1',
        agentFrameId: 'agent-1',
        messageBranchId: 'branch-1',
        runtimeSegmentId: 'segment-1',
        promptMessageId: 'prompt-1',
        state: 'finalized',
        contentStorageKey,
        evidenceStorageKey:
          'artifacts/project-1/session-1/.provenance/versions/version-1/evidence.json',
        evidenceSchemaVersion: 1,
        sizeBytes: BigInt(14),
        checksum: 'a'.repeat(64),
        evidenceJson: '{}',
        evidenceChecksum: 'b'.repeat(64)
      }
    })
    const request = {
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactId: 'artifact-1',
      versionId: 'version-1'
    }

    await expect(repository.readCodeReconstructionCache(request)).resolves.toBeUndefined()
    await repository.writeCodeReconstructionCache(request, '{"schemaVersion":1}\n')
    await expect(repository.readCodeReconstructionCache(request)).resolves.toBe(
      '{"schemaVersion":1}\n'
    )
    await expect(
      readFile(join(dirname(contentPath), 'code-reconstruction.json'), 'utf8')
    ).resolves.toBe('{"schemaVersion":1}\n')
    await expect(
      repository.readCodeReconstructionCache({ ...request, appSessionId: 'other-session' })
    ).rejects.toThrow('Artifact Version not found')
  })

  it('removes a stale orphaned staging directory that has no SQLite lifecycle row', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-artifact-orphan-staging-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)
    const repository = new ArtifactProvenanceRepository({
      storageRoot,
      getClient: () => Promise.resolve(client)
    })
    const orphanVersionId = 'orphan-version-1'
    const stagingDirectory = join(
      storageRoot,
      'artifacts',
      'project-1',
      'session-1',
      '.provenance',
      '.staging',
      'versions',
      orphanVersionId
    )
    await mkdir(stagingDirectory, { recursive: true })
    await writeFile(join(stagingDirectory, 'content'), 'orphaned bytes')
    const staleTime = new Date(Date.now() - 2 * 60 * 60 * 1_000)
    await utimes(stagingDirectory, staleTime, staleTime)

    await expect(
      repository.reconcileSession('project-1', 'session-1', undefined, {
        removeOrphanStaging: true
      })
    ).resolves.toEqual({
      recoveredVersionIds: [],
      quarantinedVersionIds: [],
      recoveredMessageArtifacts: [],
      nativeFinalizationRunIds: [],
      unresolvedNativeFinalizationRunIds: []
    })
    await expect(stat(stagingDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('leaves a fresh rowless staging directory for an in-flight writer', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-artifact-live-staging-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)
    const repository = new ArtifactProvenanceRepository({
      storageRoot,
      getClient: () => Promise.resolve(client)
    })
    const stagingDirectory = join(
      storageRoot,
      'artifacts',
      'project-1',
      'session-1',
      '.provenance',
      '.staging',
      'versions',
      'in-flight-version'
    )
    await mkdir(stagingDirectory, { recursive: true })
    await writeFile(join(stagingDirectory, 'content'), 'still copying')

    await repository.reconcileSession('project-1', 'session-1', undefined, {
      removeOrphanStaging: true
    })

    await expect(stat(stagingDirectory)).resolves.toBeDefined()
  })

  it('never removes rowless staging during read-triggered reconciliation', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-artifact-read-reconcile-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)
    const repository = new ArtifactProvenanceRepository({
      storageRoot,
      getClient: () => Promise.resolve(client)
    })
    const stagingDirectory = join(
      storageRoot,
      'artifacts',
      'project-1',
      'session-1',
      '.provenance',
      '.staging',
      'versions',
      'old-but-active-version'
    )
    await mkdir(stagingDirectory, { recursive: true })
    await writeFile(join(stagingDirectory, 'content'), 'long-running copy')
    const staleTime = new Date(Date.now() - 2 * 60 * 60 * 1_000)
    await utimes(stagingDirectory, staleTime, staleTime)

    await repository.reconcileSession('project-1', 'session-1')

    await expect(stat(stagingDirectory)).resolves.toBeDefined()
  })

  it('serializes same-session writes so concurrent calls cannot exceed the turn budget', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-artifact-turn-budget-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)
    const compatibilityRepository = new ArtifactRepository(storageRoot)
    const content = createPngBytes('budgeted')
    const repository = new ArtifactProvenanceRepository({
      storageRoot,
      getClient: () => Promise.resolve(client),
      compatibilityRepository,
      resourceBudgets: {
        artifactTurnBytes: content.byteLength,
        artifactSessionBytes: content.byteLength * 10
      }
    })
    const common = {
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-1',
      artifactRunId: 'artifact-run-1',
      rootFrameId: 'root-frame-1',
      agentFrameId: 'agent-frame-1',
      messageBranchId: 'branch-1',
      runtimeSegmentId: 'runtime-segment-1',
      promptMessageId: 'prompt-1',
      agentName: 'Codex',
      contentType: 'image/png'
    } as const
    for (const filename of ['a.png', 'b.png']) {
      await compatibilityRepository.writePendingFile({
        projectId: common.projectId,
        sessionId: common.artifactStorageSessionId,
        runId: common.artifactRunId,
        filename,
        mimeType: common.contentType,
        source: { kind: 'inline', content: content.toString('base64'), encoding: 'base64' }
      })
    }

    const results = await Promise.allSettled(
      ['a.png', 'b.png'].map((filename, index) =>
        repository.createVersion({
          ...common,
          filename,
          writeOperationId: `write-${index}`,
          writeRequestChecksum: String(index).repeat(64)
        })
      )
    )

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { dimension: 'turn' }
    })
  })

  it('counts durable bytes across runs in the same Session', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-artifact-session-budget-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)
    const compatibilityRepository = new ArtifactRepository(storageRoot)
    const content = createPngBytes('session-budgeted')
    const repository = new ArtifactProvenanceRepository({
      storageRoot,
      getClient: () => Promise.resolve(client),
      compatibilityRepository,
      resourceBudgets: {
        artifactTurnBytes: content.byteLength * 10,
        artifactSessionBytes: content.byteLength
      }
    })
    const common = {
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-1',
      rootFrameId: 'root-frame-1',
      agentFrameId: 'agent-frame-1',
      messageBranchId: 'branch-1',
      runtimeSegmentId: 'runtime-segment-1',
      promptMessageId: 'prompt-1',
      agentName: 'Codex',
      contentType: 'image/png'
    } as const

    for (const [filename, artifactRunId] of [
      ['first.png', 'artifact-run-1'],
      ['second.png', 'artifact-run-2']
    ] as const) {
      await compatibilityRepository.writePendingFile({
        projectId: common.projectId,
        sessionId: common.artifactStorageSessionId,
        runId: artifactRunId,
        filename,
        mimeType: common.contentType,
        source: { kind: 'inline', content: content.toString('base64'), encoding: 'base64' }
      })
    }
    await repository.createVersion({
      ...common,
      artifactRunId: 'artifact-run-1',
      filename: 'first.png',
      writeOperationId: 'write-first',
      writeRequestChecksum: 'a'.repeat(64)
    })

    await expect(
      repository.createVersion({
        ...common,
        artifactRunId: 'artifact-run-2',
        filename: 'second.png',
        writeOperationId: 'write-second',
        writeRequestChecksum: 'b'.repeat(64)
      })
    ).rejects.toMatchObject({ dimension: 'session' })
  })

  it('releases a write reservation after a successful Version write', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-artifact-reservation-success-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)
    const compatibilityRepository = new ArtifactRepository(storageRoot)
    const repository = new ArtifactProvenanceRepository({
      storageRoot,
      getClient: () => Promise.resolve(client),
      compatibilityRepository
    })
    const content = createPngBytes('reserved success')
    const reservationRequest = {
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-1',
      artifactRunId: 'artifact-run-1',
      writeOperationId: 'write-reserved-success',
      filename: 'reserved.png',
      fileBytes: content.byteLength
    } as const
    const reservation = await repository.reserveWrite(reservationRequest)
    await compatibilityRepository.writePendingFile({
      projectId: reservationRequest.projectId,
      sessionId: reservationRequest.artifactStorageSessionId,
      runId: reservationRequest.artifactRunId,
      filename: reservationRequest.filename,
      mimeType: 'image/png',
      source: { kind: 'inline', content: content.toString('base64'), encoding: 'base64' }
    })

    await repository.createVersion({
      ...reservationRequest,
      writeRequestChecksum: 'a'.repeat(64),
      rootFrameId: 'root-frame-1',
      agentFrameId: 'agent-frame-1',
      messageBranchId: 'branch-1',
      runtimeSegmentId: 'runtime-segment-1',
      promptMessageId: 'prompt-1',
      contentType: 'image/png',
      resourceReservationId: reservation.id,
      resourceSizeBytes: content.byteLength,
      resourceChecksum: createHash('sha256').update(content).digest('hex')
    })

    const replacement = await repository.reserveWrite(reservationRequest)
    expect(replacement.id).not.toBe(reservation.id)
    await repository.releaseWriteReservation({
      projectId: reservationRequest.projectId,
      appSessionId: reservationRequest.appSessionId,
      artifactStorageSessionId: reservationRequest.artifactStorageSessionId,
      artifactRunId: reservationRequest.artifactRunId,
      reservationId: replacement.id
    })
  })

  it('keeps immutable bytes while same-session same-name saves advance one lineage', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-artifact-versions-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)

    const compatibilityRepository = new ArtifactRepository(storageRoot)
    const repository = new ArtifactProvenanceRepository({
      storageRoot,
      getClient: () => Promise.resolve(client),
      compatibilityRepository
    })

    const common = {
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-1',
      artifactRunId: 'artifact-run-1',
      rootFrameId: 'root-frame-1',
      agentFrameId: 'agent-frame-1',
      messageBranchId: 'branch-1',
      runtimeSegmentId: 'runtime-segment-1',
      promptMessageId: 'prompt-1',
      agentName: 'Codex',
      filename: 'Sin.png',
      contentType: 'image/png',
      titleSnapshot: 'Sine analysis'
    } as const

    await compatibilityRepository.writePendingFile({
      projectId: common.projectId,
      sessionId: common.artifactStorageSessionId,
      runId: common.artifactRunId,
      filename: common.filename,
      mimeType: common.contentType,
      source: createPngInlineSource('version one')
    })
    const first = await repository.createVersion({
      ...common,
      writeOperationId: 'write-1',
      writeRequestChecksum: 'a'.repeat(64)
    })

    const replacementFilename = 'SIN.PNG'
    await compatibilityRepository.writePendingFile({
      projectId: common.projectId,
      sessionId: common.artifactStorageSessionId,
      runId: common.artifactRunId,
      filename: replacementFilename,
      mimeType: common.contentType,
      source: createPngInlineSource('version two')
    })
    const second = await repository.createVersion({
      ...common,
      filename: replacementFilename,
      writeOperationId: 'write-2',
      writeRequestChecksum: 'b'.repeat(64)
    })
    const third = await repository.createVersion({
      ...common,
      filename: replacementFilename,
      writeOperationId: 'write-3',
      writeRequestChecksum: 'c'.repeat(64)
    })

    const otherSession = {
      ...common,
      appSessionId: 'session-2',
      artifactStorageSessionId: 'artifact-session-2',
      artifactRunId: 'artifact-run-2'
    }
    await compatibilityRepository.writePendingFile({
      projectId: otherSession.projectId,
      sessionId: otherSession.artifactStorageSessionId,
      runId: otherSession.artifactRunId,
      filename: otherSession.filename,
      mimeType: otherSession.contentType,
      source: createPngInlineSource('version two')
    })
    const separateLineage = await repository.createVersion({
      ...otherSession,
      writeOperationId: 'write-other-session',
      writeRequestChecksum: 'd'.repeat(64)
    })

    expect(first.artifactId).toBe(second.artifactId)
    expect(first.versionId).not.toBe(second.versionId)
    expect(first.versionNumber).toBe(1)
    expect(second.versionNumber).toBe(2)
    expect(third.versionNumber).toBe(3)
    expect(third.checksum).toBe(second.checksum)
    expect(separateLineage.artifactId).not.toBe(first.artifactId)
    expect(separateLineage.versionNumber).toBe(1)
    expect(await readFile(first.path)).toEqual(createPngBytes('version one'))
    expect(await readFile(second.path)).toEqual(createPngBytes('version two'))
    expect(first.name).toBe(common.filename)
    expect(second.name).toBe(replacementFilename)
    const firstRow = requireAgentArtifactVersion(
      await client.artifactVersion.findUniqueOrThrow({ where: { id: first.versionId } })
    )
    expect(JSON.parse(firstRow.evidenceJson)).toMatchObject({ agent_name: 'Codex' })

    const versions = await client.artifactVersion.findMany({
      where: { artifactId: first.artifactId },
      orderBy: { versionNumber: 'asc' }
    })
    expect(versions.map((version) => version.versionNumber)).toEqual([1, 2, 3])
    expect(versions.map((version) => version.filename)).toEqual([
      common.filename,
      replacementFilename,
      replacementFilename
    ])
  })

  it('selects the exact pending filename when multiple files share one normalized name', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-artifact-exact-filename-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)

    const compatibilityRepository = new ArtifactRepository(storageRoot)
    const repository = new ArtifactProvenanceRepository({
      storageRoot,
      getClient: () => Promise.resolve(client),
      compatibilityRepository
    })
    const oldCandidate = await compatibilityRepository.writePendingFile({
      projectId: 'project-1',
      sessionId: 'artifact-session-1',
      runId: 'artifact-run-1',
      filename: 'old-candidate.png',
      mimeType: 'image/png',
      source: createPngInlineSource('old bytes')
    })
    const exactCandidate = await compatibilityRepository.writePendingFile({
      projectId: 'project-1',
      sessionId: 'artifact-session-1',
      runId: 'artifact-run-1',
      filename: 'exact-candidate.png',
      mimeType: 'image/png',
      source: createPngInlineSource('exact bytes')
    })
    vi.spyOn(compatibilityRepository, 'listPendingRunFiles').mockResolvedValue([
      { ...oldCandidate, name: 'Sin.png' },
      { ...exactCandidate, name: 'SIN.PNG' }
    ])
    vi.spyOn(compatibilityRepository, 'ensurePendingVersionRouting').mockResolvedValue()

    const version = await repository.createVersion({
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-1',
      artifactRunId: 'artifact-run-1',
      rootFrameId: 'root-frame-1',
      agentFrameId: 'agent-frame-1',
      messageBranchId: 'branch-1',
      runtimeSegmentId: 'runtime-segment-1',
      promptMessageId: 'prompt-1',
      agentName: 'Codex',
      filename: 'SIN.PNG',
      contentType: 'image/png',
      titleSnapshot: 'Sine analysis',
      writeOperationId: 'write-1',
      writeRequestChecksum: 'a'.repeat(64)
    })

    expect(await readFile(version.path)).toEqual(createPngBytes('exact bytes'))
  })

  it('rejects ambiguous normalized pending filenames when none exactly matches', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-artifact-ambiguous-filename-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)

    const compatibilityRepository = new ArtifactRepository(storageRoot)
    const repository = new ArtifactProvenanceRepository({
      storageRoot,
      getClient: () => Promise.resolve(client),
      compatibilityRepository
    })
    const firstCandidate = await compatibilityRepository.writePendingFile({
      projectId: 'project-1',
      sessionId: 'artifact-session-1',
      runId: 'artifact-run-1',
      filename: 'first-candidate.png',
      mimeType: 'image/png',
      source: createPngInlineSource('first bytes')
    })
    const secondCandidate = await compatibilityRepository.writePendingFile({
      projectId: 'project-1',
      sessionId: 'artifact-session-1',
      runId: 'artifact-run-1',
      filename: 'second-candidate.png',
      mimeType: 'image/png',
      source: createPngInlineSource('second bytes')
    })
    vi.spyOn(compatibilityRepository, 'listPendingRunFiles').mockResolvedValue([
      { ...firstCandidate, name: 'Sin.png' },
      { ...secondCandidate, name: 'sin.PNG' }
    ])

    await expect(
      repository.createVersion({
        projectId: 'project-1',
        appSessionId: 'session-1',
        artifactStorageSessionId: 'artifact-session-1',
        artifactRunId: 'artifact-run-1',
        rootFrameId: 'root-frame-1',
        agentFrameId: 'agent-frame-1',
        messageBranchId: 'branch-1',
        runtimeSegmentId: 'runtime-segment-1',
        promptMessageId: 'prompt-1',
        agentName: 'Codex',
        filename: 'SIN.PNG',
        contentType: 'image/png',
        titleSnapshot: 'Sine analysis',
        writeOperationId: 'write-1',
        writeRequestChecksum: 'a'.repeat(64)
      })
    ).rejects.toThrow('Pending artifact filename is ambiguous: SIN.PNG')
    await expect(client.artifactVersion.count()).resolves.toBe(0)
  })

  it('publishes app-generated compatibility bytes and an immutable Version together', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-app-generated-artifact-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)
    const compatibilityRepository = new ArtifactRepository(storageRoot)
    const repository = new ArtifactProvenanceRepository({
      storageRoot,
      getClient: () => Promise.resolve(client),
      compatibilityRepository
    })

    const version = await repository.writeAppGeneratedVersion({
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-1',
      artifactRunId: 'artifact-run-1',
      rootFrameId: 'root-frame-1',
      agentFrameId: 'agent-frame-1',
      messageBranchId: 'branch-1',
      runtimeSegmentId: 'runtime-segment-1',
      promptMessageId: 'prompt-1',
      agentName: 'OpenCode',
      filename: 'caffeine.mol',
      content: 'generated molecule bytes',
      contentType: 'chemical/x-mdl-molfile'
    })

    await expect(readFile(version.path, 'utf8')).resolves.toBe('generated molecule bytes')
    await expect(
      repository.listRunVersions({
        projectId: 'project-1',
        appSessionId: 'session-1',
        artifactRunId: 'artifact-run-1'
      })
    ).resolves.toEqual([expect.objectContaining({ versionId: version.versionId })])
    const row = requireAgentArtifactVersion(
      await client.artifactVersion.findUniqueOrThrow({ where: { id: version.versionId } })
    )
    expect(JSON.parse(row.evidenceJson)).toMatchObject({
      producer: { state: 'unavailable', reason: 'producer-not-supplied' },
      execution_status: { state: 'unavailable', reason: 'producer-not-supplied' }
    })
  })

  it('does not deadlock app-generated and RPC Version writes for the same pending file', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-artifact-lock-order-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)
    const compatibilityRepository = new ArtifactRepository(storageRoot)
    const repository = new ArtifactProvenanceRepository({
      storageRoot,
      getClient: () => Promise.resolve(client),
      compatibilityRepository
    })
    const content = 'same pending file'
    const common = {
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-1',
      artifactRunId: 'artifact-run-1',
      rootFrameId: 'root-frame-1',
      agentFrameId: 'agent-frame-1',
      messageBranchId: 'branch-1',
      runtimeSegmentId: 'runtime-segment-1',
      promptMessageId: 'prompt-1',
      agentName: 'Codex',
      filename: 'shared.txt',
      contentType: 'text/plain'
    } as const
    await compatibilityRepository.writePendingFile({
      projectId: common.projectId,
      sessionId: common.artifactStorageSessionId,
      runId: common.artifactRunId,
      filename: common.filename,
      mimeType: common.contentType,
      source: { kind: 'inline', content, encoding: 'utf8' }
    })

    const rpcRoutingStarted = createDeferred()
    const releaseRpcRouting = createDeferred()
    const sessionWrites = vi.spyOn(ArtifactProvenanceVersionWriter.prototype, 'withSessionWrite')
    const originalEnsureRouting =
      compatibilityRepository.ensurePendingVersionRouting.bind(compatibilityRepository)
    vi.spyOn(compatibilityRepository, 'ensurePendingVersionRouting').mockImplementation(
      async (request) => {
        rpcRoutingStarted.resolve()
        await releaseRpcRouting.promise
        return originalEnsureRouting(request)
      }
    )

    const appPendingTransactionStarted = createDeferred()
    let appPendingTransactionDidStart = false
    const originalPendingTransaction =
      compatibilityRepository.withPendingFileTransaction.bind(compatibilityRepository)
    vi.spyOn(compatibilityRepository, 'withPendingFileTransaction').mockImplementation(
      (request, options, operation) =>
        originalPendingTransaction(request, options, async (...args) => {
          appPendingTransactionDidStart = true
          appPendingTransactionStarted.resolve()
          return operation(...args)
        })
    )

    const rpcWrite = repository.createVersion({
      ...common,
      writeOperationId: 'rpc-write',
      writeRequestChecksum: 'a'.repeat(64)
    })
    await rpcRoutingStarted.promise

    const appWrite = repository.writeAppGeneratedVersion({
      ...common,
      content
    })
    await vi.waitFor(() => expect(sessionWrites).toHaveBeenCalledTimes(2))
    expect(appPendingTransactionDidStart).toBe(false)
    releaseRpcRouting.resolve()
    await appPendingTransactionStarted.promise

    const result = await Promise.race([
      Promise.allSettled([rpcWrite, appWrite]).then(() => 'settled' as const),
      new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 1_000))
    ])
    expect(result).toBe('settled')
  })

  it('persists a trusted app-owned Connector execution receipt with its generated Version', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-connector-provenance-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)
    const repository = new ArtifactProvenanceRepository({
      storageRoot,
      getClient: () => Promise.resolve(client),
      compatibilityRepository: new ArtifactRepository(storageRoot)
    })
    const normalizedArguments = {
      filename: 'caffeine',
      smiles: 'CN1C=NC2=C1C(=O)N(C(=O)N2C)C'
    }
    const argumentsChecksum = createHash('sha256')
      .update(JSON.stringify(normalizedArguments))
      .digest('hex')

    const version = await repository.writeAppGeneratedVersion({
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-1',
      artifactRunId: 'artifact-run-1',
      rootFrameId: 'root-frame-1',
      agentFrameId: 'agent-frame-1',
      messageBranchId: 'branch-1',
      runtimeSegmentId: 'runtime-segment-1',
      promptMessageId: 'prompt-1',
      agentName: 'OpenCode',
      filename: 'caffeine.mol',
      content: 'generated molecule bytes',
      contentType: 'chemical/x-mdl-molfile',
      producer: {
        kind: 'connector',
        connectorId: 'molecule',
        toolId: 'preview_molecule',
        invocationId: 'connector-call-1',
        implementationVersion: '1',
        normalizedArguments
      }
    })

    await expect(
      repository.getVersionProvenance({
        projectId: 'project-1',
        appSessionId: 'session-1',
        artifactId: version.artifactId,
        versionId: version.versionId
      })
    ).resolves.toMatchObject({
      evidence: {
        producer: {
          state: 'available',
          kind: 'connector',
          connector_id: 'molecule',
          tool_id: 'preview_molecule',
          invocation_id: 'connector-call-1',
          implementation_version: '1',
          arguments_checksum: argumentsChecksum,
          association_method: 'app-owned-handler'
        },
        connector_execution: {
          schema_version: 1,
          normalized_arguments: normalizedArguments,
          arguments_checksum: argumentsChecksum
        },
        execution_status: { state: 'partial' },
        environment_status: { state: 'unavailable', reason: 'environment-not-supported' },
        inputs: []
      }
    })
  })

  it('ignores Connector producer claims attached to the ordinary Artifact create request', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-untrusted-connector-provenance-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)
    const compatibilityRepository = new ArtifactRepository(storageRoot)
    const repository = new ArtifactProvenanceRepository({
      storageRoot,
      getClient: () => Promise.resolve(client),
      compatibilityRepository
    })
    await compatibilityRepository.writePendingFile({
      projectId: 'project-1',
      sessionId: 'artifact-session-1',
      runId: 'artifact-run-1',
      filename: 'untrusted.mol',
      source: { kind: 'inline', content: 'untrusted bytes', encoding: 'utf8' }
    })

    const untrustedRequest = {
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-1',
      artifactRunId: 'artifact-run-1',
      writeOperationId: 'write-1',
      writeRequestChecksum: 'a'.repeat(64),
      rootFrameId: 'root-frame-1',
      agentFrameId: 'agent-frame-1',
      messageBranchId: 'branch-1',
      runtimeSegmentId: 'runtime-segment-1',
      promptMessageId: 'prompt-1',
      filename: 'untrusted.mol',
      sourceKind: 'inline' as const,
      producer: {
        kind: 'connector',
        connectorId: 'custom-mcp',
        toolId: 'spoof_producer',
        invocationId: 'untrusted-call-1',
        implementationVersion: '1',
        normalizedArguments: {}
      }
    }

    const version = await repository.createVersion(untrustedRequest)

    await expect(
      repository.getVersionProvenance({
        projectId: 'project-1',
        appSessionId: 'session-1',
        artifactId: version.artifactId,
        versionId: version.versionId
      })
    ).resolves.toMatchObject({
      evidence: {
        producer: { state: 'unavailable', reason: 'producer-not-supplied' },
        execution_status: { state: 'unavailable', reason: 'producer-not-supplied' }
      }
    })
  })

  it('links a verified Upload Version as an input to a Connector-generated Artifact Version', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-connector-upload-provenance-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-1', name: 'Project' } })
    const repository = new ArtifactProvenanceRepository({
      storageRoot,
      getClient: () => Promise.resolve(client),
      compatibilityRepository: new ArtifactRepository(storageRoot)
    })
    const inputContent = 'CC(=O)Oc1ccccc1C(=O)O\n'
    const inputChecksum = createHash('sha256').update(inputContent).digest('hex')
    const inputStorageKey =
      'uploads/project-1/source-session/upload-1/versions/upload-version-1/content'
    const inputPath = join(storageRoot, ...inputStorageKey.split('/'))
    await mkdir(dirname(inputPath), { recursive: true })
    await writeFile(inputPath, inputContent)
    await client.fileOriginSession.create({
      data: { projectId: 'project-1', sessionId: 'source-session' }
    })
    await client.uploadFile.create({
      data: {
        id: 'upload-1',
        projectId: 'project-1',
        sessionId: 'source-session',
        filename: 'aspirin.smi',
        originalFilename: 'aspirin.smi',
        versions: {
          create: {
            id: 'upload-version-1',
            versionNumber: 1,
            state: 'ready',
            contentStorageKey: inputStorageKey,
            filename: 'aspirin.smi',
            originalFilename: 'aspirin.smi',
            contentType: 'chemical/x-daylight-smiles',
            sizeBytes: BigInt(Buffer.byteLength(inputContent)),
            checksum: inputChecksum,
            createdAt: new Date('2026-08-20T06:00:00.000Z')
          }
        }
      }
    })
    await client.uploadFile.update({
      where: { id: 'upload-1' },
      data: { currentVersionId: 'upload-version-1' }
    })

    const version = await repository.writeAppGeneratedVersion({
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-1',
      artifactRunId: 'artifact-run-1',
      rootFrameId: 'root-frame-1',
      agentFrameId: 'agent-frame-1',
      messageBranchId: 'branch-1',
      runtimeSegmentId: 'runtime-segment-1',
      promptMessageId: 'prompt-1',
      filename: 'aspirin.mol',
      content: 'generated molecule bytes',
      contentType: 'chemical/x-mdl-molfile',
      producer: {
        kind: 'connector',
        connectorId: 'molecule',
        toolId: 'preview_molecule',
        invocationId: 'connector-call-1',
        implementationVersion: '1',
        normalizedArguments: { filename: 'aspirin.mol' },
        inputFiles: [
          {
            inputFileVersionId: 'upload-version-1',
            sourceKind: 'upload-version',
            sourceFileId: 'upload-1',
            sourceVersionNumber: 1,
            sourceCreatedAt: '2026-08-20T06:00:00.000Z',
            sourceProjectId: 'project-1',
            sourceSessionId: 'source-session',
            filename: 'aspirin.smi',
            contentType: 'chemical/x-daylight-smiles',
            sizeBytes: Buffer.byteLength(inputContent),
            checksum: inputChecksum,
            storageKey: inputStorageKey,
            association: 'resolver-accessed'
          }
        ]
      }
    })

    await expect(
      repository.readDependencyRelations({
        projectId: 'project-1',
        versionId: version.versionId,
        direction: 'up'
      })
    ).resolves.toEqual([
      {
        versionId: version.versionId,
        dependsOnVersionId: 'upload-version-1',
        ordinal: 0,
        sourceKind: 'upload-version',
        inputFilename: 'aspirin.smi',
        association: 'resolver-accessed'
      }
    ])
    await expect(
      repository.getVersionProvenance({
        projectId: 'project-1',
        appSessionId: 'session-1',
        artifactId: version.artifactId,
        versionId: version.versionId
      })
    ).resolves.toMatchObject({
      evidence: {
        inputs: [
          {
            input_file_version_id: 'upload-version-1',
            source_kind: 'upload-version',
            source_file_id: 'upload-1',
            strongest_association: 'resolver-accessed'
          }
        ]
      }
    })
  })

  it('fails closed when a Connector claims an unverifiable Upload Version input', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-connector-upload-rejection-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)
    const repository = new ArtifactProvenanceRepository({
      storageRoot,
      getClient: () => Promise.resolve(client),
      compatibilityRepository: new ArtifactRepository(storageRoot),
      inputAuthority: {
        validateVersion: async () => ({ state: 'unavailable' })
      }
    })

    await expect(
      repository.writeAppGeneratedVersion({
        projectId: 'project-1',
        appSessionId: 'session-1',
        artifactStorageSessionId: 'artifact-session-1',
        artifactRunId: 'artifact-run-1',
        rootFrameId: 'root-frame-1',
        agentFrameId: 'agent-frame-1',
        messageBranchId: 'branch-1',
        runtimeSegmentId: 'runtime-segment-1',
        promptMessageId: 'prompt-1',
        filename: 'aspirin.mol',
        content: 'generated molecule bytes',
        producer: {
          kind: 'connector',
          connectorId: 'molecule',
          toolId: 'preview_molecule',
          invocationId: 'connector-call-1',
          implementationVersion: '1',
          normalizedArguments: { filename: 'aspirin.mol' },
          inputFiles: [
            {
              inputFileVersionId: 'missing-upload-version',
              sourceKind: 'upload-version',
              sourceFileId: 'upload-1',
              sourceProjectId: 'project-1',
              sourceSessionId: 'source-session',
              filename: 'aspirin.smi',
              sizeBytes: 1,
              checksum: 'a'.repeat(64),
              storageKey: 'uploads/untrusted/content',
              association: 'resolver-accessed'
            }
          ]
        }
      })
    ).rejects.toThrow('Connector Upload input identity is corrupt: missing-upload-version')
    await expect(
      repository.listRunVersions({
        projectId: 'project-1',
        appSessionId: 'session-1',
        artifactRunId: 'artifact-run-1'
      })
    ).resolves.toEqual([])
  })

  it('resolves finalized native Versions in first-occurrence request order without paths', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-artifact-version-descriptors-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)
    const repository = new ArtifactProvenanceRepository({
      storageRoot,
      getClient: () => Promise.resolve(client),
      compatibilityRepository: new ArtifactRepository(storageRoot),
      loadSession: async (projectId, appSessionId) =>
        projectId === 'project-1' && appSessionId === 'branched-session'
          ? {
              id: appSessionId,
              projectId,
              title: 'Branched session',
              cwd: '/workspace',
              status: 'idle',
              messages: [],
              createdAt: 1,
              updatedAt: 1
            }
          : undefined
    })
    const createVersion = async (filename: string, content: string): Promise<ArtifactVersionFile> =>
      repository.writeAppGeneratedVersion({
        projectId: 'project-1',
        appSessionId: 'source-session-1',
        artifactStorageSessionId: 'artifact-session-1',
        artifactRunId: `run-${filename}`,
        rootFrameId: 'root-frame-1',
        agentFrameId: 'agent-frame-1',
        messageBranchId: 'branch-1',
        runtimeSegmentId: 'runtime-segment-1',
        promptMessageId: 'prompt-1',
        filename,
        content,
        contentType: 'text/plain'
      })

    const first = await createVersion('first.txt', 'first bytes')
    const second = await createVersion('second.txt', 'second bytes')
    await client.artifactVersion.updateMany({
      where: { id: { in: [first.versionId, second.versionId] } },
      data: { state: 'finalized' }
    })

    const resolved = await repository.resolveVersionDescriptors({
      projectId: 'project-1',
      appSessionId: 'branched-session',
      versionIds: [second.versionId, 'missing-version', first.versionId, second.versionId]
    })

    expect(resolved).toEqual([
      expect.objectContaining({
        id: second.versionId,
        versionId: second.versionId,
        artifactId: second.artifactId,
        versionNumber: 1,
        projectId: 'project-1',
        sessionId: 'source-session-1',
        name: 'second.txt',
        mimeType: 'text/plain',
        size: Buffer.byteLength('second bytes')
      }),
      expect.objectContaining({
        id: first.versionId,
        versionId: first.versionId,
        artifactId: first.artifactId,
        name: 'first.txt'
      })
    ])
    expect(
      resolved.every((descriptor) => !('path' in descriptor) && !('fileUrl' in descriptor))
    ).toBe(true)
    await expect(
      repository.resolveVersionDescriptors({
        projectId: 'project-2',
        appSessionId: 'branched-session',
        versionIds: [first.versionId]
      })
    ).rejects.toThrow('Session does not belong to the requested Project.')
  })

  it('bounds Version descriptor requests before querying SQLite', async () => {
    const repository = new ArtifactProvenanceRepository({
      storageRoot: '/unused',
      getClient: () => {
        throw new Error('SQLite should not be queried for an oversized request.')
      }
    })

    await expect(
      repository.resolveVersionDescriptors({
        projectId: 'project-1',
        appSessionId: 'session-1',
        versionIds: Array.from({ length: 101 }, (_, index) => `version-${index}`)
      })
    ).rejects.toThrow(/At most 100 Artifact Version ids/)
  })

  it('returns the original Version for an exact write-operation retry without rereading changed pending bytes', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-artifact-idempotency-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)

    const compatibilityRepository = new ArtifactRepository(storageRoot)
    const repository = new ArtifactProvenanceRepository({
      storageRoot,
      getClient: () => Promise.resolve(client),
      compatibilityRepository
    })
    const request = {
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-1',
      artifactRunId: 'artifact-run-1',
      writeOperationId: 'write-1',
      writeRequestChecksum: 'a'.repeat(64),
      rootFrameId: 'root-frame-1',
      agentFrameId: 'agent-frame-1',
      messageBranchId: 'branch-1',
      runtimeSegmentId: 'runtime-segment-1',
      promptMessageId: 'prompt-1',
      filename: 'sin.png',
      contentType: 'image/png'
    } as const

    await compatibilityRepository.writePendingFile({
      projectId: request.projectId,
      sessionId: request.artifactStorageSessionId,
      runId: request.artifactRunId,
      filename: request.filename,
      source: createPngInlineSource('original bytes')
    })
    const first = await repository.createVersion(request)
    await expect(
      repository.replayVersion({
        projectId: request.projectId,
        appSessionId: request.appSessionId,
        artifactStorageSessionId: request.artifactStorageSessionId,
        artifactRunId: request.artifactRunId,
        writeOperationId: request.writeOperationId,
        filename: request.filename,
        contentType: request.contentType
      })
    ).resolves.toMatchObject({ versionId: first.versionId })
    await expect(
      repository.replayVersion({
        projectId: request.projectId,
        appSessionId: request.appSessionId,
        artifactStorageSessionId: request.artifactStorageSessionId,
        artifactRunId: request.artifactRunId,
        writeOperationId: request.writeOperationId,
        filename: request.filename,
        contentType: 'application/pdf'
      })
    ).rejects.toThrow(/write operation.*different request/i)

    await compatibilityRepository.writePendingFile({
      projectId: request.projectId,
      sessionId: request.artifactStorageSessionId,
      runId: request.artifactRunId,
      filename: request.filename,
      source: createPngInlineSource('changed after delivery')
    })
    const retry = await repository.createVersion(request)

    expect(retry.versionId).toBe(first.versionId)
    expect(retry.versionNumber).toBe(1)
    expect(await readFile(retry.path)).toEqual(createPngBytes('original bytes'))
    expect(await client.artifactVersion.count()).toBe(1)
    await expect(
      repository.createVersion({ ...request, writeRequestChecksum: 'b'.repeat(64) })
    ).rejects.toThrow(/write operation.*different request/i)
    expect(await client.artifactVersion.count()).toBe(1)
  })

  it('keeps a Version in staging when a durable file barrier fails', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-artifact-durable-file-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)
    const compatibilityRepository = new ArtifactRepository(storageRoot)
    const repository = new ArtifactProvenanceRepository({
      storageRoot,
      getClient: () => Promise.resolve(client),
      compatibilityRepository,
      durability: {
        syncFile: async (path) => {
          if (path.endsWith('evidence.json')) throw new Error('simulated durable file failure')
        },
        syncDirectory: async () => undefined
      }
    })
    const request = {
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-1',
      artifactRunId: 'artifact-run-1',
      writeOperationId: 'write-durable-file',
      writeRequestChecksum: 'a'.repeat(64),
      rootFrameId: 'root-frame-1',
      agentFrameId: 'agent-frame-1',
      messageBranchId: 'branch-1',
      runtimeSegmentId: 'runtime-segment-1',
      promptMessageId: 'prompt-1',
      filename: 'sin.png',
      contentType: 'image/png'
    } as const
    const content = createPngBytes('durable file failure')
    const reservationRequest = {
      projectId: request.projectId,
      appSessionId: request.appSessionId,
      artifactStorageSessionId: request.artifactStorageSessionId,
      artifactRunId: request.artifactRunId,
      writeOperationId: request.writeOperationId,
      filename: request.filename,
      fileBytes: content.byteLength
    }
    const reservation = await repository.reserveWrite(reservationRequest)
    await compatibilityRepository.writePendingFile({
      projectId: request.projectId,
      sessionId: request.artifactStorageSessionId,
      runId: request.artifactRunId,
      filename: request.filename,
      mimeType: request.contentType,
      source: { kind: 'inline', content: content.toString('base64'), encoding: 'base64' }
    })

    const originalRelease = ArtifactWriteBudgetOwner.prototype.release
    const release = vi
      .spyOn(ArtifactWriteBudgetOwner.prototype, 'release')
      .mockImplementationOnce(async function (this: ArtifactWriteBudgetOwner, releaseRequest) {
        await originalRelease.call(this, releaseRequest)
        throw new Error('simulated reservation release failure')
      })
    try {
      await expect(
        repository.createVersion({
          ...request,
          resourceReservationId: reservation.id,
          resourceSizeBytes: content.byteLength,
          resourceChecksum: createHash('sha256').update(content).digest('hex')
        })
      ).rejects.toThrow('simulated durable file failure')
      expect(release).toHaveBeenCalledOnce()
    } finally {
      release.mockRestore()
    }
    const replacement = await repository.reserveWrite(reservationRequest)
    expect(replacement.id).not.toBe(reservation.id)
    await repository.releaseWriteReservation({
      projectId: request.projectId,
      appSessionId: request.appSessionId,
      artifactStorageSessionId: request.artifactStorageSessionId,
      artifactRunId: request.artifactRunId,
      reservationId: replacement.id
    })

    const row = await client.artifactVersion.findUniqueOrThrow({
      where: { writeOperationId: request.writeOperationId }
    })
    expect(row.state).toBe('staging')
    await expect(
      repository.listRunVersions({
        projectId: request.projectId,
        appSessionId: request.appSessionId,
        artifactRunId: request.artifactRunId
      })
    ).resolves.toEqual([])
  })

  it('recovers a renamed staging Version after the parent directory barrier fails', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-artifact-durable-directory-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)
    const compatibilityRepository = new ArtifactRepository(storageRoot)
    const request = {
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-1',
      artifactRunId: 'artifact-run-1',
      writeOperationId: 'write-durable-directory',
      writeRequestChecksum: 'b'.repeat(64),
      rootFrameId: 'root-frame-1',
      agentFrameId: 'agent-frame-1',
      messageBranchId: 'branch-1',
      runtimeSegmentId: 'runtime-segment-1',
      promptMessageId: 'prompt-1',
      filename: 'sin.png',
      contentType: 'image/png'
    } as const
    await compatibilityRepository.writePendingFile({
      projectId: request.projectId,
      sessionId: request.artifactStorageSessionId,
      runId: request.artifactRunId,
      filename: request.filename,
      mimeType: request.contentType,
      source: createPngInlineSource('durable directory failure')
    })
    const interrupted = new ArtifactProvenanceRepository({
      storageRoot,
      getClient: () => Promise.resolve(client),
      compatibilityRepository,
      durability: {
        syncFile: async () => undefined,
        syncDirectory: async (path) => {
          if (!path.includes(`${sep}.staging${sep}`)) {
            throw new Error('simulated durable directory failure')
          }
        }
      }
    })

    await expect(interrupted.createVersion(request)).rejects.toThrow(
      'simulated durable directory failure'
    )
    await expect(
      client.artifactVersion.findUniqueOrThrow({
        where: { writeOperationId: request.writeOperationId }
      })
    ).resolves.toMatchObject({ state: 'staging' })

    const recovered = new ArtifactProvenanceRepository({
      storageRoot,
      getClient: () => Promise.resolve(client),
      compatibilityRepository
    })
    await expect(recovered.createVersion(request)).resolves.toMatchObject({ versionNumber: 1 })
    await expect(
      client.artifactVersion.findUniqueOrThrow({
        where: { writeOperationId: request.writeOperationId }
      })
    ).resolves.toMatchObject({ state: 'pending' })
  })

  it('publishes compatibility routing before advancing SQLite from staging to pending', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-artifact-routing-order-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)
    const compatibilityRepository = new ArtifactRepository(storageRoot)
    const repository = new ArtifactProvenanceRepository({
      storageRoot,
      getClient: () => Promise.resolve(client),
      compatibilityRepository
    })
    const request = {
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-1',
      artifactRunId: 'artifact-run-1',
      writeOperationId: 'write-routing-order',
      writeRequestChecksum: '8'.repeat(64),
      rootFrameId: 'root-frame-1',
      agentFrameId: 'agent-frame-1',
      messageBranchId: 'branch-1',
      runtimeSegmentId: 'runtime-segment-1',
      promptMessageId: 'prompt-1',
      filename: 'routing-order.png',
      contentType: 'image/png'
    } as const
    await compatibilityRepository.writePendingFile({
      projectId: request.projectId,
      sessionId: request.artifactStorageSessionId,
      runId: request.artifactRunId,
      filename: request.filename,
      mimeType: request.contentType,
      source: createPngInlineSource('routing order bytes')
    })
    const publish = vi
      .spyOn(compatibilityRepository, 'ensurePendingVersionRouting')
      .mockRejectedValueOnce(new Error('simulated sidecar publication failure'))

    await expect(repository.createVersion(request)).rejects.toThrow(
      'simulated sidecar publication failure'
    )
    await expect(
      client.artifactVersion.findUniqueOrThrow({
        where: { writeOperationId: request.writeOperationId }
      })
    ).resolves.toMatchObject({ state: 'staging' })

    publish.mockRestore()
    await expect(repository.createVersion(request)).resolves.toMatchObject({ versionNumber: 1 })
    await expect(
      client.artifactVersion.findUniqueOrThrow({
        where: { writeOperationId: request.writeOperationId }
      })
    ).resolves.toMatchObject({ state: 'pending' })
  })

  it('rejects new Versions while the origin Session is being deleted', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-artifact-deleting-origin-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)
    const compatibilityRepository = new ArtifactRepository(storageRoot)
    const repository = new ArtifactProvenanceRepository({
      storageRoot,
      getClient: () => Promise.resolve(client),
      compatibilityRepository
    })
    await client.fileOriginSession.create({
      data: {
        projectId: 'project-1',
        sessionId: 'session-1',
        state: 'deleting',
        deletionOperationId: 'delete-1',
        retainedReviewIdsJson: '[]'
      }
    })
    await compatibilityRepository.writePendingFile({
      projectId: 'project-1',
      sessionId: 'artifact-session-1',
      runId: 'artifact-run-1',
      filename: 'sin.png',
      source: createPngInlineSource('late bytes')
    })

    await expect(
      repository.createVersion({
        projectId: 'project-1',
        appSessionId: 'session-1',
        artifactStorageSessionId: 'artifact-session-1',
        artifactRunId: 'artifact-run-1',
        writeOperationId: 'write-late',
        writeRequestChecksum: 'a'.repeat(64),
        rootFrameId: 'root-frame-1',
        agentFrameId: 'agent-frame-1',
        messageBranchId: 'branch-1',
        runtimeSegmentId: 'runtime-segment-1',
        promptMessageId: 'prompt-1',
        filename: 'sin.png'
      })
    ).rejects.toThrow(/being deleted/u)
    await expect(client.artifactVersion.count()).resolves.toBe(0)
    await expect(client.artifactLineage.count()).resolves.toBe(0)
  })

  it('recovers an existing staging operation from its immutable copied bytes', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-artifact-staging-recovery-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)
    const compatibilityRepository = new ArtifactRepository(storageRoot)
    const repository = new ArtifactProvenanceRepository({
      storageRoot,
      getClient: () => Promise.resolve(client),
      compatibilityRepository
    })
    const content = 'copied before crash'
    const contentChecksum = createHash('sha256').update(content).digest('hex')
    const evidenceJson = '{"schema_version":1}'
    const evidenceChecksum = createHash('sha256').update(evidenceJson).digest('hex')
    const versionId = 'version-recovery-1'
    const contentStorageKey =
      'artifacts/project-1/session-1/.provenance/artifact-1/versions/version-recovery-1/content'
    const evidenceStorageKey =
      'artifacts/project-1/session-1/.provenance/artifact-1/versions/version-recovery-1/evidence.json'
    const stagingDirectory = join(
      storageRoot,
      'artifacts',
      'project-1',
      'session-1',
      '.provenance',
      '.staging',
      'versions',
      versionId
    )
    await mkdir(stagingDirectory, { recursive: true })
    await writeFile(join(stagingDirectory, 'content'), content, 'utf8')
    const pendingDirectory = join(
      storageRoot,
      'artifacts',
      'project-1',
      'artifact-session-1',
      '.pending',
      'artifact-run-1'
    )
    await mkdir(pendingDirectory, { recursive: true })
    await writeFile(join(pendingDirectory, 'sin.png'), content, 'utf8')
    await client.fileOriginSession.create({
      data: { projectId: 'project-1', sessionId: 'session-1' }
    })
    await client.artifactLineage.create({
      data: {
        id: 'artifact-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        normalizedFilename: 'sin.png',
        filename: 'sin.png'
      }
    })
    const createdAt = new Date('2026-07-27T12:00:00.000Z')
    await client.artifactVersion.create({
      data: {
        id: versionId,
        artifactId: 'artifact-1',
        versionNumber: 1,
        filename: 'sin.png',
        artifactRunId: 'artifact-run-1',
        writeOperationId: 'write-1',
        writeRequestChecksum: 'a'.repeat(64),
        rootFrameId: 'root-frame-1',
        agentFrameId: 'agent-frame-1',
        messageBranchId: 'branch-1',
        runtimeSegmentId: 'runtime-segment-1',
        promptMessageId: 'prompt-1',
        state: 'staging',
        contentStorageKey,
        evidenceStorageKey,
        evidenceSchemaVersion: 1,
        sizeBytes: BigInt(Buffer.byteLength(content)),
        checksum: contentChecksum,
        evidenceJson,
        evidenceChecksum,
        createdAt
      }
    })
    const corruptVersionId = 'version-recovery-corrupt'
    const corruptStagingDirectory = join(
      storageRoot,
      'artifacts',
      'project-1',
      'session-1',
      '.provenance',
      '.staging',
      'versions',
      corruptVersionId
    )
    await mkdir(corruptStagingDirectory, { recursive: true })
    await writeFile(join(corruptStagingDirectory, 'content'), 'corrupt', 'utf8')
    await client.artifactLineage.create({
      data: {
        id: 'artifact-corrupt',
        projectId: 'project-1',
        sessionId: 'session-1',
        normalizedFilename: 'corrupt.png',
        filename: 'corrupt.png'
      }
    })
    await client.artifactVersion.create({
      data: {
        id: corruptVersionId,
        artifactId: 'artifact-corrupt',
        versionNumber: 1,
        filename: 'corrupt.png',
        artifactRunId: 'artifact-run-corrupt',
        writeOperationId: 'write-corrupt',
        writeRequestChecksum: 'b'.repeat(64),
        rootFrameId: 'root-frame-1',
        agentFrameId: 'agent-frame-1',
        messageBranchId: 'branch-1',
        runtimeSegmentId: 'runtime-segment-1',
        promptMessageId: 'prompt-1',
        state: 'staging',
        contentStorageKey:
          'artifacts/project-1/session-1/.provenance/artifact-corrupt/versions/version-recovery-corrupt/content',
        evidenceStorageKey:
          'artifacts/project-1/session-1/.provenance/artifact-corrupt/versions/version-recovery-corrupt/evidence.json',
        evidenceSchemaVersion: 1,
        sizeBytes: BigInt(Buffer.byteLength('expected')),
        checksum: createHash('sha256').update('expected').digest('hex'),
        evidenceJson,
        evidenceChecksum
      }
    })

    await expect(repository.reconcileSession('project-1', 'session-1')).resolves.toEqual({
      recoveredVersionIds: [versionId],
      quarantinedVersionIds: [corruptVersionId],
      recoveredMessageArtifacts: [],
      nativeFinalizationRunIds: [],
      unresolvedNativeFinalizationRunIds: []
    })
    await expect(
      readFile(join(storageRoot, ...contentStorageKey.split('/')), 'utf8')
    ).resolves.toBe(content)
    await expect(
      readFile(join(storageRoot, ...evidenceStorageKey.split('/')), 'utf8')
    ).resolves.toBe(evidenceJson)
    await expect(
      client.artifactVersion.findUniqueOrThrow({ where: { id: versionId } })
    ).resolves.toMatchObject({ state: 'pending', createdAt })
    await expect(
      readFile(join(pendingDirectory, '.metadata', 'sin.png.json'), 'utf8').then(JSON.parse)
    ).resolves.toMatchObject({
      artifactId: 'artifact-1',
      versionId,
      versionNumber: 1,
      artifactRunId: 'artifact-run-1',
      checksum: contentChecksum
    })
    await expect(
      client.artifactVersion.findUnique({ where: { id: corruptVersionId } })
    ).resolves.toBeNull()
    await expect(readFile(join(corruptStagingDirectory, 'content'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('validates the declared producer and freezes the branch execution prefix', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-artifact-producer-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-1', name: 'Project' } })

    const compatibilityRepository = new ArtifactRepository(storageRoot)
    const notebookRepository = new NotebookRunRepository(storageRoot)
    const repository = new ArtifactProvenanceRepository({
      storageRoot,
      getClient: () => Promise.resolve(client),
      compatibilityRepository,
      notebookRepository
    })
    const graph = {
      rootFrameId: 'root-frame-1',
      agentFrameId: 'agent-frame-1',
      messageBranchId: 'branch-1',
      runtimeSegmentId: 'runtime-segment-1',
      promptMessageId: 'prompt-1'
    }
    const environmentManifest: NotebookEnvironmentManifest = {
      schemaVersion: 1,
      captureKind: 'completed-run',
      capturedAt: '2026-07-27T12:00:00.000Z',
      installedInventory: {
        capturedAt: '2026-07-27T11:59:00.000Z',
        source: 'cache-reused',
        validation: 'full-scan'
      },
      kernelKind: 'python',
      environmentName: 'analysis-python',
      runtimeSource: 'external',
      runtimeVersion: '3.13.2',
      platform: 'darwin',
      architecture: 'arm64',
      inventorySources: ['kernel-native', 'interpreter-native'],
      packages: [
        {
          name: 'numpy',
          version: '2.2.0',
          versionStatus: 'known',
          ecosystem: 'python',
          evidenceSources: ['python-importlib-metadata', 'python-kernel-modules'],
          loadedState: 'loaded',
          source: {
            type: 'github',
            repository: 'numpy/numpy',
            ref: 'v2.2.0',
            commit: 'abc123'
          }
        }
      ],
      // Persisted manifests from before structured installer evidence contain only these five
      // fields. Artifact saving must project safe defaults instead of calling .map on attempts.
      operationLog: [
        {
          operationId: 'legacy-install-1',
          timestamp: '2026-07-27T11:58:00.000Z',
          operation: 'install',
          packages: ['matplotlib'],
          result: 'success'
        } as unknown as NonNullable<NotebookEnvironmentManifest['operationLog']>[number],
        {
          operationId: 'versioned-install-2',
          timestamp: '2026-07-27T11:59:00.000Z',
          operation: 'install',
          packages: ['numpy'],
          result: 'success',
          attempts: [],
          fallbackUsed: false,
          inventoryRefresh: 'published',
          inventoryRefreshAttempts: [],
          packageChanges: [
            {
              name: 'numpy',
              ecosystem: 'python',
              relationship: 'requested',
              change: 'updated',
              beforeVersion: '2.1.0',
              afterVersion: '2.2.0',
              source: {
                type: 'github',
                repository: 'numpy/numpy',
                ref: 'v2.2.0',
                commit: 'abc123'
              }
            }
          ]
        }
      ],
      operationLogTruncation: {
        omittedCount: 4,
        earliestRetainedAt: '2026-07-27T11:58:00.000Z'
      },
      complete: true,
      captureStatus: 'complete'
    }
    const environmentManifestChecksum = createHash('sha256')
      .update(`${JSON.stringify(environmentManifest, null, 2)}\n`)
      .digest('hex')
    const baseRun = {
      cellId: 'cell-1',
      source: 'agent' as const,
      kernelKind: 'python' as const,
      status: 'completed' as const,
      startedAt: 1,
      endedAt: 2,
      text: { stdout: '', stderr: '', traceback: '', plain: [] },
      outputs: [],
      artifacts: [],
      workingFiles: [],
      environment: 'analysis-python',
      environmentCapture: {
        state: 'available' as const,
        manifestChecksum: environmentManifestChecksum
      },
      environmentManifest,
      environmentManifestChecksum,
      ...graph
    }
    const inputStorageKey =
      'uploads/project-1/source-session/upload-1/versions/upload-version-1/content'
    const inputContent = 'group\nA\n'
    const inputChecksum = createHash('sha256').update(inputContent).digest('hex')
    const inputPath = join(storageRoot, ...inputStorageKey.split('/'))
    await mkdir(dirname(inputPath), { recursive: true })
    await writeFile(inputPath, inputContent)
    await client.fileOriginSession.create({
      data: { projectId: 'project-1', sessionId: 'source-session' }
    })
    await client.uploadFile.create({
      data: {
        id: 'upload-1',
        projectId: 'project-1',
        sessionId: 'source-session',
        filename: 'groups.csv',
        originalFilename: 'groups.csv',
        versions: {
          create: {
            id: 'upload-version-1',
            versionNumber: 1,
            state: 'ready',
            contentStorageKey: inputStorageKey,
            filename: 'groups.csv',
            originalFilename: 'groups.csv',
            contentType: 'text/csv',
            sizeBytes: BigInt(Buffer.byteLength(inputContent)),
            checksum: inputChecksum,
            createdAt: new Date('2026-07-27T11:00:00.000Z')
          }
        }
      }
    })
    await client.uploadFile.update({
      where: { id: 'upload-1' },
      data: { currentVersionId: 'upload-version-1' }
    })
    const inputFile = {
      inputFileVersionId: 'upload-version-1',
      sourceKind: 'upload-version' as const,
      sourceFileId: 'upload-1',
      sourceVersionNumber: 1,
      sourceCreatedAt: '2026-07-27T11:00:00.000Z',
      sourceProjectId: 'project-1',
      sourceSessionId: 'source-session',
      filename: 'groups.csv',
      contentType: 'text/csv',
      sizeBytes: Buffer.byteLength(inputContent),
      checksum: inputChecksum,
      storageKey: inputStorageKey
    }
    const notebookDocument = await notebookRepository.loadOrCreate({
      projectId: 'project-1',
      sessionId: 'session-1',
      lane: createFrameNotebookLane('project-1', 'session-1', 'agent-frame-1'),
      workspaceCwd: '/workspace'
    })
    const producerSourcePath = join(notebookDocument.notebookSessionRoot, 'data', 'sin.png')
    await mkdir(dirname(producerSourcePath), { recursive: true })
    await writeFile(producerSourcePath, createPngBytes('plot bytes'))
    const producerSourceStat = await stat(producerSourcePath)
    await notebookRepository.appendRun({
      projectId: 'project-1',
      sessionId: 'session-1',
      lane: createFrameNotebookLane('project-1', 'session-1', 'agent-frame-1'),
      run: {
        ...baseRun,
        runId: 'notebook-run-1',
        script: 'x = 1',
        messageBranchId: 'branch-parent',
        promptMessageId: 'prompt-parent',
        inputFiles: [{ ...inputFile, association: 'turn-attached' }]
      }
    })
    await notebookRepository.appendRun({
      projectId: 'project-1',
      sessionId: 'session-1',
      lane: createFrameNotebookLane('project-1', 'session-1', 'agent-frame-1'),
      run: {
        ...baseRun,
        runId: 'notebook-run-sibling',
        cellId: 'cell-sibling',
        script: 'must_not_leak()',
        messageBranchId: 'branch-sibling',
        promptMessageId: 'prompt-sibling',
        inputFiles: []
      }
    })
    await notebookRepository.appendRun({
      projectId: 'project-1',
      sessionId: 'session-1',
      lane: createFrameNotebookLane('project-1', 'session-1', 'agent-frame-1'),
      run: {
        ...baseRun,
        runId: 'notebook-run-parent-after-fork',
        cellId: 'cell-parent-after-fork',
        script: 'must_not_leak_from_parent_suffix()',
        messageBranchId: 'branch-parent',
        promptMessageId: 'prompt-parent-after-fork',
        inputFiles: []
      }
    })
    await notebookRepository.appendRun({
      projectId: 'project-1',
      sessionId: 'session-1',
      lane: createFrameNotebookLane('project-1', 'session-1', 'agent-frame-1'),
      run: {
        ...baseRun,
        runId: 'notebook-run-2',
        cellId: 'cell-2',
        script: 'save_plot()',
        outputs: [
          { type: 'stream' as const, name: 'stdout' as const, text: 'x'.repeat(16_100) },
          { type: 'error' as const, name: 'ValueError', traceback: 'line one\nline two' },
          {
            type: 'display' as const,
            data: { 'text/plain': 'Sine plot', 'image/png': 'QUJD' }
          },
          {
            type: 'json' as const,
            data: [
              { x: 1, y: 2 },
              { x: 3, y: 4 }
            ]
          }
        ],
        workingFiles: [
          {
            path: producerSourcePath,
            relativePath: 'data/sin.png',
            kind: 'other',
            size: producerSourceStat.size,
            mtimeMs: producerSourceStat.mtimeMs,
            createdByRunId: 'notebook-run-2'
          }
        ],
        inputFiles: [{ ...inputFile, association: 'resolver-accessed' }]
      }
    })
    await client.computeJob.create({
      data: {
        id: 'compute-job-1',
        providerId: 'ssh:cluster',
        shape: 'scheduler_cluster',
        sessionId: 'session-1',
        projectId: 'project-1',
        producerRunId: 'notebook-run-2',
        status: 'success',
        intent: 'render the plot',
        command: 'python render.py --token must-not-leak',
        commandHash: 'compute-command-hash',
        fileEvidence: JSON.stringify({
          schemaVersion: 1,
          activityId: 'compute-job-1',
          activityKind: 'compute-job',
          parentActivityId: 'notebook-run-2',
          state: 'partial',
          evidenceId: 'execution-file-evidence-compute-job-1',
          checksum: 'd'.repeat(64),
          storageKey:
            'execution-file-evidence/project-1/session-1/activity-compute-job-1/evidence.json',
          relationCount: 2,
          generationCount: 2,
          scientificOutputCount: 1,
          initialViewState: 'complete',
          managedRootsFinalState: 'partial',
          scientificOutputAnalysis: 'complete',
          fileReads: 'unavailable',
          externalPaths: 'partial',
          writerAttribution: 'complete',
          reasonCodes: ['remote-input-generation-not-captured']
        })
      }
    })
    await client.computeJob.create({
      data: {
        id: 'compute-job-misbound',
        providerId: 'ssh:cluster',
        shape: 'scheduler_cluster',
        sessionId: 'session-1',
        projectId: 'project-1',
        producerRunId: 'notebook-run-2',
        status: 'success',
        intent: 'must fail closed',
        command: 'python forged.py --token must-not-leak-either',
        commandHash: 'misbound-compute-command-hash',
        fileEvidence: JSON.stringify({
          schemaVersion: 1,
          activityId: 'another-job',
          activityKind: 'compute-job',
          parentActivityId: 'notebook-run-2',
          state: 'partial',
          evidenceId: 'execution-file-evidence-another-job',
          checksum: 'e'.repeat(64),
          storageKey:
            'execution-file-evidence/project-1/session-1/activity-another-job/evidence.json',
          scientificOutputCount: 1,
          initialViewState: 'complete',
          managedRootsFinalState: 'partial',
          scientificOutputAnalysis: 'partial',
          fileReads: 'unavailable',
          externalPaths: 'partial',
          writerAttribution: 'complete',
          reasonCodes: []
        })
      }
    })
    await compatibilityRepository.writePendingFile({
      projectId: 'project-1',
      sessionId: 'artifact-session-1',
      runId: 'artifact-run-1',
      filename: 'sin.png',
      source: createPngInlineSource('plot bytes')
    })

    const version = await repository.createVersion({
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-1',
      artifactRunId: 'artifact-run-1',
      writeOperationId: 'write-1',
      writeRequestChecksum: 'c'.repeat(64),
      ...graph,
      messageBranchAncestry: ['branch-parent', 'branch-1'],
      messageAncestry: ['prompt-parent', 'prompt-1'],
      notebookSessionId: 'session-1',
      producerRunId: 'notebook-run-2',
      sourceFileObservation: {
        path: await realpath(producerSourcePath),
        sizeBytes: producerSourceStat.size,
        mtimeMs: producerSourceStat.mtimeMs
      },
      filename: 'sin.png',
      contentType: 'image/png'
    })
    const row = requireAgentArtifactVersion(
      await client.artifactVersion.findUniqueOrThrow({ where: { id: version.versionId } })
    )
    const evidence = JSON.parse(row.evidenceJson) as Record<string, unknown>
    const execution = JSON.parse(row.executionSnapshotJson ?? '{}') as {
      producerRunId: string
      producerRunIndex: number
      runs: Array<{ runId: string; script: string }>
      inputFiles: Array<{ inputFileVersionId: string; association: string }>
    }

    expect(row.producerRunId).toBe('notebook-run-2')
    expect(row.producerRunIndex).toBe(3)
    expect(evidence).toMatchObject({
      reproduction_code: 'save_plot()',
      producer: {
        state: 'available',
        notebook_session_id: 'session-1',
        producer_run_id: 'notebook-run-2',
        run_index: 3,
        kernel_kind: 'python'
      },
      execution_status: { state: 'available' },
      environment_status: { state: 'available' },
      environment: {
        capture_kind: 'completed-run',
        environment_name: 'analysis-python',
        kernel_kind: 'python',
        runtime_source: 'external',
        runtime_version: '3.13.2',
        packages: [
          expect.objectContaining({
            name: 'numpy',
            version: '2.2.0',
            loaded_state: 'loaded',
            source: {
              type: 'github',
              repository: 'numpy/numpy',
              ref: 'v2.2.0',
              commit: 'abc123'
            }
          })
        ],
        op_log: [
          expect.objectContaining({
            operation_id: 'legacy-install-1',
            attempts: [],
            fallback_used: false,
            inventory_refresh: 'published',
            inventory_refresh_attempts: []
          }),
          expect.objectContaining({
            operation_id: 'versioned-install-2',
            package_changes: [
              expect.objectContaining({
                name: 'numpy',
                relationship: 'requested',
                change: 'updated',
                before_version: '2.1.0',
                after_version: '2.2.0',
                source: {
                  type: 'github',
                  repository: 'numpy/numpy',
                  ref: 'v2.2.0',
                  commit: 'abc123'
                }
              })
            ]
          })
        ],
        op_log_truncation: {
          omitted_count: 4,
          earliest_retained_at: '2026-07-27T11:58:00.000Z'
        },
        source_manifest_checksum: environmentManifestChecksum,
        complete: true,
        capture_status: 'complete'
      },
      inputs: [
        {
          ordinal: 0,
          input_file_version_id: 'upload-version-1',
          source_kind: 'upload-version',
          strongest_association: 'resolver-accessed'
        }
      ],
      compute_executions: [
        {
          activity_id: 'compute-job-1',
          provider_id: 'ssh:cluster',
          shape: 'scheduler_cluster',
          status: 'success',
          file_evidence: {
            state: 'partial',
            evidence_id: 'execution-file-evidence-compute-job-1',
            checksum: 'd'.repeat(64),
            storage_key:
              'execution-file-evidence/project-1/session-1/activity-compute-job-1/evidence.json',
            generation_count: 2,
            reason_codes: ['remote-input-generation-not-captured']
          }
        },
        {
          activity_id: 'compute-job-misbound',
          provider_id: 'ssh:cluster',
          shape: 'scheduler_cluster',
          status: 'success',
          file_evidence: {
            state: 'unavailable',
            reason_codes: ['evidence-persistence-failed']
          }
        }
      ]
    })
    expect(row.evidenceJson).not.toContain('must-not-leak')
    expect(row.evidenceJson).not.toContain('must-not-leak-either')
    expect(execution.runs.map((run) => run.runId)).toEqual(['notebook-run-1', 'notebook-run-2'])
    expect(execution).toMatchObject({ producerRunId: 'notebook-run-2', producerRunIndex: 3 })
    expect(execution.inputFiles).toEqual([
      expect.objectContaining({
        inputFileVersionId: 'upload-version-1',
        association: 'resolver-accessed'
      })
    ])
    const executionProjection = await repository.getVersionExecution({
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactId: version.artifactId,
      versionId: version.versionId
    })
    expect(executionProjection.execution?.inputFiles).toEqual([
      expect.objectContaining({
        inputFileVersionId: 'upload-version-1',
        association: 'resolver-accessed',
        availability: { state: 'available' }
      })
    ])
    expect(executionProjection.execution?.inputFiles[0]).not.toHaveProperty('storageKey')
    expect(executionProjection.execution?.runs.at(-1)?.outputs).toEqual([
      expect.objectContaining({ type: 'text', truncated: true }),
      {
        type: 'error',
        name: 'ValueError',
        message: 'ValueError',
        traceback: ['line one', 'line two']
      },
      { type: 'text', text: 'Sine plot' },
      { type: 'omitted-media', mimeType: 'image/png', byteLength: 3 },
      {
        type: 'table',
        columns: ['x', 'y'],
        rowCount: 2,
        previewRows: [
          [1, 2],
          [3, 4]
        ]
      }
    ])
    const evidenceMirrorPath = join(storageRoot, ...row.evidenceStorageKey.split('/'))
    const executionMirrorPath = join(
      storageRoot,
      ...String(row.executionSnapshotStorageKey).split('/')
    )
    await Promise.all([rm(evidenceMirrorPath), rm(executionMirrorPath)])
    await expect(
      repository.getVersionExecution({
        projectId: 'project-1',
        appSessionId: 'session-1',
        artifactId: version.artifactId,
        versionId: version.versionId
      })
    ).resolves.toMatchObject({ execution: { producerRunId: 'notebook-run-2' } })
    await expect(stat(evidenceMirrorPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(executionMirrorPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await rm(inputPath)
    await expect(
      repository.getVersionExecution({
        projectId: 'project-1',
        appSessionId: 'session-1',
        artifactId: version.artifactId,
        versionId: version.versionId
      })
    ).resolves.toMatchObject({
      execution: {
        inputFiles: [{ availability: { state: 'unavailable', reason: 'input-content-missing' } }]
      }
    })
    await writeFile(inputPath, 'changed bytes')
    await expect(
      repository.getVersionExecution({
        projectId: 'project-1',
        appSessionId: 'session-1',
        artifactId: version.artifactId,
        versionId: version.versionId
      })
    ).resolves.toMatchObject({
      execution: {
        inputFiles: [{ availability: { state: 'unavailable', reason: 'input-content-corrupt' } }]
      }
    })
    await expect(
      client.artifactVersionInput.findMany({ where: { artifactVersionId: version.versionId } })
    ).resolves.toEqual([
      expect.objectContaining({
        inputFileVersionId: 'upload-version-1',
        sourceUploadVersionId: 'upload-version-1',
        strongestAssociation: 'resolver-accessed'
      })
    ])
    const lineage = await repository.getLineage({
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactId: version.artifactId
    })
    expect(lineage).toMatchObject({
      artifactId: version.artifactId,
      filename: 'sin.png',
      originSession: { sessionId: 'session-1', state: 'active' },
      versions: [{ versionId: version.versionId, versionNumber: 1 }]
    })
    if (!lineage) throw new Error('Expected Artifact lineage.')
    expect(lineage.versions[0]).not.toHaveProperty('path')
    expect(lineage.versions[0]).not.toHaveProperty('fileUrl')
    await expect(
      repository.getLineage({
        projectId: 'project-1',
        appSessionId: 'different-session',
        artifactId: version.artifactId
      })
    ).resolves.toBeUndefined()
    await expect(
      repository.getLineage({
        projectId: 'project-1',
        appSessionId: 'session-1',
        artifactId: 'session-1:message-1:sin.png'
      })
    ).resolves.toBeUndefined()
    await expect(
      repository.getVersionProvenance({
        projectId: 'project-1',
        appSessionId: 'different-session',
        artifactId: version.artifactId,
        versionId: version.versionId
      })
    ).rejects.toThrow(`Artifact Version not found: ${version.versionId}`)

    // An omitted producerRunId never infers a Notebook execution, even when only one run belongs to
    // the active turn. Provenance must distinguish an explicit producer association from a guess.
    await compatibilityRepository.writePendingFile({
      projectId: 'project-1',
      sessionId: 'artifact-session-1',
      runId: 'artifact-run-inferred',
      filename: 'inferred.png',
      source: createPngInlineSource('inferred plot bytes')
    })
    const inferred = await repository.createVersion({
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-1',
      artifactRunId: 'artifact-run-inferred',
      writeOperationId: 'write-inferred',
      writeRequestChecksum: 'd'.repeat(64),
      ...graph,
      messageBranchAncestry: ['branch-parent', 'branch-1'],
      messageAncestry: ['prompt-parent', 'prompt-1'],
      notebookSessionId: 'session-1',
      filename: 'inferred.png',
      contentType: 'image/png'
    })
    const inferredRow = requireAgentArtifactVersion(
      await client.artifactVersion.findUniqueOrThrow({ where: { id: inferred.versionId } })
    )
    expect(inferredRow).toMatchObject({ producerRunId: null, producerRunIndex: null })
    expect(JSON.parse(inferredRow.evidenceJson)).toMatchObject({
      producer: { state: 'unavailable', reason: 'producer-not-supplied' },
      execution_status: { state: 'unavailable', reason: 'producer-not-supplied' }
    })

    await notebookRepository.appendRun({
      projectId: 'project-1',
      sessionId: 'session-1',
      lane: createFrameNotebookLane('project-1', 'session-1', 'agent-frame-1'),
      run: {
        ...baseRun,
        runId: 'notebook-run-3',
        cellId: 'cell-3',
        script: 'save_another_plot()',
        inputFiles: []
      }
    })
    await compatibilityRepository.writePendingFile({
      projectId: 'project-1',
      sessionId: 'artifact-session-1',
      runId: 'artifact-run-ambiguous',
      filename: 'ambiguous.png',
      source: createPngInlineSource('ambiguous plot bytes')
    })
    const ambiguous = await repository.createVersion({
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-1',
      artifactRunId: 'artifact-run-ambiguous',
      writeOperationId: 'write-ambiguous',
      writeRequestChecksum: 'e'.repeat(64),
      ...graph,
      messageBranchAncestry: ['branch-parent', 'branch-1'],
      messageAncestry: ['prompt-parent', 'prompt-1'],
      notebookSessionId: 'session-1',
      sourceFileObservation: {
        // Keep the unverifiable hint outside the durable Notebook root on every platform. On macOS,
        // /var resolves through /private/var; relying on that alias made this fixture accidentally
        // exercise a different trust-boundary branch than Linux.
        path: join(storageRoot, 'unverifiable-source', 'ambiguous.png'),
        sizeBytes: Buffer.byteLength('ambiguous plot bytes'),
        mtimeMs: 1.5
      },
      filename: 'ambiguous.png',
      contentType: 'image/png'
    })
    const ambiguousRow = requireAgentArtifactVersion(
      await client.artifactVersion.findUniqueOrThrow({ where: { id: ambiguous.versionId } })
    )
    expect(ambiguousRow).toMatchObject({ producerRunId: null, producerRunIndex: null })
    expect(JSON.parse(ambiguousRow.evidenceJson)).toMatchObject({
      producer: { state: 'unavailable', reason: 'producer-source-unverifiable' },
      execution_status: { state: 'unavailable', reason: 'producer-source-unverifiable' }
    })

    await client.review.createMany({
      data: [
        {
          id: 'review-direct-flagged',
          projectId: 'project-1',
          sessionId: 'session-1',
          turnMessageId: 'prompt-1',
          scope: JSON.stringify({
            turnMessageId: 'prompt-1',
            blocks: [],
            artifactVersionIds: [version.versionId]
          }),
          lifecycle: 'complete',
          outcome: 'flagged',
          reviewerLog: '[]',
          createdAt: new Date('2026-07-27T10:00:00Z'),
          updatedAt: new Date('2026-07-27T10:00:00Z')
        },
        {
          id: 'review-direct-pass',
          projectId: 'project-1',
          sessionId: 'session-1',
          turnMessageId: 'prompt-1',
          scope: JSON.stringify({
            turnMessageId: 'prompt-1',
            blocks: [],
            artifactVersionIds: [version.versionId]
          }),
          lifecycle: 'complete',
          outcome: 'pass',
          reviewerLog: '[]',
          createdAt: new Date('2026-07-27T10:01:00Z'),
          updatedAt: new Date('2026-07-27T10:01:00Z')
        }
      ]
    })
    await client.finding.createMany({
      data: [
        {
          id: 'finding-direct-flagged',
          reviewId: 'review-direct-flagged',
          status: 'fail',
          claim: 'Artifact row count does not match.',
          evidence: 'The first assessment observed 12 rows.',
          artifactVersionId: version.versionId,
          artifactBindingState: 'scope_validated'
        },
        {
          id: 'finding-direct-pass',
          reviewId: 'review-direct-pass',
          status: 'pass',
          claim: 'Artifact values match the execution output.',
          evidence: 'Recomputed from the immutable Artifact Version.',
          artifactVersionId: version.versionId,
          artifactBindingState: 'scope_validated'
        }
      ]
    })
    await client.reviewFindingDisposition.create({
      data: {
        id: 'disposition-direct-pass',
        sourceFindingId: 'finding-direct-flagged',
        causeReviewId: 'review-direct-pass',
        sequence: 1,
        trigger: 'review_submission',
        outcome: 'resolved',
        assessedArtifactVersionId: version.versionId,
        assessmentSnapshot: JSON.stringify({
          schemaVersion: 1,
          status: 'pass',
          claim: 'Round 2 row count is corrected.',
          evidence: 'Round 2 observed all 33 rows.',
          artifactVersionId: version.versionId,
          sortIndex: 1
        })
      }
    })
    await expect(
      repository.getVersionProvenance({
        projectId: 'project-1',
        appSessionId: 'session-1',
        artifactId: version.artifactId,
        versionId: version.versionId
      })
    ).resolves.toMatchObject({
      descriptor: { versionId: version.versionId },
      evidence: { reproduction_code: 'save_plot()' },
      execution: { producerRunId: 'notebook-run-2' },
      review: {
        state: 'available',
        value: {
          binding: 'version',
          selectedVersionAssessment: {
            id: 'review-direct-pass',
            submittedChecks: [
              { kind: 'new', check: { id: 'finding-direct-pass' } },
              {
                kind: 'tracked',
                sourceFindingId: 'finding-direct-flagged',
                assessedArtifactVersionId: version.versionId
              }
            ]
          },
          currentDirectAssessment: {
            id: 'review-direct-pass',
            outcome: 'pass',
            submittedChecks: [
              { kind: 'new', check: { id: 'finding-direct-pass' } },
              {
                kind: 'tracked',
                sourceFindingId: 'finding-direct-flagged',
                dispositionOutcome: 'resolved',
                assessment: {
                  status: 'pass',
                  claim: 'Round 2 row count is corrected.',
                  evidence: 'Round 2 observed all 33 rows.',
                  artifactVersionId: version.versionId,
                  sortIndex: 1
                }
              }
            ]
          },
          latestChainReview: { id: 'review-direct-pass', outcome: 'pass' },
          selectedVersionChecks: [{ artifactBindingState: 'scope_validated' }],
          history: expect.arrayContaining([
            expect.objectContaining({
              kind: 'review',
              review: expect.objectContaining({
                id: 'review-direct-flagged',
                submittedChecks: expect.arrayContaining([
                  expect.objectContaining({
                    kind: 'new',
                    check: expect.objectContaining({
                      claim: 'Artifact row count does not match.'
                    })
                  })
                ])
              })
            }),
            expect.objectContaining({
              kind: 'review',
              review: expect.objectContaining({
                id: 'review-direct-pass',
                submittedChecks: expect.arrayContaining([
                  expect.objectContaining({
                    kind: 'tracked',
                    assessment: expect.objectContaining({
                      claim: 'Round 2 row count is corrected.'
                    })
                  })
                ])
              })
            })
          ])
        }
      }
    })

    const invalidExecutionJson = JSON.stringify({
      ...(JSON.parse(row.executionSnapshotJson ?? '{}') as Record<string, unknown>),
      producerRunIndex: 2
    })
    const invalidExecutionChecksum = createHash('sha256').update(invalidExecutionJson).digest('hex')
    const invalidEvidenceJson = JSON.stringify({
      ...(JSON.parse(row.evidenceJson) as Record<string, unknown>),
      execution_snapshot_checksum: invalidExecutionChecksum
    })
    await client.artifactVersion.update({
      where: { id: version.versionId },
      data: {
        executionSnapshotJson: invalidExecutionJson,
        executionSnapshotChecksum: invalidExecutionChecksum,
        evidenceJson: invalidEvidenceJson,
        evidenceChecksum: createHash('sha256').update(invalidEvidenceJson).digest('hex')
      }
    })
    await writeFile(
      join(storageRoot, ...String(row.executionSnapshotStorageKey).split('/')),
      invalidExecutionJson
    )
    await writeFile(join(storageRoot, ...row.evidenceStorageKey.split('/')), invalidEvidenceJson)
    await expect(
      repository.getVersionExecution({
        projectId: 'project-1',
        appSessionId: 'session-1',
        artifactId: version.artifactId,
        versionId: version.versionId
      })
    ).rejects.toThrow(/execution snapshot metadata mismatch/i)

    const originalExecution = JSON.parse(row.executionSnapshotJson ?? '{}') as Record<
      string,
      unknown
    >
    const originalInputs = originalExecution.inputFiles as Array<Record<string, unknown>>
    const invalidInputExecutionJson = JSON.stringify({
      ...originalExecution,
      inputFiles: [{ ...originalInputs[0], inputFileVersionId: 'forged-upload-version' }]
    })
    const invalidInputExecutionChecksum = createHash('sha256')
      .update(invalidInputExecutionJson)
      .digest('hex')
    const invalidInputEvidenceJson = JSON.stringify({
      ...(JSON.parse(row.evidenceJson) as Record<string, unknown>),
      execution_snapshot_checksum: invalidInputExecutionChecksum
    })
    await client.artifactVersion.update({
      where: { id: version.versionId },
      data: {
        executionSnapshotJson: invalidInputExecutionJson,
        executionSnapshotChecksum: invalidInputExecutionChecksum,
        evidenceJson: invalidInputEvidenceJson,
        evidenceChecksum: createHash('sha256').update(invalidInputEvidenceJson).digest('hex')
      }
    })
    await writeFile(
      join(storageRoot, ...String(row.executionSnapshotStorageKey).split('/')),
      invalidInputExecutionJson
    )
    await writeFile(
      join(storageRoot, ...row.evidenceStorageKey.split('/')),
      invalidInputEvidenceJson
    )
    await expect(
      repository.getVersionExecution({
        projectId: 'project-1',
        appSessionId: 'session-1',
        artifactId: version.artifactId,
        versionId: version.versionId
      })
    ).rejects.toThrow(/execution snapshot input metadata mismatch/i)
  })

  it('rejects an omitted Notebook producer when mtime is the only association', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-artifact-auto-producer-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)

    const compatibilityRepository = new ArtifactRepository(storageRoot)
    const notebookRepository = new NotebookRunRepository(storageRoot)
    const repository = new ArtifactProvenanceRepository({
      storageRoot,
      getClient: () => Promise.resolve(client),
      compatibilityRepository,
      notebookRepository
    })
    const graph = {
      rootFrameId: 'root-frame-1',
      agentFrameId: 'agent-frame-1',
      messageBranchId: 'branch-1',
      runtimeSegmentId: 'runtime-segment-1',
      promptMessageId: 'prompt-1'
    }
    const document = await notebookRepository.loadOrCreate({
      projectId: 'project-1',
      sessionId: 'session-1',
      lane: createFrameNotebookLane('project-1', 'session-1', 'agent-frame-1'),
      workspaceCwd: '/workspace'
    })
    const sourcePath = join(document.notebookSessionRoot, 'data', 'sin.png')
    const content = createPngBytes('plot bytes')
    await mkdir(dirname(sourcePath), { recursive: true })
    await writeFile(sourcePath, content)
    const sourceStat = await stat(sourcePath)
    const resolvedSourcePath = await realpath(sourcePath)
    const baseRun = {
      cellId: 'cell-1',
      source: 'agent' as const,
      kernelKind: 'python' as const,
      status: 'completed' as const,
      text: { stdout: '', stderr: '', traceback: '', plain: [] },
      outputs: [],
      artifacts: [],
      workingFiles: [],
      inputFiles: [],
      ...graph
    }
    await notebookRepository.appendRun({
      projectId: 'project-1',
      sessionId: 'session-1',
      lane: createFrameNotebookLane('project-1', 'session-1', 'agent-frame-1'),
      run: {
        ...baseRun,
        runId: 'notebook-run-before',
        script: 'unrelated()',
        startedAt: sourceStat.mtimeMs - 300,
        endedAt: sourceStat.mtimeMs - 200
      }
    })
    await notebookRepository.appendRun({
      projectId: 'project-1',
      sessionId: 'session-1',
      lane: createFrameNotebookLane('project-1', 'session-1', 'agent-frame-1'),
      run: {
        ...baseRun,
        runId: 'notebook-run-producer',
        cellId: 'cell-producer',
        script: 'save_plot("sin.png")',
        startedAt: sourceStat.mtimeMs - 100,
        endedAt: sourceStat.mtimeMs + 100
      }
    })
    await compatibilityRepository.writePendingFile({
      projectId: 'project-1',
      sessionId: 'artifact-session-1',
      runId: 'artifact-run-1',
      filename: 'sin.png',
      source: { kind: 'inline', content: content.toString('base64'), encoding: 'base64' }
    })

    await expect(
      repository.createVersion({
        projectId: 'project-1',
        appSessionId: 'session-1',
        artifactStorageSessionId: 'artifact-session-1',
        artifactRunId: 'artifact-run-1',
        writeOperationId: 'write-auto-producer',
        writeRequestChecksum: 'f'.repeat(64),
        ...graph,
        notebookSessionId: 'session-1',
        sourceFileObservation: {
          path: resolvedSourcePath,
          sizeBytes: sourceStat.size,
          mtimeMs: sourceStat.mtimeMs
        },
        filename: 'sin.png',
        contentType: 'image/png'
      })
    ).rejects.toThrow('Notebook source must have exactly one eligible Run owner.')
    await expect(
      repository.listRunVersions({
        projectId: 'project-1',
        appSessionId: 'session-1',
        artifactRunId: 'artifact-run-1'
      })
    ).resolves.toEqual([])
  })

  it('bounds execution evidence while retaining the producer run', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-artifact-bounded-execution-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)

    const compatibilityRepository = new ArtifactRepository(storageRoot)
    const notebookRepository = new NotebookRunRepository(storageRoot)
    const repository = new ArtifactProvenanceRepository({
      storageRoot,
      getClient: () => Promise.resolve(client),
      compatibilityRepository,
      notebookRepository
    })
    const graph = {
      rootFrameId: 'root-frame-1',
      agentFrameId: 'agent-frame-1',
      messageBranchId: 'branch-1',
      runtimeSegmentId: 'runtime-segment-1',
      promptMessageId: 'prompt-1'
    }
    const document = await notebookRepository.loadOrCreate({
      projectId: 'project-1',
      sessionId: 'session-1',
      lane: createFrameNotebookLane('project-1', 'session-1', 'agent-frame-1'),
      workspaceCwd: '/workspace'
    })
    const sourcePath = join(document.notebookSessionRoot, 'data', 'bounded.png')
    const content = createPngBytes('bounded execution')
    await mkdir(dirname(sourcePath), { recursive: true })
    await writeFile(sourcePath, content)
    const sourceStat = await stat(sourcePath)
    const producerRunId = 'notebook-run-129'

    for (let index = 0; index < 130; index += 1) {
      const runId = `notebook-run-${index}`
      await notebookRepository.appendRun({
        projectId: 'project-1',
        sessionId: 'session-1',
        lane: createFrameNotebookLane('project-1', 'session-1', 'agent-frame-1'),
        run: {
          runId,
          cellId: `cell-${index}`,
          source: 'agent',
          kernelKind: 'python',
          status: 'completed',
          startedAt: sourceStat.mtimeMs - 1_000 + index,
          endedAt: sourceStat.mtimeMs - 999 + index,
          script: index === 129 ? 'save_plot("bounded.png")' : `step(${index})`,
          text: { stdout: '', stderr: '', traceback: '', plain: [] },
          outputs: Array.from({ length: 3 }, (_, outputIndex) => ({
            type: 'stream' as const,
            name: 'stdout' as const,
            text: `run ${index} output ${outputIndex}`
          })),
          artifacts: [],
          workingFiles:
            index === 129
              ? [
                  {
                    path: sourcePath,
                    relativePath: 'data/bounded.png',
                    kind: 'other' as const,
                    size: sourceStat.size,
                    mtimeMs: sourceStat.mtimeMs,
                    createdByRunId: producerRunId
                  }
                ]
              : [],
          inputFiles: [],
          ...graph
        }
      })
    }
    await compatibilityRepository.writePendingFile({
      projectId: 'project-1',
      sessionId: 'artifact-session-1',
      runId: 'artifact-run-1',
      filename: 'bounded.png',
      source: { kind: 'inline', content: content.toString('base64'), encoding: 'base64' }
    })

    const version = await repository.createVersion({
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-1',
      artifactRunId: 'artifact-run-1',
      writeOperationId: 'write-bounded-execution',
      writeRequestChecksum: 'e'.repeat(64),
      ...graph,
      messageBranchAncestry: ['branch-1'],
      messageAncestry: ['prompt-1'],
      notebookSessionId: 'session-1',
      producerRunId,
      sourceFileObservation: {
        path: await realpath(sourcePath),
        sizeBytes: sourceStat.size,
        mtimeMs: sourceStat.mtimeMs
      },
      filename: 'bounded.png',
      contentType: 'image/png'
    })
    const row = await client.artifactVersion.findUniqueOrThrow({
      where: { id: version.versionId }
    })
    const executionJson = row.executionSnapshotJson ?? ''
    const execution = JSON.parse(executionJson) as {
      producerRunId: string
      runs: Array<{ runId: string; outputs: unknown[] }>
      truncation: {
        reason: string
        omittedLeadingRunCount: number
        omittedOutputCount: number
        omittedInputCount: number
      }
    }

    expect(Buffer.byteLength(executionJson, 'utf8')).toBeLessThanOrEqual(4 * 1024 * 1024)
    expect(execution.producerRunId).toBe(producerRunId)
    expect(execution.runs).toHaveLength(128)
    expect(execution.runs.at(-1)?.runId).toBe(producerRunId)
    expect(execution.runs.reduce((count, run) => count + run.outputs.length, 0)).toBe(256)
    expect(execution.truncation).toEqual({
      reason: 'payload-limit',
      omittedLeadingRunCount: 2,
      omittedOutputCount: 128,
      omittedInputCount: 0
    })
  })

  it('uses exact observed ownership and scope-validates an inline producer declaration', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-artifact-producer-mismatch-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)

    const compatibilityRepository = new ArtifactRepository(storageRoot)
    const notebookRepository = new NotebookRunRepository(storageRoot)
    const repository = new ArtifactProvenanceRepository({
      storageRoot,
      getClient: () => Promise.resolve(client),
      compatibilityRepository,
      notebookRepository
    })
    const graph = {
      rootFrameId: 'root-frame-1',
      agentFrameId: 'agent-frame-1',
      messageBranchId: 'branch-1',
      runtimeSegmentId: 'runtime-segment-1',
      promptMessageId: 'prompt-1'
    }
    const document = await notebookRepository.loadOrCreate({
      projectId: 'project-1',
      sessionId: 'session-1',
      lane: createFrameNotebookLane('project-1', 'session-1', 'agent-frame-1'),
      workspaceCwd: '/workspace'
    })
    const sourcePath = join(document.notebookSessionRoot, 'data', 'plot.png')
    await mkdir(dirname(sourcePath), { recursive: true })
    await writeFile(sourcePath, createPngBytes('plot bytes'))
    const sourceStat = await stat(sourcePath)
    const commonRun = {
      source: 'agent' as const,
      kernelKind: 'python' as const,
      status: 'completed' as const,
      startedAt: sourceStat.mtimeMs - 100,
      endedAt: sourceStat.mtimeMs + 100,
      text: { stdout: '', stderr: '', traceback: '', plain: [] },
      outputs: [],
      artifacts: [],
      inputFiles: [],
      ...graph
    }
    await notebookRepository.appendRun({
      projectId: 'project-1',
      sessionId: 'session-1',
      lane: createFrameNotebookLane('project-1', 'session-1', 'agent-frame-1'),
      run: {
        ...commonRun,
        runId: 'notebook-run-owner',
        cellId: 'cell-owner',
        script: 'save_plot()',
        workingFiles: [
          {
            path: sourcePath,
            relativePath: 'data/plot.png',
            kind: 'other',
            size: sourceStat.size,
            mtimeMs: sourceStat.mtimeMs,
            createdByRunId: 'notebook-run-owner'
          }
        ]
      }
    })
    await notebookRepository.appendRun({
      projectId: 'project-1',
      sessionId: 'session-1',
      lane: createFrameNotebookLane('project-1', 'session-1', 'agent-frame-1'),
      run: {
        ...commonRun,
        runId: 'notebook-run-wrong',
        cellId: 'cell-wrong',
        script: 'unrelated()',
        workingFiles: []
      }
    })
    await compatibilityRepository.writePendingFile({
      projectId: 'project-1',
      sessionId: 'artifact-session-1',
      runId: 'artifact-run-1',
      filename: 'plot.png',
      source: createPngInlineSource('plot bytes')
    })

    const sourceFileObservation = {
      path: await realpath(sourcePath),
      sizeBytes: sourceStat.size,
      mtimeMs: sourceStat.mtimeMs
    }
    const inferred = await repository.createVersion({
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-1',
      artifactRunId: 'artifact-run-1',
      writeOperationId: 'write-producer-inferred',
      writeRequestChecksum: 'b'.repeat(64),
      ...graph,
      notebookSessionId: 'session-1',
      sourceFileObservation,
      filename: 'plot.png',
      contentType: 'image/png'
    })
    const inferredRow = requireAgentArtifactVersion(
      await client.artifactVersion.findUniqueOrThrow({ where: { id: inferred.versionId } })
    )
    expect(inferredRow).toMatchObject({
      producerRunId: 'notebook-run-owner',
      producerRunIndex: 0
    })
    expect(JSON.parse(inferredRow.evidenceJson)).toMatchObject({
      producer: {
        state: 'available',
        producer_run_id: 'notebook-run-owner',
        association_method: 'server-inferred-file-observation'
      }
    })

    await expect(
      repository.createVersion({
        projectId: 'project-1',
        appSessionId: 'session-1',
        artifactStorageSessionId: 'artifact-session-1',
        artifactRunId: 'artifact-run-1',
        writeOperationId: 'write-producer-mismatch',
        writeRequestChecksum: 'a'.repeat(64),
        ...graph,
        notebookSessionId: 'session-1',
        producerRunId: 'notebook-run-wrong',
        sourceFileObservation,
        filename: 'plot.png',
        contentType: 'image/png'
      })
    ).rejects.toThrow(/producer.*source.*another Notebook run/i)
    await expect(client.artifactVersion.count()).resolves.toBe(1)

    await compatibilityRepository.writePendingFile({
      projectId: 'project-1',
      sessionId: 'artifact-session-1',
      runId: 'artifact-run-1',
      filename: 'cross-frame.png',
      source: createPngInlineSource('cross-frame bytes')
    })
    await expect(
      repository.createVersion({
        projectId: 'project-1',
        appSessionId: 'session-1',
        artifactStorageSessionId: 'artifact-session-1',
        artifactRunId: 'artifact-run-1',
        writeOperationId: 'write-cross-frame-producer',
        writeRequestChecksum: 'f'.repeat(64),
        ...graph,
        agentFrameId: 'parent-frame-1',
        notebookSessionId: 'session-1',
        producerRunId: 'notebook-run-owner',
        sourceKind: 'inline',
        filename: 'cross-frame.png',
        contentType: 'image/png'
      })
    ).rejects.toThrow(
      'Notebook producer run belongs to a different agent frame. Have the producing agent publish it directly, or reference an already completed Artifact Version.'
    )

    await compatibilityRepository.writePendingFile({
      projectId: 'project-1',
      sessionId: 'artifact-session-1',
      runId: 'artifact-run-1',
      filename: 'spoof.png',
      source: createPngInlineSource('different artifact bytes')
    })
    await expect(
      repository.createVersion({
        projectId: 'project-1',
        appSessionId: 'session-1',
        artifactStorageSessionId: 'artifact-session-1',
        artifactRunId: 'artifact-run-1',
        writeOperationId: 'write-spoofed-source-observation',
        writeRequestChecksum: 'e'.repeat(64),
        ...graph,
        notebookSessionId: 'session-1',
        producerRunId: 'notebook-run-owner',
        sourceFileObservation,
        filename: 'spoof.png',
        contentType: 'image/png'
      })
    ).rejects.toThrow('Notebook producer source could not be verified: notebook-run-owner')
    await expect(
      repository.listRunVersions({
        projectId: 'project-1',
        appSessionId: 'session-1',
        artifactRunId: 'artifact-run-1'
      })
    ).resolves.toHaveLength(1)

    await compatibilityRepository.writePendingFile({
      projectId: 'project-1',
      sessionId: 'artifact-session-1',
      runId: 'artifact-run-1',
      filename: 'inline.png',
      source: createPngInlineSource('model supplied bytes')
    })
    const inline = await repository.createVersion({
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-1',
      artifactRunId: 'artifact-run-1',
      writeOperationId: 'write-inline-producer-declaration',
      writeRequestChecksum: 'd'.repeat(64),
      ...graph,
      notebookSessionId: 'session-1',
      producerRunId: 'notebook-run-owner',
      sourceKind: 'inline',
      filename: 'inline.png',
      contentType: 'image/png'
    })
    const inlineRow = requireAgentArtifactVersion(
      await client.artifactVersion.findUniqueOrThrow({ where: { id: inline.versionId } })
    )
    expect(inlineRow).toMatchObject({
      producerRunId: 'notebook-run-owner',
      producerRunIndex: 0
    })
    expect(JSON.parse(inlineRow.evidenceJson)).toMatchObject({
      producer: {
        state: 'available',
        producer_run_id: 'notebook-run-owner',
        association_method: 'agent-declared-and-session-validated'
      },
      execution_status: { state: 'available' }
    })

    await compatibilityRepository.writePendingFile({
      projectId: 'project-1',
      sessionId: 'artifact-session-1',
      runId: 'artifact-run-1',
      filename: 'unobserved-local.png',
      source: createPngInlineSource('unobserved local bytes')
    })
    await expect(
      repository.createVersion({
        projectId: 'project-1',
        appSessionId: 'session-1',
        artifactStorageSessionId: 'artifact-session-1',
        artifactRunId: 'artifact-run-1',
        writeOperationId: 'write-unobserved-local-producer',
        writeRequestChecksum: 'c'.repeat(64),
        ...graph,
        notebookSessionId: 'session-1',
        producerRunId: 'notebook-run-owner',
        sourceKind: 'localPath',
        filename: 'unobserved-local.png',
        contentType: 'image/png'
      })
    ).rejects.toThrow('Notebook producer source observation is required: notebook-run-owner')
    await expect(
      repository.listRunVersions({
        projectId: 'project-1',
        appSessionId: 'session-1',
        artifactRunId: 'artifact-run-1'
      })
    ).resolves.toHaveLength(2)
  })

  it('rejects a renderer-supplied message that the durable Conversation Graph does not own', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-artifact-finalize-ownership-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)

    const prompt = {
      id: 'prompt-1',
      role: 'user' as const,
      content: 'draw',
      status: 'complete' as const,
      eventIds: [],
      createdAt: 1,
      updatedAt: 1
    }
    const assistant = {
      id: 'message-1',
      role: 'agent' as const,
      content: 'done',
      status: 'complete' as const,
      eventIds: [],
      createdAt: 2,
      updatedAt: 2
    }
    const conversationGraph = createLinearConversationGraph({
      sessionId: 'session-1',
      messages: [prompt, assistant],
      frameworkId: 'codex',
      createdAt: 1,
      updatedAt: 2
    })
    const session: PersistedChatSession = {
      id: 'session-1',
      projectId: 'project-1',
      title: 'Ownership',
      cwd: '/workspace',
      status: 'idle',
      messages: [prompt, assistant],
      conversationGraph,
      createdAt: 1,
      updatedAt: 2
    }
    const compatibilityRepository = new ArtifactRepository(storageRoot)
    const repository = new ArtifactProvenanceRepository({
      storageRoot,
      getClient: () => Promise.resolve(client),
      compatibilityRepository,
      loadSession: async () => session
    })
    const branch = conversationGraph.branches[0]
    const context = {
      rootFrameId: conversationGraph.rootFrameId,
      agentFrameId: conversationGraph.activeFrameId,
      messageBranchId: branch.id,
      runtimeSegmentId: conversationGraph.runtimeSegments[0].id,
      promptMessageId: prompt.id
    }
    await compatibilityRepository.writePendingFile({
      projectId: 'project-1',
      sessionId: 'artifact-session-1',
      runId: 'artifact-run-1',
      filename: 'sin.png',
      source: createPngInlineSource('plot bytes')
    })
    const version = await repository.createVersion({
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-1',
      artifactRunId: 'artifact-run-1',
      writeOperationId: 'write-1',
      writeRequestChecksum: 'a'.repeat(64),
      ...context,
      filename: 'sin.png'
    })

    const ownershipRequest = {
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactRunId: 'artifact-run-1',
      artifactVersionIds: [version.versionId],
      ...context,
      messageId: assistant.id
    }
    await expect(
      repository.validateFinalizationOwnership({
        ...ownershipRequest,
        rootFrameId: 'root-frame-forged'
      })
    ).rejects.toMatchObject({ reasonCode: 'root-frame-mismatch' })
    await expect(
      repository.validateFinalizationOwnership({
        ...ownershipRequest,
        agentFrameId: 'agent-frame-forged'
      })
    ).rejects.toMatchObject({ reasonCode: 'branch-frame-mismatch' })
    await expect(
      repository.validateFinalizationOwnership({
        ...ownershipRequest,
        runtimeSegmentId: 'runtime-segment-forged'
      })
    ).rejects.toMatchObject({ reasonCode: 'runtime-segment-missing' })

    await expect(
      repository.finalizeRun({
        ...ownershipRequest,
        messageId: 'message-forged',
        messageBranchAncestry: [branch.id],
        messageAncestry: [prompt.id, 'message-forged']
      })
    ).rejects.toMatchObject({
      name: 'ArtifactOwnershipPersistenceRaceError',
      reasonCode: 'message-not-durable'
    })

    const durablePrompt = conversationGraph.messages.find((message) => message.id === prompt.id)!
    durablePrompt.status = 'streaming'
    await expect(
      repository.finalizeRun({
        projectId: 'project-1',
        appSessionId: 'session-1',
        artifactRunId: 'artifact-run-1',
        artifactVersionIds: [version.versionId],
        ...context,
        messageId: assistant.id
      })
    ).rejects.toMatchObject({
      name: 'ArtifactFinalizationProofError',
      reasonCode: 'prompt-ownership-mismatch'
    })

    durablePrompt.status = 'complete'
    const durableAssistant = conversationGraph.messages.find(
      (message) => message.id === assistant.id
    )!
    durableAssistant.role = 'user'
    await expect(
      repository.validateFinalizationOwnership({
        projectId: 'project-1',
        appSessionId: 'session-1',
        artifactRunId: 'artifact-run-1',
        artifactVersionIds: [version.versionId],
        ...context,
        messageId: assistant.id
      })
    ).rejects.toMatchObject({
      name: 'ArtifactFinalizationProofError',
      reasonCode: 'message-ownership-mismatch'
    })

    durableAssistant.role = 'agent'
    durableAssistant.status = 'streaming'
    await expect(
      repository.validateFinalizationOwnership({
        projectId: 'project-1',
        appSessionId: 'session-1',
        artifactRunId: 'artifact-run-1',
        artifactVersionIds: [version.versionId],
        ...context,
        messageId: assistant.id
      })
    ).resolves.toBeUndefined()

    await expect(
      client.artifactVersion.findUniqueOrThrow({ where: { id: version.versionId } })
    ).resolves.toMatchObject({ state: 'pending', messageId: null })
  })

  it('finalizes every same-turn Version to one immutable message owner and replays idempotently', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-artifact-finalize-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)

    const prompt = {
      id: 'prompt-1',
      role: 'user' as const,
      content: 'draw',
      status: 'complete' as const,
      eventIds: [],
      createdAt: 1,
      updatedAt: 1
    }
    const assistant = {
      id: 'message-1',
      role: 'agent' as const,
      content: 'done',
      status: 'complete' as const,
      eventIds: [],
      createdAt: 2,
      updatedAt: 2
    }
    const conversationGraph = createLinearConversationGraph({
      sessionId: 'session-1',
      messages: [prompt, assistant],
      frameworkId: 'codex',
      createdAt: 1,
      updatedAt: 2
    })
    const session: PersistedChatSession = {
      id: 'session-1',
      projectId: 'project-1',
      title: 'Finalize',
      cwd: '/workspace',
      status: 'idle',
      messages: [prompt, assistant],
      conversationGraph,
      createdAt: 1,
      updatedAt: 2
    }
    const compatibilityRepository = new ArtifactRepository(storageRoot)
    const repository = new ArtifactProvenanceRepository({
      storageRoot,
      getClient: () => Promise.resolve(client),
      compatibilityRepository,
      loadSession: async () => session
    })
    const common = {
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-1',
      artifactRunId: 'artifact-run-1',
      rootFrameId: conversationGraph.rootFrameId,
      agentFrameId: conversationGraph.activeFrameId,
      messageBranchId: conversationGraph.branches[0].id,
      runtimeSegmentId: conversationGraph.runtimeSegments[0].id,
      promptMessageId: prompt.id,
      filename: 'sin.png'
    } as const

    for (const [index, content] of ['first', 'second', 'interrupted'].entries()) {
      await compatibilityRepository.writePendingFile({
        projectId: common.projectId,
        sessionId: common.artifactStorageSessionId,
        runId: common.artifactRunId,
        filename: common.filename,
        source: createPngInlineSource(content)
      })
      await repository.createVersion({
        ...common,
        writeOperationId: `write-${index + 1}`,
        writeRequestChecksum: String(index + 1).repeat(64)
      })
    }
    const interrupted = await client.artifactVersion.findFirstOrThrow({
      where: { artifactRunId: common.artifactRunId, versionNumber: 3 }
    })
    await client.artifactVersion.update({
      where: { id: interrupted.id },
      data: { state: 'staging' }
    })
    const finalizableVersions = await client.artifactVersion.findMany({
      where: { artifactRunId: common.artifactRunId, state: 'pending' },
      orderBy: { versionNumber: 'asc' }
    })

    const finalizeRequest = {
      projectId: common.projectId,
      appSessionId: common.appSessionId,
      artifactRunId: common.artifactRunId,
      artifactVersionIds: finalizableVersions.map((version) => version.id),
      rootFrameId: common.rootFrameId,
      agentFrameId: common.agentFrameId,
      messageBranchId: common.messageBranchId,
      runtimeSegmentId: common.runtimeSegmentId,
      promptMessageId: common.promptMessageId,
      messageId: 'message-1'
    }
    await expect(
      repository.finalizeRun({ ...finalizeRequest, artifactVersionIds: [] })
    ).rejects.toMatchObject({
      reasonCode: 'version-ids-missing',
      message: expect.stringMatching(/Artifact Version ids/i)
    })
    await expect(
      repository.finalizeRun({
        ...finalizeRequest,
        artifactVersionIds: [
          finalizeRequest.artifactVersionIds[0],
          finalizeRequest.artifactVersionIds[0]
        ]
      })
    ).rejects.toMatchObject({ reasonCode: 'version-ids-duplicate' })
    await expect(
      repository.finalizeRun({
        ...finalizeRequest,
        artifactVersionIds: [finalizeRequest.artifactVersionIds[0]]
      })
    ).rejects.toMatchObject({
      reasonCode: 'version-omitted-from-claim',
      message: expect.stringMatching(/omitted from the finalization claim/i)
    })
    await expect(
      repository.finalizeRun({
        ...finalizeRequest,
        artifactVersionIds: [...finalizeRequest.artifactVersionIds, 'version-not-in-run']
      })
    ).rejects.toMatchObject({
      reasonCode: 'version-not-eligible',
      message: expect.stringMatching(/no longer eligible/i)
    })
    const ancestryProbe = await client.artifactVersion.findFirstOrThrow({
      where: { artifactRunId: common.artifactRunId, versionNumber: 1 }
    })
    await client.artifactVersion.update({
      where: { id: ancestryProbe.id },
      data: { state: 'finalized', messageId: 'message-other' }
    })
    await expect(repository.finalizeRun(finalizeRequest)).rejects.toMatchObject({
      reasonCode: 'version-message-conflict'
    })
    await client.artifactVersion.update({
      where: { id: ancestryProbe.id },
      data: { state: ancestryProbe.state, messageId: ancestryProbe.messageId }
    })

    const invalidEvidence = '{}'
    await client.artifactVersion.update({
      where: { id: ancestryProbe.id },
      data: {
        evidenceJson: invalidEvidence,
        evidenceChecksum: createHash('sha256').update(invalidEvidence).digest('hex')
      }
    })
    await expect(repository.finalizeRun(finalizeRequest)).rejects.toMatchObject({
      reasonCode: 'version-evidence-invalid'
    })
    await client.artifactVersion.update({
      where: { id: ancestryProbe.id },
      data: {
        evidenceJson: ancestryProbe.evidenceJson,
        evidenceChecksum: ancestryProbe.evidenceChecksum
      }
    })

    await client.artifactVersion.update({
      where: { id: ancestryProbe.id },
      data: {
        producerRunIndex: 0,
        executionSnapshotJson: null,
        executionSnapshotChecksum: null,
        executionSnapshotStorageKey: null,
        executionSnapshotSchemaVersion: null
      }
    })
    await expect(repository.finalizeRun(finalizeRequest)).rejects.toMatchObject({
      reasonCode: 'execution-snapshot-missing'
    })
    await client.artifactVersion.update({
      where: { id: ancestryProbe.id },
      data: {
        producerRunIndex: ancestryProbe.producerRunIndex,
        executionSnapshotJson: ancestryProbe.executionSnapshotJson,
        executionSnapshotChecksum: ancestryProbe.executionSnapshotChecksum,
        executionSnapshotStorageKey: ancestryProbe.executionSnapshotStorageKey,
        executionSnapshotSchemaVersion: ancestryProbe.executionSnapshotSchemaVersion
      }
    })

    const invalidExecution = '{}'
    await client.artifactVersion.update({
      where: { id: ancestryProbe.id },
      data: {
        executionSnapshotJson: invalidExecution,
        executionSnapshotChecksum: createHash('sha256').update(invalidExecution).digest('hex'),
        executionSnapshotStorageKey: 'invalid-execution.json',
        executionSnapshotSchemaVersion: 2
      }
    })
    await expect(repository.finalizeRun(finalizeRequest)).rejects.toMatchObject({
      reasonCode: 'execution-snapshot-invalid'
    })
    await client.artifactVersion.update({
      where: { id: ancestryProbe.id },
      data: {
        executionSnapshotJson: ancestryProbe.executionSnapshotJson,
        executionSnapshotChecksum: ancestryProbe.executionSnapshotChecksum,
        executionSnapshotStorageKey: ancestryProbe.executionSnapshotStorageKey,
        executionSnapshotSchemaVersion: ancestryProbe.executionSnapshotSchemaVersion
      }
    })

    const forgedExecution = JSON.stringify({
      schemaVersion: 2,
      rootFrameId: common.rootFrameId,
      agentFrameId: common.agentFrameId,
      messageBranchId: common.messageBranchId,
      terminalPromptMessageId: common.promptMessageId,
      producerRunId: 'notebook-run-sibling',
      producerRunIndex: 0,
      createdAt: '2026-07-27T12:00:00.000Z',
      inputFiles: [],
      runs: [
        {
          runId: 'notebook-run-sibling',
          runIndex: 0,
          agentFrameId: common.agentFrameId,
          messageBranchId: 'sibling-branch',
          runtimeSegmentId: common.runtimeSegmentId,
          promptMessageId: 'sibling-prompt',
          kernelKind: 'python',
          script: 'forged_sibling_evidence()',
          status: 'completed',
          startedAt: '2026-07-27T11:59:00.000Z',
          outputs: [],
          inputFileVersionKeys: []
        }
      ]
    })
    const forgedExecutionChecksum = createHash('sha256').update(forgedExecution).digest('hex')
    const forgedEvidence = JSON.stringify({
      producer: {
        state: 'available',
        producer_run_id: 'notebook-run-sibling',
        run_index: 0
      },
      execution_snapshot_checksum: forgedExecutionChecksum
    })
    await client.artifactVersion.update({
      where: { id: ancestryProbe.id },
      data: {
        producerRunId: 'notebook-run-sibling',
        producerRunIndex: 0,
        executionSnapshotJson: forgedExecution,
        executionSnapshotChecksum: forgedExecutionChecksum,
        executionSnapshotStorageKey: 'forged-execution.json',
        executionSnapshotSchemaVersion: 2,
        evidenceJson: forgedEvidence,
        evidenceChecksum: createHash('sha256').update(forgedEvidence).digest('hex')
      }
    })
    await expect(repository.finalizeRun(finalizeRequest)).rejects.toMatchObject({
      reasonCode: 'execution-outside-ancestry',
      message: expect.stringMatching(/durable Branch ancestry/i)
    })
    await client.artifactVersion.update({
      where: { id: ancestryProbe.id },
      data: {
        producerRunId: ancestryProbe.producerRunId,
        producerRunIndex: ancestryProbe.producerRunIndex,
        executionSnapshotJson: ancestryProbe.executionSnapshotJson,
        executionSnapshotChecksum: ancestryProbe.executionSnapshotChecksum,
        executionSnapshotStorageKey: ancestryProbe.executionSnapshotStorageKey,
        executionSnapshotSchemaVersion: ancestryProbe.executionSnapshotSchemaVersion,
        evidenceJson: ancestryProbe.evidenceJson,
        evidenceChecksum: ancestryProbe.evidenceChecksum
      }
    })
    const finalized = await repository.finalizeRun(finalizeRequest)
    const replayed = await repository.finalizeRun(finalizeRequest)

    expect(finalized.map((version) => version.versionNumber)).toEqual([1, 2])
    expect(replayed.map((version) => version.versionId)).toEqual(
      finalized.map((version) => version.versionId)
    )
    await expect(
      client.artifactVersion.findMany({
        where: { id: { in: finalized.map((version) => version.versionId) } },
        select: { managedVisibleAt: true }
      })
    ).resolves.toEqual([{ managedVisibleAt: null }, { managedVisibleAt: null }])
    await expect(
      client.artifactLineage.findUniqueOrThrow({ where: { id: finalizableVersions[0].artifactId } })
    ).resolves.toMatchObject({ currentVersionId: null })
    const competing = await client.artifactVersion.findUniqueOrThrow({
      where: { id: finalized[1].versionId }
    })
    await client.artifactVersion.create({
      data: {
        id: 'artifact-competing-run-v4',
        artifactId: competing.artifactId,
        versionNumber: 4,
        filename: competing.filename,
        originKind: 'agent_generated',
        artifactRunId: 'artifact-run-competing',
        writeOperationId: 'write-competing-v4',
        writeRequestChecksum: 'f'.repeat(64),
        rootFrameId: competing.rootFrameId,
        agentFrameId: competing.agentFrameId,
        messageBranchId: competing.messageBranchId,
        runtimeSegmentId: competing.runtimeSegmentId,
        promptMessageId: competing.promptMessageId,
        notebookSessionId: competing.notebookSessionId,
        producerRunId: competing.producerRunId,
        producerRunIndex: competing.producerRunIndex,
        messageId: null,
        state: 'finalized',
        managedVisibleAt: null,
        contentStorageKey: 'artifacts/project-1/session-1/competing-v4/content',
        evidenceStorageKey: 'artifacts/project-1/session-1/competing-v4/evidence.json',
        contentType: competing.contentType,
        sizeBytes: competing.sizeBytes,
        checksum: competing.checksum,
        evidenceJson: competing.evidenceJson,
        evidenceChecksum: competing.evidenceChecksum,
        evidenceSchemaVersion: competing.evidenceSchemaVersion,
        executionSnapshotJson: competing.executionSnapshotJson,
        executionSnapshotChecksum: competing.executionSnapshotChecksum,
        executionSnapshotStorageKey: competing.executionSnapshotStorageKey,
        executionSnapshotSchemaVersion: competing.executionSnapshotSchemaVersion
      }
    })
    await repository.activateFinalizedRun(finalizeRequest)
    await expect(
      client.artifactLineage.findUniqueOrThrow({ where: { id: finalizableVersions[0].artifactId } })
    ).resolves.toMatchObject({ currentVersionId: finalized[1].versionId })
    await expect(
      client.artifactVersion.findMany({
        where: { id: { in: finalized.map((version) => version.versionId) } },
        select: { managedVisibleAt: true }
      })
    ).resolves.toEqual([
      { managedVisibleAt: expect.any(Date) },
      { managedVisibleAt: expect.any(Date) }
    ])
    const laterUserEditId = 'artifact-user-edit-v5'
    await client.artifactVersion.create({
      data: {
        id: laterUserEditId,
        artifactId: finalizableVersions[0].artifactId,
        versionNumber: 5,
        filename: common.filename,
        originKind: 'user_edit',
        basedOnVersionId: finalized[1].versionId,
        storageTag: 'vlate0001',
        storedFilename: 'vlate0001_sin.png',
        state: 'finalized',
        contentStorageKey: 'artifacts/project-1/session-1/user-edit-v5/content',
        contentType: 'image/png',
        sizeBytes: BigInt(4),
        checksum: 'd'.repeat(64)
      }
    })
    await client.artifactLineage.update({
      where: { id: finalizableVersions[0].artifactId },
      data: { currentVersionId: laterUserEditId }
    })
    await repository.activateFinalizedRun(finalizeRequest)
    await expect(
      client.artifactLineage.findUniqueOrThrow({ where: { id: finalizableVersions[0].artifactId } })
    ).resolves.toMatchObject({ currentVersionId: laterUserEditId })
    expect(
      await client.artifactVersion.count({
        where: { state: 'finalized', messageId: 'message-1' }
      })
    ).toBe(2)
    await expect(
      client.artifactVersion.findUniqueOrThrow({ where: { id: interrupted.id } })
    ).resolves.toMatchObject({ state: 'staging', messageId: null })

    await expect(
      repository.finalizeRun({ ...finalizeRequest, messageId: 'message-2' })
    ).rejects.toBeInstanceOf(ArtifactOwnershipPersistenceRaceError)
    await expect(
      repository.finalizeRun({
        ...finalizeRequest,
        messageBranchAncestry: ['branch-other'],
        messageAncestry: ['prompt-1', 'message-1']
      })
    ).resolves.toHaveLength(2)
  })

  it('replays the default compatibility repository crash window only with durable Branch ownership', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-artifact-marker-recovery-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)
    const compatibilityRepository = new ArtifactRepository(storageRoot)
    const repository = new ArtifactProvenanceRepository({
      storageRoot,
      getClient: () => Promise.resolve(client)
    })
    const prompt = {
      id: 'prompt-1',
      role: 'user' as const,
      content: 'draw',
      status: 'complete' as const,
      eventIds: [],
      createdAt: 1,
      updatedAt: 1
    }
    const message = {
      id: 'message-1',
      role: 'agent' as const,
      content: 'done',
      status: 'complete' as const,
      eventIds: [],
      createdAt: 2,
      updatedAt: 2
    }
    const conversationGraph = createLinearConversationGraph({
      sessionId: 'session-1',
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
    const request = {
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-1',
      artifactRunId: 'artifact-run-crash',
      writeOperationId: 'write-crash',
      writeRequestChecksum: 'd'.repeat(64),
      ...context,
      filename: 'crash.png'
    } as const
    await compatibilityRepository.writePendingFile({
      projectId: request.projectId,
      sessionId: request.artifactStorageSessionId,
      runId: request.artifactRunId,
      filename: request.filename,
      source: createPngInlineSource('crash-window')
    })
    const version = await repository.createVersion(request)
    // Simulate process exit after compatibility finalize wrote its marker/moved bytes but before the
    // Provenance transaction advanced pending -> finalized.
    await compatibilityRepository.finalizeRunArtifacts({
      projectId: request.projectId,
      sourceSessionId: request.artifactStorageSessionId,
      sessionId: request.appSessionId,
      runId: request.artifactRunId,
      messageId: 'message-1',
      provenanceContext: context
    })
    await expect(
      client.artifactVersion.findUniqueOrThrow({ where: { id: version.versionId } })
    ).resolves.toMatchObject({ state: 'pending', messageId: null })
    await expect(
      compatibilityRepository.findRunFinalizationMarker(request.projectId, request.artifactRunId)
    ).resolves.toMatchObject({
      sourceSessionId: request.artifactStorageSessionId,
      sessionId: request.appSessionId,
      messageId: 'message-1',
      provenanceContext: context
    })
    await expect(
      new ArtifactRepository(storageRoot).findRunFinalizationMarker(
        request.projectId,
        request.artifactRunId
      )
    ).resolves.toMatchObject({ messageId: 'message-1' })

    const session: PersistedChatSession = {
      id: 'session-1',
      projectId: 'project-1',
      title: 'Recovery',
      cwd: '/workspace',
      status: 'idle',
      messages: [prompt, message],
      conversationGraph,
      createdAt: 1,
      updatedAt: 2
    }

    const wrongBranchSession: PersistedChatSession = {
      ...session,
      conversationGraph: {
        ...session.conversationGraph!,
        branches: session.conversationGraph!.branches.map((branch) => ({
          ...branch,
          headMessageId: prompt.id
        }))
      }
    }
    await expect(
      repository.reconcileSession('project-1', 'session-1', wrongBranchSession)
    ).resolves.toMatchObject({ recoveredVersionIds: [] })
    await expect(
      client.artifactVersion.findUniqueOrThrow({ where: { id: version.versionId } })
    ).resolves.toMatchObject({ state: 'pending', messageId: null })

    await expect(
      repository.reconcileSession('project-1', 'session-1', session)
    ).resolves.toMatchObject({ recoveredVersionIds: expect.arrayContaining([version.versionId]) })
    await expect(
      client.artifactVersion.findUniqueOrThrow({ where: { id: version.versionId } })
    ).resolves.toMatchObject({ state: 'finalized', messageId: 'message-1' })
  })

  it('recovers a prepared run only to its unique durable turn message', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-artifact-intent-recovery-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)
    const compatibilityRepository = new ArtifactRepository(storageRoot)
    const repository = new ArtifactProvenanceRepository({
      storageRoot,
      getClient: () => Promise.resolve(client),
      compatibilityRepository
    })
    const prompt = {
      id: 'prompt-1',
      role: 'user' as const,
      content: 'draw',
      status: 'complete' as const,
      eventIds: [],
      createdAt: 1,
      updatedAt: 1
    }
    const message = {
      id: 'message-1',
      role: 'agent' as const,
      content: 'done',
      // Renderer lifecycle persistence may lag the provider stop that prepared the durable handoff.
      status: 'streaming' as const,
      eventIds: [],
      createdAt: 2,
      updatedAt: 2
    }
    const conversationGraph = createLinearConversationGraph({
      sessionId: 'session-1',
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
    const request = {
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-1',
      artifactRunId: 'artifact-run-before-renderer-finalize',
      writeOperationId: 'write-before-renderer-finalize',
      writeRequestChecksum: 'e'.repeat(64),
      ...context,
      filename: 'prepared.png'
    } as const
    await compatibilityRepository.writePendingFile({
      projectId: request.projectId,
      sessionId: request.artifactStorageSessionId,
      runId: request.artifactRunId,
      filename: request.filename,
      source: createPngInlineSource('prepared-window')
    })
    const version = await repository.createVersion(request)
    const session: PersistedChatSession = {
      id: request.appSessionId,
      projectId: request.projectId,
      title: 'Prepared recovery',
      cwd: '/workspace',
      status: 'idle',
      messages: [prompt, message],
      conversationGraph,
      createdAt: 1,
      updatedAt: 2
    }

    // A streaming node plus pending Version alone does not prove that the runtime ended the turn and
    // chose to publish it; a crash before the prepared witness must remain pending.
    await expect(
      repository.reconcileSession(request.projectId, request.appSessionId, session)
    ).resolves.toMatchObject({ recoveredVersionIds: [], recoveredMessageArtifacts: [] })

    // Simulate exit after the runtime durably prepared the handoff but before the renderer finalized it.
    // The witness proves turn termination; the renderer-owned message status is allowed to lag.
    await compatibilityRepository.prepareRunFinalization({
      projectId: request.projectId,
      sourceSessionId: request.artifactStorageSessionId,
      sessionId: request.appSessionId,
      runId: request.artifactRunId,
      provenanceContext: context
    })
    const sessionWithoutTerminalMessage: PersistedChatSession = {
      ...session,
      messages: [prompt],
      conversationGraph: {
        ...session.conversationGraph!,
        branches: session.conversationGraph!.branches.map((branch) => ({
          ...branch,
          headMessageId: prompt.id
        })),
        messages: session.conversationGraph!.messages.slice(0, 1)
      }
    }
    await expect(
      repository.reconcileSession(
        request.projectId,
        request.appSessionId,
        sessionWithoutTerminalMessage
      )
    ).resolves.toMatchObject({ recoveredVersionIds: [], recoveredMessageArtifacts: [] })

    const wrongBranchSession: PersistedChatSession = {
      ...session,
      conversationGraph: {
        ...session.conversationGraph!,
        branches: [
          {
            ...session.conversationGraph!.branches[0],
            headMessageId: prompt.id
          },
          {
            id: 'branch-other',
            agentFrameId: context.agentFrameId,
            headMessageId: message.id,
            createdAt: 1,
            updatedAt: 2
          }
        ],
        messages: session.conversationGraph!.messages.map((node) =>
          node.id === message.id ? { ...node, introducedOnBranchId: 'branch-other' } : node
        )
      }
    }
    await expect(
      repository.reconcileSession(request.projectId, request.appSessionId, wrongBranchSession)
    ).resolves.toMatchObject({ recoveredVersionIds: [], recoveredMessageArtifacts: [] })

    const ambiguousMessage = {
      ...message,
      id: 'message-ambiguous',
      content: 'later agent output',
      createdAt: 3,
      updatedAt: 3
    }
    const ambiguousSession: PersistedChatSession = {
      ...session,
      messages: [prompt, message, ambiguousMessage],
      conversationGraph: {
        ...session.conversationGraph!,
        branches: session.conversationGraph!.branches.map((branch) => ({
          ...branch,
          headMessageId: ambiguousMessage.id,
          updatedAt: 3
        })),
        messages: [
          ...session.conversationGraph!.messages,
          {
            ...ambiguousMessage,
            agentFrameId: context.agentFrameId,
            introducedOnBranchId: context.messageBranchId,
            parentMessageId: message.id,
            runtimeSegmentId: context.runtimeSegmentId
          }
        ]
      }
    }
    await expect(
      repository.reconcileSession(request.projectId, request.appSessionId, ambiguousSession)
    ).resolves.toMatchObject({ recoveredVersionIds: [], recoveredMessageArtifacts: [] })
    await expect(
      client.artifactVersion.findUniqueOrThrow({ where: { id: version.versionId } })
    ).resolves.toMatchObject({ state: 'pending', messageId: null })

    const recovered = await repository.reconcileSession(
      request.projectId,
      request.appSessionId,
      session
    )
    expect(recovered).toMatchObject({
      recoveredVersionIds: expect.arrayContaining([version.versionId]),
      recoveredMessageArtifacts: [
        {
          messageId: message.id,
          artifacts: [
            expect.objectContaining({
              id: version.versionId,
              versionId: version.versionId,
              artifactId: version.artifactId
            })
          ]
        }
      ]
    })
    await expect(
      client.artifactVersion.findUniqueOrThrow({ where: { id: version.versionId } })
    ).resolves.toMatchObject({ state: 'finalized', messageId: message.id })
    await expect(
      compatibilityRepository.findRunFinalizationMarker(request.projectId, request.artifactRunId)
    ).resolves.toMatchObject({ messageId: message.id, provenanceContext: context })

    // A failed Session JSON save retries the attachment even though SQLite is already finalized.
    const attachmentRetry = await repository.reconcileSession(
      request.projectId,
      request.appSessionId,
      session
    )
    expect(attachmentRetry).toMatchObject({
      recoveredVersionIds: [],
      recoveredMessageArtifacts: [
        {
          messageId: message.id,
          artifacts: [expect.objectContaining({ id: version.versionId })]
        }
      ]
    })

    const messageLinkedSession: PersistedChatSession = {
      ...session,
      messages: session.messages.map((item) =>
        item.id === message.id ? { ...item, artifactIds: [version.versionId] } : item
      ),
      conversationGraph: {
        ...session.conversationGraph!,
        messages: session.conversationGraph!.messages.map((item) =>
          item.id === message.id ? { ...item, artifactIds: [version.versionId] } : item
        )
      }
    }
    await expect(
      repository.reconcileSession(request.projectId, request.appSessionId, messageLinkedSession)
    ).resolves.toMatchObject({
      recoveredVersionIds: [],
      recoveredMessageArtifacts: [
        { messageId: message.id, artifacts: [expect.objectContaining({ id: version.versionId })] }
      ]
    })

    const linkedSession: PersistedChatSession = {
      ...messageLinkedSession,
      artifacts: [
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
          mtimeMs: version.mtimeMs,
          sha256: version.checksum
        }
      ]
    }
    await expect(
      repository.reconcileSession(request.projectId, request.appSessionId, linkedSession)
    ).resolves.toMatchObject({ recoveredVersionIds: [], recoveredMessageArtifacts: [] })
  })

  it('withholds saved Review conclusions when an active source Session cannot be loaded', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-active-review-unavailable-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)
    const compatibilityRepository = new ArtifactRepository(storageRoot)
    const repository = new ArtifactProvenanceRepository({
      storageRoot,
      getClient: () => Promise.resolve(client),
      compatibilityRepository,
      loadSession: async () => {
        throw new Error('Session JSON is temporarily unreadable.')
      }
    })
    const common = {
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-1',
      artifactRunId: 'artifact-run-1',
      rootFrameId: 'root-frame-1',
      agentFrameId: 'agent-frame-1',
      messageBranchId: 'branch-1',
      runtimeSegmentId: 'runtime-segment-1',
      promptMessageId: 'prompt-1',
      filename: 'sin.png'
    } as const
    await compatibilityRepository.writePendingFile({
      projectId: common.projectId,
      sessionId: common.artifactStorageSessionId,
      runId: common.artifactRunId,
      filename: common.filename,
      source: createPngInlineSource('reviewed bytes')
    })
    const version = await repository.createVersion({
      ...common,
      writeOperationId: 'write-1',
      writeRequestChecksum: 'a'.repeat(64)
    })
    await client.review.create({
      data: {
        id: 'review-1',
        projectId: common.projectId,
        sessionId: common.appSessionId,
        turnMessageId: common.promptMessageId,
        scope: JSON.stringify({
          turnMessageId: common.promptMessageId,
          blocks: [],
          artifactVersionIds: [version.versionId]
        }),
        lifecycle: 'complete',
        outcome: 'pass',
        reviewerLog: '[]'
      }
    })

    await expect(
      repository.getVersionReview({
        projectId: common.projectId,
        appSessionId: common.appSessionId,
        artifactId: version.artifactId,
        versionId: version.versionId
      })
    ).resolves.toEqual({
      review: { state: 'unavailable', reason: 'source-session-unavailable' }
    })

    await client.fileOriginSession.update({
      where: {
        projectId_sessionId: {
          projectId: common.projectId,
          sessionId: common.appSessionId
        }
      },
      data: { state: 'deleted', deletedAt: new Date() }
    })
    await expect(
      repository.getVersionReview({
        projectId: common.projectId,
        appSessionId: common.appSessionId,
        artifactId: version.artifactId,
        versionId: version.versionId
      })
    ).resolves.toMatchObject({
      review: {
        state: 'available',
        value: { currentDirectAssessment: { id: 'review-1', outcome: 'pass' } }
      }
    })
  })

  it('serializes concurrent Unicode case-folded writes into one monotonic lineage', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-artifact-concurrent-'))
    const client = createProjectDbClient(storageRoot)
    const secondClient = createProjectDbClient(storageRoot)
    disconnect = async () => {
      await Promise.all([client.$disconnect(), secondClient.$disconnect()])
    }
    await migrateApplicationDatabase(client)
    const compatibilityRepository = new ArtifactRepository(storageRoot)
    const repository = new ArtifactProvenanceRepository({
      storageRoot,
      getClient: () => Promise.resolve(client),
      compatibilityRepository
    })
    const competingRepository = new ArtifactProvenanceRepository({
      storageRoot,
      getClient: () => Promise.resolve(secondClient),
      compatibilityRepository
    })
    const common = {
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-1',
      artifactRunId: 'artifact-run-1',
      rootFrameId: 'root-frame-1',
      agentFrameId: 'agent-frame-1',
      messageBranchId: 'branch-1',
      runtimeSegmentId: 'runtime-segment-1',
      promptMessageId: 'prompt-1'
    } as const
    for (const filename of ['Straße.png', 'STRASSE.PNG']) {
      await compatibilityRepository.writePendingFile({
        projectId: common.projectId,
        sessionId: common.artifactStorageSessionId,
        runId: common.artifactRunId,
        filename,
        // A case-insensitive filesystem exposes one compatibility path for this folded identity.
        // Keep the bytes identical so this test isolates lineage serialization from routing conflict.
        source: createPngInlineSource('shared-case-folded-content')
      })
    }

    const versions = await Promise.all(
      ['Straße.png', 'STRASSE.PNG'].map((filename, index) =>
        (index === 0 ? repository : competingRepository).createVersion({
          ...common,
          filename,
          writeOperationId: `write-${index + 1}`,
          writeRequestChecksum: String(index + 1).repeat(64)
        })
      )
    )

    expect(new Set(versions.map((version) => version.artifactId)).size).toBe(1)
    expect(
      versions.map((version) => version.versionNumber).sort((left, right) => left - right)
    ).toEqual([1, 2])
  })

  it('keeps evidence readable when immutable content bytes are missing', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-artifact-missing-content-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)
    const compatibilityRepository = new ArtifactRepository(storageRoot)
    const repository = new ArtifactProvenanceRepository({
      storageRoot,
      getClient: () => Promise.resolve(client),
      compatibilityRepository
    })
    const request = {
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-1',
      artifactRunId: 'artifact-run-1',
      writeOperationId: 'write-1',
      writeRequestChecksum: 'a'.repeat(64),
      rootFrameId: 'root-frame-1',
      agentFrameId: 'agent-frame-1',
      messageBranchId: 'branch-1',
      runtimeSegmentId: 'runtime-segment-1',
      promptMessageId: 'prompt-1',
      filename: 'sin.png'
    } as const
    await compatibilityRepository.writePendingFile({
      projectId: request.projectId,
      sessionId: request.artifactStorageSessionId,
      runId: request.artifactRunId,
      filename: request.filename,
      source: createPngInlineSource('plot bytes')
    })
    const version = await repository.createVersion(request)
    const versionRow = requireAgentArtifactVersion(
      await client.artifactVersion.findUniqueOrThrow({ where: { id: version.versionId } })
    )
    await rm(version.path)
    await rm(join(storageRoot, ...versionRow.evidenceStorageKey.split('/')))

    await expect(
      repository.getVersionProvenance({
        projectId: request.projectId,
        appSessionId: request.appSessionId,
        artifactId: version.artifactId,
        versionId: version.versionId
      })
    ).resolves.toMatchObject({
      descriptor: { versionId: version.versionId },
      contentStatus: { state: 'unavailable', reason: 'missing' },
      evidence: { checksum: version.checksum }
    })
    await expect(
      readFile(join(storageRoot, ...versionRow.evidenceStorageKey.split('/')), 'utf8')
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reconstructs a missing finalized SQLite Version only from exact Message-snapshot ownership', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-artifact-row-recovery-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)
    const prompt = {
      id: 'prompt-1',
      role: 'user' as const,
      content: 'recover',
      status: 'complete' as const,
      eventIds: [],
      createdAt: 1,
      updatedAt: 1
    }
    const assistant = {
      id: 'message-1',
      role: 'agent' as const,
      content: 'saved recover.png',
      status: 'complete' as const,
      eventIds: [],
      createdAt: 2,
      updatedAt: 2
    }
    const conversationGraph = createLinearConversationGraph({
      sessionId: 'session-1',
      messages: [prompt, assistant],
      frameworkId: 'codex',
      createdAt: 1,
      updatedAt: 2
    })
    const session: PersistedChatSession = {
      id: 'session-1',
      projectId: 'project-1',
      title: 'Recovery',
      cwd: '/workspace',
      status: 'idle',
      messages: [prompt, assistant],
      conversationGraph,
      createdAt: 1,
      updatedAt: 2
    }
    const compatibilityRepository = new ArtifactRepository(storageRoot)
    const repository = new ArtifactProvenanceRepository({
      storageRoot,
      getClient: () => Promise.resolve(client),
      compatibilityRepository,
      loadSession: async () => session
    })
    const request = {
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-1',
      artifactRunId: 'artifact-run-1',
      writeOperationId: 'write-recover-1',
      writeRequestChecksum: 'c'.repeat(64),
      rootFrameId: conversationGraph.rootFrameId,
      agentFrameId: conversationGraph.activeFrameId,
      messageBranchId: conversationGraph.branches[0].id,
      runtimeSegmentId: conversationGraph.runtimeSegments[0].id,
      promptMessageId: prompt.id,
      filename: 'recover.png'
    } as const
    await compatibilityRepository.writePendingFile({
      projectId: request.projectId,
      sessionId: request.artifactStorageSessionId,
      runId: request.artifactRunId,
      filename: request.filename,
      source: createPngInlineSource('recoverable bytes')
    })
    const version = await repository.createVersion(request)
    await repository.finalizeRun({
      projectId: request.projectId,
      appSessionId: request.appSessionId,
      artifactRunId: request.artifactRunId,
      artifactVersionIds: [version.versionId],
      rootFrameId: request.rootFrameId,
      agentFrameId: request.agentFrameId,
      messageBranchId: request.messageBranchId,
      runtimeSegmentId: request.runtimeSegmentId,
      promptMessageId: request.promptMessageId,
      messageId: 'message-1'
    })
    await compatibilityRepository.finalizeRunArtifacts({
      projectId: request.projectId,
      sessionId: request.appSessionId,
      sourceSessionId: request.artifactStorageSessionId,
      runId: request.artifactRunId,
      messageId: 'message-1'
    })
    const snapshotId = 'snapshot-recovery-1'
    const snapshotStorageKey =
      'artifacts/project-1/session-1/.provenance/message-snapshots/snapshot-recovery-1.json'
    const snapshot = {
      schemaVersion: 3,
      snapshotId,
      rootFrameId: request.rootFrameId,
      agentFrameId: request.agentFrameId,
      messageBranchId: request.messageBranchId,
      terminalMessageId: 'message-1',
      createdAt: '2026-07-27T00:00:00.000Z',
      messages: [
        {
          id: 'message-1',
          role: 'agent',
          content: 'saved recover.png',
          createdAt: 1,
          artifacts: [{ versionId: version.versionId, name: request.filename }]
        }
      ],
      activities: [],
      activityGroups: []
    }
    const serializedSnapshot = JSON.stringify(snapshot)
    await mkdir(dirname(join(storageRoot, ...snapshotStorageKey.split('/'))), { recursive: true })
    await writeFile(join(storageRoot, ...snapshotStorageKey.split('/')), serializedSnapshot, 'utf8')
    await client.artifactMessageSnapshot.create({
      data: {
        id: snapshotId,
        projectId: request.projectId,
        sessionId: request.appSessionId,
        rootFrameId: request.rootFrameId,
        agentFrameId: request.agentFrameId,
        messageBranchId: request.messageBranchId,
        terminalMessageId: 'message-1',
        state: 'ready',
        storageKey: snapshotStorageKey,
        checksum: createHash('sha256').update(serializedSnapshot).digest('hex'),
        messageCount: 1
      }
    })
    await client.artifactVersion.update({
      where: { id: version.versionId },
      data: { messageSnapshotId: snapshotId }
    })
    await client.artifactLineage.update({
      where: { id: version.artifactId },
      data: { currentVersionId: null }
    })
    await client.managedFile.deleteMany({
      where: {
        projectId: request.projectId,
        source: 'artifact',
        sourceFileId: version.artifactId
      }
    })
    await client.artifactVersion.delete({ where: { id: version.versionId } })

    await expect(
      repository.reconcileSession(request.projectId, request.appSessionId)
    ).resolves.toEqual({
      recoveredVersionIds: [version.versionId],
      quarantinedVersionIds: [],
      recoveredMessageArtifacts: [],
      nativeFinalizationRunIds: [],
      unresolvedNativeFinalizationRunIds: []
    })
    await expect(
      client.artifactVersion.findUniqueOrThrow({ where: { id: version.versionId } })
    ).resolves.toMatchObject({
      state: 'finalized',
      messageId: 'message-1',
      messageSnapshotId: snapshotId,
      writeOperationId: null,
      writeRequestChecksum: null
    })
  })

  it('reconstructs an unindexed pending Version only from its exact compatibility routing sidecar', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-artifact-pending-recovery-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)
    const compatibilityRepository = new ArtifactRepository(storageRoot)
    const repository = new ArtifactProvenanceRepository({
      storageRoot,
      getClient: () => Promise.resolve(client),
      compatibilityRepository
    })
    const request = {
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-1',
      artifactRunId: 'artifact-run-1',
      writeOperationId: 'write-pending-recover-1',
      writeRequestChecksum: 'e'.repeat(64),
      rootFrameId: 'root-frame-1',
      agentFrameId: 'agent-frame-1',
      messageBranchId: 'branch-1',
      runtimeSegmentId: 'runtime-segment-1',
      promptMessageId: 'prompt-1',
      filename: 'pending-recover.png',
      contentType: 'image/png'
    } as const
    await compatibilityRepository.writePendingFile({
      projectId: request.projectId,
      sessionId: request.artifactStorageSessionId,
      runId: request.artifactRunId,
      filename: request.filename,
      mimeType: request.contentType,
      source: createPngInlineSource('pending recoverable bytes')
    })
    const version = await repository.createVersion(request)
    const metadataPath = join(
      storageRoot,
      'artifacts',
      request.projectId,
      request.artifactStorageSessionId,
      '.pending',
      request.artifactRunId,
      '.metadata',
      `${encodeURIComponent(request.filename)}.json`
    )
    await expect(readFile(metadataPath, 'utf8').then(JSON.parse)).resolves.toMatchObject({
      artifactId: version.artifactId,
      versionId: version.versionId,
      versionNumber: 1,
      artifactRunId: request.artifactRunId,
      checksum: version.checksum,
      mimeType: request.contentType
    })
    await client.artifactVersion.delete({ where: { id: version.versionId } })

    await expect(
      repository.reconcileSession(request.projectId, request.appSessionId)
    ).resolves.toEqual({
      recoveredVersionIds: [version.versionId],
      quarantinedVersionIds: [],
      recoveredMessageArtifacts: [],
      nativeFinalizationRunIds: [],
      unresolvedNativeFinalizationRunIds: []
    })
    await expect(
      client.artifactVersion.findUniqueOrThrow({ where: { id: version.versionId } })
    ).resolves.toMatchObject({
      state: 'pending',
      artifactRunId: request.artifactRunId,
      messageId: null,
      messageSnapshotId: null
    })
  })

  it('defers orphan recovery instead of quarantining when an unrelated sidecar is unreadable', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-artifact-incomplete-route-scan-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)
    const compatibilityRepository = new ArtifactRepository(storageRoot)
    const repository = new ArtifactProvenanceRepository({
      storageRoot,
      getClient: () => Promise.resolve(client),
      compatibilityRepository
    })
    const request = {
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-1',
      artifactRunId: 'artifact-run-1',
      writeOperationId: 'write-incomplete-route-scan-1',
      writeRequestChecksum: '9'.repeat(64),
      rootFrameId: 'root-frame-1',
      agentFrameId: 'agent-frame-1',
      messageBranchId: 'branch-1',
      runtimeSegmentId: 'runtime-segment-1',
      promptMessageId: 'prompt-1',
      filename: 'recover-later.png',
      contentType: 'image/png'
    } as const
    await compatibilityRepository.writePendingFile({
      projectId: request.projectId,
      sessionId: request.artifactStorageSessionId,
      runId: request.artifactRunId,
      filename: request.filename,
      mimeType: request.contentType,
      source: createPngInlineSource('recover after scan repair')
    })
    const version = await repository.createVersion(request)
    await client.artifactVersion.delete({ where: { id: version.versionId } })

    await compatibilityRepository.writePendingFile({
      projectId: request.projectId,
      sessionId: 'artifact-session-corrupt',
      runId: 'artifact-run-corrupt',
      filename: 'unrelated.txt',
      mimeType: 'text/plain',
      source: { kind: 'inline', content: 'unrelated', encoding: 'utf8' }
    })
    const corruptMetadataPath = join(
      storageRoot,
      'artifacts',
      request.projectId,
      'artifact-session-corrupt',
      '.pending',
      'artifact-run-corrupt',
      '.metadata',
      `${encodeURIComponent('unrelated.txt')}.json`
    )
    await writeFile(corruptMetadataPath, '{ not-json', 'utf8')

    await expect(
      repository.reconcileSession(request.projectId, request.appSessionId)
    ).resolves.toEqual({
      recoveredVersionIds: [],
      quarantinedVersionIds: [],
      recoveredMessageArtifacts: [],
      nativeFinalizationRunIds: [],
      unresolvedNativeFinalizationRunIds: []
    })
    await expect(readFile(version.path)).resolves.toBeTruthy()
    await expect(
      client.artifactVersion.findUnique({ where: { id: version.versionId } })
    ).resolves.toBeNull()

    await rm(corruptMetadataPath)
    await expect(
      repository.reconcileSession(request.projectId, request.appSessionId)
    ).resolves.toEqual({
      recoveredVersionIds: [version.versionId],
      quarantinedVersionIds: [],
      recoveredMessageArtifacts: [],
      nativeFinalizationRunIds: [],
      unresolvedNativeFinalizationRunIds: []
    })
  })

  it('quarantines an unindexed Version when no immutable lifecycle proof exists', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-artifact-row-quarantine-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)
    const compatibilityRepository = new ArtifactRepository(storageRoot)
    const repository = new ArtifactProvenanceRepository({
      storageRoot,
      getClient: () => Promise.resolve(client),
      compatibilityRepository
    })
    const request = {
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactStorageSessionId: 'artifact-session-1',
      artifactRunId: 'artifact-run-1',
      writeOperationId: 'write-quarantine-1',
      writeRequestChecksum: 'd'.repeat(64),
      rootFrameId: 'root-frame-1',
      agentFrameId: 'agent-frame-1',
      messageBranchId: 'branch-1',
      runtimeSegmentId: 'runtime-segment-1',
      promptMessageId: 'prompt-1',
      filename: 'unlinked.png'
    } as const
    await compatibilityRepository.writePendingFile({
      projectId: request.projectId,
      sessionId: request.artifactStorageSessionId,
      runId: request.artifactRunId,
      filename: request.filename,
      source: createPngInlineSource('unlinked bytes')
    })
    const version = await repository.createVersion(request)
    const metadataPath = join(
      storageRoot,
      'artifacts',
      request.projectId,
      request.artifactStorageSessionId,
      '.pending',
      request.artifactRunId,
      '.metadata',
      `${encodeURIComponent(request.filename)}.json`
    )
    await writeFile(metadataPath, `${JSON.stringify({ mimeType: 'image/png' }, null, 2)}\n`, 'utf8')
    const forgedSnapshotId = 'snapshot-forged-1'
    const forgedSnapshotStorageKey =
      'artifacts/project-1/session-1/.provenance/message-snapshots/snapshot-forged-1.json'
    const forgedSnapshot = {
      schemaVersion: 3,
      snapshotId: forgedSnapshotId,
      rootFrameId: request.rootFrameId,
      agentFrameId: request.agentFrameId,
      messageBranchId: request.messageBranchId,
      terminalMessageId: 'message-forged-1',
      createdAt: '2026-07-27T12:00:00.000Z',
      messages: [
        {
          id: 'message-forged-1',
          role: 'agent',
          content: 'forged ownership',
          createdAt: 1,
          artifacts: [{ versionId: version.versionId, name: request.filename }]
        }
      ],
      activities: [],
      activityGroups: []
    }
    const forgedSnapshotPath = join(storageRoot, ...forgedSnapshotStorageKey.split('/'))
    await mkdir(dirname(forgedSnapshotPath), { recursive: true })
    await writeFile(forgedSnapshotPath, JSON.stringify(forgedSnapshot), 'utf8')
    await client.artifactMessageSnapshot.create({
      data: {
        id: forgedSnapshotId,
        projectId: request.projectId,
        sessionId: request.appSessionId,
        rootFrameId: request.rootFrameId,
        agentFrameId: request.agentFrameId,
        messageBranchId: request.messageBranchId,
        terminalMessageId: 'message-forged-1',
        state: 'ready',
        storageKey: forgedSnapshotStorageKey,
        checksum: 'f'.repeat(64),
        messageCount: 1
      }
    })
    await client.artifactVersion.delete({ where: { id: version.versionId } })

    await expect(
      repository.reconcileSession(request.projectId, request.appSessionId)
    ).resolves.toEqual({
      recoveredVersionIds: [],
      quarantinedVersionIds: [version.versionId],
      recoveredMessageArtifacts: [],
      nativeFinalizationRunIds: [],
      unresolvedNativeFinalizationRunIds: []
    })
    await expect(readFile(version.path)).rejects.toMatchObject({ code: 'ENOENT' })
    const quarantineRoot = join(
      storageRoot,
      'artifacts',
      request.projectId,
      request.appSessionId,
      '.provenance',
      '.quarantine',
      'recovered-unlinked',
      version.artifactId
    )
    expect(await readdir(quarantineRoot)).toEqual([
      expect.stringContaining(`${version.versionId}-`)
    ])
  })

  it('physically removes only the selected Project provenance graph and bytes', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-project-provenance-delete-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)
    const compatibilityRepository = new ArtifactRepository(storageRoot)
    const repository = new ArtifactProvenanceRepository({
      storageRoot,
      getClient: () => Promise.resolve(client),
      compatibilityRepository
    })

    const createProjectVersion = async (
      projectId: string,
      operation: string
    ): Promise<ArtifactVersionFile> => {
      await compatibilityRepository.writePendingFile({
        projectId: projectId,
        sessionId: `${projectId}-artifact-session`,
        runId: `${projectId}-artifact-run`,
        filename: 'sin.png',
        source: createPngInlineSource(`${projectId} bytes`)
      })
      return repository.createVersion({
        projectId,
        appSessionId: 'shared-session',
        artifactStorageSessionId: `${projectId}-artifact-session`,
        artifactRunId: `${projectId}-artifact-run`,
        writeOperationId: operation,
        writeRequestChecksum: operation.repeat(64).slice(0, 64),
        rootFrameId: 'root-frame-1',
        agentFrameId: 'agent-frame-1',
        messageBranchId: 'branch-1',
        runtimeSegmentId: 'runtime-segment-1',
        promptMessageId: 'prompt-1',
        filename: 'sin.png'
      })
    }
    const deletedVersion = await createProjectVersion('project-1', 'a')
    const survivingVersion = await createProjectVersion('project-2', 'b')

    await repository.deleteProjectProvenance('project-1')

    await expect(client.artifactLineage.count({ where: { projectId: 'project-1' } })).resolves.toBe(
      0
    )
    await expect(
      client.fileOriginSession.count({ where: { projectId: 'project-1' } })
    ).resolves.toBe(0)
    await expect(readFile(deletedVersion.path)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(survivingVersion.path)).resolves.toEqual(
      createPngBytes('project-2 bytes')
    )
    await expect(client.artifactLineage.count({ where: { projectId: 'project-2' } })).resolves.toBe(
      1
    )
  })

  it('retains every Project Version and write journal when Version storage deletion fails', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-version-operator-delete-retry-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)
    const artifactBytes = Buffer.from('artifact version')
    const uploadBytes = Buffer.from('upload version')
    const artifactStorageRef =
      'artifacts/project-1/session-1/artifact-1/managed-versions/vabc12345_report.md'
    const uploadStorageRef =
      'uploads/project-1/session-1/upload-1/managed-versions/vdef67890_input.csv'
    for (const [storageRef, bytes] of [
      [artifactStorageRef, artifactBytes],
      [uploadStorageRef, uploadBytes]
    ] as const) {
      const path = join(storageRoot, ...storageRef.split('/'))
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, bytes)
    }
    await client.fileOriginSession.create({
      data: { projectId: 'project-1', sessionId: 'session-1' }
    })
    await client.artifactLineage.create({
      data: {
        id: 'artifact-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        normalizedFilename: 'report.md',
        filename: 'report.md',
        versions: {
          create: {
            id: 'artifact-v1',
            versionNumber: 1,
            filename: 'report.md',
            originKind: 'legacy',
            state: 'finalized',
            contentStorageKey: artifactStorageRef,
            sizeBytes: artifactBytes.byteLength,
            checksum: createHash('sha256').update(artifactBytes).digest('hex')
          }
        }
      }
    })
    await client.artifactLineage.update({
      where: { id: 'artifact-1' },
      data: { currentVersionId: 'artifact-v1' }
    })
    await client.uploadFile.create({
      data: {
        id: 'upload-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        filename: 'input.csv',
        originalFilename: 'input.csv',
        versions: {
          create: {
            id: 'upload-v1',
            versionNumber: 1,
            state: 'ready',
            contentStorageKey: uploadStorageRef,
            filename: 'input.csv',
            originalFilename: 'input.csv',
            sizeBytes: uploadBytes.byteLength,
            checksum: createHash('sha256').update(uploadBytes).digest('hex')
          }
        }
      }
    })
    await client.uploadFile.update({
      where: { id: 'upload-1' },
      data: { currentVersionId: 'upload-v1' }
    })
    await client.managedFileVersionWriteOperation.create({
      data: {
        operationId: 'artifact-operation-1',
        source: 'artifact',
        projectId: 'project-1',
        sourceFileId: 'artifact-1',
        basedOnVersionId: 'artifact-v1',
        expectedHeadVersionId: 'artifact-v1',
        state: 'published',
        storageTag: 'vabc12345',
        storedFilename: 'vabc12345_report.md',
        contentStorageKey: artifactStorageRef,
        checksum: createHash('sha256').update(artifactBytes).digest('hex'),
        sizeBytes: artifactBytes.byteLength,
        textFormatJson: '{}',
        resultVersionId: 'artifact-v1'
      }
    })
    const removeImmutable = vi.fn(async (storageRef: string) => {
      if (storageRef === uploadStorageRef) throw new Error('simulated storage outage')
      await rm(join(storageRoot!, ...storageRef.split('/')), { force: true })
    })
    const repository = new ArtifactProvenanceRepository({
      storageRoot,
      getClient: () => Promise.resolve(client),
      versionFileOperator: { removeImmutable } as never
    })

    await expect(repository.deleteProjectProvenance('project-1')).rejects.toThrow(
      'simulated storage outage'
    )

    expect(removeImmutable).toHaveBeenCalledWith(artifactStorageRef, {
      sizeBytes: artifactBytes.byteLength,
      checksum: createHash('sha256').update(artifactBytes).digest('hex')
    })
    expect(removeImmutable).toHaveBeenCalledWith(uploadStorageRef, {
      sizeBytes: uploadBytes.byteLength,
      checksum: createHash('sha256').update(uploadBytes).digest('hex')
    })
    await expect(client.artifactVersion.count()).resolves.toBe(1)
    await expect(client.uploadVersion.count()).resolves.toBe(1)
    await expect(client.managedFileVersionWriteOperation.count()).resolves.toBe(1)
    await expect(client.artifactLineage.count()).resolves.toBe(1)
    await expect(client.uploadFile.count()).resolves.toBe(1)
    await expect(client.fileOriginSession.count()).resolves.toBe(1)
  })

  it('retries claimed partial journal deletion without repairing its bytes manually', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-partial-journal-delete-retry-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)
    let corruptPublication = true
    const operator = new NodeVersionFileOperator({
      storageRoot,
      fileSystem: {
        open: async (...args) => {
          const handle = await openFile(...args)
          if (!corruptPublication || typeof args[1] !== 'string' || !args[1].startsWith('wx')) {
            return handle
          }
          return new Proxy(handle, {
            get(target, property) {
              if (property === 'write') {
                return async (
                  buffer: Uint8Array,
                  offset: number,
                  length: number,
                  position: number
                ) => {
                  const changed = Buffer.from(buffer.subarray(offset, offset + length))
                  if (changed.byteLength > 0) changed[0] = changed[0]! ^ 0xff
                  return target.write(changed, 0, changed.byteLength, position)
                }
              }
              const value = Reflect.get(target, property, target)
              return typeof value === 'function' ? value.bind(target) : value
            }
          })
        }
      }
    })
    const planInput = {
      operationId: 'partial-journal-operation',
      scope: {
        source: 'upload' as const,
        projectId: 'project-1',
        sessionId: 'session-1',
        logicalFileId: 'upload-1'
      },
      logicalFilename: 'input.csv',
      candidateIndex: 0
    }
    const plannedFile = operator.planImmutable(planInput)
    const expectedBytes = Buffer.from('complete upload edit')
    await expect(
      operator.publishImmutable({ ...planInput, plannedFile, content: expectedBytes })
    ).rejects.toBeDefined()
    const partialPath = join(storageRoot, ...plannedFile.storageRef.split('/'))
    await client.fileOriginSession.create({
      data: { projectId: 'project-1', sessionId: 'session-1' }
    })
    await client.uploadFile.create({
      data: {
        id: 'upload-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        filename: 'input.csv',
        originalFilename: 'input.csv'
      }
    })
    await client.managedFileVersionWriteOperation.create({
      data: {
        operationId: planInput.operationId,
        source: 'upload',
        projectId: 'project-1',
        sourceFileId: 'upload-1',
        basedOnVersionId: 'upload-v1',
        expectedHeadVersionId: 'upload-v1',
        state: 'failed',
        storageTag: `v${plannedFile.versionToken}`,
        storedFilename: plannedFile.storedFilename,
        contentStorageKey: plannedFile.storageRef,
        checksum: createHash('sha256').update(expectedBytes).digest('hex'),
        sizeBytes: expectedBytes.byteLength,
        textFormatJson: '{}',
        errorCode: 'CONTENT_INTEGRITY_FAILED'
      }
    })
    const removeIncomplete = operator.removeIncomplete.bind(operator)
    let removalAttempts = 0
    const versionFileOperator = Object.assign(operator, {
      removeIncomplete: async (...args: Parameters<typeof removeIncomplete>) => {
        removalAttempts += 1
        if (removalAttempts === 1) {
          throw new VersionFileOperatorError('STORAGE_UNAVAILABLE', 'temporary delete failure')
        }
        return removeIncomplete(...args)
      }
    })
    const repository = new ArtifactProvenanceRepository({
      storageRoot,
      getClient: () => Promise.resolve(client),
      versionFileOperator
    })

    await expect(repository.deleteProjectProvenance('project-1')).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE'
    })
    expect(removalAttempts).toBe(1)
    await expect(readFile(partialPath)).resolves.toHaveLength(expectedBytes.byteLength)
    await expect(client.managedFileVersionWriteOperation.count()).resolves.toBe(1)
    await expect(client.uploadFile.count()).resolves.toBe(1)
    await expect(client.fileOriginSession.count()).resolves.toBe(1)

    corruptPublication = false
    await expect(repository.deleteProjectProvenance('project-1')).resolves.toBeUndefined()
    expect(removalAttempts).toBe(2)
    await expect(readFile(partialPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(client.managedFileVersionWriteOperation.count()).resolves.toBe(0)
    await expect(client.uploadFile.count()).resolves.toBe(0)
    await expect(client.fileOriginSession.count()).resolves.toBe(0)
  })

  it('recovers an opaque partial journal from its database logical-file owner', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-opaque-journal-delete-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)
    await client.fileOriginSession.create({
      data: { projectId: 'project-1', sessionId: 'session-opaque' }
    })
    await client.uploadFile.create({
      data: {
        id: 'upload-opaque',
        projectId: 'project-1',
        sessionId: 'session-opaque',
        filename: 'internal.csv',
        originalFilename: 'Opaque.csv'
      }
    })
    const checksum = createHash('sha256').update('new').digest('hex')
    await client.managedFileVersionWriteOperation.create({
      data: {
        operationId: 'opaque-operation',
        source: 'upload',
        projectId: 'project-1',
        sourceFileId: 'upload-opaque',
        basedOnVersionId: 'upload-v1',
        expectedHeadVersionId: 'upload-v1',
        state: 'failed',
        storageTag: 'vopaque01',
        storedFilename: 'vopaque01_Opaque.csv',
        contentStorageKey: 'opaque:version-file:operation-1',
        checksum,
        sizeBytes: 3,
        textFormatJson: '{}',
        errorCode: 'CONTENT_INTEGRITY_FAILED'
      }
    })
    let reportMismatchedCandidateIndex = true
    const planImmutable = vi.fn((input: { candidateIndex: number }) => ({
      storageRef:
        input.candidateIndex === 0
          ? 'opaque:version-file:operation-1'
          : `opaque:version-file:operation-${input.candidateIndex + 1}`,
      storedFilename:
        input.candidateIndex === 0
          ? 'vopaque01_Opaque.csv'
          : `vopaque0${input.candidateIndex + 1}_Opaque.csv`,
      versionToken: input.candidateIndex === 0 ? 'opaque01' : `opaque0${input.candidateIndex + 1}`,
      candidateIndex: reportMismatchedCandidateIndex
        ? input.candidateIndex + 1
        : input.candidateIndex
    }))
    const inspectRecovery = vi.fn().mockResolvedValue({
      state: 'incomplete',
      actualIntegrity: { sizeBytes: 2, checksum: createHash('sha256').update('ne').digest('hex') }
    })
    const removeIncomplete = vi.fn().mockResolvedValue(undefined)
    const removeImmutable = vi
      .fn()
      .mockRejectedValue(new Error('opaque partial journals require recovery inspection'))
    const repository = new ArtifactProvenanceRepository({
      storageRoot,
      getClient: () => Promise.resolve(client),
      versionFileOperator: {
        planImmutable,
        inspectRecovery,
        removeIncomplete,
        removeImmutable
      } as never
    })

    await expect(repository.deleteProjectProvenance('project-1')).rejects.toThrow(
      'opaque partial journals require recovery inspection'
    )
    expect(inspectRecovery).not.toHaveBeenCalled()
    expect(removeIncomplete).not.toHaveBeenCalled()
    await expect(client.managedFileVersionWriteOperation.count()).resolves.toBe(1)
    await expect(client.uploadFile.count()).resolves.toBe(1)

    reportMismatchedCandidateIndex = false
    planImmutable.mockClear()
    removeImmutable.mockClear()

    await expect(repository.deleteProjectProvenance('project-1')).resolves.toBeUndefined()

    expect(inspectRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: 'opaque-operation',
        scope: {
          source: 'upload',
          projectId: 'project-1',
          sessionId: 'session-opaque',
          logicalFileId: 'upload-opaque'
        },
        logicalFilename: 'Opaque.csv',
        candidateIndex: 0,
        expectedIntegrity: { sizeBytes: 3, checksum }
      })
    )
    expect(removeIncomplete).toHaveBeenCalledOnce()
    expect(removeImmutable).not.toHaveBeenCalled()
    await expect(client.managedFileVersionWriteOperation.count()).resolves.toBe(0)
    await expect(client.uploadFile.count()).resolves.toBe(0)
  })

  it('deletes migrated Artifact and Upload graphs with multiple derived Versions', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-version-chain-delete-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)
    const repository = new ArtifactProvenanceRepository({
      storageRoot,
      getClient: () => Promise.resolve(client),
      compatibilityRepository: new ArtifactRepository(storageRoot)
    })

    await client.fileOriginSession.create({
      data: { projectId: 'project-1', sessionId: 'session-1' }
    })
    await client.artifactLineage.create({
      data: {
        id: 'artifact-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        normalizedFilename: 'report.md',
        filename: 'report.md'
      }
    })
    await client.artifactVersion.createMany({
      data: [
        {
          id: 'artifact-v1',
          artifactId: 'artifact-1',
          versionNumber: 1,
          filename: 'report.md',
          originKind: 'legacy',
          state: 'finalized',
          contentStorageKey: 'artifacts/project-1/session-1/artifact-v1/content',
          sizeBytes: 1,
          checksum: 'a'.repeat(64)
        },
        {
          id: 'artifact-v2',
          artifactId: 'artifact-1',
          versionNumber: 2,
          filename: 'report.md',
          originKind: 'legacy',
          basedOnVersionId: 'artifact-v1',
          state: 'finalized',
          contentStorageKey: 'artifacts/project-1/session-1/artifact-v2/content',
          sizeBytes: 2,
          checksum: 'b'.repeat(64)
        }
      ]
    })
    await client.artifactLineage.update({
      where: { id: 'artifact-1' },
      data: { currentVersionId: 'artifact-v2' }
    })

    await client.uploadFile.create({
      data: {
        id: 'upload-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        filename: 'input.csv',
        originalFilename: 'Input.csv'
      }
    })
    await client.uploadVersion.createMany({
      data: [
        {
          id: 'upload-v1',
          uploadFileId: 'upload-1',
          versionNumber: 1,
          state: 'ready',
          contentStorageKey: 'uploads/project-1/session-1/upload-1/v1/content',
          filename: 'input.csv',
          originalFilename: 'Input.csv',
          sizeBytes: 1,
          checksum: createHash('sha256').update('x').digest('hex')
        },
        {
          id: 'upload-v2',
          uploadFileId: 'upload-1',
          versionNumber: 2,
          state: 'ready',
          originKind: 'user_edit',
          basedOnVersionId: 'upload-v1',
          storageTag: 'v1a2b3c4d',
          storedFilename: 'v1a2b3c4d_input.csv',
          contentStorageKey: 'uploads/project-1/session-1/upload-1/v2/content',
          filename: 'input.csv',
          originalFilename: 'Input.csv',
          sizeBytes: 1,
          checksum: createHash('sha256').update('x').digest('hex')
        }
      ]
    })
    await client.uploadFile.update({
      where: { id: 'upload-1' },
      data: { currentVersionId: 'upload-v2' }
    })
    for (const storageKeyValue of [
      'uploads/project-1/session-1/upload-1/v1/content',
      'uploads/project-1/session-1/upload-1/v2/content'
    ]) {
      const path = join(storageRoot, ...storageKeyValue.split('/'))
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, 'x')
    }

    await expect(repository.deleteProjectProvenance('project-1')).resolves.toBeUndefined()
    await expect(client.artifactVersion.count()).resolves.toBe(0)
    await expect(client.artifactLineage.count()).resolves.toBe(0)
    await expect(client.uploadVersion.count()).resolves.toBe(0)
    await expect(client.uploadFile.count()).resolves.toBe(0)
    await expect(client.fileOriginSession.count()).resolves.toBe(0)
  })

  it('retains every Version write journal until all Artifact and Upload journal bytes are deleted', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-version-journal-delete-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)
    const repository = new ArtifactProvenanceRepository({
      storageRoot,
      getClient: () => Promise.resolve(client),
      compatibilityRepository: new ArtifactRepository(storageRoot)
    })
    const operations = [
      {
        operationId: 'operation-artifact-a-staging',
        source: 'artifact',
        state: 'staging',
        contentStorageKey: 'managed-version-journals/project-1/artifact/staging/content'
      },
      {
        operationId: 'operation-artifact-b-file-ready',
        source: 'artifact',
        state: 'file_ready',
        contentStorageKey: 'managed-version-journals/project-1/artifact/file-ready/content'
      },
      {
        operationId: 'operation-artifact-c-published',
        source: 'artifact',
        state: 'published',
        contentStorageKey: 'managed-version-journals/project-1/artifact/published/content'
      },
      {
        operationId: 'operation-upload-a-staging',
        source: 'upload',
        state: 'staging',
        contentStorageKey: 'uploads/project-1/session-1/upload-1/staging/content'
      },
      {
        operationId: 'operation-upload-b-file-ready',
        source: 'upload',
        state: 'file_ready',
        contentStorageKey: 'uploads/project-1/session-1/upload-1/file-ready/content'
      },
      {
        operationId: 'operation-upload-c-published',
        source: 'upload',
        state: 'published',
        contentStorageKey: 'uploads/project-1/session-1/upload-1/published/content'
      }
    ]
    await client.fileOriginSession.create({
      data: { projectId: 'project-1', sessionId: 'session-1' }
    })
    await client.uploadFile.create({
      data: {
        id: 'upload-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        filename: 'notes.txt',
        originalFilename: 'Notes.txt',
        currentVersionId: null,
        versions: {
          create: {
            id: 'upload-v1',
            versionNumber: 1,
            state: 'ready',
            contentStorageKey: operations[5]!.contentStorageKey,
            filename: 'notes.txt',
            originalFilename: 'Notes.txt',
            sizeBytes: 1,
            checksum: createHash('sha256').update('x').digest('hex')
          }
        }
      }
    })
    await client.uploadFile.update({
      where: { id: 'upload-1' },
      data: { currentVersionId: 'upload-v1' }
    })
    await client.managedFileVersionWriteOperation.createMany({
      data: operations.map((operation, index) => ({
        ...operation,
        projectId: 'project-1',
        sourceFileId: `${operation.source}-1`,
        basedOnVersionId: `${operation.source}-v1`,
        expectedHeadVersionId: `${operation.source}-v1`,
        storageTag: `vjournal${index}`,
        storedFilename: `vjournal${index}_notes.txt`,
        checksum: createHash('sha256').update('x').digest('hex'),
        sizeBytes: 1,
        textFormatJson: '{}'
      }))
    })
    for (const operation of operations) {
      const path = join(storageRoot, ...operation.contentStorageKey.split('/'))
      await mkdir(dirname(path), { recursive: true })
      if (operation.operationId === 'operation-artifact-b-file-ready') {
        await mkdir(path)
      } else {
        await writeFile(path, 'x')
      }
    }

    await expect(repository.deleteProjectProvenance('project-1')).rejects.toThrow()
    await expect(
      client.managedFileVersionWriteOperation.count({ where: { projectId: 'project-1' } })
    ).resolves.toBe(6)
    await expect(client.uploadFile.count({ where: { projectId: 'project-1' } })).resolves.toBe(1)
    await expect(
      readFile(join(storageRoot, ...operations[0]!.contentStorageKey.split('/')))
    ).resolves.toHaveLength(0)
    await expect(
      readFile(join(storageRoot, ...operations[2]!.contentStorageKey.split('/')))
    ).resolves.toEqual(Buffer.from('x'))

    const blockingPath = join(storageRoot, ...operations[1]!.contentStorageKey.split('/'))
    await rm(blockingPath, { recursive: true })
    await writeFile(blockingPath, 'x')
    await expect(repository.deleteProjectProvenance('project-1')).resolves.toBeUndefined()

    await expect(
      client.managedFileVersionWriteOperation.count({ where: { projectId: 'project-1' } })
    ).resolves.toBe(0)
    for (const operation of operations) {
      const operationPath = join(storageRoot, ...operation.contentStorageKey.split('/'))
      if (operation.source === 'upload') {
        await expect(readFile(operationPath)).rejects.toMatchObject({ code: 'ENOENT' })
      } else {
        await expect(readFile(operationPath)).resolves.toHaveLength(0)
      }
    }
  })

  it('retains Upload authority when Project byte deletion must be retried', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-project-upload-delete-retry-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)
    const repository = new ArtifactProvenanceRepository({
      storageRoot,
      getClient: () => Promise.resolve(client),
      compatibilityRepository: new ArtifactRepository(storageRoot)
    })
    const contentStorageKey =
      'uploads/project-1/session-1/upload-1/versions/upload-version-1/content'
    const contentPath = join(storageRoot, ...contentStorageKey.split('/'))
    await client.fileOriginSession.create({
      data: { projectId: 'project-1', sessionId: 'session-1' }
    })
    await client.uploadFile.create({
      data: {
        id: 'upload-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        filename: 'input.csv',
        originalFilename: 'input.csv',
        versions: {
          create: {
            id: 'upload-version-1',
            versionNumber: 1,
            state: 'ready',
            contentStorageKey,
            filename: 'input.csv',
            originalFilename: 'input.csv',
            contentType: 'text/csv',
            sizeBytes: BigInt(1),
            checksum: createHash('sha256').update('x').digest('hex')
          }
        }
      }
    })
    await mkdir(contentPath, { recursive: true })

    await expect(repository.deleteProjectProvenance('project-1')).rejects.toThrow()
    await expect(client.uploadFile.count({ where: { projectId: 'project-1' } })).resolves.toBe(1)
    await expect(
      client.fileOriginSession.count({ where: { projectId: 'project-1' } })
    ).resolves.toBe(1)

    await rm(contentPath, { recursive: true, force: true })
    await mkdir(dirname(contentPath), { recursive: true })
    await writeFile(contentPath, 'x')
    await repository.deleteProjectProvenance('project-1')
    await expect(client.uploadFile.count({ where: { projectId: 'project-1' } })).resolves.toBe(0)
  })
})
