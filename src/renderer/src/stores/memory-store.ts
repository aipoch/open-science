import { create } from 'zustand'

import {
  type CreateMemoryCategoryRequest,
  type CreateMemoryEntryRequest,
  type DeleteMemoryCategoryRequest,
  type DeleteMemoryEntryRequest,
  type MemorySnapshot,
  type UpdateMemoryCategoryRequest,
  type UpdateMemoryEntryRequest
} from '../../../shared/memory'

type MemoryStore = MemorySnapshot & {
  status: 'idle' | 'loading' | 'ready' | 'error'
  error?: string
  selectedCategoryId?: string
  selectCategory(id: string): void
  load(): Promise<void>
  setEnabled(enabled: boolean): Promise<void>
  createCategory(request: CreateMemoryCategoryRequest): Promise<string>
  updateCategory(request: UpdateMemoryCategoryRequest): Promise<void>
  deleteCategory(request: DeleteMemoryCategoryRequest): Promise<void>
  createEntry(request: CreateMemoryEntryRequest): Promise<void>
  updateEntry(request: UpdateMemoryEntryRequest): Promise<void>
  deleteEntry(request: DeleteMemoryEntryRequest): Promise<void>
  clearAll(): Promise<void>
  listen(): () => void
}

const EMPTY_SNAPSHOT: MemorySnapshot = {
  revision: 0,
  enabled: false,
  categories: []
}

export const createInitialMemoryState = (): MemorySnapshot & {
  status: MemoryStore['status']
  error?: string
  selectedCategoryId?: string
} => ({ ...EMPTY_SNAPSHOT, status: 'idle' })

let loadSequence = 0

const stateFromSnapshot = (
  snapshot: MemorySnapshot,
  selectedCategoryId?: string
): Pick<MemoryStore, keyof MemorySnapshot | 'status' | 'selectedCategoryId' | 'error'> => ({
  ...snapshot,
  status: 'ready',
  error: undefined,
  selectedCategoryId: snapshot.categories.some(({ id }) => id === selectedCategoryId)
    ? selectedCategoryId
    : snapshot.categories[0]?.id
})

export const useMemoryStore = create<MemoryStore>((set, get) => {
  const applyMutation = async (operation: () => Promise<MemorySnapshot>): Promise<void> => {
    try {
      const snapshot = await operation()
      loadSequence += 1
      set(stateFromSnapshot(snapshot, get().selectedCategoryId))
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'memory' })
      throw error
    }
  }

  return {
    ...createInitialMemoryState(),
    selectCategory: (selectedCategoryId) => set({ selectedCategoryId }),
    load: async () => {
      if (!window.api?.memory) {
        set({ ...EMPTY_SNAPSHOT, status: 'error', error: 'load' })
        return
      }
      const sequence = ++loadSequence
      set({ status: 'loading', error: undefined })
      try {
        const snapshot = await window.api.memory.snapshot()
        if (sequence !== loadSequence) return
        if (snapshot.revision < get().revision) {
          set({ status: 'ready' })
          return
        }
        set(stateFromSnapshot(snapshot, get().selectedCategoryId))
      } catch {
        if (sequence !== loadSequence) return
        set({ status: 'error', error: 'load' })
      }
    },
    setEnabled: (enabled) => applyMutation(() => window.api.memory.setEnabled({ enabled })),
    createCategory: async (request) => {
      const before = new Set(get().categories.map(({ id }) => id))
      let createdId = ''
      await applyMutation(async () => {
        const snapshot = await window.api.memory.createCategory(request)
        createdId = snapshot.categories.find(({ id }) => !before.has(id))?.id ?? ''
        return snapshot
      })
      if (!createdId) throw new Error('Created memory category is missing.')
      set({ selectedCategoryId: createdId })
      return createdId
    },
    updateCategory: (request) => applyMutation(() => window.api.memory.updateCategory(request)),
    deleteCategory: (request) => applyMutation(() => window.api.memory.deleteCategory(request)),
    createEntry: (request) => applyMutation(() => window.api.memory.createEntry(request)),
    updateEntry: (request) => applyMutation(() => window.api.memory.updateEntry(request)),
    deleteEntry: (request) => applyMutation(() => window.api.memory.deleteEntry(request)),
    clearAll: () => applyMutation(() => window.api.memory.clearAll()),
    listen: () => {
      if (!window.api?.memory) return () => undefined
      return window.api.memory.onChanged(({ revision }) => {
        if (revision > get().revision) void get().load()
      })
    }
  }
})
