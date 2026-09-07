// Renderer-side cache of the folders the user granted the app access to ("Grant folder access").
// The main-process SQLite table is authoritative; every mutation channel returns the full updated
// list. A refresh that started before a successful mutation cannot replace that newer list. `loaded`
// distinguishes "never fetched" from "fetched, user granted nothing" so surfaces don't flash an
// empty state on first paint.
import { create } from 'zustand'

import type { GrantedLocalRoot, GrantedLocalRootAccess } from '../../../shared/local-fs'

type GrantedFoldersStoreData = {
  roots: GrantedLocalRoot[]
  loaded: boolean
}

type GrantedFoldersStore = GrantedFoldersStoreData & {
  refresh: () => Promise<GrantedLocalRoot[]>
  grant: (path: string, access: GrantedLocalRootAccess) => Promise<GrantedLocalRoot[]>
  setAccess: (id: string, access: GrantedLocalRootAccess) => Promise<GrantedLocalRoot[]>
  remove: (id: string) => Promise<GrantedLocalRoot[]>
}

// Fresh transient state for the app and isolated tests.
export const createInitialGrantedFoldersState = (): GrantedFoldersStoreData => ({
  roots: [],
  loaded: false
})

export const useGrantedFoldersStore = create<GrantedFoldersStore>((set, get) => {
  let mutationRevision = 0
  let refreshSequence = 0
  let mutationQueue: Promise<void> = Promise.resolve()

  const apply = (roots: GrantedLocalRoot[]): GrantedLocalRoot[] => {
    set({ roots, loaded: true })
    return roots
  }

  const applyMutation = (roots: GrantedLocalRoot[]): GrantedLocalRoot[] => {
    mutationRevision += 1
    return apply(roots)
  }

  // Full-list responses must publish in submission order within this renderer.
  const mutate = (operation: () => Promise<GrantedLocalRoot[]>): Promise<GrantedLocalRoot[]> => {
    const result = mutationQueue.then(operation).then(applyMutation)
    mutationQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  return {
    ...createInitialGrantedFoldersState(),

    refresh: async () => {
      const sequence = ++refreshSequence
      const startedAtRevision = mutationRevision
      const roots = await window.api.localFs.listGrantedRoots()
      return sequence === refreshSequence && startedAtRevision === mutationRevision
        ? apply(roots)
        : get().roots
    },

    // Rejections carry a user-presentable message from main; callers surface them and the store
    // keeps the previous list.
    grant: (path, access) => mutate(() => window.api.localFs.grantRoot({ path, access })),

    setAccess: (id, access) =>
      mutate(() => window.api.localFs.setGrantedRootAccess({ id, access })),

    remove: (id) => mutate(() => window.api.localFs.removeGrantedRoot({ id }))
  }
})
