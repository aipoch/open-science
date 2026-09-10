import { ArtifactProvenanceDependencyReader } from '../artifacts/provenance-dependency-reader'
import { ManagedPreviewResources } from '../managed-preview-resources'
import { ImmutableInputAuthority } from '../immutable-input-authority'
import { createComputeArtifactResolver } from '../compute/compute-job-workflow-owner'
import { mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PrismaClient } from '@prisma/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { ManagedFileVersionService } from '../managed-file-versions/service'
import { ManagedFileIndexRepository } from './repository'
import { UploadRepository } from '../uploads/repository'

describe('hidden artifacts (isolated SQLite and files)', () => {
  let root: string
  let client: PrismaClient
  let versions: ManagedFileVersionService
  let files: ManagedFileIndexRepository
  let fileId: string
  let versionId: string
  const identity = (): { source: 'artifact'; projectId: string; fileId: string } => ({
    source: 'artifact' as const,
    projectId: 'project-a',
    fileId
  })

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'open-science-hidden-'))
    client = createProjectDbClient(root)
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-a', name: 'Temporary project' } })
    await client.fileOriginSession.create({
      data: { projectId: 'project-a', sessionId: 'session-a' }
    })
    versions = new ManagedFileVersionService({ storageRoot: root, getClient: async () => client })
    files = new ManagedFileIndexRepository(
      async () => client,
      root,
      versions,
      new UploadRepository(root, { getClient: async () => client })
    )
    const adopted = await versions.adoptLegacyArtifact({
      projectId: 'project-a',
      sessionId: 'session-a',
      sourceFileId: 'artifact-a',
      logicalFilename: 'secret.txt',
      content: Buffer.from('private result')
    })
    fileId = adopted.fileId
    versionId = adopted.versionId
  })

  afterEach(async () => {
    await client?.$disconnect()
    if (root) await rm(root, { recursive: true, force: true })
  })

  it('excludes hidden files from ordinary catalogs and searches while keeping the Hidden collection', async () => {
    await files.setArtifactHidden({ projectId: 'project-a', fileId, hidden: true })
    expect(
      (await files.listFiles({ projectId: 'project-a', collection: { kind: 'all' }, limit: 20 }))
        .items
    ).toEqual([])
    expect((await files.listArtifactGroups({ projectId: 'project-a', limit: 20 })).items).toEqual(
      []
    )
    expect(
      (
        await files.searchArtifacts({
          primaryProjectIds: ['project-a'],
          otherProjectIds: [],
          primaryLimit: 20,
          otherLimit: 0
        })
      ).primary.items
    ).toEqual([])
    expect(await files.readHostArtifactCatalog({ projectId: 'project-a', versionId })).toEqual([])
    const hidden = await files.listFiles({
      projectId: 'project-a',
      collection: { kind: 'hidden' },
      limit: 20
    })
    expect(hidden.items.map((item) => item.sourceFileId)).toEqual([fileId])
    expect(await files.getOverview('project-a')).toMatchObject({
      totalCount: 0,
      hiddenArtifactCount: 1
    })
    await files.setArtifactHidden({ projectId: 'project-a', fileId, hidden: false })
    expect(
      (
        await files.listFiles({ projectId: 'project-a', collection: { kind: 'all' }, limit: 20 })
      ).items.map((item) => item.sourceFileId)
    ).toEqual([fileId])
  })

  it('removes hidden source and output dependencies from public lineage queries', async () => {
    const output = await versions.adoptLegacyArtifact({
      projectId: 'project-a',
      sessionId: 'session-a',
      sourceFileId: 'artifact-b',
      logicalFilename: 'derived.txt',
      content: Buffer.from('derived result')
    })
    const source = await client.artifactVersion.findUniqueOrThrow({ where: { id: versionId } })
    await client.artifactVersionInput.create({
      data: {
        id: 'dependency',
        artifactVersionId: output.versionId,
        ordinal: 0,
        inputFileVersionId: versionId,
        sourceKind: 'artifact-version',
        sourceFileId: fileId,
        sourceArtifactVersionId: versionId,
        sourceVersionNumber: source.versionNumber,
        sourceCreatedAt: source.createdAt,
        sourceProjectId: 'project-a',
        sourceSessionId: 'session-a',
        filename: source.filename,
        contentType: source.contentType,
        sizeBytes: source.sizeBytes,
        checksum: source.checksum!,
        storageKey: source.contentStorageKey,
        strongestAssociation: 'resolver-accessed'
      }
    })
    const reader = new ArtifactProvenanceDependencyReader(async () => client)
    const request = {
      projectId: 'project-a',
      versionId: output.versionId,
      direction: 'up' as const
    }
    expect(await reader.readDependencyRelations(request)).toHaveLength(1)
    await files.setArtifactHidden({ projectId: 'project-a', fileId, hidden: true })
    expect(await reader.readDependencyRelations(request)).toEqual([])
    expect(
      await reader.readDependencyRelations({ ...request, versionId, direction: 'down' })
    ).toEqual([])
    expect(await client.artifactVersionInput.count()).toBe(1)
  })

  it('blocks canonical and symlink paths, held local previews, and existing Notebook staging copies', async () => {
    const lease = await versions.openLatest(identity())
    const path = lease.path
    await lease.close()
    const inputs = new ImmutableInputAuthority({ storageRoot: root, managedFileVersions: versions })
    const staged = await inputs.stageVersion({
      projectId: 'project-a',
      targetSessionId: 'session-a',
      sourceKind: 'artifact-version',
      expectedSourceFileId: fileId,
      inputFileVersionId: versionId
    })
    const previews = new ManagedPreviewResources({
      resolvePath: async () => path,
      assertPathVisible: (candidate) => versions.assertArtifactPathVisible(candidate)
    })
    const resource = await previews.acquire(1, { source: 'local', path })
    const response = await previews.resolveProtocolResource(resource.id)
    expect('fileHandle' in response).toBe(true)
    await files.setArtifactHidden({ projectId: 'project-a', fileId, hidden: true })
    await expect(versions.assertArtifactPathVisible(path)).rejects.toMatchObject({
      code: 'FILE_NOT_FOUND'
    })
    await expect(versions.assertArtifactPathVisible(staged)).rejects.toMatchObject({
      code: 'FILE_NOT_FOUND'
    })
    await expect(
      previews.readRange(1, { resourceId: resource.id, begin: 0, end: 7 })
    ).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' })
    await expect(previews.resolveProtocolResource(resource.id)).rejects.toMatchObject({
      code: 'FILE_NOT_FOUND'
    })
    if ('fileHandle' in response) {
      await expect(response.fileHandle.read(new Uint8Array(7), 0, 7, 0)).rejects.toMatchObject({
        code: 'FILE_NOT_FOUND'
      })
      await response.fileHandle.close()
    }
    previews.release(1, { resourceId: resource.id })
    const compute = createComputeArtifactResolver(
      await realpath(root),
      async (value) => value,
      (value) => versions.assertArtifactPathVisible(value)
    )
    await expect(
      compute.resolveArtifactPath(staged, {
        projectId: 'project-a',
        sessionId: 'session-a',
        providerId: 'local'
      })
    ).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' })
    // Match macOS /var aliases and user-selected symlink data roots without leaving test data behind.
    const alias = root + '-alias'
    await symlink(root, alias, 'dir')
    try {
      const aliased = new ManagedFileVersionService({
        storageRoot: alias,
        getClient: async () => client
      })
      await expect(aliased.assertArtifactPathVisible(path)).rejects.toMatchObject({
        code: 'FILE_NOT_FOUND'
      })
    } finally {
      await rm(alias)
    }
  })

  it('rejects wrong-project and wrong-version Hidden reads and restores ordinary access on unhide', async () => {
    await files.setArtifactHidden({ projectId: 'project-a', fileId, hidden: true })
    await expect(
      versions.openHiddenArtifactVersion({ projectId: 'project-b', fileId }, versionId)
    ).rejects.toBeDefined()
    await expect(
      versions.openHiddenArtifactVersion({ projectId: 'project-a', fileId }, 'wrong-version')
    ).rejects.toBeDefined()
    const oldHidden = await versions.openHiddenArtifactVersion(
      { projectId: 'project-a', fileId },
      versionId
    )
    await files.setArtifactHidden({ projectId: 'project-a', fileId, hidden: false })
    await expect(oldHidden.readRange(0, 7)).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' })
    await oldHidden.close()
    const ordinary = await versions.openLatest(identity())
    expect(Buffer.from(await ordinary.readRange(0, ordinary.size)).toString()).toBe(
      'private result'
    )
    await ordinary.close()
  })

  it('revokes old reads and denies direct version access but permits the dedicated hidden reader', async () => {
    const lease = await versions.openLatest(identity())
    await files.setArtifactHidden({ projectId: 'project-a', fileId, hidden: true })
    await expect(versions.openLatest(identity())).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' })
    await expect(versions.openVersion(identity(), versionId)).rejects.toMatchObject({
      code: 'FILE_NOT_FOUND'
    })
    await expect(versions.inspect(identity())).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' })
    await expect(lease.readRange(0, 7)).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' })
    await expect(lease.copyTo(join(root, 'forbidden-copy.txt'))).rejects.toMatchObject({
      code: 'FILE_NOT_FOUND'
    })
    await lease.close()
    const allowed = await versions.openHiddenArtifactVersion(
      { projectId: 'project-a', fileId },
      versionId
    )
    expect(Buffer.from(await allowed.readRange(0, allowed.size)).toString()).toBe('private result')
    await allowed.close()
    // A separate repository instance must observe the persisted policy without renderer state.
    const restarted = new ManagedFileVersionService({
      storageRoot: root,
      getClient: async () => client
    })
    await expect(restarted.openLatest(identity())).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' })
  })
})
