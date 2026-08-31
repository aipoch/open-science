// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_NOTEBOOK_NETWORK_SETTINGS } from '../../../../shared/notebook-network'
import { useSettingsStore } from '@/stores/settings-store'
import { NotebookNetworkDomainsForm } from './NotebookNetworkDomainsForm'

let container: HTMLDivElement
let root: Root

const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
  })
}

const button = (label: string): HTMLButtonElement =>
  [...container.querySelectorAll('button')].find((element) =>
    element.textContent?.includes(label)
  ) as HTMLButtonElement

const typeInput = async (input: HTMLInputElement, value: string): Promise<void> => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useSettingsStore.setState({
    notebookNetwork: DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
    setNotebookNetwork: vi.fn(async (settings) => settings)
  })
  ;(window as unknown as { api: unknown }).api = {
    platform: 'darwin',
    settings: {
      getNotebookNetworkStatus: vi.fn().mockResolvedValue({ kind: 'ready', warnings: [] }),
      installNotebookNetwork: vi.fn(),
      removeNotebookNetwork: vi.fn()
    }
  }
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  delete (window as unknown as { api?: unknown }).api
})

describe('NotebookNetworkDomainsForm', () => {
  it('locks package registries and validates, adds, removes, and saves custom domains', async () => {
    await act(async () => root.render(<NotebookNetworkDomainsForm />))
    await flush()

    const packageGroup = container.querySelector(
      '[aria-label="Allow Package registries and source code"]'
    ) as HTMLButtonElement
    expect(packageGroup.disabled).toBe(true)
    expect(
      (container.querySelector('[aria-label="Allow pypi.org"]') as HTMLButtonElement).disabled
    ).toBe(true)

    const input = container.querySelector('[aria-label="Domain hostname"]') as HTMLInputElement
    await typeInput(input, 'https://data.example.org/path')
    await act(async () => button('Add').click())
    expect(container.textContent).toContain(
      'Enter a hostname only, without a scheme, path, port, or wildcard.'
    )

    await typeInput(input, 'data.example.org')
    await act(async () => button('Add').click())
    expect(container.textContent).toContain('data.example.org')

    await act(async () => button('Save changes').click())
    expect(useSettingsStore.getState().setNotebookNetwork).toHaveBeenCalledWith(
      expect.objectContaining({ allowedDomains: ['data.example.org'] }),
      []
    )
  })

  it('keeps a domain approved while the settings form was open', async () => {
    const save = vi.fn(async (settings: typeof DEFAULT_NOTEBOOK_NETWORK_SETTINGS) => ({
      ...settings,
      allowedDomains: ['approved.example.org']
    }))
    useSettingsStore.setState({ setNotebookNetwork: save })
    await act(async () => root.render(<NotebookNetworkDomainsForm />))
    await flush()

    await act(async () => button('Save changes').click())

    expect(save).toHaveBeenCalledWith(DEFAULT_NOTEBOOK_NETWORK_SETTINGS, [])
    expect(container.textContent).toContain('approved.example.org')
  })

  it('shows localized status codes and applies successful Windows setup status', async () => {
    const getStatus = vi
      .fn()
      .mockResolvedValueOnce({
        kind: 'setupRequired',
        platform: 'win32',
        reasons: ['windowsProfileMissing']
      })
      .mockResolvedValueOnce({ kind: 'ready', warnings: [] })
    const install = vi.fn().mockResolvedValue({ kind: 'ready', warnings: [] })
    ;(window as unknown as { api: unknown }).api = {
      platform: 'win32',
      settings: {
        getNotebookNetworkStatus: getStatus,
        installNotebookNetwork: install,
        removeNotebookNetwork: vi.fn()
      }
    }

    await act(async () => root.render(<NotebookNetworkDomainsForm />))
    await flush()
    expect(container.textContent).toContain('The Windows sandbox needs administrator setup.')

    await act(async () => button('Set up').click())
    expect(install).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('Status: Active')
  })

  it('keeps setup available when the Windows UAC prompt is cancelled', async () => {
    const setupRequired = {
      kind: 'setupRequired' as const,
      platform: 'win32' as const,
      reasons: ['windowsOwnershipMissing' as const]
    }
    ;(window as unknown as { api: unknown }).api = {
      platform: 'win32',
      settings: {
        getNotebookNetworkStatus: vi.fn().mockResolvedValue(setupRequired),
        installNotebookNetwork: vi.fn().mockResolvedValue(setupRequired),
        removeNotebookNetwork: vi.fn()
      }
    }

    await act(async () => root.render(<NotebookNetworkDomainsForm />))
    await flush()
    await act(async () => button('Set up').click())
    expect(container.textContent).toContain('The Windows sandbox needs administrator setup.')
    expect(button('Set up')).not.toBeUndefined()
  })

  it('returns to standard execution after removing Windows protection', async () => {
    const notSetUp = {
      kind: 'setupRequired' as const,
      platform: 'win32' as const,
      reasons: ['windowsProfileMissing' as const]
    }
    const remove = vi.fn().mockResolvedValue(notSetUp)
    ;(window as unknown as { api: unknown }).api = {
      platform: 'win32',
      settings: {
        getNotebookNetworkStatus: vi.fn().mockResolvedValue({ kind: 'ready', warnings: [] }),
        installNotebookNetwork: vi.fn(),
        removeNotebookNetwork: remove
      }
    }

    await act(async () => root.render(<NotebookNetworkDomainsForm />))
    await flush()
    await act(async () => button('Remove…').click())

    expect(remove).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('Status: Not set up')
    expect(container.textContent).toContain('standard execution')
  })

  it('shows translated generic copy when saving fails', async () => {
    useSettingsStore.setState({
      setNotebookNetwork: vi.fn().mockRejectedValue(new Error('C:\\private\\backend.txt'))
    })
    await act(async () => root.render(<NotebookNetworkDomainsForm />))
    await flush()
    await act(async () => button('Save changes').click())
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Could not save Notebook network access.'
    )
    expect(container.textContent).not.toContain('private')
  })

  it('does not expose backend error prose', async () => {
    ;(window as unknown as { api: unknown }).api = {
      platform: 'darwin',
      settings: {
        getNotebookNetworkStatus: vi.fn().mockRejectedValue(new Error('secret backend path')),
        installNotebookNetwork: vi.fn(),
        removeNotebookNetwork: vi.fn()
      }
    }
    await act(async () => root.render(<NotebookNetworkDomainsForm />))
    await flush()
    expect(container.textContent).toContain('Could not check Notebook network protection.')
    expect(container.textContent).not.toContain('secret backend path')
  })
})
