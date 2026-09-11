// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'
import { ConnectorCredentialControls, ConnectorCredentialDialog } from './ConnectorCredentialDialog'
import { CredentialRequestBroker } from '../../../../main/connectors/credential-request-broker'

let container: HTMLDivElement
let root: Root

const button = (label: string): HTMLButtonElement | undefined =>
  Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
    (candidate) => candidate.textContent?.trim() === label
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

    expect(useSettingsStore.getState().validateOpenAlexCredential).toHaveBeenCalledWith({
      apiKey: 'openalex-valid-key'
    })
    expect(useSettingsStore.getState().setOpenAlexCredential).toHaveBeenCalledWith({
      apiKey: 'openalex-valid-key'
    })
    expect(useSettingsStore.getState().respondCredentialRequest).toHaveBeenCalledWith(
      'credential-1',
      true
    )
  })

  it('keeps the call parked when OpenAlex rejects the candidate', async () => {
    useSettingsStore.setState({
      validateOpenAlexCredential: vi.fn().mockResolvedValue({
        valid: false,
        reason: 'rejected'
      })
    })
    act(() => root.render(<ConnectorCredentialDialog />))
    enterKey('openalex-rejected-key')

    await act(async () => button('Save key')?.click())
    await flush()

    expect(document.body.textContent).toContain('OpenAlex rejected this API key.')
    expect(useSettingsStore.getState().setOpenAlexCredential).not.toHaveBeenCalled()
    expect(useSettingsStore.getState().respondCredentialRequest).not.toHaveBeenCalled()
  })
})
