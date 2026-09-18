import * as storageRoots from '../storage-root'
import { BookmarkRepository } from '../bookmarks/repository'
import { SessionProjectionRepository } from '../session-persistence/projection'
import { LiteratureAttachmentAuthority } from '../literature/attachment-authority'
import { SessionPdfSourceResolver } from '../literature/session-pdf-source-resolver'
import { ContentRepository } from '../storage/content-repository'
import { readPackageArchive, writePackageArchive, packageEntry } from './archive'
import {
  createLinearConversationGraph,
  forkEditedConversationMessage,
  resolveActiveConversationMessages
} from '../../shared/conversation-graph'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createProvenanceTestFixture } from '../artifacts/provenance-test-fixtures'
import { sha256 } from '../artifacts/provenance-canonical'
import { createTestPdf } from '../../../test/fixtures/literature-pdf'
import { SessionRepository } from '../session-persistence/repository'
import { SessionPackageService } from './service'
import { PackageLiteratureReader } from './literature-reader'
import { ManagedFileVersionService } from '../managed-file-versions/service'
import { literatureItemInputSchema } from '../../shared/literature'
import { sessionLiteratureReferences } from './literature'
import type { PersistedChatSession } from '../../shared/session-persistence'

vi.mock('electron', () => ({
  app: { getPath: () => '/home/user', isPackaged: true },
  safeStorage: { isEncryptionAvailable: () => false }
}))
const fixtures: Awaited<ReturnType<typeof createProvenanceTestFixture>>[] = []
const services: SessionPackageService[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const service of services.splice(0)) await service.close()
  for (const fixture of fixtures.splice(0)) await fixture.dispose()
})
const setup = async (): Promise<
  Awaited<ReturnType<typeof createProvenanceTestFixture>> & { service: SessionPackageService }
> => {
  const fixture = await createProvenanceTestFixture()
  fixtures.push(fixture)
  // Session path codecs must use fixture data, not the desktop configuration under test.
  vi.spyOn(storageRoots, 'resolveDataRoot').mockReturnValue(fixture.storageRoot)
  const service = new SessionPackageService({
    storageRoot: fixture.storageRoot,
    getClient: async () => fixture.client
  })
  services.push(service)
  return { ...fixture, service }
}
const session = (): PersistedChatSession => ({
  id: 'session-1',
  projectId: 'project-1',
  title: 'Reading paper',
  cwd: '',
  status: 'idle',
  createdAt: 1,
  updatedAt: 1,
  messages: [],
  runtimeContext: {
    version: 1,
    revision: 1,
    pdfContext: {
      version: 1,
      bindings: [
        {
          version: 1,
          bindingId: 'binding-1',
          sourceKind: 'literature-attachment-version',
          sourceFileId: 'attachment-1',
          sourceVersionId: 'version-1',
          name: 'paper.pdf',
          mimeType: 'application/pdf',
          sizeBytes: createTestPdf().length,
          checksum: sha256(createTestPdf()),
          linkedAt: 1
        }
      ]
    }
  }
})
const seed = async (source: Awaited<ReturnType<typeof setup>>): Promise<void> => {
  const { client, storageRoot } = source
  await client.project.create({ data: { id: 'project-1', name: 'Reading' } })
  await client.literatureItem.create({
    data: {
      id: 'item-1',
      itemType: 'journalArticle',
      title: 'Evidence paper',
      abstract: 'Abstract preserved without the PDF.'
    }
  })
  const storageKey = 'content/blobs/paper'
  await mkdir(join(storageRoot, 'content/blobs'), { recursive: true })
  await writeFile(join(storageRoot, storageKey), createTestPdf())
  await client.contentBlob.create({
    data: {
      id: 'blob-1',
      storageKey,
      checksum: sha256(createTestPdf()),
      sizeBytes: BigInt(createTestPdf().length),
      contentType: 'application/pdf',
      state: 'available'
    }
  })
  await client.literatureAttachment.create({
    data: {
      id: 'attachment-1',
      itemId: 'item-1',
      versions: {
        create: {
          id: 'version-1',
          contentBlobId: 'blob-1',
          versionNumber: 1,
          filename: 'paper.pdf',
          contentType: 'application/pdf',
          sizeBytes: BigInt(createTestPdf().length),
          checksum: sha256(createTestPdf())
        }
      }
    }
  })
  await new SessionRepository(storageRoot).saveSession(session())
}

it.each([false, true])(
  'round-trips Reading PDF metadata with excluded=%s and keeps it out of the Library',
  async (excluded) => {
    const source = await setup(),
      target = await setup()
    await seed(source)
    const archive = join(source.storageRoot, 'paper.science')
    await source.service.exportTo({ projectId: 'project-1', sessionId: 'session-1' }, archive, {
      selectFiles: async (files) => {
        expect(files).toHaveLength(1)
        expect(files[0]).toMatchObject({
          source: 'literature',
          filename: 'paper.pdf',
          requiredForEvidence: false
        })
        return excluded ? files.map((file) => file.storageKey) : []
      }
    })
    const imported = await target.service.importFrom(archive)
    expect(await target.client.literatureItem.count()).toBe(0)
    const saved = await new SessionRepository(target.storageRoot).loadSession(
      imported.projectId,
      imported.sessionId
    )
    const versionId = saved!.runtimeContext!.pdfContext!.bindings[0].sourceVersionId
    expect(versionId).not.toBe('version-1')
    const root = join(
      target.storageRoot,
      'artifacts',
      imported.projectId,
      imported.sessionId,
      '.session-package'
    )
    const records = JSON.parse(await readFile(join(root, 'source/records.json'), 'utf8'))
    expect(records.literature.items[0].item).toMatchObject({
      title: 'Evidence paper',
      abstract: 'Abstract preserved without the PDF.'
    })
    const reader = new PackageLiteratureReader({
      storageRoot: target.storageRoot,
      getClient: async () => target.client,
      files: new ManagedFileVersionService({
        storageRoot: target.storageRoot,
        getClient: async () => target.client
      })
    })
    const authority = new LiteratureAttachmentAuthority({
      getClient: async () => target.client,
      content: new ContentRepository({
        storageRoot: target.storageRoot,
        getClient: async () => target.client
      }),
      packages: reader
    })
    const resolver = new SessionPdfSourceResolver({
      literature: authority,
      inputs: { resolveVersion: vi.fn(), openContent: vi.fn() }
    })
    const request = {
      projectId: imported.projectId,
      sourceKind: 'literature-attachment-version' as const,
      sourceVersionId: versionId,
      expectedSourceFileId: saved!.runtimeContext!.pdfContext!.bindings[0].sourceFileId
    }
    if (excluded) {
      await expect(authority.openContent(versionId)).rejects.toThrow('not included')
      await expect(resolver.resolveVersion(request)).rejects.toThrow('not included')
    } else {
      const resolved = await resolver.resolveVersion(request)
      expect(resolved).toMatchObject({
        sourceVersionId: versionId,
        sourceFileId: request.expectedSourceFileId,
        checksum: sha256(createTestPdf())
      })
      const lease = await resolved!.openContent!()
      try {
        expect(await readFile(lease.path)).toEqual(createTestPdf())
      } finally {
        await lease.close()
      }
    }
    const forwarded = join(target.storageRoot, 'forwarded.science')
    await target.service.exportTo(imported, forwarded)
    const second = await target.service.importFrom(forwarded)
    expect(second.sessionId).not.toBe(imported.sessionId)
    expect(await target.client.literatureItem.count()).toBe(0)
    await target.service.prepareSessionDeletion(saved!)
    await new SessionRepository(
      target.storageRoot,
      {},
      new SessionProjectionRepository(async () => target.client)
    ).deleteSession(imported.projectId, imported.sessionId)
    await target.service.recover({ collectDeletedPackages: true })
    expect(await target.client.uploadVersion.findUnique({ where: { id: versionId } })).toBeNull()
    expect(await target.client.uploadVersion.count()).toBe(1)
    expect(await source.client.literatureAttachmentVersion.count()).toBe(1)
    const surviving = await new SessionRepository(target.storageRoot).loadSession(
      second.projectId,
      second.sessionId
    )
    const survivorId = surviving!.runtimeContext!.pdfContext!.bindings[0].sourceVersionId
    if (!excluded) {
      const lease = await authority.openContent(survivorId)
      await lease.close()
    }
    const forked = await target.service.fork(second)
    const forkedSession = (await new SessionRepository(target.storageRoot).loadSession(
      forked.projectId,
      forked.sessionId
    ))!
    const forkedVersionId = forkedSession.runtimeContext!.pdfContext!.bindings[0].sourceVersionId
    if (excluded)
      await expect(authority.openContent(forkedVersionId)).rejects.toThrow('not included')
    else {
      const lease = await authority.openContent(forkedVersionId)
      try {
        expect(await readFile(lease.path)).toEqual(createTestPdf())
      } finally {
        await lease.close()
      }
    }
    // A fork is editable history; its next export captures the current native records while
    // retaining packaged Literature metadata and any explicit missing-content evidence.
    const reforked = await target.service.fork(forked)
    expect(reforked.sessionId).not.toBe(forked.sessionId)
  },
  30_000
)

it('keeps metadata-only Literature references', () => {
  const item = literatureItemInputSchema.parse({
    itemType: 'journalArticle',
    title: 'Metadata only'
  })
  const value = session()
  value.runtimeContext = undefined
  value.messages = [
    {
      id: 'message',
      role: 'user',
      content: '',
      createdAt: 1,
      updatedAt: 1,
      status: 'complete',
      eventIds: [],
      parts: [{ type: 'literature', itemId: 'item-1', metadataRevision: 1, item }]
    }
  ]
  expect(sessionLiteratureReferences(value)).toEqual({
    versionIds: new Set(),
    items: [{ itemId: 'item-1', metadataRevision: 1, item }]
  })
})

it('round-trips two versions of one Literature attachment across stored branches', async () => {
  const source = await setup(),
    target = await setup()
  await seed(source)
  const secondPdf = createTestPdf('second version')
  await writeFile(join(source.storageRoot, 'content/blobs/second'), secondPdf)
  await source.client.contentBlob.create({
    data: {
      id: 'blob-2',
      storageKey: 'content/blobs/second',
      checksum: sha256(secondPdf),
      sizeBytes: BigInt(secondPdf.length),
      contentType: 'application/pdf',
      state: 'available'
    }
  })
  await source.client.literatureAttachmentVersion.create({
    data: {
      id: 'version-2',
      attachmentId: 'attachment-1',
      contentBlobId: 'blob-2',
      versionNumber: 2,
      filename: 'paper-revised.pdf',
      contentType: 'application/pdf',
      sizeBytes: BigInt(secondPdf.length),
      checksum: sha256(secondPdf)
    }
  })
  const value = session()
  const graph = forkEditedConversationMessage(
    createLinearConversationGraph({
      sessionId: value.id,
      createdAt: 1,
      updatedAt: 1,
      messages: [
        {
          id: 'old',
          role: 'user',
          content: 'Read the PDF',
          status: 'complete',
          eventIds: [],
          createdAt: 1,
          updatedAt: 1,
          pdfContext: value.runtimeContext!.pdfContext
        }
      ]
    }),
    'old',
    'revised-message',
    2
  )
  value.runtimeContext = {
    ...value.runtimeContext!,
    pdfContext: {
      version: 1,
      bindings: [
        {
          ...value.runtimeContext!.pdfContext!.bindings[0],
          sourceVersionId: 'version-2',
          name: 'paper-revised.pdf',
          sizeBytes: secondPdf.length,
          checksum: sha256(secondPdf)
        }
      ]
    }
  }
  for (const message of graph.messages)
    if (message.id !== 'old') message.pdfContext = value.runtimeContext!.pdfContext
  value.conversationGraph = graph
  value.messages = resolveActiveConversationMessages(graph)
  expect(value.messages.some((message) => message.id === 'old')).toBe(false)
  expect(sessionLiteratureReferences(value).versionIds.has('version-1')).toBe(true)
  expect(sessionLiteratureReferences(value).versionIds.has('version-2')).toBe(true)
  await new SessionRepository(source.storageRoot).saveSession(value)
  const archive = join(source.storageRoot, 'branches.science')
  await source.service.exportTo({ projectId: value.projectId, sessionId: value.id }, archive, {
    selectFiles: async (files) => {
      expect(files).toHaveLength(2)
      expect(files.every((file) => file.source === 'literature')).toBe(true)
      expect(new Set(files.map((file) => file.groupId)).size).toBe(1)
      return []
    }
  })
  await target.service.importFrom(archive)
  const versions = await target.client.uploadVersion.findMany({ orderBy: { versionNumber: 'asc' } })
  expect(versions).toHaveLength(2)
  expect(versions[0].uploadFileId).toBe(versions[1].uploadFileId)
  const reader = new PackageLiteratureReader({
    storageRoot: target.storageRoot,
    getClient: async () => target.client,
    files: new ManagedFileVersionService({
      storageRoot: target.storageRoot,
      getClient: async () => target.client
    })
  })
  for (const [index, pdf] of [createTestPdf(), secondPdf].entries()) {
    const lease = await reader.openContent(versions[index].id)
    try {
      expect(await readFile(lease.path)).toEqual(pdf)
    } finally {
      await lease.close()
    }
  }
})

it.each(['bytes', 'binding', 'attachment-owner'])(
  'rejects inconsistent Literature %s before publishing a package',
  async (kind) => {
    const source = await setup()
    await seed(source)
    if (kind === 'bytes')
      await writeFile(join(source.storageRoot, 'content/blobs/paper'), createTestPdf('wrong'))
    else {
      const value = session()
      if (kind === 'binding')
        value.runtimeContext = {
          ...value.runtimeContext!,
          pdfContext: {
            version: 1,
            bindings: [
              { ...value.runtimeContext!.pdfContext!.bindings[0], checksum: '0'.repeat(64) }
            ]
          }
        }
      else
        value.messages = [
          {
            id: 'mention',
            role: 'user',
            content: 'Reference',
            status: 'complete',
            eventIds: [],
            createdAt: 1,
            updatedAt: 1,
            parts: [
              {
                type: 'literature',
                itemId: 'other-item',
                metadataRevision: 1,
                item: literatureItemInputSchema.parse({
                  itemType: 'journalArticle',
                  title: 'Another paper'
                }),
                attachmentVersionId: 'version-1'
              }
            ]
          }
        ]
      await new SessionRepository(source.storageRoot).saveSession(value)
    }
    await expect(
      source.service.exportTo(
        { projectId: 'project-1', sessionId: 'session-1' },
        join(source.storageRoot, 'invalid.science')
      )
    ).rejects.toThrow(/mismatch/)
  }
)

it('rejects changed imported metadata and never treats an unrelated Upload as Literature', async () => {
  const source = await setup(),
    target = await setup()
  await seed(source)
  const archive = join(source.storageRoot, 'paper.science')
  await source.service.exportTo({ projectId: 'project-1', sessionId: 'session-1' }, archive)
  const imported = await target.service.importFrom(archive)
  const row = await target.client.uploadVersion.findFirstOrThrow()
  const reader = new PackageLiteratureReader({
    storageRoot: target.storageRoot,
    getClient: async () => target.client,
    files: new ManagedFileVersionService({
      storageRoot: target.storageRoot,
      getClient: async () => target.client
    })
  })
  const recordsPath = join(
    target.storageRoot,
    'artifacts',
    imported.projectId,
    imported.sessionId,
    '.session-package/source/records.json'
  )
  await writeFile(recordsPath, '{}')
  await expect(reader.openContent(row.id)).rejects.toThrow('metadata changed')
  await target.client.uploadVersion.create({
    data: {
      id: 'unrelated-version',
      uploadFileId: row.uploadFileId,
      versionNumber: 2,
      state: 'ready',
      contentStorageKey: row.contentStorageKey + '-other',
      filename: 'other.pdf',
      originalFilename: 'other.pdf',
      contentType: 'application/pdf',
      checksum: row.checksum,
      sizeBytes: row.sizeBytes
    }
  })
  // Restore the unmodified source record so this exercises receipt membership, not corruption.
  const restoreDir = join(source.storageRoot, 'restore')
  await readPackageArchive(archive, restoreDir)
  await writeFile(recordsPath, await readFile(join(restoreDir, 'records.json')))
  expect(await reader.resolveVersion('unrelated-version')).toBeUndefined()
})

it.each(['checksum', 'owner'])(
  'rejects a checksummed archive with an inconsistent Literature binding %s',
  async (field) => {
    const source = await setup(),
      target = await setup()
    await seed(source)
    const archive = join(source.storageRoot, 'source.science')
    await source.service.exportTo({ projectId: 'project-1', sessionId: 'session-1' }, archive)
    const directory = join(source.storageRoot, 'tampered')
    const manifest = await readPackageArchive(archive, directory)
    const path = join(directory, 'session.json')
    const value = JSON.parse(await readFile(path, 'utf8'))
    const binding = value.session.runtimeContext.pdfContext.bindings[0]
    if (field === 'checksum') binding.checksum = '0'.repeat(64)
    else binding.sourceFileId = 'wrong-attachment'
    await writeFile(path, JSON.stringify(value))
    manifest.inventory = await Promise.all(
      manifest.inventory.map((entry) =>
        entry.path === 'session.json' ? packageEntry(directory, 'session.json', 'session') : entry
      )
    )
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest))
    const tampered = join(source.storageRoot, 'tampered.science')
    await writePackageArchive(directory, tampered)
    await expect(target.service.importFrom(tampered)).rejects.toThrow('binding identity mismatch')
    expect(await target.client.uploadVersion.count()).toBe(0)
  }
)

it('imports historical metadata-only Literature mentions with attachment IDs but no Literature section', async () => {
  const source = await setup(),
    target = await setup()
  await seed(source)
  const value = session()
  value.runtimeContext = undefined
  value.messages = [
    {
      id: 'mention',
      role: 'user',
      content: 'Reference',
      status: 'complete',
      eventIds: [],
      createdAt: 1,
      updatedAt: 1,
      parts: [
        {
          type: 'literature',
          itemId: 'item-1',
          metadataRevision: 1,
          item: literatureItemInputSchema.parse({
            itemType: 'journalArticle',
            title: 'Historical metadata'
          }),
          attachmentVersionId: 'version-1'
        }
      ]
    }
  ]
  await new SessionRepository(source.storageRoot).saveSession(value)
  const archive = join(source.storageRoot, 'current.science')
  await source.service.exportTo({ projectId: value.projectId, sessionId: value.id }, archive)
  const directory = join(source.storageRoot, 'historical')
  const manifest = await readPackageArchive(archive, directory)
  const records = JSON.parse(await readFile(join(directory, 'records.json'), 'utf8'))
  delete records.literature
  for (const key of Object.keys(records.tables)) records.tables[key] = []
  await writeFile(join(directory, 'records.json'), JSON.stringify(records))
  delete manifest.requiredFeatures
  manifest.inventory = await Promise.all(
    manifest.inventory
      .filter((entry) => !entry.storageKey)
      .map((entry) =>
        entry.path === 'records.json' ? packageEntry(directory, 'records.json', 'records') : entry
      )
  )
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest))
  const historical = join(source.storageRoot, 'historical.science')
  await writePackageArchive(directory, historical)
  const imported = await target.service.importFrom(historical)
  const saved = await new SessionRepository(target.storageRoot).loadSession(
    imported.projectId,
    imported.sessionId
  )
  expect(saved?.messages[0].parts?.[0]).toMatchObject({
    type: 'literature',
    attachmentVersionId: 'version-1',
    item: { title: 'Historical metadata' }
  })
  expect(await target.client.uploadVersion.count()).toBe(0)
})

it('forks a PDF referenced only by a private bookmark and keeps its metadata and target usable', async () => {
  const fixture = await setup()
  await seed(fixture)
  await new SessionRepository(fixture.storageRoot).saveSession({
    ...session(),
    runtimeContext: undefined
  })
  const bookmarks = new BookmarkRepository(async () => fixture.client)
  await bookmarks.create({
    projectId: 'project-1',
    sessionId: 'session-1',
    id: 'pdf-bookmark',
    note: 'Private PDF note',
    target: {
      kind: 'pdf',
      source: {
        kind: 'literature-attachment-version',
        projectId: 'project-1',
        sourceFileId: 'attachment-1',
        versionId: 'version-1',
        checksum: sha256(createTestPdf()),
        name: 'paper.pdf',
        path: 'literature-attachment-version:version-1'
      },
      selector: {
        kind: 'region',
        pageNumber: 1,
        pageRotation: 0,
        coordinateVersion: 1,
        rect: { x: 0, y: 0, width: 0.5, height: 0.5 }
      }
    }
  })
  const forked = await fixture.service.fork({ projectId: 'project-1', sessionId: 'session-1' })
  const bookmark = (await bookmarks.list(forked)).items[0]
  expect(bookmark.note).toBe('Private PDF note')
  if (bookmark.target.source.kind !== 'literature-attachment-version')
    throw new Error('Expected PDF target')
  expect(bookmark.target.source.versionId).not.toBe('version-1')
  const reader = new PackageLiteratureReader({
    storageRoot: fixture.storageRoot,
    getClient: async () => fixture.client,
    files: new ManagedFileVersionService({
      storageRoot: fixture.storageRoot,
      getClient: async () => fixture.client
    })
  })
  const authority = new LiteratureAttachmentAuthority({
    getClient: async () => fixture.client,
    content: new ContentRepository({
      storageRoot: fixture.storageRoot,
      getClient: async () => fixture.client
    }),
    packages: reader
  })
  const lease = await authority.openContent(bookmark.target.source.versionId)
  try {
    expect(await readFile(lease.path)).toEqual(createTestPdf())
  } finally {
    await lease.close()
  }
  expect((await fixture.service.readOrigin(forked)).literature?.items[0].item.title).toBe(
    'Evidence paper'
  )
})
