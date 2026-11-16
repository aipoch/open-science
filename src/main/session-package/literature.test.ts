import { createLiteraturePackageSource } from '../literature/package-source'
import { persistentContentReferences } from '../storage/prisma-content-references'
import { literatureItemInputSchema } from '@aipoch/literature-library/item'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { createTestPdf } from '../../../test/fixtures/literature-pdf'
import {
  createLinearConversationGraph,
  forkEditedConversationMessage,
  resolveActiveConversationMessages,
  synchronizeActiveConversationActivities
} from '../../shared/conversation-graph'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { sha256 } from '../artifacts/provenance-canonical'
import { createProvenanceTestFixture } from '../artifacts/provenance-test-fixtures'
import { BookmarkRepository } from '../bookmarks/repository'
import { LiteratureAttachmentAuthority } from '../literature/attachment-authority'
import { SessionPdfSourceResolver } from '../literature/session-pdf-source-resolver'
import { ManagedFileVersionService } from '../managed-file-versions/service'
import { ManagedPreviewResources } from '../managed-preview-resources'
import { SessionProjectionRepository } from '../session-persistence/projection'
import { SessionRepository } from '../session-persistence/repository'
import * as storageRoots from '../storage-root'
import { ContentRepository } from '../storage/content-repository'
import { packageEntry, readPackageArchive, writePackageArchive } from './archive'
import {
  remapSessionLiteratureCitations,
  sessionLiteratureReferences,
  validatePackageLiteratureSession
} from './literature'
import {
  createLiteratureSourceCitationHref,
  parseLiteratureSourceCitationHref,
  resolveLiteratureSourceCitationHref,
  type LiteratureSourceCitation
} from '../../shared/literature-source-citation'
import type { PersistedToolActivity } from '../../shared/session-message-contract'
import { PackageLiteratureReader } from './literature-reader'
import { SessionPackageService } from './service'

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
    literatureSource: createLiteraturePackageSource(async () => fixture.client),
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

const sourceCitation = (): LiteratureSourceCitation => ({
  itemId: 'item-1',
  citationId: '0123456789abcdef',
  title: 'Evidence paper',
  kind: 'pdf',
  quote: 'Evidence retained in the original PDF.',
  context: 'Evidence retained in the original PDF. Further validation is needed.',
  source: {
    attachmentId: 'attachment-1',
    versionId: 'version-1',
    checksum: sha256(createTestPdf()),
    name: 'paper.pdf'
  },
  pageStart: 1,
  pageEnd: 1
})

const citationSession = (graph = false, citation = sourceCitation()): PersistedChatSession => {
  const href = createLiteratureSourceCitationHref(citation)
  const value = session()
  value.runtimeContext = undefined
  value.messages = [
    {
      id: 'prompt',
      role: 'user',
      content: `Review the project. ${href}`,
      parts: [{ type: 'literature-scope', scope: 'project' }],
      status: 'complete',
      eventIds: [],
      createdAt: 1,
      updatedAt: 1
    },
    {
      id: 'answer',
      role: 'agent',
      responseToMessageId: 'prompt',
      content: `[1](#library-cite=${citation.citationId}) [legacy](${href})`,
      parts: [{ type: 'text', text: `[legacy](${href})` }],
      status: 'complete',
      eventIds: [],
      createdAt: 3,
      updatedAt: 3
    }
  ]
  const activity: PersistedToolActivity = {
    id: 'citation-tool',
    kind: 'tool',
    title: 'Read Library PDF',
    providerToolName: 'mcp__open_science_library__read_library_pdf',
    promptMessageId: 'prompt',
    status: 'completed',
    sortIndex: 0,
    eventIds: [],
    createdAt: 2,
    updatedAt: 2,
    toolContent: [
      {
        type: 'content',
        content: {
          type: 'text',
          text: JSON.stringify({
            openScienceLiteraturePresentation: {
              libraryAction: 'read',
              sourceCitationHrefs: [href]
            }
          })
        }
      }
    ]
  }
  value.activities = [activity]
  if (graph)
    value.conversationGraph = synchronizeActiveConversationActivities(
      createLinearConversationGraph({
        sessionId: value.id,
        messages: value.messages,
        frameworkId: 'claude-code',
        createdAt: 1,
        updatedAt: 3
      }),
      [activity],
      []
    )
  return value
}

const citationReceipt = (value: PersistedChatSession): string => {
  const activity =
    (value.conversationGraph?.activities ?? value.activities)!.find(
      ({ id }) => id === 'citation-tool'
    ) ?? (value.conversationGraph?.activities ?? value.activities)![0]
  const output = activity.toolContent![0] as { content: { text: string } }
  return JSON.parse(output.content.text).openScienceLiteraturePresentation.sourceCitationHrefs[0]
}

it('collects and maps only completed, prompt-bound Library citation receipts', () => {
  const valid = citationSession()
  expect(sessionLiteratureReferences(valid).versionIds).toEqual(new Set(['version-1']))
  for (const patch of [
    { status: 'failed' as const },
    { status: 'in_progress' as const },
    { providerToolName: 'mcp__unrelated__read_library_pdf' },
    { promptMessageId: 'missing-prompt' }
  ]) {
    const invalid = structuredClone(valid)
    Object.assign(invalid.activities![0], patch)
    expect(sessionLiteratureReferences(invalid).versionIds.size).toBe(0)
    expect(remapSessionLiteratureCitations(invalid, { 'version-1': 'local-version' })).toEqual(
      invalid
    )
  }
  const mapped = remapSessionLiteratureCitations(valid, {
    'item-1': 'local-item',
    'attachment-1': 'local-attachment',
    'version-1': 'local-version'
  })
  const href = citationReceipt(mapped)
  expect(parseLiteratureSourceCitationHref(href)).toEqual({
    ...sourceCitation(),
    itemId: 'local-item',
    source: {
      ...sourceCitation().source!,
      attachmentId: 'local-attachment',
      versionId: 'local-version'
    }
  })
  expect(mapped.messages[0].content).toBe(valid.messages[0].content)
  expect(mapped.messages[1].content).toContain(`(${href})`)
  expect(mapped.messages[1].content).toContain('(#library-cite=0123456789abcdef)')
  expect(mapped.messages[1].parts).toEqual([{ type: 'text', text: `[legacy](${href})` }])
  expect(citationReceipt(valid)).toBe(createLiteratureSourceCitationHref(sourceCitation()))
})

it.each([
  { graph: false, excluded: false, merged: false },
  { graph: false, excluded: true, merged: false },
  { graph: true, excluded: false, merged: false },
  { graph: true, excluded: true, merged: false },
  { graph: true, excluded: false, merged: true }
])(
  'round-trips citation-only Library PDF evidence (graph=$graph, excluded=$excluded, merged=$merged)',
  async ({ graph, excluded, merged }) => {
    const source = await setup(),
      target = await setup()
    await seed(source)
    const snapshot = sourceCitation()
    if (merged) {
      await source.client.literatureItem.create({
        data: {
          id: 'merged-alias',
          itemType: 'journalArticle',
          title: 'Merged paper',
          deletedAt: new Date(),
          mergedIntoItemId: 'item-1'
        }
      })
      snapshot.itemId = 'merged-alias'
    }
    const value = citationSession(graph, snapshot)
    await new SessionRepository(source.storageRoot).saveSession(value)
    const archive = join(source.storageRoot, 'citations.science')
    await source.service.exportTo({ projectId: value.projectId, sessionId: value.id }, archive, {
      selectFiles: async (files) => {
        expect(files).toHaveLength(1)
        expect(files[0]).toMatchObject({ source: 'literature', filename: 'paper.pdf' })
        return excluded ? files.map(({ storageKey }) => storageKey) : []
      }
    })
    const imported = await target.service.importFrom(archive)
    const saved = (await new SessionRepository(target.storageRoot).loadSession(
      imported.projectId,
      imported.sessionId
    ))!
    const href = citationReceipt(saved)
    const citation = resolveLiteratureSourceCitationHref('#library-cite=0123456789abcdef', [href])!
    expect(citation).toBeDefined()
    expect(citation.itemId).not.toBe('item-1')
    expect(citation.source!.attachmentId).not.toBe('attachment-1')
    expect(citation.source!.versionId).not.toBe('version-1')
    expect(citation).toMatchObject({
      quote: sourceCitation().quote,
      context: sourceCitation().context,
      pageStart: 1,
      pageEnd: 1
    })
    expect(citation.source!.checksum).toBe(sha256(createTestPdf()))
    expect(saved.messages.find(({ role }) => role === 'agent')!.content).toContain(`(${href})`)
    expect(await target.client.literatureItem.count()).toBe(0)
    const reader = new PackageLiteratureReader({
      storageRoot: target.storageRoot,
      getClient: async () => target.client,
      files: new ManagedFileVersionService({
        storageRoot: target.storageRoot,
        getClient: async () => target.client
      })
    })
    if (excluded) {
      await expect(reader.resolveVersion(citation.source!.versionId)).rejects.toThrow(
        'not included'
      )
    } else {
      expect(await reader.resolveVersion(citation.source!.versionId)).toMatchObject({
        itemId: citation.itemId,
        attachmentId: citation.source!.attachmentId,
        versionId: citation.source!.versionId,
        checksum: citation.source!.checksum
      })
      const lease = await reader.openContent(citation.source!.versionId)
      try {
        expect(await lease.readRange(0, lease.size)).toEqual(new Uint8Array(createTestPdf()))
      } finally {
        await lease.close()
      }
    }
    if (graph && !excluded) {
      const forwarded = join(target.storageRoot, 'forwarded-citations.science')
      await target.service.exportTo(imported, forwarded)
      const second = await target.service.importFrom(forwarded)
      const restored = (await new SessionRepository(target.storageRoot).loadSession(
        second.projectId,
        second.sessionId
      ))!
      const forwardedCitation = parseLiteratureSourceCitationHref(citationReceipt(restored))!
      expect(forwardedCitation.source!.versionId).not.toBe(citation.source!.versionId)
      expect(await reader.resolveVersion(forwardedCitation.source!.versionId)).toMatchObject({
        checksum: citation.source!.checksum
      })
      if (merged) {
        const forked = await target.service.fork(second)
        const forkedSession = (await new SessionRepository(target.storageRoot).loadSession(
          forked.projectId,
          forked.sessionId
        ))!
        const forkedCitation = parseLiteratureSourceCitationHref(citationReceipt(forkedSession))!
        expect(forkedCitation.source!.versionId).not.toBe(forwardedCitation.source!.versionId)
        expect(await reader.resolveVersion(forkedCitation.source!.versionId)).toMatchObject({
          checksum: citation.source!.checksum
        })
        const original = (await new SessionRepository(source.storageRoot).loadSession(
          value.projectId,
          value.id
        ))!
        expect(parseLiteratureSourceCitationHref(citationReceipt(original))!.itemId).toBe(
          'merged-alias'
        )
      }
    }
  }
)

it('retains citation-only PDF dependencies from inactive conversation branches', () => {
  const value = citationSession(true)
  value.conversationGraph = forkEditedConversationMessage(
    value.conversationGraph!,
    'prompt',
    'edited-prompt',
    4
  )
  value.messages = resolveActiveConversationMessages(value.conversationGraph)
  expect(value.messages.some(({ id }) => id === 'prompt')).toBe(false)
  expect(sessionLiteratureReferences(value).versionIds).toEqual(new Set(['version-1']))
})

it.each(['item', 'attachment', 'checksum'] as const)(
  'rejects citation-only PDF evidence with mismatched %s identity',
  async (field) => {
    const source = await setup()
    await seed(source)
    const citation = sourceCitation()
    if (field === 'item') citation.itemId = 'another-item'
    if (field === 'attachment') citation.source!.attachmentId = 'another-attachment'
    if (field === 'checksum') citation.source!.checksum = '0'.repeat(64)
    const value = citationSession(false, citation)
    await new SessionRepository(source.storageRoot).saveSession(value)
    await expect(
      source.service.exportTo(
        { projectId: value.projectId, sessionId: value.id },
        join(source.storageRoot, 'invalid-citations.science')
      )
    ).rejects.toThrow('citation content identity mismatch')
    expect(() => validatePackageLiteratureSession({ tables: {} } as never, value)).toThrow(
      'no packaged Version'
    )
  }
)

it.each(['deleted', 'unavailable', 'checksum', 'size', 'content-type'] as const)(
  'rejects a live Literature source with invalid %s identity',
  async (invalid) => {
    const fixture = await setup()
    await seed(fixture)
    if (invalid === 'deleted')
      await fixture.client.literatureItem.update({
        where: { id: 'item-1' },
        data: { deletedAt: new Date() }
      })
    else if (invalid === 'content-type')
      await fixture.client.literatureAttachmentVersion.update({
        where: { id: 'version-1' },
        data: { contentType: 'text/plain' }
      })
    else
      await fixture.client.contentBlob.update({
        where: { id: 'blob-1' },
        data:
          invalid === 'unavailable'
            ? { state: 'quarantined' }
            : invalid === 'checksum'
              ? { checksum: '0'.repeat(64) }
              : { sizeBytes: 1n }
      })
    const source = createLiteraturePackageSource(async () => fixture.client)
    await expect(source.readVersions(['version-1'])).rejects.toThrow(
      'Literature PDF content identity is invalid'
    )
  }
)

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
        references: persistentContentReferences,
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
  // Two imports plus two forks repeatedly migrate real validation databases; Ubuntu coverage
  // exceeded 30 seconds. Match the bounded budgets of the adjacent package round-trip suites.
  process.platform === 'win32' ? 120_000 : 60_000
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
    const resources = new ManagedPreviewResources({
      resolvePath: async () => {
        throw new Error('Package preview must use its trusted lease')
      },
      openLiterature: () => reader.openContent(versions[index].id)
    })
    const resource = await resources.acquire(17, { source: 'literature', path: versions[index].id })
    try {
      expect(resource.sourceChecksum).toBe(sha256(pdf))
      expect(resource.size).toBe(pdf.length)
      const bytes = await resources.readRange(17, {
        resourceId: resource.id,
        begin: 0,
        end: pdf.length
      })
      expect(Buffer.from(bytes.data)).toEqual(pdf)
    } finally {
      await resources.release(17, { resourceId: resource.id })
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
      .filter((entry) => !entry.storageKey && entry.path !== 'ro-crate-metadata.json')
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
      references: persistentContentReferences,
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

const frozenImportFixtures = [
  {
    name: 'minimal package',
    path: fileURLToPath(
      new URL('./fixtures/session-package-v0.31.1-minimal.science', import.meta.url)
    ),
    sha256: 'be6f0dad2957db20682501bb1affffa496a6e6a7dce739f418585bd303804123',
    projectName: 'Legacy research',
    sessionTitle: 'Legacy research',
    source: { projectId: 'legacy-project', sessionId: 'legacy-session' },
    artifactCount: 0,
    requiredFeatures: undefined,
    literatureItemCount: 0,
    literatureVersionCount: 0,
    pdfBytes: undefined
  },
  {
    name: 'artifact package',
    path: fileURLToPath(
      new URL('./fixtures/session-package-v0.31.1-artifact.science', import.meta.url)
    ),
    sha256: 'd31f86381012eb7ae54b4ebe6ffca9510e7bc6049dd19e53e5206b7fbbcbcf24',
    projectName: 'Artifact research',
    sessionTitle: 'Artifact research',
    source: { projectId: 'project-1', sessionId: 'session-1' },
    artifactCount: 1,
    requiredFeatures: undefined,
    literatureItemCount: 0,
    literatureVersionCount: 0,
    pdfBytes: undefined
  },
  {
    name: 'literature package',
    path: fileURLToPath(
      new URL('./fixtures/session-package-v0.31.1-literature.science', import.meta.url)
    ),
    sha256: '37b4c014151676aebc8c0866fc1f6b577bd5ad2976bd13b4b1412b18d9d256c8',
    projectName: 'Literature research',
    sessionTitle: 'Reading paper',
    source: { projectId: 'project-1', sessionId: 'session-1' },
    artifactCount: 0,
    requiredFeatures: ['literature'],
    literatureItemCount: 0,
    literatureVersionCount: 1,
    pdfBytes: createTestPdf()
  }
] as const

for (const fixtureCase of frozenImportFixtures) {
  it(`imports the checked-in ${fixtureCase.name}`, async () => {
    const packageBytes = await readFile(fixtureCase.path)
    expect(createHash('sha256').update(packageBytes).digest('hex')).toBe(fixtureCase.sha256)

    const target = await setup()
    const imported = await target.service.importFrom(fixtureCase.path)
    const session = await new SessionRepository(target.storageRoot).loadSession(
      imported.projectId,
      imported.sessionId
    )
    const project = await target.client.project.findUniqueOrThrow({
      where: { id: imported.projectId }
    })
    const origin = await target.service.readOrigin(imported)

    expect(project.name).toBe(fixtureCase.projectName)
    expect(session).toMatchObject({
      id: imported.sessionId,
      projectId: imported.projectId,
      title: fixtureCase.sessionTitle,
      status: 'idle',
      packageOrigin: {
        sourceProjectId: fixtureCase.source.projectId,
        sourceSessionId: fixtureCase.source.sessionId
      }
    })
    expect(origin.sourceManifest.source).toMatchObject(fixtureCase.source)
    expect(origin.sourceManifest.requiredFeatures).toEqual(fixtureCase.requiredFeatures)
    expect(await target.client.artifactVersion.count()).toBe(fixtureCase.artifactCount)

    expect(await target.client.literatureItem.count()).toBe(fixtureCase.literatureItemCount)
    const literatureVersions = await target.client.uploadVersion.findMany({
      orderBy: { versionNumber: 'asc' }
    })
    expect(literatureVersions).toHaveLength(fixtureCase.literatureVersionCount)

    if (fixtureCase.pdfBytes) {
      const [version] = literatureVersions
      expect(version).toMatchObject({
        filename: 'paper.pdf',
        originalFilename: 'paper.pdf',
        contentType: 'application/pdf',
        checksum: sha256(fixtureCase.pdfBytes),
        sizeBytes: BigInt(fixtureCase.pdfBytes.length)
      })
      expect(await readFile(join(target.storageRoot, version.contentStorageKey))).toEqual(
        fixtureCase.pdfBytes
      )

      const binding = session?.runtimeContext?.pdfContext?.bindings[0]
      expect(binding).toMatchObject({
        sourceKind: 'literature-attachment-version',
        sourceFileId: version.uploadFileId,
        sourceVersionId: version.id,
        name: 'paper.pdf',
        mimeType: 'application/pdf',
        sizeBytes: fixtureCase.pdfBytes.length,
        checksum: sha256(fixtureCase.pdfBytes)
      })

      const recordsRoot = join(
        target.storageRoot,
        'artifacts',
        imported.projectId,
        imported.sessionId,
        '.session-package',
        'source'
      )
      const records = JSON.parse(await readFile(join(recordsRoot, 'records.json'), 'utf8'))
      expect(records.literature.items).toHaveLength(1)
      expect(records.literature.items[0]).toMatchObject({
        itemId: 'item-1',
        metadataRevision: 7,
        item: {
          itemType: 'journalArticle',
          title: 'Evidence paper',
          abstract: 'Abstract preserved with the PDF.',
          issuedText: '2024',
          issuedYear: 2024,
          containerTitle: 'Journal of Evidence',
          shortTitle: 'Evidence',
          language: 'en',
          rights: 'CC BY 4.0',
          url: 'https://example.test/evidence',
          accessedAt: 1_700_000_000_000,
          citationKey: 'evidence-2024',
          extra: 'Imported from fixture',
          rating: 4,
          personalNote: 'Read the methods section.',
          typeFields: { volume: '12', issue: '3', pages: '10-20' },
          creators: [
            {
              nameMode: 'person',
              givenName: 'Ada',
              familyName: 'Lovelace',
              creatorType: 'author'
            },
            {
              nameMode: 'organization',
              literalName: 'Evidence Institute',
              creatorType: 'publisher'
            }
          ],
          identifiers: [
            { scheme: 'doi', value: '10.1234/ABC', isPrimary: true },
            { scheme: 'pmid', value: '12345', isPrimary: false }
          ]
        }
      })
      expect(records.literature.attachments).toHaveLength(1)
      expect(records.literature.attachments[0]).toMatchObject({
        attachmentId: 'attachment-1',
        itemId: 'item-1',
        versionId: 'version-1'
      })
    }
  })
}
