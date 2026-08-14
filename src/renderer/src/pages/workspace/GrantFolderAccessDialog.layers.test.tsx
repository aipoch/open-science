// @vitest-environment jsdom
// Real-Radix layering tests for the drive dropdown inside the modal grant dialog. The sibling
// GrantFolderAccessDialog.interaction.test.tsx flat-mocks @/components/ui/dropdown-menu, which
// renders the menu inside the dialog's DOM and therefore cannot express portaling/stacking
// behavior; this file deliberately uses the real DropdownMenu.
//
// jsdom limitations vs a real browser: dispatchEvent ignores pointer-events, so "blank" clicks
// are dispatched directly on the panel/overlay element a real click would fall through to. The
// pointer-capture and scrollIntoView shims below cover jsdom gaps Radix menus hit on open.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

import {
  createInitialGrantedFoldersState,
  useGrantedFoldersStore
} from '@/stores/granted-folders-store'
import { GrantFolderAccessDialog } from './GrantFolderAccessDialog'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// jsdom lacks the pointer-capture and scrollIntoView APIs Radix menus call.
Element.prototype.setPointerCapture = () => undefined
Element.prototype.releasePointerCapture = () => undefined
Element.prototype.hasPointerCapture = () => false
Element.prototype.scrollIntoView = () => undefined

const HOME = '/Users/roxi'

let container: HTMLElement
let root: Root
let onOpenChange: Mock<(open: boolean) => void>
let listDir: ReturnType<typeof vi.fn>

const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  useGrantedFoldersStore.setState(createInitialGrantedFoldersState())
  onOpenChange = vi.fn()
  listDir = vi.fn(async (path: string) => ({ entries: [], truncated: false, resolvedPath: path }))
  ;(window as unknown as { api: unknown }).api = {
    localFs: {
      getRoots: vi.fn().mockResolvedValue({ home: HOME, machineName: 'Test Mac' }),
      listDrives: vi.fn().mockResolvedValue([
        { path: '/', label: '/' },
        { path: '/Volumes/External', label: 'External' }
      ]),
      listDir,
      listGrantedRoots: vi.fn().mockResolvedValue([]),
      grantRoot: vi.fn().mockResolvedValue([])
    }
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  // The portaled menu content outlives the React root; clean it up between tests.
  document
    .querySelectorAll('[data-slot="dropdown-menu-content"],[data-radix-popper-content-wrapper]')
    .forEach((node) => node.remove())
  document.body.style.pointerEvents = ''
  vi.restoreAllMocks()
})

const fire = async (target: Element, type: string): Promise<void> => {
  await act(async () => {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, cancelable: true }))
    await Promise.resolve()
  })
}

const menuOpen = (): boolean =>
  Boolean(document.body.querySelector('[data-slot="dropdown-menu-content"]'))

const openDriveMenu = async (): Promise<void> => {
  const trigger = document.body.querySelector('[data-testid="grant-access-drive-root"]')
  await fire(trigger as Element, 'pointerdown')
  await fire(trigger as Element, 'click')
  await flush()
  expect(menuOpen()).toBe(true)
}

const renderDialog = (): void => {
  act(() => {
    root.render(<GrantFolderAccessDialog open onOpenChange={onOpenChange} />)
  })
}

describe('GrantFolderAccessDialog drive menu layering (real Radix)', () => {
  it('closes only the menu when blank areas are clicked while it is open', async () => {
    renderDialog()
    await flush()
    await openDriveMenu()

    // (a) A blank area inside the dialog: with the modal menu open, pointer events are disabled
    // there, so a real click falls through to the overlay — dispatch on the panel stands in.
    const panel = document.body.querySelector('[data-testid="grant-folder-access-dialog"]')
    await fire(panel as Element, 'pointerdown')
    await fire(panel as Element, 'click')
    await flush()
    expect(menuOpen()).toBe(false)
    expect(onOpenChange).not.toHaveBeenCalled()

    // (b) The overlay itself: must close only the menu, not the dialog.
    await openDriveMenu()
    const overlay = document.body.querySelector('.fixed.inset-0')
    await fire(overlay as Element, 'pointerdown')
    await fire(overlay as Element, 'click')
    await flush()
    expect(menuOpen()).toBe(false)
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('navigates on drive select without closing the dialog', async () => {
    renderDialog()
    await flush()
    await openDriveMenu()

    const item = document.body.querySelector('[data-testid="grant-access-drive-/Volumes/External"]')
    expect(item).not.toBeNull()
    await fire(item as Element, 'pointerdown')
    await fire(item as Element, 'click')
    await flush()

    expect(menuOpen()).toBe(false)
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(listDir).toHaveBeenCalledWith('/Volumes/External')
  })

  it('absorbs the first outside click after an Escape close and a keyboard reopen', async () => {
    // Regression coverage for the stale-disarm-listener hole: an Escape close leaves the
    // one-shot pointerdown disarm listener unconsumed, and a keyboard reopen involves no
    // pointerdown to consume it. Without withdrawing the listener on reopen, the next outside
    // pointerdown flips the guard off while the menu is open and the deferred click then
    // dismisses the dialog too. jsdom caveat (verified by instrumented runs): after a keyboard
    // reopen the dialog's layer bails before guard evaluation, so this test cannot fail without
    // the fix here — the negative verification was done by logging the stale disarm firing at
    // the overlay pointerdown in the unfixed build. The test still pins the end-to-end contract.
    renderDialog()
    await flush()
    await openDriveMenu()

    // Escape closes the menu without any pointerdown, leaving the one-shot disarm listener
    // unconsumed.
    const menu = document.body.querySelector('[data-slot="dropdown-menu-content"]')
    await act(async () => {
      menu?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await Promise.resolve()
    })
    await flush()
    expect(menuOpen()).toBe(false)
    expect(onOpenChange).not.toHaveBeenCalled()

    // Reopen via keyboard (Enter on the trigger): no pointerdown is involved, so a stale disarm
    // listener would survive into the next outside click.
    const trigger = document.body.querySelector('[data-testid="grant-access-drive-root"]')
    await act(async () => {
      trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await Promise.resolve()
    })
    await flush()
    expect(menuOpen()).toBe(true)

    // The overlay click must close only the menu, not the dialog.
    const overlay = document.body.querySelector('.fixed.inset-0')
    await fire(overlay as Element, 'pointerdown')
    await fire(overlay as Element, 'click')
    await flush()
    expect(menuOpen()).toBe(false)
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('still dismisses the dialog on an outside click once the menu is closed', async () => {
    renderDialog()
    await flush()
    await openDriveMenu()

    // Close the menu via an overlay click (absorbed for the dialog), then click the overlay
    // again: the second click is a genuine outside interaction and dismisses the dialog.
    const overlay = document.body.querySelector('.fixed.inset-0')
    await fire(overlay as Element, 'pointerdown')
    await fire(overlay as Element, 'click')
    await flush()
    expect(menuOpen()).toBe(false)
    expect(onOpenChange).not.toHaveBeenCalled()

    await fire(overlay as Element, 'pointerdown')
    await fire(overlay as Element, 'click')
    await flush()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
