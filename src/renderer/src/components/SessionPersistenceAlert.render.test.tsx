// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SessionPersistenceAlert } from './SessionPersistenceAlert'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('SessionPersistenceAlert', () => {
  it('renders the default error as a fixed semantic card without a retry action', () => {
    act(() =>
      root.render(
        <SessionPersistenceAlert title="Storage unavailable" message="Retry after reconnecting." />
      )
    )

    const alert = container.querySelector<HTMLElement>('[role="alert"]')

    expect(alert?.textContent).toContain('Storage unavailable')
    expect(alert?.textContent).toContain('Retry after reconnecting.')
    expect(alert?.className).toContain('fixed')
    expect(alert?.className).toContain('bg-card')
    expect(alert?.className).toContain('border-destructive/40')
    expect(alert?.className).not.toContain('border-border')
    expect(container.querySelector('[data-testid="session-persistence-retry"]')).toBeNull()
  })

  it('renders an inline warning with the shared retry Button contract', () => {
    const onRetry = vi.fn()
    act(() =>
      root.render(
        <SessionPersistenceAlert
          inline
          variant="warning"
          title="Some conversations were skipped"
          message="Retry to scan storage again."
          onRetry={onRetry}
        />
      )
    )

    const alert = container.querySelector<HTMLElement>('[role="alert"]')
    const retry = container.querySelector<HTMLButtonElement>(
      '[data-testid="session-persistence-retry"]'
    )

    expect(alert?.className).toContain('flex w-full max-w-md')
    expect(alert?.className).toContain('border-border')
    expect(alert?.className).not.toContain('fixed')
    expect(alert?.className).not.toContain('border-destructive/40')
    expect(retry?.dataset.slot).toBe('button')
    expect(retry?.className).toContain('focus-visible:ring-3')
    expect(retry?.className).toContain('disabled:pointer-events-none')

    act(() => retry?.click())
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('renders a labelled shared Button for dismissing a persistent warning', () => {
    const onDismiss = vi.fn()
    act(() =>
      root.render(
        <SessionPersistenceAlert
          variant="warning"
          title="Saved conversation data was damaged"
          message="The damaged file was moved aside."
          onDismiss={onDismiss}
        />
      )
    )

    const dismiss = container.querySelector<HTMLButtonElement>(
      '[data-testid="session-persistence-dismiss"]'
    )

    expect(dismiss?.dataset.slot).toBe('button')
    expect(dismiss?.getAttribute('aria-label')).toBe('Dismiss storage warning')
    expect(dismiss?.className).toContain('focus-visible:ring-3')
    act(() => dismiss?.click())
    expect(onDismiss).toHaveBeenCalledOnce()
  })
})
