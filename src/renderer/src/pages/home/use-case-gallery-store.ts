import { create } from 'zustand'
import type { UseCase } from '../../../../shared/use-cases'

type GalleryState = {
  items: UseCase[] | undefined
  slugs: string[]
  page: number
  receive: (items: UseCase[]) => void
  select: (slugs: string[], page: number) => void
}

// Navigation state lasts for this renderer session; the native owner still refreshes the catalog.
export const useUseCaseGalleryStore = create<GalleryState>((set) => ({
  items: undefined,
  slugs: [],
  page: 0,
  receive: (items) =>
    set((state) => {
      const available = new Set(items.map((item) => item.slug))
      const retained = new Set(state.slugs.filter((slug) => available.has(slug)))
      const replacements = items.filter((item) => !retained.has(item.slug)).map((item) => item.slug)
      // Fill deleted slots in place; catalog ordering and title updates must not reshuffle survivors.
      const slugs = state.slugs
        .map((slug) => (available.has(slug) ? slug : replacements.shift()))
        .filter((slug): slug is string => Boolean(slug))
        .slice(0, Math.min(3, items.length))
      while (slugs.length < Math.min(3, items.length)) slugs.push(replacements.shift()!)
      return { items, slugs, page: state.page % Math.max(1, Math.ceil(items.length / 3)) }
    }),
  select: (slugs, page) => set({ slugs, page })
}))
