// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { i18next } from '@/i18n'
import type { LabView } from '../../../../shared/lab'
import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'
import { LabPanel } from './LabPanel'

let container: HTMLDivElement
let root: Root

const settingsApi = {
  labSetServer: vi.fn(),
  labCheck: vi.fn(),
  labBeginLogin: vi.fn(),
  labWaitLogin: vi.fn(),
  labCancelLogin: vi.fn(),
  labRefresh: vi.fn(),
  labLogout: vi.fn()
}

const renderPanel = async (lab: LabView | undefined): Promise<void> => {
  useSettingsStore.setState({ ...createInitialSettingsState(), lab })
  await act(async () => root.render(<LabPanel />))
}

const buttonWithText = (label: string): HTMLButtonElement | undefined =>
  [...container.querySelectorAll('button')].find((button) => button.textContent === label)

const changeInput = (value: string): void => {
  const input = container.querySelector('input[aria-label="Lab server address"]')
  expect(input).toBeInstanceOf(HTMLInputElement)
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input!.dispatchEvent(new Event('input', { bubbles: true }))
}

const click = async (label: string): Promise<void> => {
  const button = buttonWithText(label)
  expect(button, label).toBeDefined()
  await act(async () => button!.click())
}

beforeEach(async () => {
  vi.clearAllMocks()
  await i18next.changeLanguage('en')
  settingsApi.labSetServer.mockResolvedValue({ state: 'signedOut' })
  settingsApi.labCheck.mockResolvedValue({ state: 'signedOut' })
  settingsApi.labBeginLogin.mockResolvedValue({
    authorizationUrl: 'https://lab.example.com/sign-in',
    expiresAt: Date.now() + 60_000
  })
  settingsApi.labWaitLogin.mockResolvedValue({ state: 'authenticated' })
  settingsApi.labCancelLogin.mockResolvedValue({ state: 'signedOut' })
  settingsApi.labRefresh.mockResolvedValue({ state: 'authenticated' })
  settingsApi.labLogout.mockResolvedValue({ state: 'signedOut' })
  window.api = { settings: settingsApi } as unknown as Window['api']
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  delete (window as unknown as { api?: unknown }).api
  vi.unstubAllGlobals()
})

describe('Lab settings panel', () => {
  it('renders the unconfigured state without calling the API', async () => {
    await renderPanel({ state: 'unconfigured' })

    expect(container.querySelector('[data-settings-anchor="lab.connection"]')).not.toBeNull()
    expect(container.textContent).toContain('Not configured')
    expect(container.textContent).toContain('Enter a Lab server address.')
    for (const method of Object.values(settingsApi)) expect(method).not.toHaveBeenCalled()
  })

  it('starts sign-in and waits for the browser callback', async () => {
    let resolveWait: ((view: LabView) => void) | undefined
    settingsApi.labWaitLogin.mockImplementation(
      () =>
        new Promise<LabView>((resolve) => {
          resolveWait = resolve
        })
    )
    await renderPanel({ state: 'signedOut', serverUrl: 'https://lab.example.com' })

    expect(container.textContent).toContain('Not signed in')
    await click('Sign in with browser')

    expect(settingsApi.labBeginLogin).toHaveBeenCalledTimes(1)
    expect(settingsApi.labWaitLogin).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('Waiting for browser confirmation…')
    expect(container.textContent).toContain('Open the sign-in page again')
    const link = container.querySelector('a')
    expect(link?.getAttribute('href')).toBe('https://lab.example.com/sign-in')
    expect(link?.getAttribute('target')).toBe('_blank')
    expect(link?.getAttribute('rel')).toBe('noreferrer')

    await act(async () => resolveWait?.({ state: 'authenticated' }))
  })

  it('shows the signed-in account, device, and models', async () => {
    await renderPanel({
      state: 'authenticated',
      accountName: 'Ada Lovelace',
      deviceName: 'MacBook Pro',
      modelCount: 2,
      models: [
        {
          id: 'lab:model-a',
          name: 'Model A',
          protocols: ['chat-completions'],
          streaming: true
        },
        { id: 'lab:model-b', name: 'Model B', protocols: ['responses'], streaming: false }
      ]
    })

    expect(container.textContent).toContain('Signed in as Ada Lovelace')
    expect(container.textContent).toContain('Device: MacBook Pro')
    expect(container.textContent).toContain('Model A')
    expect(container.textContent).toContain('Chat Completions')
    expect(container.textContent).toContain('Model B')
    expect(container.textContent).toContain('Responses')
    expect(container.textContent).toContain('Non-streaming')
  })

  it('shows token and organization usage in the authenticated panel', async () => {
    await renderPanel({
      state: 'authenticated',
      accountName: 'Ada Lovelace',
      deviceName: 'MacBook Pro',
      modelCount: 0,
      models: [],
      usage: {
        available: true,
        token: {
          available: true,
          status: 'active',
          quota: { limit: 500_000, used: 165_900, remaining: 334_100, unlimited: false }
        },
        org: {
          available: true,
          unlimited: false,
          quota: { limit: 69_349_151, used: 166_271, remaining: 69_268_880, unlimited: false },
          stale: false
        },
        effective: { remaining: 334_100, limitedBy: 'token' },
        display: {
          perUnit: 500_000,
          exchangeRate: 7.3,
          currency: 'CNY',
          cny: {
            token: { limit: 7.3, used: 2.42, remaining: 4.88 },
            org: { limit: 1_012.3, used: 2.43, remaining: 1_009.87 }
          },
          usd: {
            token: { limit: 1, used: 0.3318, remaining: 0.6682 },
            org: { limit: 138.7, used: 0.33, remaining: 138.37 }
          }
        },
        stale: false
      }
    })

    expect(container.textContent).toContain('Usage')
    expect(container.textContent).toContain('Access token quota')
    expect(container.textContent).toContain('¥4.88 / ¥7.30')
    expect(container.textContent).not.toContain('Organization wallet')
    expect(container.querySelector('dl > :last-child dd')?.textContent).toBe('¥4.88')
    await click('Refresh models')
    expect(settingsApi.labRefresh).toHaveBeenCalledTimes(1)
  })

  it('shows the blocked reason and retries the connection check', async () => {
    await renderPanel({
      state: 'blocked',
      serverUrl: 'https://lab.example.com',
      error: { code: 'seat-required' }
    })

    expect(container.textContent).toContain('Lab access blocked')
    expect(container.textContent).toContain('A Lab seat is required for this account.')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'A Lab seat is required for this account.'
    )

    await click('Retry')
    expect(settingsApi.labCheck).toHaveBeenCalledTimes(1)
  })

  it('tests the draft address without saving the deployment', async () => {
    await renderPanel({ state: 'signedOut', serverUrl: 'https://lab.example.com' })
    const input = container.querySelector('input[aria-label="Lab server address"]')
    expect(input).toBeInstanceOf(HTMLInputElement)
    changeInput('https://draft.example.com')

    await click('Test connection')
    expect(settingsApi.labCheck).toHaveBeenCalledWith({ serverUrl: 'https://draft.example.com' })
    expect(settingsApi.labSetServer).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Lab server address is reachable.')
  })

  it('fills the saved address when it arrives after the panel mounted', async () => {
    await renderPanel({ state: 'unconfigured' })
    expect(container.querySelector('input[aria-label="Lab server address"]')).toHaveProperty(
      'value',
      ''
    )
    await renderPanel({ state: 'signedOut', serverUrl: 'https://late.example.com' })
    expect(container.querySelector('input[aria-label="Lab server address"]')).toHaveProperty(
      'value',
      'https://late.example.com'
    )
  })

  it('does not show a success result for an empty draft address', async () => {
    await renderPanel({ state: 'signedOut', serverUrl: 'https://lab.example.com' })
    settingsApi.labCheck.mockResolvedValueOnce({
      state: 'signedOut',
      error: { code: 'server-url-missing' }
    })
    changeInput('')

    await click('Test connection')
    expect(settingsApi.labCheck).toHaveBeenCalledWith({ serverUrl: '' })
    expect(container.textContent).not.toContain('Lab server address is reachable.')
  })

  it('drops a probe error when the input changes while it is in flight', async () => {
    await renderPanel({ state: 'signedOut', serverUrl: 'https://lab.example.com' })
    let rejectCheck: ((error: unknown) => void) | undefined
    settingsApi.labCheck.mockImplementation(
      () =>
        new Promise<LabView>((_resolve, reject) => {
          rejectCheck = reject
        })
    )
    const button = buttonWithText('Test connection')
    await act(async () => button!.click())
    changeInput('https://other.example.com')
    await act(async () => rejectCheck?.(new Error('local config read failed')))
    expect(container.textContent).not.toContain('The Lab server rejected the request.')
  })

  it('drops a probe result when the input changes while it is in flight', async () => {
    await renderPanel({ state: 'signedOut', serverUrl: 'https://lab.example.com' })
    let resolveCheck: ((view: LabView) => void) | undefined
    settingsApi.labCheck.mockImplementation(
      () =>
        new Promise<LabView>((resolve) => {
          resolveCheck = resolve
        })
    )
    const button = buttonWithText('Test connection')
    await act(async () => button!.click())
    changeInput('https://other.example.com')
    await act(async () => resolveCheck?.({ state: 'signedOut' }))
    expect(container.textContent).not.toContain('Lab server address is reachable.')
  })

  it('shows the browser wait state and cancels the attempt', async () => {
    await renderPanel({ state: 'signingIn', serverUrl: 'https://lab.example.com' })

    expect(container.textContent).toContain('Waiting for browser confirmation…')
    settingsApi.labCancelLogin.mockImplementationOnce(async () => {
      const view = { state: 'signedOut', serverUrl: 'https://lab.example.com' } satisfies LabView
      useSettingsStore.setState({ lab: view })
      return view
    })
    await click('Cancel sign-in')
    expect(settingsApi.labCancelLogin).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(buttonWithText('Sign in with browser'))
  })

  it('never opens a blocking alert or dialog', async () => {
    const alert = vi.fn()
    vi.stubGlobal('alert', alert)
    await renderPanel({ state: 'signedOut', serverUrl: 'https://lab.example.com' })

    await click('Sign in with browser')

    expect(alert).not.toHaveBeenCalled()
    expect(document.querySelector('[role="dialog"], [role="alertdialog"]')).toBeNull()
  })
})
