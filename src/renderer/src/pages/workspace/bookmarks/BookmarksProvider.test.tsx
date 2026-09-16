// @vitest-environment jsdom
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Bookmark, TextBookmarkTarget } from '../../../../../shared/bookmarks'
import { useBookmarks, type BookmarkPort } from './bookmark-context'
import { BookmarksProvider } from './BookmarksProvider'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const deferred = <T,>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
} => {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const target: TextBookmarkTarget = {
  kind: 'text',
  source: { kind: 'agent-message', sessionId: 'session-2', messageId: 'message-1' },
  quote: 'selected evidence',
  anchor: { position: { start: 0, end: 17 } }
}

const bookmark = (id: string, sessionId: string): Bookmark => ({
  id,
  projectId: 'project-1',
  sessionId,
  version: 1,
  target: {
    ...target,
    source: { kind: 'agent-message', sessionId, messageId: 'message-1' }
  },
  note: '',
  createdAt: '2026-09-14T00:00:00.000Z',
  updatedAt: '2026-09-14T00:00:00.000Z'
})

describe('BookmarksProvider', () => {
  let container: HTMLDivElement
  let root: Root
  let latest: BookmarkPort | undefined

  const Probe = (): null => {
    const port = useBookmarks()
    useEffect(() => {
      latest = port
    }, [port])
    return null
  }

  const renderScope = async (
    sessionId?: string,
    persistSessionTextSource?: (projectId: string, sessionId: string) => Promise<void>
  ): Promise<void> => {
    await act(async () => {
      root.render(
        <BookmarksProvider
          projectId={sessionId ? 'project-1' : undefined}
          sessionId={sessionId}
          persistSessionTextSource={persistSessionTextSource}
        >
          <Probe />
        </BookmarksProvider>
      )
    })
  }

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    latest = undefined
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
  })

  it('keeps late list results out of the newly selected Session', async () => {
    const first = deferred<{ items: Bookmark[]; total: number }>()
    const list = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ items: [bookmark('bookmark-2', 'session-2')], total: 1 })
    window.api = { bookmarks: { list } } as unknown as Window['api']

    await renderScope('session-1')
    await renderScope('session-2')
    await act(async () => undefined)

    expect(latest?.bookmarks.map(({ id }) => id)).toEqual(['bookmark-2'])
    expect(latest?.total).toBe(1)

    await act(async () => first.resolve({ items: [bookmark('bookmark-1', 'session-1')], total: 1 }))

    expect(latest?.bookmarks.map(({ id }) => id)).toEqual(['bookmark-2'])
  })

  it('uses the caller-owned id for a retry and publishes only the committed create', async () => {
    const committed = bookmark('bookmark-stable', 'session-2')
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce(committed)
    window.api = {
      bookmarks: {
        list: vi.fn().mockResolvedValue({ items: [], total: 0 }),
        create
      }
    } as unknown as Window['api']
    await renderScope('session-2')
    await act(async () => undefined)

    await expect(latest?.create('bookmark-stable', target, 'note')).rejects.toThrow(
      'temporary failure'
    )
    expect(latest?.bookmarks).toEqual([])

    await act(async () => {
      await latest?.create('bookmark-stable', target, 'note')
    })

    expect(create).toHaveBeenNthCalledWith(1, {
      id: 'bookmark-stable',
      projectId: 'project-1',
      sessionId: 'session-2',
      target,
      note: 'note'
    })
    expect(create).toHaveBeenNthCalledWith(2, {
      id: 'bookmark-stable',
      projectId: 'project-1',
      sessionId: 'session-2',
      target,
      note: 'note'
    })
    expect(latest?.bookmarks).toEqual([committed])
  })

  it('commits the displayed Session source before creating its bookmark', async () => {
    const barrier = deferred<void>()
    const persistSource = vi.fn(() => barrier.promise)
    const create = vi.fn().mockResolvedValue(bookmark('bookmark-new', 'session-2'))
    window.api = {
      bookmarks: { list: vi.fn().mockResolvedValue({ items: [], total: 0 }), create }
    } as unknown as Window['api']
    await renderScope('session-2', persistSource)
    const creating = latest!.create('bookmark-new', target, 'note')
    expect(persistSource).toHaveBeenCalledWith('project-1', 'session-2')
    expect(create).not.toHaveBeenCalled()
    await act(async () => {
      barrier.resolve()
      await creating
    })
    expect(create).toHaveBeenCalledWith({
      id: 'bookmark-new',
      projectId: 'project-1',
      sessionId: 'session-2',
      target,
      note: 'note'
    })
    expect(latest!.total).toBe(1)
  })

  it('preserves the bookmark retry identity when its source cannot be persisted', async () => {
    const persistSource = vi
      .fn()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValueOnce(undefined)
    const create = vi.fn().mockResolvedValue(bookmark('bookmark-retry', 'session-2'))
    window.api = {
      bookmarks: { list: vi.fn().mockResolvedValue({ items: [], total: 0 }), create }
    } as unknown as Window['api']
    await renderScope('session-2', persistSource)
    await expect(latest!.create('bookmark-retry', target, 'note')).rejects.toThrow('disk full')
    expect(create).not.toHaveBeenCalled()
    expect(latest!.total).toBe(0)
    await act(async () => {
      await latest!.create('bookmark-retry', target, 'note')
    })
    expect(create).toHaveBeenCalledOnce()
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'bookmark-retry', note: 'note' })
    )
  })

  it('keeps the captured Session scope while its source write is pending', async () => {
    const barrier = deferred<void>()
    const persistSource = vi.fn(() => barrier.promise)
    const create = vi.fn().mockResolvedValue(bookmark('bookmark-old-scope', 'session-2'))
    window.api = {
      bookmarks: { list: vi.fn().mockResolvedValue({ items: [], total: 0 }), create }
    } as unknown as Window['api']
    await renderScope('session-2', persistSource)
    const creating = latest!.create('bookmark-old-scope', target, '')
    await renderScope('session-3', persistSource)
    await act(async () => {
      barrier.resolve()
      await creating
    })
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-2', target }))
    expect(latest!.sessionId).toBe('session-3')
    expect(latest!.total).toBe(0)
    expect(latest!.bookmarks).toEqual([])
  })

  it('does not rewrite a Session to bookmark an independently versioned file', async () => {
    const persistSource = vi.fn()
    const create = vi.fn().mockResolvedValue(bookmark('bookmark-file', 'session-2'))
    window.api = {
      bookmarks: { list: vi.fn().mockResolvedValue({ items: [], total: 0 }), create }
    } as unknown as Window['api']
    await renderScope('session-2', persistSource)
    await act(async () => {
      await latest!.create(
        'bookmark-file',
        {
          ...target,
          source: { kind: 'project-file', projectId: 'project-1', path: '/project/file.txt' }
        },
        ''
      )
    })
    expect(persistSource).not.toHaveBeenCalled()
    expect(create).toHaveBeenCalledOnce()
  })

  it('does not call persistence without a persisted Session scope', async () => {
    const list = vi.fn()
    window.api = { bookmarks: { list } } as unknown as Window['api']

    await renderScope()

    expect(latest?.available).toBe(false)
    expect(latest?.bookmarks).toEqual([])
    expect(list).not.toHaveBeenCalled()
  })

  it('updates notes and removes bookmarks through the active Session scope', async () => {
    const original = bookmark('bookmark-1', 'session-2')
    const updated = { ...original, note: 'review this', updatedAt: '2026-09-14T00:01:00.000Z' }
    const updateNote = vi.fn().mockResolvedValue(updated)
    const remove = vi.fn().mockResolvedValue({ deleted: true })
    window.api = {
      bookmarks: {
        list: vi.fn().mockResolvedValue({ items: [original], total: 1 }),
        updateNote,
        delete: remove
      }
    } as unknown as Window['api']
    await renderScope('session-2')
    await act(async () => undefined)

    await act(async () => {
      await latest?.updateNote('bookmark-1', 'review this')
    })
    expect(updateNote).toHaveBeenCalledWith({
      projectId: 'project-1',
      sessionId: 'session-2',
      id: 'bookmark-1',
      note: 'review this'
    })
    expect(latest?.bookmarks[0]?.note).toBe('review this')

    await act(async () => {
      await latest?.remove('bookmark-1')
    })
    expect(remove).toHaveBeenCalledWith({
      projectId: 'project-1',
      sessionId: 'session-2',
      id: 'bookmark-1'
    })
    expect(latest?.bookmarks).toEqual([])
    expect(latest?.total).toBe(0)
  })

  it('does not publish a create that finishes after the Session changes', async () => {
    const pending = deferred<Bookmark>()
    window.api = {
      bookmarks: {
        list: vi.fn().mockResolvedValue({ items: [], total: 0 }),
        create: vi.fn().mockReturnValue(pending.promise)
      }
    } as unknown as Window['api']
    await renderScope('session-1')
    await act(async () => undefined)

    const creating = latest?.create(
      'bookmark-late',
      {
        ...target,
        source: { kind: 'agent-message', sessionId: 'session-1', messageId: 'message-1' }
      },
      ''
    )
    await renderScope('session-2')
    await act(async () => pending.resolve(bookmark('bookmark-late', 'session-1')))
    await creating

    expect(latest?.bookmarks).toEqual([])
    expect(latest?.total).toBe(0)
  })

  it('shows a list failure and retries the active Session', async () => {
    const list = vi
      .fn()
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValueOnce({ items: [bookmark('bookmark-1', 'session-2')], total: 1 })
    window.api = { bookmarks: { list } } as unknown as Window['api']
    await renderScope('session-2')

    await vi.waitFor(() => expect(latest?.loadError).toBe('database unavailable'))
    await act(async () => latest?.retryLoad())
    await vi.waitFor(() => expect(latest?.bookmarks).toHaveLength(1))

    expect(latest?.loadError).toBeUndefined()
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('merges a committed create over a slower initial list result', async () => {
    const initial = deferred<{ items: Bookmark[]; total: number }>()
    const created = bookmark('bookmark-new', 'session-2')
    window.api = {
      bookmarks: {
        list: vi.fn().mockReturnValue(initial.promise),
        create: vi.fn().mockResolvedValue(created)
      }
    } as unknown as Window['api']
    await renderScope('session-2')

    await act(async () => {
      await latest?.create('bookmark-new', target, '')
    })
    await act(async () =>
      initial.resolve({ items: [bookmark('bookmark-old', 'session-2')], total: 1 })
    )

    expect(latest?.bookmarks.map(({ id }) => id)).toEqual(['bookmark-new', 'bookmark-old'])
    expect(latest?.total).toBe(2)
  })

  it('preserves a committed create when the slower initial list fails', async () => {
    const initial = deferred<{ items: Bookmark[]; total: number }>()
    const created = bookmark('bookmark-new', 'session-2')
    window.api = {
      bookmarks: {
        list: vi.fn().mockReturnValue(initial.promise),
        create: vi.fn().mockResolvedValue(created)
      }
    } as unknown as Window['api']
    await renderScope('session-2')

    await act(async () => {
      await latest?.create('bookmark-new', target, '')
    })
    await act(async () => initial.reject(new Error('database unavailable')))

    expect(latest?.bookmarks).toEqual([created])
    expect(latest?.total).toBe(1)
    expect(latest?.loadError).toBe('database unavailable')
  })

  it.each(['create', 'updateNote', 'remove'] as const)(
    'publishes a pending %s when a read retry completes before the write',
    async (operation) => {
      const original = bookmark('bookmark-1', 'session-2')
      const committed = { ...original, note: 'saved note' }
      const pending = deferred<Bookmark | { deleted: boolean }>()
      const initialItems = operation === 'create' ? [] : [original]
      window.api = {
        bookmarks: {
          list: vi.fn().mockResolvedValue({ items: initialItems, total: initialItems.length }),
          create: vi.fn().mockReturnValue(pending.promise),
          updateNote: vi.fn().mockReturnValue(pending.promise),
          delete: vi.fn().mockReturnValue(pending.promise)
        }
      } as unknown as Window['api']
      await renderScope('session-2')
      const writing =
        operation === 'create'
          ? latest!.create(original.id, target, committed.note)
          : operation === 'updateNote'
            ? latest!.updateNote(original.id, committed.note)
            : latest!.remove(original.id)

      await act(async () => latest!.retryLoad())
      expect(latest?.bookmarks).toEqual(initialItems)
      await act(async () => {
        pending.resolve(operation === 'remove' ? { deleted: true } : committed)
        await writing
      })

      expect(latest?.bookmarks).toEqual(operation === 'remove' ? [] : [committed])
      expect(latest?.total).toBe(operation === 'remove' ? 0 : 1)
    }
  )

  it('publishes a complete paginated list instead of a partial list', async () => {
    const second = deferred<{ items: Bookmark[]; total: number }>()
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        items: [bookmark('bookmark-1', 'session-2')],
        total: 2,
        nextCursor: { createdAt: '2026-09-14T00:00:00.000Z', id: 'bookmark-1' }
      })
      .mockReturnValueOnce(second.promise)
    window.api = { bookmarks: { list } } as unknown as Window['api']
    await renderScope('session-2')
    await act(async () => undefined)

    expect(latest?.loading).toBe(true)
    expect(latest?.bookmarks).toEqual([])

    await act(async () =>
      second.resolve({ items: [bookmark('bookmark-2', 'session-2')], total: 2 })
    )
    expect(latest?.bookmarks.map(({ id }) => id)).toEqual(['bookmark-1', 'bookmark-2'])
    expect(latest?.loading).toBe(false)
  })
})
