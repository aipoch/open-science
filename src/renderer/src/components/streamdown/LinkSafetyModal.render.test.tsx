// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LinkSafetyModal } from './LinkSafetyModal'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('LinkSafetyModal', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    vi.useRealTimers()
    act(() => root.unmount())
    container.remove()
    document.body.querySelector('[data-streamdown="link-safety-modal"]')?.remove()
    document.body.style.overflow = ''
  })

  it('uses settings dialog chrome and requires an explicit close action', () => {
    const onClose = vi.fn()

    act(() => {
      root.render(
        <LinkSafetyModal
          url="https://example.com/paper"
          isOpen
          onClose={onClose}
          onConfirm={vi.fn()}
        />
      )
    })

    const overlay = document.body.querySelector<HTMLElement>(
      '[data-streamdown="link-safety-modal"]'
    )
    const panel = document.body.querySelector<HTMLElement>(
      '[role="dialog"][aria-label="Open external link?"]'
    )

    expect(overlay).not.toBeNull()
    expect(panel).not.toBeNull()
    expect(overlay?.contains(panel)).toBe(false)
    expect(overlay?.getAttribute('data-state')).toBe('open')
    expect(overlay?.className).toContain('bg-black/50')
    expect(overlay?.className).toContain('data-[state=open]:fade-in-0')
    expect(overlay?.className).toContain('data-[state=closed]:fill-mode-forwards')
    expect(panel?.className).toContain('rounded-xl')
    expect(panel?.className).toContain('border-border')
    expect(panel?.className).toContain('bg-card')
    expect(panel?.className).toContain('shadow-dialog')
    expect(panel?.className).toContain('data-[state=open]:zoom-in-95')
    expect(panel?.className).toContain('data-[state=closed]:fill-mode-forwards')

    act(() => {
      overlay?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onClose).not.toHaveBeenCalled()

    act(() => {
      panel
        ?.querySelector<HTMLButtonElement>('[aria-label="Close"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('keeps the closing modal mounted and scroll-locked until its exit animation ends', () => {
    vi.useFakeTimers()

    const onClose = vi.fn()

    const renderModal = (isOpen: boolean): void => {
      act(() => {
        root.render(
          <LinkSafetyModal
            url="https://example.com/paper"
            isOpen={isOpen}
            onClose={onClose}
            onConfirm={vi.fn()}
          />
        )
      })
    }

    renderModal(true)

    expect(document.body.style.overflow).toBe('hidden')

    act(() => {
      document.body
        .querySelector<HTMLButtonElement>('[aria-label="Close"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    renderModal(false)

    const closingOverlay = document.body.querySelector<HTMLElement>(
      '[data-streamdown="link-safety-modal"]'
    )
    const closingPanel = document.body.querySelector<HTMLElement>(
      '[role="dialog"][aria-label="Open external link?"]'
    )

    expect(closingOverlay?.getAttribute('data-state')).toBe('closed')
    expect(closingPanel?.getAttribute('data-state')).toBe('closed')
    expect(closingOverlay?.contains(closingPanel)).toBe(false)
    expect(document.body.style.overflow).toBe('hidden')

    act(() => {
      vi.advanceTimersByTime(200)
    })

    expect(document.body.querySelector('[data-streamdown="link-safety-modal"]')).not.toBeNull()

    act(() => {
      closingPanel?.dispatchEvent(new Event('animationend', { bubbles: true }))
    })

    expect(document.body.querySelector('[data-streamdown="link-safety-modal"]')).toBeNull()
    expect(
      document.body.querySelector('[role="dialog"][aria-label="Open external link?"]')
    ).toBeNull()
    expect(document.body.style.overflow).toBe('')
  })
})
