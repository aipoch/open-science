// @vitest-environment jsdom
import { act } from 'react'
import { WEB_CALLER_LOCATION_ATTRIBUTE } from '../../../../shared/web-caller-location'
import { fireEvent, screen, within } from '@testing-library/react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'
import { CredentialsPanel } from './CredentialsPanel'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  useSettingsStore.setState({
    ...createInitialSettingsState(),
    customServers: [
      {
        id: 'custom-search',
        name: 'custom-search',
        displayName: 'Custom Search',
        transport: 'streamable_http',
        enabled: true,
        url: 'https://mcp.example.test',
        hasHeaders: true
      }
    ],
    loadConnectors: vi.fn().mockResolvedValue(undefined)
  })
  ;(window as unknown as { api: unknown }).api = {
    settings: {
      getGitHubTokenStatus: vi.fn().mockResolvedValue({ configured: false })
    }
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  delete (window as unknown as { api?: unknown }).api
})

describe('CredentialsPanel', () => {
  it.each([
    ['semantic-scholar', 'https://www.semanticscholar.org/product/api'],
    ['openalex', 'https://openalex.org/settings/api'],
    ['literature', 'https://account.ncbi.nlm.nih.gov/settings/']
  ] as const)('links to the official key page for %s', async (serviceId, href) => {
    await act(async () =>
      root.render(
        <CredentialsPanel
          view={{ kind: 'service', serviceId }}
          onNavigate={vi.fn()}
          onOpenConnector={vi.fn()}
          onOpenProvider={vi.fn()}
        />
      )
    )
    const link = screen.getByRole('link', { name: 'Get an API key' })
    expect(link.getAttribute('href')).toBe(href)
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noreferrer')
  })

  it('opens Unpaywall from Credentials and edits the same shared contact email', async () => {
    const onNavigate = vi.fn()
    const onLeaveStateChange = vi.fn()
    const save = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      ncbi: { hasApiKey: true, contactEmail: 'research@lab.org' },
      setNcbiCredentials: save
    })
    const props = {
      onNavigate,
      onLeaveStateChange,
      onOpenConnector: vi.fn(),
      onOpenProvider: vi.fn()
    }
    await act(async () => root.render(<CredentialsPanel {...props} view={{ kind: 'list' }} />))
    const row = screen.getByText('Unpaywall').parentElement?.parentElement
    const manage = row?.querySelector('button')
    expect(manage).not.toBeNull()
    act(() => manage?.click())
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'service', serviceId: 'unpaywall' })
    await act(async () =>
      root.render(
        <CredentialsPanel {...props} view={{ kind: 'service', serviceId: 'unpaywall' }} />
      )
    )
    expect(screen.getByLabelText('Contact email')).toHaveProperty('value', 'research@lab.org')
    expect(onLeaveStateChange).toHaveBeenLastCalledWith({ dirty: false, busy: false })
    fireEvent.change(screen.getByLabelText('Contact email'), {
      target: { value: 'updated@lab.org' }
    })
    expect(onLeaveStateChange).toHaveBeenLastCalledWith({ dirty: true, busy: false })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })))
    expect(save).toHaveBeenCalledWith({ contactEmail: 'updated@lab.org' })
    expect(onLeaveStateChange).toHaveBeenCalledWith(null)
    expect(onLeaveStateChange).toHaveBeenLastCalledWith({ dirty: false, busy: false })
    expect(onNavigate).toHaveBeenLastCalledWith({ kind: 'list' })
  })

  it('keeps an Unpaywall draft protected after a failed save', async () => {
    let rejectSave: ((error: Error) => void) | undefined
    const onLeaveStateChange = vi.fn()
    useSettingsStore.setState({
      ncbi: { hasApiKey: false, contactEmail: 'research@lab.org' },
      setNcbiCredentials: vi.fn().mockImplementation(
        () =>
          new Promise((_, reject) => {
            rejectSave = reject
          })
      )
    })
    await act(async () =>
      root.render(
        <CredentialsPanel
          view={{ kind: 'service', serviceId: 'unpaywall' }}
          onNavigate={vi.fn()}
          onOpenConnector={vi.fn()}
          onOpenProvider={vi.fn()}
          onLeaveStateChange={onLeaveStateChange}
        />
      )
    )
    fireEvent.change(screen.getByLabelText('Contact email'), {
      target: { value: 'retry@lab.org' }
    })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })))
    expect(onLeaveStateChange).toHaveBeenLastCalledWith({ dirty: true, busy: true })

    await act(async () => rejectSave?.(new Error('Credential storage unavailable')))
    expect(onLeaveStateChange).toHaveBeenLastCalledWith({ dirty: true, busy: false })
    expect(screen.getByLabelText('Contact email')).toHaveProperty('value', 'retry@lab.org')
    expect(screen.getByRole('alert')).not.toBeNull()
  })

  it('lists device credentials and opens their shared credential editor', async () => {
    const onNavigate = vi.fn()
    useSettingsStore.setState({
      deviceCredentials: [
        {
          id: 'credential-1',
          displayName: 'Lab OAuth',
          kind: 'oauth',
          status: 'connected',
          needsSecret: false,
          resourceUri: 'https://mcp.example.test/',
          transport: 'streamable_http',
          consumerCount: 1,
          consumerNames: ['Custom Search'],
          createdAt: 1,
          updatedAt: 1
        }
      ],
      loadDeviceCredentials: vi.fn().mockResolvedValue(undefined)
    })

    await act(async () => {
      root.render(
        <CredentialsPanel
          view={{ kind: 'list' }}
          onNavigate={onNavigate}
          onOpenConnector={vi.fn()}
          onOpenProvider={vi.fn()}
        />
      )
      await Promise.resolve()
    })

    const label = Array.from(document.body.querySelectorAll<HTMLParagraphElement>('p')).find(
      (element) => element.textContent === 'Lab OAuth'
    )
    const row = label?.parentElement?.parentElement
    act(() =>
      Array.from(row?.querySelectorAll<HTMLButtonElement>('button') ?? [])
        .find((button) => button.textContent === 'Manage')
        ?.click()
    )

    expect(onNavigate).toHaveBeenCalledWith({ kind: 'credential', id: 'credential-1' })
    const remove = row?.querySelector<HTMLButtonElement>('[aria-label="Remove Lab OAuth"]')
    expect(remove?.disabled).toBe(false)
    expect(remove?.getAttribute('aria-disabled')).toBe('true')
  })

  it.each([
    [false, 'Temporarily unavailable'],
    [true, 'Replacement required']
  ])(
    'surfaces unreadable device credentials when secure storage availability is %s',
    async (encryptionAvailable, expectedStatus) => {
      useSettingsStore.setState({
        encryptionAvailable,
        deviceCredentials: [
          {
            id: 'credential-unreadable',
            displayName: 'Unreadable key',
            kind: 'api_key',
            status: 'stored',
            needsSecret: true,
            consumerCount: 0,
            consumerNames: [],
            createdAt: 1,
            updatedAt: 1
          }
        ],
        loadDeviceCredentials: vi.fn().mockResolvedValue(undefined)
      })

      await act(async () => {
        root.render(
          <CredentialsPanel
            view={{ kind: 'list' }}
            onNavigate={vi.fn()}
            onOpenConnector={vi.fn()}
            onOpenProvider={vi.fn()}
          />
        )
        await Promise.resolve()
      })

      expect(document.body.textContent).toContain(`API key / ${expectedStatus}`)
      expect(document.body.textContent).not.toContain('API key: Stored')
    }
  )

  it('confirms device credential removal with the shared alert dialog', async () => {
    const removeDeviceCredential = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      deviceCredentials: [
        {
          id: 'credential-remove',
          displayName: 'Temporary token',
          kind: 'token',
          status: 'stored',
          needsSecret: false,
          consumerCount: 0,
          consumerNames: [],
          createdAt: 1,
          updatedAt: 1
        }
      ],
      loadDeviceCredentials: vi.fn().mockResolvedValue(undefined),
      removeDeviceCredential
    })

    await act(async () => {
      root.render(
        <CredentialsPanel
          view={{ kind: 'list' }}
          onNavigate={vi.fn()}
          onOpenConnector={vi.fn()}
          onOpenProvider={vi.fn()}
        />
      )
      await Promise.resolve()
    })

    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>('[aria-label="Remove Temporary token"]')
        ?.click()
    })
    expect(document.body.textContent).toContain('Remove this credential from this device?')

    const cancel = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent === 'Cancel'
    )
    await act(async () => cancel?.click())
    expect(removeDeviceCredential).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toContain('Remove this credential from this device?')

    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>('[aria-label="Remove Temporary token"]')
        ?.click()
    })
    const confirm = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent === 'Remove'
    )
    await act(async () => confirm?.click())

    expect(removeDeviceCredential).toHaveBeenCalledWith({ id: 'credential-remove' })
    expect(document.body.textContent).not.toContain('Remove this credential from this device?')
  })

  it('aggregates service credentials and links custom MCP secrets to their owner', async () => {
    const onOpenConnector = vi.fn()
    await act(async () => {
      root.render(
        <CredentialsPanel
          view={{ kind: 'list' }}
          onNavigate={vi.fn()}
          onOpenConnector={onOpenConnector}
          onOpenProvider={vi.fn()}
        />
      )
      await Promise.resolve()
    })

    expect(document.body.textContent).toContain('Services')
    expect(document.body.textContent).toContain('GitHub')
    expect(document.body.textContent).toContain('Literature access')
    expect(document.body.textContent).toContain('OpenAlex')
    expect(document.body.textContent).toContain('Custom Search')
    expect(document.body.textContent).toContain('Credential fields configured')

    const customLabel = Array.from(document.body.querySelectorAll<HTMLParagraphElement>('p')).find(
      (element) => element.textContent === 'Custom Search'
    )
    const customRow = customLabel?.parentElement?.parentElement
    act(() => customRow?.querySelector<HTMLButtonElement>('button')?.click())
    expect(onOpenConnector).toHaveBeenCalledWith('custom-search')
  })

  it('cancels browser sign-in without restoring a stale pending response, and confirms local disconnect', async () => {
    const disconnected = { provider: 'hugging-face', state: 'disconnected', localAvailable: true }
    const pending = { ...disconnected, state: 'pending', userCode: 'ABCD-EFGH' }
    const connected = { ...disconnected, state: 'connected', identity: 'lab', source: 'local' }
    let finishPoll: (status: typeof pending) => void = () => undefined
    const accountStatus = vi
      .fn()
      .mockResolvedValueOnce(disconnected)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishPoll = resolve
          })
      )
    const disconnectAccount = vi.fn().mockResolvedValue(disconnected)
    const connectAccount = vi.fn().mockResolvedValue(pending)
    const cancelAccountConnection = vi.fn().mockResolvedValue(disconnected)
    const useLocalAccount = vi
      .fn()
      .mockResolvedValue({ provider: 'hugging-face', state: 'pending', source: 'local' })
    Object.assign(window.api, {
      compute: {
        getComputePythonRuntime: vi.fn(async () => ({
          selection: { kind: 'managed' },
          revision: 0,
          candidates: []
        })),
        accountStatus,
        disconnectAccount,
        connectAccount,
        cancelAccountConnection,
        useLocalAccount
      }
    })
    await act(async () =>
      root.render(
        <CredentialsPanel
          view={{ kind: 'service', serviceId: 'hugging-face' }}
          onNavigate={vi.fn()}
          onOpenConnector={vi.fn()}
          onOpenProvider={vi.fn()}
        />
      )
    )
    await act(async () => screen.getByRole('button', { name: 'Connect' }).click())
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Connect in browser' }))
    await act(async () => screen.getByRole('button', { name: 'Connect in browser' }).click())
    expect(connectAccount).toHaveBeenCalledWith(
      'hugging-face',
      expect.objectContaining({ operationId: expect.any(String), revision: 0 })
    )
    expect(screen.getByText('ABCD-EFGH')).toBeTruthy()
    const writeText = vi.fn().mockResolvedValue(undefined)
    const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    try {
      await act(async () => screen.getByRole('button', { name: 'Copy code' }).click())
      expect(writeText).toHaveBeenCalledWith('ABCD-EFGH')
      expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy()
    } finally {
      if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard)
      else Reflect.deleteProperty(navigator, 'clipboard')
    }
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await act(async () => screen.getByRole('button', { name: 'Cancel' }).click())
    await act(async () => finishPoll(pending))
    expect(cancelAccountConnection).toHaveBeenCalledWith(
      'hugging-face',
      expect.objectContaining({ operationId: expect.any(String), revision: 0 })
    )
    expect(screen.queryByText('ABCD-EFGH')).toBeNull()
    await act(async () => screen.getByRole('button', { name: 'Connect' }).click())
    await act(async () => screen.getByRole('button', { name: 'Use local sign-in' }).click())
    expect(within(screen.getByRole('alertdialog')).getByRole('status').textContent).toBe(
      'Checking…'
    )
    expect(screen.queryByRole('button', { name: 'Copy code' })).toBeNull()
    cancelAccountConnection.mockResolvedValue(connected)
    accountStatus.mockResolvedValueOnce(connected)
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(screen.getByRole('status').textContent).toContain('Local CLI')
    await act(async () => screen.getByRole('button', { name: 'Disconnect' }).click())
    expect(disconnectAccount).not.toHaveBeenCalled()
    expect(screen.getByRole('alertdialog').textContent).toContain(
      'Remote jobs may continue running'
    )
    await act(async () =>
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Disconnect' }).click()
    )
    expect(disconnectAccount).toHaveBeenCalledWith('hugging-face')
    expect(screen.queryByText('lab')).toBeNull()
  })

  it('keeps the dialog open for a failed account switch and cancels an outstanding browser start on close', async () => {
    const current = { provider: 'modal', state: 'connected', source: 'managed', identity: 'lab' }
    let finish!: (status: unknown) => void
    const cancelAccountConnection = vi.fn().mockResolvedValue(current)
    const connectAccount = vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const useLocalAccount = vi.fn().mockResolvedValue({ ...current, reason: 'authorization' })
    Object.assign(window.api, {
      compute: {
        getComputePythonRuntime: vi.fn(async () => ({
          selection: { kind: 'managed' },
          revision: 0,
          candidates: []
        })),
        accountStatus: vi.fn().mockResolvedValue(current),
        useLocalAccount,
        connectAccount,
        cancelAccountConnection
      }
    })
    await act(async () =>
      root.render(
        <CredentialsPanel
          view={{ kind: 'service', serviceId: 'modal' }}
          onNavigate={vi.fn()}
          onOpenConnector={vi.fn()}
          onOpenProvider={vi.fn()}
        />
      )
    )
    await act(async () => screen.getByRole('button', { name: 'Reconnect' }).click())
    const dialog = within(screen.getByRole('alertdialog'))
    await act(async () => dialog.getByRole('button', { name: 'Use local sign-in' }).click())
    expect(dialog.getByRole('alert').textContent).toContain('Authorization was not completed')
    await act(async () => dialog.getByRole('button', { name: 'Retry' }).click())
    expect(useLocalAccount).toHaveBeenCalledTimes(2)
    act(() => dialog.getByRole('button', { name: 'Connect in browser' }).click())
    await act(async () => dialog.getByRole('button', { name: 'Close' }).click())
    expect(cancelAccountConnection).toHaveBeenLastCalledWith(
      'modal',
      expect.objectContaining({ operationId: expect.any(String), revision: 0 })
    )
    await act(async () => finish({ ...current, state: 'pending', userCode: 'LATE-CODE' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(screen.getByRole('status').textContent).toContain('lab')
    expect(screen.queryByText('LATE-CODE')).toBeNull()
    await act(async () => screen.getByRole('button', { name: 'Reconnect' }).click())
    act(() => screen.getByRole('button', { name: 'Connect in browser' }).click())
    await act(async () => finish({ ...current, state: 'pending', userCode: 'NEW-CODE' }))
    expect(screen.getByText('NEW-CODE')).toBeTruthy()
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(cancelAccountConnection).toHaveBeenLastCalledWith(
      'modal',
      expect.objectContaining({ operationId: expect.any(String), revision: 0 })
    )
  })

  it('manages Ray tokens by Dashboard address without reading their material into an editor', async () => {
    const endpoint = 'https://compute.example.test'
    const listRayTokens = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([endpoint])
      .mockResolvedValueOnce([endpoint])
      .mockResolvedValue([])
    const setRayToken = vi.fn().mockResolvedValue(undefined)
    const removeRayToken = vi.fn().mockResolvedValue(undefined)
    Object.assign(window.api, { compute: { listRayTokens, setRayToken, removeRayToken } })
    const props = { onNavigate: vi.fn(), onOpenConnector: vi.fn(), onOpenProvider: vi.fn() }
    await act(async () => root.render(<CredentialsPanel {...props} view={{ kind: 'list' }} />))
    const ray = screen.getByText('Ray Jobs').parentElement!
    await act(async () => within(ray).getByRole('button', { name: 'Manage' }).click())
    expect(props.onNavigate).toHaveBeenCalledWith({ kind: 'service', serviceId: 'ray' })
    await act(async () =>
      root.render(<CredentialsPanel {...props} view={{ kind: 'service', serviceId: 'ray' }} />)
    )
    expect(screen.getByText('No saved tokens.')).toBeTruthy()
    await act(async () => screen.getByRole('button', { name: 'Add access token' }).click())
    function enterToken(value: string): HTMLInputElement {
      const input = screen.getByLabelText<HTMLInputElement>('Access token')
      const paste = new Event('paste', { bubbles: true, cancelable: true })
      Object.defineProperty(paste, 'clipboardData', { value: { getData: () => value } })
      act(() => input.dispatchEvent(paste))
      expect(input.value).toBe('•'.repeat(value.length))
      return input
    }
    act(() =>
      fireEvent.change(screen.getByLabelText('Ray Dashboard URL'), { target: { value: endpoint } })
    )
    enterToken('test-original')
    await act(async () => screen.getByRole('button', { name: 'Save' }).click())
    expect(setRayToken).toHaveBeenLastCalledWith(endpoint, 'test-original')
    await act(async () => screen.getByRole('button', { name: 'Replace access token' }).click())
    expect(screen.getByLabelText('Ray Dashboard URL')).toHaveProperty('readOnly', true)
    expect(screen.getByLabelText('Access token')).toHaveProperty('value', '')
    enterToken('test-replacement')
    await act(async () => screen.getByRole('button', { name: 'Save' }).click())
    expect(setRayToken).toHaveBeenLastCalledWith(endpoint, 'test-replacement')
    await act(async () => screen.getByRole('button', { name: 'Remove ' + endpoint }).click())
    expect(removeRayToken).not.toHaveBeenCalled()
    await act(async () =>
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Remove' }).click()
    )
    expect(removeRayToken).toHaveBeenCalledExactlyOnceWith(endpoint)
    expect(screen.getByText('No saved tokens.')).toBeTruthy()
    listRayTokens.mockClear()
    document.documentElement.setAttribute(WEB_CALLER_LOCATION_ATTRIBUTE, 'remote')
    try {
      await act(async () => root.render(<CredentialsPanel {...props} view={{ kind: 'list' }} />))
      expect(screen.queryByText('Ray Jobs')).toBeNull()
      await act(async () =>
        root.render(<CredentialsPanel {...props} view={{ kind: 'service', serviceId: 'ray' }} />)
      )
      expect(screen.getByText('Desktop only')).toBeTruthy()
      expect(listRayTokens).not.toHaveBeenCalled()
    } finally {
      document.documentElement.removeAttribute(WEB_CALLER_LOCATION_ATTRIBUTE)
    }
  })

  it('keeps credential drafts isolated between service forms', async () => {
    const props = {
      onNavigate: vi.fn(),
      onOpenConnector: vi.fn(),
      onOpenProvider: vi.fn()
    }
    await act(async () => {
      root.render(<CredentialsPanel {...props} view={{ kind: 'service', serviceId: 'openalex' }} />)
      await Promise.resolve()
    })
    const openAlexField = document.body.querySelector<HTMLInputElement>('#service-api-key')!
    const paste = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', {
      value: { getData: vi.fn(() => 'openalex-secret'), setData: vi.fn() }
    })
    act(() => openAlexField.dispatchEvent(paste))
    expect(openAlexField.value).not.toBe('')

    act(() =>
      root.render(
        <CredentialsPanel {...props} view={{ kind: 'service', serviceId: 'literature' }} />
      )
    )

    expect(document.body.querySelector<HTMLInputElement>('#service-api-key')?.value).toBe('')
  })

  it('keeps desktop-only service credentials unavailable and hides Connector credentials on remote Web', async () => {
    window.api.settings.getGitHubTokenStatus = vi
      .fn()
      .mockRejectedValue(
        new Error(
          'This action is only available in the local desktop app (settings:get-github-token-status).'
        )
      )
    const props = {
      onNavigate: vi.fn(),
      onOpenConnector: vi.fn(),
      onOpenProvider: vi.fn()
    }

    await act(async () => {
      root.render(<CredentialsPanel {...props} view={{ kind: 'list' }} />)
      await Promise.resolve()
    })

    const desktopOnlyButtons = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('button')
    ).filter((button) => button.textContent === 'Desktop only')
    expect(desktopOnlyButtons).toHaveLength(3)
    expect(desktopOnlyButtons.every((button) => button.disabled)).toBe(true)
    expect(
      Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
        (button) => button.textContent === 'Connect' && !button.disabled
      )
    ).toBeDefined()
    expect(document.body.textContent).not.toContain('Connector credentials')
    expect(document.body.textContent).not.toContain('New credential')

    act(() =>
      root.render(<CredentialsPanel {...props} view={{ kind: 'service', serviceId: 'openalex' }} />)
    )

    expect(document.body.textContent).toContain(
      'This credential can only be configured in the local desktop app.'
    )
    expect(document.body.querySelector('#service-api-key')).toBeNull()

    act(() => root.render(<CredentialsPanel {...props} view={{ kind: 'create' }} />))
    expect(document.body.textContent).toContain(
      'This credential can only be configured in the local desktop app.'
    )
  })

  it('removes a stored NCBI key without clearing the contact email', async () => {
    const setNcbiCredentials = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      ncbi: { contactEmail: 'science@example.test', hasApiKey: true },
      setNcbiCredentials
    })

    await act(async () => {
      root.render(
        <CredentialsPanel
          view={{ kind: 'service', serviceId: 'literature' }}
          onNavigate={vi.fn()}
          onOpenConnector={vi.fn()}
          onOpenProvider={vi.fn()}
        />
      )
      await Promise.resolve()
    })

    const removeButton = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('button')
    ).find((button) => button.textContent === 'Remove key')
    await act(async () => removeButton?.click())

    expect(setNcbiCredentials).toHaveBeenCalledWith({
      contactEmail: 'science@example.test',
      apiKey: ''
    })
  })

  it('reports service credential drafts and returns to a clean state after saving', async () => {
    let resolveSave!: () => void
    const onLeaveStateChange = vi.fn()
    const setNcbiCredentials = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve
        })
    )
    useSettingsStore.setState({
      ncbi: { contactEmail: 'research@lab.org', hasApiKey: false },
      encryptionAvailable: true,
      setNcbiCredentials
    })
    await act(async () =>
      root.render(
        <CredentialsPanel
          view={{ kind: 'service', serviceId: 'literature' }}
          onNavigate={vi.fn()}
          onOpenConnector={vi.fn()}
          onOpenProvider={vi.fn()}
          onLeaveStateChange={onLeaveStateChange}
        />
      )
    )
    expect(onLeaveStateChange).toHaveBeenLastCalledWith({ dirty: false, busy: false })

    fireEvent.change(screen.getByLabelText('Contact email'), {
      target: { value: 'updated@lab.org' }
    })
    const paste = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', {
      value: { getData: vi.fn(() => 'ncbi-secret'), setData: vi.fn() }
    })
    act(() => document.body.querySelector('#service-api-key')?.dispatchEvent(paste))
    expect(onLeaveStateChange).toHaveBeenLastCalledWith({ dirty: true, busy: false })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })))
    expect(onLeaveStateChange).toHaveBeenLastCalledWith({ dirty: true, busy: true })

    await act(async () => {
      useSettingsStore.setState({
        ncbi: { ...useSettingsStore.getState().ncbi, contactEmail: 'updated@lab.org' }
      })
      resolveSave()
    })
    expect(setNcbiCredentials).toHaveBeenCalledWith({
      contactEmail: 'updated@lab.org',
      apiKey: 'ncbi-secret'
    })
    expect(onLeaveStateChange).toHaveBeenLastCalledWith({ dirty: false, busy: false })
  })
})
