// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { usePermissionGrantsStore } from '@/stores/permission-grants-store'
import { PermissionUndoSnackbar } from './PermissionUndoSnackbar'

describe('PermissionUndoSnackbar', () => {
  let container: HTMLDivElement
  let root: Root
  const restore = vi.fn()

  beforeEach(() => {
    vi.useFakeTimers()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    restore.mockReset().mockResolvedValue({
      grants: [],
      counts: { all: 0, global: 0, project: 0, session: 0 },
      conflicts: []
    })
    window.api = { permissions: { restore } } as unknown as Window['api']
    usePermissionGrantsStore.setState({
      grants: [],
      counts: { all: 0, global: 0, project: 0, session: 0 },
      status: 'ready',
      error: undefined,
      undo: {
        token: 'undo-1',
        expiresAt: Date.now() + 8_000,
        message: 'Revoked Local compute · Shell'
      },
      undoQueue: [],
      isRestoring: false
    })
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
    expect(container.querySelector('[data-testid="permission-undo-snackbar"]')).toBeNull()
  })

  it('supports explicit dismiss and expiry after Settings has closed', async () => {
    await act(async () => root.render(<PermissionUndoSnackbar />))
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Dismiss permission Undo"]')?.click()
    )
    expect(container.querySelector('[data-testid="permission-undo-snackbar"]')).toBeNull()

    await act(async () =>
      usePermissionGrantsStore.setState({
        undo: {
          token: 'undo-2',
          expiresAt: Date.now() + 8_000,
          message: 'Revoked Python'
        }
      })
    )
    expect(container.textContent).toContain('Revoked Python')

    await act(async () => vi.advanceTimersByTime(8_000))
    expect(container.querySelector('[data-testid="permission-undo-snackbar"]')).toBeNull()
  })

  it('keeps the Undo stack above the window bottom after Settings has closed', async () => {
    await act(async () => root.render(<PermissionUndoSnackbar />))

    const stack = container.querySelector<HTMLElement>('[data-testid="permission-undo-stack"]')

    expect(stack?.className).toContain('bottom-[max(1.5rem,env(safe-area-inset-bottom))]')
    expect(stack?.className).toContain('max-h-[min(70svh,32rem)]')
    expect(stack?.className).toContain('overflow-y-auto')
    expect(stack?.querySelector('[data-slot="scroll-area-viewport"]')).toBeNull()
  })

  it('pauses automatic dismissal while the snackbar is hovered', async () => {
    await act(async () => root.render(<PermissionUndoSnackbar />))
    const snackbar = container.querySelector<HTMLElement>(
      '[data-testid="permission-undo-snackbar"]'
    )

    await act(async () => snackbar?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    await act(async () => vi.advanceTimersByTime(8_000))
    expect(container.querySelector('[data-testid="permission-undo-snackbar"]')).not.toBeNull()

    await act(async () => snackbar?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })))
    await act(async () => vi.advanceTimersByTime(0))
    expect(container.querySelector('[data-testid="permission-undo-snackbar"]')).toBeNull()
  })

  it('renders every unexpired receipt as an independently operable Undo action', async () => {
    usePermissionGrantsStore.setState({
      undoQueue: [
        {
          token: 'undo-2',
          expiresAt: Date.now() + 8_000,
          message: 'Revoked Python'
        },
        {
          token: 'undo-3',
          expiresAt: Date.now() + 8_000,
          message: 'Revoked Shell'
        },
        {
          token: 'undo-4',
          expiresAt: Date.now() + 8_000,
          message: 'Revoked Connector'
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
    expect(container.querySelector('[data-undo-token="undo-4"]')).toBeNull()
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
      expect(button.className).toContain('focus-visible:ring-3')
    })
  })
})
