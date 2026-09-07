// @vitest-environment jsdom
import { act, cleanup, renderHook, type RenderHookResult } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  LiteratureCatalogSearchPage,
  LiteratureCatalogSearchRequest
} from '../../../../shared/literature'
import { useLiteratureEntries } from './useLiteratureEntries'
import { literatureItemInputSchema, type LiteratureItemView } from '../../../../shared/literature'

const page: LiteratureCatalogSearchPage = { entries: [], totalCount: 0 }
const search =
  vi.fn<(request: LiteratureCatalogSearchRequest) => Promise<LiteratureCatalogSearchPage>>()
const request: LiteratureCatalogSearchRequest = { scope: 'library', offset: 0, limit: 50 }

type HookProps = { enabled: boolean; scopeKey: string; request: LiteratureCatalogSearchRequest }

const setup = (): RenderHookResult<ReturnType<typeof useLiteratureEntries>, HookProps> & {
  onPage: ReturnType<typeof vi.fn>
  onError: ReturnType<typeof vi.fn>
} => {
  const onPage = vi.fn()
  const onEmptyPage = vi.fn()
  const onError = vi.fn()
  return {
    onPage,
    onError,
    ...renderHook<ReturnType<typeof useLiteratureEntries>, HookProps>(
      ({ enabled, scopeKey, request }) =>
        useLiteratureEntries({ enabled, scopeKey, request, onPage, onEmptyPage, onError }),
      { initialProps: { enabled: true, scopeKey: 'library', request } }
    )
  }
}

describe('useLiteratureEntries', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    search.mockReset().mockResolvedValue(page)
    Object.defineProperty(window, 'api', { configurable: true, value: { literature: { search } } })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it.each(['initial', 'next page', 'filter'] as const)(
    'ends loading after a failed %s request and permits retry',
    async (kind) => {
      if (kind === 'initial') search.mockRejectedValueOnce(new Error('Unavailable'))
      const { result, rerender, onError } = setup()
      await act(async () => {})
      if (kind !== 'initial') {
        search.mockRejectedValueOnce(new Error('Unavailable'))
        rerender({
          enabled: true,
          scopeKey: kind === 'filter' ? 'filtered' : 'library',
          request: { ...request, ...(kind === 'filter' ? { query: 'new' } : { offset: 50 }) }
        })
        await act(async () => {
          await vi.runAllTimersAsync()
        })
      }
      expect(onError).toHaveBeenLastCalledWith(true)
      expect(result.current.loading).toBe(false)
      expect(result.current.pageTransitionLoading).toBe(false)
      search.mockResolvedValueOnce({
        entries: [
          {
            id: 'retry',
            item: literatureItemInputSchema.parse({
              itemType: 'journalArticle',
              title: 'Recovered'
            }),
            attachments: [],
            collectionIds: [],
            projectIds: [],
            metadataRevision: 1,
            createdAt: 1,
            updatedAt: 1
          }
        ],
        totalCount: 51
      })
      await act(() => result.current.reload(true))
      expect(onError).toHaveBeenLastCalledWith(false)
      expect(result.current.loading).toBe(false)
    }
  )

  it('returns from a failed scope to the cached page without another request', async () => {
    const { result, rerender, onError, onPage } = setup()
    await act(async () => {})
    search.mockRejectedValueOnce(new Error('Unavailable'))
    rerender({ enabled: true, scopeKey: 'filtered', request: { ...request, query: 'new' } })
    await act(async () => {})
    expect(onError).toHaveBeenLastCalledWith(true)
    rerender({ enabled: true, scopeKey: 'library', request })
    await act(async () => {})
    expect(onError).toHaveBeenLastCalledWith(false)
    expect(result.current.loading).toBe(false)
    expect(onPage).toHaveBeenCalledTimes(1)
    expect(onPage).toHaveBeenLastCalledWith(page, request, false)
    expect(search).toHaveBeenCalledTimes(2)
  })

  it('ignores an old rejection after a new scope succeeds', async () => {
    let reject: (error: Error) => void = () => {}
    search.mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          reject = fail
        })
    )
    const { result, rerender, onError } = setup()
    rerender({ enabled: true, scopeKey: 'filtered', request: { ...request, query: 'new' } })
    await act(async () => {})
    await act(async () => reject(new Error('Old failure')))
    expect(onError).not.toHaveBeenCalledWith(true)
    expect(result.current.loading).toBe(false)
  })

  it('starts first-page navigation without waiting for a debounce timer', async () => {
    const { rerender, result } = setup()
    expect(search).toHaveBeenCalledTimes(1)
    await act(async () => {})
    expect(result.current.loading).toBe(false)
    rerender({
      enabled: true,
      scopeKey: 'collection',
      request: { ...request, collectionId: 'collection-1' }
    })
    expect(search).toHaveBeenCalledTimes(2)
    await act(async () => {})
  })

  it('resumes the displayed page without requesting or applying it again', async () => {
    const { rerender, result, onPage } = setup()
    await act(async () => {})
    rerender({ enabled: false, scopeKey: 'library', request })
    expect(result.current.loading).toBe(false)
    rerender({ enabled: true, scopeKey: 'library', request })
    expect(search).toHaveBeenCalledTimes(1)
    expect(onPage).toHaveBeenCalledTimes(1)
    expect(result.current.loading).toBe(false)
  })

  it('invalidates a hidden page after a mutation and reloads it on return', async () => {
    const { rerender, result, onPage } = setup()
    await act(async () => {})
    rerender({ enabled: false, scopeKey: 'library', request })
    await act(() => result.current.reload(true))
    expect(search).toHaveBeenCalledTimes(1)
    expect(result.current.loading).toBe(true)
    rerender({ enabled: true, scopeKey: 'library', request })
    await act(async () => {})
    expect(search).toHaveBeenCalledTimes(2)
    expect(onPage).toHaveBeenCalledTimes(2)
    expect(result.current.loading).toBe(false)
  })

  it('reapplies a cached page when returning from a different scope', async () => {
    const { rerender, onPage } = setup()
    await act(async () => {})
    rerender({
      enabled: true,
      scopeKey: 'collection',
      request: { ...request, collectionId: 'collection-1' }
    })
    await act(async () => {})
    rerender({ enabled: true, scopeKey: 'library', request })
    expect(search).toHaveBeenCalledTimes(2)
    expect(onPage).toHaveBeenCalledTimes(3)
    expect(onPage).toHaveBeenLastCalledWith(page, request, true)
  })

  it('rejects a response that finishes while the list is hidden', async () => {
    let resolvePage: (value: LiteratureCatalogSearchPage) => void = () => {}
    search.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePage = resolve
        })
    )
    const { rerender, onPage } = setup()
    rerender({ enabled: false, scopeKey: 'library', request })
    await act(async () => {
      resolvePage(page)
    })
    expect(onPage).not.toHaveBeenCalled()
    rerender({ enabled: true, scopeKey: 'library', request })
    await act(async () => {})
    expect(search).toHaveBeenCalledTimes(2)
    expect(onPage).toHaveBeenCalledTimes(1)
  })

  it('never renders a loading gap when returning to a cached scope', async () => {
    const states: boolean[] = []
    const onPage = vi.fn()
    const onEmptyPage = vi.fn()
    const onError = vi.fn()
    const collectionRequest = { ...request, collectionId: 'c1' }
    const { rerender } = renderHook(
      ({ scopeKey }) => {
        const state = useLiteratureEntries({
          scopeKey,
          request: scopeKey === 'collection' ? collectionRequest : request,
          onPage,
          onEmptyPage,
          onError
        })
        states.push(state.loading)
        return state
      },
      { initialProps: { scopeKey: 'library' } }
    )
    await act(async () => {})
    rerender({ scopeKey: 'collection' })
    await act(async () => {})
    states.length = 0
    rerender({ scopeKey: 'library' })
    expect(states.length).toBeGreaterThan(0)
    expect(states).not.toContain(true)
    expect(search).toHaveBeenCalledTimes(2)
  })

  it('patches only changed visible references without reloading, reordering or resetting position', async () => {
    const first: LiteratureItemView = {
      id: 'a',
      item: literatureItemInputSchema.parse({ itemType: 'journalArticle', title: 'Before' }),
      attachments: [],
      collectionIds: [],
      projectIds: [],
      metadataRevision: 1,
      createdAt: 1,
      updatedAt: 1
    }
    const second = { ...first, id: 'b' }
    const updated = { ...first, metadataRevision: 2, item: { ...first.item, title: 'After' } }
    search.mockResolvedValue({ entries: [first, second], totalCount: 2 })
    const get = vi.fn().mockResolvedValue(updated)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { literature: { search, get } }
    })
    const { result, onPage } = setup()
    await act(async () => {})
    await act(() => result.current.refreshItems(['a', 'off-page']))
    expect(get).toHaveBeenCalledTimes(1)
    expect(get).toHaveBeenCalledWith('a')
    expect(search).toHaveBeenCalledTimes(1)
    expect(result.current.loading).toBe(false)
    expect(onPage).toHaveBeenLastCalledWith(
      { entries: [updated, second], totalCount: 2 },
      request,
      true,
      true
    )
  })
})
