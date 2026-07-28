import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createUploadVersionReference } from '../../shared/uploads'
import { createProjectDbClient, ensureProjectSchema } from '../projects/prisma-client'
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
    await ensureProjectSchema(client)
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
    await ensureProjectSchema(client)
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
})
