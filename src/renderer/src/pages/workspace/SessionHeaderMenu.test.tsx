// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SessionHeaderMenu } from './SessionHeaderMenu'

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
  await act(async () => trigger().click())
}

describe('SessionHeaderMenu', () => {
  it('resolves its catalog and recipe to one action and creates an empty side chat once', async () => {
    const createSideChat = vi.fn(() => 'draft')
    await render({ sessionId: 'session-a', createSideChat })
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
    await render({ sessionId: 'session-a', createSideChat, disabledReason: 'Session unavailable' })
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
    await render({ sessionId: 'session-a', createSideChat: first })
    await openMenu()
    await render({ sessionId: 'session-b', createSideChat: second })
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
    await openMenu()
    await act(async () =>
      document.querySelector<HTMLElement>('[data-action-id="new-side-chat"]')!.click()
    )
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledExactlyOnceWith()
  })

  it('restores trigger focus when the keyboard dismisses the menu', async () => {
    await render({ sessionId: 'session-a', createSideChat: () => 'draft' })
    trigger().focus()
    await openMenu()
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
      )
    })
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(trigger())
  })
})
