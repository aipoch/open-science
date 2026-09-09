import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { PrismaClient } from '@prisma/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { literatureItemInputSchema } from '../../shared/literature'
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

  it.each([false, true])(
    'retains overlapping publications across repositories and releases them on failure=%s',
    async (fail) => {
      const publisher = await createRepository()
      const other = new ContentRepository({
        storageRoot: storageRoot!,
        getClient: async () => client!
      })
      const sourcePath = join(storageRoot!, 'source.pdf')
      await writeFile(sourcePath, 'shared publication')
      let contentId = ''
      const sweep = (): ReturnType<ContentRepository['sweep']> =>
        other.sweep({ createdBefore: new Date(Date.now() + 1) })
      const acquisition = publisher.withPublishedContent({ sourcePath }, async (first) => {
        contentId = first.id
        await other.withPublishedContent({ sourcePath }, async (second) => {
          expect(second.id).toBe(first.id)
          expect((await sweep()).retainedIds).toContain(first.id)
          await expect(other.verify(first.id)).resolves.toMatchObject({ state: 'available' })
        })
        expect((await sweep()).retainedIds).toContain(first.id)
        if (fail) throw new Error('Reference insertion failed')
      })
      if (fail) await expect(acquisition).rejects.toThrow('Reference insertion failed')
      else await acquisition
      expect((await sweep()).removedIds).toContain(contentId)
    }
  )

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

  it('serializes cancellation cleanup with another publisher of the same bytes', async () => {
    const repository = await createRepository()
    const other = new ContentRepository({
      storageRoot: storageRoot!,
      getClient: async () => client!
    })
    const sourcePath = join(storageRoot!, 'shared-paper.pdf')
    const bytes = Buffer.from('concurrent publication')
    await writeFile(sourcePath, bytes)
    let release!: () => void
    let entered!: () => void
    const ready = new Promise<void>((resolve) => {
      entered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const cancelled = repository
      .publish({
        sourcePath,
        commit: async () => {
          entered()
          await gate
          throw new Error('cancelled before commit')
        }
      })
      .then(
        () => undefined,
        (error: unknown) => error
      )
    await ready
    const concurrent = other.publish({ sourcePath })
    release()
    expect(await cancelled).toMatchObject({ message: 'cancelled before commit' })
    const kept = await concurrent
    expect(await readFile(kept.path)).toEqual(bytes)
    expect(await client!.contentBlob.count()).toBe(1)
  })

  it('retains reused unreferenced bytes and newly committed references on callback failure', async () => {
    const repository = await createRepository()
    const sourcePath = join(storageRoot!, 'shared-paper.pdf')
    await writeFile(sourcePath, 'already published')
    const existing = await repository.publish({ sourcePath })
    await expect(
      repository.publish({
        sourcePath,
        commit: async () => {
          throw new Error('cancelled')
        }
      })
    ).rejects.toThrow('cancelled')
    expect(await repository.open(existing.id)).toEqual(existing)

    await writeFile(sourcePath, 'newly committed')
    const catalog = new LiteratureCatalog(async () => client!)
    const item = await catalog.transact({
      kind: 'create-item',
      item: literatureItemInputSchema.parse({
        itemType: 'journalArticle',
        title: 'Committed paper'
      })
    })
    let committedId = ''
    await expect(
      repository.publish({
        sourcePath,
        contentType: 'application/pdf',
        commit: async (content) => {
          committedId = content.id
          await catalog.attachContent({
            itemId: item.id,
            contentBlobId: content.id,
            filename: 'paper.pdf',
            contentType: 'application/pdf',
            checksum: content.checksum,
            sizeBytes: Number(content.sizeBytes),
            pageCount: 1
          })
          throw new Error('caller failed after commit')
        }
      })
    ).rejects.toThrow('caller failed after commit')
    expect((await repository.open(committedId)).id).toBe(committedId)
    expect((await catalog.get(item.id))!.attachments).toHaveLength(1)
  })

  it('keeps a sweep outside the publication-to-commit window', async () => {
    const repository = await createRepository()
    const sourcePath = join(storageRoot!, 'sweep-paper.pdf')
    await writeFile(sourcePath, 'publication under sweep')
    const catalog = new LiteratureCatalog(async () => client!)
    const item = await catalog.transact({
      kind: 'create-item',
      item: literatureItemInputSchema.parse({ itemType: 'journalArticle', title: 'Paper' })
    })
    let sweep!: ReturnType<ContentRepository['sweep']>
    const published = await repository.publish({
      sourcePath,
      contentType: 'application/pdf',
      commit: async (content) => {
        sweep = repository.sweep({
          createdBefore: new Date(Date.now() + 1000),
          contentIds: [content.id]
        })
        await catalog.attachContent({
          itemId: item.id,
          contentBlobId: content.id,
          filename: 'paper.pdf',
          contentType: 'application/pdf',
          checksum: content.checksum,
          sizeBytes: Number(content.sizeBytes),
          pageCount: 1
        })
      }
    })
    expect(await sweep).toMatchObject({
      removedIds: [],
      retainedIds: [published.id],
      failedIds: []
    })
    expect((await repository.open(published.id)).id).toBe(published.id)
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

  it('orders a failed verification before repair across repository instances', async () => {
    const verifier = await createRepository()
    const sourcePath = join(storageRoot!, 'verification-repair.pdf')
    await writeFile(sourcePath, 'original bytes')
    const published = await verifier.publish({ sourcePath, contentType: 'application/pdf' })
    await writeFile(published.path, 'broken')
    const publisher = new ContentRepository({
      storageRoot: storageRoot!,
      getClient: async () => client!
    })
    let observe!: () => void
    let release!: () => void
    const observing = new Promise<void>((resolve) => {
      observe = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const update = client!.contentBlob.updateMany.bind(client!.contentBlob)
    const spy = vi.spyOn(client!.contentBlob, 'updateMany').mockImplementation((async (
      args: Parameters<typeof update>[0]
    ) => {
      if (args?.data.lastVerificationFailure === 'size-mismatch') {
        observe()
        await gate
      }
      return update(args)
    }) as unknown as typeof update)
    const verification = verifier.verify(published.id)
    await observing
    const publishing = publisher.publish({ sourcePath, contentType: 'application/pdf' })
    try {
      release()
      await expect(verification).resolves.toMatchObject({
        state: 'unavailable',
        reason: 'size-mismatch'
      })
      await publishing
      await expect(
        client!.contentBlob.findUnique({ where: { id: published.id } })
      ).resolves.toMatchObject({
        state: 'available',
        lastVerificationFailure: null,
        lastVerificationAttemptAt: expect.any(Date)
      })
      await expect(verifier.verify(published.id)).resolves.toMatchObject({ state: 'available' })
    } finally {
      release()
      spy.mockRestore()
    }
  })

  it('limits targeted sweep reference reads to candidate content', async () => {
    const repository = await createRepository()
    for (const id of ['target', 'unrelated']) {
      await publishFixture(id, `content/project/${id}`, Buffer.from(id))
      await client!.literatureItem.create({
        data: {
          itemType: 'journalArticle',
          title: id,
          attachments: {
            create: {
              kind: 'fullText',
              versions: {
                create: {
                  contentBlobId: id,
                  versionNumber: 1,
                  filename: 'paper.pdf',
                  contentType: 'application/pdf',
                  sizeBytes: BigInt(id.length),
                  checksum: sha256(Buffer.from(id))
                }
              }
            }
          }
        }
      })
    }
    const queries = [
      vi.spyOn(client!.uploadVersion, 'findMany'),
      vi.spyOn(client!.artifactVersion, 'findMany'),
      vi.spyOn(client!.literatureAttachmentVersion, 'findMany'),
      vi.spyOn(client!.literatureInboxPdf, 'findMany')
    ]
    await expect(
      repository.sweep({
        contentIds: ['target'],
        createdBefore: new Date('2026-08-31T00:00:00.000Z')
      })
    ).resolves.toEqual({ removedIds: [], retainedIds: ['target'], failedIds: [] })
    // Observe real SQLite rows, not a mock that assumes the filter works.
    expect(await queries[2].mock.results[0].value).toEqual([{ contentBlobId: 'target' }])
    for (const query of queries) {
      expect(query).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { contentBlobId: { in: ['target'] } }
        })
      )
    }
  })

  it('retains a reference published after targeted sweep prefiltering', async () => {
    const repository = await createRepository()
    await publishFixture('target', 'content/project/target', Buffer.from('target'))
    const findMany = client!.literatureAttachmentVersion.findMany.bind(
      client!.literatureAttachmentVersion
    )
    vi.spyOn(client!.literatureAttachmentVersion, 'findMany').mockImplementationOnce(
      (query) =>
        (async () => {
          const before = await findMany(query)
          await client!.literatureItem.create({
            data: {
              itemType: 'journalArticle',
              title: 'Late reference',
              attachments: {
                create: {
                  kind: 'fullText',
                  versions: {
                    create: {
                      contentBlobId: 'target',
                      versionNumber: 1,
                      filename: 'paper.pdf',
                      contentType: 'application/pdf',
                      sizeBytes: 6n,
                      checksum: sha256(Buffer.from('target'))
                    }
                  }
                }
              }
            }
          })
          return before
        })() as ReturnType<typeof findMany>
    )
    await expect(
      repository.sweep({
        contentIds: ['target'],
        createdBefore: new Date('2026-08-31T00:00:00.000Z')
      })
    ).resolves.toEqual({ removedIds: [], retainedIds: ['target'], failedIds: [] })
    await expect(
      readFile(resolveContentStorageKey(storageRoot!, 'content/project/target'))
    ).resolves.toEqual(Buffer.from('target'))
  })

  it('skips reference reads when a targeted sweep has no candidates', async () => {
    const repository = await createRepository()
    const queries = [
      vi.spyOn(client!.uploadVersion, 'findMany'),
      vi.spyOn(client!.artifactVersion, 'findMany'),
      vi.spyOn(client!.literatureAttachmentVersion, 'findMany'),
      vi.spyOn(client!.literatureInboxPdf, 'findMany')
    ]
    await expect(
      repository.sweep({
        contentIds: ['missing'],
        createdBefore: new Date()
      })
    ).resolves.toEqual({ removedIds: [], retainedIds: [], failedIds: [] })
    for (const query of queries) expect(query).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'sweeps only old unreferenced blobs and leaves referenced bytes intact (targeted=%s)',
    async (targeted) => {
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
      await publishFixture(
        'referenced',
        'content/project/referenced',
        Buffer.from('kept'),
        createdAt
      )
      await publishFixture(
        'literature-only',
        'content/literature/paper',
        Buffer.from('paper'),
        createdAt
      )
      await client!.fileOriginSession.create({
        data: { projectId: 'project-1', sessionId: 'session-1' }
      })
      await publishFixture(
        'artifact-only',
        'content/project/artifact',
        Buffer.from('artifact'),
        createdAt
      )
      await client!.artifactLineage.create({
        data: {
          id: 'artifact',
          projectId: 'project-1',
          sessionId: 'session-1',
          normalizedFilename: 'result.pdf',
          filename: 'result.pdf',
          versions: {
            create: {
              id: 'artifact-version',
              versionNumber: 1,
              filename: 'result.pdf',
              contentBlobId: 'artifact-only',
              contentStorageKey: 'content/project/artifact',
              sizeBytes: 8n,
              checksum: sha256(Buffer.from('artifact')),
              state: 'finalized',
              originKind: 'legacy'
            }
          }
        }
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
        repository.sweep({
          createdBefore: new Date('2026-08-31T00:00:00.000Z'),
          ...(targeted
            ? {
                contentIds: [
                  'orphan',
                  'inbox-only',
                  'referenced',
                  'literature-only',
                  'artifact-only'
                ]
              }
            : {})
        })
      ).resolves.toEqual({
        removedIds: ['orphan'],
        retainedIds: ['artifact-only', 'inbox-only', 'literature-only', 'referenced'],
        failedIds: []
      })
      await expect(client!.contentBlob.findUnique({ where: { id: 'orphan' } })).resolves.toBeNull()
      await expect(
        readFile(resolveContentStorageKey(storageRoot!, 'content/project/orphan'))
      ).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(
        readFile(resolveContentStorageKey(storageRoot!, 'content/project/referenced'), 'utf8')
      ).resolves.toBe('kept')
    }
  )

  it('rejects traversal and platform-specific absolute storage keys', () => {
    expect(() => resolveContentStorageKey('/data', '../outside')).toThrow(/invalid/i)
    expect(() => resolveContentStorageKey('/data', '/absolute/content')).toThrow(/invalid/i)
    expect(() => resolveContentStorageKey('/data', 'C:\\content\\blob')).toThrow(/invalid/i)
  })
})
