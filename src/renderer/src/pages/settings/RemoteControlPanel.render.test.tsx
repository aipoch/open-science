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
  Record<'getSnapshot' | 'probe' | 'detect' | 'setMode' | 'onChanged', ReturnType<typeof vi.fn>>
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
    onChanged: vi.fn(() => vi.fn())
  }
  Object.defineProperty(window, 'api', { configurable: true, value: { remoteAccess: api } })
  await act(async () => root.render(<RemoteControlPanel />))
  expect(api.probe).toHaveBeenCalledOnce()
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
