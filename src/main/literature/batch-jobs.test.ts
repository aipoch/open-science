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
  reviewVersion: 1,
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

it.each(['pmc', 'arxiv'] as const)(
  'restores reviewed %s candidates and revalidates them before attachment',
  async (provider) => {
    const { jobs, options, fullText } = await setup()
    const candidate = {
      ...source,
      provider,
      ...(provider === 'arxiv'
        ? {
            source: 'arXiv',
            url: 'https://arxiv.org/pdf/2401.12345',
            sourceUrl: 'https://arxiv.org/abs/2401.12345'
          }
        : {})
    }
    fullText.mockResolvedValue({ mode: 'search', candidates: [candidate], notices: [] })
    const jobId = randomUUID()
    await jobs.run({ action: 'create', mode: 'full-text', itemIds: ['a'], requestId: jobId })
    await vi.waitFor(async () => expect((await state(jobs, jobId)).state).toBe('review'))
    await jobs.close()
    const reopened = new LiteratureBatchJobs(options)
    cleanup.push(() => reopened.close())
    expect((await state(reopened, jobId)).rows[0].candidates).toEqual([candidate])
    fullText.mockImplementation(async (request) =>
      request.mode === 'search'
        ? { mode: 'search', candidates: [{ ...candidate, id: 'fresh-token' }], notices: [] }
        : { mode: 'attach', item: item('a') }
    )
    await reopened.run({
      action: 'apply',
      jobId,
      selections: [{ itemId: 'a', candidateId: candidate.id }]
    })
    await vi.waitFor(async () => expect((await state(reopened, jobId)).state).toBe('completed'))
    expect(fullText).toHaveBeenLastCalledWith({
      mode: 'attach',
      itemId: 'a',
      candidateId: 'fresh-token'
    })
    expect((await state(reopened, jobId)).rows[0].status).toBe('done')
  }
)

it('keeps a failed apply checkpoint in review and allows the same command to be retried', async () => {
  const { rename } = await import('node:fs/promises')
  const { jobs, path, options } = await setup()
  const jobId = randomUUID()
  await jobs.run({ action: 'create', mode: 'metadata', itemIds: ['a'], requestId: jobId })
  await vi.waitFor(async () => expect((await state(jobs, jobId)).state).toBe('review'))
  const directory = `${path}.d`
  const backup = `${path}.saved`
  const checkpoint = await readFile(join(directory, `${jobId}.json`), 'utf8')
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
  expect(await readFile(join(directory, `${jobId}.json`), 'utf8')).toBe(checkpoint)
  expect(options.metadata.applyReviewed).not.toHaveBeenCalled()
  expect(await state(jobs, jobId)).toMatchObject({ state: 'review', phase: 'search' })
  await jobs.run({ action: 'apply', jobId, selections: [{ itemId: 'a' }] })
  await vi.waitFor(() => expect(options.metadata.applyReviewed).toHaveBeenCalledOnce())
})

it('offers identifier-only metadata additions as a ready batch row', async () => {
  const { LiteratureMetadataEnricher } = await import('./metadata-enricher')
  const { jobs: initial, options } = await setup()
  await initial.close()
  const current = item('a')
  current.item.url = 'https://pubmed.ncbi.nlm.nih.gov/12345678/'
  current.item.identifiers = [{ scheme: 'pmid', value: '12345678', isPrimary: true }]
  const applyMetadata = vi.fn(async (input) => ({ ...current, item: input.item }))
  const enricher = new LiteratureMetadataEnricher(
    { get: async () => current, applyMetadata },
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            result: {
              '12345678': {
                uid: '12345678',
                articleids: [
                  { idtype: 'doi', value: '10.2000/example' },
                  { idtype: 'pmc', value: 'PMC1234567' }
                ]
              }
            }
          })
        )
    )
  )
  const jobs = new LiteratureBatchJobs({
    ...options,
    catalog: { get: async () => current },
    metadata: enricher
  })
  cleanup.push(() => jobs.close())
  const jobId = randomUUID()
  await jobs.run({ action: 'create', mode: 'metadata', itemIds: ['a'], requestId: jobId })
  await vi.waitFor(async () =>
    expect(['review', 'completed']).toContain((await state(jobs, jobId)).state)
  )
  expect((await state(jobs, jobId)).rows[0]!.status).toBe('ready')
  await jobs.run({ action: 'apply', jobId, selections: [{ itemId: 'a' }] })
  await vi.waitFor(() => expect(applyMetadata).toHaveBeenCalledOnce())
  expect(applyMetadata.mock.calls[0]![0].item.identifiers).toHaveLength(3)
})

it.each(['review', 'retry', 'resume', 'remove'] as const)(
  'preserves accepted task state when %s cannot be persisted',
  async (action) => {
    const { rename, mkdir } = await import('node:fs/promises')
    const setupResult = await setup()
    const { path, options } = setupResult
    let jobs = setupResult.jobs
    const jobId = randomUUID()
    await jobs.run({ action: 'create', mode: 'metadata', itemIds: ['a'], requestId: jobId })
    await vi.waitFor(async () => expect((await state(jobs, jobId)).state).toBe('review'))
    if (action === 'resume') {
      await jobs.close()
      const record = JSON.parse(await readFile(join(`${path}.d`, `${jobId}.json`), 'utf8'))
      record.state = 'paused'
      await writeFile(join(`${path}.d`, `${jobId}.json`), JSON.stringify(record))
      jobs = new LiteratureBatchJobs(options)
      cleanup.push(() => jobs.close())
    }
    const before = await state(jobs, jobId)
    // Block the real write destination, retaining all original files for restoration.
    const target = action === 'remove' ? path : `${path}.d`
    const backup = `${target}.saved`
    await rename(target, backup)
    try {
      if (action === 'remove') await mkdir(target)
      else await writeFile(target, 'unavailable directory')
      await expect(
        jobs.run(
          action === 'review'
            ? { action, jobId, selections: [{ itemId: 'a', checked: false }] }
            : { action, jobId }
        )
      ).rejects.toThrow()
      expect(await state(jobs, jobId)).toEqual(before)
    } finally {
      await rm(target, { force: true, recursive: true })
      await rename(backup, target)
    }
    await jobs.run(
      action === 'review'
        ? { action, jobId, selections: [{ itemId: 'a', checked: false }] }
        : { action, jobId }
    )
    if (action === 'remove') expect((await jobs.run({ action: 'list' })).summaries).toEqual([])
    else if (action === 'review') expect((await state(jobs, jobId)).rows[0]!.checked).toBe(false)
    else await vi.waitFor(async () => expect((await state(jobs, jobId)).state).toBe('review'))
  }
)

it('does not pause an active worker when the pause checkpoint fails', async () => {
  const { rename } = await import('node:fs/promises')
  const { jobs, path, metadata } = await setup()
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
  const target = `${path}.d`
  await rename(target, `${target}.saved`)
  try {
    await writeFile(target, 'unavailable directory')
    await expect(jobs.run({ action: 'pause', jobId })).rejects.toThrow()
    expect((await state(jobs, jobId)).state).toBe('running')
  } finally {
    await rm(target, { force: true })
    await rename(`${target}.saved`, target)
    release()
  }
  await vi.waitFor(async () => expect((await state(jobs, jobId)).state).toBe('review'))
  expect(metadata).toHaveBeenCalledTimes(2)
})

it('marks a persisted legacy review for a fresh search without applying it', async () => {
  const { jobs, metadata, options } = await setup()
  metadata.mockImplementation(async ({ itemId }) => {
    const old = preview(itemId)
    delete old.reviewVersion
    return old
  })
  const jobId = randomUUID()
  await jobs.run({ action: 'create', mode: 'metadata', itemIds: ['a'], requestId: jobId })
  await vi.waitFor(async () => expect((await state(jobs, jobId)).state).toBe('review'))
  await jobs.close()
  const reopened = new LiteratureBatchJobs(options)
  cleanup.push(() => reopened.close())
  await reopened.run({ action: 'apply', jobId, selections: [{ itemId: 'a' }] })
  await vi.waitFor(async () => expect((await state(reopened, jobId)).state).toBe('completed'))
  expect(options.metadata.applyReviewed).not.toHaveBeenCalled()
  expect((await state(reopened, jobId)).rows[0]).toMatchObject({
    status: 'error',
    message: 'Search again to refresh this older metadata review.'
  })
})
