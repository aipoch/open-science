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
// Keep the last authoritative assignments separate from in-flight local intent.
// Every accepted snapshot is projected through the pending writes in request order.
let confirmedAssignments: TagSnapshot['assignments'] = []
let nextAssignmentWrite = 0
const pendingAssignments = new Map<
  number,
  { request: SetTagAssignmentRequest; createdAt: number }
>()
const settledAssignments = new Map<string, number>()
const assignmentKey = (
  value: Pick<SetTagAssignmentRequest, 'tagId' | 'resourceType' | 'resourceId'>
): string => JSON.stringify([value.tagId, value.resourceType, value.resourceId])

const projectAssignments = (tags: TagSnapshot['tags']): TagSnapshot['assignments'] => {
  const assignments = new Map(
    confirmedAssignments.map((assignment) => [assignmentKey(assignment), assignment])
  )
  const tagIds = new Set(tags.map((tag) => tag.id))
  for (const [sequence, { request, createdAt }] of pendingAssignments) {
    const key = assignmentKey(request)
    if (sequence <= (settledAssignments.get(key) ?? 0) || !tagIds.has(request.tagId)) continue
    if (!request.assigned) assignments.delete(key)
    else if (!assignments.has(key))
      assignments.set(key, {
        tagId: request.tagId,
        resourceType: request.resourceType,
        resourceId: request.resourceId,
        createdAt
      })
  }
  return [...assignments.values()]
}

// A later optimistic backup may contain an earlier failed write. Follow those backups only
// when the failing write still owns the projection; authority snapshots always take precedence.
const failedTagProjections = new WeakMap<TagSnapshot['tags'], TagSnapshot['tags']>()
const rollbackProjection = <T>(failed: WeakMap<T[], T[]>, optimistic: T[], before: T[]): T[] => {
  failed.set(optimistic, before)
  let restored = before
  while (failed.has(restored)) restored = failed.get(restored)!
  return restored
}

const stateFromSnapshot = (snapshot: TagSnapshot): Pick<TagStore, keyof TagSnapshot | 'status'> => {
  confirmedAssignments = snapshot.assignments
  return { ...snapshot, assignments: projectAssignments(snapshot.tags), status: 'ready' }
}

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
    const revision = get().revision
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
    const optimistic = get().tags
    try {
      const snapshot = await window.api.tags.reorder(request)
      loadSequence += 1
      set((state) => ({ ...stateFromMutationSnapshot(snapshot, state.revision), error: undefined }))
    } catch (error) {
      const restored = rollbackProjection(failedTagProjections, optimistic, before)
      if (get().revision === revision && get().tags === optimistic) set({ tags: restored })
      await get().load()
      throw error
    }
  },
  setAssignment: async (request) => {
    if (pendingAssignments.size === 0) {
      confirmedAssignments = get().assignments
      settledAssignments.clear()
    }
    const sequence = ++nextAssignmentWrite
    const key = assignmentKey(request)
    pendingAssignments.set(sequence, { request, createdAt: Date.now() })
    set({ assignments: projectAssignments(get().tags) })
    try {
      const snapshot = await window.api.tags.setAssignment(request)
      pendingAssignments.delete(sequence)
      settledAssignments.set(key, Math.max(sequence, settledAssignments.get(key) ?? 0))
      loadSequence += 1
      set((state) => ({
        assignments: projectAssignments(state.tags),
        ...stateFromMutationSnapshot(snapshot, state.revision),
        error: undefined
      }))
    } catch (error) {
      pendingAssignments.delete(sequence)
      set({ assignments: projectAssignments(get().tags) })
      await get().load()
      throw error
    } finally {
      if (pendingAssignments.size === 0) settledAssignments.clear()
    }
  },
  listen: () => {
    if (!window.api?.tags) return () => undefined
    return window.api.tags.onChanged(({ revision }) => {
      if (revision > get().revision) void get().load()
    })
  }
}))
