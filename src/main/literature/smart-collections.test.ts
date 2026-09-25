import { randomUUID } from 'node:crypto'
import { ClassificationUsageRecorder } from '../settings/classification-usage'
import { formatSmartRule } from '../../shared/smart-collection-rule'
import {
  AutomaticClassificationPausedError,
  ClassificationEvaluationError
} from '../../shared/classification'
import { literatureItemInputSchema } from '../../shared/literature'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createProjectDbClient } from '../projects/prisma-client'
import { migrateApplicationDatabase } from '../database/migration-service'
import { LiteratureSmartCollections } from './smart-collections'
import { LiteratureCatalog } from './catalog'
import type { ClassifyLiterature } from '../../shared/classification'
import { SMART_COLLECTION_RESUME_UNAVAILABLE } from '../../shared/literature-smart-collections'

let root: string
let db: ReturnType<typeof createProjectDbClient>
let owner: LiteratureSmartCollections
let catalog: LiteratureCatalog
const classify = vi.fn<ClassifyLiterature>()
const changed = vi.fn()
let configured = true
let classificationChanged: (() => void) | undefined
const unsubscribeClassification = vi.fn()
const serviceId = '55555555-5555-4555-8555-555555555555'
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'smart-collection-'))
  db = createProjectDbClient(root)
  await migrateApplicationDatabase(db)
  configured = true
  classificationChanged = undefined
  unsubscribeClassification.mockClear()
  changed.mockReset()
  classify.mockReset().mockResolvedValue({
    verdict: 'match',
    model: 'jev-1.13.0',
    confidence: 1,
    probabilities: { match: 1, 'no-match': 0, uncertain: 0 }
  })
  const usageRecorder = new ClassificationUsageRecorder(async () => db)
  owner = new LiteratureSmartCollections(
    async () => db,
    {
      subscribe: (listener) => {
        classificationChanged = listener
        return unsubscribeClassification
      },
      classifyLiterature: async (input) => {
        const record = usageRecorder.observer(
          input.usageContext ?? { scenario: 'literature-update' }
        )
        const event = {
          eventId: randomUUID(),
          providerId: 'fixture',
          model: 'fixture',
          occurredAt: Date.now()
        }
        await record({ ...event, status: 'started' })
        let tokens: { inputTokens: number; outputTokens: number } | undefined
        let completed = false
        try {
          const answer = await classify({
            ...input,
            observeUsage: (value) => {
              tokens = value.usage
              input.observeUsage?.(value)
            }
          })
          completed = true
          return answer
        } finally {
          await record({ ...event, ...tokens, status: completed ? 'completed' : 'failed' })
        }
      },
      snapshot: async () => ({
        revision: 1,
        services: [{ id: serviceId, name: 'Test', adapter: 'typesafe', configured }],
        availableProviders: [],
        smartCollections: { serviceId, modelId: 'jev-latest' }
      })
    },
    changed
  )
  catalog = new LiteratureCatalog(async () => db, undefined, undefined, undefined, undefined, owner)
  await db.literatureItem.create({
    data: {
      id: 'paper',
      itemType: 'journalArticle',
      title: 'Research',
      normalizedTitle: 'research',
      abstract: 'Original study'
    }
  })
})
afterEach(async () => {
  await owner?.dispose()
  await db.$disconnect()
  await rm(root, { recursive: true, force: true })
})
const create = async (): Promise<string> =>
  (
    await owner.execute({
      kind: 'create-smart-collection',
      name: 'Research',
      description: formatSmartRule({
        description: '',
        inclusion: 'Original studies',
        exclusion: ''
      }),
      scope: { kind: 'library' }
    })
  ).id
const refresh = async (id: string): Promise<void> => {
  await owner.execute({ kind: 'smart-collection', collectionId: id, action: 'refresh', offset: 0 })
  await vi.waitFor(async () => expect((await owner.view(id)).run?.state).toBe('completed'))
}

it('reads bounded run outcomes, preserves historical verdicts and distinguishes missing details', async () => {
  await db.literatureItem.createMany({
    data: Array.from({ length: 30 }, (_, i) => ({
      id: `progress-${String(i).padStart(2, '0')}`,
      title: `Progress ${i}`,
      itemType: 'journalArticle',
      abstract: 'Original study'
    }))
  })
  const collectionId = await create()
  await refresh(collectionId)
  const runId = (await owner.view(collectionId)).run!.id
  await db.literatureSmartRunItem.updateMany({
    where: { runId },
    data: { evaluatedAt: new Date(1000) }
  })
  await db.literatureSmartRunItem.update({
    where: { runId_itemId: { runId, itemId: 'progress-29' } },
    data: { deferred: true }
  })
  await db.literatureSmartRunItem.update({
    where: { runId_itemId: { runId, itemId: 'progress-28' } },
    data: { state: 'error', resultJson: null, failure: 'network' }
  })
  await db.literatureSmartRunItem.update({
    where: { runId_itemId: { runId, itemId: 'progress-27' } },
    data: { resultJson: null, evaluatedAt: null }
  })
  await db.literatureSmartRunItem.update({
    where: { runId_itemId: { runId, itemId: 'progress-26' } },
    data: { resultJson: JSON.stringify({ answer: { verdict: 'uncertain' } }) }
  })
  await db.literatureSmartRunItem.update({
    where: { runId_itemId: { runId, itemId: 'progress-25' } },
    data: {
      resultJson: JSON.stringify({ answer: { verdict: 'no-match' } }),
      evaluatedAt: new Date(500)
    }
  })
  await db.literatureSmartAssessment.updateMany({
    where: { collectionId },
    data: { verdict: 'no-match' }
  })
  await owner.execute({
    kind: 'smart-collection',
    action: 'override',
    collectionId,
    itemId: 'paper',
    decision: 'exclude',
    offset: 0
  })
  const command = { kind: 'read-smart-run-progress' as const, collectionId, runId }
  const before = classify.mock.calls.length
  const first = (await catalog.transact(command)).smartRunProgress!
  expect(first).toMatchObject({
    total: 30,
    done: 30,
    counts: { match: 26, noMatch: 1, review: 1, unavailable: 1, error: 1, pending: 0 }
  })
  expect(first.outcomes).toHaveLength(10)
  expect(first.outcomes.filter((row) => row.verdict === 'match')).toHaveLength(6)
  expect(first.outcomes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: 'progress-25', verdict: 'no-match' }),
      expect.objectContaining({ id: 'progress-26', verdict: 'uncertain' }),
      expect.objectContaining({ id: 'progress-27', state: 'done' }),
      expect.objectContaining({ id: 'progress-28', state: 'error' })
    ])
  )
  expect(first.outcomes[0]).toMatchObject({ id: 'paper', verdict: 'match', override: 'exclude' })
  expect((await catalog.transact(command)).smartRunProgress).toEqual(first)
  expect(classify).toHaveBeenCalledTimes(before)
  await expect(
    catalog.transact({ ...command, collectionId: 'different-collection' })
  ).rejects.toThrow()
  await expect(catalog.transact({ ...command, runId: 'missing-run' })).rejects.toThrow()
})

it('exposes only committed outcomes while other candidates are still being evaluated', async () => {
  await db.literatureItem.createMany({
    data: ['a', 'b', 'c'].map((id) => ({
      id,
      title: id,
      itemType: 'journalArticle',
      abstract: 'Original study'
    }))
  })
  const releases: Array<() => void> = []
  classify.mockImplementation(async () => {
    await new Promise<void>((resolve) => releases.push(resolve))
    return {
      verdict: 'match',
      model: 'jev-1.13.0',
      confidence: 1,
      probabilities: { match: 1, 'no-match': 0, uncertain: 0 }
    }
  })
  const collectionId = await create()
  await owner.execute({ kind: 'smart-collection', collectionId, action: 'refresh', offset: 0 })
  try {
    await vi.waitFor(() => expect(releases).toHaveLength(4))
    const runId = (await owner.view(collectionId)).run!.id
    const command = { kind: 'read-smart-run-progress' as const, collectionId, runId }
    const initial = (await catalog.transact(command)).smartRunProgress!
    expect(initial.candidates).toHaveLength(4)
    expect(initial.outcomes).toEqual([])
    releases[2]()
    await vi.waitFor(async () =>
      expect(await db.literatureSmartRunItem.count({ where: { runId, state: 'done' } })).toBe(1)
    )
    const next = (await catalog.transact(command)).smartRunProgress!
    expect(next).toMatchObject({
      state: 'running',
      total: 4,
      done: 1,
      counts: { pending: 3, match: 1 }
    })
    expect(next.outcomes).toHaveLength(1)
    expect(next.candidates.some(({ id }) => id === next.outcomes[0].id)).toBe(false)
  } finally {
    releases.forEach((release) => release())
  }
})
it('saves an unconfigured collection without inference and distinguishes pending from no matches', async () => {
  configured = false
  const id = await create()
  expect(await owner.view(id)).toMatchObject({
    configured: false,
    matches: 0,
    pending: 1,
    total: 1
  })
  await expect(refresh(id)).rejects.toThrow('not configured')
  expect(classify).not.toHaveBeenCalled()
})
it('keeps smart membership independent and invalidates only changed evidence', async () => {
  const id = await create()
  await refresh(id)
  expect(await owner.members(id)).toEqual(['paper'])
  expect(await db.literatureCollectionItem.count()).toBe(0)
  expect((await catalog.search({ scope: 'library', collectionId: id })).totalCount).toBe(1)
  await db.literatureItem.update({
    where: { id: 'paper' },
    data: { rating: 4, personalNote: 'Read again' }
  })
  await refresh(id)
  expect(classify).toHaveBeenCalledTimes(1)
  await db.literatureItem.update({
    where: { id: 'paper' },
    data: { abstract: 'Different evidence' }
  })
  expect(await owner.members(id)).toEqual([])
  expect((await owner.view(id)).rows[0]?.verdict).toBe('stale')
})
it('preserves human decisions across rule edits and enforces the source boundary', async () => {
  await db.project.create({ data: { id: 'project', name: 'Project' } })
  await db.projectLiterature.create({
    data: { projectId: 'project', itemId: 'paper', source: 'manual' }
  })
  const id = (
    await owner.execute({
      kind: 'create-smart-collection',
      name: 'Project papers',
      description: formatSmartRule({
        description: '',
        inclusion: 'Original studies',
        exclusion: ''
      }),
      scope: { kind: 'project', id: 'project' }
    })
  ).id
  await owner.execute({
    kind: 'smart-collection',
    collectionId: id,
    action: 'override',
    offset: 0,
    itemId: 'paper',
    decision: 'include'
  })
  await catalog.transact({
    kind: 'update-collection',
    collectionId: id,
    expectedRevision: 1,
    name: 'Project papers',
    description: formatSmartRule({ description: '', inclusion: 'New criteria', exclusion: '' })
  })
  expect(await owner.members(id)).toEqual(['paper'])
  await db.projectLiterature.deleteMany({ where: { projectId: 'project' } })
  expect(await owner.members(id)).toEqual([])
  await expect(
    owner.execute({
      kind: 'smart-collection',
      collectionId: id,
      action: 'override',
      offset: 0,
      itemId: 'paper',
      decision: 'include'
    })
  ).rejects.toThrow('outside')
})
it('reports missing evidence as not evaluated without a paid call', async () => {
  await db.literatureItem.update({ where: { id: 'paper' }, data: { abstract: '' } })
  const id = await create()
  await refresh(id)
  expect((await owner.view(id)).rows[0]?.verdict).toBe('pending')
  expect(classify).not.toHaveBeenCalled()
})

it('projects the same smart memberships into detail, multi-get, filtered collections and export', async () => {
  const id = await create()
  await refresh(id)
  expect((await catalog.get('paper'))?.collectionIds).toEqual([id])
  expect((await catalog.getMany(['paper']))[0]?.collectionIds).toEqual([id])
  expect((await catalog.search({ scope: 'collections', itemId: 'paper' })).entries).toMatchObject([
    { id, itemCount: 1, smart: true }
  ])
  const exported = await catalog.exportRecord({ itemId: 'paper' })
  expect(JSON.parse(exported.chunk).collectionIds).toEqual([id])
  await db.literatureItem.update({ where: { id: 'paper' }, data: { abstract: 'Revised' } })
  expect((await catalog.get('paper'))?.collectionIds).toEqual([])
  expect((await catalog.search({ scope: 'collections', itemId: 'paper' })).totalCount).toBe(0)
})

it('does not write ordinary memberships when importing into a smart collection', async () => {
  const id = await create()
  await expect(
    catalog.importItems(
      [literatureItemInputSchema.parse({ itemType: 'journalArticle', title: 'New paper' })],
      id
    )
  ).rejects.toThrow('ordinary collection')
  expect(await db.literatureItem.count()).toBe(1)
  expect(await db.literatureCollectionItem.count()).toBe(0)
})

it('stops on failure, records usage and retries without erasing the rule', async () => {
  const id = await create()
  classify.mockImplementationOnce(async ({ observeUsage }) => {
    observeUsage?.({
      eventId: 'test-usage',
      providerId: serviceId,
      model: 'jev-1.13.0',
      usage: { inputTokens: 42, outputTokens: 7, cacheTokens: 0 }
    })
    throw new Error('unavailable')
  })
  await owner.execute({ kind: 'smart-collection', collectionId: id, action: 'refresh', offset: 0 })
  await vi.waitFor(async () => expect((await owner.view(id)).run?.state).toBe('failed'))
  expect(await owner.view(id)).toMatchObject({
    pending: 1,
    matches: 0,
    rows: [{ verdict: 'error' }],
    run: { inputTokens: 42, outputTokens: 7, usageIncomplete: false }
  })
  await refresh(id)
  expect(await owner.members(id)).toEqual(['paper'])
})

it('rejects a late result after cancellation and releases the worker', async () => {
  const id = await create()
  let resolve!: (value: Awaited<ReturnType<typeof classify>>) => void
  classify.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      })
  )
  await owner.execute({ kind: 'smart-collection', collectionId: id, action: 'refresh', offset: 0 })
  await vi.waitFor(() => expect(classify).toHaveBeenCalledTimes(1))
  await owner.execute({ kind: 'smart-collection', collectionId: id, action: 'cancel', offset: 0 })
  resolve({
    verdict: 'match',
    confidence: 1,
    probabilities: { match: 1, 'no-match': 0, uncertain: 0 },
    model: 'jev-1.13.0'
  })
  await owner.dispose()
  expect((await owner.view(id)).run?.state).toBe('cancelled')
  expect(await db.literatureSmartAssessment.count()).toBe(0)
})

const pauseAfterOneResult = async (
  automatic = false,
  manualAction: 'refresh' | 'recompute' = 'recompute'
): Promise<{ id: string; runId: string; doneId: string }> => {
  await db.literatureItem.createMany({
    data: Array.from({ length: 7 }, (_, i) => ({
      id: `resume-${i}`,
      itemType: 'journalArticle',
      title: `Resume ${i}`,
      abstract: 'Original study'
    }))
  })
  const id = await create()
  if (automatic)
    await db.literatureSmartCollection.update({
      where: { collectionId: id },
      data: { autoUpdate: true }
    })
  let first = true
  classify.mockImplementation(async (input) => {
    if (first) {
      first = false
      return {
        verdict: 'match',
        model: 'jev-1.13.0',
        confidence: 1,
        probabilities: { match: 1, 'no-match': 0, uncertain: 0 }
      }
    }
    return new Promise((_, reject) =>
      input.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    )
  })
  await owner.execute(
    {
      kind: 'smart-collection',
      collectionId: id,
      action: automatic ? 'refresh' : manualAction,
      offset: 0
    },
    automatic
  )
  await vi.waitFor(async () => expect((await owner.view(id)).run?.done).toBe(1))
  await owner.execute({ kind: 'smart-collection', collectionId: id, action: 'cancel', offset: 0 })
  await vi.waitFor(async () => expect((await owner.view(id)).run?.state).toBe('cancelled'))
  const runId = (await owner.view(id)).run!.id
  const done = await db.literatureSmartRunItem.findFirstOrThrow({ where: { runId, state: 'done' } })
  return { id, runId, doneId: done.itemId }
}

it('resumes the same stopped run once and preserves completed outcomes', async () => {
  const { id, runId, doneId } = await pauseAfterOneResult()
  const before = await db.literatureSmartRunItem.findUniqueOrThrow({
    where: { runId_itemId: { runId, itemId: doneId } }
  })
  const calls = classify.mock.calls.length
  classify.mockResolvedValue({
    verdict: 'match',
    model: 'jev-1.13.0',
    confidence: 1,
    probabilities: { match: 1, 'no-match': 0, uncertain: 0 }
  })
  await Promise.all(
    Array.from({ length: 2 }, () =>
      owner.execute({ kind: 'smart-collection', collectionId: id, action: 'resume', offset: 0 })
    )
  )
  await vi.waitFor(async () => expect((await owner.view(id)).run?.state).toBe('completed'))
  expect((await owner.view(id)).run).toMatchObject({ id: runId, done: 8, total: 8 })
  expect(await db.literatureSmartRun.count({ where: { collectionId: id } })).toBe(1)
  expect(classify.mock.calls.length - calls).toBe(7)
  expect(
    await db.literatureSmartRunItem.findUniqueOrThrow({
      where: { runId_itemId: { runId, itemId: doneId } }
    })
  ).toEqual(before)
})

it('does not assign another automatic pause to a manual run resumed without usage', async () => {
  const { id, runId } = await pauseAfterOneResult(false, 'refresh')
  await db.classificationUsage.deleteMany({ where: { runId } })
  await db.literatureSmartRun.create({
    data: {
      id: 'other-automatic-run',
      collectionId: id,
      kind: 'refresh',
      state: 'interrupted',
      ruleRevision: 1,
      policyKey: 'fixture',
      createdAt: new Date(0)
    }
  })
  await db.literatureSmartCollection.update({
    where: { collectionId: id },
    data: {
      autoUpdate: true,
      automaticPauseReason: 'interrupted',
      automaticPauseRunId: 'other-automatic-run'
    }
  })
  classify.mockResolvedValue({
    verdict: 'match',
    model: 'jev-1.13.0',
    confidence: 1,
    probabilities: { match: 1, 'no-match': 0, uncertain: 0 }
  })

  await owner.execute({
    kind: 'smart-collection',
    collectionId: id,
    action: 'resume',
    runId,
    offset: 0
  })
  await vi.waitFor(async () => expect((await owner.view(id)).run?.state).toBe('completed'))

  expect(await owner.view(id)).toMatchObject({
    automaticPauseReason: 'interrupted',
    automaticPauseRunId: 'other-automatic-run'
  })
  expect(
    await db.classificationUsage.findMany({ where: { runId }, select: { scenario: true } })
  ).not.toEqual(expect.arrayContaining([{ scenario: 'literature-automatic' }]))
})

it('rejects resuming an automatic run after automatic updates are disabled', async () => {
  const { id, runId } = await pauseAfterOneResult(true)
  await db.literatureSmartCollection.update({
    where: { collectionId: id },
    data: { autoUpdate: false }
  })
  const calls = classify.mock.calls.length
  await expect(
    owner.execute({ kind: 'smart-collection', collectionId: id, action: 'resume', offset: 0 })
  ).rejects.toThrow(SMART_COLLECTION_RESUME_UNAVAILABLE)
  expect(classify).toHaveBeenCalledTimes(calls)
  expect((await owner.view(id)).run?.id).toBe(runId)
})

it('resumes automatic work with the same usage context and preserves its guard', async () => {
  const { id, runId } = await pauseAfterOneResult(true)
  const usage = await db.classificationUsage.count({ where: { runId } })
  const calls = classify.mock.calls.length
  classify.mockRejectedValue(new AutomaticClassificationPausedError('run-limit'))
  await owner.execute({ kind: 'smart-collection', collectionId: id, action: 'resume', offset: 0 })
  await vi.waitFor(async () =>
    expect((await owner.view(id)).automaticPauseReason).toBe('run-limit')
  )
  expect((await owner.view(id)).run).toMatchObject({
    id: runId,
    state: 'interrupted',
    done: 1,
    total: 8
  })
  for (const [input] of classify.mock.calls.slice(calls))
    expect(input.usageContext).toMatchObject({ runId, scenario: 'literature-automatic' })
  expect(await db.classificationUsage.count({ where: { runId } })).toBeGreaterThan(usage)
  expect(await db.literatureSmartRun.count({ where: { collectionId: id } })).toBe(1)
  const limitedRun = await db.literatureSmartRun.findUniqueOrThrow({ where: { id: runId } })
  const limitedUsage = await db.classificationUsage.count({ where: { runId } })
  const limitedCalls = classify.mock.calls.length
  await expect(
    owner.execute({ kind: 'smart-collection', collectionId: id, action: 'resume', offset: 0 })
  ).rejects.toThrow(SMART_COLLECTION_RESUME_UNAVAILABLE)
  expect((await owner.view(id)).automaticPauseReason).toBe('run-limit')
  expect(await db.literatureSmartRun.findUniqueOrThrow({ where: { id: runId } })).toEqual(
    limitedRun
  )
  expect(await db.classificationUsage.count({ where: { runId } })).toBe(limitedUsage)
  expect(classify).toHaveBeenCalledTimes(limitedCalls)
})

it.each([
  'paper',
  'rule',
  'policy',
  'snapshot',
  'details',
  'incomplete-result',
  'timestamp'
] as const)('rejects resume after %s changes without dispatching paid work', async (change) => {
  const { id, runId, doneId } = await pauseAfterOneResult()
  if (change === 'paper')
    await db.literatureItem.update({
      where: { id: 'paper' },
      data: { abstract: 'Changed input' }
    })
  if (change === 'rule')
    await db.literatureCollection.update({
      where: { id },
      data: {
        description: formatSmartRule({
          description: '',
          inclusion: 'Changed inclusion',
          exclusion: ''
        })
      }
    })
  if (change === 'policy')
    await db.literatureSmartRun.update({ where: { id: runId }, data: { policyKey: 'outdated' } })
  if (change === 'snapshot')
    await db.literatureSmartRun.update({ where: { id: runId }, data: { snapshotJson: null } })
  if (change === 'details')
    await db.literatureSmartRunItem.update({
      where: { runId_itemId: { runId, itemId: doneId } },
      data: { resultJson: null }
    })
  if (change === 'incomplete-result' || change === 'timestamp')
    await db.literatureSmartRunItem.update({
      where: { runId_itemId: { runId, itemId: doneId } },
      data:
        change === 'timestamp'
          ? { evaluatedAt: null }
          : { resultJson: JSON.stringify({ answer: { verdict: 'match' } }) }
    })
  const calls = classify.mock.calls.length
  await expect(
    owner.execute({ kind: 'smart-collection', collectionId: id, action: 'resume', offset: 0 })
  ).rejects.toThrow(SMART_COLLECTION_RESUME_UNAVAILABLE)
  expect(classify).toHaveBeenCalledTimes(calls)
  expect((await owner.view(id)).run).toMatchObject({ id: runId, state: 'cancelled' })
})

it('marks abandoned work interrupted without restarting paid requests', async () => {
  const id = await create()
  await db.literatureSmartRun.create({
    data: { collectionId: id, kind: 'refresh', state: 'running', ruleRevision: 1, policyKey: 'old' }
  })
  expect((await owner.view(id)).run).toMatchObject({ state: 'interrupted', usageIncomplete: false })
  expect(classify).not.toHaveBeenCalled()
})

it('never broadens scope when its ordinary source is deleted', async () => {
  const source = await db.literatureCollection.create({
    data: { name: 'Source', nameKey: 'source' }
  })
  await db.literatureCollectionItem.create({ data: { collectionId: source.id, itemId: 'paper' } })
  const id = (
    await owner.execute({
      kind: 'create-smart-collection',
      name: 'Scoped',
      description: formatSmartRule({ description: '', inclusion: 'Research', exclusion: '' }),
      scope: { kind: 'collection', id: source.id }
    })
  ).id
  await refresh(id)
  await db.literatureCollection.delete({ where: { id: source.id } })
  expect(await owner.view(id)).toMatchObject({ sourceAvailable: false, matches: 0, total: 0 })
  await expect(refresh(id)).rejects.toThrow('source is unavailable')
  expect(classify).toHaveBeenCalledTimes(1)
})

it('updates scope through collection revision checks without broadening unavailable sources', async () => {
  const id = await create()
  await refresh(id)
  const source = await db.literatureCollection.create({
    data: { name: 'Other scope', nameKey: 'other scope' }
  })
  await catalog.transact({
    kind: 'update-collection',
    collectionId: id,
    expectedRevision: 1,
    name: 'Research',
    description: formatSmartRule({ description: '', inclusion: 'Original studies', exclusion: '' }),
    smartScope: { kind: 'collection', id: source.id }
  })
  expect(await owner.view(id)).toMatchObject({
    total: 0,
    scope: { kind: 'collection', id: source.id }
  })
  expect(
    (await db.literatureSmartCollection.findUniqueOrThrow({ where: { collectionId: id } }))
      .ruleRevision
  ).toBe(2)
  await expect(
    catalog.transact({
      kind: 'update-collection',
      collectionId: id,
      expectedRevision: 2,
      name: 'Research',
      description: formatSmartRule({
        description: '',
        inclusion: 'Original studies',
        exclusion: ''
      }),
      smartScope: { kind: 'collection', id }
    })
  ).rejects.toThrow('source is unavailable')
})

it('does not combine results when a model alias resolves to a different model', async () => {
  const id = await create()
  await refresh(id)
  await db.literatureItem.create({
    data: {
      id: 'second',
      itemType: 'journalArticle',
      title: 'More research',
      abstract: 'A second original study'
    }
  })
  classify.mockResolvedValueOnce({
    verdict: 'match',
    model: 'jev-2.0',
    confidence: 1,
    probabilities: { match: 1, 'no-match': 0, uncertain: 0 }
  })
  await owner.execute({ kind: 'smart-collection', collectionId: id, action: 'refresh', offset: 0 })
  await vi.waitFor(async () => expect((await owner.view(id)).run?.state).toBe('failed'))
  expect(await owner.members(id)).toEqual([])
  expect((await owner.view(id)).rows.find((row) => row.id === 'paper')?.verdict).toBe('stale')
})

it('includes smart collections in project global search and honors text filters', async () => {
  const id = await create()
  await db.project.create({ data: { id: 'project', name: 'Project' } })
  await db.projectLiterature.create({
    data: { projectId: 'project', itemId: 'paper', source: 'manual' }
  })
  await refresh(id)
  expect(
    (
      await catalog.search({
        scope: 'global-search',
        projectId: 'project',
        entryKind: 'collection',
        query: 'Research'
      })
    ).entries
  ).toMatchObject([
    {
      id,
      itemCount: 1,
      smart: true,
      smartScope: { kind: 'library' },
      smartEvidenceMode: 'abstract',
      smartAutoUpdate: false
    }
  ])
  expect(
    (
      await catalog.search({
        scope: 'global-search',
        projectId: 'project',
        entryKind: 'collection',
        query: 'Unrelated'
      })
    ).totalCount
  ).toBe(0)
})

it('recomputes on explicit request, filters decisions, and resets manual overrides', async () => {
  const id = await create()
  await refresh(id)
  await owner.execute({
    kind: 'smart-collection',
    collectionId: id,
    action: 'recompute',
    offset: 0
  })
  await vi.waitFor(() => expect(classify).toHaveBeenCalledTimes(2))
  await owner.dispose()
  await owner.execute({
    kind: 'smart-collection',
    collectionId: id,
    action: 'override',
    itemId: 'paper',
    decision: 'exclude',
    offset: 0
  })
  expect(await owner.view(id, 0, 'match')).toMatchObject({ rows: [], overrides: 1 })
  expect(await owner.view(id, 0, 'no-match')).toMatchObject({ rows: [{ id: 'paper' }] })
  await owner.execute({
    kind: 'smart-collection',
    collectionId: id,
    action: 'reset-overrides',
    offset: 0
  })
  expect((await owner.view(id)).overrides).toBe(0)
})

it('uses the same searchable paginated catalog for every smart decision view', async () => {
  const id = await create()
  expect(
    (
      await catalog.search({ scope: 'library', collectionId: id, smartFilter: 'pending' })
    ).entries.map((row) => ('id' in row ? row.id : undefined))
  ).toEqual(['paper'])
  expect(
    (await catalog.search({ scope: 'library', collectionId: id, smartFilter: 'match' })).totalCount
  ).toBe(0)
  await refresh(id)
  await db.literatureItem.update({ where: { id: 'paper' }, data: { abstract: 'Changed evidence' } })
  expect(
    (
      await catalog.search({
        scope: 'library',
        collectionId: id,
        smartFilter: 'review',
        query: 'Research',
        limit: 1
      })
    ).entries.map((row) => ('id' in row ? row.id : undefined))
  ).toEqual(['paper'])
  expect(
    (
      await catalog.search({
        scope: 'library',
        collectionId: id,
        smartFilter: 'review',
        query: 'missing'
      })
    ).totalCount
  ).toBe(0)
  await owner.execute({
    kind: 'smart-collection',
    collectionId: id,
    action: 'override',
    itemId: 'paper',
    decision: 'exclude',
    offset: 0
  })
  expect(
    (
      await catalog.search({ scope: 'library', collectionId: id, smartFilter: 'no-match' })
    ).entries.map((row) => ('id' in row ? row.id : undefined))
  ).toEqual(['paper'])
  expect(
    (await catalog.search({ scope: 'library', collectionId: id, smartFilter: 'review' })).totalCount
  ).toBe(0)
})

it('filters decision source before pagination and counts overrides independently of model results', async () => {
  const id = await create()
  const search = (
    smartDecisionSource: 'all' | 'ai' | 'manual',
    smartFilter: 'match' | 'no-match' | 'pending' = 'match'
  ): ReturnType<typeof catalog.search> =>
    catalog.search({
      scope: 'library',
      collectionId: id,
      smartDecisionSource,
      smartFilter,
      limit: 1
    })
  expect((await search('ai', 'pending')).totalCount).toBe(0)
  await refresh(id)
  expect((await search('ai')).totalCount).toBe(1)
  expect((await search('manual')).totalCount).toBe(0)
  expect((await owner.view(id)).countsBySource?.ai.match).toBe(1)
  await owner.execute({
    kind: 'smart-collection',
    collectionId: id,
    action: 'override',
    itemId: 'paper',
    decision: 'exclude',
    offset: 0
  })
  expect((await search('ai', 'no-match')).totalCount).toBe(0)
  expect(
    (await search('manual', 'no-match')).entries.map((row) => ('id' in row ? row.id : undefined))
  ).toEqual(['paper'])
  expect((await owner.view(id)).countsBySource?.manual['no-match']).toBe(1)
  await owner.execute({
    kind: 'smart-collection',
    collectionId: id,
    action: 'override',
    itemId: 'paper',
    decision: 'automatic',
    offset: 0
  })
  expect((await search('manual', 'no-match')).totalCount).toBe(0)
  expect((await search('ai')).totalCount).toBe(1)
})

it('counts the entire scope before paging and agrees with each decision filter', async () => {
  const id = await create()
  for (const filter of ['match', 'review', 'no-match', 'pending'] as const) {
    const view = await owner.view(id, 100, filter)
    expect(view.rows).toEqual([])
    expect(view.counts[filter]).toBe((await owner.members(id, undefined, filter))!.length)
  }
})

it('exposes per-page assessment evidence, freshness and reversible decisions', async () => {
  classify.mockResolvedValue({
    verdict: 'uncertain',
    model: 'jev-test',
    confidence: 0.7,
    probabilities: { match: 0.2, 'no-match': 0.1, uncertain: 0.7 }
  })
  const id = await create()
  await refresh(id)
  const progress = (
    await catalog.transact({
      kind: 'read-smart-run-progress',
      collectionId: id,
      runId: (await owner.view(id)).run!.id
    })
  ).smartRunProgress!
  expect(progress.counts).toMatchObject({ review: 1, unavailable: 0 })
  expect(progress.outcomes[0]).toMatchObject({ id: 'paper', verdict: 'uncertain' })
  const page = await catalog.search({ scope: 'library', collectionId: id, smartFilter: 'review' })
  expect(page.entries[0]).toMatchObject({
    smartDecision: {
      reason: 'uncertain',
      assessment: { current: true, model: 'jev-test', probabilities: { match: 0.2 } }
    }
  })
  await db.literatureItem.update({ where: { id: 'paper' }, data: { abstract: 'Changed evidence' } })
  expect((await owner.view(id)).rows[0]).toMatchObject({
    reason: 'input-changed',
    assessment: { current: false }
  })
  await owner.execute({
    kind: 'smart-collection',
    collectionId: id,
    action: 'override',
    itemId: 'paper',
    decision: 'include',
    offset: 0
  })
  expect(await owner.members(id)).toEqual(['paper'])
  await owner.execute({
    kind: 'smart-collection',
    collectionId: id,
    action: 'override',
    itemId: 'paper',
    decision: 'automatic',
    offset: 0
  })
  expect(await owner.members(id, undefined, 'review')).toEqual(['paper'])
  await db.literatureSmartAssessment.updateMany({ data: { probabilitiesJson: '{}' } })
  expect((await owner.view(id)).rows[0]?.assessment?.probabilities).toBeUndefined()
})

it('explains missing evidence without pretending that a model evaluated it', async () => {
  await db.literatureItem.update({ where: { id: 'paper' }, data: { abstract: '' } })
  const id = await create()
  await refresh(id)
  expect(classify).not.toHaveBeenCalled()
  expect((await owner.view(id)).rows[0]).toMatchObject({
    reason: 'missing-evidence',
    assessment: { model: 'insufficient-evidence', current: true }
  })
  expect((await owner.view(id)).rows[0]?.assessment?.probabilities).toBeUndefined()
  expect((await owner.view(id)).counts).toMatchObject({ pending: 1, review: 0 })
  expect(await owner.members(id, undefined, 'pending')).toEqual(['paper'])
  expect(await owner.members(id, undefined, 'review')).toEqual([])
  const runId = (await owner.view(id)).run!.id
  const progress = (
    await catalog.transact({
      kind: 'read-smart-run-progress',
      collectionId: id,
      runId
    })
  ).smartRunProgress!
  expect(progress).toMatchObject({
    total: 1,
    done: 1,
    counts: { pending: 0, review: 0, unavailable: 1 }
  })
  expect(progress.outcomes).toHaveLength(1)
  expect(progress.outcomes[0]).toMatchObject({ id: 'paper', state: 'done' })
  expect(progress.outcomes[0].verdict).toBeUndefined()
  await refresh(id)
  expect((await owner.view(id)).run?.total).toBe(0)
  expect(classify).not.toHaveBeenCalled()
  await db.literatureItem.update({ where: { id: 'paper' }, data: { abstract: 'New evidence' } })
  expect((await owner.view(id)).rows[0]?.verdict).toBe('pending')
  await refresh(id)
  expect(classify).toHaveBeenCalledOnce()
  expect(await owner.members(id)).toEqual(['paper'])
})

it('keeps decisions disjoint and retries failed papers with older valid assessments', async () => {
  await db.literatureItem.create({
    data: {
      id: 'second',
      itemType: 'journalArticle',
      title: 'Second',
      normalizedTitle: 'second',
      abstract: 'Study'
    }
  })
  const id = await create()
  await refresh(id)
  const classifyNormally = classify.getMockImplementation()!
  let failedPaper = false
  classify.mockImplementation(async (input) => {
    if (!failedPaper && input.title === 'Research') {
      failedPaper = true
      throw new ClassificationEvaluationError('auth')
    }
    return classifyNormally(input)
  })
  await owner.execute({
    kind: 'smart-collection',
    collectionId: id,
    action: 'recompute',
    offset: 0
  })
  await vi.waitFor(async () => expect((await owner.view(id)).run?.state).toBe('failed'))
  expect((await owner.view(id)).counts).toEqual({ match: 1, review: 0, 'no-match': 0, pending: 1 })
  expect((await owner.view(id)).run?.failure).toBe('auth')
  expect((await owner.view(id)).rows.find((row) => row.verdict === 'error')?.failure).toBe('auth')
  expect(await owner.members(id)).toEqual(['second'])
  expect(await owner.members(id, undefined, 'pending')).toHaveLength(1)
  const page = await catalog.search({ scope: 'library', collectionId: id, smartFilter: 'pending' })
  expect(page.entries[0]).toHaveProperty('smartDecision')
  expect(
    (await owner.view(id)).rows.find((row) => row.verdict === 'error')?.assessment?.current
  ).toBe(false)
  const calls = classify.mock.calls.length
  await refresh(id)
  expect(classify.mock.calls.length - calls).toBe(1)
  expect((await owner.view(id)).counts).toEqual({ match: 2, review: 0, 'no-match': 0, pending: 0 })
})

it('preserves unresolved failures across selected runs, with manual overrides taking precedence', async () => {
  await db.literatureItem.create({
    data: {
      id: 'second',
      itemType: 'journalArticle',
      title: 'Second',
      normalizedTitle: 'second',
      abstract: 'Study'
    }
  })
  const id = await create()
  await refresh(id)
  const classifyNormally = classify.getMockImplementation()!
  let failedPaper = false
  classify.mockImplementation(async (input) => {
    if (!failedPaper && input.title === 'Research') {
      failedPaper = true
      throw new Error('failure')
    }
    return classifyNormally(input)
  })
  await owner.execute({
    kind: 'smart-collection',
    collectionId: id,
    action: 'recompute',
    offset: 0
  })
  await vi.waitFor(async () => expect((await owner.view(id)).run?.state).toBe('failed'))
  await owner.execute({
    kind: 'smart-collection',
    collectionId: id,
    action: 'recompute',
    itemIds: ['second'],
    offset: 0
  })
  await vi.waitFor(async () => expect((await owner.view(id)).run?.state).toBe('completed'))
  expect((await owner.view(id)).counts).toEqual({ match: 1, review: 0, 'no-match': 0, pending: 1 })
  expect((await owner.view(id)).run).toMatchObject({ total: 1, done: 1 })
  await owner.execute({
    kind: 'smart-collection',
    collectionId: id,
    action: 'override',
    itemId: 'paper',
    decision: 'include',
    offset: 0
  })
  expect((await owner.view(id)).counts).toEqual({ match: 2, review: 0, 'no-match': 0, pending: 0 })
  await owner.execute({
    kind: 'smart-collection',
    collectionId: id,
    action: 'recompute',
    itemIds: ['second'],
    offset: 0
  })
  await vi.waitFor(async () => expect((await owner.view(id)).run?.state).toBe('completed'))
  await owner.execute({
    kind: 'smart-collection',
    collectionId: id,
    action: 'override',
    itemId: 'paper',
    decision: 'automatic',
    offset: 0
  })
  expect((await owner.view(id)).counts.pending).toBe(1)
  await expect(
    owner.execute({
      kind: 'smart-collection',
      collectionId: id,
      action: 'recompute',
      itemIds: ['outside'],
      offset: 0
    })
  ).rejects.toThrow('outside')
  await refresh(id)
  expect((await owner.view(id)).counts.pending).toBe(0)
})

it('preserves unfinished older results when a different selection is evaluated', async () => {
  await db.literatureItem.create({
    data: {
      id: 'second',
      itemType: 'journalArticle',
      title: 'Second',
      normalizedTitle: 'second',
      abstract: 'Study'
    }
  })
  const id = await create()
  await refresh(id)
  classify.mockRejectedValueOnce(new Error('failure')).mockRejectedValueOnce(new Error('failure'))
  await owner.execute({
    kind: 'smart-collection',
    collectionId: id,
    action: 'recompute',
    offset: 0
  })
  await vi.waitFor(async () => expect((await owner.view(id)).run?.state).toBe('failed'))
  await owner.execute({
    kind: 'smart-collection',
    collectionId: id,
    action: 'recompute',
    itemIds: ['paper'],
    offset: 0
  })
  await vi.waitFor(async () => expect((await owner.view(id)).run?.state).toBe('completed'))
  expect((await owner.view(id)).counts).toEqual({ match: 1, review: 0, 'no-match': 0, pending: 1 })
  await refresh(id)
  expect((await owner.view(id)).counts.match).toBe(2)
})

it('measures collection reads with 2000 references without issuing model requests', async () => {
  await db.literatureItem.createMany({
    data: Array.from({ length: 2000 }, (_, n) => ({
      id: `scale-${n}`,
      itemType: 'journalArticle',
      title: 'Study',
      normalizedTitle: 'study',
      abstract: 'Scientific evidence '.repeat(50)
    }))
  })
  const id = await create()
  const start = performance.now()
  expect((await owner.view(id)).counts.pending).toBe(2001)
  const viewMs = performance.now() - start
  const pageStart = performance.now()
  const page = await catalog.search({
    scope: 'library',
    collectionId: id,
    smartFilter: 'pending',
    limit: 25
  })
  expect(page.entries).toHaveLength(25)
  expect(page.totalCount).toBe(2001)
  expect(classify).not.toHaveBeenCalled()
  process.stdout.write(
    JSON.stringify({
      smartCollectionBenchmark: {
        references: 2001,
        viewMs: Math.round(viewMs),
        pageMs: Math.round(performance.now() - pageStart)
      }
    })
  )
})

it('bounds inference to four requests and accounts for every started result before stopping', async () => {
  await db.literatureItem.createMany({
    data: Array.from({ length: 8 }, (_, i) => ({
      id: 'parallel-' + i,
      itemType: 'journalArticle',
      title: 'Study ' + i,
      normalizedTitle: 'study ' + i,
      abstract: 'Research'
    }))
  })
  let active = 0
  let peak = 0
  const release: Array<() => void> = []
  classify.mockImplementation(async (input) => {
    active++
    peak = Math.max(peak, active)
    await new Promise<void>((resolve) => release.push(resolve))
    active--
    input.observeUsage?.({
      eventId: input.title,
      providerId: 'test',
      model: 'jev-1.13.0',
      usage: { inputTokens: 12, outputTokens: 0, cacheTokens: 0, turnCount: 1 }
    })
    if (input.title === 'Research') throw new ClassificationEvaluationError('auth')
    return {
      verdict: 'match',
      model: 'jev-1.13.0',
      confidence: 1,
      probabilities: { match: 1, 'no-match': 0, uncertain: 0 }
    }
  })
  const id = await create()
  await owner.execute({ kind: 'smart-collection', collectionId: id, action: 'refresh', offset: 0 })
  await vi.waitFor(() => expect(release).toHaveLength(4))
  expect(peak).toBe(4)
  // "paper" precedes "parallel-*" in scope order and fails; its in-flight peers still settle.
  release.splice(0).forEach((resolve) => resolve())
  await vi.waitFor(async () => expect((await owner.view(id)).run?.state).toBe('failed'))
  expect(classify).toHaveBeenCalledTimes(4)
  expect((await owner.view(id)).run?.inputTokens).toBe(48)
  expect((await owner.view(id)).counts).toEqual({ match: 3, review: 0, 'no-match': 0, pending: 6 })
})

it('previews draft rules without writing collections, runs, assessments or overrides', async () => {
  const id = await create()
  await refresh(id)
  const before = await db.literatureSmartAssessment.findMany()
  const preview = await catalog.transact({
    kind: 'preview-smart-collection',
    requestId: 'draft',
    description: formatSmartRule({
      description: '',
      inclusion: 'Changed unsaved rule',
      exclusion: ''
    }),
    scope: { kind: 'library' }
  })
  expect(preview.smartPreview?.rows[0]?.verdict).toBe('match')
  expect(classify.mock.calls.at(-1)?.[0].description).toContain('Changed unsaved rule')
  expect(await db.literatureSmartAssessment.findMany()).toEqual(before)
  expect(await db.literatureSmartRun.count()).toBe(1)
  expect(await db.literatureSmartOverride.count()).toBe(0)
  expect((await db.literatureCollection.findUniqueOrThrow({ where: { id } })).description).toBe(
    formatSmartRule({ description: '', inclusion: 'Original studies', exclusion: '' })
  )
})

it('cancels draft previews and never returns obsolete results', async () => {
  let finish!: () => void
  classify.mockImplementation(async () => {
    await new Promise<void>((resolve) => {
      finish = resolve
    })
    return {
      verdict: 'match',
      model: 'jev-1.13.0',
      confidence: 1,
      probabilities: { match: 1, 'no-match': 0, uncertain: 0 }
    }
  })
  const preview = owner.execute({
    kind: 'preview-smart-collection',
    requestId: 'draft',
    description: formatSmartRule({ description: '', inclusion: 'Rule', exclusion: '' }),
    scope: { kind: 'library' }
  })
  const assertion = expect(preview).rejects.toThrow()
  await vi.waitFor(() => expect(classify).toHaveBeenCalledTimes(1))
  await owner.execute({ kind: 'cancel-smart-preview', requestId: 'draft' })
  finish()
  await assertion
  expect(await db.literatureSmartAssessment.count()).toBe(0)
})

it('does not classify draft previews without a model or outside a valid scope', async () => {
  configured = false
  expect(
    (
      await owner.execute({
        kind: 'preview-smart-collection',
        requestId: 'none',
        description: formatSmartRule({ description: '', inclusion: 'Rule', exclusion: '' }),
        scope: { kind: 'library' }
      })
    ).smartPreview?.configured
  ).toBe(false)
  configured = true
  await expect(
    owner.execute({
      kind: 'preview-smart-collection',
      requestId: 'scope',
      description: formatSmartRule({ description: '', inclusion: 'Rule', exclusion: '' }),
      scope: { kind: 'collection', id: 'missing' }
    })
  ).rejects.toThrow('unavailable')
  expect(classify).not.toHaveBeenCalled()
})

it('keeps legacy evidence defaults and invalidates results only when the evidence mode changes', async () => {
  const id = await create()
  await refresh(id)
  expect(await owner.view(id)).toMatchObject({ evidenceMode: 'abstract', autoUpdate: false })
  await catalog.transact({
    kind: 'update-collection',
    collectionId: id,
    expectedRevision: 1,
    name: 'Research',
    description: formatSmartRule({ description: '', inclusion: 'Original studies', exclusion: '' }),
    smartEvidenceMode: 'full-text'
  })
  expect((await owner.view(id)).rows[0]).toMatchObject({ verdict: 'stale', reason: 'rule-changed' })
  await refresh(id)
  expect((await owner.view(id)).rows[0]?.assessment?.evidence).toEqual({ coverage: 'unavailable' })
  expect(classify).toHaveBeenLastCalledWith(
    expect.objectContaining({ evidence: { coverage: 'unavailable', passages: [] } })
  )
})

it('uses primary PDF evidence without an abstract, saves the selected original passage and invalidates replaced versions', async () => {
  await db.literatureItem.update({ where: { id: 'paper' }, data: { abstract: '' } })
  const attachment = await db.literatureAttachment.create({ data: { itemId: 'paper' } })
  const addVersion = async (versionNumber: number): Promise<{ id: string; checksum: string }> => {
    const blob = await db.contentBlob.create({
      data: {
        id: `blob-${versionNumber}`,
        checksum: String(versionNumber).repeat(64),
        sizeBytes: 42n,
        storageKey: `paper-${versionNumber}.pdf`,
        state: 'available'
      }
    })
    return db.literatureAttachmentVersion.create({
      data: {
        attachmentId: attachment.id,
        contentBlobId: blob.id,
        versionNumber,
        filename: 'paper.pdf',
        contentType: 'application/pdf',
        checksum: blob.checksum,
        sizeBytes: 42n
      }
    })
  }
  const version = await addVersion(1)
  const passage = {
    pageStart: 2,
    pageEnd: 2,
    content: 'Adults were randomly assigned to treatment.'
  }
  const read = vi.fn().mockResolvedValue({ coverage: 'full-text', passages: [passage] })
  const evidenceOwner = new LiteratureSmartCollections(
    async () => db,
    {
      snapshot: async () => ({
        revision: 1,
        services: [{ id: serviceId, name: 'Test', adapter: 'typesafe', configured: true }],
        availableProviders: [],
        smartCollections: { serviceId, modelId: 'jev-latest' }
      }),
      classifyLiterature: classify
    },
    () => undefined,
    read
  )
  await owner.dispose()
  owner = evidenceOwner
  classify.mockResolvedValue({
    verdict: 'match',
    model: 'jev-1.13.0',
    confidence: 1,
    probabilities: { match: 1, 'no-match': 0, uncertain: 0 },
    evidenceIndex: 0
  })
  const { id } = await owner.execute({
    kind: 'create-smart-collection',
    name: 'Full text',
    description: formatSmartRule({ description: '', inclusion: 'Adult trials', exclusion: '' }),
    scope: { kind: 'library' },
    evidenceMode: 'full-text'
  })
  await refresh(id)
  expect(read).toHaveBeenCalledWith(
    expect.objectContaining({ attachmentVersionId: version.id, checksum: version.checksum })
  )
  expect((await owner.view(id)).rows[0]?.assessment?.evidence).toEqual({
    coverage: 'full-text',
    attachmentVersionId: version.id,
    filename: 'paper.pdf',
    passage
  })
  expect(classify).toHaveBeenCalledOnce()
  await addVersion(2)
  expect((await owner.view(id)).rows[0]).toMatchObject({
    verdict: 'stale',
    reason: 'input-changed'
  })
  expect(classify).toHaveBeenCalledOnce()
})

it('debounces automatic changes, skips unchanged results and preserves explicit decisions', async () => {
  const { id } = await owner.execute({
    kind: 'create-smart-collection',
    name: 'Automatic',
    description: formatSmartRule({ description: '', inclusion: 'Original studies', exclusion: '' }),
    scope: { kind: 'library' },
    autoUpdate: true
  })
  owner.schedule()
  owner.schedule()
  await vi.waitFor(async () => expect((await owner.view(id)).matches).toBe(1), { timeout: 5000 })
  expect(classify).toHaveBeenCalledOnce()
  const runs = await db.literatureSmartRun.count()
  owner.schedule()
  await new Promise((resolve) => setTimeout(resolve, 1100))
  expect(await db.literatureSmartRun.count()).toBe(runs)
  await catalog.transact({
    kind: 'update-item',
    itemId: 'paper',
    expectedMetadataRevision: 1,
    item: literatureItemInputSchema.parse({
      itemType: 'journalArticle',
      title: 'Research',
      abstract: 'Updated methods'
    })
  })
  await vi.waitFor(() => expect(classify).toHaveBeenCalledTimes(2), { timeout: 5000 })
  await vi.waitFor(async () => expect((await owner.view(id)).run?.state).toBe('completed'))
  await owner.execute({
    kind: 'smart-collection',
    action: 'override',
    offset: 0,
    collectionId: id,
    itemId: 'paper',
    decision: 'exclude'
  })
  await db.literatureItem.update({ where: { id: 'paper' }, data: { abstract: 'Another change' } })
  owner.schedule()
  await new Promise((resolve) => setTimeout(resolve, 1100))
  expect(classify).toHaveBeenCalledTimes(2)
  expect((await owner.view(id)).rows[0]?.override).toBe('exclude')
})

it('does not automatically repeat a failed input, but accepts changed evidence', async () => {
  classify.mockRejectedValueOnce(new ClassificationEvaluationError('service'))
  const { id } = await owner.execute({
    kind: 'create-smart-collection',
    name: 'Automatic',
    description: formatSmartRule({ description: '', inclusion: 'Original studies', exclusion: '' }),
    scope: { kind: 'library' },
    autoUpdate: true
  })
  await vi.waitFor(async () => expect((await owner.view(id)).run?.state).toBe('failed'), {
    timeout: 5000
  })
  owner.schedule()
  await new Promise((resolve) => setTimeout(resolve, 1100))
  expect(classify).toHaveBeenCalledOnce()
  await db.literatureItem.update({ where: { id: 'paper' }, data: { abstract: 'New evidence' } })
  owner.schedule()
  await vi.waitFor(async () => expect((await owner.view(id)).matches).toBe(1), { timeout: 5000 })
  expect(classify).toHaveBeenCalledTimes(2)
})

it('reads full-text freshness in batches without per-paper attachment lookups', async () => {
  await db.literatureItem.createMany({
    data: Array.from({ length: 2000 }, (_, n) => ({
      id: `full-${n}`,
      itemType: 'journalArticle',
      title: `Paper ${n}`,
      abstract: 'Study'
    }))
  })
  const { id } = await owner.execute({
    kind: 'create-smart-collection',
    name: 'Full scope',
    description: formatSmartRule({ description: '', inclusion: 'Studies', exclusion: '' }),
    scope: { kind: 'library' },
    evidenceMode: 'full-text'
  })
  const lookup = vi.spyOn(db.literatureAttachment, 'findFirst')
  try {
    const start = performance.now()
    const view = await owner.view(id)
    const viewMs = Math.round(performance.now() - start)
    expect(view.total).toBe(2001)
    expect(view.counts.pending).toBe(2001)
    expect(classify).not.toHaveBeenCalled()
    process.stdout.write(
      JSON.stringify({
        fullTextFreshness: {
          references: view.total,
          viewMs,
          perPaperLookups: lookup.mock.calls.length
        }
      }) + '\n'
    )
    expect(lookup).not.toHaveBeenCalled()
  } finally {
    lookup.mockRestore()
  }
})

it('does not start queued automatic inference after automatic updates are disabled', async () => {
  let release!: () => void
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  classify.mockImplementationOnce(async () => {
    await blocked
    return {
      verdict: 'match',
      model: 'jev-1.13.0',
      confidence: 1,
      probabilities: { match: 1, 'no-match': 0, uncertain: 0 }
    }
  })
  const first = await create()
  await owner.execute({
    kind: 'smart-collection',
    collectionId: first,
    action: 'refresh',
    offset: 0
  })
  try {
    await vi.waitFor(() => expect(classify).toHaveBeenCalledOnce())
    const { id } = await owner.execute({
      kind: 'create-smart-collection',
      name: 'Queued automatic',
      description: formatSmartRule({
        description: '',
        inclusion: 'Original studies',
        exclusion: ''
      }),
      scope: { kind: 'library' },
      autoUpdate: true
    })
    await vi.waitFor(async () => expect((await owner.view(id)).run?.state).toBe('queued'), {
      timeout: 5000
    })
    await catalog.transact({
      kind: 'update-collection',
      collectionId: id,
      expectedRevision: 1,
      name: 'Queued automatic',
      description: formatSmartRule({
        description: '',
        inclusion: 'Original studies',
        exclusion: ''
      }),
      smartAutoUpdate: false
    })
    release()
    await vi.waitFor(async () => expect((await owner.view(id)).run?.state).toBe('cancelled'))
    expect(classify).toHaveBeenCalledOnce()
    expect((await owner.view(id)).counts.pending).toBe(1)
    await refresh(id)
    expect(classify).toHaveBeenCalledTimes(2)
  } finally {
    release()
  }
})

it.each(['override', 'reset-overrides'] as const)(
  'resumes opted-in evaluation after %s clears a manual decision',
  async (action) => {
    const { id } = await owner.execute({
      kind: 'create-smart-collection',
      name: 'Automatic review',
      description: formatSmartRule({
        description: '',
        inclusion: 'Original studies',
        exclusion: ''
      }),
      scope: { kind: 'library' },
      autoUpdate: true
    })
    await owner.execute({
      kind: 'smart-collection',
      collectionId: id,
      action: 'override',
      itemId: 'paper',
      decision: 'exclude',
      offset: 0
    })
    await new Promise((resolve) => setTimeout(resolve, 1000))
    expect(classify).not.toHaveBeenCalled()
    await owner.execute({
      kind: 'smart-collection',
      collectionId: id,
      action,
      ...(action === 'override' ? { itemId: 'paper', decision: 'automatic' as const } : {}),
      offset: 0
    })
    await vi.waitFor(async () => expect((await owner.view(id)).matches).toBe(1), { timeout: 5000 })
    expect(classify).toHaveBeenCalledOnce()
    expect(await owner.members(id)).toEqual(['paper'])
  }
)

it('does not repeat a current assessment when restoring an automatic decision', async () => {
  const { id } = await owner.execute({
    kind: 'create-smart-collection',
    name: 'Automatic review',
    description: formatSmartRule({ description: '', inclusion: 'Original studies', exclusion: '' }),
    scope: { kind: 'library' },
    autoUpdate: true
  })
  await vi.waitFor(async () => expect((await owner.view(id)).matches).toBe(1), { timeout: 5000 })
  const runs = await db.literatureSmartRun.count()
  await owner.execute({
    kind: 'smart-collection',
    collectionId: id,
    action: 'override',
    itemId: 'paper',
    decision: 'exclude',
    offset: 0
  })
  expect(await owner.members(id)).toEqual([])
  await owner.execute({
    kind: 'smart-collection',
    collectionId: id,
    action: 'override',
    itemId: 'paper',
    decision: 'automatic',
    offset: 0
  })
  await new Promise((resolve) => setTimeout(resolve, 1000))
  expect(classify).toHaveBeenCalledOnce()
  expect(await db.literatureSmartRun.count()).toBe(runs)
  expect(await owner.members(id)).toEqual(['paper'])
})

it('keeps restored decisions pending when automatic updates are off', async () => {
  const id = await create()
  await owner.execute({
    kind: 'smart-collection',
    collectionId: id,
    action: 'override',
    itemId: 'paper',
    decision: 'include',
    offset: 0
  })
  await owner.execute({
    kind: 'smart-collection',
    collectionId: id,
    action: 'reset-overrides',
    offset: 0
  })
  await new Promise((resolve) => setTimeout(resolve, 1000))
  expect(classify).not.toHaveBeenCalled()
  expect((await owner.view(id)).counts.pending).toBe(1)
  expect(await db.literatureSmartRun.count()).toBe(0)
})

it('reuses scan digests, shares concurrent reads and writes progress once per four results', async () => {
  await db.literatureItem.createMany({
    data: Array.from({ length: 8 }, (_, i) => ({
      id: `perf-${i}`,
      itemType: 'journalArticle',
      title: `Study ${i}`,
      normalizedTitle: `study ${i}`,
      abstract: 'Research'
    }))
  })
  const id = await create()
  const scan = vi.spyOn(db.literatureItem, 'findMany')
  const members = await Promise.all([owner.members(id), owner.members(id)])
  expect(members).toEqual([[], []])
  expect(scan).not.toHaveBeenCalled() // Reuse the completed scan from create().
  await db.literatureItem.update({ where: { id: 'paper' }, data: { abstract: 'Changed evidence' } })
  await Promise.all([owner.members(id), owner.members(id)])
  expect(scan).toHaveBeenCalledTimes(1)
  scan.mockRestore()
  const lookup = vi.spyOn(db.literatureItem, 'findUniqueOrThrow')
  const writes = vi.spyOn(db.literatureSmartRun, 'update')
  await refresh(id)
  expect(lookup).not.toHaveBeenCalled()
  const progressWrites = writes.mock.calls.filter(
    ([arg]) => arg.data.updatedAt !== undefined && arg.data.state === undefined
  )
  expect(progressWrites).toHaveLength(3)
  expect(await owner.members(id)).toHaveLength(9)
  const summary = await owner.execute({
    kind: 'smart-collection',
    collectionId: id,
    action: 'read',
    summaryOnly: true,
    offset: 0
  })
  expect(summary.smart).toMatchObject({ total: 9, matches: 9, rows: [] })
  lookup.mockRestore()
  writes.mockRestore()
})

it('publishes each committed result without waiting for slow peers, including the trailing update', async () => {
  await db.literatureItem.createMany({
    data: Array.from({ length: 3 }, (_, i) => ({
      id: `stream-${i}`,
      itemType: 'journalArticle',
      title: `Study ${i}`,
      normalizedTitle: `study ${i}`,
      abstract: 'Research'
    }))
  })
  const releases: Array<() => void> = []
  classify.mockImplementation(async () => {
    await new Promise<void>((resolve) => releases.push(resolve))
    return {
      verdict: 'match',
      model: 'jev-1.13.0',
      confidence: 1,
      probabilities: { match: 1, 'no-match': 0, uncertain: 0 }
    }
  })
  const id = await create()
  // Keep both commits inside the throttle window; the real trailing timer must still fire.
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
  try {
    await owner.execute({
      kind: 'smart-collection',
      collectionId: id,
      action: 'refresh',
      offset: 0
    })
    await vi.waitFor(() => expect(releases).toHaveLength(4))
    changed.mockClear()
    releases[0]!()
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1))
    expect((await owner.view(id)).run).toMatchObject({ state: 'running', done: 1 })
    releases[1]!()
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(2))
    expect((await owner.view(id)).run).toMatchObject({ state: 'running', done: 2 })
    expect(classify).toHaveBeenCalledTimes(4)
  } finally {
    clock.mockRestore()
    for (const release of releases) release()
  }
  await vi.waitFor(async () => expect((await owner.view(id)).run?.state).toBe('completed'))
})

it('refills idle inference slots while a slow request is still running', async () => {
  await db.literatureItem.createMany({
    data: Array.from({ length: 5 }, (_, i) => ({
      id: `rolling-${i}`,
      itemType: 'journalArticle',
      title: `Study ${i}`,
      normalizedTitle: `study ${i}`,
      abstract: 'Research'
    }))
  })
  let release!: () => void
  const slow = new Promise<void>((resolve) => {
    release = resolve
  })
  const answer = {
    verdict: 'match' as const,
    model: 'jev-1.13.0',
    confidence: 1,
    probabilities: { match: 1, 'no-match': 0, uncertain: 0 }
  }
  classify.mockImplementation(async ({ title }) => {
    if (title === 'Research') await slow
    return answer
  })
  const id = await create()
  try {
    await owner.execute({
      kind: 'smart-collection',
      collectionId: id,
      action: 'refresh',
      offset: 0
    })
    await vi.waitFor(() => expect(classify).toHaveBeenCalledTimes(6))
    expect((await owner.view(id)).run?.state).toBe('running')
  } finally {
    release()
  }
  await vi.waitFor(async () => expect((await owner.view(id)).run?.state).toBe('completed'))
})

it('lets draft preview use a free slot before a long formal run ends, with four calls globally', async () => {
  let release!: () => void
  const slow = new Promise<void>((resolve) => {
    release = resolve
  })
  let active = 0,
    peak = 0
  const answer = {
    verdict: 'match' as const,
    model: 'jev-1.13.0',
    confidence: 1,
    probabilities: { match: 1, 'no-match': 0, uncertain: 0 }
  }
  classify.mockImplementation(async ({ description }) => {
    active++
    peak = Math.max(peak, active)
    try {
      if (description.includes('Original studies')) await slow
      return answer
    } finally {
      active--
    }
  })
  const id = await create()
  try {
    await owner.execute({
      kind: 'smart-collection',
      collectionId: id,
      action: 'refresh',
      offset: 0
    })
    await vi.waitFor(() => expect(classify).toHaveBeenCalledOnce())
    const preview = await owner.execute({
      kind: 'preview-smart-collection',
      requestId: 'concurrent-preview',
      description: formatSmartRule({ description: '', inclusion: 'Preview rule', exclusion: '' }),
      scope: { kind: 'library' }
    })
    expect(preview.smartPreview?.rows).toHaveLength(1)
    expect((await owner.view(id)).run?.state).toBe('running')
    expect(peak).toBeLessThanOrEqual(4)
  } finally {
    release()
  }
  await vi.waitFor(async () => expect((await owner.view(id)).run?.state).toBe('completed'))
})

it('hands all four inference slots to queued previews and reuses full capacity afterwards', async () => {
  const releases: Array<() => void> = []
  let active = 0
  let peak = 0
  classify.mockImplementation(async () => {
    active++
    peak = Math.max(peak, active)
    try {
      await new Promise<void>((resolve) => {
        releases.push(resolve)
      })
      return {
        verdict: 'match',
        confidence: 1,
        model: 'fixture',
        probabilities: { match: 1, 'no-match': 0, uncertain: 0 }
      }
    } finally {
      active--
    }
  })
  const preview = (index: number): ReturnType<typeof owner.execute> =>
    owner.execute({
      kind: 'preview-smart-collection',
      requestId: `queued-preview-${index}`,
      description: formatSmartRule({
        description: '',
        inclusion: 'Original studies',
        exclusion: ''
      }),
      scope: { kind: 'library' }
    })
  let work: Array<ReturnType<typeof owner.execute>> = []
  try {
    work = Array.from({ length: 12 }, (_, index) => preview(index))
    for (let wave = 0; wave < 3; wave++) {
      await vi.waitFor(() => expect(classify).toHaveBeenCalledTimes((wave + 1) * 4))
      expect(active).toBe(4)
      releases.splice(0).forEach((release) => release())
    }
    await Promise.all(work)
    expect(active).toBe(0)
    work = Array.from({ length: 4 }, (_, index) => preview(index + 12))
    await vi.waitFor(() => expect(classify).toHaveBeenCalledTimes(16))
    expect(active).toBe(4)
    expect(peak).toBe(4)
  } finally {
    classify.mockResolvedValue({
      verdict: 'match',
      confidence: 1,
      model: 'fixture',
      probabilities: { match: 1, 'no-match': 0, uncertain: 0 }
    })
    releases.splice(0).forEach((release) => release())
    await Promise.allSettled(work)
  }
})

it('drains started calls and retries saving their usage after a progress write fails', async () => {
  await db.literatureItem.createMany({
    data: Array.from({ length: 8 }, (_, i) => ({
      id: `write-${i}`,
      itemType: 'journalArticle',
      title: `Study ${i}`,
      normalizedTitle: `study ${i}`,
      abstract: 'Research'
    }))
  })
  classify.mockImplementation(async ({ observeUsage }) => {
    observeUsage?.({
      eventId: 'fixture',
      providerId: 'test',
      model: 'jev-1.13.0',
      usage: { inputTokens: 5, outputTokens: 1, cacheTokens: 0 }
    })
    return {
      verdict: 'match',
      model: 'jev-1.13.0',
      confidence: 1,
      probabilities: { match: 1, 'no-match': 0, uncertain: 0 }
    }
  })
  const update = db.literatureSmartRun.update.bind(db.literatureSmartRun)
  let failed = false
  const writes = vi.spyOn(db.literatureSmartRun, 'update').mockImplementation((args) => {
    if (!failed && args.data.updatedAt !== undefined) {
      failed = true
      throw new Error('Temporary database write failure')
    }
    return update(args)
  })
  try {
    const id = await create()
    await owner.execute({
      kind: 'smart-collection',
      collectionId: id,
      action: 'refresh',
      offset: 0
    })
    await vi.waitFor(async () => expect((await owner.view(id)).run?.state).toBe('failed'))
    expect(classify.mock.calls.length).toBeLessThan(9)
    const run = (await owner.view(id)).run!
    expect(run.inputTokens).toBe(classify.mock.calls.length * 5)
    expect(run.outputTokens).toBe(classify.mock.calls.length)
  } finally {
    writes.mockRestore()
  }
})

it('reads only requested decisions through the catalog without scanning the whole scope', async () => {
  const id = await create()
  await refresh(id)
  await db.literatureItem.createMany({
    data: Array.from({ length: 250 }, (_, i) => ({
      id: `unrelated-${i}`,
      itemType: 'journalArticle',
      title: `Other ${i}`,
      normalizedTitle: `other ${i}`
    }))
  })
  const scan = vi.spyOn(db.literatureItem, 'findMany')
  try {
    const result = await catalog.transact({
      kind: 'read-smart-decisions',
      collectionId: id,
      itemIds: ['paper']
    })
    expect(result.smart).toBeUndefined()
    expect(result.smartDecisions).toMatchObject([{ id: 'paper', verdict: 'match' }])
    expect(scan).toHaveBeenCalledTimes(1)
    expect(scan.mock.calls[0][0]?.where).toMatchObject({ AND: [{}, { id: { in: ['paper'] } }] })
    expect(classify).toHaveBeenCalledOnce()
    await db.literatureItem.update({ where: { id: 'paper' }, data: { deletedAt: new Date() } })
    expect(
      (
        await catalog.transact({
          kind: 'read-smart-decisions',
          collectionId: id,
          itemIds: ['paper']
        })
      ).smartDecisions
    ).toEqual([])
  } finally {
    scan.mockRestore()
  }
})

it('commits completion with the assessment before an aggregate flush and retains it after interruption', async () => {
  await db.literatureItem.createMany({
    data: Array.from({ length: 3 }, (_, i) => ({
      id: `slow-${i}`,
      itemType: 'journalArticle',
      title: `Slow ${i}`,
      normalizedTitle: `slow ${i}`,
      abstract: 'Research'
    }))
  })
  let release!: () => void
  const slow = new Promise<void>((resolve) => {
    release = resolve
  })
  classify.mockImplementation(async ({ title, observeUsage }) => {
    if (title.startsWith('Slow')) await slow
    observeUsage?.({
      eventId: title,
      providerId: 'test',
      model: 'jev-1.13.0',
      usage: { inputTokens: 7, outputTokens: 2, cacheTokens: 0 }
    })
    return {
      verdict: 'match',
      model: 'jev-1.13.0',
      confidence: 1,
      probabilities: { match: 1, 'no-match': 0, uncertain: 0 }
    }
  })
  const id = await create()
  let saved!: { id: string }
  try {
    await owner.execute({
      kind: 'smart-collection',
      collectionId: id,
      action: 'refresh',
      offset: 0
    })
    await vi.waitFor(async () => {
      saved = await db.literatureSmartRun.findFirstOrThrow({ where: { collectionId: id } })
      expect(
        (
          await db.literatureSmartRunItem.findUniqueOrThrow({
            where: { runId_itemId: { runId: saved.id, itemId: 'paper' } }
          })
        ).state
      ).toBe('done')
    })
    expect(await db.literatureSmartAssessment.count({ where: { collectionId: id } })).toBe(1)
    expect((await owner.view(id)).run).toMatchObject({
      state: 'running',
      done: 1,
      inputTokens: 7,
      outputTokens: 2
    })
    await owner.execute({ kind: 'smart-collection', collectionId: id, action: 'cancel', offset: 0 })
  } finally {
    release()
    await owner.dispose()
  }
  // Restore the exact durable progress observed before any aggregate flush, as after a crash.
  await db.literatureSmartRun.update({
    where: { id: saved.id },
    data: { state: 'running' }
  })
  expect(await owner.view(id)).toMatchObject({
    matches: 1,
    pending: 3,
    run: { state: 'interrupted', done: 1, usageIncomplete: false }
  })
})

it('rolls back an assessment when its atomic completion marker cannot be written', async () => {
  const id = await create()
  await db.$executeRawUnsafe(`CREATE TRIGGER reject_smart_completion BEFORE UPDATE OF state ON LiteratureSmartRunItem
    WHEN NEW.state = 'done'
    BEGIN SELECT RAISE(ABORT, 'fixture completion failure'); END`)
  try {
    await owner.execute({
      kind: 'smart-collection',
      collectionId: id,
      action: 'refresh',
      offset: 0
    })
    await vi.waitFor(async () => expect((await owner.view(id)).run?.state).toBe('failed'))
    expect(await db.literatureSmartAssessment.count({ where: { collectionId: id } })).toBe(0)
    expect((await owner.decisions(id, ['paper']))[0]?.verdict).toBe('error')
  } finally {
    await db.$executeRawUnsafe('DROP TRIGGER reject_smart_completion')
  }
})

it('hydrates smart member counts only for global-search collections on the requested page', async () => {
  for (let i = 0; i < 3; i++)
    await owner.execute({
      kind: 'create-smart-collection',
      name: `Search fixture ${i}`,
      description: formatSmartRule({
        description: '',
        inclusion: 'Original studies',
        exclusion: ''
      }),
      scope: { kind: 'library' }
    })
  await catalog.transact({ kind: 'create-collection', name: 'Ordinary fixture' })
  const members = vi.spyOn(owner, 'members')
  try {
    const request = {
      scope: 'global-search' as const,
      entryKind: 'collection' as const,
      query: 'Search fixture',
      limit: 1
    }
    const first = await catalog.search(request)
    expect(first.totalCount).toBe(3)
    expect(first.entries).toHaveLength(1)
    expect(members).toHaveBeenCalledTimes(1)
    expect(first.entries[0]).toMatchObject({ id: members.mock.calls[0][0] })
    members.mockClear()
    const second = await catalog.search({ ...request, offset: 1 })
    expect(second.entries[0]).not.toEqual(first.entries[0])
    expect(members).toHaveBeenCalledTimes(1)
    expect(second.entries[0]).toMatchObject({ id: members.mock.calls[0][0] })
    members.mockClear()
    expect((await catalog.search({ ...request, countOnly: true })).totalCount).toBe(3)
    expect(members).not.toHaveBeenCalled()
    const ordinary = await catalog.search({ ...request, query: 'Ordinary fixture' })
    expect(ordinary.entries).toMatchObject([{ smart: false, itemCount: 0 }])
    expect(members).not.toHaveBeenCalled()
  } finally {
    members.mockRestore()
  }
})

it('restricts project membership scans before reading papers and isolates concurrent project queries', async () => {
  await db.literatureItem.create({
    data: {
      id: 'other-paper',
      title: 'Other',
      normalizedTitle: 'other',
      itemType: 'journalArticle'
    }
  })
  await db.project.createMany({
    data: [
      { id: 'project-a', name: 'A' },
      { id: 'project-b', name: 'B' }
    ]
  })
  await db.projectLiterature.createMany({
    data: [
      { projectId: 'project-a', itemId: 'paper', source: 'manual' },
      { projectId: 'project-b', itemId: 'other-paper', source: 'manual' }
    ]
  })
  const a = await create()
  const b = (
    await owner.execute({
      kind: 'create-smart-collection',
      name: 'Other collection',
      description: formatSmartRule({ description: '', inclusion: 'Other studies', exclusion: '' }),
      scope: { kind: 'library' }
    })
  ).id
  for (const [collectionId, itemId] of [
    [a, 'paper'],
    [b, 'other-paper']
  ])
    await owner.execute({
      kind: 'smart-collection',
      collectionId,
      action: 'override',
      itemId,
      decision: 'include',
      offset: 0
    })
  const scans = vi.spyOn(db.literatureItem, 'findMany')
  const followups = vi.spyOn(db.projectLiterature, 'count')
  try {
    const [projectA, projectB] = await Promise.all([
      owner.matchingCollections(undefined, 'project-a'),
      owner.matchingCollections(undefined, 'project-b')
    ])
    expect(projectA).toEqual([a])
    expect(projectB).toEqual([b])
    expect(scans).toHaveBeenCalledTimes(4)
    for (const [request] of scans.mock.calls)
      expect(request?.where).toMatchObject({
        AND: expect.arrayContaining([
          { projects: { some: { projectId: expect.stringMatching(/^project-[ab]$/) } } }
        ])
      })
    expect(followups).not.toHaveBeenCalled()
    expect(await owner.matchingCollections('paper', 'project-b')).toEqual([])
    await db.project.update({ where: { id: 'project-a' }, data: { deletedAt: new Date() } })
    expect(await owner.matchingCollections(undefined, 'project-a')).toEqual([])
  } finally {
    scans.mockRestore()
    followups.mockRestore()
  }
})

it('throttles fast progress events without delaying terminal state or dropping assessments', async () => {
  await db.literatureItem.createMany({
    data: Array.from({ length: 19 }, (_, index) => ({
      id: `fast-${index}`,
      itemType: 'journalArticle',
      title: `Study ${index}`,
      normalizedTitle: `study ${index}`,
      abstract: 'Original study'
    }))
  })
  const id = await create()
  changed.mockClear()
  let resume!: () => void
  const gate = new Promise<void>((resolve) => {
    resume = resolve
  })
  let started = 0
  classify.mockImplementation(async () => {
    if (++started > 4) await gate
    return {
      verdict: 'match',
      confidence: 1,
      model: 'fixture',
      probabilities: { match: 1, 'no-match': 0, uncertain: 0 }
    }
  })
  const notifications: number[] = []
  changed.mockImplementation(() => notifications.push(performance.now()))
  try {
    const pending = refresh(id)
    try {
      await vi.waitFor(() => expect(changed).toHaveBeenCalled())
      await vi.waitFor(async () =>
        expect((await owner.view(id)).run).toMatchObject({ state: 'running', done: 4 })
      )
    } finally {
      resume()
    }
    await pending
    // Progress is time-throttled, while the final notification is unconditional.
    expect(notifications.length).toBeGreaterThanOrEqual(2)
    expect(notifications.length).toBeLessThan(20)
    for (let i = 1; i < notifications.length - 1; i++)
      expect(notifications[i]! - notifications[i - 1]!).toBeGreaterThanOrEqual(240)
    expect(await owner.members(id)).toHaveLength(20)
    expect((await owner.view(id)).run).toMatchObject({ state: 'completed', done: 20 })
  } finally {
    changed.mockReset()
  }
})

it('invalidates completed scans for external commits and model availability; bypasses transactions', async () => {
  const id = await create()
  await refresh(id)
  expect(await owner.members(id)).toEqual(['paper'])
  const external = createProjectDbClient(root)
  try {
    await external.literatureItem.update({
      where: { id: 'paper' },
      data: { abstract: 'External edit' }
    })
    expect(await owner.members(id)).toEqual([])
    expect((await owner.view(id)).counts.review).toBe(1)
  } finally {
    await external.$disconnect()
  }
  configured = false
  expect((await owner.view(id)).configured).toBe(false)
  configured = true
  expect((await owner.view(id)).configured).toBe(true)
  await expect(
    db.$transaction(async (tx) => {
      await tx.literatureSmartOverride.create({
        data: { collectionId: id, itemId: 'paper', decision: 'include' }
      })
      expect(await owner.members(id, tx)).toEqual(['paper'])
      throw new Error('rollback')
    })
  ).rejects.toThrow('rollback')
  expect(await owner.members(id)).toEqual([])
})

it('bounds completed scope scans and evicts the least recently used entry', async () => {
  const ids: string[] = []
  for (let i = 0; i < 5; i++)
    ids.push(
      (
        await owner.execute({
          kind: 'create-smart-collection',
          name: `Cache ${i}`,
          description: formatSmartRule({
            description: '',
            inclusion: 'Original studies',
            exclusion: ''
          }),
          scope: { kind: 'library' }
        })
      ).id
    )
  for (const id of ids) await owner.members(id)
  const scan = vi.spyOn(db.literatureItem, 'findMany')
  try {
    await owner.members(ids[4])
    expect(scan).not.toHaveBeenCalled()
    await owner.members(ids[0])
    expect(scan).toHaveBeenCalledTimes(1)
  } finally {
    scan.mockRestore()
  }
})

it('does not cache a scope scan crossed by a concurrent write', async () => {
  const id = await create()
  await refresh(id)
  await db.literatureItem.update({ where: { id: 'paper' }, data: { title: 'New title' } })
  const findMany = db.literatureItem.findMany.bind(db.literatureItem)
  const scan = vi.spyOn(db.literatureItem, 'findMany').mockImplementationOnce((async (
    args: Parameters<typeof findMany>[0]
  ) => {
    const result = await findMany(args)
    await db.literatureItem.update({
      where: { id: 'paper' },
      data: { abstract: 'Changed during scan' }
    })
    return result
  }) as typeof db.literatureItem.findMany)
  try {
    await owner.members(id)
    scan.mockClear()
    await owner.members(id)
    expect(scan).toHaveBeenCalledTimes(1)
    await owner.members(id)
    expect(scan).toHaveBeenCalledTimes(1)
  } finally {
    scan.mockRestore()
  }
})

it('updates the model assessment under an explicit manual decision and snapshots run settings', async () => {
  const id = await create()
  await refresh(id)
  await owner.execute({
    kind: 'smart-collection',
    collectionId: id,
    action: 'override',
    itemId: 'paper',
    decision: 'exclude',
    offset: 0
  })
  const before = classify.mock.calls.length
  await owner.execute({
    kind: 'smart-collection',
    collectionId: id,
    action: 'recompute',
    itemIds: ['paper'],
    offset: 0
  })
  await vi.waitFor(async () => expect((await owner.view(id)).run?.state).toBe('completed'))
  expect(classify).toHaveBeenCalledTimes(before + 1)
  const view = await owner.view(id)
  expect(view.rows[0]).toMatchObject({
    override: 'exclude',
    verdict: 'no-match',
    assessment: { current: true, probabilities: { match: 1 } }
  })
  expect(view.run?.snapshot).toMatchObject({
    description: formatSmartRule({ description: '', inclusion: 'Original studies', exclusion: '' }),
    action: 'recompute',
    selectedCount: 1,
    evidenceMode: 'abstract'
  })
  await db.literatureCollection.update({
    where: { id },
    data: {
      description: formatSmartRule({ description: '', inclusion: 'Changed rule', exclusion: '' })
    }
  })
  expect((await owner.view(id)).run?.snapshot?.description).toBe(
    formatSmartRule({ description: '', inclusion: 'Original studies', exclusion: '' })
  )
})

it('commits override chunks without full scope scans and reports out-of-scope references separately', async () => {
  const id = await create()
  const scan = vi.spyOn(db.literatureItem, 'findMany')
  try {
    const receipt = await owner.execute({
      kind: 'smart-collection',
      collectionId: id,
      action: 'override',
      itemIds: ['paper'],
      decision: 'include',
      offset: 0
    })
    expect(receipt).toEqual({
      kind: 'collection',
      id,
      smartDecisionBatch: { saved: ['paper'], failed: [] }
    })
    expect(
      scan.mock.calls.every(([args]) => args?.select?.id === true && !args?.select?.abstract)
    ).toBe(true)
    const partial = await owner.execute({
      kind: 'smart-collection',
      collectionId: id,
      action: 'override',
      itemIds: ['paper', 'missing'],
      decision: 'exclude',
      offset: 0
    })
    expect(partial.smartDecisionBatch).toEqual({ saved: ['paper'], failed: ['missing'] })
    expect(await db.literatureSmartOverride.findFirst()).toMatchObject({ decision: 'exclude' })
    await owner.execute({
      kind: 'smart-collection',
      collectionId: id,
      action: 'override',
      itemIds: ['paper'],
      decision: 'automatic',
      offset: 0
    })
    expect(await db.literatureSmartOverride.count()).toBe(0)
  } finally {
    scan.mockRestore()
  }
})

it('cancels a queued run immediately and accepts a retry while another collection is still running', async () => {
  const first = await create()
  const second = (
    await owner.execute({
      kind: 'create-smart-collection',
      name: 'Second',
      description: formatSmartRule({
        description: '',
        inclusion: 'Original studies',
        exclusion: ''
      }),
      scope: { kind: 'library' }
    })
  ).id
  let release!: (value: Awaited<ReturnType<typeof classify>>) => void
  classify.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve
      })
  )
  await owner.execute({
    kind: 'smart-collection',
    collectionId: first,
    action: 'refresh',
    offset: 0
  })
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  try {
    const queued = await owner.execute({
      kind: 'smart-collection',
      collectionId: second,
      action: 'refresh',
      offset: 0
    })
    expect(queued.smart?.run?.state).toBe('queued')
    expect(
      (
        await owner.execute({
          kind: 'smart-collection',
          collectionId: second,
          action: 'cancel',
          offset: 0
        })
      ).smart?.run?.state
    ).toBe('cancelled')
    const retry = await owner.execute({
      kind: 'smart-collection',
      collectionId: second,
      action: 'refresh',
      offset: 0
    })
    expect(retry.smart?.run?.id).not.toBe(queued.smart?.run?.id)
    expect(retry.smart?.run?.state).toBe('queued')
  } finally {
    release({
      verdict: 'match',
      confidence: 1,
      model: 'jev-1.13.0',
      probabilities: { match: 1, 'no-match': 0, uncertain: 0 }
    })
  }
  await vi.waitFor(async () => expect((await owner.view(second)).run?.state).toBe('completed'))
  expect(classify).toHaveBeenCalledTimes(2)
})

it('drains replacement work after a cancelled queued run releases its reservation', async () => {
  const first = await create()
  const second = (
    await owner.execute({
      kind: 'create-smart-collection',
      name: 'Replacement',
      description: formatSmartRule({
        description: '',
        inclusion: 'Original studies',
        exclusion: ''
      }),
      scope: { kind: 'library' }
    })
  ).id
  let releaseFirst!: () => void
  let releaseReplacement!: () => void
  const answer = {
    verdict: 'match' as const,
    confidence: 1,
    model: 'fixture',
    probabilities: { match: 1, 'no-match': 0, uncertain: 0 }
  }
  classify
    .mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        releaseFirst = resolve
      })
      return answer
    })
    .mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        releaseReplacement = resolve
      })
      return answer
    })
  const refresh = (collectionId: string): ReturnType<typeof owner.execute> =>
    owner.execute({
      kind: 'smart-collection',
      collectionId,
      action: 'refresh',
      offset: 0
    })
  await refresh(first)
  await vi.waitFor(() => expect(releaseFirst).toBeTypeOf('function'))
  try {
    await refresh(second)
    await owner.execute({
      kind: 'smart-collection',
      collectionId: second,
      action: 'cancel',
      offset: 0
    })
    await refresh(second)
    releaseFirst()
    await vi.waitFor(() => expect(releaseReplacement).toBeTypeOf('function'))
    let removed = false
    const deleting = owner.deleteCollection(second, async () => {
      removed = true
    })
    await vi.waitFor(() => expect(classify.mock.calls[1][0].signal?.aborted).toBe(true))
    // Let an incorrectly unblocked deletion finish before checking the drain contract.
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(removed).toBe(false)
    releaseReplacement()
    await deleting
    expect(removed).toBe(true)
    expect(classify).toHaveBeenCalledTimes(2)
  } finally {
    releaseFirst()
    releaseReplacement?.()
  }
})

it('measures cold and warm 10000-reference reads and large checkpoint updates without model requests', async () => {
  await db.literatureItem.createMany({
    data: Array.from({ length: 9999 }, (_, n) => ({
      id: `large-${n}`,
      itemType: 'journalArticle',
      title: `Study ${n}`,
      normalizedTitle: `study ${n}`,
      abstract: 'Scientific evidence '.repeat(50)
    }))
  })
  const id = await create()
  await db.literatureItem.update({ where: { id: 'paper' }, data: { title: 'Cold scan' } })
  const coldStart = performance.now()
  expect((await owner.view(id, 0, 'all', undefined, true)).total).toBe(10000)
  const coldMs = performance.now() - coldStart
  const warmStart = performance.now()
  expect((await owner.view(id, 0, 'all', undefined, true)).total).toBe(10000)
  const warmMs = performance.now() - warmStart
  const checkpoint = JSON.stringify(
    Array.from({ length: 10000 }, (_, n) => ({
      id: `large-${n}`,
      digest: 'a'.repeat(64),
      state: 'pending'
    }))
  )
  const run = await db.literatureSmartRun.create({
    data: {
      collectionId: id,
      kind: 'refresh',
      state: 'completed',
      ruleRevision: 1,
      policyKey: 'benchmark',
      items: {
        create: JSON.parse(checkpoint).map(
          ({ id, ...row }: { id: string; digest: string; state: string }) => ({
            itemId: id,
            ...row
          })
        )
      }
    }
  })
  const writeStart = performance.now()
  for (let n = 0; n < 100; n++)
    await db.literatureSmartRunItem.update({
      where: { runId_itemId: { runId: run.id, itemId: `large-${n}` } },
      data: { state: 'done' }
    })
  const writeMs = performance.now() - writeStart
  const progressStart = performance.now()
  const progress = await catalog.transact({
    kind: 'read-smart-run-progress',
    collectionId: id,
    runId: run.id
  })
  const progressMs = performance.now() - progressStart
  expect(progress.smartRunProgress?.candidates).toHaveLength(4)
  expect(progress.smartRunProgress?.outcomes.length).toBeLessThanOrEqual(24)
  await owner.view(id, 0, 'all', undefined, true)
  const warmRunSamples: number[] = []
  const checkpointRead = vi.spyOn(db.literatureSmartRunItem, 'findMany')
  for (let sample = 0; sample < 5; sample++) {
    const start = performance.now()
    const summary = await owner.view(id, 0, 'all', undefined, true)
    expect(summary.run).toMatchObject({ total: 10000, done: 100 })
    warmRunSamples.push(performance.now() - start)
  }
  const checkpointReadCount = checkpointRead.mock.calls.length
  expect(checkpointReadCount).toBe(0)
  checkpointRead.mockRestore()
  const saved = await db.literatureSmartRunItem.findMany({ where: { runId: run.id } })
  expect(saved.filter((row: { state: string }) => row.state === 'done')).toHaveLength(100)
  expect(classify).not.toHaveBeenCalled()
  process.stdout.write(
    JSON.stringify({
      smartLargeScopeBenchmark: {
        references: 10000,
        coldMs: Math.round(coldMs),
        warmMs: Math.round(warmMs),
        progressMs: Math.round(progressMs),
        warmRunMedianMs: Math.round(warmRunSamples.sort((a, b) => a - b)[2]!),
        checkpointReadCount,
        runItems: 10000,
        itemUpdates: 100,
        writeMs: Math.round(writeMs)
      }
    })
  )
}, 30000)

it('retains a warm scope cache through unrelated local writes', async () => {
  const id = await create()
  await owner.members(id)
  await db.$executeRawUnsafe('CREATE TABLE UnrelatedCacheTest (value TEXT)')
  const scans = vi.spyOn(db.literatureItem, 'findMany')
  try {
    await db.$executeRawUnsafe("INSERT INTO UnrelatedCacheTest VALUES ('unrelated update')")
    await owner.members(id)
    expect(scans).not.toHaveBeenCalled()
  } finally {
    scans.mockRestore()
  }
})

it('normalizes structured edits without treating JSON formatting as a rule change', async () => {
  const id = await create()
  await refresh(id)
  await catalog.transact({
    kind: 'update-collection',
    collectionId: id,
    expectedRevision: 1,
    name: 'Research',
    description: JSON.stringify(
      { exclusion: '', inclusion: 'Original studies', description: '' },
      null,
      2
    )
  })
  expect(
    (await db.literatureSmartCollection.findUniqueOrThrow({ where: { collectionId: id } }))
      .ruleRevision
  ).toBe(1)
  expect((await owner.view(id)).counts.match).toBe(1)
  await catalog.transact({
    kind: 'update-collection',
    collectionId: id,
    expectedRevision: 2,
    name: 'Research',
    description: formatSmartRule({
      description: 'Updated context',
      inclusion: 'x'.repeat(1500),
      exclusion: ''
    })
  })
  expect(
    (await db.literatureSmartCollection.findUniqueOrThrow({ where: { collectionId: id } }))
      .ruleRevision
  ).toBe(2)
  expect((await owner.view(id)).counts.review).toBe(1)
  const ordinary = await catalog.transact({ kind: 'create-collection', name: 'Ordinary notes' })
  await expect(
    catalog.transact({
      kind: 'update-collection',
      collectionId: ordinary.id,
      expectedRevision: 1,
      name: 'Ordinary notes',
      description: formatSmartRule({ description: '', inclusion: 'x'.repeat(1500), exclusion: '' })
    })
  ).rejects.toThrow('Collection description is too long.')
})

it('returns a saved receipt when the post-commit summary cannot be read', async () => {
  const id = await create()
  const read = vi.spyOn(owner, 'view').mockRejectedValueOnce(new Error('summary unavailable'))
  const receipt = await owner.execute({
    kind: 'smart-collection',
    collectionId: id,
    action: 'override',
    itemId: 'paper',
    decision: 'exclude',
    offset: 0
  })
  expect(receipt).toMatchObject({
    smartRefreshFailed: true,
    smartDecisionBatch: { saved: ['paper'], failed: [] }
  })
  read.mockRestore()
  expect((await owner.view(id)).rows[0].override).toBe('exclude')
})

it('keeps a committed reset successful when its summary fails, without masking read failures', async () => {
  const id = await create()
  await owner.execute({
    kind: 'smart-collection',
    collectionId: id,
    action: 'override',
    itemId: 'paper',
    decision: 'exclude',
    offset: 0
  })
  const read = vi.spyOn(owner, 'view').mockRejectedValue(new Error('summary unavailable'))
  expect(
    await owner.execute({
      kind: 'smart-collection',
      collectionId: id,
      action: 'reset-overrides',
      offset: 0
    })
  ).toMatchObject({ smartRefreshFailed: true })
  expect(await db.literatureSmartOverride.count({ where: { collectionId: id } })).toBe(0)
  await expect(
    owner.execute({ kind: 'smart-collection', collectionId: id, action: 'read', offset: 0 })
  ).rejects.toThrow('summary unavailable')
  read.mockRestore()
})

it('retains immutable rule versions and successful run results across edits and re-evaluation', async () => {
  const id = await create()
  await refresh(id)
  const original = await db.literatureSmartRunItem.findFirstOrThrow({
    where: { run: { collectionId: id }, state: 'done' }
  })
  const collection = await db.literatureCollection.findUniqueOrThrow({ where: { id } })
  await catalog.transact({
    kind: 'update-collection',
    collectionId: id,
    expectedRevision: collection.revision,
    name: collection.name,
    description: formatSmartRule({
      description: 'Updated scope',
      inclusion: 'Randomized trials',
      exclusion: 'Reviews'
    })
  })
  const versions = await db.literatureSmartRuleRevision.findMany({
    where: { collectionId: id },
    orderBy: { revision: 'asc' }
  })
  expect(versions.map((v) => v.inclusionCriteria)).toEqual([
    'Original studies',
    'Randomized trials'
  ])
  const stale = await owner.view(id)
  expect(stale.counts.review).toBe(1)
  expect(stale.rows[0]).toMatchObject({
    verdict: 'stale',
    reason: 'rule-changed',
    assessment: { ruleRevision: 1, currentRuleRevision: 2, current: false }
  })
  expect(JSON.parse(stale.rows[0].assessment!.rule!).inclusion).toBe('Original studies')
  await refresh(id)
  expect((await owner.view(id)).rows[0]).toMatchObject({
    verdict: 'match',
    assessment: { ruleRevision: 2, currentRuleRevision: 2, current: true }
  })
  expect(
    await db.literatureSmartRunItem.findUniqueOrThrow({
      where: { runId_itemId: { runId: original.runId, itemId: 'paper' } }
    })
  ).toEqual(original)
  const completed = await db.literatureSmartRunItem.findMany({
    where: { run: { collectionId: id }, state: 'done' },
    include: { run: { include: { rule: true } } }
  })
  expect(completed).toHaveLength(2)
  expect(completed.every((row) => JSON.parse(row.resultJson!).answer.verdict === 'match')).toBe(
    true
  )
  expect(new Set(completed.map((row) => row.run.rule.revision))).toEqual(new Set([1, 2]))
  const history = await catalog.transact({
    kind: 'read-smart-history',
    collectionId: id,
    itemId: 'paper',
    offset: 0
  })
  expect(history.smartHistory?.currentRevision).toBe(2)
  expect(history.smartHistory?.entries.map((entry) => entry.revision)).toEqual([2, 1])
  expect(JSON.parse(history.smartHistory!.entries[1].rule).inclusion).toBe('Original studies')
  expect(history.smartHistory?.nextOffset).toBeUndefined()
})

it('rejects late results after editing a running rule and retains the manual decision', async () => {
  const id = await create()
  await refresh(id)
  await owner.execute({
    kind: 'smart-collection',
    collectionId: id,
    action: 'override',
    itemId: 'paper',
    decision: 'include',
    offset: 0
  })
  let finish!: () => void
  const gate = new Promise<void>((resolve) => {
    finish = resolve
  })
  classify.mockImplementationOnce(async () => {
    await gate
    return {
      verdict: 'no-match',
      model: 'fixture',
      confidence: 1,
      probabilities: { match: 0, 'no-match': 1, uncertain: 0 }
    }
  })
  await owner.execute({
    kind: 'smart-collection',
    collectionId: id,
    action: 'recompute',
    itemIds: ['paper'],
    offset: 0
  })
  await vi.waitFor(() => expect(classify).toHaveBeenCalledTimes(2))
  const collection = await db.literatureCollection.findUniqueOrThrow({ where: { id } })
  await catalog.transact({
    kind: 'update-collection',
    collectionId: id,
    expectedRevision: collection.revision,
    name: collection.name,
    description: formatSmartRule({ description: '', inclusion: 'Changed rule', exclusion: '' })
  })
  finish()
  await vi.waitFor(async () => expect((await owner.view(id)).run?.state).toBe('cancelled'))
  expect((await owner.view(id)).rows[0]).toMatchObject({
    verdict: 'match',
    override: 'include',
    assessment: { ruleRevision: 1, current: false }
  })
  await owner.execute({
    kind: 'smart-collection',
    collectionId: id,
    action: 'override',
    itemId: 'paper',
    decision: 'automatic',
    offset: 0
  })
  expect((await owner.view(id)).rows[0]).toMatchObject({ verdict: 'stale', reason: 'rule-changed' })
  expect(
    await db.literatureSmartRunItem.count({
      where: { run: { collectionId: id }, resultJson: { not: null } }
    })
  ).toBe(1)
})

it('keeps previous-version results in review after a failed new evaluation and rolls back rejected rule edits', async () => {
  const id = await create()
  await refresh(id)
  const before = await db.literatureCollection.findUniqueOrThrow({ where: { id } })
  const edit = {
    kind: 'update-collection' as const,
    collectionId: id,
    expectedRevision: before.revision,
    name: before.name,
    description: formatSmartRule({ description: '', inclusion: 'New criteria', exclusion: '' })
  }
  await db.$executeRawUnsafe(
    `CREATE TRIGGER reject_rule_version BEFORE INSERT ON LiteratureSmartRuleRevision WHEN NEW.revision = 2 BEGIN SELECT RAISE(ABORT, 'storage failure'); END`
  )
  await expect(catalog.transact(edit)).rejects.toThrow()
  expect(await db.literatureCollection.findUniqueOrThrow({ where: { id } })).toEqual(before)
  expect(
    (await db.literatureSmartCollection.findUniqueOrThrow({ where: { collectionId: id } }))
      .ruleRevision
  ).toBe(1)
  await db.$executeRawUnsafe('DROP TRIGGER reject_rule_version')
  await catalog.transact(edit)
  await expect(catalog.transact(edit)).rejects.toThrow()
  expect(await db.literatureSmartRuleRevision.count({ where: { collectionId: id } })).toBe(2)
  classify.mockRejectedValueOnce(new ClassificationEvaluationError('network'))
  await owner.execute({ kind: 'smart-collection', collectionId: id, action: 'refresh', offset: 0 })
  await vi.waitFor(async () => expect((await owner.view(id)).run?.state).toBe('failed'))
  const view = await owner.view(id)
  expect(view.rows[0]).toMatchObject({
    verdict: 'stale',
    failure: 'network',
    assessment: { ruleRevision: 1, currentRuleRevision: 2, current: false }
  })
  expect(view.counts.review).toBe(1)
  expect(view.counts.pending).toBe(0)
})

it.each(['run-limit', 'daily-limit', 'storage-error'] as const)(
  'keeps automatic work pending after a %s guard and resumes explicitly',
  async (reason) => {
    const id = await create()
    await db.literatureSmartCollection.update({
      where: { collectionId: id },
      data: { autoUpdate: true }
    })
    classify.mockRejectedValueOnce(new AutomaticClassificationPausedError(reason))
    owner.schedule()
    await vi.waitFor(
      async () => {
        const view = await owner.view(id)
        expect(view.automaticPauseReason).toBe(reason)
        expect(view.run?.state).toBe('interrupted')
      },
      { timeout: 5000 }
    )
    expect(await db.literatureSmartRunItem.findMany()).toMatchObject([
      { state: 'pending', failure: null }
    ])
    expect((await owner.view(id)).rows[0].failure).toBeUndefined()
    owner.schedule()
    await new Promise((resolve) => setTimeout(resolve, 850))
    expect(classify).toHaveBeenCalledOnce()
    const pausedRunId = (await owner.view(id)).run!.id
    await owner.execute({
      kind: 'smart-collection',
      collectionId: id,
      action: 'resume-automatic',
      offset: 0
    })
    await vi.waitFor(async () => expect((await owner.view(id)).run?.state).toBe('completed'))
    expect((await owner.view(id)).automaticPauseReason).toBeUndefined()
    expect(classify).toHaveBeenCalledTimes(2)
    if (reason !== 'run-limit') expect((await owner.view(id)).run?.id).toBe(pausedRunId)
  }
)

it('abandons a paused automatic run without resuming it', async () => {
  const id = await create()
  await refresh(id)
  const run = await db.literatureSmartRun.findFirstOrThrow({
    where: { collectionId: id },
    orderBy: { createdAt: 'desc' }
  })
  await db.literatureSmartCollection.update({
    where: { collectionId: id },
    data: {
      autoUpdate: true,
      automaticPauseReason: 'run-limit',
      automaticPauseRunId: run.id
    }
  })
  await db.literatureSmartRun.update({ where: { id: run.id }, data: { state: 'cancelled' } })

  await owner.execute({
    kind: 'smart-collection',
    collectionId: id,
    action: 'abandon',
    runId: run.id,
    offset: 0
  })

  expect(await owner.view(id)).toMatchObject({
    automaticPauseReason: undefined,
    matches: 1,
    run: { id: run.id, state: 'cancelled', done: 1 }
  })
  expect(classify).toHaveBeenCalledOnce()
})

it('abandons a failed storage-error run and clears its durable pause', async () => {
  const id = await create()
  await refresh(id)
  const run = await db.literatureSmartRun.findFirstOrThrow({
    where: { collectionId: id },
    orderBy: { createdAt: 'desc' }
  })
  await db.literatureSmartRun.update({ where: { id: run.id }, data: { state: 'failed' } })
  await db.literatureSmartCollection.update({
    where: { collectionId: id },
    data: {
      autoUpdate: true,
      automaticPauseReason: 'storage-error',
      automaticPauseRunId: run.id
    }
  })

  await owner.execute({
    kind: 'smart-collection',
    collectionId: id,
    action: 'abandon',
    runId: run.id,
    offset: 0
  })

  expect(await owner.view(id)).toMatchObject({
    automaticPauseReason: undefined,
    matches: 1,
    run: { id: run.id, state: 'cancelled', done: 1 }
  })
  expect(classify).toHaveBeenCalledOnce()
})

it('clears a completed run pause without changing its classification results', async () => {
  const id = await create()
  await refresh(id)
  const run = await db.literatureSmartRun.findFirstOrThrow({ where: { collectionId: id } })
  await db.literatureSmartCollection.update({
    where: { collectionId: id },
    data: { autoUpdate: true, automaticPauseReason: 'interrupted', automaticPauseRunId: run.id }
  })
  configured = false

  await owner.execute({
    kind: 'smart-collection',
    collectionId: id,
    action: 'abandon',
    runId: run.id,
    offset: 0
  })

  expect(await owner.view(id)).toMatchObject({
    automaticPauseReason: undefined,
    matches: 1,
    run: { id: run.id, state: 'completed', abandoned: true }
  })
  expect(classify).toHaveBeenCalledOnce()
})

it('does not resume an older automatic run after a newer manual run completes', async () => {
  const { id, runId } = await pauseAfterOneResult(true)
  classify.mockResolvedValue({
    verdict: 'no-match',
    model: 'jev-1.13.0',
    confidence: 1,
    probabilities: { match: 0, 'no-match': 1, uncertain: 0 }
  })
  await owner.execute({
    kind: 'smart-collection',
    collectionId: id,
    action: 'recompute',
    offset: 0
  })
  await vi.waitFor(async () => expect((await owner.view(id)).run?.state).toBe('completed'))
  const latestId = (await owner.view(id)).run!.id
  const calls = classify.mock.calls.length

  await owner.execute({
    kind: 'smart-collection',
    collectionId: id,
    action: 'resume-automatic',
    offset: 0
  })

  expect((await owner.view(id)).run?.id).toBe(latestId)
  expect((await owner.view(id)).automaticPauseReason).toBeUndefined()
  expect(classify).toHaveBeenCalledTimes(calls)
  expect(await db.literatureSmartRun.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({
    state: 'cancelled'
  })
  expect(
    await db.literatureSmartAssessment.count({ where: { collectionId: id, verdict: 'no-match' } })
  ).toBe(8)
})

it('re-evaluates abandoned checkpoints on the next automatic refresh', async () => {
  const id = await create()
  await db.literatureSmartCollection.update({
    where: { collectionId: id },
    data: { autoUpdate: true }
  })
  classify.mockRejectedValueOnce(new AutomaticClassificationPausedError('run-limit'))
  owner.schedule()
  await vi.waitFor(async () => {
    expect((await owner.view(id)).automaticPauseReason).toBe('run-limit')
  })
  const pausedRunId = (await owner.view(id)).run!.id

  await owner.execute({
    kind: 'smart-collection',
    collectionId: id,
    action: 'abandon',
    runId: pausedRunId,
    offset: 0
  })
  expect(
    await db.literatureSmartRun.findUniqueOrThrow({ where: { id: pausedRunId } })
  ).toMatchObject({ state: 'cancelled', abandonedAt: expect.any(Date) })

  owner.schedule()
  await vi.waitFor(() => expect(classify).toHaveBeenCalledTimes(2))
  await vi.waitFor(async () => expect((await owner.view(id)).run?.state).toBe('completed'))
  expect((await owner.view(id)).run?.id).not.toBe(pausedRunId)
})

it('does not clear an automatic pause when abandoning a newer manual run', async () => {
  const id = await create()
  await refresh(id)
  const automaticRun = await db.literatureSmartRun.findFirstOrThrow({
    where: { collectionId: id },
    orderBy: { createdAt: 'desc' }
  })
  await db.literatureSmartCollection.update({
    where: { collectionId: id },
    data: {
      autoUpdate: true,
      automaticPauseReason: 'run-limit',
      automaticPauseRunId: automaticRun.id
    }
  })
  await db.literatureSmartRun.update({
    where: { id: automaticRun.id },
    data: { state: 'interrupted' }
  })
  await owner.execute({
    kind: 'smart-collection',
    collectionId: id,
    action: 'recompute',
    offset: 0
  })
  const manualRun = await db.literatureSmartRun.findFirstOrThrow({
    where: { collectionId: id },
    orderBy: { createdAt: 'desc' }
  })
  await db.literatureSmartRun.update({
    where: { id: manualRun.id },
    data: { state: 'interrupted' }
  })

  await owner.execute({
    kind: 'smart-collection',
    collectionId: id,
    action: 'abandon',
    runId: manualRun.id,
    offset: 0
  })

  expect(await owner.view(id)).toMatchObject({
    automaticPauseReason: 'run-limit',
    run: { id: manualRun.id, state: 'cancelled' }
  })
  expect(
    await db.literatureSmartRun.findUniqueOrThrow({ where: { id: automaticRun.id } })
  ).toMatchObject({ state: 'interrupted' })
})

it('discards unfinished progress when clearing an unattributed pause', async () => {
  const id = await create()
  await refresh(id)
  await owner.execute({
    kind: 'smart-collection',
    collectionId: id,
    action: 'recompute',
    offset: 0
  })
  const runs = await db.literatureSmartRun.findMany({
    where: { collectionId: id },
    orderBy: { createdAt: 'asc' },
    select: { id: true }
  })
  await db.literatureSmartRun.updateMany({
    where: { collectionId: id },
    data: { state: 'interrupted' }
  })
  await db.literatureSmartRun.update({ where: { id: runs[0].id }, data: { state: 'cancelled' } })
  await db.literatureSmartRunItem.update({
    where: { runId_itemId: { runId: runs[1].id, itemId: 'paper' } },
    data: { state: 'pending', resultJson: null, evaluatedAt: null, deferred: false }
  })
  await db.literatureSmartCollection.update({
    where: { collectionId: id },
    data: { autoUpdate: true, automaticPauseReason: 'interrupted', automaticPauseRunId: null }
  })

  expect((await owner.view(id)).automaticPauseRunId).toBeUndefined()
  expect((await owner.view(id)).rows[0].verdict).toBe('pending')
  classify.mockClear()
  configured = false
  await owner.execute({
    kind: 'smart-collection',
    collectionId: id,
    action: 'abandon',
    offset: 0
  })

  expect((await owner.view(id)).automaticPauseReason).toBeUndefined()
  expect(classify).not.toHaveBeenCalled()
  expect(
    await db.literatureSmartRun.findUniqueOrThrow({ where: { id: runs[1].id } })
  ).toMatchObject({ abandonedAt: expect.any(Date) })
  configured = true
  owner.schedule()
  await new Promise((resolve) => setTimeout(resolve, 850))
  expect(classify).not.toHaveBeenCalled()
  expect(await owner.view(id)).toMatchObject({ automaticPauseReason: undefined, matches: 1 })
  expect((await owner.view(id)).run?.id).toBe(runs[1].id)
  expect(
    await db.literatureSmartRun.findMany({
      where: { id: { in: runs.map((run) => run.id) } },
      orderBy: { createdAt: 'asc' },
      select: { abandonedAt: true }
    })
  ).toEqual([{ abandonedAt: null }, { abandonedAt: expect.any(Date) }])
})

it('drains paid requests and retains a durable pause when both result and failure writes fail', async () => {
  await db.literatureItem.createMany({
    data: Array.from({ length: 7 }, (_, i) => ({
      id: `drain-${i}`,
      itemType: 'journalArticle',
      title: `Trial ${i}`,
      abstract: 'Randomized trial'
    }))
  })
  const id = await create()
  await db.literatureSmartCollection.update({
    where: { collectionId: id },
    data: { autoUpdate: true }
  })
  let finish!: () => void
  const gate = new Promise<void>((resolve) => {
    finish = resolve
  })
  classify.mockImplementation(async () => {
    await gate
    return {
      verdict: 'match',
      model: 'jev-1.13.0',
      confidence: 1,
      probabilities: { match: 1, 'no-match': 0, uncertain: 0 }
    }
  })
  await db.$executeRawUnsafe(
    "CREATE TRIGGER fail_result BEFORE INSERT ON LiteratureSmartAssessment BEGIN SELECT RAISE(ABORT,'disk full'); END"
  )
  await db.$executeRawUnsafe(
    "CREATE TRIGGER fail_failure BEFORE UPDATE ON LiteratureSmartRunItem BEGIN SELECT RAISE(ABORT,'disk full'); END"
  )
  owner.schedule()
  await vi.waitFor(() => expect(classify).toHaveBeenCalledTimes(4), { timeout: 5000 })
  expect(
    (await db.literatureSmartCollection.findUniqueOrThrow({ where: { collectionId: id } }))
      .automaticPauseReason
  ).toBe('interrupted')
  finish()
  await vi.waitFor(
    async () => expect((await owner.view(id)).automaticPauseReason).toBe('storage-error'),
    { timeout: 5000 }
  )
  expect((await owner.view(id)).run?.state).toBe('failed')
  expect(await db.classificationUsage.count({ where: { status: 'completed' } })).toBe(4)
  expect(classify).toHaveBeenCalledTimes(4)
  owner.schedule()
  await new Promise((resolve) => setTimeout(resolve, 1000))
  expect(classify).toHaveBeenCalledTimes(4)
  await db.$executeRawUnsafe('DROP TRIGGER fail_result')
  await db.$executeRawUnsafe('DROP TRIGGER fail_failure')
  await owner.execute({
    kind: 'smart-collection',
    collectionId: id,
    action: 'resume-automatic',
    offset: 0
  })
  await vi.waitFor(async () => expect((await owner.view(id)).matches).toBe(8), { timeout: 5000 })
  expect((await owner.view(id)).automaticPauseReason).toBeUndefined()
})

it('drains an active classifier before deleting its collection', async () => {
  const id = await create()
  let complete!: () => void
  classify.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      complete = resolve
    })
    return {
      verdict: 'match',
      confidence: 1,
      model: 'fixture',
      probabilities: { match: 1, 'no-match': 0, uncertain: 0 }
    }
  })
  await owner.execute({ kind: 'smart-collection', collectionId: id, action: 'refresh', offset: 0 })
  await vi.waitFor(() => expect(classify).toHaveBeenCalledTimes(1))
  const deleting = catalog.transact({ kind: 'delete-collection', collectionId: id })
  await vi.waitFor(() => expect(classify.mock.calls[0][0].signal?.aborted).toBe(true))
  expect(await db.literatureCollection.findUnique({ where: { id } })).not.toBeNull()
  complete()
  await deleting
  expect(await db.literatureCollection.findUnique({ where: { id } })).toBeNull()
  expect(await db.literatureSmartRun.count({ where: { collectionId: id } })).toBe(0)
  expect(classify).toHaveBeenCalledTimes(1)
})

it('reconciles automatic collections on startup and model configuration without resuming pauses', async () => {
  configured = false
  const id = await create()
  const paused = await createPausedCollection()
  await db.literatureSmartCollection.update({
    where: { collectionId: id },
    data: { autoUpdate: true }
  })
  owner.start()
  await new Promise((resolve) => setTimeout(resolve, 850))
  expect(classify).not.toHaveBeenCalled()
  configured = true
  classificationChanged?.()
  await vi.waitFor(() => expect(classify).toHaveBeenCalledTimes(1), { timeout: 5000 })
  await vi.waitFor(async () => expect((await owner.view(id)).run?.state).toBe('completed'))
  expect((await owner.view(paused)).automaticPauseReason).toBe('daily-limit')
  classificationChanged?.()
  await new Promise((resolve) => setTimeout(resolve, 850))
  expect(classify).toHaveBeenCalledTimes(1)
  await owner.dispose()
  expect(unsubscribeClassification).toHaveBeenCalledOnce()
})

async function createPausedCollection(): Promise<string> {
  const result = await owner.execute({
    kind: 'create-smart-collection',
    name: 'Paused',
    description: formatSmartRule({ description: '', inclusion: 'Original studies', exclusion: '' }),
    scope: { kind: 'library' }
  })
  await db.literatureSmartCollection.update({
    where: { collectionId: result.id },
    data: { autoUpdate: true, automaticPauseReason: 'daily-limit' }
  })
  return result.id
}

it('evaluates existing unpaused automatic collections when started', async () => {
  const id = await create()
  await db.literatureSmartCollection.update({
    where: { collectionId: id },
    data: { autoUpdate: true }
  })
  owner.start()
  await vi.waitFor(async () => expect((await owner.view(id)).run?.state).toBe('completed'), {
    timeout: 5000
  })
  expect(classify).toHaveBeenCalledTimes(1)
})
