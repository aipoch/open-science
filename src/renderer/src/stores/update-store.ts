import { create } from 'zustand'

import type { AppInfo, UpdateStatus } from '../../../shared/update'

type UpdateStore = {
  appInfo: AppInfo | null
  status: UpdateStatus
  // Whether the update confirmation dialog is open (opened from the capsule or the settings button).
  isDialogOpen: boolean
  init: () => () => void
  check: () => Promise<void>
  openDialog: () => void
  closeDialog: () => void
  download: () => Promise<void>
  cancel: () => Promise<void>
  apply: () => Promise<void>
}

let cleanupUpdateSubscriptions: (() => void) | undefined
let statusRevision = 0

// ponytail: local observation order protects replies from newer live state. Arbitrarily reordered
// broadcasts would require a main-process revision shared by every response and event.
const acceptUpdateResponse = async (request: () => Promise<UpdateStatus | void>): Promise<void> => {
  const revision = statusRevision
  const status = await request()
  if (!status || revision !== statusRevision) return
  statusRevision += 1
  useUpdateStore.setState({ status })
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
    cleanupUpdateSubscriptions?.()
    const api = window.api?.update
    if (!api) return () => undefined
    void api
      .getAppInfo()
      .then((info) =>
        set((s) => ({ appInfo: info, status: { ...s.status, current: info.version } }))
      )
    // Status events don't carry downloadProgress. A strategy that emits progress (with speed) then
    // immediately a status (electron-updater does on every tick) would otherwise wipe the speed the
    // progress event just set. Preserve downloadProgress across a status update while downloading so
    // DownloadProgressLine keeps rendering speed/ETA on Win/Linux.
    const removeStatusListener = api.onStatus((status) => {
      statusRevision += 1
      set((s) => ({
        status: {
          ...status,
          downloadProgress: status.state === 'downloading' ? s.status.downloadProgress : undefined
        }
      }))
    })
    const removeProgressListener = api.onProgress((progress) => {
      statusRevision += 1
      set((s) => ({
        status: {
          ...s.status,
          // A `reconnecting` event omits percent/total (bytesPerSecond: 0); keep the last known
          // values so the action button doesn't flip to "Downloading 0%" and drop the size label
          // mid-reconnect. downloadProgress always carries the raw event for DownloadProgressLine.
          progress: progress.percent ?? s.status.progress,
          downloadedBytes: progress.transferred,
          totalBytes: progress.total ?? s.status.totalBytes,
          downloadProgress: progress
        }
      }))
    })
    void acceptUpdateResponse(() => api.getStatus())

    let active = true
    const cleanup = (): void => {
      if (!active) return
      active = false
      statusRevision += 1
      removeStatusListener?.()
      removeProgressListener?.()
      if (cleanupUpdateSubscriptions === cleanup) cleanupUpdateSubscriptions = undefined
    }
    cleanupUpdateSubscriptions = cleanup
    return cleanup
  },

  check: async () => {
    const api = window.api?.update
    if (!api) return
    await acceptUpdateResponse(() => api.check())
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
    await acceptUpdateResponse(() => api.download())
  },

  cancel: async () => {
    const cancel = window.api?.update?.cancel
    if (!cancel) return
    await acceptUpdateResponse(() => cancel())
  },

  apply: async (options?: { force?: boolean }) => {
    const api = window.api?.update
    if (!api) return
    await acceptUpdateResponse(() => api.apply(options))
  }
}))
