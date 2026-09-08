import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile, readFile, stat, cp } from 'node:fs/promises'
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
): Promise<import('../../shared/literature-jobs').LiteratureJobView> {
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
  const checkpoint = join(`${path}.d`, first, 'task.json')
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
  const checkpoint = await readFile(join(directory, jobId, 'task.json'), 'utf8')
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
  expect(await readFile(join(directory, jobId, 'task.json'), 'utf8')).toBe(checkpoint)
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
    { getMetadataCommitReceipt: async () => null, get: async () => current, applyMetadata },
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
    // Finish the search checkpoint before injecting a command-only write failure.
    await jobs.close()
    if (action === 'resume') {
      const record = JSON.parse(await readFile(join(`${path}.d`, jobId, 'task.json'), 'utf8'))
      record.state = 'paused'
      await writeFile(join(`${path}.d`, jobId, 'task.json'), JSON.stringify(record))
    }
    jobs = new LiteratureBatchJobs(options)
    cleanup.push(() => jobs.close())
    const before = await state(jobs, jobId)
    // Block the real write destination, retaining all original files for restoration.
    const target = action === 'remove' ? path : join(`${path}.d`, jobId, 'task.json')
    const backup = `${target}.saved`
    await rename(target, backup)
    try {
      await mkdir(target)
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

it.each(['supplement', 'fullText'] as const)(
  'uses the attachment role when searching for full text beside a %s PDF',
  async (kind) => {
    const { jobs, options, fullText } = await setup()
    options.catalog.get = async (id) => ({
      ...item(id),
      attachments: [
        {
          id: 'attachment',
          kind,
          title: 'Supporting methods',
          sortOrder: 0,
          createdAt: 1,
          updatedAt: 1,
          versions: [
            {
              id: 'version',
              versionNumber: 1,
              filename: 'supporting-methods.pdf',
              contentType: 'application/pdf',
              sizeBytes: 10,
              checksum: 'a'.repeat(64),
              pageCount: 2,
              createdAt: 1
            }
          ]
        }
      ]
    })
    const jobId = randomUUID()
    await jobs.run({ action: 'create', mode: 'full-text', itemIds: ['a'], requestId: jobId })
    await vi.waitFor(async () =>
      expect(['review', 'completed']).toContain((await state(jobs, jobId)).state)
    )
    expect(fullText).toHaveBeenCalledTimes(kind === 'fullText' ? 0 : 1)
    expect((await state(jobs, jobId)).rows[0].status).toBe(
      kind === 'fullText' ? 'skipped' : 'ready'
    )
  }
)

it('still applies the selected full text when a supplement PDF appears after search', async () => {
  const { jobs, options, fullText } = await setup()
  const jobId = randomUUID()
  await jobs.run({ action: 'create', mode: 'full-text', itemIds: ['a'], requestId: jobId })
  await vi.waitFor(async () => expect((await state(jobs, jobId)).state).toBe('review'))
  const current = {
    ...item('a'),
    attachments: [
      {
        id: 'supplement',
        kind: 'supplement',
        title: 'Supporting methods',
        sortOrder: 0,
        createdAt: 1,
        updatedAt: 1,
        versions: [
          {
            id: 'version',
            versionNumber: 1,
            filename: 'supporting-methods.pdf',
            contentType: 'application/pdf',
            sizeBytes: 10,
            checksum: 'a'.repeat(64),
            pageCount: 2,
            createdAt: 1
          }
        ]
      }
    ]
  }
  options.catalog.get = async () => current
  fullText.mockImplementation(async (request) =>
    request.mode === 'attach'
      ? { mode: 'attach', item: current }
      : { mode: 'search', candidates: [source], notices: [] }
  )
  await jobs.run({ action: 'apply', jobId, selections: [{ itemId: 'a', candidateId: source.id }] })
  await vi.waitFor(async () => expect((await state(jobs, jobId)).state).toBe('completed'))
  expect(fullText).toHaveBeenCalledWith({ mode: 'attach', itemId: 'a', candidateId: source.id })
  expect((await state(jobs, jobId)).rows[0].status).toBe('done')
})

it('finishes an attachment from its committed receipt while item refresh is unavailable', async () => {
  const { jobs, fullText } = await setup()
  fullText.mockResolvedValue({ mode: 'search', candidates: [source], notices: [] })
  const jobId = randomUUID()
  await jobs.run({ action: 'create', mode: 'full-text', itemIds: ['a'], requestId: jobId })
  await vi.waitFor(async () => expect((await state(jobs, jobId)).state).toBe('review'))
  fullText.mockImplementation(async (request) =>
    request.mode === 'search'
      ? { mode: 'search', candidates: [source], notices: [] }
      : {
          mode: 'transfer',
          transfer: {
            id: 'task',
            itemId: 'a',
            candidate: source,
            status: 'succeeded',
            attachmentId: 'attachment',
            versionId: 'version'
          }
        }
  )
  await jobs.run({ action: 'apply', jobId, selections: [{ itemId: 'a', candidateId: source.id }] })
  await vi.waitFor(async () => expect((await state(jobs, jobId)).state).toBe('completed'))
  expect((await state(jobs, jobId)).rows[0].status).toBe('done')
})

it('keeps unsearched references resumable after applying a paused partial search', async () => {
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
  try {
    await jobs.run({ action: 'pause', jobId })
  } finally {
    release()
  }
  await vi.waitFor(async () => expect((await state(jobs, jobId)).state).toBe('paused'))
  expect((await state(jobs, jobId)).rows.map(({ status }) => status)).toEqual(['ready', 'pending'])
  await jobs.run({ action: 'apply', jobId, selections: [{ itemId: 'a' }] })
  await vi.waitFor(async () => {
    expect(['paused', 'completed']).toContain((await state(jobs, jobId)).state)
  })
  expect(options.metadata.applyReviewed).toHaveBeenCalledOnce()
  expect((await state(jobs, jobId)).rows.map(({ status }) => status)).toEqual(['done', 'pending'])
  expect((await jobs.run({ action: 'list' })).summaries?.[0]).toMatchObject({
    total: 2,
    checked: 1,
    done: 1,
    ready: 0,
    failed: 0
  })
  expect(await state(jobs, jobId)).toMatchObject({ state: 'paused', phase: 'search' })
  expect((await state(jobs, jobId)).rows[1].checked).toBe(true)
  await jobs.run({ action: 'resume', jobId })
  await vi.waitFor(async () => expect((await state(jobs, jobId)).state).toBe('review'))
  expect(metadata).toHaveBeenCalledTimes(2)
  expect(metadata).toHaveBeenLastCalledWith({ mode: 'preview', itemId: 'b' })
  expect((await state(jobs, jobId)).rows.map(({ status }) => status)).toEqual(['done', 'ready'])
})

it('reloads repaired checkpoints on the same service without dropping any indexed task', async () => {
  const { rename } = await import('node:fs/promises')
  const { jobs, options, path } = await setup()
  const first = randomUUID(),
    second = randomUUID()
  for (const jobId of [first, second]) {
    await jobs.run({ action: 'create', mode: 'metadata', itemIds: ['a'], requestId: jobId })
    await vi.waitFor(async () => expect((await state(jobs, jobId)).state).toBe('review'))
  }
  await jobs.close()
  const indexBefore = await readFile(path, 'utf8')
  const checkpoint = join(`${path}.d`, first, 'task.json')
  await rename(checkpoint, `${checkpoint}.saved`)
  const reopened = new LiteratureBatchJobs(options)
  cleanup.push(() => reopened.close())
  try {
    const blocked = await Promise.allSettled([
      reopened.run({ action: 'list' }),
      reopened.run({ action: 'get', jobId: second }),
      reopened.run({ action: 'remove', jobId: second })
    ])
    expect(blocked.map((result) => result.status)).toEqual(['rejected', 'rejected', 'rejected'])
    for (const result of blocked)
      if (result.status === 'rejected') expect(result.reason.message).toContain('checkpoint')
    expect(await readFile(path, 'utf8')).toBe(indexBefore)
  } finally {
    await rename(`${checkpoint}.saved`, checkpoint)
  }
  // Control: the original bytes are healthy and load in another instance.
  const fresh = new LiteratureBatchJobs(options)
  expect((await fresh.run({ action: 'list' })).summaries?.map(({ id }) => id)).toEqual([
    second,
    first
  ])
  await fresh.close()
  await expect(reopened.run({ action: 'list' })).resolves.toMatchObject({
    summaries: [{ id: second }, { id: first }]
  })
  expect((await state(reopened, second)).state).toBe('review')
  await reopened.run({ action: 'remove', jobId: second })
  expect((await reopened.run({ action: 'list' })).summaries?.map(({ id }) => id)).toEqual([first])
})

it('recognizes its committed metadata after replaying the pre-commit checkpoint', async () => {
  const { LiteratureCatalog } = await import('./catalog')
  const { LiteratureMetadataEnricher } = await import('./metadata-enricher')
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
  expect((await state(jobs, jobId)).rows[0]).toMatchObject({ status: 'done', message: undefined })
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
  expect(fetchMetadata).toHaveBeenCalledOnce()
})

it('restores a historically completed partial search without repeating completed metadata', async () => {
  const { jobs, options, path, metadata } = await setup()
  const jobId = randomUUID()
  await jobs.run({ action: 'create', mode: 'metadata', itemIds: ['a'], requestId: jobId })
  await vi.waitFor(async () => expect((await state(jobs, jobId)).state).toBe('review'))
  await jobs.close()
  const checkpoint = join(`${path}.d`, `${jobId}.json`)
  const stored = {
    id: jobId,
    mode: 'metadata',
    state: 'completed',
    phase: 'apply',
    phaseItemIds: ['a'],
    createdAt: 1,
    updatedAt: 2,
    rows: [
      { id: 'a', status: 'done', checked: true, item: item('a'), metadata: preview('a') },
      { id: 'b', status: 'pending', checked: true }
    ]
  }
  await writeFile(checkpoint, JSON.stringify(stored))
  await writeFile(path, JSON.stringify({ version: 2, jobIds: [jobId] }))
  const reopened = new LiteratureBatchJobs(options)
  cleanup.push(() => reopened.close())
  expect(await state(reopened, jobId)).toMatchObject({
    state: 'paused',
    phase: 'search',
    phaseItemIds: undefined
  })
  metadata.mockClear()
  await reopened.run({ action: 'resume', jobId })
  await vi.waitFor(async () => expect((await state(reopened, jobId)).state).toBe('review'))
  expect(metadata).toHaveBeenCalledExactlyOnceWith({ mode: 'preview', itemId: 'b' })
})

it.each(['missing', 'corrupt'] as const)(
  'removes a task with %s payloads without discarding other indexed tasks',
  async (damage) => {
    const { jobs, options, path } = await setup()
    const removed = randomUUID()
    const retained = randomUUID()
    for (const jobId of [removed, retained]) {
      await jobs.run({ action: 'create', mode: 'metadata', itemIds: ['a'], requestId: jobId })
      await vi.waitFor(async () => expect((await state(jobs, jobId)).state).toBe('review'))
    }
    await jobs.close()
    const directory = join(`${path}.d`, removed)
    const header = JSON.parse(await readFile(join(directory, 'task.json'), 'utf8'))
    const payload = join(directory, 'payloads', `${header.rows[0].payload}.json`)
    if (damage === 'missing') await rm(payload)
    else await writeFile(payload, '{invalid')
    const reopened = new LiteratureBatchJobs(options)
    cleanup.push(() => reopened.close())
    expect((await reopened.run({ action: 'list' })).summaries).toHaveLength(2)
    await expect(reopened.run({ action: 'get', jobId: removed })).rejects.toThrow()
    await expect(reopened.run({ action: 'remove', jobId: removed })).resolves.toEqual({ jobs: [] })
    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
    await reopened.close()
    const restored = new LiteratureBatchJobs(options)
    cleanup.push(() => restored.close())
    expect((await restored.run({ action: 'list' })).summaries?.map(({ id }) => id)).toEqual([
      retained
    ])
    expect((await state(restored, retained)).rows[0].status).toBe('ready')
  }
)

it('reads a bounded task page without loading later payloads or retaining full row snapshots', async () => {
  const { jobs, options, path, metadata } = await setup()
  metadata.mockImplementation(async ({ itemId }) => ({
    ...preview(itemId),
    filled: [{ field: 'journal', value: 'P'.repeat(6 * 1024 * 1024) }]
  }))
  const jobId = randomUUID()
  await jobs.run({ action: 'create', mode: 'metadata', itemIds: ['a', 'b', 'c'], requestId: jobId })
  await vi.waitFor(
    async () => expect((await jobs.run({ action: 'list' })).summaries?.[0].state).toBe('review'),
    { timeout: 5000 }
  )
  await jobs.close()
  const directory = join(`${path}.d`, jobId)
  const header = JSON.parse(await readFile(join(directory, 'task.json'), 'utf8'))
  await rm(join(directory, 'payloads', `${header.rows[2].payload}.json`))
  const reopened = new LiteratureBatchJobs(options)
  cleanup.push(() => reopened.close())
  const result = await reopened.run({ action: 'get', jobId })
  expect(result.jobs[0]).toMatchObject({
    rowOffset: 0,
    nextRowOffset: 1,
    totalRows: 3,
    rows: [{ id: 'a', metadata: { filled: [{ field: 'journal' }] } }]
  })
  expect(result.jobs[0].rows).toHaveLength(1)
  await expect(reopened.run({ action: 'get', jobId, rowOffset: 2 })).rejects.toThrow()
  // A read must not leave large payloads cached on the durable control rows.
  await rm(join(directory, 'payloads', `${header.rows[0].payload}.json`))
  await expect(reopened.run({ action: 'get', jobId })).rejects.toThrow()
})

it.each(['metadata', 'full-text'] as const)(
  'replays an accepted %s create request with complete review rows after restart',
  async (mode) => {
    const { jobs, options } = await setup()
    const request = { action: 'create' as const, mode, itemIds: ['a'], requestId: randomUUID() }
    await jobs.run(request)
    await vi.waitFor(async () =>
      expect((await state(jobs, request.requestId)).state).toBe('review')
    )
    const before = await state(jobs, request.requestId)
    await jobs.close()
    const reopened = new LiteratureBatchJobs(options)
    cleanup.push(() => reopened.close())
    expect((await reopened.run(request)).jobs).toEqual([before])
  }
)
