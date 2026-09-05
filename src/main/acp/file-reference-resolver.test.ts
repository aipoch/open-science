import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createArtifactVersionLocator } from '../../shared/artifact-provenance'
import { createUploadVersionReference } from '../../shared/uploads'
import type { ArtifactRepository } from '../artifacts/repository'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { UploadRepository } from '../uploads/repository'
import { stageUploadFixtures } from '../uploads/repository.test-utils'
import { createManagedFileReferenceResolver } from './file-reference-resolver'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, stat: vi.fn(actual.stat) }
})

let root: string | undefined
let disconnect: (() => Promise<void>) | undefined

afterEach(async () => {
  await disconnect?.()
  disconnect = undefined
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('managed file reference resolver', () => {
  it('opens the latest trusted lease for a logical reference without reopening its path', async () => {
    const close = vi.fn(async () => undefined)
    const openLatest = vi.fn().mockResolvedValue({
      path: '/replaced-after-open.txt',
      size: 12,
      read: vi.fn(),
      readRange: vi.fn(),
      verifyUnchanged: vi.fn(),
      close,
      logicalFile: { id: 'artifact-file', displayName: 'notes.txt' },
      version: {
        id: 'artifact-version-2',
        checksum: '2'.repeat(64),
        contentType: 'text/plain'
      }
    })
    const resolver = createManagedFileReferenceResolver({
      managedFileVersions: { openLatest } as never
    })

    const resolved = await resolver.resolve(
      { projectId: 'project-1', sessionId: 'session-1' },
      {
        id: 'artifact-row',
        sourceFileId: 'artifact-file',
        versionId: 'artifact-version-2',
        name: 'stale.txt',
        path: 'artifact-version:stale',
        source: 'artifact'
      }
    )

    expect(openLatest).toHaveBeenCalledWith({
      source: 'artifact',
      projectId: 'project-1',
      fileId: 'artifact-file'
    })
    expect(resolved).toMatchObject({
      absolutePath: '/replaced-after-open.txt',
      size: 12,
      sourceFileId: 'artifact-file',
      versionId: 'artifact-version-2',
      checksum: '2'.repeat(64),
      trustedLease: { close }
    })
    expect(close).not.toHaveBeenCalled()
  })

  it.each(['artifact', 'upload'] as const)(
    'resolves a default %s reference through the current DB head at prompt preparation',
    async (source) => {
      root = await mkdtemp(join(tmpdir(), 'file-reference-head-'))
      const headPath = join(root, `${source}-v2.csv`)
      await writeFile(headPath, 'head bytes')
      const close = vi.fn(async () => undefined)
      const openLatest = vi.fn().mockResolvedValue({
        path: headPath,
        size: 10,
        read: vi.fn(),
        readRange: vi.fn(),
        verifyUnchanged: vi.fn(),
        close,
        logicalFile: { id: `${source}-file`, displayName: 'study.csv' },
        version: {
          id: `${source}-version-2`,
          checksum: '2'.repeat(64),
          contentType: 'text/csv'
        }
      })
      const resolver = createManagedFileReferenceResolver({
        managedFileVersions: { openLatest } as never
      })

      await expect(
        resolver.resolve(
          { projectId: 'project-1', sessionId: 'target-session' },
          {
            id: `${source}-row`,
            sourceFileId: `${source}-file`,
            name: 'stale-name.csv',
            path: `${source}-version:stale-projection`,
            source
          }
        )
      ).resolves.toMatchObject({
        absolutePath: headPath,
        name: 'study.csv',
        mimeType: 'text/csv',
        size: 10,
        sourceFileId: `${source}-file`,
        versionId: `${source}-version-2`,
        checksum: '2'.repeat(64)
      })
      expect(openLatest).toHaveBeenCalledWith({
        source,
        projectId: 'project-1',
        fileId: `${source}-file`
      })
      expect(close).not.toHaveBeenCalled()
    }
  )

  it('resolves an Agent reference to the latest Version even when projection metadata is stale', async () => {
    root = await mkdtemp(join(tmpdir(), 'file-reference-exact-'))
    const latestPath = join(root, 'artifact-v2.csv')
    await writeFile(latestPath, 'v2 bytes')
    const close = vi.fn(async () => undefined)
    const openLatest = vi.fn().mockResolvedValue({
      path: latestPath,
      size: 8,
      read: vi.fn(),
      readRange: vi.fn(),
      verifyUnchanged: vi.fn(),
      close,
      logicalFile: { id: 'artifact-file', displayName: 'study.csv' },
      version: {
        id: 'artifact-version-2',
        checksum: '2'.repeat(64),
        contentType: 'text/csv'
      }
    })
    const resolver = createManagedFileReferenceResolver({
      managedFileVersions: { openLatest } as never
    })

    await expect(
      resolver.resolve(
        { projectId: 'project-1', sessionId: 'target-session' },
        {
          id: 'artifact-row',
          sourceFileId: 'artifact-file',
          versionId: 'artifact-version-1',
          name: 'study.csv',
          path: 'artifact-version:stale-projection',
          source: 'artifact'
        }
      )
    ).resolves.toMatchObject({
      sourceFileId: 'artifact-file',
      versionId: 'artifact-version-2',
      checksum: '2'.repeat(64)
    })

    expect(openLatest).toHaveBeenCalledWith({
      source: 'artifact',
      projectId: 'project-1',
      fileId: 'artifact-file'
    })
    expect(close).not.toHaveBeenCalled()
  })

  it('uses the logical Artifact id in a legacy Version locator to open the latest Version', async () => {
    const close = vi.fn(async () => undefined)
    const openLatest = vi.fn().mockResolvedValue({
      path: '/trusted/latest.csv',
      size: 12,
      read: vi.fn(),
      readRange: vi.fn(),
      verifyUnchanged: vi.fn(),
      close,
      logicalFile: { id: 'artifact-file', displayName: 'latest.csv' },
      version: {
        id: 'artifact-version-3',
        checksum: '3'.repeat(64),
        contentType: 'text/csv'
      }
    })
    const resolver = createManagedFileReferenceResolver({
      artifacts: {} as ArtifactRepository,
      managedFileVersions: { openLatest } as never
    })

    await expect(
      resolver.resolve(
        { projectId: 'project-1', sessionId: 'target-session' },
        {
          id: 'legacy-artifact-reference',
          name: 'historic.csv',
          path: createArtifactVersionLocator({
            projectId: 'project-1',
            appSessionId: 'source-session',
            artifactId: 'artifact-file',
            versionId: 'artifact-version-1'
          }),
          source: 'artifact',
          mimeType: 'text/csv'
        }
      )
    ).resolves.toMatchObject({
      absolutePath: '/trusted/latest.csv',
      name: 'latest.csv',
      sourceFileId: 'artifact-file',
      versionId: 'artifact-version-3',
      checksum: '3'.repeat(64),
      trustedLease: { close }
    })
    expect(openLatest).toHaveBeenCalledWith({
      source: 'artifact',
      projectId: 'project-1',
      fileId: 'artifact-file'
    })
  })

  it('fails closed when a legacy Artifact Version locator disagrees with sourceFileId', async () => {
    const openLatest = vi.fn().mockResolvedValue({
      path: '/wrong/latest.csv',
      size: 12,
      read: vi.fn(),
      readRange: vi.fn(),
      verifyUnchanged: vi.fn(),
      close: vi.fn(),
      logicalFile: { id: 'wrong-artifact-file', displayName: 'wrong.csv' },
      version: {
        id: 'wrong-artifact-version',
        checksum: '4'.repeat(64),
        contentType: 'text/csv'
      }
    })
    const resolveManagedFilePath = vi.fn()
    const resolver = createManagedFileReferenceResolver({
      artifacts: { resolveManagedFilePath } as never,
      managedFileVersions: { openLatest } as never
    })

    await expect(
      resolver.resolve(
        { projectId: 'project-1', sessionId: 'target-session' },
        {
          id: 'legacy-artifact-reference',
          sourceFileId: 'wrong-artifact-file',
          name: 'historic.csv',
          path: createArtifactVersionLocator({
            projectId: 'project-1',
            appSessionId: 'source-session',
            artifactId: 'artifact-file',
            versionId: 'artifact-version-1'
          }),
          source: 'artifact',
          mimeType: 'text/csv'
        }
      )
    ).rejects.toThrow(/source file.*does not match.*locator/i)
    expect(openLatest).not.toHaveBeenCalled()
    expect(resolveManagedFilePath).not.toHaveBeenCalled()
  })

  it('fails closed for a legacy Artifact Version locator when latest resolution is unavailable', async () => {
    const resolver = createManagedFileReferenceResolver({
      artifacts: {} as ArtifactRepository
    })

    await expect(
      resolver.resolve(
        { projectId: 'project-1', sessionId: 'target-session' },
        {
          id: 'legacy-artifact-reference',
          name: 'historic.csv',
          path: createArtifactVersionLocator({
            projectId: 'project-1',
            appSessionId: 'source-session',
            artifactId: 'artifact-file',
            versionId: 'artifact-version-1'
          }),
          source: 'artifact',
          mimeType: 'text/csv'
        }
      )
    ).rejects.toThrow(/latest.*not configured/i)
  })

  it('rejects a path-only Upload reference instead of reopening legacy bytes', async () => {
    root = await mkdtemp(join(tmpdir(), 'file-reference-resolver-'))
    const uploads = new UploadRepository(root)
    const [pending] = await stageUploadFixtures(uploads, {
      files: [
        {
          name: 'study.csv',
          mimeType: 'text/csv',
          content: Buffer.from('id,value\n1,2\n').toString('base64')
        }
      ]
    })
    const [attachment] = await uploads.finalizePendingSessionUploads('session-1', [pending])
    const openLatest = vi.fn()
    const resolver = createManagedFileReferenceResolver({
      uploads,
      managedFileVersions: { openLatest } as never
    })

    await expect(
      resolver.resolve(
        { projectId: 'default-project', sessionId: 'session-1' },
        {
          id: attachment.id,
          name: attachment.originalName,
          path: attachment.path,
          source: 'upload',
          mimeType: attachment.mimeType
        }
      )
    ).rejects.toThrow(/logical identity/i)
    expect(openLatest).not.toHaveBeenCalled()
  })

  it('resolves an explicitly referenced Upload Version from another Session in the same Project', async () => {
    root = await mkdtemp(join(tmpdir(), 'file-reference-resolver-'))
    const client = createProjectDbClient(root)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-1', name: 'Project one' } })
    const uploads = new UploadRepository(root, { getClient: () => Promise.resolve(client) })
    const [pending] = await stageUploadFixtures(uploads, {
      files: [
        {
          name: 'shared.csv',
          mimeType: 'text/csv',
          content: Buffer.from('id,value\n1,2\n').toString('base64')
        }
      ]
    })
    const [attachment] = await uploads.finalizePendingSessionUploads(
      'source-session',
      [pending],
      'project-1'
    )
    const openLatest = vi.fn().mockResolvedValue({
      path: attachment.path,
      size: 'id,value\n1,2\n'.length,
      read: vi.fn(),
      readRange: vi.fn(),
      verifyUnchanged: vi.fn(),
      close: vi.fn(),
      logicalFile: { id: attachment.id, displayName: 'shared.csv' },
      version: {
        id: attachment.versionId,
        checksum: attachment.checksum,
        contentType: attachment.mimeType
      }
    })
    const resolver = createManagedFileReferenceResolver({
      uploads,
      managedFileVersions: { openLatest } as never
    })

    await expect(
      resolver.resolve(
        { projectId: 'project-1', sessionId: 'target-session' },
        {
          id: attachment.id,
          sourceFileId: attachment.id,
          name: attachment.originalName,
          path: createUploadVersionReference(attachment.versionId ?? '', {
            projectId: 'project-1',
            sessionId: 'source-session'
          }),
          source: 'upload',
          mimeType: attachment.mimeType
        }
      )
    ).resolves.toMatchObject({
      absolutePath: attachment.path,
      name: 'shared.csv',
      mimeType: 'text/csv',
      allowSkillImportReference: true
    })
  })

  it('rejects an explicitly referenced Upload Version from another Project', async () => {
    root = await mkdtemp(join(tmpdir(), 'file-reference-resolver-'))
    const client = createProjectDbClient(root)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-a', name: 'Project A' } })
    const uploads = new UploadRepository(root, { getClient: () => Promise.resolve(client) })
    const [pending] = await stageUploadFixtures(uploads, {
      files: [
        {
          name: 'private.csv',
          mimeType: 'text/csv',
          content: Buffer.from('secret\n').toString('base64')
        }
      ]
    })
    const [attachment] = await uploads.finalizePendingSessionUploads(
      'source-session',
      [pending],
      'project-a'
    )
    const resolver = createManagedFileReferenceResolver({
      uploads,
      managedFileVersions: {
        openLatest: vi
          .fn()
          .mockRejectedValue(new Error('Managed file belongs to a different Project.'))
      } as never
    })

    await expect(
      resolver.resolve(
        { projectId: 'project-b', sessionId: 'target-session' },
        {
          id: attachment.id,
          sourceFileId: attachment.id,
          name: attachment.originalName,
          path: createUploadVersionReference(attachment.versionId ?? '', {
            projectId: 'project-a',
            sessionId: 'source-session'
          }),
          source: 'upload',
          mimeType: attachment.mimeType
        }
      )
    ).rejects.toThrow(/different project/i)
  })

  it('rejects an explicitly referenced Artifact Version from another Project', async () => {
    const resolver = createManagedFileReferenceResolver({
      artifacts: {} as ArtifactRepository
    })

    await expect(
      resolver.resolve(
        { projectId: 'project-b', sessionId: 'target-session' },
        {
          id: 'artifact-version-1',
          name: 'private.csv',
          path: createArtifactVersionLocator({
            projectId: 'project-a',
            appSessionId: 'source-session',
            artifactId: 'artifact-1',
            versionId: 'artifact-version-1'
          }),
          source: 'artifact',
          mimeType: 'text/csv'
        }
      )
    ).rejects.toThrow(/different project/i)
  })

  it('leaves linked folders unavailable until a capability-validating adapter is registered', async () => {
    const resolver = createManagedFileReferenceResolver({})

    await expect(
      resolver.resolve(
        { projectId: 'default-project', sessionId: 'session-1' },
        {
          id: 'linked-1',
          name: 'future.csv',
          source: 'linked-folder',
          rootId: 'root-1',
          relativePath: 'data/future.csv'
        }
      )
    ).rejects.toThrow(/not configured/i)
  })

  it('resolves a linked-folder file inside the granted root', async () => {
    root = await mkdtemp(join(tmpdir(), 'file-reference-resolver-'))
    await mkdir(join(root, 'data'))
    await writeFile(join(root, 'data', 'study.csv'), 'id,value\n1,2\n')
    const resolver = createManagedFileReferenceResolver({
      grantedRoots: {
        resolveRoot: async (rootId) =>
          rootId === 'root-1' ? { path: root!, access: 'rw' } : undefined
      }
    })

    const resolved = await resolver.resolve(
      { projectId: 'default-project', sessionId: 'session-1' },
      {
        id: 'linked-1',
        name: 'study.csv',
        source: 'linked-folder',
        rootId: 'root-1',
        relativePath: 'data/study.csv',
        mimeType: 'text/csv'
      }
    )

    expect(resolved).toMatchObject({
      absolutePath: await realpath(join(root, 'data', 'study.csv')),
      name: 'study.csv',
      mimeType: 'text/csv',
      allowSkillImportReference: false
    })
    expect(resolved.uri).toMatch(/^file:/u)
  })

  it('does not expose a read-only linked-folder source path to the Agent', async () => {
    root = await mkdtemp(join(tmpdir(), 'file-reference-resolver-'))
    const sourcePath = join(root, 'study.csv')
    await writeFile(sourcePath, 'id,value\n1,2\n')
    const resolver = createManagedFileReferenceResolver({
      grantedRoots: { resolveRoot: async () => ({ path: root!, access: 'ro' }) }
    })

    const resolved = await resolver.resolve(
      { projectId: 'default-project', sessionId: 'session-1' },
      {
        id: 'linked-1',
        name: 'study.csv',
        source: 'linked-folder',
        rootId: 'root-1',
        relativePath: 'study.csv',
        mimeType: 'text/csv'
      }
    )

    expect(resolved.absolutePath).not.toBe(await realpath(sourcePath))
    expect(await readFile(resolved.absolutePath, 'utf8')).toBe('id,value\n1,2\n')
    resolver.resetSession('session-1')
    await vi.waitFor(async () => {
      await expect(stat(resolved.absolutePath)).rejects.toMatchObject({ code: 'ENOENT' })
    })
  })

  it('removes every read-only snapshot synchronously during terminal cleanup', async () => {
    root = await mkdtemp(join(tmpdir(), 'file-reference-resolver-'))
    await writeFile(join(root, 'study.csv'), 'data\n')
    const resolver = createManagedFileReferenceResolver({
      grantedRoots: { resolveRoot: async () => ({ path: root!, access: 'ro' }) }
    })
    const resolved = await resolver.resolve(
      { projectId: 'default-project', sessionId: 'session-1' },
      {
        id: 'linked-1',
        name: 'study.csv',
        source: 'linked-folder',
        rootId: 'root-1',
        relativePath: 'study.csv'
      }
    )

    resolver.clear()

    await expect(stat(resolved.absolutePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('clears only snapshots owned by the disconnected connection generation', async () => {
    root = await mkdtemp(join(tmpdir(), 'file-reference-resolver-'))
    await writeFile(join(root, 'study.csv'), 'data\n')
    const resolver = createManagedFileReferenceResolver({
      grantedRoots: { resolveRoot: async () => ({ path: root!, access: 'ro' }) }
    })
    const reference = {
      id: 'linked-1',
      name: 'study.csv',
      source: 'linked-folder' as const,
      rootId: 'root-1',
      relativePath: 'study.csv'
    }
    const oldSnapshot = await resolver.resolve(
      { projectId: 'default-project', sessionId: 'session-1', connectionGeneration: 1 },
      reference
    )
    const successorSnapshot = await resolver.resolve(
      { projectId: 'default-project', sessionId: 'session-1', connectionGeneration: 2 },
      reference
    )

    resolver.clearGeneration(1)

    await expect(stat(oldSnapshot.absolutePath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(successorSnapshot.absolutePath)).resolves.toMatchObject({ size: 5 })
    resolver.clear()
  })

  it('bounds cumulative read-only snapshot storage for a Session', async () => {
    root = await mkdtemp(join(tmpdir(), 'file-reference-resolver-'))
    await writeFile(join(root, 'first.txt'), '123')
    await writeFile(join(root, 'second.txt'), '456')
    const resolver = createManagedFileReferenceResolver({
      grantedRoots: { resolveRoot: async () => ({ path: root!, access: 'ro' }) },
      readOnlyProjectionMaxSessionBytes: 5
    })
    const context = { projectId: 'default-project', sessionId: 'session-1' }
    await resolver.resolve(context, {
      id: 'linked-1',
      name: 'first.txt',
      source: 'linked-folder',
      rootId: 'root-1',
      relativePath: 'first.txt'
    })

    await expect(
      resolver.resolve(context, {
        id: 'linked-2',
        name: 'second.txt',
        source: 'linked-folder',
        rootId: 'root-1',
        relativePath: 'second.txt'
      })
    ).rejects.toThrow(/Session storage limit/i)
    resolver.clear()
  })

  it('bounds the bytes actually copied into a read-only snapshot', async () => {
    root = await mkdtemp(join(tmpdir(), 'file-reference-resolver-'))
    const sourcePath = join(root, 'growing.txt')
    await writeFile(sourcePath, '1234')
    const resolver = createManagedFileReferenceResolver({
      grantedRoots: { resolveRoot: async () => ({ path: root!, access: 'ro' }) },
      readOnlyProjectionMaxSessionBytes: 5
    })
    const context = { projectId: 'default-project', sessionId: 'session-1' }
    const reference = {
      id: 'linked-1',
      name: 'growing.txt',
      source: 'linked-folder' as const,
      rootId: 'root-1',
      relativePath: 'growing.txt'
    }
    const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(stat).mockImplementationOnce(async (path) => {
      const beforeGrowth = await actualFs.stat(path)
      await writeFile(sourcePath, '123456')
      return beforeGrowth
    })

    await expect(resolver.resolve(context, reference)).rejects.toThrow(/Session storage limit/i)

    await writeFile(sourcePath, '12345')
    await expect(resolver.resolve(context, reference)).resolves.toMatchObject({ size: 5 })
    resolver.clear()
  })

  it('rejects a linked-folder reference with an unknown root id', async () => {
    root = await mkdtemp(join(tmpdir(), 'file-reference-resolver-'))
    const resolver = createManagedFileReferenceResolver({
      grantedRoots: { resolveRoot: async () => undefined }
    })

    await expect(
      resolver.resolve(
        { projectId: 'default-project', sessionId: 'session-1' },
        {
          id: 'linked-1',
          name: 'study.csv',
          source: 'linked-folder',
          rootId: 'nope',
          relativePath: 'study.csv'
        }
      )
    ).rejects.toThrow(/unknown granted folder root/i)
  })

  it('rejects a linked-folder reference that escapes the root via ..', async () => {
    root = await mkdtemp(join(tmpdir(), 'file-reference-resolver-'))
    const granted = join(root, 'granted')
    await mkdir(granted)
    await writeFile(join(root, 'secret.txt'), 'outside\n')
    const resolver = createManagedFileReferenceResolver({
      grantedRoots: { resolveRoot: async () => ({ path: granted, access: 'ro' }) }
    })

    await expect(
      resolver.resolve(
        { projectId: 'default-project', sessionId: 'session-1' },
        {
          id: 'linked-1',
          name: 'secret.txt',
          source: 'linked-folder',
          rootId: 'root-1',
          relativePath: '../secret.txt'
        }
      )
    ).rejects.toThrow(/escapes the granted folder/i)
  })

  it('rejects a linked-folder reference that escapes the root via a symlink', async () => {
    root = await mkdtemp(join(tmpdir(), 'file-reference-resolver-'))
    const granted = join(root, 'granted')
    await mkdir(granted)
    await writeFile(join(root, 'secret.txt'), 'outside\n')
    await symlink(join(root, 'secret.txt'), join(granted, 'leak.txt'))
    const resolver = createManagedFileReferenceResolver({
      grantedRoots: { resolveRoot: async () => ({ path: granted, access: 'ro' }) }
    })

    await expect(
      resolver.resolve(
        { projectId: 'default-project', sessionId: 'session-1' },
        {
          id: 'linked-1',
          name: 'leak.txt',
          source: 'linked-folder',
          rootId: 'root-1',
          relativePath: 'leak.txt'
        }
      )
    ).rejects.toThrow(/escapes the granted folder/i)
  })
})
