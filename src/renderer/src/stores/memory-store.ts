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
  selectedProjectId?: string
  selectCategory(id: string): void
  selectProject(id: string): void
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
  categories: [],
  projects: []
}

export const createInitialMemoryState = (): MemorySnapshot & {
  status: MemoryStore['status']
  error?: string
  selectedCategoryId?: string
  selectedProjectId?: string
} => ({ ...EMPTY_SNAPSHOT, status: 'idle' })

let loadSequence = 0

// Match the repository's unique category name key.
const categoryNameKey = (name: string): string =>
  name.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase()

const stateFromSnapshot = (
  snapshot: MemorySnapshot,
  selectedCategoryId?: string,
  selectedProjectId?: string
): Pick<
  MemoryStore,
  keyof MemorySnapshot | 'status' | 'selectedCategoryId' | 'selectedProjectId' | 'error'
> => {
  const projectExists = snapshot.projects.some(({ projectId }) => projectId === selectedProjectId)
  const categoryExists = snapshot.categories.some(({ id }) => id === selectedCategoryId)

  return {
    ...snapshot,
    status: 'ready',
    error: undefined,
    selectedCategoryId: projectExists
      ? undefined
      : categoryExists
        ? selectedCategoryId
        : snapshot.categories[0]?.id,
    selectedProjectId: projectExists ? selectedProjectId : undefined
  }
}

export const useMemoryStore = create<MemoryStore>((set, get) => {
  const applySnapshot = (snapshot: MemorySnapshot): boolean => {
    const state = get()
    if (snapshot.revision < state.revision) return false
    // Only an accepted snapshot can supersede pending loads.
    loadSequence += 1
    set(stateFromSnapshot(snapshot, state.selectedCategoryId, state.selectedProjectId))
    return true
  }

  const applyMutation = async (operation: () => Promise<MemorySnapshot>): Promise<void> => {
    try {
      applySnapshot(await operation())
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'memory' })
      throw error
    }
  }

  return {
    ...createInitialMemoryState(),
    selectCategory: (selectedCategoryId) =>
      set({ selectedCategoryId, selectedProjectId: undefined }),
    selectProject: (selectedProjectId) => set({ selectedCategoryId: undefined, selectedProjectId }),
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
        if (!applySnapshot(snapshot)) set({ status: 'ready' })
      } catch {
        if (sequence !== loadSequence) return
        set({ status: 'error', error: 'load' })
      }
    },
    setEnabled: (enabled) => applyMutation(() => window.api.memory.setEnabled({ enabled })),
    createCategory: async (request) => {
      const requestedNameKey = categoryNameKey(request.name)
      let createdId = ''
      await applyMutation(async () => {
        const snapshot = await window.api.memory.createCategory(request)
        createdId =
          snapshot.categories.find(
            (category) => 'name' in category && categoryNameKey(category.name) === requestedNameKey
          )?.id ?? ''
        return snapshot
      })
      if (!createdId) throw new Error('Created memory category is missing.')
      if (get().categories.some(({ id }) => id === createdId)) {
        set({ selectedCategoryId: createdId, selectedProjectId: undefined })
      }
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
