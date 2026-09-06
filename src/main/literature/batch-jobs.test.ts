import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  literatureItemInputSchema,
  type LiteratureItemView,
  type LiteratureFullTextResult,
  type LiteratureMetadataCompletionResult
} from '../../shared/literature'
import { LiteratureBatchJobs } from './batch-jobs'

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
    path: join(directory, 'jobs.json'),
    catalog: { get: async (id: string) => item(id) },
    metadata: {
      complete: metadata,
      applyReviewed: vi.fn(async (review: LiteratureMetadataCompletionResult) => review)
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
): Promise<import('../../shared/literature-jobs').LiteratureJob> {
  return (await jobs.run({ action: 'get', jobId })).jobs[0]!
}

it('runs once across repeated create requests, persists review and never applies without selection', async () => {
  const { jobs, metadata, options } = await setup()
  const request = {
    action: 'create' as const,
    mode: 'metadata' as const,
    itemIds: ['a', 'b'],
    requestId: randomUUID()
  }
  await Promise.all([jobs.run(request), jobs.run(request)])
  await vi.waitFor(async () => expect((await state(jobs, request.requestId)).state).toBe('review'))
  expect(metadata).toHaveBeenCalledTimes(2)
  expect(metadata.mock.calls.every(([request]) => request.mode === 'preview')).toBe(true)
  await jobs.close()
  const reopened = new LiteratureBatchJobs(options)
  cleanup.push(() => reopened.close())
  expect((await state(reopened, request.requestId)).rows.map(({ status }) => status)).toEqual([
    'ready',
    'ready'
  ])
  await reopened.run({ action: 'apply', jobId: request.requestId, selections: [{ itemId: 'b' }] })
  await vi.waitFor(async () =>
    expect((await state(reopened, request.requestId)).state).toBe('completed')
  )
  expect(options.metadata.applyReviewed).toHaveBeenCalledWith(preview('b'))
  expect(metadata).toHaveBeenCalledTimes(2)
  expect((await state(reopened, request.requestId)).rows.map(({ status }) => status)).toEqual([
    'ready',
    'done'
  ])
})

it('pauses after the current reference and resumes only unfinished rows after reopening', async () => {
  const { jobs, metadata, options } = await setup()
  let release!: () => void
  metadata.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      release = resolve
    })
    return preview('a')
  })
  const jobId = randomUUID()
  await jobs.run({ action: 'create', mode: 'metadata', itemIds: ['a', 'b'], requestId: jobId })
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  await jobs.run({ action: 'pause', jobId })
  release()
  await vi.waitFor(async () => expect((await state(jobs, jobId)).state).toBe('paused'))
  expect(metadata).toHaveBeenCalledTimes(1)
  await jobs.close()
  const reopened = new LiteratureBatchJobs(options)
  cleanup.push(() => reopened.close())
  expect((await state(reopened, jobId)).state).toBe('paused')
  expect(metadata).toHaveBeenCalledTimes(1)
  await reopened.run({ action: 'resume', jobId })
  await vi.waitFor(async () => expect((await state(reopened, jobId)).state).toBe('review'))
  expect(metadata).toHaveBeenCalledTimes(2)
  expect(metadata).toHaveBeenLastCalledWith({ mode: 'preview', itemId: 'b' })
})

it('refreshes a PDF token but refuses a different source after a paused task resumes', async () => {
  const { jobs, fullText } = await setup()
  const jobId = randomUUID()
  await jobs.run({ action: 'create', mode: 'full-text', itemIds: ['a'], requestId: jobId })
  await vi.waitFor(async () => expect((await state(jobs, jobId)).state).toBe('review'))
  fullText.mockResolvedValue({
    mode: 'search',
    candidates: [{ ...source, id: 'new-token', url: 'https://publisher.example/different.pdf' }],
    notices: []
  })
  await jobs.run({ action: 'apply', jobId, selections: [{ itemId: 'a', candidateId: source.id }] })
  await vi.waitFor(async () => expect((await state(jobs, jobId)).state).toBe('completed'))
  expect((await state(jobs, jobId)).rows[0]).toMatchObject({
    status: 'error',
    message: 'The selected source changed. Search again and review the results.'
  })
  expect(fullText.mock.calls.every(([request]) => request.mode !== 'attach')).toBe(true)
})

it('recovers an interrupted journal without auto-running or repeating completed rows', async () => {
  const { jobs, path, options, metadata } = await setup()
  await jobs.close()
  const id = randomUUID()
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      jobs: [
        {
          id,
          mode: 'metadata',
          phase: 'search',
          state: 'running',
          createdAt: 1,
          updatedAt: 1,
          rows: [
            { id: 'a', status: 'done', checked: true, item: item('a') },
            { id: 'b', status: 'searching', checked: true }
          ]
        }
      ]
    })
  )
  const reopened = new LiteratureBatchJobs(options)
  cleanup.push(() => reopened.close())
  expect((await state(reopened, id)).rows.map(({ status }) => status)).toEqual(['done', 'pending'])
  expect((await state(reopened, id)).state).toBe('paused')
  expect(metadata).not.toHaveBeenCalled()
  await reopened.run({ action: 'resume', jobId: id })
  await vi.waitFor(async () => expect((await state(reopened, id)).state).toBe('review'))
  expect(metadata).toHaveBeenCalledTimes(1)
  expect(metadata).toHaveBeenCalledWith({ mode: 'preview', itemId: 'b' })
})

it('rejects changed revisions and does not retry completed references', async () => {
  const { jobs, metadata, options } = await setup()
  const jobId = randomUUID()
  await jobs.run({ action: 'create', mode: 'metadata', itemIds: ['a', 'b'], requestId: jobId })
  await vi.waitFor(async () => expect((await state(jobs, jobId)).state).toBe('review'))
  options.catalog.get = async (id) => ({ ...item(id), metadataRevision: id === 'a' ? 2 : 1 })
  await jobs.run({ action: 'apply', jobId, selections: [{ itemId: 'a' }, { itemId: 'b' }] })
  await vi.waitFor(async () => expect((await state(jobs, jobId)).state).toBe('completed'))
  expect((await state(jobs, jobId)).rows.map(({ status }) => status)).toEqual(['error', 'done'])
  metadata.mockClear()
  await jobs.run({ action: 'retry', jobId })
  await vi.waitFor(async () => expect((await state(jobs, jobId)).state).toBe('review'))
  expect(metadata).toHaveBeenCalledTimes(1)
  expect(metadata).toHaveBeenCalledWith({ mode: 'preview', itemId: 'a' })
})

it('persists review choices and writes only the changed task checkpoint', async () => {
  const { jobs, path, options } = await setup()
  const first = randomUUID(),
    second = randomUUID()
  for (const id of [first, second]) {
    await jobs.run({ action: 'create', mode: 'full-text', itemIds: ['a'], requestId: id })
    await vi.waitFor(async () => expect((await state(jobs, id)).state).toBe('review'))
  }
  const checkpoint = join(`${path}.d`, `${first}.json`)
  const before = await stat(checkpoint)
  const indexBefore = await readFile(path, 'utf8')
  await jobs.run({
    action: 'review',
    jobId: second,
    selections: [{ itemId: 'a', checked: false, candidateId: source.id }]
  })
  expect((await stat(checkpoint)).mtimeMs).toBe(before.mtimeMs)
  expect(await readFile(path, 'utf8')).toBe(indexBefore)
  await jobs.close()
  const reopened = new LiteratureBatchJobs(options)
  cleanup.push(() => reopened.close())
  expect((await state(reopened, second)).rows[0]).toMatchObject({
    checked: false,
    candidateId: source.id
  })
  const snapshot = await state(reopened, second)
  expect(
    (await reopened.run({ action: 'get', jobId: second, ifUpdatedAt: snapshot.updatedAt })).jobs
  ).toEqual([])
})

it('distinguishes queued work and counts only selected apply rows', async () => {
  const { jobs, metadata, options } = await setup()
  let release!: () => void
  metadata.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      release = resolve
    })
    return preview('a')
  })
  const first = randomUUID(),
    second = randomUUID()
  await jobs.run({ action: 'create', mode: 'metadata', itemIds: ['a'], requestId: first })
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  await jobs.run({ action: 'create', mode: 'metadata', itemIds: ['a', 'b'], requestId: second })
  expect((await state(jobs, second)).state).toBe('queued')
  release()
  await vi.waitFor(async () => expect((await state(jobs, second)).state).toBe('review'))
  await jobs.run({ action: 'apply', jobId: second, selections: [{ itemId: 'b' }] })
  await vi.waitFor(async () => expect((await state(jobs, second)).state).toBe('completed'))
  expect(
    (await jobs.run({ action: 'list' })).summaries?.find((job) => job.id === second)
  ).toMatchObject({ processed: 1, phaseTotal: 1 })
  expect(options.metadata.applyReviewed).toHaveBeenCalledTimes(1)
})

it('discards delayed download progress after its attachment finishes', async () => {
  const { jobs, fullText } = await setup()
  let finishAttachment!: () => void
  let finishProgress!: () => void
  fullText.mockImplementation(async (request) => {
    if (request.mode === 'search') return { mode: 'search', candidates: [source], notices: [] }
    if (request.mode === 'attach')
      return new Promise<LiteratureFullTextResult>((resolve) => {
        finishAttachment = () => resolve({ mode: 'attach', item: item('a') })
      })
    return new Promise<LiteratureFullTextResult>((resolve) => {
      finishProgress = () =>
        resolve({
          mode: 'progress',
          progress: { receivedBytes: 100, bytesPerSecond: 10, phase: 'downloading' }
        })
    })
  })
  const jobId = randomUUID()
  await jobs.run({ action: 'create', mode: 'full-text', itemIds: ['a'], requestId: jobId })
  await vi.waitFor(async () => expect((await state(jobs, jobId)).state).toBe('review'))
  await jobs.run({ action: 'apply', jobId, selections: [{ itemId: 'a', candidateId: source.id }] })
  await vi.waitFor(() => expect(finishAttachment).toBeTypeOf('function'))
  const pendingProgress = jobs.run({ action: 'get', jobId })
  await vi.waitFor(() => expect(finishProgress).toBeTypeOf('function'))
  finishAttachment()
  await vi.waitFor(async () =>
    expect((await jobs.run({ action: 'list' })).summaries?.[0].state).toBe('completed')
  )
  finishProgress()
  await expect(pendingProgress).resolves.toMatchObject({ progress: undefined })
})

it('recounts a resumed apply phase after changing its remaining selections', async () => {
  const { jobs, options } = await setup()
  const applyReviewed = vi.mocked(options.metadata.applyReviewed)
  let finishFirst!: () => void
  applyReviewed.mockImplementationOnce(
    async (review) =>
      new Promise<LiteratureMetadataCompletionResult>((resolve) => {
        finishFirst = () => resolve(review)
      })
  )
  const jobId = randomUUID()
  await jobs.run({ action: 'create', mode: 'metadata', itemIds: ['a', 'b', 'c'], requestId: jobId })
  await vi.waitFor(async () => expect((await state(jobs, jobId)).state).toBe('review'))
  await jobs.run({ action: 'apply', jobId, selections: [{ itemId: 'a' }, { itemId: 'b' }] })
  await vi.waitFor(() => expect(finishFirst).toBeTypeOf('function'))
  await jobs.run({ action: 'pause', jobId })
  finishFirst()
  await vi.waitFor(async () => expect((await state(jobs, jobId)).state).toBe('paused'))
  await jobs.run({
    action: 'review',
    jobId,
    selections: [
      { itemId: 'b', checked: false },
      { itemId: 'c', checked: true }
    ]
  })
  await jobs.run({ action: 'resume', jobId })
  await vi.waitFor(async () => expect((await state(jobs, jobId)).state).toBe('completed'))
  expect((await state(jobs, jobId)).phaseItemIds).toEqual(['a', 'c'])
  expect((await jobs.run({ action: 'list' })).summaries?.[0]).toMatchObject({
    processed: 2,
    phaseTotal: 2
  })
  expect(applyReviewed.mock.calls.map(([review]) => review.item.id)).toEqual(['a', 'c'])
})

it('preserves completed apply counts when resuming older checkpoints without phase item IDs', async () => {
  const { jobs, path } = await setup()
  const jobId = randomUUID()
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      jobs: [
        {
          id: jobId,
          mode: 'metadata',
          phase: 'apply',
          state: 'paused',
          createdAt: 1,
          updatedAt: 1,
          rows: [
            { id: 'a', status: 'done', checked: true, item: item('a') },
            { id: 'b', status: 'ready', checked: true, item: item('b'), metadata: preview('b') }
          ]
        }
      ]
    })
  )
  await jobs.run({ action: 'resume', jobId })
  await vi.waitFor(async () => expect((await state(jobs, jobId)).state).toBe('completed'))
  expect((await state(jobs, jobId)).phaseItemIds).toEqual(['a', 'b'])
  expect((await jobs.run({ action: 'list' })).summaries?.[0]).toMatchObject({
    processed: 2,
    phaseTotal: 2
  })
})
