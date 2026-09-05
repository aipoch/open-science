import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { PrismaClient } from '@prisma/client'
import { afterEach, describe, expect, it } from 'vitest'

import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { markContentBlobAvailable, registerContentBlob } from './content-blob-registry'
import { ContentRepository, resolveContentStorageKey } from './content-repository'

const sha256 = (content: Buffer): string => createHash('sha256').update(content).digest('hex')

describe('content repository', () => {
  let storageRoot: string | undefined
  let client: PrismaClient | undefined

  afterEach(async () => {
    await client?.$disconnect()
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
  })

  const createRepository = async (): Promise<ContentRepository> => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-content-repository-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    return new ContentRepository({ storageRoot, getClient: () => Promise.resolve(client!) })
  }

  const publishFixture = async (
    id: string,
    storageKey: string,
    content: Buffer,
    createdAt = new Date('2026-08-30T00:00:00.000Z')
  ): Promise<void> => {
    const path = resolveContentStorageKey(storageRoot!, storageKey)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content)
    const input = {
      id,
      storageKey,
      checksum: sha256(content),
      sizeBytes: BigInt(content.byteLength),
      contentType: 'application/pdf',
      createdAt
    }
    await client!.$transaction(async (transaction) => {
      await registerContentBlob(transaction, input)
      await markContentBlobAvailable(transaction, input, createdAt)
    })
  }

  it('opens and verifies available immutable bytes', async () => {
    const repository = await createRepository()
    const content = Buffer.from('verified literature bytes')
    await publishFixture('blob-1', 'content/project/blob-1', content)

    await expect(repository.open('blob-1')).resolves.toMatchObject({
      id: 'blob-1',
      storageKey: 'content/project/blob-1',
      checksum: sha256(content),
      sizeBytes: BigInt(content.byteLength)
    })
    await expect(repository.verify('blob-1')).resolves.toMatchObject({ state: 'available' })
    await expect(repository.verify('blob-1', { maxBytes: 1 })).resolves.toEqual({
      state: 'unavailable',
      reason: 'size-limit'
    })
    await expect(
      client!.contentBlob.findUniqueOrThrow({ where: { id: 'blob-1' } })
    ).resolves.toMatchObject({ state: 'available' })
  })

  it('publishes selected bytes once and reuses their content identity', async () => {
    const repository = await createRepository()
    const source = join(storageRoot!, 'selected-paper.pdf')
    const content = Buffer.from('selected literature bytes')
    await writeFile(source, content)

    const first = await repository.publish({ sourcePath: source, contentType: 'application/pdf' })
    const second = await repository.publish({ sourcePath: source, contentType: 'application/pdf' })

    expect(second).toEqual(first)
    expect(first).toMatchObject({
      id: `sha256:${sha256(content)}:${content.byteLength}`,
      checksum: sha256(content),
      sizeBytes: BigInt(content.byteLength),
      contentType: 'application/pdf'
    })
    await expect(readFile(first.path)).resolves.toEqual(content)
    await expect(client!.contentBlob.count()).resolves.toBe(1)
  })

  it('quarantines corrupt bytes and refuses future opens', async () => {
    const repository = await createRepository()
    await publishFixture('blob-1', 'content/project/blob-1', Buffer.from('expected'))
    await writeFile(resolveContentStorageKey(storageRoot!, 'content/project/blob-1'), 'corrupt!')

    await expect(repository.verify('blob-1')).resolves.toEqual({
      state: 'unavailable',
      reason: 'checksum-mismatch'
    })
    await expect(
      client!.contentBlob.findUniqueOrThrow({ where: { id: 'blob-1' } })
    ).resolves.toMatchObject({ state: 'quarantined' })
    await expect(repository.open('blob-1')).rejects.toThrow(/not available/i)
  })

  it('sweeps only old unreferenced blobs and leaves referenced bytes intact', async () => {
    const repository = await createRepository()
    const createdAt = new Date('2026-08-30T00:00:00.000Z')
    await publishFixture('orphan', 'content/project/orphan', Buffer.from('orphan'), createdAt)
    await publishFixture('referenced', 'content/project/referenced', Buffer.from('kept'), createdAt)
    await publishFixture(
      'literature-only',
      'content/literature/paper',
      Buffer.from('paper'),
      createdAt
    )
    await client!.fileOriginSession.create({
      data: { projectId: 'project-1', sessionId: 'session-1' }
    })
    await client!.uploadFile.create({
      data: {
        id: 'upload-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        filename: 'paper.pdf',
        originalFilename: 'paper.pdf',
        versions: {
          create: {
            id: 'upload-version-1',
            versionNumber: 1,
            state: 'ready',
            contentStorageKey: 'content/project/referenced',
            filename: 'paper.pdf',
            originalFilename: 'paper.pdf',
            contentType: 'application/pdf',
            sizeBytes: 4n,
            checksum: sha256(Buffer.from('kept')),
            contentBlobId: 'referenced',
            createdAt
          }
        }
      }
    })
    await client!.literatureItem.create({
      data: {
        itemType: 'journalArticle',
        title: 'Referenced paper',
        attachments: {
          create: {
            kind: 'fullText',
            versions: {
              create: {
                contentBlobId: 'literature-only',
                versionNumber: 1,
                filename: 'paper.pdf',
                contentType: 'application/pdf',
                sizeBytes: 5n,
                checksum: sha256(Buffer.from('paper')),
                pageCount: 2
              }
            }
          }
        }
      }
    })

    await expect(
      repository.sweep({ createdBefore: new Date('2026-08-31T00:00:00.000Z') })
    ).resolves.toEqual({
      removedIds: ['orphan'],
      retainedIds: ['literature-only', 'referenced'],
      failedIds: []
    })
    await expect(client!.contentBlob.findUnique({ where: { id: 'orphan' } })).resolves.toBeNull()
    await expect(
      readFile(resolveContentStorageKey(storageRoot!, 'content/project/orphan'))
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      readFile(resolveContentStorageKey(storageRoot!, 'content/project/referenced'), 'utf8')
    ).resolves.toBe('kept')
  })

  it('rejects traversal and platform-specific absolute storage keys', () => {
    expect(() => resolveContentStorageKey('/data', '../outside')).toThrow(/invalid/i)
    expect(() => resolveContentStorageKey('/data', '/absolute/content')).toThrow(/invalid/i)
    expect(() => resolveContentStorageKey('/data', 'C:\\content\\blob')).toThrow(/invalid/i)
  })
})
