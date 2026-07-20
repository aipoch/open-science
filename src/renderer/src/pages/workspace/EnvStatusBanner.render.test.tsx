// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { EnvStatusBanner } from './EnvStatusBanner'

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

describe('EnvStatusBanner', () => {
  it('shows an updating banner during an additive upgrade', () => {
    act(() =>
      root.render(
        <EnvStatusBanner
          ui={{
            kind: 'preparing',
            scope: 'upgrade',
            phase: 'install',
            message: 'Updating…',
            progress: 0.6
          }}
        />
      )
    )
    expect(container.querySelector('[data-testid="env-status-banner"]')?.textContent).toContain(
      'Updating'
    )
  })

  it('shows an error banner with a retry affordance wired to the store retry action', () => {
    let retried = 0
    act(() =>
      root.render(
        <EnvStatusBanner
          ui={{ kind: 'error', message: 'offline' }}
          onRetry={() => (retried += 1)}
        />
      )
    )
    const banner = container.querySelector('[data-testid="env-status-banner"]')
    expect(banner?.textContent).toContain('offline')
    const button = container.querySelector(
      '[data-testid="env-status-banner-retry"]'
    ) as HTMLButtonElement
    expect(button).not.toBeNull()
    act(() => button.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(retried).toBe(1)
  })

  it('is hidden for a first-run python preparation (that is the onboarding/gate surface, not a banner)', () => {
    act(() =>
      root.render(
        <EnvStatusBanner
          ui={{ kind: 'preparing', scope: 'python', phase: '', message: '', progress: 0.2 }}
        />
      )
    )
    expect(container.querySelector('[data-testid="env-status-banner"]')).toBeNull()
  })

  it('is hidden when ready', () => {
    act(() => root.render(<EnvStatusBanner ui={{ kind: 'ready' }} />))
    expect(container.querySelector('[data-testid="env-status-banner"]')).toBeNull()
  })
})
