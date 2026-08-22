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

  it('keeps an upgrade download to one quiet status without transfer telemetry', () => {
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
    const banner = container.querySelector('[data-testid="env-status-banner"]')
    expect(banner?.textContent).toContain('Updating the notebook environment…')
    expect(banner?.textContent).not.toContain('/s')
    expect(banner?.textContent).not.toContain('%')
    expect(banner?.querySelector('[style*="scaleX"]')).toBeNull()
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
    expect(button.className).toContain('h-8')
    expect(button.className).not.toContain('min-h-11')
    act(() => button.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(retried).toBe(1)
  })

  it('bounds a long error reason in a scrollable box and uses the dialog card chrome, keeping the full text readable', () => {
    // A provisioner failure can carry a long reason. This banner is the ONLY error surface outside the
    // notebook pane (Home has no overlay), so the reason must stay fully readable: bound it to a
    // scrollable box (max-h + overflow) rather than clamping lines, which could hide the actionable tail.
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
    // The reason is bounded (max-h) and scrollable (overflow-y-auto) rather than line-clamped, so the
    // banner cannot fill the screen yet the full excerpt remains reachable — no line-clamp truncation.
    const reason = banner.querySelector('.overflow-y-auto') as HTMLElement
    expect(reason).not.toBeNull()
    expect(reason.className).toMatch(/max-h-/)
    expect(reason.className).not.toContain('line-clamp')
    expect(reason.textContent).toContain('micromamba failed (exit 1)')
    // The full reason text is rendered (not truncated in the DOM), so scrolling exposes all of it.
    expect(reason.textContent).toBe(longReason)
    // The standing title is separate from the scrollable reason.
    expect(banner.textContent).toContain('Environment update failed')
  })

  it('shows first-run Python preparation without a percentage or progress card', () => {
    act(() =>
      root.render(
        <EnvStatusBanner
          ui={{ kind: 'preparing', scope: 'python', phase: '', message: '', progress: 0.2 }}
        />
      )
    )
    const banner = container.querySelector<HTMLElement>('[data-testid="env-status-banner"]')
    expect(banner?.textContent).toBe('Preparing Python environment…')
    expect(banner?.getAttribute('role')).toBe('status')
    expect(banner?.className).not.toContain('shadow-dialog')
    expect(container.querySelector('[data-testid="env-status-activity"]')).not.toBeNull()
  })

  it('renders preparation inline when onboarding owns the status placement', () => {
    act(() =>
      root.render(
        <EnvStatusBanner
          placement="inline"
          ui={{ kind: 'preparing', scope: 'python', phase: '', message: '', progress: 0.2 }}
        />
      )
    )
    const banner = container.querySelector<HTMLElement>('[data-testid="env-status-banner"]')
    expect(banner?.dataset.placement).toBe('inline')
    expect(banner?.className).not.toContain('fixed')
    expect(banner?.className).toContain('border-t')
  })

  it('is hidden when ready', () => {
    act(() => root.render(<EnvStatusBanner ui={{ kind: 'ready' }} />))
    expect(container.querySelector('[data-testid="env-status-banner"]')).toBeNull()
  })
})
