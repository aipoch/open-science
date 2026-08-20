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
  Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
    (button) => button.textContent?.trim() === 'Add connector'
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

    expect(document.body.querySelector('[aria-label="Server URL"]')).not.toBeNull()
  })

  it('adds a remote OAuth server with scopes and discovery overrides', async () => {
    act(() => {
      root.render(
        <ConnectorAddForm initialTransport="remote" onDone={vi.fn()} onCancel={vi.fn()} />
      )
    })

    setValue('Display name', 'OAuth MCP')
    setValue('Server URL', 'https://mcp.example.test')
    openAdvancedSettings()
    selectOption('Authentication', 'OAuth')
    setValue('OAuth scopes', 'openid profile')
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
  })

  it('requires an imported OAuth client secret locally and submits pre-registered credentials', async () => {
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

    expect(document.body.querySelector<HTMLInputElement>('[aria-label="Client ID"]')?.value).toBe(
      'registered-client'
    )
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
          clientSecret: 'local-client-secret'
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
