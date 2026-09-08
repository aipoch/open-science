import { describe, expect, it, vi } from 'vitest'
import { createMessageSearch } from './message-search'
import type { PersistedChatSession, SessionSummary } from '../../shared/session-persistence'

const summary = (id: string, overrides = {}): SessionSummary =>
  ({
    id,
    projectId: 'p',
    title: id,
    number: 1,
    revision: 1,
    updatedAt: 10,
    activeMessageCount: 12,
    ...overrides
  }) as SessionSummary
const session = (id: string, overrides = {}): PersistedChatSession =>
  ({
    id,
    projectId: 'p',
    title: id,
    cwd: '/workspace',
    status: 'idle',
    createdAt: 1,
    updatedAt: 10,
    messages: Array.from({ length: 12 }, (_, i) => ({
      id: `${id}-${i}`,
      role: 'user',
      content: `before\nＡＩ [query] ${i}\nafter`,
      status: 'complete',
      createdAt: i,
      updatedAt: i,
      eventIds: []
    })),
    ...overrides
  }) as PersistedChatSession

describe('message body search', () => {
  it('groups matching agent fragments by turn before counting and paging, retaining the best hit target', async () => {
    const search = createMessageSearch({
      list: async () => ({ sessions: [summary('s')] }),
      loadOne: async () =>
        session('s', {
          messages: [
            { id: 'prompt', role: 'user', content: 'needle question', createdAt: 1 },
            {
              id: 'progress',
              role: 'agent',
              responseToMessageId: 'prompt',
              content: 'Checking needle sources.',
              createdAt: 2
            },
            {
              id: 'answer',
              role: 'agent',
              responseToMessageId: 'prompt',
              content: 'Answer heading\nneedle evidence and needle conclusion.',
              createdAt: 3
            },
            {
              id: 'follow-up',
              role: 'agent',
              responseToMessageId: 'another-prompt',
              content: 'Another needle answer.',
              createdAt: 4
            }
          ]
        })
    })
    const request = { projectIds: ['p'], query: 'needle', sort: 'relevance' as const, limit: 2 }
    expect(await search(request)).toMatchObject({
      totalCount: 3,
      nextOffset: 2,
      items: [
        {
          messageId: 'answer',
          title: 'Answer heading',
          content: 'Answer heading\nneedle evidence and needle conclusion.'
        },
        { messageId: 'follow-up' }
      ]
    })
    expect(await search({ ...request, offset: 2 })).toMatchObject({
      totalCount: 3,
      nextOffset: undefined,
      items: [{ messageId: 'prompt', role: 'user' }]
    })
    expect(await search({ ...request, sort: 'recent' })).toMatchObject({
      totalCount: 3,
      items: [{ messageId: 'follow-up' }, { messageId: 'answer' }]
    })
  })

  it('prefers the later equally relevant fragment and applies filters before selecting a turn hit', async () => {
    const search = createMessageSearch({
      list: async () => ({ sessions: [summary('s')] }),
      loadOne: async () =>
        session('s', {
          messages: [
            {
              id: 'strong',
              role: 'agent',
              responseToMessageId: 'prompt',
              content: 'needle needle',
              createdAt: 1
            },
            {
              id: 'progress',
              role: 'agent',
              responseToMessageId: 'prompt',
              content: 'needle progress',
              createdAt: 5
            },
            {
              id: 'final',
              role: 'agent',
              responseToMessageId: 'prompt',
              content: 'needle final answer',
              createdAt: 5
            }
          ]
        })
    })
    const request = { projectIds: ['p'], query: 'needle', role: 'agent' as const, limit: 10 }
    expect(await search(request)).toMatchObject({ totalCount: 1, items: [{ messageId: 'strong' }] })
    expect(await search({ ...request, updatedAfter: 4 })).toMatchObject({
      totalCount: 1,
      items: [{ messageId: 'final', content: 'needle final answer' }]
    })
    expect(await search({ ...request, query: '' })).toMatchObject({
      totalCount: 1,
      items: [{ messageId: 'final' }]
    })
    expect(await search({ ...request, role: 'user' })).toMatchObject({ totalCount: 0, items: [] })
  })

  it('keeps unlinked messages separate and never groups turns across sessions', async () => {
    const search = createMessageSearch({
      list: async () => ({ sessions: [summary('s1'), summary('s2')] }),
      loadOne: async ({ sessionId }) =>
        session(sessionId, {
          messages: [
            { id: 'legacy-1', role: 'agent', content: 'needle', createdAt: 1 },
            { id: 'legacy-2', role: 'agent', content: 'needle', createdAt: 2 },
            {
              id: 'progress',
              role: 'agent',
              responseToMessageId: 'prompt',
              content: 'needle',
              createdAt: 3
            },
            {
              id: 'final',
              role: 'agent',
              responseToMessageId: 'prompt',
              content: 'needle',
              createdAt: 4
            }
          ]
        })
    })
    const result = await search({ projectIds: ['p'], query: 'needle', limit: 10 })
    expect(result.totalCount).toBe(6)
    for (const sessionId of ['s1', 's2']) {
      expect(
        result.items.filter((item) => item.sessionId === sessionId).map((item) => item.messageId)
      ).toEqual(['final', 'legacy-2', 'legacy-1'])
    }
  })

  it('filters senders and dates before pagination and ranks body matches when requested', async () => {
    const search = createMessageSearch({
      list: async () => ({ sessions: [summary('s')] }),
      loadOne: async () =>
        session('s', {
          messages: [
            { id: 'old', role: 'user', content: 'needle needle needle', createdAt: 1 },
            { id: 'agent', role: 'agent', content: 'needle needle needle', createdAt: 9 },
            {
              id: 'relevant',
              role: 'user',
              content: 'Actual heading\nneedle needle',
              createdAt: 5
            },
            { id: 'recent', role: 'user', content: 'needle', createdAt: 8 }
          ]
        })
    })
    const request = {
      projectIds: ['p'],
      query: 'needle',
      limit: 1,
      updatedAfter: 4,
      role: 'user' as const,
      sort: 'relevance' as const
    }
    expect(await search(request)).toMatchObject({
      totalCount: 2,
      nextOffset: 1,
      items: [{ messageId: 'relevant', title: 'Actual heading' }]
    })
    expect(await search({ ...request, offset: 1 })).toMatchObject({
      items: [{ messageId: 'recent' }],
      nextOffset: undefined
    })
    expect(await search({ ...request, sort: 'recent' })).toMatchObject({
      items: [{ messageId: 'recent' }]
    })
    expect(await search({ ...request, role: 'agent' })).toMatchObject({
      totalCount: 1,
      items: [{ messageId: 'agent' }]
    })
  })
  it('starts a fresh scan when an in-flight query is revisited after cancellation', async () => {
    const catalog = { sessions: [summary('s')] }
    let releaseRead!: () => void
    let releaseCatalog!: (value: typeof catalog) => void
    const loadOne = vi.fn(async () => session('s'))
    loadOne.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        releaseRead = resolve
      })
      return session('s')
    })
    const list = vi.fn(async () => catalog)
    const search = createMessageSearch({ list, loadOne })
    const request = { projectIds: ['p'], query: 'query', limit: 10 }
    const first = search(request)
    await vi.waitFor(() => expect(loadOne).toHaveBeenCalledTimes(1))
    list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseCatalog = resolve
        })
    )
    const middle = search({ ...request, query: 'other' })
    const latest = search(request)
    await Promise.resolve()
    releaseRead()
    releaseCatalog(catalog)
    await Promise.all([first, middle])
    expect(await latest).toMatchObject({ totalCount: 12, isComplete: true })
    expect(loadOne).toHaveBeenCalledTimes(2)
  })
  it('preserves incomplete catalog diagnostics and retries the catalog', async () => {
    const loadOne = vi.fn(async () => session('s'))
    const search = createMessageSearch({
      list: async () => ({ sessions: [summary('s')], diagnostics: { isComplete: false } }),
      loadOne
    })
    const request = { projectIds: ['p'], query: 'query', limit: 10 }
    expect((await search(request)).isComplete).toBe(false)
    await search(request)
    expect(loadOne).toHaveBeenCalledTimes(2)
  })
  it('stops superseded scans and bounds concurrent reads across queries', async () => {
    let active = 0
    let maximum = 0
    const loadOne = vi.fn(async ({ sessionId }: { sessionId: string }) => {
      active++
      maximum = Math.max(maximum, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active--
      return session(sessionId)
    })
    const search = createMessageSearch({
      list: async () => ({ sessions: Array.from({ length: 12 }, (_, i) => summary(String(i))) }),
      loadOne
    })
    const first = search({ projectIds: ['p'], query: 'old', limit: 10 })
    await new Promise((resolve) => setTimeout(resolve, 1))
    const second = search({ projectIds: ['p'], query: 'query', limit: 10 })
    await Promise.all([first, second])
    expect(maximum).toBeLessThanOrEqual(4)
    expect(loadOne.mock.calls.length).toBeLessThan(24)
  })
  it('finds literal normalized body matches, pages deterministically and excludes archived/hidden messages', async () => {
    const loadOne = vi.fn(async ({ sessionId }: { sessionId: string }) => session(sessionId))
    const search = createMessageSearch({
      list: async () => ({
        sessions: [
          summary('s'),
          summary('archive', { archivedAt: 1 }),
          summary('other', { projectId: 'other' })
        ]
      }),
      loadOne
    })
    const request = { projectIds: ['p'], query: 'ai [query]', limit: 10 }
    const first = await search(request)
    expect(first.totalCount).toBe(12)
    expect(first.items).toHaveLength(10)
    expect(first.items[0]).toMatchObject({ messageId: 's-11', sessionId: 's', projectId: 'p' })
    const second = await search({ ...request, offset: first.nextOffset })
    expect(second.items.map((item) => item.messageId)).toEqual(['s-1', 's-0'])
    expect(second.nextOffset).toBeUndefined()
    expect(loadOne).toHaveBeenCalledTimes(1)
  })
  it('invalidates revision caches and reports partial failures without losing healthy results', async () => {
    let revision = 1
    const search = createMessageSearch({
      list: async () => ({ sessions: [summary('s', { revision }), summary('broken')] }),
      loadOne: async ({ sessionId }) => {
        if (sessionId === 'broken') throw new Error('unreadable')
        return session('s', {
          messages: [
            { id: 'hidden', content: 'needle', role: 'user', turnIntent: 'save-as-skill' },
            { id: 'visible', content: revision === 1 ? 'needle' : 'changed', role: 'agent' }
          ]
        })
      }
    })
    expect(await search({ projectIds: ['p'], query: 'needle', limit: 10 })).toMatchObject({
      totalCount: 1,
      isComplete: false,
      items: [{ messageId: 'visible' }]
    })
    revision++
    expect(await search({ projectIds: ['p'], query: 'needle', limit: 10 })).toMatchObject({
      totalCount: 0
    })
    await expect(search({ projectIds: ['p'], query: 'x', limit: -1 })).rejects.toThrow()
  })
})
