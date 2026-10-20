// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SessionHeaderMenu } from './SessionHeaderMenu'
import { createSessionActionBindings } from './session-action-menu'
import type { ChatSession } from '@/stores/session-store'

const session: ChatSession = {
  id: 'session-a',
  projectId: 'project-a',
  title: 'Research',
  cwd: '/workspace',
  status: 'idle',
  messages: [],
  createdAt: 1,
  updatedAt: 1
}

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

const render = async (props: React.ComponentProps<typeof SessionHeaderMenu>): Promise<void> => {
  await act(async () => root.render(<SessionHeaderMenu {...props} />))
}

const trigger = (): HTMLButtonElement =>
  container.querySelector('[data-testid="session-header-menu-trigger"]')!

const openMenu = async (): Promise<void> => {
  await act(async () =>
    trigger().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  )
}

describe('SessionHeaderMenu', () => {
  it('resolves its catalog and recipe to one action and creates an empty side chat once', async () => {
    const createSideChat = vi.fn(() => 'draft')
    await render({ session, createSideChat })
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
    await openMenu()
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
    const items = document.querySelectorAll<HTMLElement>('[role="menuitem"]')
    expect(items).toHaveLength(1)
    expect(items[0].textContent).toBe('New side chat')
    await act(async () => items[0].click())
    expect(createSideChat).toHaveBeenCalledExactlyOnceWith()
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
  })

  it('explains an unavailable action and does not invoke the binding', async () => {
    const createSideChat = vi.fn(() => 'draft')
    await render({ session, createSideChat, disabledReason: 'Session unavailable' })
    await openMenu()
    const item = document.querySelector<HTMLElement>('[data-action-id="new-side-chat"]')!
    expect(item.getAttribute('aria-disabled')).toBe('true')
    expect(item.title).toBe('Session unavailable')
    await act(async () => item.click())
    expect(createSideChat).not.toHaveBeenCalled()
  })

  it('dismisses a stale target on Session switch and uses the new owner on reopening', async () => {
    const first = vi.fn(() => 'first')
    const second = vi.fn(() => 'second')
    await render({ session, createSideChat: first })
    await openMenu()
    await render({ session: { ...session, id: 'session-b' }, createSideChat: second })
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
    await openMenu()
    await act(async () =>
      document.querySelector<HTMLElement>('[data-action-id="new-side-chat"]')!.click()
    )
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledExactlyOnceWith()
  })

  it('groups existing Session actions and resolves Pin to Unpin for a pinned Session', async () => {
    const pin = vi.fn()
    const edit = vi.fn()
    const bindings = createSessionActionBindings({
      canMutateConversations: true,
      canDeleteConversations: true,
      canDownloadArtifacts: true,
      canArchiveSession: () => true,
      onTogglePin: pin,
      onRenameSession: edit,
      onDownloadArtifacts: vi.fn(),
      onViewNotebook: vi.fn(),
      onDeleteSession: vi.fn(),
      onForkSession: vi.fn(async () => {}),
      onExportSession: vi.fn(),
      onExportPackage: vi.fn(async () => {}),
      onExportDiagnostics: vi.fn(),
      onArchiveSession: vi.fn()
    })
    const pinned = { ...session, pinned: true }
    await render({ session: pinned, bindings, createSideChat: () => 'draft' })
    await openMenu()
    expect(
      [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)
    ).toEqual(['Edit…', 'Unpin', 'New side chat', 'Fork', 'Export', 'Archive'])
    expect(document.querySelectorAll('[role="separator"]')).toHaveLength(3)
    await act(async () =>
      document.querySelector<HTMLElement>('[data-action-id="toggle-pin"]')!.click()
    )
    expect(pin).toHaveBeenCalledExactlyOnceWith(pinned)
    expect(edit).not.toHaveBeenCalled()
  })

  it('updates an open menu when Session availability changes and prevents stale actions', async () => {
    const fork = vi.fn(async () => {})
    const options = {
      canMutateConversations: true,
      canDeleteConversations: true,
      canDownloadArtifacts: true,
      canArchiveSession: () => true,
      onTogglePin: vi.fn(),
      onRenameSession: vi.fn(),
      onDownloadArtifacts: vi.fn(),
      onViewNotebook: vi.fn(),
      onDeleteSession: vi.fn(),
      onForkSession: fork
    }
    const bindings = createSessionActionBindings(options)
    await render({ session, bindings })
    await openMenu()
    expect(
      document.querySelector('[data-action-id="fork"]')?.getAttribute('aria-disabled')
    ).not.toBe('true')
    await render({ session: { ...session, status: 'running' }, bindings })
    const item = document.querySelector<HTMLElement>('[data-action-id="fork"]')!
    expect(item.getAttribute('aria-disabled')).toBe('true')
    expect(item.title).toContain('Wait for all Session activity')
    await act(async () => item.click())
    expect(fork).not.toHaveBeenCalled()
  })

  it('blocks Fork and transfer exports while credentials are pending, then restores availability', async () => {
    const onFork = vi.fn(async () => {})
    const bindings = createSessionActionBindings({
      canMutateConversations: true,
      canDeleteConversations: false,
      canDownloadArtifacts: false,
      onTogglePin: vi.fn(),
      onRenameSession: vi.fn(),
      onForkSession: onFork,
      onExportSession: vi.fn(),
      onExportPackage: vi.fn(async () => {})
    })
    const ready = { ...session, activeMessageCount: 1 }
    await render({ session: ready, bindings, credentialPending: true })
    await openMenu()
    const fork = document.querySelector<HTMLElement>('[data-action-id="fork"]')!
    const exports = document.querySelector<HTMLElement>('[data-slot="dropdown-menu-sub-trigger"]')!
    expect(fork.getAttribute('aria-disabled')).toBe('true')
    expect(exports.getAttribute('aria-disabled')).toBe('true')
    await act(async () => fork.click())
    expect(onFork).not.toHaveBeenCalled()
    await render({ session: ready, bindings, credentialPending: false })
    expect(fork.getAttribute('aria-disabled')).not.toBe('true')
    expect(exports.getAttribute('aria-disabled')).not.toBe('true')
  })

  it('restores trigger focus when the keyboard dismisses the menu', async () => {
    await render({ session, createSideChat: () => 'draft' })
    trigger().focus()
    await openMenu()
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
      )
    })
    expect(document.querySelector('[role="menu"]')).toBeNull()
    await act(async () => {
      await vi.waitFor(() => expect(document.activeElement).toBe(trigger()))
    })
  })
})
