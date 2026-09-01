// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'
import { DeviceCredentialEditor } from './DeviceCredentialEditor'

let container: HTMLDivElement
let root: Root

if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = (): boolean => false
  Element.prototype.setPointerCapture = (): void => undefined
  Element.prototype.releasePointerCapture = (): void => undefined
}

beforeEach(() => {
  useSettingsStore.setState({
    ...createInitialSettingsState(),
    encryptionAvailable: true,
    createDeviceCredential: vi.fn().mockResolvedValue(undefined),
    authenticateDeviceCredential: vi.fn().mockResolvedValue(undefined)
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

const setInputValue = (input: HTMLInputElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const selectCredentialType = (option: string): void => {
  const trigger = document.body.querySelector<HTMLButtonElement>('[aria-label="Credential type"]')
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

describe('DeviceCredentialEditor', () => {
  it('creates a device-global API key without exposing it back through the form', async () => {
    const onDone = vi.fn()
    act(() => root.render(<DeviceCredentialEditor onDone={onDone} onCancel={vi.fn()} />))
    const content = container.firstElementChild?.firstElementChild
    expect(content?.className).toContain('w-full')
    expect(content?.className).not.toContain('mx-auto')
    expect(content?.className).not.toContain('max-w-')
    const [name, secret] = Array.from(container.querySelectorAll<HTMLInputElement>('input'))
    expect(name?.getAttribute('aria-required')).toBe('true')
    expect(secret?.getAttribute('aria-required')).toBe('true')
    setInputValue(name!, 'Lab API')
    const paste = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', {
      value: { getData: vi.fn(() => 'raw-secret'), setData: vi.fn() }
    })
    act(() => secret!.dispatchEvent(paste))

    const save = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent === 'Save'
    )
    await act(async () => save?.click())

    expect(useSettingsStore.getState().createDeviceCredential).toHaveBeenCalledWith({
      displayName: 'Lab API',
      kind: 'api_key',
      secret: 'raw-secret'
    })
    expect(secret?.value).not.toContain('raw-secret')
    expect(onDone).toHaveBeenCalledOnce()
  })

  it('reconnects an existing OAuth credential through the device lifecycle action', async () => {
    const credential = {
      id: 'credential-oauth',
      displayName: 'Lab OAuth',
      kind: 'oauth' as const,
      status: 'disconnected' as const,
      needsSecret: false,
      resourceUri: 'https://mcp.example.test/',
      transport: 'streamable_http' as const,
      consumerCount: 1,
      consumerNames: ['Research'],
      createdAt: 1,
      updatedAt: 1
    }
    act(() =>
      root.render(
        <DeviceCredentialEditor credential={credential} onDone={vi.fn()} onCancel={vi.fn()} />
      )
    )
    const signIn = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent === 'Sign in'
    )
    expect(container.textContent).toContain('disables every Connector using this credential')
    await act(async () => signIn?.click())

    expect(useSettingsStore.getState().authenticateDeviceCredential).toHaveBeenCalledWith({
      id: credential.id
    })
    expect(container.textContent).toContain('Credential connected.')
  })

  it('keeps OAuth details collapsed and signs in immediately after saving', async () => {
    const onDone = vi.fn()
    const created = {
      id: 'credential-new-oauth',
      displayName: 'Lab OAuth',
      kind: 'oauth' as const,
      status: 'disconnected' as const,
      needsSecret: false,
      resourceUri: 'https://mcp.example.test/',
      transport: 'streamable_http' as const,
      consumerCount: 0,
      consumerNames: [],
      createdAt: 1,
      updatedAt: 1
    }
    useSettingsStore.setState({
      createDeviceCredential: vi.fn().mockResolvedValue(created)
    })
    act(() => root.render(<DeviceCredentialEditor onDone={onDone} onCancel={vi.fn()} />))

    selectCredentialType('OAuth')
    const advanced = document.body.querySelector<HTMLButtonElement>(
      '[aria-controls="credential-oauth-advanced-settings"]'
    )
    expect(advanced?.getAttribute('aria-expanded')).toBe('false')
    expect(document.body.querySelector('[aria-label="Transport"]')).toBeNull()

    const name = container.querySelectorAll<HTMLInputElement>('input')[0]!
    const resource = container.querySelector<HTMLInputElement>(
      'input[placeholder="https://mcp.example.com/"]'
    )!
    setInputValue(name, 'Lab OAuth')
    setInputValue(resource, 'https://mcp.example.test/')
    const saveAndSignIn = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent === 'Save and sign in'
    )
    await act(async () => saveAndSignIn?.click())

    expect(useSettingsStore.getState().createDeviceCredential).toHaveBeenCalledWith({
      displayName: 'Lab OAuth',
      kind: 'oauth',
      resourceUri: 'https://mcp.example.test/',
      transport: 'streamable_http',
      oauth: {}
    })
    expect(useSettingsStore.getState().authenticateDeviceCredential).toHaveBeenCalledWith({
      id: created.id
    })
    expect(onDone).toHaveBeenCalledWith(created)
  })

  it('returns a newly created OAuth credential after a successful sign-in retry', async () => {
    const onDone = vi.fn()
    const created = {
      id: 'credential-retry-oauth',
      displayName: 'Retry OAuth',
      kind: 'oauth' as const,
      status: 'disconnected' as const,
      needsSecret: false,
      resourceUri: 'https://mcp.example.test/',
      transport: 'streamable_http' as const,
      consumerCount: 0,
      consumerNames: [],
      createdAt: 1,
      updatedAt: 1
    }
    const authenticateDeviceCredential = vi
      .fn()
      .mockRejectedValueOnce(new Error('Sign-in cancelled'))
      .mockResolvedValueOnce(undefined)
    useSettingsStore.setState({
      createDeviceCredential: vi.fn().mockImplementation(async () => {
        useSettingsStore.setState({ deviceCredentials: [created] })
        return created
      }),
      authenticateDeviceCredential
    })
    act(() => root.render(<DeviceCredentialEditor onDone={onDone} onCancel={vi.fn()} />))

    selectCredentialType('OAuth')
    const [name] = Array.from(container.querySelectorAll<HTMLInputElement>('input'))
    const resource = container.querySelector<HTMLInputElement>(
      'input[placeholder="https://mcp.example.com/"]'
    )!
    setInputValue(name!, 'Retry OAuth')
    setInputValue(resource, 'https://mcp.example.test/')
    const saveAndSignIn = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent === 'Save and sign in'
    )
    await act(async () => saveAndSignIn?.click())

    expect(container.textContent).toContain('Could not connect credential.')
    expect(container.textContent).not.toContain('Sign-in cancelled')
    expect(onDone).not.toHaveBeenCalled()
    const retry = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent === 'Sign in'
    )
    await act(async () => retry?.click())

    expect(authenticateDeviceCredential).toHaveBeenCalledTimes(2)
    expect(onDone).toHaveBeenCalledWith(created)
  })

  it('opens required imported OAuth client settings automatically', () => {
    act(() =>
      root.render(
        <DeviceCredentialEditor
          initialKind="oauth"
          initialResourceUri="https://mcp.example.test/"
          initialOAuth={{ clientId: 'registered-client' }}
          requiresOAuthClientSecret
          onDone={vi.fn()}
          onCancel={vi.fn()}
        />
      )
    )
    expect(
      document.body
        .querySelector('[aria-controls="credential-oauth-advanced-settings"]')
        ?.getAttribute('aria-expanded')
    ).toBe('true')
    const preRegistered = document.body.querySelector<HTMLInputElement>(
      '[aria-label="Use a pre-registered OAuth client"]'
    )
    expect(preRegistered?.checked).toBe(true)
    expect(preRegistered?.disabled).toBe(true)
    expect(
      Array.from(document.body.querySelectorAll<HTMLInputElement>('input'))
        .find((input) => input.type === 'password')
        ?.getAttribute('aria-required')
    ).toBe('true')
    expect(document.body.querySelector('[aria-label="Credential type"]')?.textContent).toContain(
      'OAuth'
    )
    expect(
      document.body.querySelector<HTMLInputElement>('input[placeholder="https://mcp.example.com/"]')
        ?.value
    ).toBe('https://mcp.example.test/')
    expect(document.body.textContent).toContain(
      'This imported Connector requires a client secret entered locally.'
    )
  })
})
