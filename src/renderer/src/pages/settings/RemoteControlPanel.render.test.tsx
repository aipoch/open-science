// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RemoteAccessSnapshot } from '../../../../shared/remote-access'
import { RemoteControlPanel } from './RemoteControlPanel'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
  delete (window as unknown as { api?: unknown }).api
  vi.unstubAllGlobals()
})

const runningSnapshot = (): RemoteAccessSnapshot => ({
  canManage: true,
  canManagePairing: true,
  mode: 'remoteit-public',
  enabled: true,
  lifecycle: 'running',
  accessUrl: 'https://open-science.connect.remote.it/',
  remoteIt: { installed: true, registered: true, loggedIn: true },
  pendingRequests: [],
  trustedBrowsers: []
})

const mount = async (
  initial: RemoteAccessSnapshot,
  probed = initial
): Promise<
  Record<
    | 'getSnapshot'
    | 'probe'
    | 'detect'
    | 'setMode'
    | 'onChanged'
    | 'approve'
    | 'reject'
    | 'revokeBrowser'
    | 'revokeBrowsers',
    ReturnType<typeof vi.fn>
  >
> => {
  const api = {
    getSnapshot: vi.fn().mockResolvedValue(initial),
    probe: vi.fn().mockResolvedValue(probed),
    detect: vi.fn().mockResolvedValue(initial),
    setMode: vi.fn().mockResolvedValue({
      ...initial,
      mode: 'off',
      enabled: false,
      lifecycle: 'disabled',
      error: undefined
    }),
    approve: vi.fn().mockImplementation(() => Promise.resolve(initial)),
    reject: vi.fn().mockImplementation(() => Promise.resolve(initial)),
    revokeBrowser: vi.fn().mockImplementation(() => Promise.resolve(initial)),
    revokeBrowsers: vi.fn().mockImplementation(() => Promise.resolve(initial)),
    onChanged: vi.fn(() => vi.fn())
  }
  Object.defineProperty(window, 'api', { configurable: true, value: { remoteAccess: api } })
  await act(async () => root.render(<RemoteControlPanel />))
  expect(api.probe).toHaveBeenCalledTimes(initial.canManage ? 1 : 0)
  return api
}

describe('Remote access failure recovery', () => {
  it('offers a retry while Off remains selected after saving the preference fails', async () => {
    const api = await mount({
      ...runningSnapshot(),
      mode: 'off',
      enabled: false,
      lifecycle: 'error',
      accessUrl: undefined,
      error: 'disk full'
    })
    const off = container.querySelector<HTMLInputElement>('input[aria-label="Off"]')!
    expect(off.checked).toBe(true)
    expect(container.textContent).toContain('disk full')
    await act(async () => off.click())
    expect(api.setMode).not.toHaveBeenCalled()

    const retry = [...container.querySelectorAll('button')].find((button) =>
      /retry|try again/i.test(button.textContent ?? '')
    )
    expect(retry, 'Off must offer recovery without first enabling access').toBeDefined()
    await act(async () => retry!.click())
    expect(api.setMode).toHaveBeenCalledExactlyOnceWith({ mode: 'off' })
    expect(off.checked).toBe(true)
    expect(container.textContent).not.toContain('disk full')
    expect(document.activeElement).toBe(off)
  })

  it('warns about restart when locally disabling access could not be saved', async () => {
    await mount({
      ...runningSnapshot(),
      mode: 'off',
      enabled: false,
      lifecycle: 'error',
      accessUrl: undefined,
      error: 'disk full'
    })
    expect(container.textContent).toMatch(/restart/i)
  })

  it('shows a failed external check and retries it without repairing the active route', async () => {
    const running = runningSnapshot()
    const api = await mount(running, {
      ...running,
      remoteIt: { ...running.remoteIt, error: 'provider status unavailable' }
    })
    expect.soft(container.textContent).toContain('provider status unavailable')
    expect.soft(container.textContent).not.toContain('Connected')
    expect.soft(container.textContent).not.toContain('Browser link is ready')
    expect(container.querySelector(`a[href="${running.accessUrl}"]`)).not.toBeNull()
    const retry = [...container.querySelectorAll('button')].find((button) =>
      /check again|detect again|retry/i.test(button.textContent ?? '')
    )
    expect(retry).toBeDefined()
    api.probe.mockResolvedValue(running)
    await act(async () => retry!.click())
    expect.soft(api.probe).toHaveBeenCalledTimes(2)
    expect.soft(api.detect).not.toHaveBeenCalled()
    expect(api.setMode).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Connected')
    expect(container.textContent).not.toContain('provider status unavailable')
  })

  it('keeps shutdown recovery visible when the retry fails again and prevents duplicate submissions', async () => {
    const snapshot: RemoteAccessSnapshot = {
      ...runningSnapshot(),
      mode: 'off',
      enabled: false,
      lifecycle: 'error',
      error: 'disk full'
    }
    const api = await mount(snapshot)
    let finish!: (snapshot: RemoteAccessSnapshot) => void
    api.setMode.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const retry = [...container.querySelectorAll('button')].find((button) =>
      /retry/i.test(button.textContent ?? '')
    )!
    await act(async () => retry.click())
    expect(retry.disabled).toBe(true)
    await act(async () => retry.click())
    expect(api.setMode).toHaveBeenCalledOnce()
    await act(async () => finish(snapshot))
    expect(retry.disabled).toBe(false)
    expect(container.textContent).toContain('disk full')
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Off"]')!.checked).toBe(true)
  })

  it('shows both lifecycle and provider errors without asserting the saved preference is wrong', async () => {
    await mount({
      ...runningSnapshot(),
      mode: 'off',
      enabled: false,
      lifecycle: 'error',
      error: 'cleanup persistence failed',
      remoteIt: {
        ...runningSnapshot().remoteIt,
        error: 'provider status unavailable'
      }
    })
    expect(container.textContent).toContain('cleanup persistence failed')
    expect(container.textContent).toContain('provider status unavailable')
    expect(container.textContent).toContain('may not have been saved')
  })
})

describe('Trusted browser revocation', () => {
  const snapshotWithBrowsers = (): RemoteAccessSnapshot => ({
    ...runningSnapshot(),
    trustedBrowsers: [
      {
        id: 'browser-1',
        browser: 'Chrome',
        platform: 'macOS',
        createdAt: 1,
        lastSeenAt: 2,
        expiresAt: 3
      },
      {
        id: 'browser-2',
        browser: 'Edge',
        platform: 'Windows',
        createdAt: 1,
        lastSeenAt: 2,
        expiresAt: 3
      }
    ]
  })

  it.each(['single', 'all'])('restores the %s revoke opener after cancellation', async (kind) => {
    vi.useFakeTimers()
    await mount(snapshotWithBrowsers())
    const opener =
      kind === 'single'
        ? container.querySelector<HTMLButtonElement>('button[aria-label="Revoke Chrome"]')!
        : [...container.querySelectorAll('button')].find(
            (button) => button.textContent?.trim() === 'Revoke all'
          )!
    await act(async () => {
      opener.focus()
      opener.click()
    })
    const dialog = document.body.querySelector<HTMLElement>('[role="alertdialog"]')!
    const cancel = [...dialog.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Cancel'
    )!
    expect(document.activeElement).toBe(cancel)
    await act(async () => cancel.click())
    await act(async () => vi.advanceTimersByTime(0))
    expect(document.activeElement === opener).toBe(true)
  })

  it.each(['single', 'all'])(
    'focuses the trusted-browser section when successful %s revocation removes the opener',
    async (kind) => {
      vi.useFakeTimers()
      const snapshot = snapshotWithBrowsers()
      const api = await mount(snapshot)
      api.revokeBrowser.mockResolvedValue({
        ...snapshot,
        trustedBrowsers: snapshot.trustedBrowsers.slice(1)
      })
      api.revokeBrowsers.mockResolvedValue({ ...snapshot, trustedBrowsers: [] })
      const opener =
        kind === 'single'
          ? container.querySelector<HTMLButtonElement>('button[aria-label="Revoke Chrome"]')!
          : [...container.querySelectorAll('button')].find(
              (button) => button.textContent?.trim() === 'Revoke all'
            )!
      await act(async () => {
        opener.focus()
        opener.click()
      })
      const dialog = document.body.querySelector<HTMLElement>('[role="alertdialog"]')!
      const confirm = [...dialog.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === (kind === 'single' ? 'Revoke' : 'Revoke all')
      )!
      await act(async () => confirm.click())
      await act(async () => vi.advanceTimersByTime(0))
      expect(opener.isConnected).toBe(false)
      expect(document.activeElement).toBe(
        container.querySelector('section[aria-label="Trusted browsers"]')
      )
    }
  )

  it('keeps the batch dialog busy until completion and reports a failed save without removing browsers', async () => {
    const snapshot = snapshotWithBrowsers()
    const api = await mount(snapshot)
    let reject!: (error: Error) => void
    api.revokeBrowsers.mockReturnValue(
      new Promise((_resolve, rejectPromise) => {
        reject = rejectPromise
      })
    )
    const opener = [...container.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Revoke all'
    )!
    await act(async () => opener.click())
    const dialog = document.body.querySelector<HTMLElement>('[role="alertdialog"]')!
    const confirm = [...dialog.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Revoke all'
    )!
    await act(async () => confirm.click())
    expect([...dialog.querySelectorAll('button')].every((button) => button.disabled)).toBe(true)
    await act(async () => {
      reject(new Error('disk full'))
    })
    expect(container.textContent).toContain('disk full')
    expect(container.querySelectorAll('button[aria-label^="Revoke "]')).toHaveLength(2)
    expect(api.revokeBrowsers).toHaveBeenCalledOnce()
    expect(api.revokeBrowser).not.toHaveBeenCalled()
  })

  it('requires AlertDialog confirmation before revoking a trusted browser', async () => {
    const snapshot = snapshotWithBrowsers()
    const api = await mount(snapshot)

    const trash = container.querySelector<HTMLButtonElement>('button[aria-label="Revoke Chrome"]')
    expect(trash).not.toBeNull()
    await act(async () => trash!.click())

    // Nothing is revoked before the dialog's explicit confirm.
    expect(api.revokeBrowser).not.toHaveBeenCalled()
    expect(api.revokeBrowsers).not.toHaveBeenCalled()
    const dialog = document.body.querySelector<HTMLElement>('[role="alertdialog"]')
    expect(dialog?.textContent).toContain('Revoke trusted browser?')
    expect(dialog?.textContent).toContain('Chrome · macOS')

    // Cancel closes without revoking.
    const cancel = [...(dialog?.querySelectorAll('button') ?? [])].find(
      (button) => button.textContent?.trim() === 'Cancel'
    )
    await act(async () => cancel!.click())
    expect(api.revokeBrowser).not.toHaveBeenCalled()

    // Re-open and confirm.
    await act(async () => trash!.click())
    const confirm = [
      ...(document.body
        .querySelector<HTMLElement>('[role="alertdialog"]')
        ?.querySelectorAll('button') ?? [])
    ].find((button) => button.textContent?.trim() === 'Revoke')
    await act(async () => confirm!.click())
    expect(api.revokeBrowser).toHaveBeenCalledExactlyOnceWith({ browserId: 'browser-1' })
  })

  it('revokes every trusted browser only after confirming the Revoke all dialog', async () => {
    const snapshot = snapshotWithBrowsers()
    const api = await mount(snapshot)

    const revokeAll = [...container.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Revoke all'
    )
    expect(revokeAll, 'Revoke all appears once more than one browser is trusted').toBeDefined()
    await act(async () => revokeAll!.click())

    expect(api.revokeBrowser).not.toHaveBeenCalled()
    expect(api.revokeBrowsers).not.toHaveBeenCalled()
    const dialog = document.body.querySelector<HTMLElement>('[role="alertdialog"]')
    expect(dialog?.textContent).toContain('Revoke all trusted browsers?')

    const confirm = [...(dialog?.querySelectorAll('button') ?? [])].find(
      (button) => button.textContent?.trim() === 'Revoke all'
    )
    await act(async () => confirm!.click())
    expect(api.revokeBrowser).not.toHaveBeenCalled()
    expect(api.revokeBrowsers).toHaveBeenCalledExactlyOnceWith({
      browserIds: ['browser-1', 'browser-2']
    })
  })

  it.each([0, 1, 2])(
    'finishes remote bulk revocation when the caller is at index %s',
    async (callerIndex) => {
      const snapshot = snapshotWithBrowsers()
      snapshot.canManage = false
      snapshot.trustedBrowsers.push({ ...snapshot.trustedBrowsers[0], id: 'browser-3' })
      const callerId = snapshot.trustedBrowsers[callerIndex].id
      const api = await mount(snapshot)
      let authorized = true
      const remaining = new Set(snapshot.trustedBrowsers.map((browser) => browser.id))
      // A single accepted batch keeps executing after its caller loses authorization.
      api.revokeBrowser.mockRejectedValue(new Error('Unexpected per-browser RPC'))
      api.revokeBrowsers.mockImplementation(async ({ browserIds }: { browserIds: string[] }) => {
        if (!authorized) throw new Error('Unauthorized')
        for (const browserId of browserIds) {
          remaining.delete(browserId)
          if (browserId === callerId) authorized = false
        }
        return { ...snapshot, trustedBrowsers: [] }
      })
      const opener = [...container.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === 'Revoke all'
      )!
      await act(async () => opener.click())
      const dialog = document.body.querySelector<HTMLElement>('[role="alertdialog"]')!
      const confirm = [...dialog.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === 'Revoke all'
      )!
      await act(async () => confirm.click())
      expect([...remaining]).toEqual([])
    }
  )
})

describe('Pairing requests', () => {
  const snapshotWithPairing = (): RemoteAccessSnapshot => ({
    ...snapshotWithTrusted(),
    pendingRequests: [
      {
        id: 'req-1',
        code: '482 913',
        browser: 'Chrome',
        platform: 'macOS',
        address: '203.0.113.24',
        requestedAt: Date.now() - 120_000,
        expiresAt: Date.now() + 272_000
      },
      {
        id: 'req-2',
        code: '105 738',
        browser: 'Firefox',
        platform: 'Windows',
        requestedAt: Date.now() - 300_000,
        expiresAt: Date.now() + 95_000
      }
    ]
  })

  const snapshotWithTrusted = (): RemoteAccessSnapshot => ({
    ...runningSnapshot(),
    trustedBrowsers: [
      {
        id: 'browser-1',
        browser: 'Chrome',
        platform: 'macOS',
        createdAt: 1,
        lastSeenAt: 2,
        expiresAt: 3
      }
    ]
  })

  it('lists pairing requests before trusted browsers', async () => {
    await mount(snapshotWithPairing())
    const sections = [...container.querySelectorAll('section')]
    const pairingIndex = sections.findIndex((s) => s.textContent?.includes('Pairing requests'))
    const trustedIndex = sections.findIndex((s) => s.textContent?.includes('Trusted browsers'))
    expect(pairingIndex).toBeGreaterThanOrEqual(0)
    expect(trustedIndex).toBeGreaterThanOrEqual(0)
    expect(pairingIndex).toBeLessThan(trustedIndex)
  })

  it('shows the pending count, action-needed badge, countdown and security note', async () => {
    await mount(snapshotWithPairing())
    expect(container.textContent).toContain('Action needed')
    expect(container.textContent).toMatch(/Code expires in \d{2}:\d{2}/)
    expect(container.textContent).toContain('Approve only if you started this sign-in')

    const urgent = container.querySelector('[data-testid="pairing-expiry-req-2"]')
    expect(urgent?.className).toContain('bg-status-warning-surface')
    const relaxed = container.querySelector('[data-testid="pairing-expiry-req-1"]')
    expect(relaxed?.className).toContain('bg-secondary')
  })

  it('does not show a success notice when approval fails', async () => {
    const api = await mount(snapshotWithPairing())
    api.approve.mockRejectedValue(new Error('disk full'))
    const button = [...container.querySelectorAll('button')].find(
      (entry) => entry.textContent?.trim() === 'Trust this browser for 180 days'
    )!
    await act(async () => button.click())
    expect(container.querySelector('[data-testid="remote-trust-toast"]')).toBeNull()
    expect(container.textContent).toContain('disk full')
  })

  it('updates the countdown through expiry and clears the clock on unmount', async () => {
    vi.useFakeTimers()
    await mount(snapshotWithPairing())
    const expiry = (): string | null | undefined =>
      container.querySelector('[data-testid="pairing-expiry-req-2"]')?.textContent
    expect(expiry()).toContain('01:35')
    await act(async () => vi.advanceTimersByTime(1_000))
    expect(expiry()).toContain('01:34')
    await act(async () => vi.advanceTimersByTime(94_000))
    expect(expiry()).toContain('Code expired')
    await act(async () => root.render(null))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('confirms a 180-day trust approval with a toast naming the browser', async () => {
    const api = await mount(snapshotWithPairing())
    const trust = [...container.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Trust this browser for 180 days'
    )
    await act(async () => trust!.click())
    expect(api.approve).toHaveBeenCalledExactlyOnceWith({ requestId: 'req-1', decision: 'always' })
    expect(container.querySelector('[data-testid="remote-trust-toast"]')?.textContent).toContain(
      'Chrome · macOS trusted for 180 days.'
    )
  })

  it.each([false, true])(
    'gives each trust confirmation its own five seconds (same label: %s)',
    async (sameLabel) => {
      vi.useFakeTimers()
      const snapshot = snapshotWithPairing()
      if (sameLabel) {
        snapshot.pendingRequests[1].browser = snapshot.pendingRequests[0].browser
        snapshot.pendingRequests[1].platform = snapshot.pendingRequests[0].platform
      }
      const api = await mount(snapshot)
      api.approve.mockResolvedValueOnce({
        ...snapshot,
        pendingRequests: snapshot.pendingRequests.slice(1)
      })
      api.approve.mockResolvedValueOnce({ ...snapshot, pendingRequests: [] })
      const approveNext = async (): Promise<void> => {
        const button = [...container.querySelectorAll('button')].find(
          (entry) => entry.textContent?.trim() === 'Trust this browser for 180 days'
        )!
        await act(async () => button.click())
      }
      await approveNext()
      await act(async () => vi.advanceTimersByTime(4_900))
      await approveNext()
      await act(async () => vi.advanceTimersByTime(100))
      expect(container.querySelector('[data-testid="remote-trust-toast"]')).not.toBeNull()
      await act(async () => vi.advanceTimersByTime(4_899))
      expect(container.querySelector('[data-testid="remote-trust-toast"]')).not.toBeNull()
      await act(async () => vi.advanceTimersByTime(1))
      expect(container.querySelector('[data-testid="remote-trust-toast"]')).toBeNull()
    }
  )
})
