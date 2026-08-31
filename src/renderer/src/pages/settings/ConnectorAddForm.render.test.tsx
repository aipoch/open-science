// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ConnectorAddForm } from './ConnectorAddForm'
import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'

if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = (): boolean => false
  Element.prototype.setPointerCapture = (): void => undefined
  Element.prototype.releasePointerCapture = (): void => undefined
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = (): void => undefined
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  useSettingsStore.setState({
    ...createInitialSettingsState(),
    encryptionAvailable: true,
    addCustomServer: vi.fn().mockResolvedValue(undefined)
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

// Sets a controlled input/textarea value the way React expects (native setter + input event).
const setValue = (label: string, value: string): void => {
  const field = document.body.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    `[aria-label="${label}"]`
  )
  const proto =
    field instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  act(() => {
    setter?.call(field, value)
    field?.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const checkTrust = (): void => {
  const checkbox = document.body.querySelector<HTMLInputElement>(
    '[aria-label="I trust this connector"]'
  )
  act(() => checkbox?.click())
}

const addButton = (): HTMLButtonElement | undefined =>
  Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find((button) =>
    ['Add connector', 'Add and sign in'].includes(button.textContent?.trim() ?? '')
  )

const advancedButton = (): HTMLButtonElement | null =>
  document.body.querySelector<HTMLButtonElement>(
    'button[aria-controls="connector-advanced-settings"]'
  )

const openAdvancedSettings = (): void => {
  const button = advancedButton()
  if (button?.getAttribute('aria-expanded') === 'false') act(() => button.click())
}

const selectOption = (label: string, option: string): void => {
  const trigger = document.body.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)
  act(() => {
    trigger?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  const item = Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]')).find(
    (candidate) => candidate.textContent?.includes(option)
  )
  act(() => {
    item?.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }))
    item?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

const staticCredential = {
  id: 'credential-static',
  displayName: 'Example API token',
  kind: 'token' as const,
  status: 'stored' as const,
  consumerCount: 0,
  consumerNames: [],
  createdAt: 1,
  updatedAt: 1
}

const oauthCredential = {
  id: 'credential-oauth',
  displayName: 'Example OAuth',
  kind: 'oauth' as const,
  status: 'connected' as const,
  resourceUri: 'https://mcp.example.test/',
  transport: 'streamable_http' as const,
  oauth: {
    authorizationServerUrl: 'https://auth.example.test/',
    clientId: 'registered-client',
    redirectUri: 'http://127.0.0.1:8080/callback'
  },
  hasClientSecret: true,
  consumerCount: 0,
  consumerNames: [],
  createdAt: 1,
  updatedAt: 1
}

describe('ConnectorAddForm (local command)', () => {
  it('uses one Connector type Tab stop and switches mode with ArrowRight', async () => {
    act(() => {
      root.render(<ConnectorAddForm initialTransport="local" onDone={vi.fn()} onCancel={vi.fn()} />)
    })

    const radios = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>(
        '[role="radiogroup"][aria-label="Connector type"] [role="radio"]'
      )
    )
    const group = document.body.querySelector<HTMLElement>(
      '[role="radiogroup"][aria-label="Connector type"]'
    )
    expect(group?.tabIndex).toBe(0)
    expect(radios.map((radio) => radio.tabIndex)).toEqual([-1, -1])

    act(() => {
      group?.focus()
    })
    expect(document.activeElement).toBe(radios[0])
    expect(radios.map((radio) => radio.tabIndex)).toEqual([0, -1])

    await act(async () => {
      radios[0].dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(document.body.querySelector('[aria-label="Server URL"]')).not.toBeNull()
    expect(document.activeElement).toBe(radios[1])
  })

  it('does not let an unbound hidden local environment draft block remote submission', async () => {
    act(() => {
      root.render(<ConnectorAddForm initialTransport="local" onDone={vi.fn()} onCancel={vi.fn()} />)
    })

    setValue('Display name', 'Remote after local')
    openAdvancedSettings()
    setValue('Environment variables', 'API_TOKEN=placeholder')
    const remote = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('[role="radio"]')
    ).find((radio) => radio.textContent?.trim() === 'Remote server')
    act(() => remote?.click())
    setValue('Server URL', 'https://mcp.example.test')
    checkTrust()

    expect(addButton()?.disabled).toBe(false)
    await act(async () => addButton()?.click())
    expect(useSettingsStore.getState().addCustomServer).toHaveBeenCalledWith(
      expect.objectContaining({
        displayName: 'Remote after local',
        transport: 'streamable_http',
        url: 'https://mcp.example.test'
      })
    )
    expect(
      vi.mocked(useSettingsStore.getState().addCustomServer).mock.calls[0]?.[0]
    ).not.toHaveProperty('oauth')
  })

  it('does not let an unbound hidden remote header draft block local submission', async () => {
    act(() => {
      root.render(
        <ConnectorAddForm initialTransport="remote" onDone={vi.fn()} onCancel={vi.fn()} />
      )
    })

    setValue('Display name', 'Local after remote')
    setValue('Server URL', 'https://mcp.example.test')
    openAdvancedSettings()
    selectOption('Authentication', 'Static headers')
    setValue('Headers', 'Authorization: placeholder')
    const local = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('[role="radio"]')
    ).find((radio) => radio.textContent?.trim() === 'Local command')
    act(() => local?.click())
    checkTrust()

    expect(addButton()?.disabled).toBe(false)
    await act(async () => addButton()?.click())
    expect(useSettingsStore.getState().addCustomServer).toHaveBeenCalledWith(
      expect.objectContaining({
        displayName: 'Local after remote',
        transport: 'stdio',
        command: 'npx'
      })
    )
  })

  it('adds a stdio server with the default npx command, then calls onDone', async () => {
    const onDone = vi.fn()
    act(() => {
      root.render(<ConnectorAddForm initialTransport="local" onDone={onDone} onCancel={vi.fn()} />)
    })

    expect(container.firstElementChild?.firstElementChild?.className).toContain('w-full')
    expect(advancedButton()?.getAttribute('aria-expanded')).toBe('false')
    expect(document.body.querySelector('[aria-label="Arguments"]')).toBeNull()
    setValue('Display name', 'Memory')
    checkTrust()

    await act(async () => {
      addButton()?.click()
    })

    expect(useSettingsStore.getState().addCustomServer).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'memory',
        displayName: 'Memory',
        transport: 'stdio',
        command: 'npx'
      })
    )
    expect(onDone).toHaveBeenCalled()
  })

  it('submits whitespace-separated header input as separate arguments', async () => {
    act(() => {
      root.render(<ConnectorAddForm initialTransport="local" onDone={vi.fn()} onCancel={vi.fn()} />)
    })

    setValue('Display name', 'Header Server')
    openAdvancedSettings()
    setValue('Arguments', '--header Authorization: Bearer plaintext-secret')
    checkTrust()

    await act(async () => addButton()?.click())

    expect(useSettingsStore.getState().addCustomServer).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ['--header', 'Authorization:', 'Bearer', 'plaintext-secret']
      })
    )
  })

  it('previews an ID from the name and submits a valid user override', async () => {
    act(() => {
      root.render(<ConnectorAddForm initialTransport="local" onDone={vi.fn()} onCancel={vi.fn()} />)
    })

    setValue('Display name', 'RNA Reviewer')
    openAdvancedSettings()

    const idInput = document.body.querySelector<HTMLInputElement>('[aria-label="Connector ID"]')
    expect(idInput?.value).toBe('rna-reviewer')

    setValue('Connector ID', 'transcriptomics-reviewer')
    checkTrust()
    await act(async () => addButton()?.click())

    expect(useSettingsStore.getState().addCustomServer).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'transcriptomics-reviewer',
        name: 'rna-reviewer',
        displayName: 'RNA Reviewer'
      })
    )
  })

  it('validates a user-provided ID while typing', () => {
    act(() => {
      root.render(<ConnectorAddForm initialTransport="local" onDone={vi.fn()} onCancel={vi.fn()} />)
    })

    setValue('Display name', 'RNA Reviewer')
    openAdvancedSettings()
    setValue('Connector ID', 'hello ee')

    const idInput = document.body.querySelector<HTMLInputElement>('[aria-label="Connector ID"]')
    expect(idInput?.getAttribute('aria-invalid')).toBe('true')
    expect(document.body.textContent).toContain(
      'ID may only contain lowercase letters, numbers, and hyphens.'
    )

    setValue('Connector ID', 'hello-ee')

    expect(idInput?.getAttribute('aria-invalid')).toBeNull()
    expect(document.body.textContent).not.toContain(
      'ID may only contain lowercase letters, numbers, and hyphens.'
    )
  })

  it('treats a pending-deletion Connector ID as reserved', () => {
    useSettingsStore.setState({ reservedCustomServerIds: ['rna-reviewer'] })
    act(() => {
      root.render(<ConnectorAddForm initialTransport="local" onDone={vi.fn()} onCancel={vi.fn()} />)
    })

    setValue('Display name', 'RNA Reviewer')
    openAdvancedSettings()

    const idInput = document.body.querySelector<HTMLInputElement>('[aria-label="Connector ID"]')
    expect(idInput?.value).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )

    setValue('Connector ID', 'rna-reviewer')

    expect(idInput?.getAttribute('aria-invalid')).toBe('true')
    expect(document.body.textContent).toContain('ID is already in use.')
  })

  it('previews and submits a UUID when the name cannot produce a safe ID', async () => {
    act(() => {
      root.render(<ConnectorAddForm initialTransport="local" onDone={vi.fn()} onCancel={vi.fn()} />)
    })

    setValue('Display name', 'MCP Research')
    openAdvancedSettings()

    const generatedId = document.body.querySelector<HTMLInputElement>(
      '[aria-label="Connector ID"]'
    )!.value
    expect(generatedId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )

    checkTrust()
    await act(async () => addButton()?.click())

    expect(useSettingsStore.getState().addCustomServer).toHaveBeenCalledWith(
      expect.objectContaining({ id: generatedId, name: 'mcp-research' })
    )
  })

  it('keeps Add connector disabled until the trust checkbox is checked', () => {
    act(() => {
      root.render(<ConnectorAddForm initialTransport="local" onDone={vi.fn()} onCancel={vi.fn()} />)
    })

    expect(
      document.body.querySelector('[aria-label="Display name"]')?.getAttribute('aria-required')
    ).toBe('true')
    expect(
      document.body.querySelector('[aria-label="Command"]')?.getAttribute('aria-required')
    ).toBe('true')
    expect(
      document.body
        .querySelector('[aria-label="I trust this connector"]')
        ?.getAttribute('aria-required')
    ).toBe('true')

    setValue('Display name', 'Memory')
    expect(addButton()?.disabled).toBe(true)

    checkTrust()
    expect(addButton()?.disabled).toBe(false)
  })

  it('uses full-width stacked fields and reveals optional fields from Advanced settings', () => {
    act(() => {
      root.render(<ConnectorAddForm initialTransport="local" onDone={vi.fn()} onCancel={vi.fn()} />)
    })

    expect(document.body.querySelectorAll('[data-slot="settings-row"]')).toHaveLength(0)
    expect(
      document.body
        .querySelector('[aria-label="Display name"]')
        ?.closest('[data-slot="settings-editor-field"]')
    ).not.toBeNull()
    expect(
      document.body
        .querySelector('[aria-label="Command"]')
        ?.closest('[data-slot="settings-editor-field"]')
    ).not.toBeNull()
    expect(document.body.querySelector('[aria-label="Connector name"]')).toBeNull()
    expect(document.body.querySelector('[aria-label="Description"]')).toBeNull()

    openAdvancedSettings()

    expect(advancedButton()?.getAttribute('aria-expanded')).toBe('true')
    for (const label of [
      'Connector name',
      'Connector ID',
      'Description',
      'Arguments',
      'Environment variables'
    ]) {
      expect(
        document.body
          .querySelector(`[aria-label="${label}"]`)
          ?.closest('[data-slot="settings-editor-field"]')
      ).not.toBeNull()
    }
  })

  it('reveals a generated Connector name error instead of hiding it in Advanced settings', () => {
    useSettingsStore.setState({
      connectors: [
        {
          id: 'memory',
          name: 'memory',
          displayName: 'Memory',
          description: 'Built-in memory connector.',
          sources: ['Open Science'],
          requiresNcbi: false,
          enabled: true,
          autoAllow: false,
          group: 'featured'
        }
      ]
    })
    act(() => {
      root.render(<ConnectorAddForm initialTransport="local" onDone={vi.fn()} onCancel={vi.fn()} />)
    })

    setValue('Display name', 'Memory')

    expect(advancedButton()?.getAttribute('aria-expanded')).toBe('true')
    expect(document.body.querySelector('[aria-label="Connector name"]')).not.toBeNull()
    expect(document.body.textContent).toContain('This name is reserved by a built-in Connector.')
  })

  it('prefills an imported template and requires a device credential binding', async () => {
    useSettingsStore.setState({ deviceCredentials: [staticCredential] })
    act(() => {
      root.render(
        <ConnectorAddForm
          initialTemplate={{
            schemaVersion: 1,
            kind: 'open-science.connector',
            name: 'example-research',
            displayName: 'Example Research',
            transport: 'stdio',
            command: 'npx',
            args: ['-y', '@example/research-mcp', '--label', 'two words'],
            requiredSecrets: { environment: ['API_TOKEN'] }
          }}
          onDone={vi.fn()}
          onCancel={vi.fn()}
        />
      )
    })

    expect(
      document.body.querySelector<HTMLInputElement>('[aria-label="Display name"]')?.value
    ).toBe('Example Research')
    expect(
      document.body.querySelector<HTMLTextAreaElement>('[aria-label="Environment variables"]')
        ?.value
    ).toBe('API_TOKEN=')
    const environment = document.body.querySelector<HTMLTextAreaElement>(
      '[aria-label="Environment variables"]'
    )
    expect(environment?.getAttribute('aria-required')).toBe('true')
    expect(environment?.getAttribute('aria-describedby')).toBe('connector-env-help')
    expect(document.body.querySelector('#connector-env-help')?.textContent).toContain(
      'Required: API_TOKEN.'
    )
    checkTrust()
    expect(addButton()?.disabled).toBe(true)

    selectOption('Credential for API_TOKEN', 'Example API token')
    expect(document.body.textContent).toContain('Example API token · Access token')
    expect(addButton()?.disabled).toBe(false)
    await act(async () => addButton()?.click())

    expect(useSettingsStore.getState().addCustomServer).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'example-research',
        displayName: 'Example Research',
        command: 'npx',
        args: ['-y', '@example/research-mcp', '--label', 'two words'],
        envCredentialIds: { API_TOKEN: 'credential-static' }
      })
    )
  })
})

describe('ConnectorAddForm (remote server)', () => {
  it('renders a Server URL field in remote mode', () => {
    act(() => {
      root.render(
        <ConnectorAddForm initialTransport="remote" onDone={vi.fn()} onCancel={vi.fn()} />
      )
    })

    expect(
      document.body.querySelector('[aria-label="Server URL"]')?.getAttribute('aria-required')
    ).toBe('true')
  })

  it('associates imported required header names with the Headers field', () => {
    act(() => {
      root.render(
        <ConnectorAddForm
          initialTemplate={{
            schemaVersion: 1,
            kind: 'open-science.connector',
            name: 'header-auth',
            displayName: 'Header Auth',
            transport: 'streamable_http',
            url: 'https://mcp.example.test',
            requiredSecrets: { headers: ['Authorization'] }
          }}
          onDone={vi.fn()}
          onCancel={vi.fn()}
        />
      )
    })

    const headers = document.body.querySelector('[aria-label="Headers"]')
    expect(headers?.getAttribute('aria-required')).toBe('true')
    expect(headers?.getAttribute('aria-describedby')).toBe('connector-headers-help')
    expect(document.body.querySelector('#connector-headers-help')?.textContent).toContain(
      'Required: Authorization.'
    )
  })

  it('adds static header credentials without legacy OAuth fields', async () => {
    useSettingsStore.setState({ deviceCredentials: [staticCredential] })
    act(() => {
      root.render(
        <ConnectorAddForm initialTransport="remote" onDone={vi.fn()} onCancel={vi.fn()} />
      )
    })

    setValue('Display name', 'Header MCP')
    setValue('Server URL', 'https://mcp.example.test')
    openAdvancedSettings()
    selectOption('Authentication', 'Static headers')
    setValue('Headers', 'Authorization:')
    selectOption('Credential for Authorization', 'Example API token')
    checkTrust()
    await act(async () => addButton()?.click())

    const request = vi.mocked(useSettingsStore.getState().addCustomServer).mock.calls[0]?.[0]
    expect(request).toEqual(
      expect.objectContaining({
        headerCredentialIds: { Authorization: staticCredential.id },
        transport: 'streamable_http'
      })
    )
    expect(request).not.toHaveProperty('oauth')
  })

  it('reveals uncommon OAuth registration settings only when selected', () => {
    act(() => {
      root.render(
        <ConnectorAddForm initialTransport="remote" onDone={vi.fn()} onCancel={vi.fn()} />
      )
    })

    openAdvancedSettings()
    selectOption('Authentication', 'OAuth')

    const scopesField = document.body.querySelector('[aria-label="OAuth scopes"]')
    expect(scopesField).not.toBeNull()
    expect(scopesField?.closest('[data-slot="settings-editor-field"]')?.textContent).not.toContain(
      '(optional)'
    )
    expect(document.body.querySelector('[aria-label="Authorization server URL"]')).toBeNull()
    expect(document.body.querySelector('[aria-label="Client metadata URL"]')).toBeNull()
    expect(document.body.querySelector('[aria-label="Client ID"]')).toBeNull()
    expect(document.body.querySelector('[aria-label="Client secret"]')).toBeNull()

    const discoveryButton = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('button')
    ).find((button) => button.textContent?.trim() === 'Configure OAuth discovery')
    act(() => discoveryButton?.click())
    const authorizationServer = document.body.querySelector(
      '[aria-label="Authorization server URL"]'
    )
    expect(authorizationServer).not.toBeNull()
    expect(
      authorizationServer?.closest('[data-slot="settings-editor-field"]')?.textContent
    ).not.toContain('(optional)')
    expect(document.body.querySelector('[aria-label="Client metadata URL"]')).not.toBeNull()

    const preRegistered = document.body.querySelector<HTMLInputElement>(
      '[aria-label="Use a pre-registered OAuth client"]'
    )
    expect(preRegistered?.checked).toBe(false)
    act(() => preRegistered?.click())

    expect(document.body.textContent).not.toContain(
      'Authorization server URL is required for a pre-registered client.'
    )
    expect(document.body.querySelector('[aria-label="Client metadata URL"]')).toBeNull()
    for (const label of ['Authorization server URL', 'Client ID', 'Client secret']) {
      const field = document.body.querySelector(`[aria-label="${label}"]`)
      expect(field).not.toBeNull()
      expect(field?.closest('[data-slot="settings-editor-field"]')?.textContent).not.toContain(
        '(optional)'
      )
    }
    expect(authorizationServer?.getAttribute('aria-required')).toBe('true')
    const clientId = document.body.querySelector('[aria-label="Client ID"]')
    expect(clientId?.getAttribute('aria-required')).toBe('true')

    setValue('Client secret', 'configured-secret')
    expect(authorizationServer?.getAttribute('aria-invalid')).toBe('true')
    expect(authorizationServer?.getAttribute('aria-describedby')).toBe(
      'connector-oauth-server-error'
    )
    expect(clientId?.getAttribute('aria-invalid')).toBe('true')
    expect(clientId?.getAttribute('aria-describedby')).toBe('connector-oauth-client-id-error')
    expect(document.body.querySelector('#connector-oauth-server-error')).not.toBeNull()
    expect(document.body.querySelector('#connector-oauth-client-id-error')).not.toBeNull()
    expect(document.body.querySelector('[aria-label="Default callback URI"]')).not.toBeNull()
  })

  it('selects a contextual OAuth credential after creating and connecting it', async () => {
    const createdCredential = {
      ...oauthCredential,
      id: 'credential-new-oauth',
      displayName: 'Notion credential'
    }
    useSettingsStore.setState({
      createDeviceCredential: vi.fn().mockImplementation(async () => {
        useSettingsStore.setState({ deviceCredentials: [createdCredential] })
        return createdCredential
      }),
      authenticateDeviceCredential: vi.fn().mockResolvedValue(undefined)
    })
    act(() => {
      root.render(
        <ConnectorAddForm initialTransport="remote" onDone={vi.fn()} onCancel={vi.fn()} />
      )
    })

    setValue('Server URL', 'https://mcp.example.test')
    openAdvancedSettings()
    selectOption('Authentication', 'OAuth')
    const newCredential = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('button')
    ).find((button) => button.textContent?.trim() === 'New credential')
    act(() => newCredential?.click())

    expect(document.body.querySelector('[aria-label="Credential type"]')?.textContent).toContain(
      'OAuth'
    )
    expect(
      document.body.querySelector<HTMLInputElement>('input[placeholder="https://mcp.example.com/"]')
        ?.value
    ).toBe('https://mcp.example.test')

    const name = Array.from(document.body.querySelectorAll<HTMLInputElement>('input')).find(
      (input) => input.closest('label')?.textContent?.includes('Name')
    )
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    act(() => {
      setter?.call(name, 'Notion credential')
      name?.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const saveAndSignIn = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('button')
    ).find((button) => button.textContent === 'Save and sign in')
    await act(async () => saveAndSignIn?.click())

    expect(useSettingsStore.getState().authenticateDeviceCredential).toHaveBeenCalledWith({
      id: createdCredential.id
    })
    expect(document.body.querySelector('[aria-label="OAuth credential"]')?.textContent).toContain(
      'Notion credential'
    )
  })

  it('adds a remote OAuth server with a matching device credential', async () => {
    const created = {
      id: 'oauth-mcp',
      name: 'oauth-mcp',
      displayName: 'OAuth MCP',
      transport: 'streamable_http' as const,
      enabled: false,
      url: 'https://mcp.example.test',
      oauth: { hasTokens: false }
    }
    const onDone = vi.fn()
    useSettingsStore.setState({
      deviceCredentials: [oauthCredential],
      addCustomServer: vi.fn().mockResolvedValue(created),
      authenticateCustomServer: vi.fn().mockResolvedValue(undefined),
      cancelCustomServerAuthentication: vi.fn().mockResolvedValue(undefined)
    })
    act(() => {
      root.render(<ConnectorAddForm initialTransport="remote" onDone={onDone} onCancel={vi.fn()} />)
    })

    setValue('Display name', 'OAuth MCP')
    setValue('Server URL', 'https://mcp.example.test')
    openAdvancedSettings()
    selectOption('Authentication', 'OAuth')
    selectOption('OAuth credential', 'Example OAuth')
    for (const label of ['Connector name', 'Authentication', 'OAuth credential']) {
      expect(
        document.body
          .querySelector(`[aria-label="${label}"]`)
          ?.closest('[data-slot="settings-editor-field"]')
      ).not.toBeNull()
    }
    checkTrust()
    expect(addButton()?.textContent).toContain('Add connector')

    await act(async () => {
      addButton()?.click()
    })

    expect(useSettingsStore.getState().addCustomServer).toHaveBeenCalledWith({
      name: 'oauth-mcp',
      displayName: 'OAuth MCP',
      description: undefined,
      transport: 'streamable_http',
      url: 'https://mcp.example.test',
      oauthCredentialId: 'credential-oauth'
    })
    expect(useSettingsStore.getState().authenticateCustomServer).not.toHaveBeenCalled()
    expect(onDone).toHaveBeenCalledOnce()
  })

  it('keeps Cancel disabled while an OAuth server is being added', async () => {
    const created = {
      id: 'oauth-mcp',
      name: 'oauth-mcp',
      displayName: 'OAuth MCP',
      transport: 'streamable_http' as const,
      enabled: false,
      url: 'https://mcp.example.test',
      oauth: { hasTokens: false }
    }
    let resolveAdd!: (server: typeof created) => void
    const onCancel = vi.fn()
    useSettingsStore.setState({
      deviceCredentials: [{ ...oauthCredential, status: 'disconnected' }],
      addCustomServer: vi.fn(
        () =>
          new Promise<typeof created>((resolve) => {
            resolveAdd = resolve
          })
      ),
      authenticateCustomServer: vi.fn().mockResolvedValue(undefined),
      cancelCustomServerAuthentication: vi.fn().mockResolvedValue(undefined)
    })
    act(() => {
      root.render(
        <ConnectorAddForm initialTransport="remote" onDone={vi.fn()} onCancel={onCancel} />
      )
    })

    setValue('Display name', 'OAuth MCP')
    setValue('Server URL', 'https://mcp.example.test')
    openAdvancedSettings()
    selectOption('Authentication', 'OAuth')
    selectOption('OAuth credential', 'Example OAuth')
    checkTrust()
    act(() => addButton()?.click())

    const cancel = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Cancel'
    )
    expect(cancel?.disabled).toBe(true)
    act(() => cancel?.click())
    expect(onCancel).not.toHaveBeenCalled()

    await act(async () => resolveAdd(created))
    expect(useSettingsStore.getState().authenticateCustomServer).toHaveBeenCalledWith({
      id: 'oauth-mcp'
    })
  })

  it('shows the default callback before revealing a different registered URI', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText }
    })
    act(() => {
      root.render(
        <ConnectorAddForm initialTransport="remote" onDone={vi.fn()} onCancel={vi.fn()} />
      )
    })

    openAdvancedSettings()
    selectOption('Authentication', 'OAuth')
    const preRegistered = document.body.querySelector<HTMLInputElement>(
      '[aria-label="Use a pre-registered OAuth client"]'
    )
    act(() => preRegistered?.click())
    setValue('Client ID', 'registered-client')

    expect(document.body.querySelector('[aria-label="Redirect URI"]')).toBeNull()
    expect(
      document.body.querySelector<HTMLInputElement>('[aria-label="Default callback URI"]')?.value
    ).toBe('http://127.0.0.1/oauth/callback')

    const copy = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Copy'
    )
    await act(async () => copy?.click())
    expect(writeText).toHaveBeenCalledWith('http://127.0.0.1/oauth/callback')

    const useDifferentUri = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('button')
    ).find((button) => button.textContent?.includes('Already registered a different callback URI?'))
    act(() => useDifferentUri?.click())

    expect(document.body.querySelector('[aria-label="Redirect URI"]')).not.toBeNull()
  })

  it('binds an imported OAuth Connector to a matching device credential', async () => {
    useSettingsStore.setState({
      encryptionAvailable: true,
      deviceCredentials: [oauthCredential]
    })
    act(() => {
      root.render(
        <ConnectorAddForm
          initialTemplate={{
            schemaVersion: 1,
            kind: 'open-science.connector',
            name: 'oauth-import',
            displayName: 'OAuth Import',
            transport: 'streamable_http',
            url: 'https://mcp.example.test',
            oauth: {
              authorizationServerUrl: 'https://auth.example.test',
              clientId: 'registered-client',
              redirectUri: 'http://127.0.0.1:8080/callback'
            },
            requiredSecrets: { oauthClientSecret: true }
          }}
          onDone={vi.fn()}
          onCancel={vi.fn()}
        />
      )
    })

    expect(document.body.querySelector<HTMLInputElement>('[aria-label="Client ID"]')?.value).toBe(
      'registered-client'
    )
    expect(
      document.body.querySelector<HTMLInputElement>('[aria-label="Redirect URI"]')?.value
    ).toBe('http://127.0.0.1:8080/callback')
    expect(
      document.body.querySelector('[aria-label="Client secret"]')?.getAttribute('aria-required')
    ).toBe('true')
    checkTrust()
    expect(addButton()?.disabled).toBe(true)
    selectOption('OAuth credential', 'Example OAuth')
    expect(addButton()?.disabled).toBe(false)

    await act(async () => addButton()?.click())
    const request = vi.mocked(useSettingsStore.getState().addCustomServer).mock.calls[0]?.[0]
    expect(request).toEqual(expect.objectContaining({ oauthCredentialId: 'credential-oauth' }))
    expect(request).not.toHaveProperty('oauth')
  })

  it('does not offer a shared OAuth credential without a required client secret', () => {
    useSettingsStore.setState({
      encryptionAvailable: true,
      deviceCredentials: [{ ...oauthCredential, hasClientSecret: false }]
    })
    act(() => {
      root.render(
        <ConnectorAddForm
          initialTemplate={{
            schemaVersion: 1,
            kind: 'open-science.connector',
            name: 'oauth-import',
            displayName: 'OAuth Import',
            transport: 'streamable_http',
            url: 'https://mcp.example.test',
            oauth: {
              authorizationServerUrl: 'https://auth.example.test',
              clientId: 'registered-client'
            },
            requiredSecrets: { oauthClientSecret: true }
          }}
          onDone={vi.fn()}
          onCancel={vi.fn()}
        />
      )
    })

    checkTrust()
    expect(addButton()?.disabled).toBe(true)
    const credentialField = document.body
      .querySelector('[aria-label="OAuth credential"]')
      ?.closest('[data-slot="settings-editor-field"]')
    const credentialTrigger = credentialField?.querySelector<HTMLButtonElement>(
      '[aria-label="OAuth credential"]'
    )
    act(() => {
      credentialTrigger?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
      credentialTrigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const emptyOption = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="option"]')
    ).find((option) => option.textContent?.includes('No matching credentials'))
    expect(emptyOption?.getAttribute('aria-disabled')).toBe('true')
    expect(credentialField?.lastElementChild?.textContent).toContain(
      "No OAuth credential matches this Connector's resource URL, transport, and registration."
    )
    expect(document.body.textContent).toContain(
      "No OAuth credential matches this Connector's resource URL, transport, and registration."
    )
  })

  it('does not offer a shared OAuth credential with an incompatible redirect URI', () => {
    useSettingsStore.setState({
      encryptionAvailable: true,
      deviceCredentials: [
        {
          ...oauthCredential,
          oauth: { ...oauthCredential.oauth, redirectUri: 'http://127.0.0.1:9090/other' }
        }
      ]
    })
    act(() => {
      root.render(
        <ConnectorAddForm
          initialTemplate={{
            schemaVersion: 1,
            kind: 'open-science.connector',
            name: 'oauth-import',
            displayName: 'OAuth Import',
            transport: 'streamable_http',
            url: 'https://mcp.example.test',
            oauth: {
              authorizationServerUrl: 'https://auth.example.test',
              clientId: 'registered-client',
              redirectUri: 'http://127.0.0.1:8080/callback'
            }
          }}
          onDone={vi.fn()}
          onCancel={vi.fn()}
        />
      )
    })

    checkTrust()
    expect(addButton()?.disabled).toBe(true)
    expect(document.body.textContent).toContain(
      "No OAuth credential matches this Connector's resource URL, transport, and registration."
    )
  })
})

describe('ConnectorAddForm (edit)', () => {
  const editServer = {
    id: 'srv-1',
    name: 'my-mem',
    displayName: 'my-mem',
    description: 'Memory server',
    transport: 'stdio' as const,
    enabled: true,
    command: 'npx',
    args: ['-y', 'old-pkg']
  }

  it('pre-fills fields, locks the name, and updates on save', async () => {
    useSettingsStore.setState({
      ...createInitialSettingsState(),
      updateCustomServer: vi.fn().mockResolvedValue(undefined)
    })
    const onDone = vi.fn()
    act(() => {
      root.render(<ConnectorAddForm editServer={editServer} onDone={onDone} onCancel={vi.fn()} />)
    })

    const nameInput = document.body.querySelector<HTMLInputElement>('[aria-label="Connector name"]')
    expect(nameInput?.value).toBe('my-mem')
    expect(nameInput?.disabled).toBe(true) // name is immutable and visibly disabled
    const idInput = document.body.querySelector<HTMLInputElement>('[aria-label="Connector ID"]')
    expect(idInput?.value).toBe('srv-1')
    expect(idInput?.disabled).toBe(true)
    const displayNameInput = document.body.querySelector<HTMLInputElement>(
      '[aria-label="Display name"]'
    )
    expect(displayNameInput?.value).toBe('my-mem')
    expect(displayNameInput?.readOnly).toBe(false)
    // The command Select shows the pre-filled runtime.
    expect(document.body.querySelector('[aria-label="Command"]')?.textContent).toContain('npx')

    // Edit a non-secret field.
    setValue('Display name', 'My Memory')
    setValue('Description', 'Updated memory')
    const save = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent?.trim() === 'Save changes'
    )
    expect(save).not.toBeUndefined()

    await act(async () => {
      save?.click()
    })

    expect(useSettingsStore.getState().updateCustomServer).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'srv-1',
        displayName: 'My Memory',
        transport: 'stdio',
        command: 'npx',
        description: 'Updated memory'
      })
    )
    // No `name` is sent on edit — the name is immutable.
    const call = (useSettingsStore.getState().updateCustomServer as ReturnType<typeof vi.fn>).mock
      .calls[0][0]
    expect(call).not.toHaveProperty('name')
    expect(onDone).toHaveBeenCalled()
  })

  it('shows saved environment names and can explicitly clear them', async () => {
    const updateCustomServer = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({ ...createInitialSettingsState(), updateCustomServer })
    act(() => {
      root.render(
        <ConnectorAddForm
          editServer={{
            ...editServer,
            hasEnv: true,
            environmentNames: ['API_TOKEN', 'ORG_ID']
          }}
          onDone={vi.fn()}
          onCancel={vi.fn()}
        />
      )
    })

    openAdvancedSettings()
    expect(document.body.textContent).toContain('API_TOKEN, ORG_ID')
    selectOption('Environment variable action', 'Clear saved variables')

    const save = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Save changes'
    )
    await act(async () => save?.click())

    expect(updateCustomServer).toHaveBeenCalledWith(expect.objectContaining({ env: {} }))
  })

  it('rebinds saved environment variables through device Credentials', async () => {
    const updateCustomServer = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      ...createInitialSettingsState(),
      deviceCredentials: [staticCredential],
      updateCustomServer
    })
    act(() => {
      root.render(
        <ConnectorAddForm
          editServer={{ ...editServer, hasEnv: true, environmentNames: ['API_TOKEN'] }}
          onDone={vi.fn()}
          onCancel={vi.fn()}
        />
      )
    })

    openAdvancedSettings()
    selectOption('Environment variable action', 'Replace saved variables')
    setValue('Environment variables', 'API_TOKEN=')
    const save = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Save changes'
    )
    expect(document.body.querySelector('[aria-label="Credential for API_TOKEN"]')).not.toBeNull()
    expect(save?.disabled).toBe(true)

    selectOption('Credential for API_TOKEN', 'Example API token')
    expect(save?.disabled).toBe(false)
    await act(async () => save?.click())

    expect(updateCustomServer).toHaveBeenCalledWith(
      expect.objectContaining({
        id: editServer.id,
        envCredentialIds: { API_TOKEN: staticCredential.id }
      })
    )
    expect(updateCustomServer.mock.calls[0]?.[0]).not.toHaveProperty('env')
  })

  it('preserves named environment variables when their encrypted values are unavailable', async () => {
    const updateCustomServer = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({ ...createInitialSettingsState(), updateCustomServer })
    act(() => {
      root.render(
        <ConnectorAddForm
          editServer={{
            ...editServer,
            hasEnv: false,
            environmentNames: ['API_TOKEN']
          }}
          onDone={vi.fn()}
          onCancel={vi.fn()}
        />
      )
    })

    openAdvancedSettings()
    expect(document.body.textContent).toContain('API_TOKEN')
    const save = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Save changes'
    )
    await act(async () => save?.click())

    const request = updateCustomServer.mock.calls[0]?.[0]
    expect(request).not.toHaveProperty('env')
  })

  it('reports malformed environment lines instead of silently dropping them', () => {
    act(() => {
      root.render(<ConnectorAddForm initialTransport="local" onDone={vi.fn()} onCancel={vi.fn()} />)
    })

    setValue('Display name', 'Memory')
    openAdvancedSettings()
    setValue('Environment variables', 'GOOD=value\nBROKEN')
    checkTrust()

    expect(document.body.textContent).toContain('Line 2: use KEY=.')
    expect(addButton()?.disabled).toBe(true)
  })

  it('reports malformed header lines instead of silently dropping them', () => {
    act(() => {
      root.render(
        <ConnectorAddForm initialTransport="remote" onDone={vi.fn()} onCancel={vi.fn()} />
      )
    })

    setValue('Display name', 'Remote memory')
    setValue('Server URL', 'https://mcp.example.test')
    openAdvancedSettings()
    selectOption('Authentication', 'Static headers')
    setValue('Headers', 'Authorization: Bearer secret\nBROKEN')
    checkTrust()

    expect(document.body.textContent).toContain('Line 2: use Name: Value.')
    expect(addButton()?.disabled).toBe(true)
  })

  it('reports duplicate environment names instead of overwriting them', () => {
    act(() => {
      root.render(<ConnectorAddForm initialTransport="local" onDone={vi.fn()} onCancel={vi.fn()} />)
    })

    setValue('Display name', 'Memory')
    openAdvancedSettings()
    setValue('Environment variables', 'API_TOKEN=first\nAPI_TOKEN=second')
    checkTrust()

    expect(document.body.textContent).toContain('Line 2: API_TOKEN is duplicated.')
    expect(addButton()?.disabled).toBe(true)
  })

  it('reports environment names that collide case-insensitively on Windows', () => {
    const originalApi = window.api
    window.api = { ...originalApi, platform: 'win32' } as Window['api']
    act(() => {
      root.render(<ConnectorAddForm initialTransport="local" onDone={vi.fn()} onCancel={vi.fn()} />)
    })

    setValue('Display name', 'Memory')
    openAdvancedSettings()
    setValue('Environment variables', 'API_TOKEN=first\napi_token=second')
    checkTrust()

    expect(document.body.textContent).toContain('Line 2: api_token is duplicated.')
    expect(addButton()?.disabled).toBe(true)
    window.api = originalApi
  })

  it('keeps case-distinct environment names valid on Unix', () => {
    const originalApi = window.api
    window.api = { ...originalApi, platform: 'darwin' } as Window['api']
    useSettingsStore.setState({
      deviceCredentials: [
        staticCredential,
        { ...staticCredential, id: 'credential-static-2', displayName: 'Second API token' }
      ]
    })
    act(() => {
      root.render(<ConnectorAddForm initialTransport="local" onDone={vi.fn()} onCancel={vi.fn()} />)
    })

    setValue('Display name', 'Memory')
    openAdvancedSettings()
    setValue('Environment variables', 'API_TOKEN=first\napi_token=second')
    selectOption('Credential for API_TOKEN', 'Example API token')
    selectOption('Credential for api_token', 'Second API token')
    checkTrust()

    expect(document.body.textContent).not.toContain('Line 2: api_token is duplicated.')
    window.api = originalApi
  })

  it('reports duplicate header names instead of overwriting them', () => {
    act(() => {
      root.render(
        <ConnectorAddForm initialTransport="remote" onDone={vi.fn()} onCancel={vi.fn()} />
      )
    })
    setValue('Display name', 'Remote memory')
    setValue('Server URL', 'https://mcp.example.test')
    openAdvancedSettings()
    selectOption('Authentication', 'Static headers')
    setValue('Headers', 'Authorization: first\nAuthorization: second')
    checkTrust()

    expect(document.body.textContent).toContain('Line 2: Authorization is duplicated.')
    expect(addButton()?.disabled).toBe(true)
  })

  it('requires stored credential bindings instead of accepting inline environment secrets', () => {
    useSettingsStore.setState({ encryptionAvailable: false })
    act(() => {
      root.render(<ConnectorAddForm initialTransport="local" onDone={vi.fn()} onCancel={vi.fn()} />)
    })

    setValue('Display name', 'Local memory')
    openAdvancedSettings()
    setValue('Environment variables', 'API_TOKEN=secret')
    checkTrust()

    expect(document.body.textContent).not.toContain('Secure credential storage is unavailable')
    expect(addButton()?.disabled).toBe(true)
  })

  it('requires stored credential bindings instead of accepting inline header secrets', () => {
    useSettingsStore.setState({ encryptionAvailable: false })
    act(() => {
      root.render(
        <ConnectorAddForm initialTransport="remote" onDone={vi.fn()} onCancel={vi.fn()} />
      )
    })

    setValue('Display name', 'Remote memory')
    setValue('Server URL', 'https://mcp.example.test')
    openAdvancedSettings()
    selectOption('Authentication', 'Static headers')
    setValue('Headers', 'Authorization: Bearer secret')
    checkTrust()

    expect(document.body.textContent).not.toContain('Secure credential storage is unavailable')
    expect(addButton()?.disabled).toBe(true)
  })

  it('keeps a legacy Connector editable when its name matches another stored ID', () => {
    useSettingsStore.setState({
      ...createInitialSettingsState(),
      customServers: [
        editServer,
        {
          ...editServer,
          id: 'my-mem',
          name: 'other-server',
          displayName: 'Other server'
        }
      ],
      updateCustomServer: vi.fn().mockResolvedValue(undefined)
    })
    act(() => {
      root.render(<ConnectorAddForm editServer={editServer} onDone={vi.fn()} onCancel={vi.fn()} />)
    })

    const save = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Save changes'
    )
    expect(document.body.textContent).not.toContain(
      'A custom Connector with this name already exists.'
    )
    expect(save?.disabled).toBe(false)
  })

  it('reveals a stored Connector name error instead of hiding it in Advanced settings', () => {
    useSettingsStore.setState({
      ...createInitialSettingsState(),
      connectors: [
        {
          id: 'my-mem',
          name: 'my-mem',
          displayName: 'Built-in memory',
          description: 'Built-in memory connector.',
          sources: ['Open Science'],
          requiresNcbi: false,
          enabled: true,
          autoAllow: false,
          group: 'featured'
        }
      ]
    })
    act(() => {
      root.render(
        <ConnectorAddForm
          editServer={{ ...editServer, description: '', args: [] }}
          onDone={vi.fn()}
          onCancel={vi.fn()}
        />
      )
    })

    expect(advancedButton()?.getAttribute('aria-expanded')).toBe('true')
    expect(document.body.querySelector('[aria-label="Connector name"]')).not.toBeNull()
    expect(document.body.textContent).toContain('This name is reserved by a built-in Connector.')
  })

  it.each(['connected', 'disconnected'] as const)(
    'binds a %s shared credential when switching a remote server to OAuth',
    async (credentialStatus) => {
      const updateCustomServer = vi.fn().mockResolvedValue(undefined)
      const authenticateCustomServer = vi.fn().mockResolvedValue(undefined)
      const onDone = vi.fn()
      useSettingsStore.setState({
        ...createInitialSettingsState(),
        deviceCredentials: [{ ...oauthCredential, status: credentialStatus }],
        updateCustomServer,
        authenticateCustomServer
      })
      act(() => {
        root.render(
          <ConnectorAddForm
            editServer={{
              id: 'remote-1',
              name: 'remote',
              displayName: 'Remote',
              transport: 'streamable_http',
              enabled: true,
              url: 'https://mcp.example.test',
              hasHeaders: true
            }}
            onDone={onDone}
            onCancel={vi.fn()}
          />
        )
      })

      selectOption('Authentication', 'OAuth')
      expect(document.body.querySelector('[aria-label="OAuth credential"]')).not.toBeNull()
      selectOption('OAuth credential', 'Example OAuth')
      const save = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
        (button) => button.textContent?.trim() === 'Save changes'
      )
      await act(async () => save?.click())

      expect(updateCustomServer).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'remote-1',
          headers: {},
          oauthCredentialId: oauthCredential.id
        })
      )
      if (credentialStatus === 'connected') {
        expect(authenticateCustomServer).not.toHaveBeenCalled()
      } else {
        expect(authenticateCustomServer).toHaveBeenCalledWith({ id: 'remote-1' })
      }
      expect(onDone).toHaveBeenCalledOnce()
    }
  )

  it('preselects the shared OAuth credential on Configure', () => {
    useSettingsStore.setState({
      ...createInitialSettingsState(),
      deviceCredentials: [oauthCredential]
    })
    act(() => {
      root.render(
        <ConnectorAddForm
          editServer={{
            id: 'remote-shared',
            name: 'remote-shared',
            displayName: 'Remote shared',
            transport: 'streamable_http',
            enabled: true,
            url: 'https://mcp.example.test',
            oauthCredentialId: oauthCredential.id,
            oauth: { ...oauthCredential.oauth, hasTokens: true, sharedCredential: true }
          }}
          onDone={vi.fn()}
          onCancel={vi.fn()}
        />
      )
    })

    expect(document.body.querySelector('[aria-label="OAuth credential"]')?.textContent).toContain(
      'Example OAuth'
    )
    expect(
      document.body.querySelector('[aria-label="OAuth scopes"]')?.closest('.hidden')
    ).not.toBeNull()
  })

  it('preserves shared header bindings when their values are unavailable and untouched', async () => {
    const updateCustomServer = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({ ...createInitialSettingsState(), updateCustomServer })
    act(() => {
      root.render(
        <ConnectorAddForm
          editServer={{
            id: 'remote-shared-header',
            name: 'remote-shared-header',
            displayName: 'Remote shared header',
            transport: 'streamable_http',
            enabled: true,
            url: 'https://mcp.example.test',
            hasHeaders: false,
            headerNames: ['Authorization'],
            availability: 'credential_unavailable'
          }}
          onDone={vi.fn()}
          onCancel={vi.fn()}
        />
      )
    })

    setValue('Display name', 'Renamed shared header')
    const save = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Save changes'
    )
    await act(async () => save?.click())

    const request = updateCustomServer.mock.calls[0]?.[0]
    expect(request).toMatchObject({
      id: 'remote-shared-header',
      displayName: 'Renamed shared header'
    })
    expect(request).not.toHaveProperty('headers')
  })

  it('replaces saved headers with device credential bindings', async () => {
    const updateCustomServer = vi.fn().mockResolvedValue(undefined)
    const replacement = {
      ...staticCredential,
      id: 'credential-static-2',
      displayName: 'Second API token'
    }
    useSettingsStore.setState({
      ...createInitialSettingsState(),
      deviceCredentials: [staticCredential, replacement],
      updateCustomServer
    })
    act(() => {
      root.render(
        <ConnectorAddForm
          editServer={{
            id: 'remote-shared-header',
            name: 'remote-shared-header',
            displayName: 'Remote shared header',
            transport: 'streamable_http',
            enabled: true,
            url: 'https://mcp.example.test',
            hasHeaders: true,
            headerNames: ['Authorization']
          }}
          onDone={vi.fn()}
          onCancel={vi.fn()}
        />
      )
    })

    selectOption('Header credential action', 'Replace saved headers')
    setValue('Headers', 'Authorization:')
    selectOption('Credential for Authorization', 'Second API token')
    const save = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Save changes'
    )
    await act(async () => save?.click())

    expect(updateCustomServer).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'remote-shared-header',
        headerCredentialIds: { Authorization: replacement.id }
      })
    )
    expect(updateCustomServer.mock.calls[0]?.[0]).not.toHaveProperty('headers')
  })

  it('clears saved header bindings explicitly', async () => {
    const updateCustomServer = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({ ...createInitialSettingsState(), updateCustomServer })
    act(() => {
      root.render(
        <ConnectorAddForm
          editServer={{
            id: 'remote-shared-header',
            name: 'remote-shared-header',
            displayName: 'Remote shared header',
            transport: 'streamable_http',
            enabled: true,
            url: 'https://mcp.example.test',
            hasHeaders: true,
            headerNames: ['Authorization']
          }}
          onDone={vi.fn()}
          onCancel={vi.fn()}
        />
      )
    })

    selectOption('Header credential action', 'Clear saved headers')
    const save = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Save changes'
    )
    await act(async () => save?.click())

    expect(updateCustomServer).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'remote-shared-header', headers: {} })
    )
    expect(updateCustomServer.mock.calls[0]?.[0]).not.toHaveProperty('headerCredentialIds')
  })

  it('clears OAuth state when switching a remote server to static headers', async () => {
    const updateCustomServer = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      ...createInitialSettingsState(),
      encryptionAvailable: true,
      deviceCredentials: [staticCredential],
      updateCustomServer
    })
    act(() => {
      root.render(
        <ConnectorAddForm
          editServer={{
            id: 'remote-1',
            name: 'remote',
            displayName: 'Remote',
            transport: 'streamable_http',
            enabled: true,
            url: 'https://mcp.example.test',
            oauth: { hasTokens: true }
          }}
          onDone={vi.fn()}
          onCancel={vi.fn()}
        />
      )
    })

    selectOption('Authentication', 'Static headers')
    setValue('Headers', 'Authorization:')
    selectOption('Credential for Authorization', 'Example API token')
    const save = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Save changes'
    )
    await act(async () => save?.click())

    expect(updateCustomServer).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'remote-1',
        headerCredentialIds: { Authorization: staticCredential.id },
        oauth: null
      })
    )
  })

  it('keeps a saved OAuth client secret when blank and removes it only explicitly', async () => {
    const updateCustomServer = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({ ...createInitialSettingsState(), updateCustomServer })
    const oauthServer = {
      id: 'remote-static',
      name: 'remote-static',
      displayName: 'Remote static',
      transport: 'streamable_http' as const,
      enabled: false,
      url: 'https://mcp.example.test',
      oauth: {
        authorizationServerUrl: 'https://auth.example.test',
        clientId: 'registered-client',
        hasTokens: false,
        hasClientSecret: true
      }
    }
    act(() => {
      root.render(<ConnectorAddForm editServer={oauthServer} onDone={vi.fn()} onCancel={vi.fn()} />)
    })

    const save = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Save changes'
    )
    await act(async () => save?.click())
    expect(updateCustomServer).toHaveBeenLastCalledWith(
      expect.objectContaining({
        oauth: expect.not.objectContaining({ clientSecret: expect.anything() })
      })
    )

    updateCustomServer.mockClear()
    setValue('Client secret', 'replacement-that-must-not-be-saved')
    const remove = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Remove saved client secret'
    )
    act(() => remove?.click())
    await act(async () => save?.click())
    expect(updateCustomServer).toHaveBeenCalledWith(
      expect.objectContaining({ oauth: expect.objectContaining({ clientSecret: null }) })
    )
  })

  it('shows None without a headers field for a remote server that has no authentication', () => {
    act(() => {
      root.render(
        <ConnectorAddForm
          editServer={{
            id: 'remote-1',
            name: 'remote',
            displayName: 'Remote',
            transport: 'streamable_http',
            enabled: true,
            url: 'https://mcp.example.test',
            hasHeaders: false
          }}
          onDone={vi.fn()}
          onCancel={vi.fn()}
        />
      )
    })

    expect(advancedButton()?.getAttribute('aria-expanded')).toBe('false')
    openAdvancedSettings()

    expect(document.body.querySelector('[aria-label="Authentication"]')?.textContent).toContain(
      'None'
    )
    expect(document.body.querySelector('[aria-label="Headers"]')).toBeNull()
  })
})
