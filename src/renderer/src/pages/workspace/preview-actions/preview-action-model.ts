import {
  BookOpen,
  ClipboardCopy,
  Download,
  Eye,
  GitBranch,
  Maximize2,
  PackagePlus,
  X
} from 'lucide-react'

import type {
  ActionMenuBinding,
  ActionMenuDefinition,
  ActionMenuRecipeEntry
} from '@/components/action-menu'

export type PreviewCapabilityId =
  | 'pdf-context'
  | 'copy-path'
  | 'save-as-artifact'
  | 'provenance'
  | 'view-in-context'
  | 'download'
  | 'open-fullscreen'
  | 'close'

export type PreviewActionBinding = ActionMenuBinding<undefined>

export type PreviewActionBindings = Partial<Record<PreviewCapabilityId, PreviewActionBinding>>

export type PreviewMenuRecipeEntry = ActionMenuRecipeEntry<PreviewCapabilityId>

export const PREVIEW_CAPABILITY_CATALOG: Record<PreviewCapabilityId, ActionMenuDefinition> = {
  'pdf-context': { labelKey: 'Read with agent', icon: BookOpen },
  'copy-path': { labelKey: 'Copy path', icon: ClipboardCopy },
  'save-as-artifact': { labelKey: 'Save as artifact', icon: PackagePlus },
  provenance: { labelKey: 'Provenance', icon: GitBranch },
  'view-in-context': { labelKey: 'View in context', icon: Eye },
  download: { labelKey: 'Download', icon: Download },
  'open-fullscreen': { labelKey: 'Open full screen preview', icon: Maximize2 },
  close: { labelKey: 'Close', icon: X }
}

export const LOCAL_PREVIEW_MENU_RECIPE: readonly PreviewMenuRecipeEntry[] = [
  { kind: 'action', action: 'copy-path' },
  { kind: 'action', action: 'save-as-artifact' },
  { kind: 'separator' },
  { kind: 'action', action: 'provenance' },
  { kind: 'action', action: 'view-in-context' },
  { kind: 'action', action: 'open-fullscreen' },
  { kind: 'action', action: 'download' },
  { kind: 'action', action: 'close' }
]

export const MANAGED_PREVIEW_MENU_RECIPE: readonly PreviewMenuRecipeEntry[] = [
  { kind: 'action', action: 'provenance' },
  { kind: 'action', action: 'view-in-context' },
  { kind: 'action', action: 'open-fullscreen' },
  { kind: 'action', action: 'download' },
  { kind: 'action', action: 'close' }
]

export const MANAGED_PDF_PREVIEW_MENU_RECIPE: readonly PreviewMenuRecipeEntry[] = [
  { kind: 'action', action: 'pdf-context' },
  { kind: 'separator' },
  ...MANAGED_PREVIEW_MENU_RECIPE
]

const NATIVE_CONTEXT_MENU_SELECTOR =
  'input, textarea, select, button, iframe, [contenteditable]:not([contenteditable="false"]), [data-preview-context-menu-passthrough]'

export const shouldHandlePreviewContextMenu = (target: EventTarget | null): boolean =>
  !(target instanceof Element && target.closest(NATIVE_CONTEXT_MENU_SELECTOR))
