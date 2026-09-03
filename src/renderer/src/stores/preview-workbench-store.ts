import { create } from 'zustand'

import type { NotebookSessionReference } from '../../../shared/notebook'
import type { ProjectFileOriginSession } from '../../../shared/project-files'
import type { FindingLocator } from '../../../shared/reviewer'
import type { UploadedAttachment } from '../../../shared/uploads'
import { getUploadedAttachmentPath } from '../../../shared/uploads'
import type { PdfReadingPosition } from '../../../shared/session-persistence'

import { resolvePlanFileProjection } from '../pages/workspace/session-plan/plan-file-projection'
import {
  dialogPreviewGuardScope,
  previewLeaveGuards,
  workbenchPreviewGuardScope
} from './preview-leave-guard'
import { useSessionStore } from './session-store'

const activeWorkbenchGuardScope = (state: PreviewWorkbenchStoreData): string | undefined =>
  workbenchPreviewGuardScope(state.activeProjectId, state.activeItemId)

export type PreviewPanelState = 'open' | 'collapsed'
export type PreviewFileFormat =
  | 'code'
  | 'markdown'
  | 'text'
  | 'json'
  | 'csv'
  | 'fasta'
  | 'html'
  | 'image'
  | 'tiff'
  | 'pdb'
  | 'molecule'
  | 'pdf'
  | 'word'
  | 'spreadsheet'
  | 'presentation'
  | 'unknown'
// Distinguishes generated artifacts from user uploads, notebook inputs, and local ("This computer")
// files when preview readers and header actions differ. 'local' files live outside app storage:
// their path is an absolute filesystem path read via window.api.localFs.
export type PreviewFileSource = 'artifact' | 'upload' | 'notebook-input' | 'local'
export const PROJECT_FILES_PREVIEW_ID = 'tool:project:files'

type PreviewItemBase = {
  id: string
  projectId?: string
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
  artifactId?: string
  managedFileId?: string
  selectedVersionId?: string
  versionNumber?: number
  originSession?: ProjectFileOriginSession
}

// Tool previews share the workbench chrome with files, but keep their own render path.
export type PreviewToolItem = PreviewItemBase & {
  type: 'tool'
  toolKind?: 'notebook' | 'files' | 'reviewer' | 'plan' | 'subagents'
  notebook?: NotebookSessionReference
  // Reviewer-specific: which session's reviews to show, which review to select, and the active
  // finding to scroll to.
  reviewerSessionId?: string
  reviewerReviewId?: string
  reviewerActiveFindingId?: string
  planArtifactVersionId?: string
  // Session-scoped Subagents Preview: one stable item owns the selected read-only Agent Frame.
  selectedAgentFrameId?: string
}

export type PreviewSourceItem = PreviewItemBase & {
  type: 'source'
  url: string
}

export type PreviewItem = PreviewFileItem | PreviewToolItem | PreviewSourceItem

export type PendingPdfContextSelection =
  | { kind: 'staged-upload'; attachmentId: string; previewItemId: string }
  | {
      kind: 'version'
      sourceKind: 'artifact-version' | 'upload-version'
      sourceFileId: string
      sourceVersionId: string
      previewItemId: string
    }

export const pendingPdfContextBindingId = (selection: PendingPdfContextSelection): string =>
  selection.kind === 'staged-upload'
    ? `staged:${selection.attachmentId}`
    : `version:${selection.sourceKind}:${selection.sourceVersionId}`

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
  // A not-yet-created Session has no durable runtime context. Keep only the staged Upload identity
  // here until first-send finalization turns it into an immutable Session PDF binding.
  pendingPdfContextByProject: Record<string, PendingPdfContextSelection>
  // Upload ids currently attached to the active new-conversation draft, mirrored from the composer
  // controller. A staged-upload pending selection can only finalize through one of these, so
  // link affordances for any other staged upload (e.g. a preview tab whose attachment was removed
  // from the draft) must refuse instead of creating a selection nothing can honor.
  draftStagedUploadIds: string[]
  // Ephemeral viewport state. Only captureSend copies the active value into a durable Message.
  pdfReadingPositionByBindingId: Record<string, PdfReadingPosition>
  // Tool tab currently shown as a large modal instead of inline panel content (files tab only).
  expandedToolItemId: string | null
  // A one-off file preview stays outside the tab list so Files and Global Search can open the same
  // dialog without creating a durable workbench tab.
  fileDialogItem: PreviewFileItem | undefined
}

type PreviewWorkbenchStore = PreviewWorkbenchStoreData & {
  activateProject: (
    projectId: string,
    restored?: RestoredPreviewSlice,
    skipGuard?: boolean
  ) => boolean
  reconcileFinalizedUploads: (uploads: UploadedAttachment[]) => void
  setPendingPdfContext: (
    projectId: string,
    selection: PendingPdfContextSelection | undefined
  ) => void
  clearPendingPdfContext: (projectId: string, selection: PendingPdfContextSelection) => void
  setDraftStagedUploadIds: (ids: string[]) => void
  setPdfReadingPosition: (bindingId: string, position: PdfReadingPosition) => void
  clearPdfReadingPosition: (bindingId: string) => void
  upsertItem: (item: PreviewItem, skipGuard?: boolean) => boolean
  upsertAndActivateItem: (item: PreviewItem) => void
  activateItem: (itemId: string) => void
  removeItem: (itemId: string) => boolean
  removeOtherItems: (keepItemId: string) => boolean
  removeSessionItems: (sessionId: string) => void
  setToolItemExpanded: (itemId: string | null) => void
  openFileDialog: (item: PreviewFileItem, skipGuard?: boolean) => boolean
  closeFileDialog: (skipGuard?: boolean) => boolean
  openPanel: () => void
  collapsePanel: () => void
  togglePanel: () => void
  syncPanelState: (panelState: PreviewPanelState) => boolean
}

// Creates a fresh transient preview workbench state for the app and isolated tests.
export const createInitialPreviewWorkbenchState = (): PreviewWorkbenchStoreData => ({
  items: [],
  activeItemId: undefined,
  panelState: 'collapsed',
  openRequestVersion: 0,
  activeProjectId: undefined,
  byProject: {},
  pendingPdfContextByProject: {},
  draftStagedUploadIds: [],
  pdfReadingPositionByBindingId: {},
  expandedToolItemId: null,
  fileDialogItem: undefined
})

// The empty slice a project starts from before any preview tabs are opened.
const createEmptyPreviewSlice = (): PreviewSlice => ({
  items: [],
  activeItemId: undefined,
  panelState: 'collapsed',
  openRequestVersion: 0
})

// Preview capabilities are project-scoped. Persisted tabs created before project scope was stored
// are repaired from the owning workbench slice, and callers cannot accidentally omit that scope.
const withProjectScope = (item: PreviewItem, projectId: string | undefined): PreviewItem =>
  (item.type === 'file' || item.type === 'source') && !item.projectId && projectId
    ? { ...item, projectId }
    : item

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

const changesActiveFileSelection = (
  state: PreviewWorkbenchStoreData,
  item: PreviewItem
): boolean => {
  if (item.type !== 'file' || item.id !== state.activeItemId) return false
  const current = state.items.find(
    (candidate): candidate is StoredPreviewItem & PreviewFileItem =>
      candidate.id === item.id && candidate.type === 'file'
  )
  return Boolean(
    current &&
    (current.path !== item.path ||
      current.selectedVersionId !== item.selectedVersionId ||
      current.managedFileId !== item.managedFileId)
  )
}

const upsertPreviewItem = (
  state: PreviewWorkbenchStoreData,
  item: PreviewItem
): Pick<PreviewWorkbenchStoreData, 'items' | 'activeItemId'> => {
  const scopedItem = withProjectScope(item, state.activeProjectId)
  const existingIndex = state.items.findIndex((previewItem) => previewItem.id === scopedItem.id)
  if (existingIndex === -1) {
    const hasActiveItem = state.items.some((previewItem) => previewItem.id === state.activeItemId)
    return {
      items: [...state.items, createStoredPreviewItem(scopedItem)],
      activeItemId: hasActiveItem ? state.activeItemId : (state.items[0]?.id ?? scopedItem.id)
    }
  }
  return {
    items: state.items.map((previewItem, index) =>
      index === existingIndex ? createStoredPreviewItem(scopedItem, previewItem) : previewItem
    ),
    activeItemId: state.activeItemId
  }
}

// Rebuilds a project's live slice from its persisted durable subset, repairing a dangling active tab.
const restoredToSlice = (restored: RestoredPreviewSlice, projectId: string): PreviewSlice => {
  const items = (restored.items ?? []).map((item) =>
    createStoredPreviewItem(withProjectScope(item, projectId))
  )
  const activeItemId = items.some((item) => item.id === restored.activeItemId)
    ? restored.activeItemId
    : items[0]?.id

  return {
    items,
    activeItemId,
    panelState: items.length > 0 ? (restored.panelState ?? 'collapsed') : 'collapsed',
    openRequestVersion: 0
  }
}

// Persistence owns file tabs and the Session-scoped Subagents selection. Other tool tabs are
// reconstructed by their runtime owners and must survive a durable snapshot refresh.
const isDurablePreviewItem = (item: PreviewItem): boolean =>
  item.type === 'file' || (item.type === 'tool' && item.toolKind === 'subagents')

const mergeRestoredPreviewSlice = (
  current: PreviewSlice,
  restored: RestoredPreviewSlice,
  projectId: string
): PreviewSlice => {
  const authoritative = restoredToSlice(restored, projectId)
  const authoritativeIds = new Set(authoritative.items.map((item) => item.id))
  const runtimeItems = current.items.filter(
    (item) => !isDurablePreviewItem(item) && !authoritativeIds.has(item.id)
  )
  const activeRuntimeItem = runtimeItems.some((item) => item.id === current.activeItemId)
  const activeItemId = activeRuntimeItem
    ? current.activeItemId
    : (authoritative.activeItemId ?? runtimeItems[0]?.id)

  return {
    ...authoritative,
    items: [...authoritative.items, ...runtimeItems],
    activeItemId,
    panelState:
      activeRuntimeItem || (!authoritative.activeItemId && runtimeItems.length > 0)
        ? current.panelState
        : authoritative.panelState,
    openRequestVersion: current.openRequestVersion
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

const createSessionPlanPreviewItem = (
  sessionId: string,
  projectId: string,
  artifactVersionId?: string
): PreviewToolItem => ({
  id: `tool:${sessionId}:plan${artifactVersionId ? `:${artifactVersionId}` : ''}`,
  projectId,
  sessionId,
  type: 'tool',
  toolKind: 'plan',
  title: 'Session Plan',
  ...(artifactVersionId ? { planArtifactVersionId: artifactVersionId } : {})
})

// Opening a saved Plan artifact file from any file entry point activates the Session Plan tool
// tab — the same version-scoped tab the in-chat "view plan" entries use — so one Plan stays one
// tab and keeps its approval and step-status surface. Files without a matching stored projection
// (archived Session, pruned plan history) stay file previews; the JSON renderer shows the
// document there.
const redirectPlanArtifactFileItem = (item: PreviewItem): PreviewItem => {
  if (item.type !== 'file' || item.format !== 'json' || !item.selectedVersionId) return item
  const session = useSessionStore
    .getState()
    .sessions.find((candidate) => candidate.id === item.sessionId)
  if (!session?.projectId) return item
  if (!resolvePlanFileProjection(session, item.selectedVersionId)) return item
  return createSessionPlanPreviewItem(item.sessionId, session.projectId, item.selectedVersionId)
}

const createSessionSubagentsPreviewItem = (
  sessionId: string,
  projectId: string | undefined,
  selectedAgentFrameId: string
): PreviewToolItem => ({
  id: `tool:${sessionId}:subagents`,
  ...(projectId ? { projectId } : {}),
  sessionId,
  type: 'tool',
  toolKind: 'subagents',
  title: 'Subagents',
  selectedAgentFrameId
})

// Builds the stable project-level preview tab that owns the file library surface.
const createProjectFilesPreviewItem = (): PreviewToolItem => ({
  id: PROJECT_FILES_PREVIEW_ID,
  sessionId: '__project_files__',
  type: 'tool',
  toolKind: 'files',
  title: 'Files'
})

// Input for opening the Session reviewer panel; findingId/locator determine scroll position.
export type SessionReviewerPreviewInput = {
  sessionId: string
  reviewId: string
  findingId: string | undefined
  locator: FindingLocator | undefined
}

// Builds a stable preview tab for the Session reviewer panel scoped to one session. The id is
// session-scoped so "Go to transcript" from any card in the same session reuses the same tab.
const createSessionReviewerPreviewItem = (input: SessionReviewerPreviewInput): PreviewToolItem => ({
  id: `tool:${input.sessionId}:reviewer`,
  sessionId: input.sessionId,
  type: 'tool',
  toolKind: 'reviewer',
  title: 'Session Reviewer',
  reviewerSessionId: input.sessionId,
  reviewerReviewId: input.reviewId,
  reviewerActiveFindingId: input.findingId
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
    if (!upload) return item
    const path = getUploadedAttachmentPath(upload, item.projectId)
    if (path === item.path && upload.sessionId === item.sessionId) return item

    changed = true
    return { ...item, sessionId: upload.sessionId, path, updatedAt }
  })

  return changed ? reconciledItems : items
}

export const usePreviewWorkbenchStore = create<PreviewWorkbenchStore>((set, get) => ({
  ...createInitialPreviewWorkbenchState(),

  // Switches the visible preview slice to a project's own tabs, stashing the outgoing project's slice
  // so returning to it restores its tabs. `restored` replaces the durable subset with authoritative
  // persistence while retaining runtime-owned tool tabs.
  activateProject: (projectId, restored, skipGuard = false) => {
    const activate = (): true => {
      set((state) => {
        if (state.activeProjectId === projectId) {
          if (!restored) return state

          const targetSlice = mergeRestoredPreviewSlice(state, restored, projectId)
          const expandedToolItemId = targetSlice.items.some(
            (item) => item.id === state.expandedToolItemId && !isDurablePreviewItem(item)
          )
            ? state.expandedToolItemId
            : null

          return {
            ...targetSlice,
            expandedToolItemId,
            fileDialogItem: state.fileDialogItem
          }
        }

        const byProject = { ...state.byProject }

        if (state.activeProjectId) {
          byProject[state.activeProjectId] = {
            items: state.items,
            activeItemId: state.activeItemId,
            panelState: state.panelState,
            openRequestVersion: state.openRequestVersion
          }
        }

        const cachedSlice = byProject[projectId]
        const targetSlice = restored
          ? mergeRestoredPreviewSlice(cachedSlice ?? createEmptyPreviewSlice(), restored, projectId)
          : (cachedSlice ?? createEmptyPreviewSlice())

        // The active slice lives at top level, never duplicated in the stash.
        delete byProject[projectId]

        // The expanded files surface is tied to the outgoing project's workbench layout.
        return {
          ...targetSlice,
          panelState: targetSlice.items.length > 0 ? targetSlice.panelState : 'collapsed',
          activeProjectId: projectId,
          byProject,
          expandedToolItemId: null,
          fileDialogItem:
            state.fileDialogItem?.projectId === projectId ? state.fileDialogItem : undefined
        }
      })
      return true
    }
    return get().activeProjectId !== projectId && !skipGuard
      ? previewLeaveGuards.request(activeWorkbenchGuardScope(get()), activate)
      : activate()
  },

  // Repairs already-open upload tabs after staged files move into their permanent session folder.
  reconcileFinalizedUploads: (uploads) => {
    if (uploads.length === 0) return

    const uploadByPreviewId = new Map(uploads.map((upload) => [`upload:${upload.id}`, upload]))
    const updatedAt = Date.now()
    const current = get()
    const activeItem = current.items.find((item) => item.id === current.activeItemId)
    const activeUpload =
      activeItem?.type === 'file' && activeItem.source === 'upload'
        ? uploadByPreviewId.get(activeItem.id)
        : undefined
    const reconcile = (
      activeUploadByPreviewId: Map<string, UploadedAttachment>,
      stashedUploadByPreviewId = activeUploadByPreviewId
    ): void =>
      set((state) => {
        const items = reconcileUploadPreviewItems(state.items, activeUploadByPreviewId, updatedAt)
        let byProject = state.byProject

        // Repair inactive project slices too without creating tabs for uploads never opened by users.
        for (const [projectId, slice] of Object.entries(state.byProject)) {
          const reconciledItems = reconcileUploadPreviewItems(
            slice.items,
            stashedUploadByPreviewId,
            updatedAt
          )
          if (reconciledItems === slice.items) continue

          if (byProject === state.byProject) byProject = { ...state.byProject }
          byProject[projectId] = { ...slice, items: reconciledItems }
        }

        if (items === state.items && byProject === state.byProject) return state

        return { items, byProject }
      })
    const activeUploadChanges =
      activeItem?.type === 'file' &&
      activeUpload &&
      (getUploadedAttachmentPath(activeUpload, activeItem.projectId) !== activeItem.path ||
        activeUpload.sessionId !== activeItem.sessionId)
    if (activeUploadChanges && activeUpload) {
      // A dirty active upload may keep its staged path until discard is confirmed. Other visible
      // tabs and inactive project slices are not protected by that draft and must reconcile now.
      const unprotectedActiveUploads = new Map(uploadByPreviewId)
      unprotectedActiveUploads.delete(activeItem.id)
      reconcile(unprotectedActiveUploads, uploadByPreviewId)

      const protectedUpload = new Map([[activeItem.id, activeUpload]])
      previewLeaveGuards.request(activeWorkbenchGuardScope(current), () =>
        reconcile(protectedUpload)
      )
      return
    }
    reconcile(uploadByPreviewId)
  },

  setPendingPdfContext: (projectId, selection) => {
    set((state) => {
      const current = state.pendingPdfContextByProject[projectId]
      if (JSON.stringify(current) === JSON.stringify(selection)) return state
      const pendingPdfContextByProject = { ...state.pendingPdfContextByProject }
      if (selection) pendingPdfContextByProject[projectId] = selection
      else delete pendingPdfContextByProject[projectId]
      return { pendingPdfContextByProject }
    })
  },

  clearPendingPdfContext: (projectId, selection) => {
    set((state) => {
      const current = state.pendingPdfContextByProject[projectId]
      if (JSON.stringify(current) !== JSON.stringify(selection)) return state
      const pendingPdfContextByProject = { ...state.pendingPdfContextByProject }
      delete pendingPdfContextByProject[projectId]
      return { pendingPdfContextByProject }
    })
  },

  setDraftStagedUploadIds: (ids) => {
    set((state) => {
      const current = state.draftStagedUploadIds
      if (current.length === ids.length && current.every((id, index) => id === ids[index])) {
        return state
      }
      return { draftStagedUploadIds: ids }
    })
  },

  setPdfReadingPosition: (bindingId, position) => {
    set((state) => {
      const current = state.pdfReadingPositionByBindingId[bindingId]
      if (current?.pageNumber === position.pageNumber && current.pageCount === position.pageCount) {
        return state
      }
      return {
        pdfReadingPositionByBindingId: {
          ...state.pdfReadingPositionByBindingId,
          [bindingId]: position
        }
      }
    })
  },

  clearPdfReadingPosition: (bindingId) => {
    set((state) => {
      if (!state.pdfReadingPositionByBindingId[bindingId]) return state
      const pdfReadingPositionByBindingId = { ...state.pdfReadingPositionByBindingId }
      delete pdfReadingPositionByBindingId[bindingId]
      return { pdfReadingPositionByBindingId }
    })
  },

  // Inserts a preview item or refreshes the existing tab without changing focus.
  upsertItem: (item, skipGuard = false) => {
    const upsert = (): true => {
      set((state) => upsertPreviewItem(state, item))
      return true
    }
    return changesActiveFileSelection(get(), item) && !skipGuard
      ? previewLeaveGuards.request(activeWorkbenchGuardScope(get()), upsert)
      : upsert()
  },

  // Opens the panel and activates the item for first-time preview requests.
  upsertAndActivateItem: (item) => {
    const activeItem = redirectPlanArtifactFileItem(item)
    const current = get()
    const upsertAndActivate = (): void =>
      set((state) => ({
        ...upsertPreviewItem(state, activeItem),
        activeItemId: activeItem.id,
        panelState: 'open',
        openRequestVersion: state.openRequestVersion + 1
      }))
    if (
      changesActiveFileSelection(current, activeItem) ||
      (current.activeItemId !== undefined && current.activeItemId !== activeItem.id)
    ) {
      previewLeaveGuards.request(activeWorkbenchGuardScope(current), upsertAndActivate)
      return
    }
    upsertAndActivate()
  },

  // Moves focus only to an item that is still present in the preview list.
  activateItem: (itemId) => {
    if (!get().items.some((item) => item.id === itemId)) return
    if (get().activeItemId === itemId) return
    previewLeaveGuards.request(activeWorkbenchGuardScope(get()), () =>
      set((state) => ({
        activeItemId: itemId,
        items: state.items.map((item) =>
          item.id === itemId ? { ...item, updatedAt: Date.now() } : item
        )
      }))
    )
  },

  // Removes one preview tab and repairs focus if the active tab disappeared.
  removeItem: (itemId) => {
    let removed = false
    const remove = (): boolean => {
      set((state) => {
        const removedIndex = state.items.findIndex((item) => item.id === itemId)

        if (removedIndex === -1) return state
        removed = true

        const items = state.items.filter((item) => item.id !== itemId)
        const activeItemId =
          state.activeItemId === itemId
            ? getRepairedActiveItemId(items, removedIndex)
            : state.activeItemId

        return {
          items,
          activeItemId,
          panelState: items.length > 0 ? state.panelState : 'collapsed',
          expandedToolItemId: state.expandedToolItemId === itemId ? null : state.expandedToolItemId,
          fileDialogItem: itemId === PROJECT_FILES_PREVIEW_ID ? undefined : state.fileDialogItem
        }
      })
      return removed
    }
    return get().activeItemId === itemId
      ? previewLeaveGuards.request(activeWorkbenchGuardScope(get()), remove)
      : remove()
  },

  // Closes every preview tab except the kept one, which becomes the active tab. Owned here (not
  // composed from removeItem by callers) so expanded-surface and file-dialog teardown rules stay
  // in one place.
  removeOtherItems: (keepItemId) => {
    const state = get()
    if (!state.items.some((item) => item.id === keepItemId)) return false

    const workbenchScope =
      state.activeItemId !== keepItemId ? activeWorkbenchGuardScope(state) : undefined
    const removesProjectFilesTab =
      keepItemId !== PROJECT_FILES_PREVIEW_ID &&
      state.items.some((item) => item.id === PROJECT_FILES_PREVIEW_ID)
    const dialogScope =
      removesProjectFilesTab && state.fileDialogItem
        ? dialogPreviewGuardScope(state.fileDialogItem.projectId, state.fileDialogItem.id)
        : undefined
    const remove = (): true => {
      set((state) => {
        const keepsProjectFilesTab = keepItemId === PROJECT_FILES_PREVIEW_ID
        const closesProjectFilesTab =
          !keepsProjectFilesTab && state.items.some((item) => item.id === PROJECT_FILES_PREVIEW_ID)
        const items = state.items.filter((item) => item.id === keepItemId)

        return {
          items,
          activeItemId: keepItemId,
          expandedToolItemId: items.some((item) => item.id === state.expandedToolItemId)
            ? state.expandedToolItemId
            : null,
          fileDialogItem: closesProjectFilesTab ? undefined : state.fileDialogItem
        }
      })
      return true
    }
    return previewLeaveGuards.request(dialogScope, () =>
      previewLeaveGuards.request(workbenchScope, remove)
    )
  },

  // Drops all preview tabs owned by a deleted session and keeps focus on a valid tab.
  removeSessionItems: (sessionId) => {
    const state = get()
    const activeItem = state.items.find((item) => item.id === state.activeItemId)
    const workbenchScope =
      activeItem?.sessionId === sessionId ? activeWorkbenchGuardScope(state) : undefined
    const dialogScope =
      state.fileDialogItem?.sessionId === sessionId
        ? dialogPreviewGuardScope(state.fileDialogItem.projectId, state.fileDialogItem.id)
        : undefined
    previewLeaveGuards.request(dialogScope, () =>
      previewLeaveGuards.request(workbenchScope, () =>
        set((currentState) => {
          const firstRemovedIndex = currentState.items.findIndex(
            (item) => item.sessionId === sessionId
          )

          if (firstRemovedIndex === -1 && currentState.fileDialogItem?.sessionId !== sessionId)
            return currentState

          const items = currentState.items.filter((item) => item.sessionId !== sessionId)
          const activeItemId = items.some((item) => item.id === currentState.activeItemId)
            ? currentState.activeItemId
            : getRepairedActiveItemId(items, Math.max(0, firstRemovedIndex))

          return {
            items,
            activeItemId,
            // A session-scoped tool tab could own the expanded surface; clear it when its tab is gone.
            panelState: items.length > 0 ? currentState.panelState : 'collapsed',
            expandedToolItemId: items.some((item) => item.id === currentState.expandedToolItemId)
              ? currentState.expandedToolItemId
              : null,
            fileDialogItem:
              currentState.fileDialogItem?.sessionId === sessionId
                ? undefined
                : currentState.fileDialogItem
          }
        })
      )
    )
  },

  // Expands a tool tab (files) into a large modal surface, or restores the inline panel layout.
  setToolItemExpanded: (itemId) => {
    set({ expandedToolItemId: itemId })
  },

  openFileDialog: (item, skipGuard = false) => {
    const current = get().fileDialogItem
    return previewLeaveGuards.request(
      skipGuard ? undefined : dialogPreviewGuardScope(current?.projectId, current?.id),
      () => set({ fileDialogItem: item })
    )
  },

  closeFileDialog: (skipGuard = false) => {
    const item = get().fileDialogItem
    return previewLeaveGuards.request(
      skipGuard ? undefined : dialogPreviewGuardScope(item?.projectId, item?.id),
      () => set({ fileDialogItem: undefined })
    )
  },

  // Records an explicit open request so the resizable panel can expand even if it is already open.
  openPanel: () => {
    if (get().items.length === 0) return

    set((state) => ({
      panelState: 'open',
      openRequestVersion: state.openRequestVersion + 1
    }))
  },

  // Stores the manual collapsed state without changing preview item data.
  collapsePanel: () => {
    previewLeaveGuards.request(activeWorkbenchGuardScope(get()), () =>
      set({ panelState: 'collapsed' })
    )
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
    const sync = (): true => {
      set((state) => ({
        panelState: panelState === 'open' && state.items.length === 0 ? 'collapsed' : panelState
      }))
      return true
    }
    return panelState === 'collapsed'
      ? previewLeaveGuards.request(activeWorkbenchGuardScope(get()), sync)
      : sync()
  }
}))

export {
  createNotebookPreviewItem,
  createProjectFilesPreviewItem,
  createSessionPlanPreviewItem,
  createSessionSubagentsPreviewItem,
  createSessionReviewerPreviewItem
}
