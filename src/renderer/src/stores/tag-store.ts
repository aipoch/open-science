import { create } from 'zustand'

import type {
  CreateTagRequest,
  ReorderTagsRequest,
  SetTagAssignmentRequest,
  TagSnapshot,
  TagResourceType,
  UpdateTagRequest
} from '../../../shared/tags'

type TagStore = TagSnapshot & {
  status: 'idle' | 'loading' | 'ready' | 'error'
  error?: string
  browserSelectedId?: string
  browserTypeFilter: 'all' | TagResourceType
  browserQuery: string
  browserScrollTop: number
  setBrowserSelectedId(id: string): void
  setBrowserTypeFilter(value: 'all' | TagResourceType): void
  setBrowserQuery(value: string): void
  setBrowserScrollTop(value: number): void
  load(): Promise<void>
  create(request: CreateTagRequest): Promise<string>
  update(request: UpdateTagRequest): Promise<void>
  delete(id: string): Promise<void>
  reorder(request: ReorderTagsRequest): Promise<void>
  setAssignment(request: SetTagAssignmentRequest): Promise<void>
  listen(): () => void
}

const EMPTY_SNAPSHOT: TagSnapshot = { revision: 0, tags: [], assignments: [] }
export const createInitialTagState = (): TagSnapshot & {
  status: TagStore['status']
  error?: string
  browserSelectedId?: string
  browserTypeFilter: 'all' | TagResourceType
  browserQuery: string
  browserScrollTop: number
} => ({
  ...EMPTY_SNAPSHOT,
  status: 'idle',
  error: undefined,
  browserSelectedId: undefined,
  browserTypeFilter: 'all',
  browserQuery: '',
  browserScrollTop: 0
})
let loadSequence = 0

const stateFromSnapshot = (
  snapshot: TagSnapshot
): Pick<TagStore, keyof TagSnapshot | 'status'> => ({
  ...snapshot,
  status: 'ready'
})

const stateFromMutationSnapshot = (
  snapshot: TagSnapshot,
  currentRevision: number
): Partial<Pick<TagStore, keyof TagSnapshot | 'status'>> =>
  snapshot.revision < currentRevision ? { status: 'ready' } : stateFromSnapshot(snapshot)

export const useTagStore = create<TagStore>((set, get) => ({
  ...createInitialTagState(),
  setBrowserSelectedId: (browserSelectedId) =>
    set((state) =>
      state.browserSelectedId === browserSelectedId
        ? { browserSelectedId }
        : { browserSelectedId, browserScrollTop: 0 }
    ),
  setBrowserTypeFilter: (browserTypeFilter) => set({ browserTypeFilter, browserScrollTop: 0 }),
  setBrowserQuery: (browserQuery) => set({ browserQuery, browserScrollTop: 0 }),
  setBrowserScrollTop: (browserScrollTop) => set({ browserScrollTop }),
  load: async () => {
    if (!window.api?.tags) {
      set({ ...EMPTY_SNAPSHOT, status: 'error', error: 'load' })
      return
    }
    const sequence = ++loadSequence
    set({ status: 'loading', error: undefined })
    try {
      const snapshot = await window.api.tags.snapshot()
      if (sequence !== loadSequence) return
      if (snapshot.revision < get().revision) {
        set({ status: 'ready', error: undefined })
        return
      }
      set({ ...stateFromSnapshot(snapshot), error: undefined })
    } catch {
      if (sequence !== loadSequence) return
      set({ status: 'error', error: 'load' })
    }
  },
  create: async (request) => {
    const snapshot = await window.api.tags.create(request)
    loadSequence += 1
    set((state) => ({ ...stateFromMutationSnapshot(snapshot, state.revision), error: undefined }))
    const requestedNameKey = request.name
      .normalize('NFKC')
      .trim()
      .replace(/\s+/gu, ' ')
      .toLowerCase()
    const created = snapshot.tags.find(
      (tag) =>
        'name' in tag &&
        tag.name.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase() === requestedNameKey
    )
    if (!created) throw new Error('Created Tag missing from authoritative snapshot.')
    return created.id
  },
  update: async (request) => {
    const snapshot = await window.api.tags.update(request)
    loadSequence += 1
    set((state) => ({ ...stateFromMutationSnapshot(snapshot, state.revision), error: undefined }))
  },
  delete: async (id) => {
    const snapshot = await window.api.tags.delete({ id })
    loadSequence += 1
    set((state) => ({ ...stateFromMutationSnapshot(snapshot, state.revision), error: undefined }))
  },
  reorder: async (request) => {
    const before = get().tags
    const byId = new Map(before.map((tag) => [tag.id, tag]))
    set({
      tags: [
        ...before.filter((tag) => 'systemKey' in tag),
        ...request.tagIds.flatMap((id) => {
          const tag = byId.get(id)
          return tag && !('systemKey' in tag) ? [tag] : []
        })
      ]
    })
    try {
      const snapshot = await window.api.tags.reorder(request)
      loadSequence += 1
      set((state) => ({ ...stateFromMutationSnapshot(snapshot, state.revision), error: undefined }))
    } catch (error) {
      set({ tags: before })
      await get().load()
      throw error
    }
  },
  setAssignment: async (request) => {
    const before = get().assignments
    const matches = (assignment: TagSnapshot['assignments'][number]): boolean =>
      assignment.tagId === request.tagId &&
      assignment.resourceType === request.resourceType &&
      assignment.resourceId === request.resourceId
    set({
      assignments: request.assigned
        ? before.some(matches)
          ? before
          : [
              ...before,
              {
                tagId: request.tagId,
                resourceType: request.resourceType,
                resourceId: request.resourceId,
                createdAt: Date.now()
              }
            ]
        : before.filter((assignment) => !matches(assignment))
    })
    try {
      const snapshot = await window.api.tags.setAssignment(request)
      loadSequence += 1
      set((state) => ({ ...stateFromMutationSnapshot(snapshot, state.revision), error: undefined }))
    } catch (error) {
      set({ assignments: before })
      await get().load()
      throw error
    }
  },
  listen: () => {
    if (!window.api?.tags) return () => undefined
    return window.api.tags.onChanged(({ revision }) => {
      if (revision > get().revision) void get().load()
    })
  }
}))
