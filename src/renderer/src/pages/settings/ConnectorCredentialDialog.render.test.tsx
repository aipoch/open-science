// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'
import { ConnectorCredentialControls, ConnectorCredentialDialog } from './ConnectorCredentialDialog'
import { CredentialRequestBroker } from '../../../../main/connectors/credential-request-broker'

const realRespondCredentialRequest = useSettingsStore.getState().respondCredentialRequest

let container: HTMLDivElement
let root: Root

const button = (label: string): HTMLButtonElement | undefined =>
  Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
    (candidate) => (candidate.getAttribute('aria-label') ?? candidate.textContent?.trim()) === label
  )

const enterKey = (value: string): void => {
  const field = document.body.querySelector<HTMLInputElement>('[role="dialog"] input')
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', {
    value: { getData: vi.fn(() => value), setData: vi.fn() }
  })
  act(() => {
    field?.dispatchEvent(event)
  })
}

const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  window.api = {
    settings: {
      validateOpenAlexCredential: vi.fn().mockResolvedValue({ valid: true }),
      setOpenAlexCredential: vi.fn().mockResolvedValue({
        connectors: [],
        customServers: [],
        ncbi: { hasApiKey: false },
        openAlex: { hasApiKey: true }
      }),
      respondConnectorCredentialRequest: vi.fn().mockResolvedValue(undefined)
    }
  } as unknown as Window['api']

  useSettingsStore.setState({
    ...createInitialSettingsState(),
    pendingCredentialRequests: [
      {
        id: 'credential-1',
        credentialId: 'openalex',
        connector: 'literature',
        method: 'openalex_search_works'
      }
    ],
    encryptionAvailable: true,
    validateOpenAlexCredential: vi.fn().mockResolvedValue({ valid: true }),
    setOpenAlexCredential: vi.fn().mockResolvedValue(undefined),
    respondCredentialRequest: vi.fn().mockResolvedValue(undefined)
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

describe('ConnectorCredentialDialog', () => {
  it.each([false, true])(
    'offers a key link without settling the request (embedded: %s)',
    (embedded) => {
      const request = useSettingsStore.getState().pendingCredentialRequests[0]
      act(() =>
        root.render(
          embedded ? (
            <ConnectorCredentialControls request={request} embedded />
          ) : (
            <ConnectorCredentialDialog />
          )
        )
      )
      const link = document.body.querySelector<HTMLAnchorElement>('a')!
      expect(link.textContent).toBe('Get an API key')
      expect(link.href).toBe('https://openalex.org/settings/api')
      expect(link.target).toBe('_blank')
      expect(link.rel).toBe('noreferrer')
      link.addEventListener('click', (event) => event.preventDefault())
      act(() => link.click())
      expect(useSettingsStore.getState().respondCredentialRequest).not.toHaveBeenCalled()
      expect(window.api.settings.setOpenAlexCredential).not.toHaveBeenCalled()
      expect(
        document.body.querySelector('[data-testid="connector-credential-controls"]')
      ).not.toBeNull()
    }
  )

  it('closes queued credential dialogs after one Not now response', async () => {
    let sequence = 0
    const broker = new CredentialRequestBroker({
      generateId: () => `queued-${++sequence}`,
      broadcast: (request) => useSettingsStore.getState().enqueueCredentialRequest(request),
      onSettled: (id) => useSettingsStore.getState().dismissCredentialRequest(id)
    })
    useSettingsStore.setState({
      pendingCredentialRequests: [],
      respondCredentialRequest: async (id, configured) => broker.respond(id, configured)
    })
    const info = {
      credentialId: 'openalex' as const,
      connector: 'literature',
      method: 'openalex_search_works'
    }
    const first = broker.request(info)
    const second = broker.request({ ...info, method: 'openalex_get_work' })
    try {
      act(() => root.render(<ConnectorCredentialDialog />))
      expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()
      await act(async () => button('Not now')?.click())
      await flush()
      expect(document.body.querySelector('[role="dialog"]')).toBeNull()
      await expect(Promise.all([first, second])).resolves.toEqual([false, false])
    } finally {
      act(() => broker.cancelAll())
    }
  })

  it('keeps concurrent embedded and fallback fields uniquely labelled', () => {
    act(() =>
      root.render(
        <>
          <ConnectorCredentialControls
            embedded
            request={{
              id: 'credential-session',
              credentialId: 'openalex',
              connector: 'literature',
              method: 'openalex_search_works',
              sessionId: 'session-1'
            }}
          />
          <ConnectorCredentialDialog />
        </>
      )
    )

    const fields = Array.from(document.body.querySelectorAll<HTMLInputElement>('input'))
    const labels = Array.from(document.body.querySelectorAll<HTMLLabelElement>('label'))

    expect(fields).toHaveLength(2)
    expect(new Set(fields.map((field) => field.id))).toHaveProperty('size', 2)
    expect(fields.every((field) => labels.some((label) => label.htmlFor === field.id))).toBe(true)
  })

  it('leaves Session requests for the Composer lane', () => {
    useSettingsStore.setState({
      pendingCredentialRequests: [
        {
          id: 'credential-1',
          credentialId: 'openalex',
          connector: 'literature',
          method: 'openalex_search_works',
          sessionId: 'session-1'
        }
      ]
    })

    act(() => root.render(<ConnectorCredentialDialog />))

    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(document.body.querySelector('[data-testid="connector-credential-controls"]')).toBeNull()
  })

  it('validates, persists, and resumes the exact parked call', async () => {
    act(() => root.render(<ConnectorCredentialDialog />))
    enterKey('openalex-valid-key')

    await act(async () => button('Save key')?.click())
    await flush()

    expect(window.api.settings.validateOpenAlexCredential).toHaveBeenCalledWith({
      apiKey: 'openalex-valid-key'
    })
    expect(window.api.settings.setOpenAlexCredential).toHaveBeenCalledWith({
      apiKey: 'openalex-valid-key'
    })
    expect(window.api.settings.respondConnectorCredentialRequest).toHaveBeenCalledWith({
      id: 'credential-1',
      configured: true
    })
  })

  it('keeps the call parked when OpenAlex rejects the candidate', async () => {
    vi.mocked(window.api.settings.validateOpenAlexCredential).mockResolvedValue({
      valid: false,
      reason: 'rejected'
    })
    act(() => root.render(<ConnectorCredentialDialog />))
    enterKey('openalex-rejected-key')

    await act(async () => button('Save key')?.click())
    await flush()

    expect(document.body.textContent).toContain('OpenAlex rejected this API key.')
    expect(window.api.settings.setOpenAlexCredential).not.toHaveBeenCalled()
    expect(useSettingsStore.getState().respondCredentialRequest).not.toHaveBeenCalled()
  })
})

it.each(['button', 'escape'] as const)(
  'closes without reminders after failures via %s and ignores replay',
  async (via) => {
    const pending = useSettingsStore.getState().pendingCredentialRequests[0]
    const response = vi.fn().mockRejectedValue(new Error('IPC unavailable'))
    window.api = {
      settings: { respondConnectorCredentialRequest: response }
    } as unknown as Window['api']
    useSettingsStore.setState({
      pendingCredentialRequests: [pending],
      respondCredentialRequest: realRespondCredentialRequest
    })
    act(() => root.render(<ConnectorCredentialDialog />))
    for (let i = 0; i < 3; i++) await act(async () => button('Not now')!.click())
    await act(async () => {
      if (via === 'button') button('Close')!.click()
      else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(response).toHaveBeenLastCalledWith({ id: pending.id, configured: false })
    expect(response).toHaveBeenCalledTimes(4)
    expect(useSettingsStore.getState().pendingCredentialRequests[0].closed).toBe(true)
    act(() => {
      useSettingsStore.getState().enqueueCredentialRequest(pending)
      root.render(<ConnectorCredentialDialog />)
    })
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(document.body.querySelector('[role="alert"]')).toBeNull()
    expect(button('Review')).toBeUndefined()
    expect(useSettingsStore.getState().pendingCredentialRequests).toHaveLength(1)
    act(() => useSettingsStore.getState().closeCredentialRequest(pending.id))
    expect(response).toHaveBeenCalledTimes(4)
    act(() => useSettingsStore.getState().dismissCredentialRequest(pending.id))
    expect(useSettingsStore.getState().pendingCredentialRequests).toHaveLength(0)
  }
)
it.each([
  'validateOpenAlexCredential',
  'setOpenAlexCredential',
  'respondConnectorCredentialRequest'
] as const)(
  'closes hanging credential %s without a reminder or duplicate operation',
  async (commandName) => {
    let reject!: (error: Error) => void
    const command = vi.fn(
      () =>
        new Promise<never>((_, fail) => {
          reject = fail
        })
    )
    window.api.settings[commandName] = command
    useSettingsStore.setState({ respondCredentialRequest: realRespondCredentialRequest })
    act(() => root.render(<ConnectorCredentialDialog />))
    enterKey('openalex-valid-key')
    await act(async () => button('Save key')!.click())
    act(() => button('Close')!.click())
    act(() => root.render(null))
    act(() => root.render(<ConnectorCredentialDialog />))
    await useSettingsStore.getState().configureCredentialRequest('credential-1', 'another-key')
    await useSettingsStore.getState().respondCredentialRequest('credential-1', false)
    expect(command).toHaveBeenCalledTimes(1)
    await act(async () => reject(new Error('Late transport failure')))
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(document.body.querySelector('[role="alert"]')).toBeNull()
    expect(button('Review')).toBeUndefined()
  }
)
it('does not save credentials after their pending request settles during validation', async () => {
  let resolve!: (value: { valid: true }) => void
  window.api.settings.validateOpenAlexCredential = vi.fn(
    () =>
      new Promise<{ valid: true }>((done) => {
        resolve = done
      })
  )
  act(() => root.render(<ConnectorCredentialDialog />))
  enterKey('openalex-valid-key')
  act(() => button('Save key')!.click())
  act(() => useSettingsStore.getState().dismissCredentialRequest('credential-1'))
  await act(async () => resolve({ valid: true }))
  expect(window.api.settings.setOpenAlexCredential).not.toHaveBeenCalled()
  expect(useSettingsStore.getState().pendingCredentialRequests).toHaveLength(0)
})

it('closes an idle request immediately and sends one cancellation through the real store', async () => {
  const pending = useSettingsStore.getState().pendingCredentialRequests[0]
  const command = vi.fn().mockResolvedValue(undefined)
  window.api = {
    settings: { respondConnectorCredentialRequest: command }
  } as unknown as Window['api']
  useSettingsStore.setState({
    pendingCredentialRequests: [pending],
    respondCredentialRequest: realRespondCredentialRequest
  })
  act(() => root.render(<ConnectorCredentialDialog />))
  await act(async () => button('Close')!.click())
  expect(command).toHaveBeenCalledExactlyOnceWith({ id: pending.id, configured: false })
  expect(useSettingsStore.getState().pendingCredentialRequests).toEqual([])
  expect(document.body.querySelector('[role="dialog"]')).toBeNull()
})

it.each(['validation', 'storage'] as const)(
  'closing during %s stops later configuration and declines the agent request',
  async (stage) => {
    let finish!: () => void
    const gate = new Promise<void>((resolve) => {
      finish = resolve
    })
    if (stage === 'validation') {
      window.api.settings.validateOpenAlexCredential = vi.fn(async () => {
        await gate
        return { valid: true as const }
      })
    } else {
      const snapshot = {
        connectors: [],
        customServers: [],
        ncbi: { hasApiKey: false },
        openAlex: { hasApiKey: true }
      }
      window.api.settings.setOpenAlexCredential = vi.fn(async () => {
        await gate
        return snapshot
      })
    }
    useSettingsStore.setState({ respondCredentialRequest: realRespondCredentialRequest })
    act(() => root.render(<ConnectorCredentialDialog />))
    enterKey('openalex-valid-key')
    await act(async () => button('Save key')!.click())
    act(() => button('Close')!.click())
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    await act(async () => finish())
    expect(window.api.settings.setOpenAlexCredential).toHaveBeenCalledTimes(
      stage === 'validation' ? 0 : 1
    )
    expect(window.api.settings.respondConnectorCredentialRequest).toHaveBeenCalledExactlyOnceWith({
      id: 'credential-1',
      configured: false
    })
    expect(useSettingsStore.getState().pendingCredentialRequests).toEqual([])
  }
)

it('does not retry a failed cancellation or restart configuration after close', async () => {
  let finish!: () => void
  const gate = new Promise<void>((resolve) => {
    finish = resolve
  })
  window.api.settings.validateOpenAlexCredential = vi.fn(async () => {
    await gate
    return { valid: true as const }
  })
  window.api.settings.respondConnectorCredentialRequest = vi
    .fn()
    .mockRejectedValue(new Error('offline'))
  useSettingsStore.setState({ respondCredentialRequest: realRespondCredentialRequest })
  act(() => root.render(<ConnectorCredentialDialog />))
  enterKey('openalex-valid-key')
  await act(async () => button('Save key')!.click())
  act(() => button('Close')!.click())
  await act(async () => finish())
  await useSettingsStore.getState().configureCredentialRequest('credential-1', 'another-key')
  expect(window.api.settings.validateOpenAlexCredential).toHaveBeenCalledTimes(1)
  expect(window.api.settings.setOpenAlexCredential).not.toHaveBeenCalled()
  expect(window.api.settings.respondConnectorCredentialRequest).toHaveBeenCalledExactlyOnceWith({
    id: 'credential-1',
    configured: false
  })
  expect(useSettingsStore.getState().pendingCredentialRequests[0].closed).toBe(true)
  expect(document.body.querySelector('[role="dialog"]')).toBeNull()
})
