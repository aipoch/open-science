// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'

import {
  resolveAppShellPresentation,
  type AppShellPresentationInput,
  type AppShellPresentationState
} from './app-shell-presentation-owner'

const noPresentations = (): AppShellPresentationState => ({
  closeConfirmation: false,
  webEventRecovery: false,
  dataRootRecovery: false,
  legacyDataMove: false,
  update: false,
  computeApproval: false,
  connectorApproval: false,
  skillImportApproval: false,
  globalSearch: false,
  settings: false,
  preview: false
})

const input = (
  presentations: Partial<AppShellPresentationState> = {},
  overrides: Partial<Omit<AppShellPresentationInput, 'presentations'>> = {}
): AppShellPresentationInput => ({
  startupView: 'app',
  isSessionPersistenceHydrated: true,
  isSessionPersistenceLoading: false,
  view: 'workspace',
  ...overrides,
  presentations: { ...noPresentations(), ...presentations }
})

describe('App Shell presentation owner', () => {
  it('selects one presentation from the fixed semantic priority', () => {
    const priority: Array<keyof AppShellPresentationState> = [
      'closeConfirmation',
      'webEventRecovery',
      'dataRootRecovery',
      'legacyDataMove',
      'update',
      'computeApproval',
      'connectorApproval',
      'skillImportApproval',
      'globalSearch',
      'settings',
      'preview'
    ]

    for (let index = 0; index < priority.length; index += 1) {
      const available = Object.fromEntries(
        priority.slice(index).map((presentation) => [presentation, true])
      ) as Partial<AppShellPresentationState>

      expect(resolveAppShellPresentation(input(available)).active).toBe(priority[index])
    }
    expect(resolveAppShellPresentation(input()).active).toBe('base')
  })

  it('keeps startup non-interactive and only reports uncovered workspace content as visible', () => {
    expect(resolveAppShellPresentation(input({}, { startupView: undefined })).active).toBe(
      'startup'
    )
    expect(
      resolveAppShellPresentation(input({}, { isSessionPersistenceHydrated: false }))
        .isSessionContentVisible
    ).toBe(false)
    expect(
      resolveAppShellPresentation(input({}, { isSessionPersistenceLoading: true }))
        .isSessionContentVisible
    ).toBe(false)
    expect(resolveAppShellPresentation(input({}, { view: 'home' })).isSessionContentVisible).toBe(
      false
    )
    expect(resolveAppShellPresentation(input({ settings: true })).isSessionContentVisible).toBe(
      false
    )
    expect(resolveAppShellPresentation(input()).isSessionContentVisible).toBe(true)
  })

  it('lets only base content open tools and lets global search toggle itself closed', () => {
    const base = resolveAppShellPresentation(input())
    expect(base.allowsShortcut('settings')).toBe(true)
    expect(base.allowsShortcut('globalSearch')).toBe(true)
    expect(base.allowsShortcut('archiveUndo')).toBe(true)

    const nestedDialog = document.createElement('div')
    nestedDialog.setAttribute('role', 'dialog')
    document.body.appendChild(nestedDialog)
    expect(base.allowsShortcut('settings')).toBe(false)
    expect(base.allowsShortcut('globalSearch')).toBe(false)
    expect(base.allowsShortcut('archiveUndo')).toBe(false)
    nestedDialog.remove()

    const search = resolveAppShellPresentation(input({ globalSearch: true }))
    expect(search.allowsShortcut('globalSearch')).toBe(true)
    expect(search.allowsShortcut('settings')).toBe(false)
    expect(search.allowsShortcut('archiveUndo')).toBe(false)
    expect(
      resolveAppShellPresentation(input({ settings: true })).allowsShortcut('globalSearch')
    ).toBe(false)
  })

  it('ignores closed and hidden DOM presentations when checking shortcut eligibility', () => {
    const base = resolveAppShellPresentation(input())
    const closed = document.createElement('div')
    closed.setAttribute('role', 'dialog')
    closed.dataset.state = 'closed'
    const hidden = document.createElement('div')
    hidden.hidden = true
    const hiddenDialog = document.createElement('div')
    hiddenDialog.setAttribute('role', 'alertdialog')
    hidden.appendChild(hiddenDialog)
    document.body.append(closed, hidden)

    expect(base.allowsShortcut('settings')).toBe(true)
    expect(base.allowsShortcut('globalSearch')).toBe(true)
    closed.remove()
    hidden.remove()
  })

  it.each([
    ['startup', {}, { startupView: undefined }, 'consume'],
    ['closeConfirmation', { closeConfirmation: true }, {}, 'consume'],
    ['dataRootRecovery', { dataRootRecovery: true }, {}, 'consume'],
    ['legacyDataMove', { legacyDataMove: true }, {}, 'consume'],
    ['update', { update: true }, {}, 'close-update'],
    ['computeApproval', { computeApproval: true }, {}, 'consume'],
    ['connectorApproval', { connectorApproval: true }, {}, 'consume'],
    ['skillImportApproval', { skillImportApproval: true }, {}, 'consume'],
    ['webEventRecovery', { webEventRecovery: true }, {}, 'consume'],
    ['globalSearch', { globalSearch: true }, {}, 'close-global-search'],
    ['settings', { settings: true }, {}, 'close-settings'],
    ['preview', { preview: true }, {}, 'close-preview'],
    ['base', {}, {}, 'close-base']
  ] as const)('maps %s to the owned close action', (_name, presentations, overrides, action) => {
    expect(
      resolveAppShellPresentation(input(presentations, overrides)).resolveCloseAction().kind
    ).toBe(action)
  })

  it.each([
    ['semantic dialog', 'role', 'dialog'],
    ['Context window dialog', 'data-slot', 'context-window-dialog']
  ])('closes an open nested %s before base panes or the window', (_name, attribute, value) => {
    const dialog = document.createElement('div')
    dialog.setAttribute(attribute, value)
    document.body.appendChild(dialog)

    const action = resolveAppShellPresentation(input()).resolveCloseAction()
    expect(action.kind).toBe('dismiss-dom-presentation')
    expect(action.kind === 'dismiss-dom-presentation' ? action.target : undefined).toBe(dialog)
    dialog.remove()
  })

  it.each([
    ['workspace dialog', 'role', 'dialog'],
    ['workspace alert dialog', 'role', 'alertdialog'],
    ['Streamdown fullscreen', 'data-streamdown', 'table-fullscreen'],
    ['Context window', 'data-slot', 'context-window-dialog']
  ])('closes a nested %s before its preview', (_name, attribute, value) => {
    const nestedPresentation = document.createElement('div')
    nestedPresentation.setAttribute(attribute, value)
    document.body.appendChild(nestedPresentation)

    const action = resolveAppShellPresentation(input({ preview: true })).resolveCloseAction()
    expect(action.kind).toBe('dismiss-dom-presentation')
    expect(action.kind === 'dismiss-dom-presentation' ? action.target : undefined).toBe(
      nestedPresentation
    )
    nestedPresentation.remove()
  })

  it('closes the preview directly when its owned file dialog is the only DOM presentation', () => {
    const previewDialog = document.createElement('div')
    previewDialog.setAttribute('role', 'dialog')
    previewDialog.dataset.slot = 'file-preview-dialog'
    document.body.appendChild(previewDialog)

    expect(resolveAppShellPresentation(input({ preview: true })).resolveCloseAction().kind).toBe(
      'close-preview'
    )
    previewDialog.remove()
  })
})
