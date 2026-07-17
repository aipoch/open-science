import { create } from 'zustand'

import type { NotebookSessionReference } from '../../../shared/notebook'
import type { UploadedAttachment } from '../../../shared/uploads'

export type PreviewPanelState = 'open' | 'collapsed'
export type PreviewFileFormat =
  | 'markdown'
  | 'text'
  | 'json'
  | 'csv'
  | 'fasta'
  | 'html'
  | 'image'
  | 'pdb'
  | 'molecule'
  | 'pdf'
  | 'word'
  | 'spreadsheet'
  | 'presentation'
  | 'unknown'
// Distinguishes generated artifacts from user uploads when preview readers and actions differ.
export type PreviewFileSource = 'artifact' | 'upload'
export const PROJECT_FILES_PREVIEW_ID = 'tool:project:files'

type PreviewItemBase = {
  id: string
  sessionId: string
  title: string
}

export type PreviewFileItem = PreviewItemBase & {
  type: 'file'
  source?: PreviewFileSource
  path: string
  format: PreviewFileFormat
  name: string
  mimeType?: string
  size?: number
  mtimeMs?: number
}

// Tool previews share the workbench chrome with files, but keep their own render path.
export type PreviewToolItem = PreviewItemBase & {
  type: 'tool'
  toolKind?: 'notebook' | 'files'
  notebook?: NotebookSessionReference
}

export type PreviewItem = PreviewFileItem | PreviewToolItem

type StoredPreviewItem = PreviewItem & {
  createdAt: number
  updatedAt: number
}

// The preview state for a single project. The store keeps the active project's slice at top level and
// stashes inactive projects' slices in `byProject` so switching projects never shows another's tabs.
type PreviewSlice = {
  items: StoredPreviewItem[]
  activeItemId: string | undefined
  panelState: PreviewPanelState
  openRequestVersion: number
}

// The durable subset restored from persistence when a project is first activated in a session.
export type RestoredPreviewSlice = {
  items?: PreviewItem[]
  activeItemId?: string
  panelState?: PreviewPanelState
}

type PreviewWorkbenchStoreData = PreviewSlice & {
  activeProjectId: string | undefined
  byProject: Record<string, PreviewSlice>
}

type PreviewWorkbenchStore = PreviewWorkbenchStoreData & {
  activateProject: (projectId: string, restored?: RestoredPreviewSlice) => void
  reconcileFinalizedUploads: (uploads: UploadedAttachment[]) => void
  upsertItem: (item: PreviewItem) => void
  upsertAndActivateItem: (item: PreviewItem) => void
  activateItem: (itemId: string) => void
  removeItem: (itemId: string) => void
  removeSessionItems: (sessionId: string) => void
  openPanel: () => void
  collapsePanel: () => void
  togglePanel: () => void
  syncPanelState: (panelState: PreviewPanelState) => void
}

// Creates a fresh transient preview workbench state for the app and isolated tests.
export const createInitialPreviewWorkbenchState = (): PreviewWorkbenchStoreData => ({
  items: [],
  activeItemId: undefined,
  panelState: 'collapsed',
  openRequestVersion: 0,
  activeProjectId: undefined,
  byProject: {}
})

// The empty slice a project starts from before any preview tabs are opened.
const createEmptyPreviewSlice = (): PreviewSlice => ({
  items: [],
  activeItemId: undefined,
  panelState: 'collapsed',
  openRequestVersion: 0
})

// Normalizes incoming preview items so callers never persist or manage timestamps themselves.
const createStoredPreviewItem = (
  item: PreviewItem,
  existingItem?: StoredPreviewItem
): StoredPreviewItem => {
  const now = Date.now()

  return {
    ...item,
    createdAt: existingItem?.createdAt ?? now,
    updatedAt: now
  } as StoredPreviewItem
}

// Rebuilds a project's live slice from its persisted durable subset, repairing a dangling active tab.
const restoredToSlice = (restored: RestoredPreviewSlice): PreviewSlice => {
  const items = (restored.items ?? []).map((item) => createStoredPreviewItem(item))
  const activeItemId = items.some((item) => item.id === restored.activeItemId)
    ? restored.activeItemId
    : items[0]?.id

  return {
    items,
    activeItemId,
    panelState: restored.panelState ?? 'collapsed',
    openRequestVersion: 0
  }
}

// Builds the stable preview tab identity for the notebook attached to one chat session.
const createNotebookPreviewItem = (notebook: NotebookSessionReference): PreviewToolItem => ({
  id: `tool:${notebook.sessionId}:notebook`,
  sessionId: notebook.sessionId,
  type: 'tool',
  toolKind: 'notebook',
  title: 'Notebook',
  notebook
})

// Builds the stable project-level preview tab that owns the file library surface.
const createProjectFilesPreviewItem = (): PreviewToolItem => ({
  id: PROJECT_FILES_PREVIEW_ID,
  sessionId: '__project_files__',
  type: 'tool',
  toolKind: 'files',
  title: 'Files'
})

// Chooses a stable fallback tab when the active preview item is removed.
const getRepairedActiveItemId = (
  items: StoredPreviewItem[],
  removedIndex: number
): string | undefined => {
  if (items.length === 0) return undefined

  return items[Math.min(removedIndex, items.length - 1)]?.id
}

// Updates matching upload tabs while preserving array identity when no item changes.
const reconcileUploadPreviewItems = (
  items: StoredPreviewItem[],
  uploadByPreviewId: Map<string, UploadedAttachment>,
  updatedAt: number
): StoredPreviewItem[] => {
  let changed = false
  const reconciledItems = items.map((item) => {
    if (item.type !== 'file' || item.source !== 'upload') return item

    const upload = uploadByPreviewId.get(item.id)
    if (!upload || (upload.path === item.path && upload.sessionId === item.sessionId)) return item

    changed = true
    return { ...item, sessionId: upload.sessionId, path: upload.path, updatedAt }
  })

  return changed ? reconciledItems : items
}

export const usePreviewWorkbenchStore = create<PreviewWorkbenchStore>((set, get) => ({
  ...createInitialPreviewWorkbenchState(),

  // Switches the visible preview slice to a project's own tabs, stashing the outgoing project's slice
  // so returning to it restores its tabs. `restored` seeds a project's slice from persistence on first
  // activation in this session.
  activateProject: (projectId, restored) => {
    set((state) => {
      if (state.activeProjectId === projectId) return state

      const byProject = { ...state.byProject }

      if (state.activeProjectId) {
        byProject[state.activeProjectId] = {
          items: state.items,
          activeItemId: state.activeItemId,
          panelState: state.panelState,
          openRequestVersion: state.openRequestVersion
        }
      }

      const targetSlice =
        byProject[projectId] ?? (restored ? restoredToSlice(restored) : createEmptyPreviewSlice())

      // The active slice lives at top level, never duplicated in the stash.
      delete byProject[projectId]

      return { ...targetSlice, activeProjectId: projectId, byProject }
    })
  },

  // Repairs already-open upload tabs after staged files move into their permanent session folder.
  reconcileFinalizedUploads: (uploads) => {
    if (uploads.length === 0) return

    const uploadByPreviewId = new Map(uploads.map((upload) => [`upload:${upload.id}`, upload]))
    const updatedAt = Date.now()

    set((state) => {
      const items = reconcileUploadPreviewItems(state.items, uploadByPreviewId, updatedAt)
      let byProject = state.byProject

      // Repair inactive project slices too without creating tabs for uploads never opened by users.
      for (const [projectId, slice] of Object.entries(state.byProject)) {
        const reconciledItems = reconcileUploadPreviewItems(
          slice.items,
          uploadByPreviewId,
          updatedAt
        )
        if (reconciledItems === slice.items) continue

        if (byProject === state.byProject) byProject = { ...state.byProject }
        byProject[projectId] = { ...slice, items: reconciledItems }
      }

      if (items === state.items && byProject === state.byProject) return state

      return { items, byProject }
    })
  },

  // Inserts a preview item or refreshes the existing tab without changing focus.
  upsertItem: (item) => {
    set((state) => {
      const existingIndex = state.items.findIndex((previewItem) => previewItem.id === item.id)

      // New items append to the horizontal preview list in discovery order.
      if (existingIndex === -1) {
        return {
          items: [...state.items, createStoredPreviewItem(item)]
        }
      }

      // Existing items keep their original position and creation time.
      return {
        items: state.items.map((previewItem, index) =>
          index === existingIndex ? createStoredPreviewItem(item, previewItem) : previewItem
        )
      }
    })
  },

  // Opens the panel and activates the item for first-time preview requests.
  upsertAndActivateItem: (item) => {
    get().upsertItem(item)
    set((state) => ({
      activeItemId: item.id,
      panelState: 'open',
      openRequestVersion: state.openRequestVersion + 1
    }))
  },

  // Moves focus only to an item that is still present in the preview list.
  activateItem: (itemId) => {
    if (!get().items.some((item) => item.id === itemId)) return

    set({ activeItemId: itemId })
  },

  // Removes one preview tab and repairs focus if the active tab disappeared.
  removeItem: (itemId) => {
    set((state) => {
      const removedIndex = state.items.findIndex((item) => item.id === itemId)

      if (removedIndex === -1) return state

      const items = state.items.filter((item) => item.id !== itemId)
      const activeItemId =
        state.activeItemId === itemId
          ? getRepairedActiveItemId(items, removedIndex)
          : state.activeItemId

      return {
        items,
        activeItemId
      }
    })
  },

  // Drops all preview tabs owned by a deleted session and keeps focus on a valid tab.
  removeSessionItems: (sessionId) => {
    set((state) => {
      const firstRemovedIndex = state.items.findIndex((item) => item.sessionId === sessionId)

      if (firstRemovedIndex === -1) return state

      const items = state.items.filter((item) => item.sessionId !== sessionId)
      const activeItemId = items.some((item) => item.id === state.activeItemId)
        ? state.activeItemId
        : getRepairedActiveItemId(items, firstRemovedIndex)

      return {
        items,
        activeItemId
      }
    })
  },

  // Records an explicit open request so the resizable panel can expand even if it is already open.
  openPanel: () => {
    set((state) => ({
      panelState: 'open',
      openRequestVersion: state.openRequestVersion + 1
    }))
  },

  // Stores the manual collapsed state without changing preview item data.
  collapsePanel: () => {
    set({ panelState: 'collapsed' })
  },

  // Keeps the header toggle behavior centralized with the panel state.
  togglePanel: () => {
    if (get().panelState === 'collapsed') {
      get().openPanel()
      return
    }

    get().collapsePanel()
  },

  // Mirrors resize-library state into the store after drag or imperative panel changes.
  syncPanelState: (panelState) => {
    set({ panelState })
  }
}))

export { createNotebookPreviewItem, createProjectFilesPreviewItem }
