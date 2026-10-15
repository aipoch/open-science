/* Fixture builders preserve inferred mock signatures for behavioral assertions. */
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { expect, it } from 'vitest'
import { PdfTranslationCheckpoints } from '../src/checkpoints.js'
import { memoryCheckpoints } from './support/checkpoint-memory.js'
function setup() {
  const memory = memoryCheckpoints()
  return {
    ...memory,
    create: () =>
      new PdfTranslationCheckpoints({
        getClient: async () => memory.database,
        resolveSource: async (sourceId) => ({ sourceId, checksum: 'a'.repeat(64) })
      })
  }
}
const input = {
  resourceRequestKey: 'reader',
  sourceId: 'version',
  fingerprint: 'fp',
  language: 'Chinese',
  concurrency: 2,
  glossary: [],
  sources: ['ATP increased.', 'The result was 12.']
}
const model = { frameworkId: 'opencode', modelId: 'model' }
it('persists an edition before inference, resumes sparse progress and fences stale revisions', async () => {
  const h = setup()
  {
    const store = h.create(),
      checkpoint = (await store.open(input, 'b'.repeat(64), model))!
    expect((await h.create().read('version'))?.key).toBe(checkpoint.key)
    const updated = await store.append(checkpoint, 1, '结果为 12。', new AbortController().signal)
    const reopened = await h.create().read('version', checkpoint.key)
    expect(reopened).toMatchObject({
      revision: updated.revision,
      translatedSourceIndices: [1],
      translations: ['结果为 12。']
    })
    await expect(
      store.append(checkpoint, 0, 'ATP 增加。', new AbortController().signal)
    ).rejects.toThrow('another window')
    expect((await h.create().read('version'))?.translations).toEqual(['结果为 12。'])
    const editions = await store.list('version')
    expect(editions).toHaveLength(1)
    await store.delete({ source: 'version', translationId: editions[0].id })
    expect(await store.read('version')).toBeNull()
    expect(h.rows().size).toBe(0)
  }
})
it('rechecks source authority inside every transaction and rolls back denied changes', async () => {
  const h = setup()
  {
    const store = h.create(),
      checkpoint = (await store.open(input, 'b'.repeat(64), model))!
    h.revoke()
    await expect(
      store.append(checkpoint, 0, 'ATP 增加。', new AbortController().signal)
    ).rejects.toThrow('denied')
    await expect(store.read('version')).rejects.toThrow('denied')
    expect([...h.rows().values()][0].checkpoint.revision).toBe(1)
  }
})

it('rolls back an already applied repository mutation when cancellation wins before commit', async () => {
  const h = setup(),
    store = h.create()
  const checkpoint = (await store.open(input, 'b'.repeat(64), model))!
  const before = h.rows()
  const controller = new AbortController()
  const transaction = h.database.transaction.bind(h.database)
  h.database.transaction = (operation) =>
    transaction((tx) =>
      operation({
        ...tx,
        async commit(...args) {
          const changed = await tx.commit(...args)
          controller.abort()
          return changed
        }
      })
    )
  await expect(store.append(checkpoint, 0, 'ATP 增加。', controller.signal)).rejects.toThrow()
  expect(h.rows()).toEqual(before)
})

it('runs and reopens a custom-source workflow using only injected inference and an in-memory repository', async () => {
  const { PdfTranslationOwner } = await import('../src/index.js')
  const h = setup(),
    store = h.create()
  const caller = {
    leaseId: 'external-reader',
    generation: 1,
    signal: new AbortController().signal,
    isCurrent: () => true
  }
  const owner = new PdfTranslationOwner({
    checkpoints: store,
    usage: { start: async () => async () => {}, recover: async () => {}, flush: async () => {} },
    captureTarget: async () => ({
      frameworkId: 'custom-runner',
      providerId: 'external-provider',
      model: { kind: 'required' as const, id: 'test-model' },
      reasoningEffort: 'default' as const
    }),
    runner: {
      supportsTarget: () => true,
      run: async () => ({ text: 'ATP 增加。', stopReason: 'end_turn' }),
      shutdown: async () => {},
      sweepStaleProfiles: async () => {}
    }
  })
  const sourceId = 'archive:customer-42/paper-7'
  try {
    const run = await owner.begin({ ...input, sourceId, sources: ['ATP increased.'] }, caller)
    await expect(
      owner.translate(
        { operationId: run.operationId, sourceIndex: 0, source: 'ATP increased.' },
        caller
      )
    ).resolves.toBe('ATP 增加。')
    const restored = await h.create().read(sourceId)
    expect(restored).toMatchObject({ sourceId, translations: ['ATP 增加。'] })
    owner.close(run.operationId, caller)
  } finally {
    await owner.shutdown()
  }
})

it('preserves independently published layouts and reports with a full-object consumer', async () => {
  const h = setup(),
    store = h.create(),
    signal = new AbortController().signal
  const first = (await store.open(input, 'b'.repeat(64), model))!
  const saved = await store.append(first, 0, 'ATP 增加。', signal)
  const snapshot = {
    version: 1 as const,
    parserVersion: 'test',
    fingerprint: input.fingerprint,
    pages: [{ width: 612, height: 792 }],
    units: input.sources.map((source, index) => ({
      id: `unit-${index}`,
      source,
      fragments: [
        {
          pageNumber: 1,
          rect: { x: 0.1, y: 0.1 + index * 0.2, width: 0.8, height: 0.1 },
          items: [{ index, text: source }]
        }
      ]
    })),
    coverage: {
      pageCount: 1,
      textItemCount: 2,
      includedItemCount: 2,
      excludedItemCount: 0,
      pagesWithoutText: [],
      exclusions: [],
      warnings: []
    }
  }
  await store.saveSnapshot({ source: input.sourceId, checkpointKey: saved.key, snapshot }, signal)
  await store.recordLayout(
    {
      source: input.sourceId,
      checkpointKey: saved.key,
      generatedAt: Date.now(),
      units: [{ sourceIndex: 0, source: input.sources[0], translation: 'ATP 增加。' }]
    },
    signal
  )
  const reports = (await h.create().read(input.sourceId))!.layoutReports
  const completed = await store.append(saved, 1, '结果为 12。', signal)
  expect(await h.create().read(input.sourceId)).toMatchObject({
    layoutSnapshot: snapshot,
    layoutReports: reports,
    translations: completed.translations
  })
  const replaced = await store.append(completed, 0, 'ATP 上升。', signal, true)
  expect((await h.create().read(input.sourceId))!.layoutReports).toEqual([])
  expect((await h.create().read(input.sourceId))!.layoutSnapshot).toEqual(snapshot)
  const resumed = (await h.create().read(input.sourceId))!
  const reader = h.create()
  const reopened = (await reader.open(
    { ...input, checkpoint: { key: resumed.key, revision: resumed.revision } },
    'b'.repeat(64),
    model
  ))!
  const latest = await reader.append(reopened, 0, 'ATP 进一步增加。', signal, true)
  expect(latest.layoutSnapshot).toEqual(snapshot)
  expect(latest.revision).toBe(replaced.revision + 1)
})

it.each(['pinLayout', 'updateLayoutReports'] as const)(
  'rolls back %s when cancellation wins after the mutation',
  async (method) => {
    const h = setup(),
      store = h.create(),
      controller = new AbortController()
    const first = (await store.open(input, 'b'.repeat(64), model))!
    const saved = await store.append(first, 0, 'ATP 增加。', controller.signal)
    const before = h.rows()
    const transaction = h.database.transaction.bind(h.database)
    h.database.transaction = (operation) =>
      transaction((tx) =>
        operation({
          ...tx,
          async pinLayout(...args) {
            await tx.pinLayout(...args)
            if (method === 'pinLayout') controller.abort()
          },
          async updateLayoutReports(...args) {
            await tx.updateLayoutReports(...args)
            if (method === 'updateLayoutReports') controller.abort()
          }
        })
      )
    const action =
      method === 'pinLayout'
        ? store.saveSnapshot(
            {
              source: input.sourceId,
              checkpointKey: saved.key,
              snapshot: {
                version: 1,
                parserVersion: 'test',
                fingerprint: input.fingerprint,
                pages: [{ width: 612, height: 792 }],
                units: input.sources.map((source, index) => ({
                  id: `unit-${index}`,
                  source,
                  fragments: [
                    {
                      pageNumber: 1,
                      rect: { x: 0.1, y: 0.1 + index * 0.2, width: 0.8, height: 0.1 },
                      items: [{ index, text: source }]
                    }
                  ]
                })),
                coverage: {
                  pageCount: 1,
                  textItemCount: 2,
                  includedItemCount: 2,
                  excludedItemCount: 0,
                  pagesWithoutText: [],
                  exclusions: [],
                  warnings: []
                }
              }
            },
            controller.signal
          )
        : store.recordLayout(
            {
              source: input.sourceId,
              checkpointKey: saved.key,
              generatedAt: Date.now(),
              units: [{ sourceIndex: 0, source: input.sources[0], translation: 'ATP 增加。' }]
            },
            controller.signal
          )
    await expect(action).rejects.toThrow()
    expect(h.rows()).toEqual(before)
  }
)
