import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { MarketplaceSnapshot } from '../../../shared/specialist-marketplace'
import { resetMarketplaceStoreForTests, useMarketplaceStore } from './marketplace-store'

const snapshot = (id: string): MarketplaceSnapshot => ({
  sources: [
    {
      id,
      kind: 'github',
      name: 'Example Marketplace',
      repositoryUrl: 'https://github.com/example/marketplace',
      ref: 'main',
      trust: 'user-approved',
      keyId: 'example-2026-01',
      keyFingerprint: 'a'.repeat(64),
      removable: true
    }
  ],
  specialists: [],
  failures: []
})

const deferred = <Value>(): {
  promise: Promise<Value>
  resolve: (value: Value) => void
} => {
  let resolve!: (value: Value) => void
  return {
    promise: new Promise<Value>((done) => {
      resolve = done
    }),
    resolve
  }
}

const setListMarketplaceApi = (listMarketplace: unknown): void => {
  ;(globalThis as unknown as { window: { api: { specialist: unknown } } }).window = {
    api: { specialist: { listMarketplace } }
  } as never
}

const state = (): ReturnType<typeof useMarketplaceStore.getState> => useMarketplaceStore.getState()

beforeEach(() => {
  resetMarketplaceStoreForTests()
})

describe('marketplace store', () => {
  it('treats a missing list API as an unavailable Marketplace', async () => {
    setListMarketplaceApi(undefined)

    await state().refresh()

    expect(state()).toMatchObject({
      snapshot: undefined,
      isRefreshing: false,
      lastRefreshFailed: true
    })
  })

  it('stores a successful snapshot and clears the refreshing flag', async () => {
    const value = snapshot('github-example')
    setListMarketplaceApi(vi.fn().mockResolvedValue(value))

    const pending = state().refresh()
    expect(state().isRefreshing).toBe(true)
    await pending

    expect(state()).toMatchObject({
      snapshot: value,
      isRefreshing: false,
      lastRefreshFailed: false
    })
  })

  it('keeps the last snapshot and flags failure when a refresh rejects', async () => {
    const value = snapshot('github-example')
    const list = vi.fn().mockResolvedValueOnce(value).mockRejectedValueOnce(new Error('offline'))
    setListMarketplaceApi(list)

    await state().refresh()
    await state().refresh({ forceRefresh: true })

    expect(state()).toMatchObject({
      snapshot: value,
      isRefreshing: false,
      lastRefreshFailed: true
    })
  })

  it('forces past the metadata cache TTL only when asked', async () => {
    const list = vi.fn().mockResolvedValue(snapshot('github-example'))
    setListMarketplaceApi(list)

    await state().refresh()
    await state().refresh({ forceRefresh: true })

    expect(list).toHaveBeenNthCalledWith(1, undefined)
    expect(list).toHaveBeenNthCalledWith(2, { forceRefresh: true })
  })

  it('ignores a response that resolves after a newer refresh', async () => {
    const stale = deferred<MarketplaceSnapshot>()
    const fresh = deferred<MarketplaceSnapshot>()
    const list = vi.fn().mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise)
    setListMarketplaceApi(list)

    const first = state().refresh()
    const second = state().refresh()
    fresh.resolve(snapshot('github-fresh'))
    await second
    stale.resolve(snapshot('github-stale'))
    await first

    expect(state().snapshot).toEqual(snapshot('github-fresh'))
    expect(state().isRefreshing).toBe(false)
  })
})
