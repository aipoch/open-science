import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ArtifactVersionFile } from '../../shared/artifact-provenance'
import { createLinearConversationGraph } from '../../shared/conversation-graph'
import type { NotebookEnvironmentManifest } from '../../shared/notebook'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { createProjectDbClient, ensureProjectSchema } from '../projects/prisma-client'
import { NotebookRunRepository } from '../notebook/repository'
import { createPngBytes, createPngInlineSource } from './artifact-test-fixtures'
import { ArtifactProvenanceRepository } from './provenance-repository'
import { ArtifactRepository } from './repository'

let storageRoot: string | undefined
let disconnect: (() => Promise<void>) | undefined

afterEach(async () => {
  await disconnect?.()
  disconnect = undefined

  if (storageRoot) {
    await rm(storageRoot, { recursive: true, force: true })
    storageRoot = undefined
  }
})

describe('artifact provenance repository', () => {
  it('keeps immutable bytes while same-session same-name saves advance one lineage', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-artifact-versions-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await ensureProjectSchema(client)

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
      projectName: common.projectId,
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

    await compatibilityRepository.writePendingFile({
      projectName: common.projectId,
      sessionId: common.artifactStorageSessionId,
      runId: common.artifactRunId,
      filename: common.filename,
      mimeType: common.contentType,
      source: createPngInlineSource('version two')
    })
    const second = await repository.createVersion({
      ...common,
      writeOperationId: 'write-2',
      writeRequestChecksum: 'b'.repeat(64)
    })
    const third = await repository.createVersion({
      ...common,
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
      projectName: otherSession.projectId,
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
    await expect(
      repository.resolveVersionContent({
        projectId: common.projectId,
        appSessionId: common.appSessionId,
        artifactId: first.artifactId,
        versionId: first.versionId
      })
    ).resolves.toMatchObject({ path: first.path, filename: common.filename })
    await expect(
      repository.resolveVersionContent({
        projectId: common.projectId,
        appSessionId: 'session-2',
        artifactId: first.artifactId,
        versionId: first.versionId
      })
    ).rejects.toThrow(`Artifact Version not found: ${first.versionId}`)
    const firstRow = await client.artifactVersion.findUniqueOrThrow({
      where: { id: first.versionId }
    })
    expect(JSON.parse(firstRow.evidenceJson)).toMatchObject({ agent_name: 'Codex' })

    const versions = await client.artifactVersion.findMany({
      where: { artifactId: first.artifactId },
      orderBy: { versionNumber: 'asc' }
    })
    expect(versions.map((version) => version.versionNumber)).toEqual([1, 2, 3])
  })

  it('publishes app-generated compatibility bytes and an immutable Version together', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-app-generated-artifact-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await ensureProjectSchema(client)
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
    const row = await client.artifactVersion.findUniqueOrThrow({
      where: { id: version.versionId }
    })
    expect(JSON.parse(row.evidenceJson)).toMatchObject({
      producer: { state: 'unavailable', reason: 'producer-not-supplied' },
      execution_status: { state: 'unavailable', reason: 'producer-not-supplied' }
    })
  })

  it('returns the original Version for an exact write-operation retry without rereading changed pending bytes', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-artifact-idempotency-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await ensureProjectSchema(client)

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
      projectName: request.projectId,
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
      projectName: request.projectId,
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
    await ensureProjectSchema(client)
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
    await compatibilityRepository.writePendingFile({
      projectName: request.projectId,
      sessionId: request.artifactStorageSessionId,
      runId: request.artifactRunId,
      filename: request.filename,
      mimeType: request.contentType,
      source: createPngInlineSource('durable file failure')
    })

    await expect(repository.createVersion(request)).rejects.toThrow(
      'simulated durable file failure'
    )

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
    await ensureProjectSchema(client)
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
      projectName: request.projectId,
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
    await ensureProjectSchema(client)
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
      projectName: request.projectId,
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
    await ensureProjectSchema(client)
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
        deletionOperationId: 'delete-1'
      }
    })
    await compatibilityRepository.writePendingFile({
      projectName: 'project-1',
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
    await ensureProjectSchema(client)
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
        sizeBytes: BigInt(Buffer.byteLength('expected')),
        checksum: createHash('sha256').update('expected').digest('hex'),
        evidenceJson,
        evidenceChecksum
      }
    })

    await expect(repository.reconcileSession('project-1', 'session-1')).resolves.toEqual({
      recoveredVersionIds: [versionId],
      quarantinedVersionIds: [corruptVersionId]
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
    await ensureProjectSchema(client)

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
          loadedState: 'loaded'
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
              afterVersion: '2.2.0'
            }
          ]
        }
      ],
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
      projectName: 'project-1',
      sessionId: 'session-1',
      workspaceCwd: '/workspace'
    })
    const producerSourcePath = join(notebookDocument.notebookSessionRoot, 'data', 'sin.png')
    await mkdir(dirname(producerSourcePath), { recursive: true })
    await writeFile(producerSourcePath, createPngBytes('plot bytes'))
    const producerSourceStat = await stat(producerSourcePath)
    await notebookRepository.appendRun({
      projectName: 'project-1',
      sessionId: 'session-1',
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
      projectName: 'project-1',
      sessionId: 'session-1',
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
      projectName: 'project-1',
      sessionId: 'session-1',
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
      projectName: 'project-1',
      sessionId: 'session-1',
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
    await compatibilityRepository.writePendingFile({
      projectName: 'project-1',
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
    const row = await client.artifactVersion.findUniqueOrThrow({ where: { id: version.versionId } })
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
            loaded_state: 'loaded'
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
                after_version: '2.2.0'
              })
            ]
          })
        ],
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
      ]
    })
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
    await expect(
      readFile(join(storageRoot, ...String(row.executionSnapshotStorageKey).split('/')), 'utf8')
    ).resolves.toBe(row.executionSnapshotJson)

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
    expect(lineage.versions[0]).not.toHaveProperty('path')
    expect(lineage.versions[0]).not.toHaveProperty('fileUrl')
    await expect(
      repository.getLineage({
        projectId: 'project-1',
        appSessionId: 'different-session',
        artifactId: version.artifactId
      })
    ).rejects.toThrow(`Artifact lineage not found: ${version.artifactId}`)
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
      projectName: 'project-1',
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
    const inferredRow = await client.artifactVersion.findUniqueOrThrow({
      where: { id: inferred.versionId }
    })
    expect(inferredRow).toMatchObject({ producerRunId: null, producerRunIndex: null })
    expect(JSON.parse(inferredRow.evidenceJson)).toMatchObject({
      producer: { state: 'unavailable', reason: 'producer-not-supplied' },
      execution_status: { state: 'unavailable', reason: 'producer-not-supplied' }
    })

    await notebookRepository.appendRun({
      projectName: 'project-1',
      sessionId: 'session-1',
      run: {
        ...baseRun,
        runId: 'notebook-run-3',
        cellId: 'cell-3',
        script: 'save_another_plot()',
        inputFiles: []
      }
    })
    await compatibilityRepository.writePendingFile({
      projectName: 'project-1',
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
        path: join(notebookDocument.notebookSessionRoot, 'data', 'ambiguous.png'),
        sizeBytes: Buffer.byteLength('ambiguous plot bytes'),
        mtimeMs: 1.5
      },
      filename: 'ambiguous.png',
      contentType: 'image/png'
    })
    const ambiguousRow = await client.artifactVersion.findUniqueOrThrow({
      where: { id: ambiguous.versionId }
    })
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
    await client.finding.create({
      data: {
        id: 'finding-direct-pass',
        reviewId: 'review-direct-pass',
        status: 'pass',
        claim: 'Artifact values match the execution output.',
        evidence: 'Recomputed from the immutable Artifact Version.',
        artifactVersionId: version.versionId,
        artifactBindingState: 'scope_validated'
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
          currentDirectAssessment: { id: 'review-direct-pass', outcome: 'pass' },
          latestChainReview: { id: 'review-direct-pass', outcome: 'pass' },
          selectedVersionChecks: [{ artifactBindingState: 'scope_validated' }]
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

  it('does not infer an omitted producer from source mtime alone', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-artifact-auto-producer-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await ensureProjectSchema(client)

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
      projectName: 'project-1',
      sessionId: 'session-1',
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
      projectName: 'project-1',
      sessionId: 'session-1',
      run: {
        ...baseRun,
        runId: 'notebook-run-before',
        script: 'unrelated()',
        startedAt: sourceStat.mtimeMs - 300,
        endedAt: sourceStat.mtimeMs - 200
      }
    })
    await notebookRepository.appendRun({
      projectName: 'project-1',
      sessionId: 'session-1',
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
      projectName: 'project-1',
      sessionId: 'artifact-session-1',
      runId: 'artifact-run-1',
      filename: 'sin.png',
      source: { kind: 'inline', content: content.toString('base64'), encoding: 'base64' }
    })

    const version = await repository.createVersion({
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
    const row = await client.artifactVersion.findUniqueOrThrow({
      where: { id: version.versionId }
    })

    expect(row).toMatchObject({ producerRunId: null, producerRunIndex: null })
    expect(JSON.parse(row.evidenceJson)).toMatchObject({
      producer: {
        state: 'unavailable',
        reason: 'producer-source-unverifiable'
      },
      execution_status: { state: 'unavailable', reason: 'producer-source-unverifiable' }
    })
    await expect(
      repository.replayVersion({
        projectId: 'project-1',
        appSessionId: 'session-1',
        artifactStorageSessionId: 'artifact-session-1',
        artifactRunId: 'artifact-run-1',
        writeOperationId: 'write-auto-producer',
        filename: 'sin.png',
        contentType: 'image/png'
      })
    ).resolves.toMatchObject({ versionId: version.versionId })
  })

  it('uses exact observed ownership and scope-validates an inline producer declaration', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-artifact-producer-mismatch-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await ensureProjectSchema(client)

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
      projectName: 'project-1',
      sessionId: 'session-1',
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
      projectName: 'project-1',
      sessionId: 'session-1',
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
      projectName: 'project-1',
      sessionId: 'session-1',
      run: {
        ...commonRun,
        runId: 'notebook-run-wrong',
        cellId: 'cell-wrong',
        script: 'unrelated()',
        workingFiles: []
      }
    })
    await compatibilityRepository.writePendingFile({
      projectName: 'project-1',
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
    const inferredRow = await client.artifactVersion.findUniqueOrThrow({
      where: { id: inferred.versionId }
    })
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
      projectName: 'project-1',
      sessionId: 'artifact-session-1',
      runId: 'artifact-run-1',
      filename: 'spoof.png',
      source: createPngInlineSource('different artifact bytes')
    })
    const spoofedObservation = await repository.createVersion({
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
    const spoofedRow = await client.artifactVersion.findUniqueOrThrow({
      where: { id: spoofedObservation.versionId }
    })
    expect(spoofedRow).toMatchObject({ producerRunId: null, producerRunIndex: null })
    expect(JSON.parse(spoofedRow.evidenceJson)).toMatchObject({
      producer: { state: 'unavailable', reason: 'producer-source-unverifiable' }
    })

    await compatibilityRepository.writePendingFile({
      projectName: 'project-1',
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
    const inlineRow = await client.artifactVersion.findUniqueOrThrow({
      where: { id: inline.versionId }
    })
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
      projectName: 'project-1',
      sessionId: 'artifact-session-1',
      runId: 'artifact-run-1',
      filename: 'unobserved-local.png',
      source: createPngInlineSource('unobserved local bytes')
    })
    const unobservedLocal = await repository.createVersion({
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
    const unobservedLocalRow = await client.artifactVersion.findUniqueOrThrow({
      where: { id: unobservedLocal.versionId }
    })
    expect(unobservedLocalRow).toMatchObject({ producerRunId: null, producerRunIndex: null })
    expect(JSON.parse(unobservedLocalRow.evidenceJson)).toMatchObject({
      producer: { state: 'unavailable', reason: 'producer-source-unverifiable' },
      execution_status: { state: 'unavailable', reason: 'producer-source-unverifiable' }
    })
  })

  it('rejects a renderer-supplied message that the durable Conversation Graph does not own', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-artifact-finalize-ownership-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await ensureProjectSchema(client)

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
      projectName: 'project-1',
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

    await expect(
      repository.finalizeRun({
        projectId: 'project-1',
        appSessionId: 'session-1',
        artifactRunId: 'artifact-run-1',
        ...context,
        messageId: 'message-forged',
        messageBranchAncestry: [branch.id],
        messageAncestry: [prompt.id, 'message-forged']
      })
    ).rejects.toThrow(/durable Session graph|Branch descendant/i)

    const durablePrompt = conversationGraph.messages.find((message) => message.id === prompt.id)!
    durablePrompt.status = 'streaming'
    await expect(
      repository.finalizeRun({
        projectId: 'project-1',
        appSessionId: 'session-1',
        artifactRunId: 'artifact-run-1',
        ...context,
        messageId: assistant.id
      })
    ).rejects.toThrow(/Branch descendant/i)

    durablePrompt.status = 'complete'
    const durableAssistant = conversationGraph.messages.find(
      (message) => message.id === assistant.id
    )!
    durableAssistant.status = 'streaming'
    await expect(
      repository.validateFinalizationOwnership({
        projectId: 'project-1',
        appSessionId: 'session-1',
        artifactRunId: 'artifact-run-1',
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
    await ensureProjectSchema(client)

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

    for (const [index, content] of ['first', 'second'].entries()) {
      await compatibilityRepository.writePendingFile({
        projectName: common.projectId,
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

    const finalizeRequest = {
      projectId: common.projectId,
      appSessionId: common.appSessionId,
      artifactRunId: common.artifactRunId,
      rootFrameId: common.rootFrameId,
      agentFrameId: common.agentFrameId,
      messageBranchId: common.messageBranchId,
      runtimeSegmentId: common.runtimeSegmentId,
      promptMessageId: common.promptMessageId,
      messageId: 'message-1'
    }
    const finalized = await repository.finalizeRun(finalizeRequest)
    const replayed = await repository.finalizeRun(finalizeRequest)

    expect(finalized.map((version) => version.versionNumber)).toEqual([1, 2])
    expect(replayed.map((version) => version.versionId)).toEqual(
      finalized.map((version) => version.versionId)
    )
    expect(
      await client.artifactVersion.count({
        where: { state: 'finalized', messageId: 'message-1' }
      })
    ).toBe(2)

    await expect(
      repository.finalizeRun({ ...finalizeRequest, messageId: 'message-2' })
    ).rejects.toThrow(/Branch descendant|different message/i)
    await expect(
      repository.finalizeRun({
        ...finalizeRequest,
        messageBranchAncestry: ['branch-other'],
        messageAncestry: ['prompt-1', 'message-1']
      })
    ).resolves.toHaveLength(2)
  })

  it('replays the compatibility-marker crash window only with durable Branch ownership', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-artifact-marker-recovery-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await ensureProjectSchema(client)
    const compatibilityRepository = new ArtifactRepository(storageRoot)
    const repository = new ArtifactProvenanceRepository({
      storageRoot,
      getClient: () => Promise.resolve(client),
      compatibilityRepository
    })
    const context = {
      rootFrameId: 'root-frame-1',
      agentFrameId: 'root-frame-1',
      messageBranchId: 'branch-1',
      runtimeSegmentId: 'runtime-segment-1',
      promptMessageId: 'prompt-1'
    } as const
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
      projectName: request.projectId,
      sessionId: request.artifactStorageSessionId,
      runId: request.artifactRunId,
      filename: request.filename,
      source: createPngInlineSource('crash-window')
    })
    const version = await repository.createVersion(request)
    // Simulate process exit after compatibility finalize wrote its marker/moved bytes but before the
    // Provenance transaction advanced pending -> finalized.
    await compatibilityRepository.finalizeRunArtifacts({
      projectName: request.projectId,
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
    const session: PersistedChatSession = {
      id: 'session-1',
      projectId: 'project-1',
      title: 'Recovery',
      cwd: '/workspace',
      status: 'idle',
      messages: [prompt, message],
      conversationGraph: {
        schemaVersion: 1,
        rootFrameId: context.rootFrameId,
        activeFrameId: context.agentFrameId,
        frames: [
          {
            id: context.agentFrameId,
            originBindingState: 'root',
            kind: 'root',
            status: 'completed',
            activeBranchId: context.messageBranchId,
            createdAt: 1,
            completedAt: 2
          }
        ],
        branches: [
          {
            id: context.messageBranchId,
            agentFrameId: context.agentFrameId,
            headMessageId: message.id,
            createdAt: 1,
            updatedAt: 2
          }
        ],
        messages: [
          {
            ...prompt,
            agentFrameId: context.agentFrameId,
            introducedOnBranchId: context.messageBranchId,
            revisionRootMessageId: prompt.id,
            runtimeSegmentId: context.runtimeSegmentId
          },
          {
            ...message,
            agentFrameId: context.agentFrameId,
            introducedOnBranchId: context.messageBranchId,
            parentMessageId: prompt.id,
            runtimeSegmentId: context.runtimeSegmentId
          }
        ],
        activities: [],
        activityGroups: [],
        runtimeSegments: [
          {
            id: context.runtimeSegmentId,
            agentFrameId: context.agentFrameId,
            frameworkId: 'codex',
            startedAt: 1,
            endedAt: 2
          }
        ]
      },
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

  it('serializes concurrent Unicode case-folded writes into one monotonic lineage', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-artifact-concurrent-'))
    const client = createProjectDbClient(storageRoot)
    const secondClient = createProjectDbClient(storageRoot)
    disconnect = async () => {
      await Promise.all([client.$disconnect(), secondClient.$disconnect()])
    }
    await ensureProjectSchema(client)
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
        projectName: common.projectId,
        sessionId: common.artifactStorageSessionId,
        runId: common.artifactRunId,
        filename,
        source: createPngInlineSource(filename)
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
    await ensureProjectSchema(client)
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
      projectName: request.projectId,
      sessionId: request.artifactStorageSessionId,
      runId: request.artifactRunId,
      filename: request.filename,
      source: createPngInlineSource('plot bytes')
    })
    const version = await repository.createVersion(request)
    const versionRow = await client.artifactVersion.findUniqueOrThrow({
      where: { id: version.versionId }
    })
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
    ).resolves.toBe(versionRow.evidenceJson)
  })

  it('reconstructs a missing finalized SQLite Version only from exact Message-snapshot ownership', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-artifact-row-recovery-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await ensureProjectSchema(client)
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
      projectName: request.projectId,
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
      rootFrameId: request.rootFrameId,
      agentFrameId: request.agentFrameId,
      messageBranchId: request.messageBranchId,
      runtimeSegmentId: request.runtimeSegmentId,
      promptMessageId: request.promptMessageId,
      messageId: 'message-1'
    })
    await compatibilityRepository.finalizeRunArtifacts({
      projectName: request.projectId,
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
    await client.artifactVersion.delete({ where: { id: version.versionId } })

    await expect(
      repository.reconcileSession(request.projectId, request.appSessionId)
    ).resolves.toEqual({ recoveredVersionIds: [version.versionId], quarantinedVersionIds: [] })
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
    await ensureProjectSchema(client)
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
      projectName: request.projectId,
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
    ).resolves.toEqual({ recoveredVersionIds: [version.versionId], quarantinedVersionIds: [] })
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
    await ensureProjectSchema(client)
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
      projectName: request.projectId,
      sessionId: request.artifactStorageSessionId,
      runId: request.artifactRunId,
      filename: request.filename,
      mimeType: request.contentType,
      source: createPngInlineSource('recover after scan repair')
    })
    const version = await repository.createVersion(request)
    await client.artifactVersion.delete({ where: { id: version.versionId } })

    await compatibilityRepository.writePendingFile({
      projectName: request.projectId,
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
    ).resolves.toEqual({ recoveredVersionIds: [], quarantinedVersionIds: [] })
    await expect(readFile(version.path)).resolves.toBeTruthy()
    await expect(
      client.artifactVersion.findUnique({ where: { id: version.versionId } })
    ).resolves.toBeNull()

    await rm(corruptMetadataPath)
    await expect(
      repository.reconcileSession(request.projectId, request.appSessionId)
    ).resolves.toEqual({ recoveredVersionIds: [version.versionId], quarantinedVersionIds: [] })
  })

  it('quarantines an unindexed Version when no immutable lifecycle proof exists', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-artifact-row-quarantine-'))
    const client = createProjectDbClient(storageRoot)
    disconnect = () => client.$disconnect()
    await ensureProjectSchema(client)
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
      projectName: request.projectId,
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
    ).resolves.toEqual({ recoveredVersionIds: [], quarantinedVersionIds: [version.versionId] })
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
    await ensureProjectSchema(client)
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
        projectName: projectId,
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
})
