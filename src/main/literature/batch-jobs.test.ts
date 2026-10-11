import { discoveryJobOptions } from './discovery-adapters'
import { randomUUID } from 'node:crypto'

import { mkdtemp, rm, writeFile, readFile, cp } from 'node:fs/promises'

import { tmpdir } from 'node:os'

import { join } from 'node:path'

import { afterEach, expect, it, vi } from 'vitest'

import {
  literatureItemInputSchema,
  type LiteratureItemView,
  type LiteratureFullTextResult,
  type LiteratureMetadataCompletionResult
} from '../../shared/literature'

import { LiteratureBatchJobs } from '@aipoch/literature-discovery'

import { defaultFileDurability } from '@aipoch/durable-files'

import { waitForDataRootWriters } from '../storage/migration-state'

const item = (id: string): LiteratureItemView => ({
  id,
  metadataRevision: 1,
  createdAt: 1,
  updatedAt: 1,
  item: literatureItemInputSchema.parse({
    itemType: 'journalArticle',
    title: id,
    identifiers: [{ scheme: 'doi', value: '10.1234/example' }]
  }),
  attachments: [],
  collectionIds: [],
  projectIds: []
})

const preview = (id: string): LiteratureMetadataCompletionResult => ({
  mode: 'preview',
  reviewVersion: 2,
  proposal: item(id).item,
  sources: [
    {
      provider: 'crossref',
      sourceUrl: 'https://api.crossref.org/works/10.1234%2Fpaper',
      rawMetadata: {}
    }
  ],
  provider: 'crossref',
  sourceUrl: 'https://crossref.org',
  item: item(id),
  filled: [{ field: 'journal', value: 'Journal' }],
  conflicts: []
})

const source = {
  id: 'first-token',
  provider: 'pmc' as const,
  source: 'PMC',
  sourceUrl: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC1/',
  url: 'https://publisher.example/paper.pdf'
}

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function setup(): Promise<{
  path: string
  jobs: LiteratureBatchJobs
  options: ConstructorParameters<typeof LiteratureBatchJobs>[0]
  metadata: ReturnType<typeof vi.fn>
  fullText: ReturnType<typeof vi.fn>
}> {
  const directory = await mkdtemp(join(tmpdir(), 'literature-jobs-test-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const metadata = vi.fn(async ({ itemId }: { itemId: string }) => preview(itemId))
  const fullText = vi.fn(async (): Promise<LiteratureFullTextResult> => ({
    mode: 'search',
    candidates: [source],
    notices: []
  }))
  const options = {
    ...discoveryJobOptions,
    path: join(directory, 'jobs.json'),
    catalog: { get: async (id: string) => item(id) },
    metadata: {
      complete: metadata,
      applyReviewed: vi.fn(async (review: LiteratureMetadataCompletionResult) => {
        const current = await options.catalog.get(review.item.id)
        if (current.metadataRevision !== review.item.metadataRevision)
          throw new Error('Reference changed')
        return review
      })
    },
    fullText: { run: fullText },
    onError: vi.fn(),
    spacingMs: 0
  }
  const jobs = new LiteratureBatchJobs(options)
  cleanup.push(() => jobs.close())
  return { path: options.path, jobs, options, metadata, fullText }
}

async function state(
  jobs: LiteratureBatchJobs,
  jobId: string
): Promise<import('@aipoch/literature-discovery/jobs').LiteratureJobView> {
  return (await jobs.run({ action: 'get', jobId })).jobs[0]!
}

it('keeps a failed apply checkpoint in review and allows the same command to be retried', async () => {
  const { open, rename } = await import('node:fs/promises')
  const { jobs, path, options } = await setup()
  const jobId = randomUUID()
  const directory = `${path}.d`
  const backup = `${path}.saved`
  const header = join(directory, jobId, 'task.json')
  const checkpointEntered = Promise.withResolvers<void>()
  const releaseCheckpoint = Promise.withResolvers<void>()
  let checkpointOpen = false
  const syncFile = defaultFileDurability.syncFile
  const sync = vi.spyOn(defaultFileDurability, 'syncFile').mockImplementation(async (file) => {
    if (
      file.startsWith(`${header}.`) &&
      JSON.parse(await readFile(file, 'utf8')).state === 'review'
    ) {
      // Hold a real checkpoint handle; do not manufacture a Windows rename error.
      const handle = await open(file, 'r+')
      checkpointOpen = true
      checkpointEntered.resolve()
      try {
        await releaseCheckpoint.promise
        await syncFile(file)
      } finally {
        await handle.close()
        checkpointOpen = false
      }
    } else await syncFile(file)
  })
  vi.mocked(options.onError).mockImplementation(checkpointEntered.reject)
  try {
    await jobs.run({ action: 'create', mode: 'metadata', itemIds: ['a'], requestId: jobId })
    await checkpointEntered.promise
    const faultInjection = (async (): Promise<void> => {
      // Review can be visible while its checkpoint is open. Join before filesystem mutation.
      await waitForDataRootWriters()
      expect(checkpointOpen, 'checkpoint handle must close before directory rename').toBe(false)
      expect((await state(jobs, jobId)).state).toBe('review')
      const checkpoint = await readFile(header, 'utf8')
      await rename(directory, backup)
      try {
        await writeFile(directory, 'block checkpoint directory creation')
        await expect(
          jobs.run({ action: 'apply', jobId, selections: [{ itemId: 'a' }] })
        ).rejects.toThrow()
      } finally {
        await rm(directory, { force: true })
        await rename(backup, directory)
      }
      expect(await readFile(header, 'utf8')).toBe(checkpoint)
      expect(options.metadata.applyReviewed).not.toHaveBeenCalled()
      expect(await state(jobs, jobId)).toMatchObject({ state: 'review', phase: 'search' })
      await jobs.run({ action: 'apply', jobId, selections: [{ itemId: 'a' }] })
      await waitForDataRootWriters()
      expect(options.metadata.applyReviewed).toHaveBeenCalledOnce()
    })()
    releaseCheckpoint.resolve()
    await faultInjection
  } finally {
    releaseCheckpoint.resolve()
    try {
      await jobs.close()
    } finally {
      sync.mockRestore()
    }
  }
})

it('recognizes its committed metadata after replaying the pre-commit checkpoint', async () => {
  const { LiteratureCatalog } = await import('./catalog')
  const { LiteratureMetadataEnricher } = await import('@aipoch/literature-discovery')
  const { createProjectDbClient } = await import('../projects/prisma-client')
  const { migrateApplicationDatabase } = await import('../database/migration-service')
  const { jobs: initial, options, path } = await setup()
  await initial.close()
  const root = await mkdtemp(join(tmpdir(), 'literature-task-commit-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const client = createProjectDbClient(root)
  cleanup.push(() => client.$disconnect())
  await migrateApplicationDatabase(client)
  const catalog = new LiteratureCatalog(async () => client)
  const created = await catalog.transact({ kind: 'create-item', item: item('a').item })
  const original = (await catalog.get(created.id))!
  const fetchMetadata = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          message: {
            DOI: '10.1234/example',
            'container-title': ['Committed journal']
          }
        })
      )
  )
  const enricher = new LiteratureMetadataEnricher(catalog, fetchMetadata)
  const jobId = randomUUID()
  const checkpoint = join(`${path}.d`, jobId, 'task.json')
  const savedDirectory = `${path}.pre-commit`
  let beforeCommit = ''
  const serviceOptions = { ...options, catalog, metadata: enricher }
  const jobs = new LiteratureBatchJobs({
    ...discoveryJobOptions,
    ...serviceOptions,
    metadata: {
      complete: (request) => enricher.complete(request),
      applyReviewed: async (review) => {
        // The service has durably accepted apply, but has not yet committed catalog data.
        beforeCommit = await readFile(checkpoint, 'utf8')
        await cp(join(`${path}.d`, jobId), savedDirectory, { recursive: true })
        return enricher.applyReviewed(review)
      }
    }
  })
  cleanup.push(() => jobs.close())
  await jobs.run({ action: 'create', mode: 'metadata', itemIds: [created.id], requestId: jobId })
  await vi.waitFor(async () => expect((await state(jobs, jobId)).state).toBe('review'))
  await jobs.run({ action: 'apply', jobId, selections: [{ itemId: created.id }] })
  await vi.waitFor(async () => expect((await state(jobs, jobId)).state).toBe('completed'))
  expect((await state(jobs, jobId)).rows[0].status).toBe('done')
  expect((await state(jobs, jobId)).rows[0].message).toBeUndefined()
  await jobs.close()
  const committed = (await catalog.get(created.id))!
  expect(committed.item.containerTitle).toBe('Committed journal')
  expect(committed.metadataRevision).toBeGreaterThan(original.metadataRevision)
  expect(JSON.parse(beforeCommit)).toMatchObject({ state: 'running', phase: 'apply' })
  // Reconstruct only the crash window: catalog commit survived, task completion did not.
  await rm(join(`${path}.d`, jobId), { recursive: true, force: true })
  await cp(savedDirectory, join(`${path}.d`, jobId), { recursive: true })
  const reopened = new LiteratureBatchJobs(serviceOptions)
  cleanup.push(() => reopened.close())
  expect((await state(reopened, jobId)).state).toBe('paused')
  await reopened.run({ action: 'resume', jobId })
  await vi.waitFor(async () => expect((await state(reopened, jobId)).state).toBe('completed'))
  expect((await catalog.get(created.id))!.metadataRevision).toBe(committed.metadataRevision)
  expect((await catalog.get(created.id))!.item.containerTitle).toBe('Committed journal')
  expect.soft((await state(reopened, jobId)).rows[0]).toMatchObject({ status: 'done' })
  expect.soft((await reopened.run({ action: 'list' })).summaries?.[0]).toMatchObject({
    done: 1,
    failed: 0,
    completedItemIds: [created.id]
  })
  expect(fetchMetadata).toHaveBeenCalledTimes(2)
})
