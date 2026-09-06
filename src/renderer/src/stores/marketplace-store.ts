import { create } from 'zustand'
import {
  MARKETPLACE_DOCUMENT_INTEGRITY_CODE,
  type MarketplaceSnapshot
} from '../../../shared/specialist-marketplace'

// Marketplace snapshot outlives the settings view that loaded it: re-entering the Marketplace tab
// renders the last snapshot immediately and refreshes in the background, instead of showing a
// full-screen loader for data the app already has. The refresh state lives here too, so the
// "Refreshing… · Showing data from <time>" status line renders the same across view entries.

type MarketplaceStoreData = {
  snapshot: MarketplaceSnapshot | undefined
  isRefreshing: boolean
  // A flag, not a translated string: the view renders the message with i18next so it follows the
  // interface language at render time instead of freezing the locale that was active on failure.
  lastRefreshFailed: boolean
  integrityFailed: boolean
}

type MarketplaceStoreActions = {
  refresh: (options?: { forceRefresh?: boolean }) => Promise<void>
}

type MarketplaceStore = MarketplaceStoreData & MarketplaceStoreActions

let latestRefreshRequest = 0

export const useMarketplaceStore = create<MarketplaceStore>((set) => ({
  snapshot: undefined,
  isRefreshing: false,
  lastRefreshFailed: false,
  integrityFailed: false,

  refresh: async (options) => {
    // Guard: specialist.listMarketplace is Electron-only and unavailable in the web gateway.
    if (typeof window.api?.specialist?.listMarketplace !== 'function') {
      latestRefreshRequest += 1
      set({ isRefreshing: false, lastRefreshFailed: true, integrityFailed: false })
      return
    }
    const requestId = ++latestRefreshRequest
    set({ isRefreshing: true, lastRefreshFailed: false })
    try {
      const snapshot = await window.api.specialist.listMarketplace(
        options?.forceRefresh ? { forceRefresh: true } : undefined
      )
      if (requestId !== latestRefreshRequest) return
      set({ snapshot, isRefreshing: false, lastRefreshFailed: false, integrityFailed: false })
    } catch (error) {
      if (requestId !== latestRefreshRequest) return
      // Keep any existing snapshot: stale content stays on screen and the view shows a
      // could-not-refresh notice instead of dropping the user back to an empty loader.
      set({
        isRefreshing: false,
        lastRefreshFailed: true,
        integrityFailed:
          error instanceof Error && error.message.includes(MARKETPLACE_DOCUMENT_INTEGRITY_CODE)
      })
    }
  }
}))

// Exposed for tests: the store is module-level state, so each case pins it back to pristine data.
export const resetMarketplaceStoreForTests = (): void => {
  latestRefreshRequest += 1
  useMarketplaceStore.setState({
    snapshot: undefined,
    isRefreshing: false,
    lastRefreshFailed: false,
    integrityFailed: false
  })
}
