import { create } from 'zustand'

import type { AppInfo, UpdateStatus } from '../../../shared/update'

type UpdateStore = {
  appInfo: AppInfo | null
  status: UpdateStatus
  // Whether the update confirmation dialog is open (opened from the capsule or the settings button).
  isDialogOpen: boolean
  init: () => void
  check: () => Promise<void>
  openDialog: () => void
  closeDialog: () => void
  download: () => Promise<void>
  cancel: () => Promise<void>
  apply: () => Promise<void>
}

// Single source of truth for update state in the renderer. The main process broadcasts every
// transition; this store mirrors it so the settings section and the external capsule agree.
export const useUpdateStore = create<UpdateStore>((set, get) => ({
  appInfo: null,
  status: { state: 'idle', current: '' },
  isDialogOpen: false,

  // Runs once at startup: loads app info, subscribes to pushed status/progress, then hydrates the
  // status that may already exist from the scheduler's startup check (which ran before any window
  // existed, so its broadcast was dropped). Degrades to a no-op when the preload bridge is absent
  // (e.g. a stray dev/preview mount).
  init: () => {
    const api = window.api?.update
    if (!api) return
    void api
      .getAppInfo()
      .then((info) =>
        set((s) => ({ appInfo: info, status: { ...s.status, current: info.version } }))
      )
    api.onStatus((status) => set({ status }))
    api.onProgress((progress) =>
      set((s) => ({
        status: {
          ...s.status,
          progress: progress.percent,
          downloadedBytes: progress.transferred,
          totalBytes: progress.total,
          downloadProgress: progress
        }
      }))
    )
    void api.getStatus().then((status) => {
      // Only apply the startup snapshot if no live broadcast has updated us yet.
      if (get().status.state === 'idle') set({ status })
    })
  },

  check: async () => {
    const api = window.api?.update
    if (!api) return
    set({ status: await api.check() })
  },

  openDialog: () => set({ isDialogOpen: true }),

  // Closing the dialog aborts any in-flight download. Cancel a request unconditionally rather than
  // gating on the local 'downloading' state: right after clicking Download the 'downloading' broadcast
  // may not have arrived yet, so a guarded call would miss it and leave the download running — the
  // exact race in issue #216. The main-process cancel() is a no-op when nothing is downloading.
  closeDialog: () => {
    void get().cancel()
    set({ isDialogOpen: false })
  },

  download: async () => {
    const api = window.api?.update
    if (!api) return
    set({ status: await api.download() })
  },

  cancel: async () => {
    const cancel = window.api?.update?.cancel
    if (!cancel) return
    set({ status: await cancel() })
  },

  apply: async () => {
    const api = window.api?.update
    if (!api) return
    const status = await api.apply()
    if (status) set({ status })
  }
}))
