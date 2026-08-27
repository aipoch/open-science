// The preview tab context-menu model: one module owns both which actions a tab offers (decision)
// and what each action does (execution). The menu UI stays a thin renderer — it draws the list
// `getPreviewTabActions` returns and forwards picks to `runPreviewTabAction`, knowing nothing about
// store mutations or save pipelines.
//
// Actions that live inside a tab's content surface (Provenance, Reload, View in context, Plan
// download, full screen) are deliberately absent: they are owned by the surfaces themselves. This
// module only exposes actions that can run without mounting the tab's content.

import { CircleX, ClipboardCopy, Download, PackagePlus, X, type LucideIcon } from 'lucide-react'

import type { PreviewFileItem, PreviewItem } from '@/stores/preview-workbench-store'
import type { SaveManagedFileRequest } from '../../../../shared/file-save'

export type PreviewTabActionCommand =
  'close' | 'close-others' | 'download' | 'copy-path' | 'save-as-artifact'

export type PreviewTabAction = {
  command: PreviewTabActionCommand
  // English source text; doubles as the i18n key per repo convention.
  label: string
  // Icon follows the prototype's close affordances (×, ⊗) and the existing header buttons for
  // file actions, so the tab menu and the in-surface controls read as one family.
  icon: LucideIcon
  danger: boolean
  disabled: boolean
}

export type PreviewTabActionContext = {
  tabCount: number
}

// Shared actions appear for every tab; specific actions follow them below a separator. Returning
// groups (not a flat list) lets the menu render the divider without knowing which commands are
// shared.
export type PreviewTabActionGroups = {
  shared: PreviewTabAction[]
  specific: PreviewTabAction[]
}

// Everything an action needs from its host. Injected so tests exercise the command→effect mapping
// without a DOM, window.api, or a live store.
export type PreviewTabActionDeps = {
  closeTab: (itemId: string) => void
  closeOtherTabs: (keepItemId: string) => void
  saveManagedFile: (request: SaveManagedFileRequest) => Promise<unknown>
  copyText: (text: string) => Promise<void>
  stageLocalPath:
    | ((request: {
        transferId: string
        name: string
        sourcePath: string
        projectId?: string
      }) => Promise<unknown>)
    | undefined
  activeProjectId: string | undefined
}

const closeAction: PreviewTabAction = {
  command: 'close',
  label: 'Close',
  icon: X,
  danger: false,
  disabled: false
}

// Every tab can be closed; closing others is meaningless with nothing else open.
const sharedActions = (tabCount: number): PreviewTabAction[] => [
  closeAction,
  {
    command: 'close-others',
    label: 'Close others',
    icon: CircleX,
    danger: true,
    disabled: tabCount <= 1
  }
]

// File tabs add source-specific actions; tool tabs (Files, Notebook, Session Plan, Reviewer,
// Subagents) offer none here — their operations are content-surface interactions.
const fileSpecificActions = (item: PreviewFileItem): PreviewTabAction[] =>
  item.source === 'local'
    ? [
        {
          command: 'copy-path',
          label: 'Copy path',
          icon: ClipboardCopy,
          danger: false,
          disabled: false
        },
        { command: 'download', label: 'Download', icon: Download, danger: false, disabled: false },
        {
          command: 'save-as-artifact',
          label: 'Save as artifact',
          icon: PackagePlus,
          danger: false,
          disabled: false
        }
      ]
    : [{ command: 'download', label: 'Download', icon: Download, danger: false, disabled: false }]

export const getPreviewTabActionGroups = (
  item: PreviewItem,
  context: PreviewTabActionContext
): PreviewTabActionGroups => ({
  shared: sharedActions(context.tabCount),
  specific: item.type === 'file' ? fileSpecificActions(item) : []
})

const downloadManagedFile = async (
  item: PreviewFileItem,
  deps: PreviewTabActionDeps
): Promise<void> => {
  const source = item.source ?? 'artifact'
  if (source === 'artifact' || source === 'upload') {
    if (!item.projectId || !item.managedFileId) {
      throw new Error('Managed file download requires a logical identity.')
    }
    await deps.saveManagedFile({
      source,
      projectId: item.projectId,
      fileId: item.managedFileId,
      ...(item.selectedVersionId ? { versionId: item.selectedVersionId } : {}),
      suggestedName: item.name
    })
    return
  }

  await deps.saveManagedFile({ source, path: item.path, suggestedName: item.name })
}

export const runPreviewTabAction = (
  command: PreviewTabActionCommand,
  item: PreviewItem,
  deps: PreviewTabActionDeps
): void => {
  if (command === 'close') {
    deps.closeTab(item.id)
    return
  }

  if (command === 'close-others') {
    deps.closeOtherTabs(item.id)
    return
  }

  if (item.type !== 'file') return

  if (command === 'download') {
    void downloadManagedFile(item, deps).catch((error: unknown) => {
      console.error(`Failed to download ${item.name} from the tab menu`, error)
    })
    return
  }

  if (command === 'copy-path') {
    void deps
      .copyText(item.path)
      .catch((error: unknown) => console.error(`Failed to copy the path of ${item.name}`, error))
    return
  }

  if (command === 'save-as-artifact') {
    // The staging pipeline is optional on window.api.uploads; without it the click is a no-op,
    // matching the local-file header menu's behavior.
    if (!deps.stageLocalPath) return

    void deps
      .stageLocalPath({
        transferId: crypto.randomUUID(),
        name: item.name,
        sourcePath: item.path,
        ...(deps.activeProjectId ? { projectId: deps.activeProjectId } : {})
      })
      .catch((error: unknown) => {
        console.error(`Failed to save ${item.name} as an artifact from the tab menu`, error)
      })
  }
}
