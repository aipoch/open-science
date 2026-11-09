import { expect, it, vi, type Mock } from 'vitest'
import {
  compactContext,
  type ContextSnapshot,
  type ContextItem,
  type CompactionOptions
} from './index'

const message = (id: string, text = 'long context text'): ContextItem => ({
  id,
  kind: 'message',
  role: 'user',
  text
})
const snapshot = (): ContextSnapshot => ({
  scope: { sessionId: 's', frameId: 'f', branchId: 'b', generation: 'g', routeId: 'model-a' },
  revision: 1,
  items: [
    message('u'),
    { id: 'c', kind: 'tool-call', callId: 'call', text: 'read' },
    { id: 'r', kind: 'tool-result', callId: 'call', text: 'evidence' },
    message('recent')
  ]
})
function fixture(): {
  options: CompactionOptions
  abort: AbortController
  commit: Mock<CompactionOptions['commit']>
  raw: ContextItem[]
  read: () => ContextSnapshot
  update: (value: ContextSnapshot) => void
} {
  let current = snapshot()
  const raw = [...current.items]
  const abort = new AbortController()
  const commit = vi.fn<CompactionOptions['commit']>(async (proposal, signal) => {
    signal.throwIfAborted()
    if (
      current.revision !== proposal.expected.revision ||
      JSON.stringify(current.scope) !== JSON.stringify(proposal.expected.scope)
    )
      return false
    current = { ...current, revision: current.revision + 1, items: proposal.items }
    return true
  })
  const options: CompactionOptions = {
    snapshot: current,
    summaryId: 'summary',
    keepRecentItems: 1,
    inputBudget: 25,
    signal: abort.signal,
    // Deterministic test price, not a tokenizer. The fixed 5 represents the request envelope.
    measure: (items) => 5 + items.reduce((sum, item) => sum + item.text.length, 0),
    summarize: vi.fn(async () => 'brief'),
    commit
  }
  return {
    options,
    abort,
    commit,
    raw,
    read: () => current,
    update: (value: ContextSnapshot) => {
      current = value
    }
  }
}

it('commits a balanced prefix, preserves recent input and leaves original evidence intact', async () => {
  const h = fixture()
  const result = await compactContext(h.options)
  expect(result).toEqual({ status: 'committed', tokens: 27, fitsBudget: false })
  expect(h.commit.mock.calls[0][0].sourceIds).toEqual(['u', 'c', 'r'])
  expect(h.read().items.map((item) => item.id)).toEqual(['summary', 'recent'])
  expect(h.raw).toEqual(snapshot().items)
})

it('moves the cut before an incomplete tool pair instead of dropping a retained result', async () => {
  const h = fixture()
  await compactContext({ ...h.options, keepRecentItems: 2 })
  expect(h.commit.mock.calls[0][0].sourceIds).toEqual(['u'])
  expect(h.read().items.map((item) => item.id)).toEqual(['summary', 'c', 'r', 'recent'])
})

it('does not summarize under budget or when no balanced prefix can be removed', async () => {
  const h = fixture()
  expect(await compactContext({ ...h.options, inputBudget: 100 })).toEqual({
    status: 'within-budget'
  })
  expect(await compactContext({ ...h.options, keepRecentItems: 4 })).toEqual({
    status: 'uncompactable'
  })
  expect(h.options.summarize).not.toHaveBeenCalled()
  expect(h.commit).not.toHaveBeenCalled()
})

it.each(['sessionId', 'frameId', 'branchId', 'generation', 'routeId'] as const)(
  'rejects changed %s at commit',
  async (key) => {
    const h = fixture()
    expect(
      await compactContext({
        ...h.options,
        summarize: async () => {
          h.update({ ...h.read(), scope: { ...h.read().scope, [key]: 'new' } })
          return 'brief'
        }
      })
    ).toEqual({ status: 'stale' })
    expect(h.read().items).toEqual(h.raw)
  }
)

it('does not overwrite an append during summarization', async () => {
  const h = fixture()
  expect(
    await compactContext({
      ...h.options,
      summarize: async () => {
        h.update({ ...h.read(), revision: 2, items: [...h.read().items, message('new')] })
        return 'brief'
      }
    })
  ).toEqual({ status: 'stale' })
  expect(h.read().items.at(-1)?.id).toBe('new')
})

it('concurrent candidates can only commit once under the host CAS contract', async () => {
  const h = fixture()
  const results = await Promise.all([
    compactContext(h.options),
    compactContext({ ...h.options, summaryId: 'other' })
  ])
  expect(results.map((result) => result.status).sort()).toEqual(['committed', 'stale'])
})

it('ignores late summary output after cancellation', async () => {
  const h = fixture()
  await expect(
    compactContext({
      ...h.options,
      summarize: async () => {
        h.abort.abort()
        return 'brief'
      }
    })
  ).rejects.toThrow()
  expect(h.commit).not.toHaveBeenCalled()
})

it('reports an acknowledged commit even if cancellation arrives at commit completion', async () => {
  const h = fixture()
  const result = await compactContext({
    ...h.options,
    commit: async (proposal, signal) => {
      const committed = await h.commit(proposal, signal)
      h.abort.abort()
      return committed
    }
  })
  expect(result.status).toBe('committed')
})

it('propagates ambiguous storage failure without retry or a false rollback', async () => {
  const h = fixture()
  const error = new Error('flush outcome unknown')
  const commit = vi.fn(async () => {
    throw error
  })
  await expect(compactContext({ ...h.options, commit })).rejects.toBe(error)
  expect(commit).toHaveBeenCalledTimes(1)
})

it('rejects non-shrinking or empty summaries without committing', async () => {
  const h = fixture()
  expect(await compactContext({ ...h.options, summarize: async () => 'x'.repeat(200) })).toEqual({
    status: 'not-smaller'
  })
  await expect(compactContext({ ...h.options, summarize: async () => '  ' })).rejects.toThrow(
    'Empty'
  )
  expect(h.commit).not.toHaveBeenCalled()
})

it.each([
  [{ id: 'r', kind: 'tool-result', callId: 'absent', text: '' }],
  [message('duplicate'), message('duplicate')],
  [
    { id: 'a', kind: 'tool-call', callId: 'dup', text: '' },
    { id: 'b', kind: 'tool-call', callId: 'dup', text: '' }
  ],
  [message('summary')]
] as ContextItem[][])(
  'rejects corrupt identities or pairing before summarization: %j',
  async (...items) => {
    const h = fixture()
    await expect(
      compactContext({ ...h.options, snapshot: { ...snapshot(), items } })
    ).rejects.toThrow()
    expect(h.options.summarize).not.toHaveBeenCalled()
  }
)

it('supports repeated compaction while preserving the most recent input', async () => {
  const h = fixture()
  for (let i = 0; i < 3; i++) {
    if (i)
      h.update({
        ...h.read(),
        revision: h.read().revision + 1,
        items: [...h.read().items, message(`next-${i}`, 'x'.repeat(30))]
      })
    expect(
      (await compactContext({ ...h.options, snapshot: h.read(), summaryId: `summary-${i}` })).status
    ).toBe('committed')
    expect(h.read().items.at(-1)?.id).toBe(i ? `next-${i}` : 'recent')
  }
})

it('commits a candidate that fits the complete request budget', async () => {
  const h = fixture()
  expect(await compactContext({ ...h.options, inputBudget: 30 })).toEqual({
    status: 'committed',
    tokens: 27,
    fitsBudget: true
  })
})

it('isolates the frozen candidate from mutable caller input and rejects invalid measurements', async () => {
  const h = fixture()
  await compactContext({
    ...h.options,
    summarize: async (source) => {
      expect(Object.isFrozen(source[0])).toBe(true)
      expect(() => {
        ;(source[0] as { text: string }).text = 'changed'
      }).toThrow()
      return 'brief'
    }
  })
  const proposal = h.commit.mock.calls[0][0]
  expect(Object.isFrozen(proposal.expected.scope)).toBe(true)
  expect(Object.isFrozen(proposal.items)).toBe(true)
  await expect(compactContext({ ...h.options, measure: () => NaN })).rejects.toThrow('Invalid')
})

it('propagates summary failure without changing history', async () => {
  const h = fixture()
  await expect(
    compactContext({
      ...h.options,
      summarize: async () => {
        throw new Error('model failure')
      }
    })
  ).rejects.toThrow('model failure')
  expect(h.commit).not.toHaveBeenCalled()
  expect(h.read().items).toEqual(h.raw)
})
