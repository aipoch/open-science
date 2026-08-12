import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
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

let root: string | undefined
let disconnect: (() => Promise<void>) | undefined

afterEach(async () => {
  await disconnect?.()
  disconnect = undefined
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('managed file reference resolver', () => {
  it('validates upload paths and returns trusted on-disk metadata', async () => {
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
    const resolver = createManagedFileReferenceResolver({ uploads })

    const resolved = await resolver.resolve(
      { projectId: 'default-project', sessionId: 'session-1' },
      {
        id: attachment.id,
        name: attachment.originalName,
        path: attachment.path,
        source: 'upload',
        mimeType: attachment.mimeType
      }
    )

    expect(resolved).toMatchObject({
      absolutePath: await realpath(attachment.path),
      name: 'study.csv',
      mimeType: 'text/csv',
      size: 'id,value\n1,2\n'.length,
      allowSkillImportReference: true
    })
    expect(resolved.uri).toMatch(/^file:/u)
  })

  it('resolves an explicitly referenced Upload Version from another Session in the same Project', async () => {
    root = await mkdtemp(join(tmpdir(), 'file-reference-resolver-'))
    const client = createProjectDbClient(root)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)
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
    const resolver = createManagedFileReferenceResolver({ uploads })

    await expect(
      resolver.resolve(
        { projectId: 'project-1', sessionId: 'target-session' },
        {
          id: attachment.id,
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
    const resolver = createManagedFileReferenceResolver({ uploads })

    await expect(
      resolver.resolve(
        { projectId: 'project-b', sessionId: 'target-session' },
        {
          id: attachment.id,
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
    const resolveVersionContent = vi.fn()
    const resolver = createManagedFileReferenceResolver({
      artifacts: {} as ArtifactRepository,
      artifactVersions: { resolveVersionContent }
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
    expect(resolveVersionContent).not.toHaveBeenCalled()
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
      grantedRoots: { resolveRootPath: async (rootId) => (rootId === 'root-1' ? root : undefined) }
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

  it('rejects a linked-folder reference with an unknown root id', async () => {
    root = await mkdtemp(join(tmpdir(), 'file-reference-resolver-'))
    const resolver = createManagedFileReferenceResolver({
      grantedRoots: { resolveRootPath: async () => undefined }
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
      grantedRoots: { resolveRootPath: async () => granted }
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
      grantedRoots: { resolveRootPath: async () => granted }
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
