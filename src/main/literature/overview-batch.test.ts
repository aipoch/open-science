import * as durableFiles from '@aipoch/durable-files'
import { literatureItemInputSchema } from '@aipoch/literature-library/item'
import { LiteratureOverviewService, LiteratureOverviewStore } from './overview'
import { literatureOverviewSource } from '../../shared/literature-overview'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi, type Mock } from 'vitest'
import { LiteratureOverviewBatch } from './overview-batch'
import { createApplicationCommandRouter } from '../application-command-router'
import { createWebCallerContext } from '../caller-context'
import { ApplicationCallerLeaseRegistry } from '../caller-lifecycle'
import { waitForDataRootWriters } from '../storage/migration-state'
import {
  literatureApplicationCommands,
  registerLiteratureApplicationCommands
} from './application-commands'
import { createLiteratureCommandOwner } from './command-owner'
import {
  overviewBatchSchema,
  type OverviewBatch,
  type OverviewBatchRequest
} from '../../shared/literature-overview-batch'
import type {
  LiteratureOverviewRequest,
  LiteratureOverviewResult
} from '../../shared/literature-overview'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const entries = ['a', 'b'].map((itemId) => ({ itemId, expectedSourceKey: itemId, language: 'en' }))
const ready = (sourceKey: string): LiteratureOverviewResult => ({
  sourceKey,
  model: 'test',
  coverage: 'abstract',
  sections: { question: null, population: null, methods: null, results: null, limitations: null }
})
async function setup(): Promise<{
  path: string
  run: Mock<(request: LiteratureOverviewRequest) => Promise<LiteratureOverviewResult>>
  batch: LiteratureOverviewBatch
}> {
  const root = await mkdtemp(join(tmpdir(), 'overview-batch-'))
  roots.push(root)
  const path = join(root, 'task.json')
  const run = vi.fn(
    async (request: LiteratureOverviewRequest): Promise<LiteratureOverviewResult> =>
      request.mode === 'read'
        ? { sourceKey: request.expectedSourceKey, issue: 'not-generated' }
        : ready(request.expectedSourceKey)
  )
  return { path, run, batch: new LiteratureOverviewBatch(() => path, { run }) }
}
async function readDisk(path: string): Promise<OverviewBatch> {
  return overviewBatchSchema.parse(JSON.parse(await readFile(path, 'utf8')))
}
function deferredOverviews(run: Awaited<ReturnType<typeof setup>>['run']): {
  gates: Map<string, ReturnType<typeof Promise.withResolvers<LiteratureOverviewResult>>>
  generated: string[]
} {
  const gates = new Map<
    string,
    ReturnType<typeof Promise.withResolvers<LiteratureOverviewResult>>
  >()
  const generated: string[] = []
  run.mockImplementation(async (request) => {
    if (request.mode === 'read')
      return { sourceKey: request.expectedSourceKey, issue: 'not-generated' }
    generated.push(request.itemId)
    const gate = Promise.withResolvers<LiteratureOverviewResult>()
    gates.set(request.itemId, gate)
    return gate.promise
  })
  return { gates, generated }
}
const threeEntries = [...entries, { itemId: 'c', expectedSourceKey: 'c', language: 'en' }]

it('admits exactly two papers per advance and durably saves each without filling its slot', async () => {
  const { batch, path, run } = await setup()
  const { gates, generated } = deferredOverviews(run)
  const job = (await batch.run({ action: 'start', entries: threeEntries }))!
  const wave = batch.run({ action: 'advance', jobId: job.id })
  try {
    await vi.waitFor(() => expect(generated).toEqual(['a', 'b']))
    const active = (await batch.run({ action: 'read' }))!
    expect(active.rows.map((row) => row.status)).toEqual(['running', 'running', 'pending'])
    expect((await readDisk(path)).rows.map((row) => row.status)).toEqual([
      'running',
      'running',
      'pending'
    ])
    gates.get('a')!.resolve(ready('a'))
    await vi.waitFor(async () => {
      const disk = await readDisk(path)
      expect(disk.rows.map((row) => row.status)).toEqual(['succeeded', 'running', 'pending'])
    })
    expect(generated).toEqual(['a', 'b'])
    gates.get('b')!.resolve(ready('b'))
    const firstWave = (await wave)!
    expect(firstWave.rows.map((row) => row.status)).toEqual(['succeeded', 'succeeded', 'pending'])
    expect(generated).toEqual(['a', 'b'])
    run.mockImplementation(async (request) =>
      request.mode === 'read'
        ? { sourceKey: request.expectedSourceKey, issue: 'not-generated' }
        : ready(request.expectedSourceKey)
    )
    const finished = (await batch.run({ action: 'advance', jobId: job.id }))!
    expect(finished.rows.map((row) => row.status)).toEqual(['succeeded', 'succeeded', 'succeeded'])
    expect(
      run.mock.calls
        .filter(([request]) => request.mode === 'generate')
        .map(([request]) => request.itemId)
    ).toEqual(['a', 'b', 'c'])
  } finally {
    for (const [id, gate] of gates) gate.resolve(ready(id))
    await wave
  }
})

it.each(['throw', 'issue'] as const)(
  'pauses on %s failure, lets its admitted companion save, and retries with pending papers',
  async (failure) => {
    const { batch, path, run } = await setup()
    const { gates, generated } = deferredOverviews(run)
    const job = (await batch.run({ action: 'start', entries: threeEntries }))!
    const wave = batch.run({ action: 'advance', jobId: job.id })
    try {
      await vi.waitFor(() => expect(generated).toEqual(['a', 'b']))
      if (failure === 'throw') gates.get('a')!.reject(new Error('Provider unavailable'))
      else gates.get('a')!.resolve({ sourceKey: 'a', issue: 'source-changed' })
      await vi.waitFor(async () => {
        const disk = await readDisk(path)
        expect(disk.paused).toBe(true)
        expect(disk.rows.map((row) => row.status)).toEqual(['failed', 'running', 'pending'])
      })
      const observing = (await batch.run({ action: 'read' }))!
      expect(observing.rows[1].status).toBe('running')
      expect(generated).toEqual(['a', 'b'])
      gates.get('b')!.resolve(ready('b'))
      const paused = (await wave)!
      expect(paused.rows.map((row) => row.status)).toEqual(['failed', 'succeeded', 'pending'])
      expect(paused.paused).toBe(true)
      expect(await batch.run({ action: 'advance', jobId: job.id })).toEqual(paused)
      expect(generated).toEqual(['a', 'b'])
      const retry = (await batch.run({ action: 'retry', jobId: job.id }))!
      expect(retry.paused).toBe(false)
      expect(retry.rows.map((row) => row.status)).toEqual(['pending', 'succeeded', 'pending'])
      expect(retry.rows[0].issue).toBeUndefined()
      run.mockImplementation(async (request) =>
        request.mode === 'read'
          ? { sourceKey: request.expectedSourceKey, issue: 'not-generated' }
          : ready(request.expectedSourceKey)
      )
      const finished = (await batch.run({ action: 'advance', jobId: job.id }))!
      expect(finished.rows.map((row) => row.status)).toEqual([
        'succeeded',
        'succeeded',
        'succeeded'
      ])
      expect(
        run.mock.calls
          .filter(([request]) => request.mode === 'generate')
          .map(([request]) => request.itemId)
      ).toEqual(['a', 'b', 'a', 'c'])
    } finally {
      for (const [id, gate] of gates) gate.resolve(ready(id))
      await wave
    }
  }
)

it('recovers both interrupted papers as pending and stays paused until resume', async () => {
  const { batch, path, run } = await setup()
  const job = (await batch.run({ action: 'start', entries: threeEntries }))!
  job.rows[0].status = 'running'
  job.rows[1].status = 'running'
  await writeFile(path, JSON.stringify(job))
  const reopened = new LiteratureOverviewBatch(() => path, { run })
  const recovered = (await reopened.run({ action: 'read' }))!
  expect(recovered.paused).toBe(true)
  expect(recovered.rows.map((row) => row.status)).toEqual(['pending', 'pending', 'pending'])
  expect(await readDisk(path)).toEqual(recovered)
  expect(await reopened.run({ action: 'advance', jobId: job.id })).toEqual(recovered)
  expect(run.mock.calls.every(([request]) => request.mode === 'read')).toBe(true)
  await reopened.run({ action: 'resume', jobId: job.id })
  const result = (await reopened.run({ action: 'advance', jobId: job.id }))!
  expect(result.rows.map((row) => row.status)).toEqual(['succeeded', 'succeeded', 'pending'])
})

it('pauses after abort and retains a companion already completed in that wave', async () => {
  const { batch, run } = await setup()
  const { gates, generated } = deferredOverviews(run)
  const job = (await batch.run({ action: 'start', entries }))!
  const controller = new AbortController()
  const wave = batch.run({ action: 'advance', jobId: job.id }, controller.signal)
  try {
    await vi.waitFor(() => expect(generated).toEqual(['a', 'b']))
    gates.get('a')!.resolve(ready('a'))
    await vi.waitFor(async () =>
      expect((await batch.run({ action: 'read' }))!.rows[0].status).toBe('succeeded')
    )
    controller.abort()
    gates.get('b')!.reject(new Error('stopped'))
    const paused = (await wave)!
    expect(paused.paused).toBe(true)
    expect(paused.rows.map((row) => row.status)).toEqual(['succeeded', 'pending'])
  } finally {
    for (const [id, gate] of gates) gate.resolve(ready(id))
    await wave
  }
})
it('rejects duplicates, oversize batches and stale job commands', async () => {
  const { batch, path, run } = await setup()
  await expect(batch.run({ action: 'start', entries: [entries[0], entries[0]] })).rejects.toThrow(
    'Duplicate'
  )
  const oversized = Array.from({ length: 6 }, (_, index) => ({
    itemId: `item-${index}`,
    expectedSourceKey: `source-${index}`,
    language: 'en'
  }))
  await expect(batch.run({ action: 'start', entries: oversized })).rejects.toThrow()
  expect(run).not.toHaveBeenCalled()
  await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  const job = (await batch.run({ action: 'start', entries }))!
  await expect(batch.run({ action: 'start', entries })).rejects.toThrow('existing')
  await expect(
    batch.run({ action: 'advance', jobId: '00000000-0000-4000-8000-000000000000' })
  ).rejects.toThrow('changed')
  await batch.run({ action: 'pause', jobId: job.id })
  expect((await batch.run({ action: 'advance', jobId: job.id }))?.rows[0].status).toBe('pending')
})
it('allows read-only observation while rejecting every mutation during an active wave', async () => {
  const { batch, path, run } = await setup()
  const { gates, generated } = deferredOverviews(run)
  const job = (await batch.run({ action: 'start', entries: threeEntries }))!
  const wave = batch.run({ action: 'advance', jobId: job.id })
  try {
    await vi.waitFor(() => expect(generated).toEqual(['a', 'b']))
    const checkpoint = await readFile(path, 'utf8')
    for (const action of ['advance', 'pause', 'resume', 'retry'] as const)
      await expect(batch.run({ action, jobId: job.id })).rejects.toThrow('busy')
    await expect(batch.run({ action: 'start', entries })).rejects.toThrow('busy')
    run.mockClear()
    const observed = (await batch.run({ action: 'read' }))!
    expect(observed.rows.map((row) => row.status)).toEqual(['running', 'running', 'pending'])
    expect(await readFile(path, 'utf8')).toBe(checkpoint)
    expect(run).not.toHaveBeenCalled()
  } finally {
    for (const [id, gate] of gates) gate.resolve(ready(id))
    await wave
  }
})
async function setupDurableOverview(itemIds = ['a']): Promise<{
  path: string
  request: LiteratureOverviewRequest
  requests: LiteratureOverviewRequest[]
  infer: Mock<ConstructorParameters<typeof LiteratureOverviewService>[0]['infer']>
  single(): LiteratureOverviewService
}> {
  const { path } = await setup()
  const items = itemIds.map((id) => ({
    id,
    metadataRevision: 1,
    createdAt: 1,
    updatedAt: 1,
    item: literatureItemInputSchema.parse({
      itemType: 'journalArticle',
      title: id,
      abstract: `A study of ${id}.`
    }),
    attachments: [],
    collectionIds: [],
    projectIds: []
  }))
  const requests = items.map((item) => ({
    itemId: item.id,
    expectedSourceKey: literatureOverviewSource(item).key,
    language: 'en'
  }))
  const request = requests[0]
  const infer = vi
    .fn<ConstructorParameters<typeof LiteratureOverviewService>[0]['infer']>()
    .mockResolvedValue({
      model: 'test',
      text: JSON.stringify({
        question: 'A?',
        population: null,
        methods: null,
        results: null,
        limitations: null
      })
    })
  const single = (): LiteratureOverviewService =>
    new LiteratureOverviewService({
      store: new LiteratureOverviewStore(() => path + '.results'),
      catalog: { get: async (id) => items.find((item) => item.id === id) },
      reader: { classificationEvidence: vi.fn() },
      infer
    })
  return { path, request, requests, infer, single }
}
it('invariant: actual single-paper storage survives lost batch completion without another inference', async () => {
  const { path, request, infer, single } = await setupDurableOverview()
  const batch = new LiteratureOverviewBatch(() => path, single())
  const job = (await batch.run({ action: 'start', entries: [request] }))!
  const intent = await readFile(path, 'utf8')
  await batch.run({ action: 'advance', jobId: job.id })
  expect(infer).toHaveBeenCalledTimes(1)
  await writeFile(path, intent)
  infer.mockClear().mockRejectedValue(new Error('Must reuse persisted result'))
  const result = await new LiteratureOverviewBatch(() => path, single()).run({
    action: 'advance',
    jobId: job.id
  })
  expect(result?.rows[0].status).toBe('succeeded')
  expect(infer).not.toHaveBeenCalled()
})

it('recovers both real single-paper saves after losing the wave checkpoint without another inference', async () => {
  const { path, requests, infer, single } = await setupDurableOverview(['a', 'b'])
  const gates = new Map<
    string,
    ReturnType<typeof Promise.withResolvers<{ model: string; text: string }>>
  >()
  infer.mockImplementation(async ({ prompt }) => {
    const title = JSON.parse(prompt).title as string
    const gate = Promise.withResolvers<{ model: string; text: string }>()
    gates.set(title, gate)
    return gate.promise
  })
  const batch = new LiteratureOverviewBatch(() => path, single())
  const job = (await batch.run({ action: 'start', entries: requests }))!
  const wave = batch.run({ action: 'advance', jobId: job.id })
  const answer = {
    model: 'test',
    text: JSON.stringify({
      question: 'Saved?',
      population: null,
      methods: null,
      results: null,
      limitations: null
    })
  }
  try {
    await vi.waitFor(() => expect([...gates.keys()].sort()).toEqual(['a', 'b']))
    const interrupted = await readFile(path, 'utf8')
    gates.get('b')!.resolve(answer)
    await vi.waitFor(async () => {
      expect((await readDisk(path)).rows.map((row) => row.status)).toEqual(['running', 'succeeded'])
    })
    expect(await single().run({ ...requests[1], mode: 'read' })).toMatchObject({ model: 'test' })
    gates.get('a')!.resolve(answer)
    expect((await wave)?.rows.map((row) => row.status)).toEqual(['succeeded', 'succeeded'])
    await writeFile(path, interrupted)
    infer.mockClear().mockRejectedValue(new Error('Must reuse both saved results'))
    const reopened = new LiteratureOverviewBatch(() => path, single())
    const recovered = (await reopened.run({ action: 'read' }))!
    expect(recovered.paused).toBe(true)
    expect(recovered.rows.map((row) => row.status)).toEqual(['pending', 'pending'])
    await reopened.run({ action: 'resume', jobId: job.id })
    const reconciled = (await reopened.run({ action: 'advance', jobId: job.id }))!
    expect(reconciled.rows.map((row) => row.status)).toEqual(['succeeded', 'succeeded'])
    expect(await readDisk(path)).toEqual(reconciled)
    expect(infer).not.toHaveBeenCalled()
  } finally {
    for (const gate of gates.values()) gate.resolve(answer)
    await wave
  }
})

it('invariant: a real checkpoint write failure preserves the result and recovers without inference', async () => {
  const { path, request, infer, single } = await setupDurableOverview()
  const batch = new LiteratureOverviewBatch(() => path, single())
  const job = (await batch.run({ action: 'start', entries: [request] }))!
  const write = durableFiles.writeDurableJsonFile
  const fault = vi.spyOn(durableFiles, 'writeDurableJsonFile').mockImplementation((...args) => {
    if (args[0] === path && String(args[1]).includes('succeeded'))
      return Promise.reject(new Error('Injected task write failure'))
    return write(...args)
  })
  try {
    await expect(batch.run({ action: 'advance', jobId: job.id })).rejects.toThrow(
      'Injected task write failure'
    )
  } finally {
    fault.mockRestore()
  }
  expect(infer).toHaveBeenCalledTimes(1)
  expect((await readDisk(path)).rows[0].status).toBe('running')
  infer.mockClear().mockRejectedValue(new Error('Must reuse persisted result'))
  const reopened = new LiteratureOverviewBatch(() => path, single())
  await reopened.run({ action: 'resume', jobId: job.id })
  const result = await reopened.run({ action: 'advance', jobId: job.id })
  expect(result?.rows[0].status).toBe('succeeded')
  expect(infer).not.toHaveBeenCalled()
})

it('fails closed on corrupt checkpoints and releases its command guard', async () => {
  const { batch, path } = await setup()
  const job = (await batch.run({ action: 'start', entries }))!
  const intent = await readFile(path, 'utf8')
  await writeFile(path, '{broken')
  await expect(batch.run({ action: 'read' })).rejects.toThrow()
  await expect(batch.run({ action: 'start', entries })).rejects.toThrow()
  expect(await readFile(path, 'utf8')).toBe('{broken')
  await writeFile(path, intent)
  expect((await batch.run({ action: 'read' }))?.id).toBe(job.id)
})

it('reads maximum escaped requests after durable writes, restart and mixed completion', async () => {
  const { batch, path, run } = await setup()
  // NUL survives trim and occupies six bytes when JSON-escaped.
  const maximumEntries = Array.from({ length: 5 }, (_, index) => ({
    itemId: '\0'.repeat(255) + index,
    expectedSourceKey: '\0'.repeat(4096),
    language: '\0'.repeat(64),
    mode: 'generate' as const
  }))
  const job = (await batch.run({ action: 'start', entries: maximumEntries }))!
  const initial = await readFile(path, 'utf8')
  expect(Buffer.byteLength(initial)).toBeGreaterThan(100_000)
  expect(job.rows.map((row) => row.request)).toEqual(maximumEntries)
  expect(await batch.run({ action: 'read' })).toEqual(job)
  const reopened = new LiteratureOverviewBatch(() => path, { run })
  expect(await reopened.run({ action: 'read' })).toEqual(job)
  run.mockImplementation(async (request) => {
    if (request.mode === 'read')
      return { sourceKey: request.expectedSourceKey, issue: 'not-generated' }
    if (request.itemId.endsWith('1'))
      return { sourceKey: request.expectedSourceKey, issue: 'source-changed' }
    if (request.itemId.endsWith('3')) throw new Error('Provider unavailable')
    return ready(request.expectedSourceKey)
  })
  let completed = job
  for (let index = 0; index < 3; index++) {
    await reopened.run({ action: 'resume', jobId: job.id })
    completed = (await reopened.run({ action: 'advance', jobId: job.id }))!
  }
  expect(completed.rows.map((row) => row.status)).toEqual([
    'succeeded',
    'failed',
    'succeeded',
    'failed',
    'succeeded'
  ])
  expect(completed.rows.map((row) => row.issue)).toEqual([
    undefined,
    'source-changed',
    undefined,
    'generation-failed',
    undefined
  ])
  expect(Buffer.byteLength(await readFile(path, 'utf8'))).toBeGreaterThan(
    Buffer.byteLength(initial)
  )
  expect(await reopened.run({ action: 'read' })).toEqual(completed)
  const finishedOwner = new LiteratureOverviewBatch(() => path, { run })
  expect(await finishedOwner.run({ action: 'read' })).toEqual(completed)
  const next = (await finishedOwner.run({ action: 'start', entries }))!
  expect(next.id).not.toBe(job.id)
  expect(next.rows.map((row) => row.request)).toEqual(entries)
  expect(await finishedOwner.run({ action: 'read' })).toEqual(next)
})

it('rejects checkpoints over 200000 bytes without replacement and releases its guard', async () => {
  const { batch, path } = await setup()
  const job = (await batch.run({ action: 'start', entries }))!
  const intent = await readFile(path, 'utf8')
  const enlarged: OverviewBatch = JSON.parse(intent)
  // The checkpoint schema permits issue strings; a valid object still has a byte budget.
  enlarged.rows[0].status = 'failed'
  enlarged.rows[0].issue = 'x'.repeat(200_000)
  for (const oversized of [JSON.stringify(enlarged), '{broken' + 'x'.repeat(200_000)]) {
    expect(Buffer.byteLength(oversized)).toBeGreaterThan(200_000)
    await writeFile(path, oversized)
    await expect(batch.run({ action: 'read' })).rejects.toThrow()
    await expect(batch.run({ action: 'start', entries })).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe(oversized)
    await writeFile(path, intent)
    expect(await batch.run({ action: 'read' })).toEqual(job)
  }
})

it('revokes a registered caller during real inference, drains writers and resumes only the unfinished paper', async () => {
  const { path, requests, infer, single } = await setupDurableOverview(['a', 'b', 'c'])
  const batch = new LiteratureOverviewBatch(() => path, single())
  const owner = createLiteratureCommandOwner({
    literatureOverviewBatch: batch
  } as unknown as Parameters<typeof createLiteratureCommandOwner>[0])
  const router = createApplicationCommandRouter()
  const installation = registerLiteratureApplicationCommands(router.registrar, owner)
  const leases = new ApplicationCallerLeaseRegistry()
  const callerContext = createWebCallerContext('overview-worker')
  const caller = leases.acquire(callerContext)
  const invoke = (request: OverviewBatchRequest): Promise<OverviewBatch | null> =>
    router.dispatcher.invoke(literatureApplicationCommands.overviewBatch, {
      args: [request],
      callerContext,
      callerLease: caller.lease
    })
  const entered = Promise.withResolvers<AbortSignal>()
  const cleanup = Promise.withResolvers<void>()
  let pending: ReturnType<typeof invoke> | undefined
  try {
    const job = (await invoke({ action: 'start', entries: requests }))!
    await invoke({ action: 'advance', jobId: job.id })
    const savedFirst = await single().run({ ...requests[0], mode: 'read' })
    expect(savedFirst).toMatchObject({ sourceKey: requests[0].expectedSourceKey, model: 'test' })
    infer.mockImplementationOnce(async ({ signal }) => {
      entered.resolve(signal)
      try {
        return await new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      } finally {
        await cleanup.promise
      }
    })
    pending = invoke({ action: 'advance', jobId: job.id })
    const inferSignal = await entered.promise
    let drained = false
    const drain = waitForDataRootWriters().then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)
    caller.release()
    expect(inferSignal.aborted).toBe(true)
    expect(caller.lease.isCurrent()).toBe(false)
    // Cancellation must retain the write lease and row guard until inference cleanup settles.
    expect((await batch.run({ action: 'read' }))?.rows.map((row) => row.status)).toEqual([
      'succeeded',
      'succeeded',
      'running'
    ])
    expect(drained).toBe(false)
    cleanup.resolve()
    const paused = (await pending)!
    await drain
    expect(drained).toBe(true)
    expect(paused.paused).toBe(true)
    expect(paused.rows.map((row) => row.status)).toEqual(['succeeded', 'succeeded', 'pending'])
    expect(paused.rows[2].issue).toBeUndefined()
    expect(await readDisk(path)).toEqual(paused)
    expect(await single().run({ ...requests[0], mode: 'read' })).toEqual(savedFirst)
    expect(await single().run({ ...requests[2], mode: 'read' })).toMatchObject({
      issue: 'not-generated'
    })
    // The original batch guard is released, and a fresh owner can recover from disk.
    expect((await batch.run({ action: 'read' }))?.id).toBe(job.id)
    const resumed = new LiteratureOverviewBatch(() => path, single())
    await resumed.run({ action: 'resume', jobId: job.id })
    const finished = (await resumed.run({ action: 'advance', jobId: job.id }))!
    expect(finished.rows.map((row) => row.status)).toEqual(['succeeded', 'succeeded', 'succeeded'])
    const inferred = infer.mock.calls.map(([input]) => JSON.parse(input.prompt).title)
    expect(inferred.slice(0, 2).sort()).toEqual(['a', 'b'])
    expect(inferred.slice(2)).toEqual(['c', 'c'])
    expect(await single().run({ ...requests[0], mode: 'read' })).toEqual(savedFirst)
  } finally {
    caller.release()
    cleanup.resolve()
    await pending?.catch(() => undefined)
    installation.uninstall()
    await installation.whenIdle()
    leases.dispose()
    router.dispose()
  }
})
