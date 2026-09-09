import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createLiteratureLibraryMcpServer } from './library-mcp-server'
import { createLiteratureMcpServer } from './mcp-server'
import * as durableJson from '../storage/durable-json-file'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import {
  createApplicationCommandRouter,
  type ApplicationInvocation
} from '../application-command-router'
import { createElectronCallerContext } from '../caller-context'
import {
  beginMigration,
  endMigration,
  waitForDataRootWriters,
  withDataRootWrite
} from '../storage/migration-state'
import {
  literatureApplicationCommands,
  registerLiteratureApplicationCommands
} from './application-commands'
import { LiteratureCitationStyleLibrary } from './citation-style-library'
import { LiteratureBatchJobs } from './batch-jobs'
import { LiteratureFullTextIndex } from './full-text-index'
import { literatureItemInputSchema } from '../../shared/literature'

vi.mock('electron', () => ({ app: { getPath: () => '/home/user', isPackaged: true } }))
const roots: string[] = []
afterEach(async () => {
  endMigration()
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const directory = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'literature-migration-writers-'))
  roots.push(root)
  return root
}
const invocation = <Args extends readonly unknown[]>(args: Args): ApplicationInvocation<Args> => {
  const callerContext = createElectronCallerContext(7)
  return {
    args,
    callerContext,
    callerLease: {
      leaseId: callerContext.leaseId,
      generation: 1,
      signal: new AbortController().signal,
      isCurrent: () => true
    }
  }
}
const style = `<style xmlns="http://purl.org/net/xbiblio/csl" version="1.0" class="in-text"><info><title>Migration race</title><id>https://example.test/race</id></info><citation><layout><text variable="title"/></layout></citation><bibliography><layout><text variable="title"/></layout></bibliography></style>`

it('refuses a CSL import through the public command while a migration copy awaits commit', async () => {
  const library = new LiteratureCitationStyleLibrary(
    join(await directory(), 'literature', 'citation-styles')
  )
  const router = createApplicationCommandRouter()
  const installation = registerLiteratureApplicationCommands(router.registrar, {
    citationStyles: async (request) => {
      if (request.kind === 'import') await library.import(request.content)
      return { styles: await library.list() }
    }
  } as Parameters<typeof registerLiteratureApplicationCommands>[1])
  try {
    beginMigration()
    await expect(
      router.dispatcher.invoke(
        literatureApplicationCommands.citationStyles,
        invocation([{ kind: 'import', content: style }])
      )
    ).rejects.toThrow(/moving your data/i)
    expect((await library.list()).filter(({ source }) => source === 'custom')).toEqual([])
  } finally {
    installation.uninstall()
  }
})

it('drains a detached batch worker and pauses remaining rows before copying', async () => {
  let release!: () => void
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const fullText = vi.fn(async () => {
    await blocked
    return { mode: 'search' as const, candidates: [], notices: [] }
  })
  const path = join(await directory(), 'literature', 'batch-jobs.json')
  const jobs = new LiteratureBatchJobs({
    path,
    spacingMs: 0,
    catalog: {
      get: async (id) => ({
        id,
        metadataRevision: 1,
        createdAt: 1,
        updatedAt: 1,
        item: literatureItemInputSchema.parse({ itemType: 'journalArticle', title: id }),
        attachments: [],
        collectionIds: [],
        projectIds: []
      })
    },
    metadata: { complete: vi.fn(), applyReviewed: vi.fn() },
    fullText: { run: fullText },
    onError: vi.fn()
  })
  const id = randomUUID()
  try {
    await withDataRootWrite(() =>
      jobs.run({ action: 'create', requestId: id, mode: 'full-text', itemIds: ['a', 'b'] })
    )
    await vi.waitFor(() => expect(fullText).toHaveBeenCalledTimes(1))
    beginMigration()
    const drained = vi.fn()
    const drain = waitForDataRootWriters().then(drained)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(drained).not.toHaveBeenCalled()
    release()
    await drain
    expect(fullText).toHaveBeenCalledTimes(1)
    endMigration()
    const result = await jobs.run({ action: 'get', jobId: id })
    expect(result.jobs[0].state).toBe('paused')
    expect(result.jobs[0].rows[1].status).toBe('pending')
    const checkpoint = JSON.parse(await readFile(join(path + '.d', id, 'task.json'), 'utf8'))
    expect(checkpoint.state).toBe('paused')
    expect(checkpoint.rows[1].status).toBe('pending')
  } finally {
    release()
    await jobs.close()
  }
})

it('does not start or flush index maintenance while the migration gate is closed', async () => {
  const sweep = vi.spyOn(LiteratureFullTextIndex, 'sweepExpired').mockResolvedValue()
  const flush = vi.spyOn(LiteratureFullTextIndex, 'flushPendingAccesses').mockResolvedValue()
  beginMigration()
  const stop = LiteratureFullTextIndex.startRetentionSweep(await directory(), vi.fn())
  await stop()
  expect(sweep).not.toHaveBeenCalled()
  expect(flush).not.toHaveBeenCalled()
})

it('pauses an admitted task creation that finishes saving after migration starts', async () => {
  const path = join(await directory(), 'literature', 'batch-jobs.json')
  const write = durableJson.writeDurableJsonFile
  vi.spyOn(durableJson, 'writeDurableJsonFile').mockImplementation(async (...args) => {
    await write(...args)
    if (args[0] === path) beginMigration()
  })
  const fullText = vi.fn()
  const jobs = new LiteratureBatchJobs({
    path,
    catalog: { get: vi.fn() },
    fullText: { run: fullText },
    metadata: { complete: vi.fn(), applyReviewed: vi.fn() },
    onError: vi.fn()
  })
  try {
    const id = randomUUID()
    const result = await withDataRootWrite(() =>
      jobs.run({
        action: 'create',
        requestId: id,
        mode: 'full-text',
        itemIds: ['a']
      })
    )
    expect(result.jobs[0].state).toBe('paused')
    await waitForDataRootWriters()
    expect(fullText).not.toHaveBeenCalled()
    const checkpoint = JSON.parse(await readFile(join(path + '.d', id, 'task.json'), 'utf8'))
    expect(checkpoint.state).toBe('paused')
  } finally {
    await jobs.close()
  }
})

it('waits for admitted index maintenance before copying', async () => {
  let release!: () => void
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const sweep = vi.spyOn(LiteratureFullTextIndex, 'sweepExpired').mockImplementation(() => blocked)
  vi.spyOn(LiteratureFullTextIndex, 'flushPendingAccesses').mockResolvedValue()
  // Startup can itself run within an admitted writer's async context.
  const stop = await withDataRootWrite(async () =>
    LiteratureFullTextIndex.startRetentionSweep(await directory(), vi.fn())
  )
  try {
    await vi.waitFor(() => expect(sweep).toHaveBeenCalledOnce())
    beginMigration()
    const drained = vi.fn()
    const drain = waitForDataRootWriters().then(drained)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(drained).not.toHaveBeenCalled()
    release()
    await drain
  } finally {
    release()
    await stop()
  }
})

it.each(['acquire_pdf', 'read_document'] as const)(
  'protects direct Agent %s requests across migration admission and drain',
  async (name) => {
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    let first = true
    const handler = vi.fn(async () => {
      if (first) {
        first = false
        await blocked
      }
      return { status: 'pending-review' as const, candidateId: 'inbox-1', filename: 'paper.pdf' }
    })
    const server =
      name === 'read_document'
        ? createLiteratureMcpServer({ readDocument: handler })
        : createLiteratureLibraryMcpServer({
            searchLibrary: vi.fn(),
            readAbstract: vi.fn(),
            readPdf: vi.fn(),
            saveToInbox: vi.fn(),
            acquirePdf: handler
          })
    const client = new Client({ name: 'migration-writers-test', version: '1' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    const args =
      name === 'read_document'
        ? { documentId: 'a' }
        : {
            candidate: {
              item: literatureItemInputSchema.parse({ itemType: 'journalArticle', title: 'a' }),
              source: { provider: 'manual', rawMetadata: {} }
            }
          }
    try {
      const active = client.callTool({ name, arguments: args })
      await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce())
      beginMigration()
      const rejected = await client.callTool({ name, arguments: args })
      expect(rejected.isError).toBe(true)
      expect(JSON.stringify(rejected.content)).toMatch(/moving your data/i)
      expect(handler).toHaveBeenCalledOnce()
      const drained = vi.fn()
      const drain = waitForDataRootWriters().then(drained)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(drained).not.toHaveBeenCalled()
      release()
      expect((await active).isError).not.toBe(true)
      await drain
    } finally {
      release()
      await client.close()
      await server.close()
    }
  }
)

it('routes stored metadata sources through the validated application boundary', async () => {
  const router = createApplicationCommandRouter()
  const records = [
    { id: 'source', provider: 'crossref', savedAt: 123, rawMetadata: { title: 'Saved title' } }
  ]
  const sources = vi.fn().mockResolvedValue(records)
  const installation = registerLiteratureApplicationCommands(router.registrar, {
    sources
  } as unknown as Parameters<typeof registerLiteratureApplicationCommands>[1])
  try {
    await expect(
      router.dispatcher.invoke(literatureApplicationCommands.sources, invocation(['item-1']))
    ).resolves.toEqual(records)
    expect(sources).toHaveBeenCalledExactlyOnceWith('item-1')
    await expect(
      router.dispatcher.invoke(literatureApplicationCommands.sources, invocation(['']))
    ).rejects.toThrow()
    expect(sources).toHaveBeenCalledTimes(1)
    sources.mockResolvedValue([{ ...records[0], savedAt: 'invalid' }])
    await expect(
      router.dispatcher.invoke(literatureApplicationCommands.sources, invocation(['item-1']))
    ).rejects.toThrow()
  } finally {
    installation.uninstall()
  }
})
