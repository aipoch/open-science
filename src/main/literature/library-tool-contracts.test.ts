import { setImmediate } from 'node:timers/promises'
import { tmpdir } from 'node:os'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AcpRuntimeOptions } from '../acp/runtime'
import { createAcpRuntime, type AcpRuntimeCompositionOptions } from '../acp/runtime-composition'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { expect, it, vi } from 'vitest'
import type {
  LiteratureLibraryMcpHandler,
  LiteratureLibrarySaveResult,
  LiteratureLibraryDiscovery
} from './library-mcp-server'
import { createLiteratureLibraryMcpServer } from './library-mcp-server'
import { LiteratureCatalog } from './catalog'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import type { LiteratureItemInput, LiteratureItemView } from '../../shared/literature'
import { literatureItemInputSchema } from '../../shared/literature'
import { buildLiteratureLibraryToolSummary } from '../../renderer/src/pages/workspace/literature-tool-presentation'
// Capture the real composition's options at the existing runtime-owner boundary.
// No provider process, network host, or runtime session is started.
const capture = vi.hoisted(() => ({ options: undefined as AcpRuntimeOptions | undefined }))
vi.mock('electron', () => ({
  app: { getVersion: () => 'test' },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('../storage-root', () => ({
  resolveConfigRoot: () => '/unused-test-config',
  resolveDataRoot: () => '/unused-test-data'
}))
vi.mock('../acp/runtime-coordinator', () => ({
  AcpRuntimeCoordinator: class {
    constructor(factory: (callbacks: object, grants: object) => unknown) {
      factory({}, {})
    }
  }
}))
vi.mock('../acp/runtime-base-composition', () => ({
  composeAcpRuntimeBaseOwners: (options: AcpRuntimeOptions) => {
    capture.options = options
    return {}
  }
}))
vi.mock('../acp/runtime-session-composition', () => ({
  composeAcpRuntimeSessionOwners: () => ({})
}))
vi.mock('../acp/runtime', () => ({ AcpRuntime: class {} }))
const production = <K extends 'saveToInbox' | 'searchLibrary' | 'readCandidateFile'>(
  name: K,
  catalog: LiteratureCatalog
): NonNullable<AcpRuntimeOptions['literatureLibrary']>[K] => {
  createAcpRuntime({
    literatureCatalog: catalog,
    fixedBackend: {},
    settingsService: {}
  } as unknown as AcpRuntimeCompositionOptions)
  return capture.options!.literatureLibrary![name]
}
const item = (title = 'A paper', extra = {}): LiteratureItemInput =>
  literatureItemInputSchema.parse({ itemType: 'journalArticle', title, ...extra })
const discovery = (title = 'A paper', extra = {}): LiteratureLibraryDiscovery => ({
  item: item(title, extra),
  source: {
    provider: 'audit',
    externalId: title,
    sourceUrl: 'https://example.test/paper',
    rawMetadata: {}
  }
})
const view = (value: ReturnType<typeof item>, id = 'item-1'): LiteratureItemView => ({
  id,
  item: value,
  metadataRevision: 1,
  attachments: [],
  projectIds: [],
  collectionIds: [],
  createdAt: 1,
  updatedAt: 1
})
const open = async (
  handler: Partial<LiteratureLibraryMcpHandler>
): Promise<{ client: Client; close: () => Promise<void> }> => {
  const server = createLiteratureLibraryMcpServer({
    searchLibrary: async () => ({ items: [], totalCount: 0, hasMore: false }),
    readAbstract: async () => undefined,
    readPdf: async () => undefined,
    saveToInbox: async () => ({ results: [] }),
    ...handler
  })
  const client = new Client({ name: 'audit', version: '1' })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(st), client.connect(ct)])
  return {
    client,
    close: async () => {
      await client.close()
      await server.close()
    }
  }
}
const db = async (
  fn: (
    catalog: LiteratureCatalog,
    client: ReturnType<typeof createProjectDbClient>
  ) => Promise<void>
): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'literature-tool-contract-'))
  const client = createProjectDbClient(root)
  try {
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-1', name: 'Research' } })
    await fn(new LiteratureCatalog(async () => client), client)
  } finally {
    await client.$disconnect()
    await rm(root, { recursive: true, force: true })
  }
}
const bindSave = (catalog: LiteratureCatalog): LiteratureLibraryMcpHandler['saveToInbox'] => {
  const save = production('saveToInbox', catalog)
  return (r: Parameters<LiteratureLibraryMcpHandler['saveToInbox']>[0]) =>
    save({ ...r, projectId: 'project-1', sessionId: 'session-1' })
}
const presentation = (result: Awaited<ReturnType<Client['callTool']>>): { savedCount: number } => {
  const content = result.content as { type: string; text: string }[]
  return JSON.parse(content[0].text).openScienceLiteraturePresentation as { savedCount: number }
}

it('retains committed receipts when a later candidate fails', async () =>
  db(async (catalog, dbClient) => {
    const real = catalog.transact.bind(catalog)
    let count = 0
    vi.spyOn(catalog, 'transact').mockImplementation(async (command) => {
      if (++count === 2) throw new Error('Injected database unavailable')
      return real(command)
    })
    const api = await open({ saveToInbox: bindSave(catalog) })
    try {
      const candidates = [discovery('first'), discovery('second'), discovery('third')]
      const result = await api.client.callTool({ name: 'save_to_inbox', arguments: { candidates } })
      expect(await dbClient.literatureInboxCandidate.count()).toBe(1)
      expect(count).toBe(2)
      expect(result.structuredContent).toEqual(
        expect.objectContaining({
          results: [expect.objectContaining({ kind: 'candidate', state: 'pending' })]
        })
      )
      // A repeat can deduplicate the first candidate but cannot retroactively supply the missing receipt.
      const retry = await api.client.callTool({ name: 'save_to_inbox', arguments: { candidates } })
      expect(retry.isError).not.toBe(true)
      expect(await dbClient.literatureInboxCandidate.count()).toBe(3)
    } finally {
      await api.close()
    }
  }))

it('does not start saving after cancellation during reference resolution', async () =>
  db(async (catalog, dbClient) => {
    let release!: (v: readonly LiteratureLibraryDiscovery[]) => void
    const saves: Promise<unknown>[] = []
    const save = bindSave(catalog)
    const api = await open({
      resolveSaveReferences: () => new Promise((r) => (release = r)),
      saveToInbox: (r) => {
        const saving = save(r)
        saves.push(saving)
        return saving
      }
    })
    try {
      const controller = new AbortController()
      const pending = api.client
        .callTool(
          { name: 'save_to_inbox', arguments: { refs: ['doi:10.1234/example'] } },
          undefined,
          { signal: controller.signal }
        )
        .then(
          () => ({ cancelled: false }),
          () => ({ cancelled: true })
        )
      await vi.waitFor(() => expect(release).toBeTypeOf('function'))
      expect(await dbClient.literatureInboxCandidate.count()).toBe(0)
      controller.abort()
      expect(await pending).toEqual({ cancelled: true })
      await api.client.ping()
      release([discovery('after cancellation')])
      await setImmediate()
      await Promise.all(saves)
      expect(await dbClient.literatureInboxCandidate.count()).toBe(0)
    } finally {
      release?.([discovery('after cancellation')])
      await api.close()
    }
  }))

it('counts repeated candidate receipts once', async () =>
  db(async (catalog, dbClient) => {
    const api = await open({ saveToInbox: bindSave(catalog) })
    try {
      const repeated = discovery('same pending')
      const result = await api.client.callTool({
        name: 'save_to_inbox',
        arguments: { candidates: [repeated, repeated] }
      })
      expect(result.isError).not.toBe(true)
      expect(await dbClient.literatureInboxCandidate.count()).toBe(1)
      expect(presentation(result).savedCount).toBe(1)
      expect((result.structuredContent as LiteratureLibrarySaveResult).results[0].id).toBe(
        (result.structuredContent as LiteratureLibrarySaveResult).results[1].id
      )
    } finally {
      await api.close()
    }
  }))

it('does not count an existing library item as an Inbox save', async () =>
  db(async (catalog, dbClient) => {
    const api = await open({ saveToInbox: bindSave(catalog) })
    try {
      const existing = discovery('existing', {
        identifiers: [{ scheme: 'doi', value: '10.1234/existing', isPrimary: true }]
      })
      await catalog.transact({ kind: 'create-item', item: existing.item })
      const reused = await api.client.callTool({
        name: 'save_to_inbox',
        arguments: { candidates: [existing] }
      })
      expect((reused.structuredContent as LiteratureLibrarySaveResult).results[0]).toMatchObject({
        kind: 'item',
        state: 'present'
      })
      expect(await dbClient.literatureInboxCandidate.count()).toBe(0)
      expect(presentation(reused).savedCount).toBe(0)
      const summary = buildLiteratureLibraryToolSummary('save', { candidates: [existing] }, reused)
      expect(summary).toMatchObject({ savedCount: 0, action: 'save', libraryScope: 'project' })
    } finally {
      await api.close()
    }
  }))

it('excludes editors and translators from authors', async () => {
  const value = item('Edited book', {
    itemType: 'book',
    creators: [
      { nameMode: 'person', givenName: 'Alice', familyName: 'Editor', creatorType: 'editor' },
      { nameMode: 'organization', literalName: 'Translation Institute', creatorType: 'translator' }
    ]
  })
  const api = await open({
    searchLibrary: async () => ({ items: [view(value)], totalCount: 1, hasMore: false })
  })
  try {
    const result = await api.client.callTool({ name: 'search_library', arguments: {} })
    expect(
      (
        result.structuredContent as {
          items: {
            authors: string
            creatorCount: number
            primaryIdentifiers: { value: string }[]
          }[]
        }
      ).items[0]
    ).toMatchObject({
      authors: '',
      creatorCount: 2
    })
    expect(JSON.stringify(result.structuredContent)).not.toContain('creatorType')
  } finally {
    await api.close()
  }
})

it('preserves exact identifier values in search results', async () => {
  const doi = '10.1234/' + 'segment'.repeat(35)
  const value = item('Long identifier', {
    identifiers: [{ scheme: 'doi', value: doi, isPrimary: true }]
  })
  expect(value.identifiers[0].value).toBe(doi)
  const api = await open({
    searchLibrary: async () => ({ items: [view(value)], totalCount: 1, hasMore: false })
  })
  try {
    const result = await api.client.callTool({ name: 'search_library', arguments: {} })
    const row = (
      result.structuredContent as {
        items: { authors: string; creatorCount: number; primaryIdentifiers: { value: string }[] }[]
      }
    ).items[0]
    expect(row.primaryIdentifiers[0].value).toBe(doi)
  } finally {
    await api.close()
  }
})

it('bounds all search text blocks for long metadata titles', async () => {
  const items = Array.from({ length: 3 }, (_, i) =>
    view(item('Long title ' + String(i) + 'x'.repeat(20000)), 'id-' + i)
  )
  const api = await open({ searchLibrary: async () => ({ items, totalCount: 3, hasMore: false }) })
  try {
    const result = await api.client.callTool({ name: 'search_library', arguments: {} })
    expect(JSON.stringify(result.structuredContent).length).toBeLessThan(38000)
    expect(JSON.stringify(result.content).length).toBeLessThanOrEqual(38000)
  } finally {
    await api.close()
  }
})

it('distinguishes unreadable files from invalid candidate content', async () => {
  const save = vi.fn()
  const api = await open({
    readCandidateFile: async () => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    },
    saveToInbox: save
  })
  try {
    const result = await api.client.callTool({
      name: 'save_to_inbox',
      arguments: { filename: 'records.json' }
    })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).not.toContain('INVALID_CANDIDATE_FILE')
    expect(save).not.toHaveBeenCalled()
  } finally {
    await api.close()
  }
})

it('does not search JSON field names in selected-item scope', async () =>
  db(async (catalog) => {
    const receipt = await catalog.transact({ kind: 'create-item', item: item('Climate methods') })
    const search = production('searchLibrary', catalog)
    const api = await open({
      searchLibrary: (request) => search({ ...request, projectId: 'project-1' })
    })
    try {
      const result = await api.client.callTool({
        name: 'search_library',
        arguments: { scope: 'items', itemIds: [receipt.id], query: 'rights' }
      })
      const global = await api.client.callTool({
        name: 'search_library',
        arguments: { scope: 'library', query: 'rights' }
      })
      expect((global.structuredContent as { totalCount: number }).totalCount).toBe(0)
      expect((result.structuredContent as { totalCount: number }).totalCount).toBe(0)
    } finally {
      await api.close()
    }
  }))

it('finishes an in-flight transaction and returns its receipt before stopping the next write', async () =>
  db(async (catalog, dbClient) => {
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const transact = catalog.transact.bind(catalog)
    let started!: () => void
    const entered = new Promise<void>((resolve) => {
      started = resolve
    })
    const spy = vi.spyOn(catalog, 'transact').mockImplementation(async (command) => {
      started()
      await blocked
      return transact(command)
    })
    const controller = new AbortController()
    const save = bindSave(catalog)
    const pending = save({
      candidates: [discovery('first'), discovery('second')],
      signal: controller.signal
    })
    await entered
    controller.abort()
    release()
    const result = await pending
    expect(await dbClient.literatureInboxCandidate.count()).toBe(1)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(result).toEqual({
      results: [expect.objectContaining({ kind: 'candidate', state: 'pending' })],
      cancelled: true
    })
  }))

it('returns bounded complete search records and a continuation that advances', async () => {
  const identifier = '10.1234/' + 'x'.repeat(12000)
  const items = Array.from({ length: 4 }, (_, index) =>
    view(
      item(`Paper ${index}`, {
        identifiers: [{ scheme: 'doi', value: identifier + index, isPrimary: true }]
      }),
      `item-${index}`
    )
  )
  const api = await open({
    searchLibrary: async ({ offset = 0 }) => ({
      items: items.slice(offset),
      totalCount: 4,
      hasMore: false
    })
  })
  try {
    const first = await api.client.callTool({ name: 'search_library', arguments: {} })
    const page = first.structuredContent as {
      items: { id: string; primaryIdentifiers: { value: string }[] }[]
      nextOffset: number
    }
    expect(JSON.stringify(first.content).length).toBeLessThanOrEqual(38000)
    expect(page.items.length).toBeGreaterThan(0)
    expect(page.items.length).toBeLessThan(4)
    expect(page.nextOffset).toBe(page.items.length)
    expect(page.items[0].primaryIdentifiers[0].value).toBe(identifier + '0')
    const second = await api.client.callTool({
      name: 'search_library',
      arguments: { offset: page.nextOffset }
    })
    expect(
      (second.structuredContent as { items: { id: string }[] }).items.map(({ id }) => id)
    ).toEqual(items.slice(page.nextOffset).map(({ id }) => id))
  } finally {
    await api.close()
  }
})

it('rejects a single oversized search record without rewriting its identifier', async () => {
  const api = await open({
    searchLibrary: async () => ({
      items: [
        view(
          item('Oversized', {
            identifiers: [{ scheme: 'doi', value: '10.1234/' + 'x'.repeat(40000), isPrimary: true }]
          })
        )
      ],
      totalCount: 1,
      hasMore: false
    })
  })
  try {
    const result = await api.client.callTool({ name: 'search_library', arguments: {} })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('SEARCH_RESULT_TOO_LARGE')
    expect(JSON.stringify(result.content).length).toBeLessThanOrEqual(38000)
  } finally {
    await api.close()
  }
})

it.each(['{', '{"candidates":[{}]}'])(
  'still classifies malformed candidate content correctly: %s',
  async (content) => {
    const save = vi.fn()
    const api = await open({ readCandidateFile: async () => content, saveToInbox: save })
    try {
      const result = await api.client.callTool({
        name: 'save_to_inbox',
        arguments: { filename: 'records.json' }
      })
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result.content)).toContain('INVALID_CANDIDATE_FILE')
      expect(save).not.toHaveBeenCalled()
    } finally {
      await api.close()
    }
  }
)

it('intersects selected IDs with ordinary search and paginates the filtered membership', async () =>
  db(async (catalog) => {
    const first = await catalog.transact({ kind: 'create-item', item: item('Climate first') })
    const second = await catalog.transact({ kind: 'create-item', item: item('Climate second') })
    await catalog.transact({ kind: 'create-item', item: item('Climate outside selection') })
    const ids = [first.id, second.id]
    const search = production('searchLibrary', catalog)
    const request = {
      projectId: 'project-1',
      scope: 'items' as const,
      itemIds: ids,
      query: 'Climate',
      limit: 1
    }
    const page = await search(request)
    expect(page.totalCount).toBe(2)
    expect(page.nextOffset).toBe(1)
    const next = await search({ ...request, offset: page.nextOffset })
    expect(new Set([...page.items, ...next.items].map(({ id }) => id))).toEqual(new Set(ids))
    expect(next.hasMore).toBe(false)
    expect(await search({ ...request, itemIds: [] })).toMatchObject({ items: [], totalCount: 0 })
  }))

it('reports the production candidate-file size limit as a read failure, without disclosing its path', async () =>
  db(async (catalog) => {
    const root = await mkdtemp(join(tmpdir(), 'literature-candidate-file-'))
    const filename = join(root, 'oversized.json')
    await writeFile(filename, ' '.repeat(2 * 1024 * 1024 + 1))
    const read = production('readCandidateFile', catalog)!
    const save = vi.fn()
    const api = await open({
      readCandidateFile: (name, signal) =>
        read({
          projectId: 'project-1',
          sessionId: 'session-1',
          workspaceCwd: root,
          filename: name,
          signal
        }),
      saveToInbox: save
    })
    try {
      const result = await api.client.callTool({ name: 'save_to_inbox', arguments: { filename } })
      expect(result.isError).toBe(true)
      const text = JSON.stringify(result.content)
      expect(text).toContain('CANDIDATE_FILE_TOO_LARGE')
      expect(text).not.toContain('INVALID_CANDIDATE_FILE')
      expect(text).not.toContain(root)
      expect(save).not.toHaveBeenCalled()
    } finally {
      await api.close()
      await rm(root, { recursive: true, force: true })
    }
  }))
