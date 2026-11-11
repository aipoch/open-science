// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { NotebookNetworkProtectionBanner } from './NotebookNetworkProtectionBanner'
import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'

let container: HTMLDivElement
let root: Root

const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
  })
}

beforeEach(() => {
  useSettingsStore.setState(createInitialSettingsState())
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  ;(window as unknown as { api: unknown }).api = {
    settings: {
      getNotebookNetworkStatus: vi.fn().mockResolvedValue({ kind: 'ready', warnings: [] })
    }
  }
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  delete (window as unknown as { api?: unknown }).api
})

describe('NotebookNetworkProtectionBanner', () => {
  it('shows the verified protection state and opens the existing settings route', async () => {
    const onOpen = vi.fn()
    await act(async () => root.render(<NotebookNetworkProtectionBanner onOpen={onOpen} />))
    await flush()

    expect(container.querySelector('h3')?.textContent).toBe('Notebook network access')
    expect(container.textContent).toContain('Relaxed mode')
    expect(container.textContent).toContain('HTTPS domains connect directly')
    expect(container.textContent).toContain('0 saved addresses')
    expect(container.querySelectorAll('li')).toHaveLength(3)
    expect(container.querySelector('button')?.textContent).toBe('Manage access')

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button')?.click()
    })
    expect(onOpen).toHaveBeenCalledOnce()
  })

  it('updates the runtime summary from the same saved strict rules and groups', async () => {
    await act(async () => root.render(<NotebookNetworkProtectionBanner onOpen={() => {}} />))
    await flush()
    await act(async () =>
      useSettingsStore.setState({
        notebookNetwork: {
          ...useSettingsStore.getState().notebookNetwork,
          mode: 'strict',
          strictWhitelist: [
            {
              id: 'one',
              protocol: 'https',
              hostnamePattern: 'example.org',
              port: 443,
              origin: 'manual'
            }
          ],
          strictWhitelistGroups: [{ id: 'research', name: 'Research' }]
        }
      })
    )
    expect(container.textContent).toContain('Strict mode')
    expect(container.textContent).toContain('Whitelist matches can connect')
    expect(container.textContent).toContain('1 rule · 1 group')
    expect(container.textContent).not.toContain('HTTPS domains connect directly')
  })

  it('keeps Windows standard execution available without claiming protection or requiring setup to run', async () => {
    const onOpen = vi.fn()
    window.api.settings.getNotebookNetworkStatus = vi.fn().mockResolvedValue({
      kind: 'setupRequired',
      platform: 'win32',
      reasons: ['windowsProfileMissing']
    })
    await act(async () => root.render(<NotebookNetworkProtectionBanner onOpen={onOpen} />))
    await flush()

    expect(container.textContent).toContain('Notebook network protection is not set up.')
    expect(container.textContent).toContain(
      'Notebook continues using standard execution. No protected mode is active.'
    )
    expect(container.textContent).not.toContain('before notebooks can run')
    expect(container.textContent).not.toContain('Network protection on')

    const button = container.querySelector<HTMLButtonElement>('button')
    expect(button?.textContent).toBe('Network settings')
    expect(button?.disabled).toBe(false)
    await act(async () => button?.click())
    expect(onOpen).toHaveBeenCalledOnce()
  })

  it('requires setup before Linux notebooks can run when bubblewrap is missing', async () => {
    window.api.settings.getNotebookNetworkStatus = vi.fn().mockResolvedValue({
      kind: 'setupRequired',
      platform: 'linux',
      reasons: ['linuxBubblewrapMissing']
    })
    await act(async () => root.render(<NotebookNetworkProtectionBanner onOpen={() => undefined} />))
    await flush()

    expect(container.textContent).toContain(
      'Notebook network protection needs setup before notebooks can run.'
    )
    expect(container.textContent).not.toContain('Notebook continues using standard execution.')
    expect(container.textContent).not.toContain('Network protection on')
  })

  it('uses a generic, actionable message when the status check fails', async () => {
    window.api.settings.getNotebookNetworkStatus = vi.fn().mockRejectedValue(new Error('private'))
    await act(async () => root.render(<NotebookNetworkProtectionBanner onOpen={() => undefined} />))
    await flush()

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Could not check Notebook network protection.'
    )
    expect(container.textContent).not.toContain('private')
  })

  it('fails safely when the status method is unavailable', async () => {
    ;(
      window.api.settings as unknown as {
        getNotebookNetworkStatus?: typeof window.api.settings.getNotebookNetworkStatus
      }
    ).getNotebookNetworkStatus = undefined

    await act(async () => root.render(<NotebookNetworkProtectionBanner onOpen={() => undefined} />))
    await flush()

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Could not check Notebook network protection.'
    )
  })

  it('refreshes a checking status until initialization finishes', async () => {
    vi.useFakeTimers()
    const getStatus = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'checking' })
      .mockResolvedValueOnce({ kind: 'ready', warnings: [] })
    window.api.settings.getNotebookNetworkStatus = getStatus

    await act(async () => root.render(<NotebookNetworkProtectionBanner onOpen={() => undefined} />))
    await flush()
    expect(container.textContent).toContain('Checking…')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })

    expect(getStatus).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('Notebook network access')
    vi.useRealTimers()
  })
})
