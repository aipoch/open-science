import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { PrismaClient } from '@prisma/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { LiteratureCatalog } from '../literature/catalog'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { markContentBlobAvailable, registerContentBlob } from './content-blob-registry'
import { ContentRepository, resolveContentStorageKey } from './content-repository'

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, rm: vi.fn(original.rm) }
})

const sha256 = (content: Buffer): string => createHash('sha256').update(content).digest('hex')

describe('content repository', () => {
  let storageRoot: string | undefined
  let client: PrismaClient | undefined

  afterEach(async () => {
    vi.mocked(rm).mockReset()
    vi.mocked(rm).mockImplementation(
      (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rm
    )
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

  it.each(['broken', 'selected literature byte!'])(
    'repairs corrupt published bytes: %s',
    async (corruption) => {
      const repository = await createRepository()
      const sourcePath = join(storageRoot!, 'repair-paper.pdf')
      const bytes = Buffer.from('selected literature bytes')
      await writeFile(sourcePath, bytes)
      const original = await repository.publish({ sourcePath, contentType: 'application/pdf' })
      await writeFile(original.path, corruption)
      await expect(repository.verify(original.id)).resolves.toMatchObject({ state: 'unavailable' })

      const repaired = await repository.publish({ sourcePath, contentType: 'application/pdf' })

      expect(repaired.id).toBe(original.id)
      await expect(readFile(repaired.path)).resolves.toEqual(bytes)
      await expect(repository.verify(original.id)).resolves.toMatchObject({ state: 'available' })
      await expect(client!.contentBlob.count()).resolves.toBe(1)
    }
  )

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

  it('serializes publication against an in-flight sweep across repository instances', async () => {
    const sweeper = await createRepository()
    const publisher = new ContentRepository({
      storageRoot: storageRoot!,
      getClient: () => Promise.resolve(client!)
    })
    const sourcePath = join(storageRoot!, 'paper.pdf')
    const bytes = Buffer.from('%PDF-1.7 concurrent literature content')
    await writeFile(sourcePath, bytes)
    const original = await publisher.publish({ sourcePath, contentType: 'application/pdf' })
    const item = await client!.literatureItem.create({
      data: { itemType: 'journalArticle', title: 'Concurrent paper' }
    })
    const catalog = new LiteratureCatalog(() => Promise.resolve(client!))
    let releaseUnlink!: () => void
    let markClaimed!: () => void
    const unlinkAllowed = new Promise<void>((resolve) => {
      releaseUnlink = resolve
    })
    const claimed = new Promise<void>((resolve) => {
      markClaimed = resolve
    })
    const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(rm).mockImplementation(async (path, options) => {
      if (path === original.path) {
        markClaimed()
        await unlinkAllowed
      }
      return actualFs.rm(path, options)
    })
    const sweeping = sweeper.sweep({
      createdBefore: new Date(Date.now() + 1_000),
      contentIds: [original.id]
    })
    await claimed
    const publishing = publisher.publish({ sourcePath, contentType: 'application/pdf' })
    try {
      // Publication must not revive the quarantined authority while unlink is pending.
      const state = await Promise.race([
        publishing.then(() => 'published'),
        new Promise<string>((resolve) => setTimeout(() => resolve('blocked'), 100))
      ])
      expect(state).toBe('blocked')
      await expect(
        client!.contentBlob.findUniqueOrThrow({ where: { id: original.id } })
      ).resolves.toMatchObject({ state: 'quarantined' })
    } finally {
      releaseUnlink()
      await sweeping
      await publishing
    }
    const published = await publishing
    const attachment = await catalog.attachContent({
      itemId: item.id,
      contentBlobId: published.id,
      filename: 'paper.pdf',
      contentType: 'application/pdf',
      checksum: published.checksum,
      sizeBytes: bytes.length
    })
    await expect(
      client!.literatureAttachmentVersion.findUniqueOrThrow({ where: { id: attachment.versionId } })
    ).resolves.toMatchObject({ contentBlobId: published.id })
    await expect(sweeper.verify(published.id)).resolves.toMatchObject({ state: 'available' })
    await expect(readFile(published.path)).resolves.toEqual(bytes)
  })

  it('sweeps only old unreferenced blobs and leaves referenced bytes intact', async () => {
    const repository = await createRepository()
    const createdAt = new Date('2026-08-30T00:00:00.000Z')
    await publishFixture('orphan', 'content/project/orphan', Buffer.from('orphan'), createdAt)
    await publishFixture('inbox-only', 'content/inbox/paper', Buffer.from('pending'), createdAt)
    await client!.literatureInboxCandidate.create({
      data: {
        id: 'inbox',
        dedupeKey: 'inbox',
        itemType: 'journalArticle',
        title: 'Pending paper',
        candidateJson: '{}',
        metadataChecksum: 'a'.repeat(64),
        origin: 'agent',
        pdfs: {
          create: {
            contentBlobId: 'inbox-only',
            filename: 'paper.pdf',
            sizeBytes: 7n,
            checksum: sha256(Buffer.from('pending')),
            pageCount: 1,
            sourceUrl: 'https://example.test/paper'
          }
        }
      }
    })
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
      retainedIds: ['inbox-only', 'literature-only', 'referenced'],
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
