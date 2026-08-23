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

  const apply = (roots: GrantedLocalRoot[]): GrantedLocalRoot[] => {
    set({ roots, loaded: true })
    return roots
  }

  const applyMutation = (roots: GrantedLocalRoot[]): GrantedLocalRoot[] => {
    mutationRevision += 1
    return apply(roots)
  }

  return {
    ...createInitialGrantedFoldersState(),

    refresh: async () => {
      const startedAtRevision = mutationRevision
      const roots = await window.api.localFs.listGrantedRoots()
      return startedAtRevision === mutationRevision ? apply(roots) : get().roots
    },

    // Rejections carry a user-presentable message from main; callers surface them and the store
    // keeps the previous list.
    grant: async (path, access) =>
      applyMutation(await window.api.localFs.grantRoot({ path, access })),

    setAccess: async (id, access) =>
      applyMutation(await window.api.localFs.setGrantedRootAccess({ id, access })),

    remove: async (id) => applyMutation(await window.api.localFs.removeGrantedRoot({ id }))
  }
})
