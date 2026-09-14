// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { EnvStatusBanner } from './EnvStatusBanner'
import { deriveProvisionUi } from './provisioning-view'

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
  it('routes reported recovery failures to settings instead of repeating provision', () => {
    let retried = 0
    let openedSettings = 0
    const diagnostic =
      "Error invoking remote method 'notebook-env:provision': Error: The python runtime is " +
      'recovering from an interrupted operation whose process could not be confirmed stopped.'
    const ui = deriveProvisionUi(
      {
        pythonReady: false,
        rReady: false,
        version: 0,
        provisioning: false,
        pythonRecoveryBlocked: true
      },
      undefined,
      undefined,
      diagnostic
    )
    act(() =>
      root.render(
        <EnvStatusBanner
          ui={ui}
          onRetry={() => {
            retried += 1
          }}
          onOpenRuntimes={() => {
            openedSettings += 1
          }}
        />
      )
    )
    const banner = container.querySelector('[role="alert"]')
    expect(banner?.textContent).toContain('Runtime recovery blocked')
    expect(banner?.textContent).not.toContain(diagnostic)
    const action = banner?.querySelector('button')
    expect(action?.textContent).toBe('Open Settings')
    act(() => action?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(openedSettings).toBe(1)
    expect(retried).toBe(0)
  })

  it('keeps Recheck available when settings are not mounted during onboarding', () => {
    let rechecked = 0
    act(() =>
      root.render(
        <EnvStatusBanner
          ui={{ kind: 'error', message: 'recovery details', recoveryBlocked: true }}
          onRetry={() => {
            rechecked += 1
          }}
        />
      )
    )
    const button = container.querySelector('button')
    expect(button?.textContent).toBe('Recheck')
    act(() => button?.click())
    expect(rechecked).toBe(1)
  })

  it('shows an updating banner during an additive upgrade', () => {
    act(() =>
      root.render(
        <EnvStatusBanner
          ui={{
            kind: 'preparing',
            scope: 'upgrade',
            phase: 'upgrade',
            event: { code: 'updating-default-packages' },
            progress: 0.6
          }}
        />
      )
    )
    expect(container.querySelector('[data-testid="env-status-banner"]')?.textContent).toContain(
      'Updating'
    )
    const banner = container.querySelector('[data-testid="env-status-banner"]')
    expect(banner?.getAttribute('role')).toBe('status')
    expect(banner?.getAttribute('aria-live')).toBe('polite')
  })

  it('shows the shared speed/ETA line during an upgrade pack download', () => {
    act(() =>
      root.render(
        <EnvStatusBanner
          ui={{
            kind: 'preparing',
            scope: 'upgrade',
            phase: 'fetch-python',
            event: { code: 'downloading-python-runtime' },
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
            phase: 'fetch-python',
            event: { code: 'downloading-python-runtime' },
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
    expect(banner?.getAttribute('role')).toBe('alert')
    expect(banner?.getAttribute('aria-live')).toBe('assertive')
    const button = container.querySelector(
      '[data-testid="env-status-banner-retry"]'
    ) as HTMLButtonElement
    expect(button).not.toBeNull()
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

  it('is hidden for a first-run python preparation (that is the onboarding/gate surface, not a banner)', () => {
    act(() =>
      root.render(
        <EnvStatusBanner ui={{ kind: 'preparing', scope: 'python', phase: '', progress: 0.2 }} />
      )
    )
    expect(container.querySelector('[data-testid="env-status-banner"]')).toBeNull()
  })

  it('is hidden when ready', () => {
    act(() => root.render(<EnvStatusBanner ui={{ kind: 'ready' }} />))
    expect(container.querySelector('[data-testid="env-status-banner"]')).toBeNull()
  })

  it('announces when environment work becomes ready', () => {
    act(() =>
      root.render(
        <EnvStatusBanner
          ui={{
            kind: 'preparing',
            scope: 'upgrade',
            phase: 'upgrade',
            event: { code: 'updating-default-packages' },
            progress: 0.8
          }}
        />
      )
    )
    act(() => root.render(<EnvStatusBanner ui={{ kind: 'ready' }} />))

    const completion = container.querySelector('[data-testid="env-status-ready-announcement"]')
    expect(completion?.getAttribute('role')).toBe('status')
    expect(completion?.textContent).toBe('Notebook environment ready')
  })
})
