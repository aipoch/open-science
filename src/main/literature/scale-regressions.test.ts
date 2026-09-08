import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { literatureItemInputSchema, type LiteratureItemView } from '../../shared/literature'
import type { LiteratureJobsResult } from '../../shared/literature-jobs'
import { WEB_RPC_PROTOCOL_VERSION } from '../../shared/web-rpc-contract'
import { ApplicationEventHub } from '../application-events'
import { migrateApplicationDatabase } from '../database/migration-service'
import { createProjectDbClient } from '../projects/prisma-client'
import { startWebHttpServer } from '../web-service/http-server'
import { LiteratureCatalog } from './catalog'
import { LiteratureBatchJobs } from './batch-jobs'
import { findLiteratureDuplicateGroups } from './duplicates'
import { writeDurableJsonFile } from '../storage/durable-json-file'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: vi.fn() },
  protocol: { handle: vi.fn(), unhandle: vi.fn() },
  net: { fetch: vi.fn() }
}))
// Observe the existing durable-write boundary, without writing gigabytes to disk.
vi.mock('../storage/durable-json-file', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../storage/durable-json-file')>()),
  writeDurableJsonFile: vi.fn(async () => undefined)
}))
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.clearAllMocks()
})
async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'literature-scale-'))
  cleanup.push(() => rm(path, { recursive: true, force: true }))
  return path
}
async function rpc(
  channel: 'literature:search' | 'literature:jobs' | 'literature:export-record',
  invoke: () => Promise<unknown>
): Promise<{ status: number; body: unknown }> {
  const dispatcher = { commandNames: () => [channel], invoke }
  const server = await startWebHttpServer({
    host: '127.0.0.1',
    port: 0,
    token: 'test-token',
    staticRoot: '/unused',
    applicationCommands: {
      localWeb: dispatcher,
      remoteWeb: { ...dispatcher, rejectedCommandNames: () => [] }
    },
    applicationEvents: new ApplicationEventHub(),
    bootstrap: {
      appName: 'Open Science',
      appVersion: '0.0.0',
      configRoot: '/fake/root',
      platform: 'test',
      versions: { electron: '1', chrome: '1', node: '1' }
    }
  })
  cleanup.push(() => server.close())
  const response = await fetch(
    `http://127.0.0.1:${server.port}/rpc/${encodeURIComponent(channel)}`,
    {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify({ protocolVersion: WEB_RPC_PROTOCOL_VERSION, args: [] })
    }
  )
  return { status: response.status, body: await response.json() }
}

it('opens a supported Library page containing long valid abstracts over Web RPC', async () => {
  const client = createProjectDbClient(await directory())
  cleanup.push(() => client.$disconnect())
  await migrateApplicationDatabase(client)
  const catalog = new LiteratureCatalog(async () => client)
  const abstract = 'a'.repeat(180_000)
  for (let index = 0; index < 100; index++) {
    await catalog.transact({
      kind: 'create-item',
      item: literatureItemInputSchema.parse({
        itemType: 'journalArticle',
        title: `Reference ${index}`,
        abstract
      })
    })
  }
  const small = await rpc('literature:search', () =>
    catalog.search({ scope: 'library', limit: 50 })
  )
  expect(small.status).toBe(200)
  const result = await rpc('literature:search', () =>
    catalog.search({ scope: 'library', limit: 100 })
  )
  expect(result, JSON.stringify(result)).toMatchObject({ status: 200 })
  const ids: string[] = []
  let offset: number | undefined = 0
  do {
    const page = await catalog.search({ scope: 'library', limit: 100, offset })
    ids.push(...page.entries.flatMap((entry) => ('id' in entry ? [entry.id] : [])))
    offset = page.nextOffset
  } while (offset !== undefined)
  expect(new Set(ids).size).toBe(100)
  expect(ids).toHaveLength(100)
  expect((await catalog.get(ids[0]))?.item.abstract).toBe(abstract)
}, 30_000)

async function completedJob(count: number): Promise<{
  measured: { bytes: number; calls: number }
  result: LiteratureJobsResult
}> {
  const item = (id: string): LiteratureItemView => ({
    id,
    metadataRevision: 1,
    createdAt: 1,
    updatedAt: 1,
    attachments: [],
    collectionIds: [],
    projectIds: [],
    item: literatureItemInputSchema.parse({
      itemType: 'journalArticle',
      title: id,
      abstract: 'a'.repeat(8_000),
      identifiers: [{ scheme: 'doi', value: `10.1234/${id}` }]
    })
  })
  const onError = vi.fn()
  const jobs = new LiteratureBatchJobs({
    path: join(await directory(), 'jobs.json'),
    spacingMs: 0,
    onError,
    catalog: { get: async (id) => item(id) },
    metadata: {
      complete: async ({ itemId }) => ({
        mode: 'preview',
        reviewVersion: 1,
        provider: 'crossref',
        sourceUrl: 'https://crossref.org',
        item: item(itemId!),
        filled: [{ field: 'journal', value: 'Journal' }],
        conflicts: []
      }),
      applyReviewed: vi.fn()
    },
    fullText: { run: vi.fn() }
  })
  cleanup.push(() => jobs.close())
  const jobId = randomUUID()
  vi.mocked(writeDurableJsonFile).mockClear()
  let bytes = 0
  let calls = 0
  vi.mocked(writeDurableJsonFile).mockImplementation(async (_path, contents) => {
    bytes += Buffer.byteLength(contents)
    calls++
    vi.mocked(writeDurableJsonFile).mockClear()
  })
  await jobs.run({
    action: 'create',
    mode: 'metadata',
    requestId: jobId,
    itemIds: Array.from({ length: count }, (_, index) => `reference-${index}`)
  })
  await vi.waitFor(
    async () => {
      expect(onError).not.toHaveBeenCalled()
      const summary = await jobs.run({ action: 'list' })
      expect(summary.summaries?.[0].state).toBe('review')
    },
    { timeout: 60_000, interval: 50 }
  )
  const result = await jobs.run({ action: 'get', jobId })
  // close drains the final durable checkpoint before measuring.
  await jobs.close()
  const measured = { bytes, calls }
  // Reopen is intentionally not exercised: this fixture observes writes, it does not persist them.
  return { measured, result }
}

it('keeps batch checkpoint bytes proportional to the number of processed references', async () => {
  const small = await completedJob(100)
  const large = await completedJob(200)
  console.info('checkpoint bytes', { small: small.measured, large: large.measured })
  expect(large.measured.bytes).toBeLessThan(small.measured.bytes * 2.5)
}, 60_000)

it('opens a completed maximum-size metadata review over Web RPC', async () => {
  const fixture = await completedJob(1000)
  expect(fixture.result.jobs[0].rows).toHaveLength(1000)
  expect(fixture.result.jobs[0].state).toBe('review')
  const result = await rpc('literature:jobs', async () => fixture.result)
  expect(result, JSON.stringify(result)).toMatchObject({ status: 200 })
}, 90_000)

it('avoids pairwise identity comparisons for conflicting candidates sharing metadata', () => {
  const measure = (count: number): number => {
    const candidates = Array.from({ length: count }, (_, index) => ({
      id: String(index),
      itemType: 'journalArticle',
      title: 'A shared title',
      issuedYear: 2024,
      creators: [{ creator: { familyName: 'Rivera', givenName: 'Alex', literalName: '' } }],
      identifiers: [{ scheme: 'doi', normalizedValue: `10.1234/${index}` }]
    }))
    // Count actual identifier membership probes, not wall-clock time or source text.
    const has = Set.prototype.has
    let comparisons = 0
    const spy = vi.spyOn(Set.prototype, 'has').mockImplementation(function (
      this: Set<unknown>,
      value
    ) {
      if (typeof value === 'string' && value.startsWith('10.1234/')) comparisons++
      return has.call(this, value)
    })
    let groups: ReturnType<typeof findLiteratureDuplicateGroups>
    try {
      groups = findLiteratureDuplicateGroups(candidates)
    } finally {
      spy.mockRestore()
    }
    expect(groups).toEqual([])
    return comparisons
  }
  const small = measure(500)
  const large = measure(1000)
  console.info('identity comparisons', { small, large })
  expect(large).toBeLessThan(Math.max(small * 2.5, 1000))
})

it('offers a lossless bounded export for an individually oversized reference', async () => {
  const client = createProjectDbClient(await directory())
  cleanup.push(() => client.$disconnect())
  await migrateApplicationDatabase(client)
  const catalog = new LiteratureCatalog(async () => client)
  const receipt = await catalog.transact({
    kind: 'create-item',
    item: literatureItemInputSchema.parse({
      itemType: 'journalArticle',
      title: 'Oversized reference',
      abstract: 'a'.repeat(10 * 1024 * 1024) + '😀'
    })
  })
  await expect(catalog.search({ scope: 'library' })).rejects.toThrow(
    'Literature reference exceeds the display budget: ' + receipt.id
  )
  const first = await catalog.exportRecord({ itemId: receipt.id })
  expect((await rpc('literature:export-record', async () => first)).status).toBe(200)
  const chunks = [first.chunk]
  let next = first.nextOffset
  while (next !== undefined) {
    const page = await catalog.exportRecord({
      itemId: receipt.id,
      offset: next,
      digest: first.digest
    })
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(2 * 1024 * 1024)
    chunks.push(page.chunk)
    next = page.nextOffset
  }
  const item = (await catalog.get(receipt.id))!
  expect(JSON.parse(chunks.join(''))).toEqual(item)
  await catalog.transact({
    kind: 'update-item',
    itemId: item.id,
    expectedMetadataRevision: item.metadataRevision,
    item: { ...item.item, title: 'Changed' }
  })
  await expect(
    catalog.exportRecord({ itemId: item.id, offset: first.nextOffset, digest: first.digest })
  ).rejects.toThrow('changed during export')
}, 60_000)

it.each([400, 1000])(
  'bounds logical checkpoint bytes for a %i-reference task',
  async (count) => {
    const fixture = await completedJob(count)
    console.info('checkpoint scale', { count, ...fixture.measured })
    expect(fixture.measured.bytes).toBeLessThan(count * 32 * 1024)
  },
  60_000
)

it('keeps a valid oversized reference available to workspace mentions', async () => {
  const { searchLiteratureMentionOptions } =
    await import('../../renderer/src/pages/workspace/literature-pdf-options')
  const client = createProjectDbClient(await directory())
  cleanup.push(() => client.$disconnect())
  await migrateApplicationDatabase(client)
  const catalog = new LiteratureCatalog(async () => client)
  const created = await catalog.transact({
    kind: 'create-item',
    item: literatureItemInputSchema.parse({
      itemType: 'journalArticle',
      title: 'Oversized mention reference',
      abstract: 'A'.repeat(10 * 1024 * 1024 + 1)
    })
  })
  vi.stubGlobal('window', {
    api: {
      literature: {
        exportRecord: (request: Parameters<LiteratureCatalog['exportRecord']>[0]) =>
          catalog.exportRecord(request),
        search: (request: Parameters<LiteratureCatalog['search']>[0]) => catalog.search(request)
      }
    }
  })
  try {
    const options = await searchLiteratureMentionOptions('Oversized mention reference')
    expect(options.map((option) => option.reference.itemId)).toEqual([created.id])
    expect(options[0].reference.item.abstract).toBe('A'.repeat(10 * 1024 * 1024 + 1))
  } finally {
    vi.unstubAllGlobals()
  }
})

it('counts matching oversized records without loading their metadata', async () => {
  const client = createProjectDbClient(await directory())
  cleanup.push(() => client.$disconnect())
  await migrateApplicationDatabase(client)
  const catalog = new LiteratureCatalog(async () => client)
  await catalog.transact({
    kind: 'create-item',
    item: literatureItemInputSchema.parse({
      itemType: 'journalArticle',
      title: 'Oversized count reference',
      abstract: 'A'.repeat(10 * 1024 * 1024 + 1)
    })
  })
  expect(
    await catalog.search({ scope: 'library', query: 'Oversized count reference', countOnly: true })
  ).toEqual({ entries: [], totalCount: 1 })
})

it('downloads complete metadata for an oversized reference retained in Trash', async () => {
  const client = createProjectDbClient(await directory())
  cleanup.push(() => client.$disconnect())
  await migrateApplicationDatabase(client)
  const catalog = new LiteratureCatalog(async () => client)
  const abstract = 'A'.repeat(10 * 1024 * 1024 + 1)
  const created = await catalog.transact({
    kind: 'create-item',
    item: literatureItemInputSchema.parse({
      itemType: 'journalArticle',
      title: 'Retained reference',
      abstract
    })
  })
  await catalog.transact({ kind: 'set-item-lifecycle', itemIds: [created.id], state: 'deleted' })
  await expect(catalog.search({ scope: 'library', lifecycle: 'deleted' })).rejects.toThrow(
    'display budget'
  )
  const chunks: string[] = []
  let offset = 0
  let digest: string | undefined
  for (;;) {
    const page = await catalog.exportRecord({ itemId: created.id, offset, digest })
    chunks.push(page.chunk)
    digest = page.digest
    if (page.nextOffset === undefined) break
    offset = page.nextOffset
  }
  const record = JSON.parse(chunks.join(''))
  expect(record.item.abstract).toBe(abstract)
  expect(record.deletedAt).toEqual(expect.any(Number))
  expect(await catalog.get(created.id)).toBeUndefined()
})
