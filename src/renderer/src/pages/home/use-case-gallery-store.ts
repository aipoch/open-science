import { create } from 'zustand'
import type { UseCase } from '../../../../shared/use-cases'

export const USE_CASE_BATCH_SIZE = 6

type GalleryState = {
  items: UseCase[] | undefined
  slugs: string[]
  refreshRevision: number
  coverRetryRevision: number
  retryFailedCovers: () => void
  receive: (items: UseCase[], refreshDetails?: boolean) => void
  loadMore: () => void
}

// Navigation state lasts for this renderer session; the native owner still refreshes the catalog.
export const useUseCaseGalleryStore = create<GalleryState>((set) => ({
  items: undefined,
  slugs: [],
  refreshRevision: 0,
  coverRetryRevision: 0,
  // Image recovery remains available even when the catalog request itself fails.
  retryFailedCovers: () => set((state) => ({ coverRetryRevision: state.coverRetryRevision + 1 })),
  receive: (items, refreshDetails = false) =>
    set((state) => {
      const available = new Set(items.map((item) => item.slug))
      const retained = new Set(state.slugs.filter((slug) => available.has(slug)))
      const replacements = items.filter((item) => !retained.has(item.slug)).map((item) => item.slug)
      const count = Math.min(Math.max(USE_CASE_BATCH_SIZE, state.slugs.length), items.length)
      // Fill deleted slots in place; catalog ordering and title updates must not reshuffle survivors.
      const slugs = state.slugs
        .map((slug) => (available.has(slug) ? slug : replacements.shift()))
        .filter((slug): slug is string => Boolean(slug))
        .slice(0, count)
      while (slugs.length < count) slugs.push(replacements.shift()!)
      const sameItems = JSON.stringify(state.items) === JSON.stringify(items)
      const sameSlugs =
        state.slugs.length === slugs.length &&
        state.slugs.every((slug, index) => slug === slugs[index])
      if (sameItems && sameSlugs && !refreshDetails) return state
      return {
        items: sameItems ? state.items : items,
        slugs: sameSlugs ? state.slugs : slugs,
        refreshRevision: state.refreshRevision + (refreshDetails ? 1 : 0)
      }
    }),
  // Append unseen identities in catalog order; the final batch never wraps or duplicates cards.
  loadMore: () =>
    set((state) => {
      const shown = new Set(state.slugs)
      const next = (state.items ?? [])
        .filter((item) => !shown.has(item.slug))
        .slice(0, USE_CASE_BATCH_SIZE)
      return next.length ? { slugs: [...state.slugs, ...next.map((item) => item.slug)] } : state
    })
}))
