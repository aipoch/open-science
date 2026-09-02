// The preview tab context-menu model: one module owns both which actions a tab offers (decision)
// and what each action does (execution). The menu UI stays a thin renderer — it draws the list
// `getPreviewTabActions` returns and forwards picks to `runPreviewTabAction`, knowing nothing about
// store mutations or save pipelines.
//
// Actions that live inside a tab's content surface (Provenance, Reload, View in context, Plan
// download, full screen) are deliberately absent: they are owned by the surfaces themselves. This
// module only exposes actions that can run without mounting the tab's content.

import {
  BookOpen,
  CircleX,
  ClipboardCopy,
  Download,
  Link2Off,
  PackagePlus,
  X,
  type LucideIcon
} from 'lucide-react'

import type { PreviewFileItem, PreviewItem } from '@/stores/preview-workbench-store'
import type {
  ActionMenuBinding,
  ActionMenuDefinition,
  ActionMenuRecipeEntry
} from '@/components/action-menu'
import type { SaveManagedFileRequest } from '../../../../shared/file-save'

import type { PdfContextLinkState } from './use-pdf-context-action'

export type PreviewTabActionCommand =
  'toggle-pdf-context' | 'close' | 'close-others' | 'download' | 'copy-path' | 'save-as-artifact'

export const PREVIEW_TAB_ACTION_CATALOG: Record<PreviewTabActionCommand, ActionMenuDefinition> = {
  'toggle-pdf-context': { labelKey: 'Read with agent', icon: BookOpen },
  close: { labelKey: 'Close', icon: X },
  'close-others': { labelKey: 'Close others', icon: CircleX, danger: true },
  download: { labelKey: 'Download', icon: Download },
  'copy-path': { labelKey: 'Copy path', icon: ClipboardCopy },
  'save-as-artifact': { labelKey: 'Save as artifact', icon: PackagePlus }
}

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
  // Set by the host (which owns the stores) for linkable PDF file tabs; drives the leading
  // Read-with-agent command's label.
  pdfContext?: PdfContextLinkState
}

// Shared actions appear for every tab; specific actions follow them below a separator. Returning
// groups (not a flat list) lets the menu render the divider without knowing which commands are
// shared. The optional pdfContext group leads the menu: reading-context entry points sit above
// window management.
export type PreviewTabActionGroups = {
  pdfContext: PreviewTabAction[]
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
  // Runs the shared link/unlink/replace command for the tab's PDF; absent when the tab is not
  // linkable (the menu then never offers the command).
  togglePdfContext?: (item: PreviewFileItem) => void
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

// Unlink is reversible, so the remove label deliberately stays out of the danger styling.
const pdfContextActions: Record<PdfContextLinkState, PreviewTabAction> = {
  link: {
    command: 'toggle-pdf-context',
    label: 'Read with agent',
    icon: BookOpen,
    danger: false,
    disabled: false
  },
  remove: {
    command: 'toggle-pdf-context',
    label: 'Remove PDF from context',
    icon: Link2Off,
    danger: false,
    disabled: false
  }
}

export const getPreviewTabActionGroups = (
  item: PreviewItem,
  context: PreviewTabActionContext
): PreviewTabActionGroups => ({
  pdfContext:
    item.type === 'file' && context.pdfContext ? [pdfContextActions[context.pdfContext]] : [],
  shared: sharedActions(context.tabCount),
  specific: item.type === 'file' ? fileSpecificActions(item) : []
})

export const getPreviewTabActionRecipe = (
  item: PreviewItem,
  context: PreviewTabActionContext
): readonly ActionMenuRecipeEntry<PreviewTabActionCommand>[] => {
  const groups = getPreviewTabActionGroups(item, context)
  return [groups.pdfContext, groups.shared, groups.specific]
    .filter((group) => group.length > 0)
    .flatMap((group, index) => [
      ...(index > 0 ? [{ kind: 'separator' as const }] : []),
      ...group.map((action) => ({ kind: 'action' as const, action: action.command }))
    ])
}

export const createPreviewTabActionBindings = (
  context: PreviewTabActionContext,
  deps: PreviewTabActionDeps
): Partial<Record<PreviewTabActionCommand, ActionMenuBinding<PreviewItem>>> => ({
  close: { execute: (item) => runPreviewTabAction('close', item, deps) },
  'close-others': {
    execute: (item) => runPreviewTabAction('close-others', item, deps),
    disabled: context.tabCount <= 1
  },
  download: { execute: (item) => runPreviewTabAction('download', item, deps) },
  'copy-path': { execute: (item) => runPreviewTabAction('copy-path', item, deps) },
  'save-as-artifact': {
    execute: (item) => runPreviewTabAction('save-as-artifact', item, deps)
  },
  ...(context.pdfContext && deps.togglePdfContext
    ? {
        'toggle-pdf-context': {
          execute: (item: PreviewItem) => runPreviewTabAction('toggle-pdf-context', item, deps),
          labelKey: context.pdfContext === 'remove' ? 'Remove PDF from context' : 'Read with agent',
          icon: context.pdfContext === 'remove' ? Link2Off : BookOpen
        }
      }
    : {})
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
): void | Promise<void> => {
  if (command === 'close') {
    deps.closeTab(item.id)
    return
  }

  if (command === 'close-others') {
    deps.closeOtherTabs(item.id)
    return
  }

  if (item.type !== 'file') return

  if (command === 'toggle-pdf-context') {
    deps.togglePdfContext?.(item)
    return
  }

  if (command === 'download') {
    return downloadManagedFile(item, deps).catch((error: unknown) => {
      console.error(`Failed to download ${item.name} from the tab menu`, error)
    })
  }

  if (command === 'copy-path') {
    return deps
      .copyText(item.path)
      .catch((error: unknown) => console.error(`Failed to copy the path of ${item.name}`, error))
  }

  if (command === 'save-as-artifact') {
    // The staging pipeline is optional on window.api.uploads; without it the click is a no-op,
    // matching the local-file header menu's behavior.
    if (!deps.stageLocalPath) return

    return deps
      .stageLocalPath({
        transferId: crypto.randomUUID(),
        name: item.name,
        sourcePath: item.path,
        ...(deps.activeProjectId ? { projectId: deps.activeProjectId } : {})
      })
      .then(() => undefined)
      .catch((error: unknown) => {
        console.error(`Failed to save ${item.name} as an artifact from the tab menu`, error)
      })
  }
}
