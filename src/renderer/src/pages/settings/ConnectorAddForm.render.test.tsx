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

  it('does not let hidden local environment errors block remote submission', async () => {
    act(() => {
      root.render(<ConnectorAddForm initialTransport="local" onDone={vi.fn()} onCancel={vi.fn()} />)
    })

    setValue('Display name', 'Remote after local')
    openAdvancedSettings()
    setValue('Environment variables', 'missing-equals')
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

  it('prefills an imported template and requires local secret values', async () => {
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

    setValue('Environment variables', 'API_TOKEN=local-secret')
    expect(addButton()?.disabled).toBe(false)
    await act(async () => addButton()?.click())

    expect(useSettingsStore.getState().addCustomServer).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'example-research',
        displayName: 'Example Research',
        command: 'npx',
        args: ['-y', '@example/research-mcp', '--label', 'two words'],
        env: { API_TOKEN: 'local-secret' }
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

  it('adds a remote OAuth server with scopes and discovery overrides', async () => {
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
    setValue('OAuth scopes', 'openid profile')
    const discoveryButton = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('button')
    ).find((button) => button.textContent?.trim() === 'Configure OAuth discovery')
    act(() => discoveryButton?.click())
    setValue('Authorization server URL', 'https://auth.example.test')
    setValue('Client metadata URL', 'https://client.example.test/metadata.json')
    for (const label of [
      'Connector name',
      'Authentication',
      'OAuth scopes',
      'Authorization server URL',
      'Client metadata URL'
    ]) {
      expect(
        document.body
          .querySelector(`[aria-label="${label}"]`)
          ?.closest('[data-slot="settings-editor-field"]')
      ).not.toBeNull()
    }
    checkTrust()
    expect(addButton()?.textContent).toContain('Add and sign in')

    await act(async () => {
      addButton()?.click()
    })

    expect(useSettingsStore.getState().addCustomServer).toHaveBeenCalledWith({
      name: 'oauth-mcp',
      displayName: 'OAuth MCP',
      description: undefined,
      transport: 'streamable_http',
      url: 'https://mcp.example.test',
      oauth: {
        scopes: ['openid', 'profile'],
        authorizationServerUrl: 'https://auth.example.test',
        clientMetadataUrl: 'https://client.example.test/metadata.json'
      }
    })
    expect(useSettingsStore.getState().authenticateCustomServer).toHaveBeenCalledWith({
      id: 'oauth-mcp'
    })
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

  it('requires an imported OAuth client secret locally and submits pre-registered credentials', async () => {
    useSettingsStore.setState({ encryptionAvailable: true })
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
    setValue('Client secret', 'local-client-secret')
    expect(addButton()?.disabled).toBe(false)

    await act(async () => addButton()?.click())
    expect(useSettingsStore.getState().addCustomServer).toHaveBeenCalledWith(
      expect.objectContaining({
        oauth: expect.objectContaining({
          authorizationServerUrl: 'https://auth.example.test',
          clientId: 'registered-client',
          clientSecret: 'local-client-secret',
          redirectUri: 'http://127.0.0.1:8080/callback'
        })
      })
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

    expect(document.body.textContent).toContain('Line 2: use KEY=VALUE.')
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
    act(() => {
      root.render(<ConnectorAddForm initialTransport="local" onDone={vi.fn()} onCancel={vi.fn()} />)
    })

    setValue('Display name', 'Memory')
    openAdvancedSettings()
    setValue('Environment variables', 'API_TOKEN=first\napi_token=second')
    checkTrust()

    expect(document.body.textContent).toContain('Line 2: api_token is duplicated.')
    expect(addButton()?.disabled).toBe(true)
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

  it('requires secure storage before submitting static credentials', () => {
    useSettingsStore.setState({ encryptionAvailable: false })
    act(() => {
      root.render(<ConnectorAddForm initialTransport="local" onDone={vi.fn()} onCancel={vi.fn()} />)
    })

    setValue('Display name', 'Local memory')
    openAdvancedSettings()
    setValue('Environment variables', 'API_TOKEN=secret')
    checkTrust()

    expect(document.body.textContent).toContain('Secure credential storage is unavailable')
    expect(addButton()?.disabled).toBe(true)
  })

  it('requires secure storage before submitting static remote headers', () => {
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

    expect(document.body.textContent).toContain('Secure credential storage is unavailable')
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

  it('clears static headers when switching a remote server to OAuth', async () => {
    const updateCustomServer = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({ ...createInitialSettingsState(), updateCustomServer })
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
          onDone={vi.fn()}
          onCancel={vi.fn()}
        />
      )
    })

    selectOption('Authentication', 'OAuth')
    const save = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Save changes'
    )
    await act(async () => save?.click())

    expect(updateCustomServer).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'remote-1', headers: {}, oauth: {} })
    )
  })

  it('clears OAuth state when switching a remote server to static headers', async () => {
    const updateCustomServer = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      ...createInitialSettingsState(),
      encryptionAvailable: true,
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
    setValue('Headers', 'Authorization: Bearer replacement')
    const save = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Save changes'
    )
    await act(async () => save?.click())

    expect(updateCustomServer).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'remote-1',
        headers: { Authorization: 'Bearer replacement' },
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
