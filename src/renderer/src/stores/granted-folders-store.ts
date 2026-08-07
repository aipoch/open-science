// Renderer-side cache of the folders the user granted the app access to ("Grant folder access").
// The main-process SQLite table is authoritative; every mutation channel returns the full updated
// list, so each action just stores what comes back. `loaded` distinguishes "never fetched" from
// "fetched, user granted nothing" so surfaces don't flash an empty state on first paint.
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

export const useGrantedFoldersStore = create<GrantedFoldersStore>((set) => {
  const apply = (roots: GrantedLocalRoot[]): GrantedLocalRoot[] => {
    set({ roots, loaded: true })
    return roots
  }

  return {
    ...createInitialGrantedFoldersState(),

    refresh: async () => apply(await window.api.localFs.listGrantedRoots()),

    // Rejections carry a user-presentable message from main; callers surface them and the store
    // keeps the previous list.
    grant: async (path, access) => apply(await window.api.localFs.grantRoot({ path, access })),

    setAccess: async (id, access) =>
      apply(await window.api.localFs.setGrantedRootAccess({ id, access })),

    remove: async (id) => apply(await window.api.localFs.removeGrantedRoot({ id }))
  }
})
