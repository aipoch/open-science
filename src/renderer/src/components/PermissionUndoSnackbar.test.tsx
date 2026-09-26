// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { i18next } from '@/i18n'
import { usePermissionGrantsStore } from '@/stores/permission-grants-store'
import { useArchiveUndoStore } from '@/stores/archive-undo-store'
import { useSettingsUndoPortal } from './use-settings-undo-portal'
import { PermissionUndoSnackbar as PermissionUndoSnackbarComponent } from './PermissionUndoSnackbar'

const PermissionUndoSnackbar = (): React.JSX.Element => (
  <PermissionUndoSnackbarComponent allowsArchiveShortcut={() => true} />
)

function SettingsUndoFixture({ open }: { open: boolean }): React.JSX.Element {
  const { background, settingsHostRef } = useSettingsUndoPortal(
    <PermissionUndoSnackbarComponent allowsArchiveShortcut={() => true} />
  )
  return (
    <>
      {background}
      {open && <div ref={settingsHostRef} />}
    </>
  )
}

const expectSnackbarExiting = (container: HTMLElement, selector: string): void => {
  const snackbar = container.querySelector(selector)
  const presence = snackbar?.closest<HTMLElement>('[data-testid="undo-snackbar-presence"]')
  expect(presence?.getAttribute('aria-hidden')).toBe('true')
  expect(presence?.hasAttribute('inert')).toBe(true)
  expect(presence?.style.pointerEvents).toBe('none')
}

const archivedProjectNotice = (
  id = 'project-1',
  archivedAt = 10,
  name = 'Project'
): ReturnType<typeof useArchiveUndoStore.getState>['notices'][number] => ({
  key: `project:${id}:${archivedAt}`,
  kind: 'project',
  projectId: id,
  archivedAt,
  revision: 0,
  expiresAt: Date.now() + 8_000,
  messageKey: 'Archived project “{{name}}”.',
  messageParams: { name }
})

describe('PermissionUndoSnackbar', () => {
  let container: HTMLDivElement
  let root: Root
  const restore = vi.fn()
  const extendUndo = vi.fn()
  const updateProjectArchive = vi.fn()

  it('keeps focused Undo paused across Settings and resumes the remaining countdown on blur', async () => {
    await act(async () => root.render(<SettingsUndoFixture open />))
    await act(async () => vi.advanceTimersByTime(3_000))
    const undoButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="permission-undo-snackbar"] button'
    )
    await act(async () => undoButton?.focus())
    await act(async () => root.render(<SettingsUndoFixture open={false} />))
    expect(document.activeElement).toBe(undoButton)
    await act(async () => vi.advanceTimersByTime(3_000))
    expect(usePermissionGrantsStore.getState().undo).toBeDefined()
    await act(async () => undoButton?.blur())
    await act(async () => vi.advanceTimersByTime(5_000))
    expect(usePermissionGrantsStore.getState().undo).toBeUndefined()
  })

  beforeEach(async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    await i18next.changeLanguage('en')
    vi.useFakeTimers()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    restore.mockReset().mockResolvedValue({
      grants: [],
      counts: { all: 0, global: 0, project: 0, session: 0 },
      conflicts: []
    })
    extendUndo.mockReset().mockImplementation(({ undoToken }: { undoToken: string }) =>
      Promise.resolve({
        undoToken,
        expiresAt: Date.now() + 8_000,
        revokedCount: 1
      })
    )
    updateProjectArchive.mockReset().mockResolvedValue({
      id: 'project-1',
      name: 'Project',
      description: '',
      isExample: false,
      createdAt: 1,
      updatedAt: 1
    })
    window.api = {
      platform: 'darwin',
      permissions: { extendUndo, restore },
      projects: { updateArchive: updateProjectArchive }
    } as unknown as Window['api']
    usePermissionGrantsStore.setState({
      grants: [],
      counts: { all: 0, global: 0, project: 0, session: 0 },
      status: 'ready',
      error: undefined,
      undo: {
        token: 'undo-1',
        expiresAt: Date.now() + 8_000,
        messageKey: 'Revoked {{family}} · {{capability}}',
        messageParams: { family: 'Local compute', capability: 'Shell' },
        translatedMessageParams: ['family', 'capability']
      },
      undoQueue: [],
      isRestoring: false
    })
    useArchiveUndoStore.setState({ notices: [], restoringKey: undefined })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    document.body.style.removeProperty('pointer-events')
    vi.useRealTimers()
  })

  it('restores from the app-root action and prevents a duplicate activation', async () => {
    await act(async () => root.render(<PermissionUndoSnackbar />))
    const undo = container.querySelector<HTMLButtonElement>('button:not([aria-label])')

    await act(async () => undo?.click())

    expect(restore).toHaveBeenCalledOnce()
    expect(restore).toHaveBeenCalledWith({ undoToken: 'undo-1' })
    expectSnackbarExiting(container, '[data-undo-token="undo-1"]')
  })

  it('supports explicit dismiss and expiry after Settings has closed', async () => {
    await act(async () => root.render(<PermissionUndoSnackbar />))
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Dismiss permission Undo"]')?.click()
    )
    expectSnackbarExiting(container, '[data-undo-token="undo-1"]')

    await act(async () =>
      usePermissionGrantsStore.setState({
        undo: {
          token: 'undo-2',
          expiresAt: Date.now() + 8_000,
          messageKey: 'Revoked Python'
        }
      })
    )
    expect(container.textContent).toContain('Revoked Python')

    await act(async () => vi.advanceTimersByTime(8_000))
    expectSnackbarExiting(container, '[data-undo-token="undo-2"]')
  })

  it('retranslates a permission notice when the language changes', async () => {
    await act(async () => root.render(<PermissionUndoSnackbar />))
    expect(container.textContent).toContain('Revoked Local compute · Shell')

    await act(async () => {
      await i18next.changeLanguage('zh-Hans')
    })

    expect(container.textContent).toContain('已撤销 本地算力 · 命令行')
    expect(container.textContent).not.toContain('Revoked Local compute')
  })

  it('leaves Undo positioning to the application stack after Settings has closed', async () => {
    await act(async () => root.render(<PermissionUndoSnackbar />))

    const stack = container.querySelector<HTMLElement>('[data-testid="permission-undo-stack"]')

    expect(stack?.className).toContain('w-full')
    expect(stack?.className).not.toContain('overflow-y-auto')
    expect(stack?.querySelector('[data-slot="scroll-area-viewport"]')).toBeNull()
  })

  it('shares the top stack with Archive Undo actions', async () => {
    useArchiveUndoStore.setState({
      notices: [archivedProjectNotice()],
      restoringKey: undefined
    })
    await act(async () => root.render(<PermissionUndoSnackbar />))

    const snackbar = container.querySelector<HTMLElement>('[data-testid="archive-undo-snackbar"]')
    expect(snackbar?.className).toContain('rounded-3xl')
    expect(snackbar?.className).toContain('shadow-menu')
    expect(snackbar?.className).toContain('border-border')
    expect(snackbar?.className).not.toContain('shadow-lg')
    // The notice carries a key plus params, so the interpolated text proves it is translated at
    // render time rather than frozen into the store when the project was archived.
    expect(snackbar?.textContent).toContain('Archived project “Project”.')
    const undo = snackbar?.querySelector<HTMLButtonElement>('button:not([aria-label])')
    await act(async () => undo?.click())

    expect(updateProjectArchive).toHaveBeenCalledWith({
      id: 'project-1',
      archived: false,
      expectedArchiveRevision: 0
    })
    expectSnackbarExiting(container, '[data-testid="archive-undo-snackbar"]')
  })

  it('shows the platform shortcut only on the latest Archive Undo action', async () => {
    useArchiveUndoStore.setState({
      notices: [
        archivedProjectNotice('project-2', 20, 'Latest'),
        archivedProjectNotice('project-1', 10, 'Earlier')
      ],
      restoringKey: undefined
    })
    await act(async () => root.render(<PermissionUndoSnackbar />))

    const actions = container.querySelectorAll<HTMLButtonElement>(
      '[data-testid="archive-undo-snackbar"] button:not([aria-label])'
    )
    expect(actions[0]?.getAttribute('aria-keyshortcuts')).toBe('Meta+Z')
    expect(actions[0]?.textContent).toContain('⌘Z')
    expect(actions[1]?.hasAttribute('aria-keyshortcuts')).toBe(false)
    expect(actions[1]?.textContent).not.toContain('⌘Z')
  })

  it.each(['success', 'failure'] as const)(
    'disables sibling archive actions until the pending restore settles with %s',
    async (outcome) => {
      useArchiveUndoStore.setState({
        notices: [
          archivedProjectNotice('project-2', 20, 'Latest'),
          archivedProjectNotice('project-1', 10, 'Earlier')
        ]
      })
      let settle: () => void = () => {}
      updateProjectArchive.mockImplementationOnce(
        () =>
          new Promise((resolve, reject) => {
            settle = () =>
              outcome === 'success'
                ? resolve({ id: 'project-1', name: 'Earlier', createdAt: 1, updatedAt: 1 })
                : reject(new Error('Restore failed'))
          })
      )
      await act(async () => root.render(<PermissionUndoSnackbar />))
      const actions = container.querySelectorAll<HTMLButtonElement>(
        '[data-testid="archive-undo-snackbar"] button:not([aria-label])'
      )
      await act(async () => actions[1].click())
      expect(actions[0].disabled).toBe(true)
      expect(actions[0].textContent).toBe('Undo')
      expect(actions[0].hasAttribute('aria-keyshortcuts')).toBe(false)
      expect(actions[0].querySelector('svg')).toBeNull()
      expect(actions[1].disabled).toBe(true)
      expect(actions[1].textContent).toBe('Restoring…')
      expect(actions[1].querySelector('svg')).not.toBeNull()
      await act(async () => actions[0].click())
      expect(updateProjectArchive).toHaveBeenCalledOnce()
      await act(async () => settle())
      expect(actions[0].disabled).toBe(false)
      expect(actions[0].getAttribute('aria-keyshortcuts')).toBe('Meta+Z')
      await act(async () => actions[0].click())
      expect(updateProjectArchive).toHaveBeenCalledTimes(2)
      expect(updateProjectArchive).toHaveBeenLastCalledWith({
        id: 'project-2',
        archived: false,
        expectedArchiveRevision: 0
      })
    }
  )

  it('undoes the latest archive with Cmd+Z without restoring a permission receipt', async () => {
    useArchiveUndoStore.setState({
      notices: [
        archivedProjectNotice('project-2', 20, 'Latest'),
        archivedProjectNotice('project-1', 10, 'Earlier')
      ],
      restoringKey: undefined
    })
    await act(async () => root.render(<PermissionUndoSnackbar />))
    const shortcut = new KeyboardEvent('keydown', {
      key: 'z',
      metaKey: true,
      bubbles: true,
      cancelable: true
    })

    await act(async () => window.dispatchEvent(shortcut))

    expect(shortcut.defaultPrevented).toBe(true)
    expect(updateProjectArchive).toHaveBeenCalledWith({
      id: 'project-2',
      archived: false,
      expectedArchiveRevision: 0
    })
    expect(restore).not.toHaveBeenCalled()
  })

  it('leaves Cmd+Z untouched when the App Shell presentation owner blocks archive Undo', async () => {
    useArchiveUndoStore.setState({
      notices: [archivedProjectNotice()],
      restoringKey: undefined
    })
    await act(async () =>
      root.render(<PermissionUndoSnackbarComponent allowsArchiveShortcut={() => false} />)
    )
    const shortcut = new KeyboardEvent('keydown', {
      key: 'z',
      metaKey: true,
      bubbles: true,
      cancelable: true
    })

    await act(async () => window.dispatchEvent(shortcut))

    expect(shortcut.defaultPrevented).toBe(false)
    expect(updateProjectArchive).not.toHaveBeenCalled()
  })

  it('keeps the archive shortcut active while its remaining time is paused', async () => {
    const expiring = archivedProjectNotice('project-2', 20, 'Expiring')
    expiring.expiresAt = Date.now() + 1_000
    const remaining = archivedProjectNotice('project-1', 10, 'Remaining')
    useArchiveUndoStore.setState({ notices: [expiring, remaining], restoringKey: undefined })
    await act(async () => root.render(<PermissionUndoSnackbar />))
    const firstSnackbar = container.querySelector<HTMLElement>(
      '[data-testid="archive-undo-snackbar"]'
    )
    await act(async () =>
      firstSnackbar?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    )

    await act(async () => vi.advanceTimersByTimeAsync(1_000))

    const actions = container.querySelectorAll<HTMLButtonElement>(
      '[data-testid="archive-undo-snackbar"] button:not([aria-label])'
    )
    expect(actions[0]?.getAttribute('aria-keyshortcuts')).toBe('Meta+Z')
    expect(actions[1]?.hasAttribute('aria-keyshortcuts')).toBe(false)
    const shortcut = new KeyboardEvent('keydown', {
      key: 'z',
      metaKey: true,
      bubbles: true,
      cancelable: true
    })
    await act(async () => window.dispatchEvent(shortcut))
    expect(shortcut.defaultPrevented).toBe(true)
    expect(updateProjectArchive).toHaveBeenCalledOnce()
  })

  it('uses Ctrl+Z outside macOS', async () => {
    window.api.platform = 'win32'
    useArchiveUndoStore.setState({
      notices: [archivedProjectNotice()],
      restoringKey: undefined
    })
    await act(async () => root.render(<PermissionUndoSnackbar />))
    const action = container.querySelector<HTMLButtonElement>(
      '[data-testid="archive-undo-snackbar"] button:not([aria-label])'
    )
    const shortcut = new KeyboardEvent('keydown', {
      key: 'z',
      ctrlKey: true,
      bubbles: true,
      cancelable: true
    })

    expect(action?.getAttribute('aria-keyshortcuts')).toBe('Control+Z')
    expect(action?.textContent).toContain('Ctrl+Z')

    await act(async () => window.dispatchEvent(shortcut))

    expect(shortcut.defaultPrevented).toBe(true)
    expect(updateProjectArchive).toHaveBeenCalledOnce()
  })

  it.each([
    ['input', () => document.createElement('input')],
    ['textarea', () => document.createElement('textarea')],
    [
      'contenteditable',
      () => {
        const editor = document.createElement('div')
        editor.setAttribute('contenteditable', 'true')
        return editor
      }
    ],
    [
      'ARIA textbox',
      () => {
        const editor = document.createElement('div')
        editor.setAttribute('role', 'textbox')
        return editor
      }
    ]
  ])('preserves native Cmd+Z in an %s', async (_, createEditor) => {
    useArchiveUndoStore.setState({
      notices: [archivedProjectNotice()],
      restoringKey: undefined
    })
    await act(async () => root.render(<PermissionUndoSnackbar />))
    const editor = createEditor()
    document.body.appendChild(editor)
    const shortcut = new KeyboardEvent('keydown', {
      key: 'z',
      metaKey: true,
      bubbles: true,
      cancelable: true
    })

    await act(async () => editor.dispatchEvent(shortcut))

    expect(shortcut.defaultPrevented).toBe(false)
    expect(updateProjectArchive).not.toHaveBeenCalled()
    editor.remove()
  })

  it('renews the authoritative receipt while automatic dismissal is paused by hover', async () => {
    await act(async () => root.render(<PermissionUndoSnackbar />))
    const snackbar = container.querySelector<HTMLElement>(
      '[data-testid="permission-undo-snackbar"]'
    )

    await act(async () => snackbar?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    await act(async () => vi.advanceTimersByTimeAsync(8_000))
    expect(extendUndo).toHaveBeenCalledWith({ undoToken: 'undo-1' })
    expect(container.querySelector('[data-testid="permission-undo-snackbar"]')).not.toBeNull()

    await act(async () => snackbar?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })))
    await act(async () => vi.advanceTimersByTimeAsync(7_999))
    expect(container.querySelector('[data-testid="permission-undo-snackbar"]')).not.toBeNull()
    await act(async () => vi.advanceTimersByTimeAsync(1))
    expectSnackbarExiting(container, '[data-undo-token="undo-1"]')
  })

  it('dismisses the action when its authoritative receipt cannot be renewed', async () => {
    extendUndo.mockResolvedValueOnce(undefined)
    await act(async () => root.render(<PermissionUndoSnackbar />))
    const snackbar = container.querySelector<HTMLElement>(
      '[data-testid="permission-undo-snackbar"]'
    )

    await act(async () => snackbar?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))

    expectSnackbarExiting(container, '[data-undo-token="undo-1"]')
  })

  it('locally pauses a non-restorable explanation without trying to renew a receipt', async () => {
    usePermissionGrantsStore.setState({
      undo: {
        token: 'undo-1',
        expiresAt: Date.now() + 5_000,
        messageKey: "Couldn't restore permission: owner no longer exists",
        canRestore: false
      }
    })
    await act(async () => root.render(<PermissionUndoSnackbar />))
    const snackbar = container.querySelector<HTMLElement>(
      '[data-testid="permission-undo-snackbar"]'
    )

    await act(async () => snackbar?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    await act(async () => vi.advanceTimersByTime(8_000))
    expect(extendUndo).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="permission-undo-snackbar"]')).not.toBeNull()

    await act(async () => snackbar?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })))
    await act(async () => vi.advanceTimersByTime(4_999))
    expect(container.querySelector('[data-undo-token="undo-1"]')).not.toBeNull()
    await act(async () => vi.advanceTimersByTime(1))
    expectSnackbarExiting(container, '[data-undo-token="undo-1"]')
  })

  it('renders every unexpired receipt as an independently operable Undo action', async () => {
    usePermissionGrantsStore.setState({
      undoQueue: [
        {
          token: 'undo-2',
          expiresAt: Date.now() + 8_000,
          messageKey: 'Revoked Python'
        },
        {
          token: 'undo-3',
          expiresAt: Date.now() + 8_000,
          messageKey: 'Revoked Shell'
        },
        {
          token: 'undo-4',
          expiresAt: Date.now() + 8_000,
          messageKey: 'Revoked Connector'
        }
      ]
    })
    await act(async () => root.render(<PermissionUndoSnackbar />))

    const snackbars = container.querySelectorAll('[data-testid="permission-undo-snackbar"]')
    expect(snackbars).toHaveLength(4)
    expect(container.textContent).toContain('Revoked Local compute · Shell')
    expect(container.textContent).toContain('Revoked Python')
    expect(container.textContent).toContain('Revoked Shell')
    expect(container.textContent).toContain('Revoked Connector')
    expect(container.textContent).not.toContain('queued')

    const fourthUndo = container.querySelector<HTMLButtonElement>(
      '[data-undo-token="undo-4"] button:not([aria-label])'
    )
    await act(async () => fourthUndo?.click())

    expect(restore).toHaveBeenCalledWith({ undoToken: 'undo-4' })
    expectSnackbarExiting(container, '[data-undo-token="undo-4"]')
    expect(container.querySelector('[data-undo-token="undo-1"]')).not.toBeNull()
  })

  it('remains interactive while a modal has locked pointer events on the document body', async () => {
    document.body.style.pointerEvents = 'none'
    await act(async () => root.render(<PermissionUndoSnackbar />))

    const snackbar = container.querySelector<HTMLElement>(
      '[data-testid="permission-undo-snackbar"]'
    )
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))

    expect(snackbar?.className).toContain('pointer-events-auto')
    expect(buttons).toHaveLength(2)
    buttons.forEach((button) => {
      expect(button.className).toContain('hover:bg-muted')
      expect(button.className).toContain('focus-visible:keyboard-focus')
    })
  })
  it('retains an archive notice during restore and preserves remaining time after hover', async () => {
    usePermissionGrantsStore.setState({ undo: undefined, undoQueue: [] })
    useArchiveUndoStore.setState({ notices: [archivedProjectNotice()] })
    await act(async () => root.render(<PermissionUndoSnackbar />))
    const snackbar = container.querySelector<HTMLElement>('[data-testid="archive-undo-snackbar"]')!
    await act(async () => vi.advanceTimersByTime(3000))
    act(() => snackbar.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    await act(async () => vi.advanceTimersByTime(10000))
    act(() =>
      snackbar.dispatchEvent(
        new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })
      )
    )
    await act(async () => vi.advanceTimersByTime(4000))
    expect(useArchiveUndoStore.getState().notices).toHaveLength(1)
    let finish: (() => void) | undefined
    updateProjectArchive.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ id: 'project-1', name: 'Project', createdAt: 1, updatedAt: 1 })
        })
    )
    await act(async () =>
      snackbar.querySelector<HTMLButtonElement>('button:not([aria-label])')?.click()
    )
    await act(async () => vi.advanceTimersByTime(10000))
    expect(useArchiveUndoStore.getState().notices).toHaveLength(1)
    expect(snackbar.textContent).toContain('Restoring')
    await act(async () => finish?.())
    expect(useArchiveUndoStore.getState().notices).toHaveLength(0)
  })
  it('does not reset remaining permission notice time when its receipt is renewed', async () => {
    await act(async () => root.render(<PermissionUndoSnackbar />))
    const snackbar = container.querySelector<HTMLElement>(
      '[data-testid="permission-undo-snackbar"]'
    )!
    // A paused-only renewal would expire at 17s, before the resumed countdown ends at 18s.
    await act(async () => vi.advanceTimersByTimeAsync(1000))
    act(() => snackbar.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    await act(async () => vi.advanceTimersByTimeAsync(10000))
    act(() =>
      snackbar.dispatchEvent(
        new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })
      )
    )
    await act(async () => vi.advanceTimersByTimeAsync(6999))
    expect(usePermissionGrantsStore.getState().undo?.expiresAt).toBeGreaterThan(Date.now())
    expect(container.querySelector('[data-undo-token="undo-1"]')?.closest('[inert]')).toBeNull()
    await act(async () => vi.advanceTimersByTimeAsync(1))
    expectSnackbarExiting(container, '[data-undo-token="undo-1"]')
  })
})
