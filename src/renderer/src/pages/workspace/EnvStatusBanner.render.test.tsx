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

  it('shows the shared speed/ETA line during an upgrade pack download', () => {
    act(() =>
      root.render(
        <EnvStatusBanner
          ui={{
            kind: 'preparing',
            scope: 'upgrade',
            phase: 'download',
            message: 'Downloading…',
            progress: 0.4,
            download: {
              phase: 'downloading',
              transferred: 4_000_000,
              total: 10_000_000,
              percent: 40,
              bytesPerSecond: 2_000_000,
              attempt: 0
            }
          }}
        />
      )
    )
    // Speed is surfaced (formatProgressLine renders "…/s"), not just a bare percent.
    expect(container.querySelector('[data-testid="env-status-banner"]')?.textContent).toContain(
      '/s'
    )
  })

  it('surfaces a reconnect during an upgrade download instead of a frozen percent', () => {
    act(() =>
      root.render(
        <EnvStatusBanner
          ui={{
            kind: 'preparing',
            scope: 'upgrade',
            phase: 'download',
            message: 'Downloading…',
            progress: 0.4,
            download: {
              phase: 'reconnecting',
              transferred: 4_000_000,
              total: 10_000_000,
              percent: 40,
              bytesPerSecond: 0,
              attempt: 2
            }
          }}
        />
      )
    )
    expect(container.querySelector('[data-testid="env-status-banner"]')?.textContent).toContain(
      'resuming'
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

  it('clamps a long error reason and uses the dialog card chrome instead of an unbounded pill', () => {
    // A provisioner failure can carry thousands of characters (the micromamba package plan). The
    // banner must not grow unbounded: the reason is line-clamped and the panel adopts the rounded
    // dialog card. Full diagnostics live in the logs, not this banner.
    const longReason = `micromamba failed (exit 1): ${'pkg==1.0=hbuild_0 - '.repeat(400)}`
    act(() =>
      root.render(
        <EnvStatusBanner ui={{ kind: 'error', message: longReason }} onRetry={() => {}} />
      )
    )
    const banner = container.querySelector('[data-testid="env-status-banner"]') as HTMLElement
    expect(banner).not.toBeNull()
    // Dialog chrome (matches dialog-chrome.ts): rounded card, card surface, dialog shadow.
    expect(banner.className).toContain('rounded-xl')
    expect(banner.className).toContain('bg-card')
    expect(banner.className).toContain('shadow-dialog')
    // The reason is present but rendered in a line-clamped node so the banner can't fill the screen.
    const reason = banner.querySelector('.line-clamp-3') as HTMLElement
    expect(reason).not.toBeNull()
    expect(reason.textContent).toContain('micromamba failed (exit 1)')
    // The standing title is separate from the clamped reason.
    expect(banner.textContent).toContain('Environment update failed')
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
