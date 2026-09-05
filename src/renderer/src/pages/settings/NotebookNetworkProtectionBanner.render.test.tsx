// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { NotebookNetworkProtectionBanner } from './NotebookNetworkProtectionBanner'

let container: HTMLDivElement
let root: Root

const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
  })
}

beforeEach(() => {
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

    expect(container.textContent).toContain('Network protection on')
    expect(container.textContent).toContain(
      'Notebook sessions and package downloads can access only approved domains.'
    )
    expect(
      container.querySelector('[data-testid="notebook-network-protection-banner"]')?.className
    ).toContain('bg-bg-10')

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button')?.click()
    })
    expect(onOpen).toHaveBeenCalledOnce()
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
    expect(container.textContent).toContain('Network protection on')
    vi.useRealTimers()
  })
})
