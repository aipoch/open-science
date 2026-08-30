// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ComputeHost } from '../../../../shared/compute'
import { createInitialComputeState, useComputeStore } from '@/stores/compute-store'
import { ComputeAddForm } from './ComputeAddForm'

let container: HTMLDivElement
let root: Root

const createdHost = {
  id: 'host-1',
  providerId: 'ssh:cluster',
  displayName: 'cluster',
  sshAlias: 'cluster',
  authentication: {
    mode: 'password',
    credentialStatus: 'configured',
    revision: 1,
    lastVerifiedAt: Date.now()
  }
} as ComputeHost

const enter = (id: string, value: string): void => {
  const input = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`)
  if (!input) throw new Error(`Missing input ${id}`)
  if (input instanceof HTMLInputElement && input.type === 'password') {
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', {
      value: { getData: () => value, setData: vi.fn() }
    })
    input.dispatchEvent(event)
    return
  }
  const prototype =
    input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

beforeEach(() => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      compute: {
        passwordCapability: vi.fn(async () => ({ available: true }))
      }
    }
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useComputeStore.setState({
    ...createInitialComputeState(),
    loadSshAliases: vi.fn(async () => undefined),
    createHost: vi.fn(async () => createdHost),
    createPasswordHost: vi.fn(async () => createdHost),
    probeHost: vi.fn(async () => ({
      ok: true,
      probedAt: new Date().toISOString(),
      exitCode: 0,
      errorTail: null
    }))
  })
  vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000001')
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('ComputeAddForm password authentication', () => {
  it('disables password mode when secure operating-system storage is unavailable', async () => {
    ;(window.api.compute.passwordCapability as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      available: false,
      reason: 'secure_storage_unavailable'
    })
    await act(async () => root.render(<ComputeAddForm onCreated={vi.fn()} onCancel={vi.fn()} />))

    const passwordChoice = container.querySelector<HTMLInputElement>(
      'input[name="compute-authentication"][value="password"]'
    )
    expect(passwordChoice?.disabled).toBe(true)
    expect(container.textContent).toContain(
      'Password authentication is unavailable because secure operating-system storage is not available.'
    )
  })

  it('uses the renderer API contract and clears password state after a successful test', async () => {
    const onCreated = vi.fn()
    await act(async () => root.render(<ComputeAddForm onCreated={onCreated} onCancel={vi.fn()} />))

    const passwordChoice = container.querySelector<HTMLInputElement>(
      'input[name="compute-authentication"][value="password"]'
    )
    act(() => passwordChoice?.click())
    act(() => {
      enter('compute-alias', ' cluster ')
      enter('compute-password-user', ' researcher ')
      enter('compute-password-port', '2222')
      enter('compute-password', 'secret with spaces\n和 Unicode')
    })
    const password = container.querySelector<HTMLInputElement>('#compute-password')
    expect(password?.type).toBe('password')
    expect(password?.value).toBe('•'.repeat('secret with spaces\n和 Unicode'.length))

    const add = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Add'
    )
    expect(add?.disabled).toBe(false)
    await act(async () => add?.click())

    expect(useComputeStore.getState().createPasswordHost).toHaveBeenCalledWith({
      sshAlias: 'cluster',
      detailsDoc: undefined,
      authenticationMode: 'password',
      username: 'researcher',
      port: 2222,
      password: 'secret with spaces\n和 Unicode',
      operationId: '00000000-0000-4000-8000-000000000001'
    })
    expect(useComputeStore.getState().createHost).not.toHaveBeenCalled()
    expect(onCreated).toHaveBeenCalledWith('ssh:cluster')
    expect(container.querySelector<HTMLInputElement>('#compute-password')?.value).toBe('')
  })

  it('keeps the default ssh_config strategy and its optional overrides compatible', async () => {
    await act(async () => root.render(<ComputeAddForm onCreated={vi.fn()} onCancel={vi.fn()} />))
    act(() => {
      enter('compute-alias', 'cluster')
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent?.includes('Advanced'))
        ?.click()
    })
    act(() => {
      enter('compute-user', 'researcher')
      enter('compute-port', '2222')
      enter('compute-identity', '~/.ssh/research')
    })

    const add = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Add'
    )
    await act(async () => add?.click())

    expect(useComputeStore.getState().createHost).toHaveBeenCalledWith({
      sshAlias: 'cluster',
      detailsDoc: undefined,
      sshOverrides: {
        user: 'researcher',
        port: 2222,
        identityFile: '~/.ssh/research'
      }
    })
    expect(useComputeStore.getState().createPasswordHost).not.toHaveBeenCalled()
  })

  it('rejects a partially parsed SSH configuration port', async () => {
    await act(async () => root.render(<ComputeAddForm onCreated={vi.fn()} onCancel={vi.fn()} />))
    act(() => {
      enter('compute-alias', 'cluster')
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent?.includes('Advanced'))
        ?.click()
    })
    act(() => enter('compute-port', '22junk'))

    const add = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Add'
    )

    expect(add?.disabled).toBe(true)
    await act(async () => add?.click())
    expect(useComputeStore.getState().createHost).not.toHaveBeenCalled()
  })

  it('shows testing and a safe inline error while preserving correctable fields', async () => {
    let rejectCreate: ((error: Error) => void) | undefined
    const createPasswordHost = vi.fn(
      () =>
        new Promise<ComputeHost>((_resolve, reject) => {
          rejectCreate = reject
        })
    )
    useComputeStore.setState({ createPasswordHost })
    await act(async () => root.render(<ComputeAddForm onCreated={vi.fn()} onCancel={vi.fn()} />))
    act(() =>
      container
        .querySelector<HTMLInputElement>('input[value="password"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    )
    act(() => {
      enter('compute-alias', 'cluster')
      enter('compute-password-user', 'researcher')
      enter('compute-password-port', '22')
      enter('compute-password', 'correctable secret')
    })

    const add = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Add'
    )
    act(() => add?.click())
    expect(container.textContent).toContain('Testing…')

    await act(async () =>
      rejectCreate?.(
        Object.assign(new Error('private helper output'), {
          code: 'authentication_failed'
        })
      )
    )
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Authentication failed. Verify the username and password.'
    )
    expect(container.textContent).not.toContain('private helper output')
    expect(container.querySelector<HTMLInputElement>('#compute-password')?.value).toBe(
      '•'.repeat('correctable secret'.length)
    )
  })

  it('keeps password requirements directly visible instead of labeling them Advanced', async () => {
    await act(async () => root.render(<ComputeAddForm onCreated={vi.fn()} onCancel={vi.fn()} />))
    const advanced = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Advanced')
    )
    const region = container.querySelector('#compute-advanced-settings')

    expect(advanced?.getAttribute('aria-expanded')).toBe('false')
    expect(advanced?.getAttribute('aria-controls')).toBe('compute-advanced-settings')
    expect(region?.hasAttribute('hidden')).toBe(true)
    expect(container.querySelector('#compute-password-user')).toBeNull()

    act(() => container.querySelector<HTMLInputElement>('input[value="password"]')?.click())

    const user = container.querySelector('#compute-password-user')
    const port = container.querySelector('#compute-password-port')
    const password = container.querySelector('#compute-password')

    expect(user?.compareDocumentPosition(port!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(port?.compareDocumentPosition(password!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(user?.closest('#compute-advanced-settings')).toBeNull()
    expect(password?.closest('#compute-advanced-settings')).toBeNull()
    expect(container.querySelector('#compute-advanced-settings')).toBeNull()
    expect(
      Array.from(container.querySelectorAll('button')).some((button) =>
        button.textContent?.includes('Advanced')
      )
    ).toBe(false)
  })

  it('never renders an unclassified raw failure message', async () => {
    useComputeStore.setState({
      createPasswordHost: vi.fn(async () => {
        throw new Error('ssh helper leaked a private path')
      })
    })
    await act(async () => root.render(<ComputeAddForm onCreated={vi.fn()} onCancel={vi.fn()} />))
    act(() => container.querySelector<HTMLInputElement>('input[value="password"]')?.click())
    act(() => {
      enter('compute-alias', 'cluster')
      enter('compute-password-user', 'researcher')
      enter('compute-password-port', '22')
      enter('compute-password', 'secret')
    })

    const add = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Add'
    )
    await act(async () => add?.click())

    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Could not add host.')
    expect(container.textContent).not.toContain('ssh helper leaked a private path')
  })
})
