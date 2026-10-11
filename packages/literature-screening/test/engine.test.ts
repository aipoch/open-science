import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import {
  LiteratureSmartCollections,
  ClassificationEvaluationError,
  AutomaticClassificationPausedError,
  SMART_COLLECTION_RESUME_UNAVAILABLE,
  type ClassifyLiterature
} from '../src/index.js'
import { formatSmartRule } from '../src/rules.js'
import { MemoryScreeningStore } from './memory-store.js'
let store: MemoryScreeningStore
let owner: LiteratureSmartCollections
let configured = true
const serviceId = 'fixture'
const classify = vi.fn<ClassifyLiterature>()
const changed = vi.fn()
beforeEach(() => {
  store = new MemoryScreeningStore()
  store.seed()
  configured = true
  changed.mockReset()
  classify.mockReset().mockResolvedValue({
    verdict: 'match',
    model: 'jev-1.13.0',
    confidence: 1,
    probabilities: { match: 1, 'no-match': 0, uncertain: 0 }
  })
  owner = makeOwner()
})
const makeOwner = (): LiteratureSmartCollections =>
  new LiteratureSmartCollections(
    async () => store.database,
    {
      policy: async () => ({ key: 'policy-v1', configured, model: 'jev-latest' }),
      classifyLiterature: async (input) => {
        const runId = input.usageContext?.runId
        const usage = runId
          ? (store.usage.get(runId) ?? {
              inputTokens: 0,
              outputTokens: 0,
              incomplete: true,
              scenarios: []
            })
          : undefined
        if (usage && runId) {
          usage.scenarios.push({ scenario: input.usageContext!.scenario })
          store.usage.set(runId, usage)
        }
        return classify({
          ...input,
          observeUsage: (value) => {
            if (usage) {
              usage.inputTokens += value.usage.inputTokens
              usage.outputTokens += value.usage.outputTokens
              usage.incomplete = false
            }
            input.observeUsage?.(value)
          }
        })
      }
    },
    changed
  )
afterEach(async () => {
  await owner.dispose()
  vi.restoreAllMocks()
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

it('reports missing evidence as not evaluated without a paid call', async () => {
  await store.edit('paper', { abstract: '' })
  const id = await create()
  await refresh(id)
  expect((await owner.view(id)).rows[0]?.verdict).toBe('pending')
  expect(classify).not.toHaveBeenCalled()
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
  expect(await store.assessments.size).toBe(0)
})

it('does not combine results when a model alias resolves to a different model', async () => {
  const id = await create()
  await refresh(id)
  await store.seed('second', 'More research', 'A second original study')
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

it('bounds inference to four requests and accounts for every started result before stopping', async () => {
  await Array.from({ length: 8 }, (_, i) => ({
    id: 'parallel-' + i,
    itemType: 'journalArticle',
    title: 'Study ' + i,
    normalizedTitle: 'study ' + i,
    abstract: 'Research'
  })).forEach((item) => store.seed(item.id, item.title, item.abstract))
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
  const before = await structuredClone([...store.assessments.values()])
  const preview = await owner.execute({
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
  expect(await structuredClone([...store.assessments.values()])).toEqual(before)
  expect(await store.runs.size).toBe(1)
  expect(await store.overrides.size).toBe(0)
  expect((await store.definitions.get(id)!.collection).description).toBe(
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
  expect(await store.assessments.size).toBe(0)
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

it('does not repeat a current assessment when restoring an automatic decision', async () => {
  const { id } = await owner.execute({
    kind: 'create-smart-collection',
    name: 'Automatic review',
    description: formatSmartRule({ description: '', inclusion: 'Original studies', exclusion: '' }),
    scope: { kind: 'library' },
    autoUpdate: true
  })
  await vi.waitFor(async () => expect((await owner.view(id)).matches).toBe(1), { timeout: 5000 })
  const runs = await store.runs.size
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
  expect(await store.runs.size).toBe(runs)
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
  expect(await store.runs.size).toBe(0)
})

it('publishes each committed result without waiting for slow peers, including the trailing update', async () => {
  await Array.from({ length: 3 }, (_, i) => ({
    id: `stream-${i}`,
    itemType: 'journalArticle',
    title: `Study ${i}`,
    normalizedTitle: `study ${i}`,
    abstract: 'Research'
  })).forEach((item) => store.seed(item.id, item.title, item.abstract))
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
  await vi.waitFor(async () => expect((await owner.view(id)).run?.state).toBe('completed'), {
    timeout: 15000
  })
})

it('refills idle inference slots while a slow request is still running', async () => {
  await Array.from({ length: 5 }, (_, i) => ({
    id: `rolling-${i}`,
    itemType: 'journalArticle',
    title: `Study ${i}`,
    normalizedTitle: `study ${i}`,
    abstract: 'Research'
  })).forEach((item) => store.seed(item.id, item.title, item.abstract))
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

it('counts the entire scope before paging and agrees with each decision filter', async () => {
  const id = await create()
  for (const filter of ['match', 'review', 'no-match', 'pending'] as const) {
    const view = await owner.view(id, 100, filter)
    expect(view.rows).toEqual([])
    expect(view.counts[filter]).toBe((await owner.members(id, undefined, filter))!.length)
  }
})

it('explains missing evidence without pretending that a model evaluated it', async () => {
  await store.edit('paper', { abstract: '' })
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
    await owner.execute({
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
  await store.edit('paper', { abstract: 'New evidence' })
  expect((await owner.view(id)).rows[0]?.verdict).toBe('pending')
  await refresh(id)
  expect(classify).toHaveBeenCalledOnce()
  expect(await owner.members(id)).toEqual(['paper'])
})

it('preserves unresolved failures across selected runs, with manual overrides taking precedence', async () => {
  await store.seed('second', 'Second', 'Study')
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
  await store.seed('second', 'Second', 'Study')
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

it.each(['refresh', 'recompute', 'preview', 'automatic'] as const)(
  'reopens %s work without replaying committed results or broadening its selection',
  async (action) => {
    for (let i = 0; i < 7; i++) store.seed(`resume-${i}`, `Resume ${i}`)
    const id = await create()
    store.definitions.get(id)!.autoUpdate = action === 'automatic'
    store.touch()
    let calls = 0
    const answer = {
      verdict: 'match' as const,
      model: 'jev-1.13.0',
      confidence: 1,
      probabilities: { match: 1, 'no-match': 0, uncertain: 0 }
    }
    classify.mockImplementation(async () => {
      if (calls++ === 0) return answer
      throw new ClassificationEvaluationError('network')
    })
    await owner.execute(
      {
        kind: 'smart-collection',
        collectionId: id,
        action: action === 'automatic' ? 'refresh' : action,
        offset: 0
      },
      action === 'automatic'
    )
    await vi.waitFor(async () => expect((await owner.view(id)).run?.state).toBe('failed'))
    const run = (await owner.view(id)).run!
    const completed = structuredClone(
      [...store.items.values()].filter((i) => i.runId === run.id && i.state === 'done')
    )
    expect(completed).toHaveLength(1)
    const history = store.runs.get(run.id)!.snapshotJson
    await owner.dispose()
    store.seed('new-outside-batch', 'New paper')
    classify.mockClear().mockResolvedValue(answer)
    owner = makeOwner()
    const command = {
      kind: 'smart-collection' as const,
      collectionId: id,
      action: 'resume' as const,
      runId: run.id,
      offset: 0
    }
    await Promise.all([owner.execute(command), owner.execute(command)])
    await vi.waitFor(async () => expect((await owner.view(id)).run?.state).toBe('completed'))
    expect((await owner.view(id)).run?.id).toBe(run.id)
    expect(store.runs.size).toBe(1)
    expect(store.runs.get(run.id)!.snapshotJson).toBe(history)
    expect(classify).toHaveBeenCalledTimes(7)
    expect(classify.mock.calls.some(([input]) => input.title === 'New paper')).toBe(false)
    for (const result of completed)
      expect(store.items.get(`${run.id}:${result.itemId}`)).toEqual(result)
    expect(new Set(classify.mock.calls.map(([input]) => input.usageContext?.scenario))).toEqual(
      new Set([
        action === 'automatic'
          ? 'literature-automatic'
          : action === 'preview'
            ? 'literature-trial'
            : action === 'recompute'
              ? 'literature-reevaluate'
              : 'literature-update'
      ])
    )
  }
)

it.each(['snapshot', 'digest', 'rule', 'model', 'abandoned', 'provenance', 'run-id'] as const)(
  'refuses unsafe historical recovery: %s',
  async (invalid) => {
    const id = await create()
    classify.mockRejectedValue(new ClassificationEvaluationError('network'))
    await owner.execute({
      kind: 'smart-collection',
      collectionId: id,
      action: 'refresh',
      offset: 0
    })
    await vi.waitFor(async () => expect((await owner.view(id)).run?.state).toBe('failed'))
    const run = [...store.runs.values()][0]
    if (invalid === 'snapshot') run.snapshotJson = '{}'
    if (invalid === 'digest') store.edit('paper', { abstract: 'Changed' })
    if (invalid === 'rule')
      store.updateRule(
        id,
        formatSmartRule({ description: '', inclusion: 'New rule', exclusion: '' })
      )
    if (invalid === 'model') run.policyKey = 'old-policy'
    if (invalid === 'abandoned') run.abandonedAt = new Date()
    if (invalid === 'provenance') store.usage.delete(run.id)
    classify.mockClear()
    await expect(
      owner.execute({
        kind: 'smart-collection',
        collectionId: id,
        action: 'resume',
        runId: invalid === 'run-id' ? 'older' : run.id,
        offset: 0
      })
    ).rejects.toThrow('SMART_COLLECTION_RESUME_UNAVAILABLE')
    expect(classify).not.toHaveBeenCalled()
    expect(store.runs.size).toBe(1)
  }
)

it('commits an assessment and its completion marker together and preserves a failed admission', async () => {
  const id = await create()
  classify.mockImplementationOnce(async () => {
    store.failCommit = true
    return {
      verdict: 'match',
      model: 'jev-1.13.0',
      confidence: 1,
      probabilities: { match: 1, 'no-match': 0, uncertain: 0 }
    }
  })
  await owner.execute({ kind: 'smart-collection', collectionId: id, action: 'refresh', offset: 0 })
  await vi.waitFor(async () => expect((await owner.view(id)).run?.state).toBe('failed'))
  expect(store.assessments.size).toBe(0)
  const before = structuredClone([...store.items.values()])
  const run = (await owner.view(id)).run!
  await expect(
    owner.execute({
      kind: 'smart-collection',
      collectionId: id,
      action: 'resume',
      runId: run.id,
      offset: 0
    })
  ).rejects.toThrow('Storage unavailable')
  expect([...store.items.values()]).toEqual(before)
  expect(store.runs.get(run.id)!.state).toBe('failed')
})

it.each(['run-limit', 'daily-limit', 'storage-error'] as const)(
  'retains automatic pause ownership for %s',
  async (reason) => {
    const id = await create()
    store.definitions.get(id)!.autoUpdate = true
    store.touch()
    classify.mockRejectedValueOnce(new AutomaticClassificationPausedError(reason))
    await owner.execute(
      { kind: 'smart-collection', collectionId: id, action: 'refresh', offset: 0 },
      true
    )
    await vi.waitFor(async () => expect((await owner.view(id)).automaticPauseReason).toBe(reason))
    const view = await owner.view(id)
    expect(view.automaticPauseRunId).toBe(view.run!.id)
    expect(view.counts.pending).toBe(1)
    expect(view.run?.state).toBe('interrupted')
    expect([...store.items.values()]).toMatchObject([{ state: 'pending', failure: null }])
    expect(view.rows[0].failure).toBeUndefined()
    owner.schedule()
    await new Promise((resolve) => setTimeout(resolve, 800))
    expect(classify).toHaveBeenCalledTimes(1)
    await owner.execute({
      kind: 'smart-collection',
      collectionId: id,
      action: 'resume-automatic',
      offset: 0
    })
    await vi.waitFor(async () => expect((await owner.view(id)).run?.state).toBe('completed'))
    expect((await owner.view(id)).automaticPauseReason).toBeUndefined()
    expect(classify).toHaveBeenCalledTimes(2)
    if (reason !== 'run-limit') expect((await owner.view(id)).run?.id).toBe(view.run!.id)
  }
)

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
  expect(await store.overrides.size).toBe(0)
  await expect(
    owner.execute({ kind: 'smart-collection', collectionId: id, action: 'read', offset: 0 })
  ).rejects.toThrow('summary unavailable')
  read.mockRestore()
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
  await store.edit('paper', { abstract: 'New evidence' })
  owner.schedule()
  await vi.waitFor(async () => expect((await owner.view(id)).matches).toBe(1), { timeout: 5000 })
  expect(classify).toHaveBeenCalledTimes(2)
})

it('throttles fast progress events without delaying terminal state or dropping assessments', async () => {
  await Array.from({ length: 19 }, (_, index) => ({
    id: `fast-${index}`,
    itemType: 'journalArticle',
    title: `Study ${index}`,
    normalizedTitle: `study ${index}`,
    abstract: 'Original study'
  })).forEach((item) => store.seed(item.id, item.title, item.abstract))
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

it('abandons a paused automatic run without resuming it', async () => {
  const id = await create()
  await refresh(id)
  const run = await store.database.latestRuns(id).then((runs) => runs[0]!)
  await (() => {
    const value = store.definitions.get(id)!
    Object.assign(value, {
      autoUpdate: true,
      automaticPauseReason: 'run-limit',
      automaticPauseRunId: run.id
    })
    store.touch()
    return structuredClone(value)
  })()
  await store.database.updateRun(run.id, { state: 'cancelled' })

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
  const run = await store.database.latestRuns(id).then((runs) => runs[0]!)
  await store.database.updateRun(run.id, { state: 'failed' })
  await (() => {
    const value = store.definitions.get(id)!
    Object.assign(value, {
      autoUpdate: true,
      automaticPauseReason: 'storage-error',
      automaticPauseRunId: run.id
    })
    store.touch()
    return structuredClone(value)
  })()

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

it('clears a failed automatic pause when its run has no pending work', async () => {
  const id = await create()
  await refresh(id)
  const run = await store.database.latestRuns(id).then((runs) => runs[0]!)
  await store.database.updateRun(run.id, { state: 'failed' })
  await (() => {
    const value = store.definitions.get(id)!
    Object.assign(value, {
      autoUpdate: true,
      automaticPauseReason: 'storage-error',
      automaticPauseRunId: run.id
    })
    store.touch()
    return structuredClone(value)
  })()

  await owner.execute({
    kind: 'smart-collection',
    collectionId: id,
    action: 'resume-automatic',
    offset: 0
  })

  expect(await owner.view(id)).toMatchObject({
    automaticPauseReason: undefined,
    matches: 1,
    run: { id: run.id, state: 'failed', done: 1, total: 1 }
  })
  expect(classify).toHaveBeenCalledOnce()
})

it('clears a completed run pause without changing its classification results', async () => {
  const id = await create()
  await refresh(id)
  const run = await store.database.latestRuns(id).then((runs) => runs[0]!)
  await (() => {
    const value = store.definitions.get(id)!
    Object.assign(value, {
      autoUpdate: true,
      automaticPauseReason: 'interrupted',
      automaticPauseRunId: run.id
    })
    store.touch()
    return structuredClone(value)
  })()
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

it('re-evaluates abandoned checkpoints on the next automatic refresh', async () => {
  const id = await create()
  await (() => {
    const value = store.definitions.get(id)!
    Object.assign(value, { autoUpdate: true })
    store.touch()
    return structuredClone(value)
  })()
  classify.mockRejectedValueOnce(new AutomaticClassificationPausedError('run-limit'))
  owner.schedule()
  await vi.waitFor(
    async () => {
      expect((await owner.view(id)).automaticPauseReason).toBe('run-limit')
    },
    { timeout: 5000 }
  )
  const pausedRunId = (await owner.view(id)).run!.id

  await owner.execute({
    kind: 'smart-collection',
    collectionId: id,
    action: 'abandon',
    runId: pausedRunId,
    offset: 0
  })
  expect(await structuredClone(store.runs.get(pausedRunId)!)).toMatchObject({
    state: 'cancelled',
    abandonedAt: expect.any(Date)
  })

  owner.schedule()
  await vi.waitFor(() => expect(classify).toHaveBeenCalledTimes(2), { timeout: 5000 })
  await vi.waitFor(async () => expect((await owner.view(id)).run?.state).toBe('completed'), {
    timeout: 5000
  })
  expect((await owner.view(id)).run?.id).not.toBe(pausedRunId)
})

const pauseAfterOneResult = async (
  automatic = false,
  manualAction: 'refresh' | 'recompute' = 'recompute'
): Promise<{ id: string; runId: string; doneId: string }> => {
  await Array.from({ length: 7 }, (_, i) => ({
    id: `resume-${i}`,
    itemType: 'journalArticle',
    title: `Resume ${i}`,
    abstract: 'Original study'
  })).forEach((item) => store.seed(item.id, item.title, item.abstract))
  const id = await create()
  if (automatic)
    await (() => {
      const value = store.definitions.get(id)!
      Object.assign(value, { autoUpdate: true })
      store.touch()
      return structuredClone(value)
    })()
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
  const done = await structuredClone(
    [...store.items.values()].find((item) => item.runId === runId && item.state === 'done')!
  )
  return { id, runId, doneId: done.itemId }
}

it('resumes the same stopped run once and preserves completed outcomes', async () => {
  const { id, runId, doneId } = await pauseAfterOneResult()
  const before = await structuredClone(store.items.get(runId + ':' + doneId)!)
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
  expect(await store.runs.size).toBe(1)
  expect(classify.mock.calls.length - calls).toBe(7)
  expect(await structuredClone(store.items.get(runId + ':' + doneId)!)).toEqual(before)
})

it.each([false, true])(
  'retries an error-only batch without creating a run (automatic: %s)',
  async (automatic) => {
    const id = await create()
    if (automatic)
      await (() => {
        const value = store.definitions.get(id)!
        Object.assign(value, { autoUpdate: true })
        store.touch()
        return structuredClone(value)
      })()
    classify.mockRejectedValueOnce(new ClassificationEvaluationError('network'))
    await owner.execute(
      { kind: 'smart-collection', collectionId: id, action: 'refresh', offset: 0 },
      automatic
    )
    await vi.waitFor(async () => expect((await owner.view(id)).run?.state).toBe('failed'))
    const runId = (await owner.view(id)).run!.id
    expect((await owner.view(id)).run).toMatchObject({
      done: 1,
      total: 1,
      manualResumeAllowed: !automatic
    })
    await owner.execute({
      kind: 'smart-collection',
      collectionId: id,
      action: 'resume',
      runId,
      offset: 0
    })
    await vi.waitFor(async () => expect((await owner.view(id)).run?.state).toBe('completed'))
    expect((await owner.view(id)).run).toMatchObject({
      id: runId,
      done: 1,
      total: 1,
      failure: undefined
    })
    expect(classify).toHaveBeenCalledTimes(2)
    expect(await store.runs.size).toBe(1)
  }
)

it('keeps repeated automatic failures and the request limit in the original batch', async () => {
  const id = await create()
  await (() => {
    const value = store.definitions.get(id)!
    Object.assign(value, { autoUpdate: true })
    store.touch()
    return structuredClone(value)
  })()
  classify.mockRejectedValue(new ClassificationEvaluationError('network'))
  await owner.execute(
    { kind: 'smart-collection', collectionId: id, action: 'refresh', offset: 0 },
    true
  )
  await vi.waitFor(async () => expect((await owner.view(id)).run?.state).toBe('failed'))
  const runId = (await owner.view(id)).run!.id
  const retry = {
    kind: 'smart-collection' as const,
    collectionId: id,
    action: 'resume' as const,
    runId,
    offset: 0
  }
  await owner.execute(retry)
  await vi.waitFor(async () => expect((await owner.view(id)).run?.state).toBe('failed'))
  expect(classify).toHaveBeenCalledTimes(2)
  classify.mockRejectedValue(new AutomaticClassificationPausedError('run-limit'))
  await owner.execute(retry)
  await vi.waitFor(async () =>
    expect((await owner.view(id)).automaticPauseReason).toBe('run-limit')
  )
  await expect(owner.execute(retry)).rejects.toThrow(SMART_COLLECTION_RESUME_UNAVAILABLE)
  expect(classify).toHaveBeenCalledTimes(3)
  expect(await store.runs.size).toBe(1)
  for (const [input] of classify.mock.calls)
    expect(input.usageContext).toMatchObject({ runId, scenario: 'literature-automatic' })
})

it.each([
  'paper',
  'rule',
  'policy',
  'snapshot',
  'details',
  'incomplete-result',
  'timestamp',
  'run-id'
] as const)('rejects resume after %s changes without dispatching paid work', async (change) => {
  const { id, runId, doneId } = await pauseAfterOneResult()
  if (change === 'paper') await store.edit('paper', { abstract: 'Changed input' })
  if (change === 'rule')
    await (() => {
      Object.assign(store.definitions.get(id)!.collection, {
        description: formatSmartRule({
          description: '',
          inclusion: 'Changed inclusion',
          exclusion: ''
        })
      })
      store.touch()
    })()
  if (change === 'policy')
    await (() => {
      Object.assign(store.runs.get(runId)!, { policyKey: 'outdated' })
      store.touch()
    })()
  if (change === 'snapshot')
    await (() => {
      Object.assign(store.runs.get(runId)!, { snapshotJson: null })
      store.touch()
    })()
  if (change === 'details')
    await store.database.updateRunItems({ runId: runId, itemId: doneId }, { resultJson: null })
  if (change === 'incomplete-result' || change === 'timestamp')
    await store.database.updateRunItems(
      { runId: runId, itemId: doneId },
      change === 'timestamp'
        ? { evaluatedAt: null }
        : { resultJson: JSON.stringify({ answer: { verdict: 'match' } }) }
    )
  const calls = classify.mock.calls.length
  await expect(
    owner.execute({
      kind: 'smart-collection',
      collectionId: id,
      action: 'resume',
      runId: change === 'run-id' ? 'another-run' : runId,
      offset: 0
    })
  ).rejects.toThrow(SMART_COLLECTION_RESUME_UNAVAILABLE)
  expect(classify).toHaveBeenCalledTimes(calls)
  expect((await owner.view(id)).run).toMatchObject({ id: runId, state: 'cancelled' })
})

it('marks abandoned work interrupted without restarting paid requests', async () => {
  const id = await create()
  await store.database.createRun({
    ...{ collectionId: id, kind: 'refresh', state: 'running', ruleRevision: 1, policyKey: 'old' },
    id: 'interrupted-run',
    snapshotJson: null,
    items: []
  })
  expect((await owner.view(id)).run).toMatchObject({ state: 'interrupted', usageIncomplete: false })
  expect(classify).not.toHaveBeenCalled()
})

it('rejects an unrecognized persisted checkpoint state instead of silently skipping it', async () => {
  const id = await create()
  await refresh(id)
  const item = [...store.items.values()][0]
  item.state = 'unrecognized'
  store.touch()
  classify.mockClear()
  await expect(owner.view(id)).rejects.toThrow()
  expect(classify).not.toHaveBeenCalled()
  expect(item.state).toBe('unrecognized')
})
