import { STREAMDOWN_FULLSCREEN_SELECTOR } from '@/components/streamdown/dom-selectors'
import type { NavigationView } from '@/stores/navigation-store'

export type AppShellPresentationState = Readonly<{
  closeConfirmation: boolean
  webEventRecovery: boolean
  dataRootRecovery: boolean
  legacyDataMove: boolean
  update: boolean
  computeApproval: boolean
  connectorApproval: boolean
  credentialRequest?: boolean
  skillImportApproval: boolean
  globalSearch: boolean
  settings: boolean
  preview: boolean
}>

export type AppShellPresentationInput = Readonly<{
  startupView: 'app' | 'onboarding' | undefined
  isSessionPersistenceHydrated: boolean
  isSessionPersistenceLoading: boolean
  view: NavigationView
  presentations: AppShellPresentationState
}>

export type AppShellPresentation = keyof AppShellPresentationState | 'startup' | 'base'
export type AppShellShortcut = 'settings' | 'globalSearch' | 'archiveUndo'

export type AppShellCloseAction =
  | Readonly<{ kind: 'consume' }>
  | Readonly<{ kind: 'close-update' }>
  | Readonly<{ kind: 'close-global-search' }>
  | Readonly<{ kind: 'close-settings' }>
  | Readonly<{ kind: 'close-preview' }>
  | Readonly<{ kind: 'close-base' }>
  | Readonly<{ kind: 'dismiss-dom-presentation'; target: HTMLElement }>

export type AppShellPresentationProjection = Readonly<{
  active: AppShellPresentation
  isSessionContentVisible: boolean
  allowsShortcut: (shortcut: AppShellShortcut, root?: ParentNode) => boolean
  resolveCloseAction: (root?: ParentNode) => AppShellCloseAction
}>

const PRESENTATION_PRIORITY: ReadonlyArray<keyof AppShellPresentationState> = [
  'closeConfirmation',
  'webEventRecovery',
  'dataRootRecovery',
  'legacyDataMove',
  'update',
  'computeApproval',
  'connectorApproval',
  'credentialRequest',
  'skillImportApproval',
  'globalSearch',
  'settings',
  'preview'
]

const BLOCKING_DOM_PRESENTATION_SELECTOR = `[role="dialog"], [role="alertdialog"], [data-slot="context-window-dialog"], ${STREAMDOWN_FULLSCREEN_SELECTOR}`
const FILE_PREVIEW_DIALOG_SELECTOR = '[data-slot="file-preview-dialog"]'

const isEffectivelyOpen = (element: HTMLElement): boolean =>
  element.dataset.state !== 'closed' && element.closest('[aria-hidden="true"], [hidden]') === null

const findTopmostDomPresentation = (
  root: ParentNode,
  ignoredSelector?: string
): HTMLElement | undefined =>
  Array.from(root.querySelectorAll<HTMLElement>(BLOCKING_DOM_PRESENTATION_SELECTOR))
    .filter(
      (element) =>
        isEffectivelyOpen(element) && (!ignoredSelector || !element.matches(ignoredSelector))
    )
    .at(-1)

const resolveActivePresentation = (input: AppShellPresentationInput): AppShellPresentation => {
  if (input.startupView !== 'app' || !input.isSessionPersistenceHydrated) return 'startup'

  return PRESENTATION_PRIORITY.find((presentation) => input.presentations[presentation]) ?? 'base'
}

const closeActionFor = (active: AppShellPresentation, root: ParentNode): AppShellCloseAction => {
  if (active === 'base') {
    const nestedPresentation = findTopmostDomPresentation(root)
    return nestedPresentation
      ? { kind: 'dismiss-dom-presentation', target: nestedPresentation }
      : { kind: 'close-base' }
  }

  // Workspace dialogs and fullscreen viewers can be nested inside a preview modal. They own the
  // first close command; the preview state remains intact until the next command.
  if (active === 'preview') {
    const nestedPresentation = findTopmostDomPresentation(root, FILE_PREVIEW_DIALOG_SELECTOR)
    return nestedPresentation
      ? { kind: 'dismiss-dom-presentation', target: nestedPresentation }
      : { kind: 'close-preview' }
  }

  if (active === 'update') return { kind: 'close-update' }
  if (active === 'globalSearch') return { kind: 'close-global-search' }
  if (active === 'settings') return { kind: 'close-settings' }

  // Startup, recovery, close confirmation, and approval presentations require an explicit decision.
  return { kind: 'consume' }
}

// Projects independently-owned store/local state into the one presentation that may interact with
// the user. The projection also owns every App Shell shortcut decision so callers cannot rebuild the
// priority as parallel Boolean gate lists.
export const resolveAppShellPresentation = (
  input: AppShellPresentationInput
): AppShellPresentationProjection => {
  const active = resolveActivePresentation(input)

  return {
    active,
    isSessionContentVisible:
      active === 'base' && input.view === 'workspace' && !input.isSessionPersistenceLoading,
    allowsShortcut: (shortcut, root = document) => {
      if (shortcut === 'globalSearch' && active === 'globalSearch') return true
      if (active !== 'base') return false
      return findTopmostDomPresentation(root) === undefined
    },
    resolveCloseAction: (root = document) => closeActionFor(active, root)
  }
}
