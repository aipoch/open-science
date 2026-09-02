import {
  BookOpen,
  ClipboardCopy,
  Download,
  Eye,
  GitBranch,
  Maximize2,
  PackagePlus,
  X,
  type LucideIcon
} from 'lucide-react'

export type PreviewCapabilityId =
  | 'pdf-context'
  | 'copy-path'
  | 'save-as-artifact'
  | 'provenance'
  | 'view-in-context'
  | 'download'
  | 'open-fullscreen'
  | 'close'

export type PreviewActionBinding = {
  execute: () => void | Promise<void>
  disabled?: boolean
  hidden?: boolean
  labelKey?: string
  icon?: LucideIcon
}

export type PreviewActionBindings = Partial<Record<PreviewCapabilityId, PreviewActionBinding>>

export type PreviewMenuRecipeEntry =
  { kind: 'action'; capability: PreviewCapabilityId } | { kind: 'separator' }

export type ResolvedPreviewMenuAction = {
  kind: 'action'
  capability: PreviewCapabilityId
  labelKey: string
  icon: LucideIcon
  danger: boolean
  disabled: boolean
}

export type ResolvedPreviewMenuEntry = ResolvedPreviewMenuAction | { kind: 'separator' }

type PreviewCapabilityDefinition = {
  labelKey: string
  icon: LucideIcon
}

const PREVIEW_CAPABILITY_CATALOG: Record<PreviewCapabilityId, PreviewCapabilityDefinition> = {
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
  { kind: 'action', capability: 'copy-path' },
  { kind: 'action', capability: 'save-as-artifact' },
  { kind: 'separator' },
  { kind: 'action', capability: 'provenance' },
  { kind: 'action', capability: 'view-in-context' },
  { kind: 'action', capability: 'open-fullscreen' },
  { kind: 'action', capability: 'download' },
  { kind: 'action', capability: 'close' }
]

export const MANAGED_PREVIEW_MENU_RECIPE: readonly PreviewMenuRecipeEntry[] = [
  { kind: 'action', capability: 'provenance' },
  { kind: 'action', capability: 'view-in-context' },
  { kind: 'action', capability: 'open-fullscreen' },
  { kind: 'action', capability: 'download' },
  { kind: 'action', capability: 'close' }
]

export const MANAGED_PDF_PREVIEW_MENU_RECIPE: readonly PreviewMenuRecipeEntry[] = [
  { kind: 'action', capability: 'pdf-context' },
  { kind: 'separator' },
  ...MANAGED_PREVIEW_MENU_RECIPE
]

const NATIVE_CONTEXT_MENU_SELECTOR =
  'input, textarea, select, button, iframe, [contenteditable]:not([contenteditable="false"]), [data-preview-context-menu-passthrough]'

export const shouldHandlePreviewContextMenu = (target: EventTarget | null): boolean =>
  !(target instanceof Element && target.closest(NATIVE_CONTEXT_MENU_SELECTOR))

export const resolvePreviewMenuEntries = (
  recipe: readonly PreviewMenuRecipeEntry[],
  bindings: PreviewActionBindings
): ResolvedPreviewMenuEntry[] => {
  const resolved = recipe.flatMap((entry): ResolvedPreviewMenuEntry[] => {
    if (entry.kind === 'separator') return [entry]

    const binding = bindings[entry.capability]
    const definition = PREVIEW_CAPABILITY_CATALOG[entry.capability]
    if (!binding || binding.hidden) return []

    return [
      {
        kind: 'action',
        capability: entry.capability,
        labelKey: binding.labelKey ?? definition.labelKey,
        icon: binding.icon ?? definition.icon,
        danger: false,
        disabled: binding.disabled ?? false
      }
    ]
  })

  // Visibility can remove whole groups, so normalize separators after resolving every action.
  const normalized: ResolvedPreviewMenuEntry[] = []
  for (const entry of resolved) {
    if (entry.kind === 'action') {
      normalized.push(entry)
      continue
    }
    if (normalized.length > 0 && normalized.at(-1)?.kind !== 'separator') {
      normalized.push(entry)
    }
  }
  if (normalized.at(-1)?.kind === 'separator') normalized.pop()
  return normalized
}
