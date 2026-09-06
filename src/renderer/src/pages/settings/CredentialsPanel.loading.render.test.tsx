// @vitest-environment jsdom
import { act } from 'react'
import { fireEvent, screen } from '@testing-library/react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DeviceCredentialsSnapshot } from '../../../../shared/settings'
import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'
import { CredentialsPanel, type CredentialsView } from './CredentialsPanel'
import { DeviceCredentialEditor } from './DeviceCredentialEditor'

let container: HTMLDivElement
let root: Root
const props = { onNavigate: vi.fn(), onOpenConnector: vi.fn(), onOpenProvider: vi.fn() }
const routes: CredentialsView[] = [{ kind: 'list' }, { kind: 'credential', id: 'saved' }]
const snapshot: DeviceCredentialsSnapshot = {
  credentials: [
    {
      id: 'saved',
      displayName: 'Saved token',
      kind: 'token',
      status: 'stored',
      needsSecret: false,
      consumerCount: 0,
      consumerNames: [],
      createdAt: 1,
      updatedAt: 1
    }
  ]
}

beforeEach(() => {
  // Use the actual credential slice actions: only the IPC response is controlled.
  useSettingsStore.setState({
    ...createInitialSettingsState(),
    loadConnectors: vi.fn().mockResolvedValue(undefined)
  })
  ;(window as unknown as { api: unknown }).api = {
    settings: {
      getGitHubTokenStatus: vi.fn().mockResolvedValue({ configured: false }),
      listDeviceCredentials: vi.fn().mockResolvedValue(snapshot)
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

describe('credential list availability', () => {
  it.each(routes)('shows a retryable read error instead of absent data on $kind', async (view) => {
    vi.mocked(window.api.settings.listDeviceCredentials).mockRejectedValueOnce(
      new Error('Credential document cannot be read')
    )
    await act(async () => root.render(<CredentialsPanel {...props} view={view} />))

    expect.soft(container.textContent).not.toContain('No Connector credentials yet.')
    expect.soft(container.textContent).not.toContain('This credential no longer exists.')
    expect.soft(container.querySelector('[role="alert"]')).not.toBeNull()
    const retry = screen.getByRole('button', { name: /retry/i })
    await act(async () => fireEvent.click(retry))
    expect(window.api.settings.listDeviceCredentials).toHaveBeenCalledTimes(2)
    expect(container.querySelector('[role="alert"]')).toBeNull()
    if (view.kind === 'list') expect(container.textContent).toContain('Saved token')
    else expect(screen.getByDisplayValue('Saved token')).toBeDefined()
  })

  it.each(routes)(
    'waits for the credential read before declaring absent data on $kind',
    async (view) => {
      let settle!: (value: DeviceCredentialsSnapshot) => void
      vi.mocked(window.api.settings.listDeviceCredentials).mockReturnValueOnce(
        new Promise((resolve) => {
          settle = resolve
        })
      )
      await act(async () => root.render(<CredentialsPanel {...props} view={view} />))
      const whilePending = container.textContent
      // Settle the read even if an assertion fails, keeping the shared store isolated across cases.
      await act(async () => settle(snapshot))
      expect(whilePending).not.toContain(
        view.kind === 'list' ? 'No Connector credentials yet.' : 'This credential no longer exists.'
      )
    }
  )
  it.each(['token', 'oauth'] as const)(
    'retains a saved %s identity while retrying a failed create projection',
    async (kind) => {
      const created = {
        ...snapshot.credentials[0]!,
        kind,
        ...(kind === 'oauth'
          ? {
              status: 'disconnected' as const,
              resourceUri: 'https://mcp.example.test/',
              transport: 'streamable_http' as const
            }
          : {})
      }
      useSettingsStore.setState({ encryptionAvailable: true, deviceCredentialsLoaded: true })
      window.api.settings.createDeviceCredential = vi
        .fn()
        .mockResolvedValue({ createdCredential: created })
      window.api.settings.updateDeviceCredential = vi
        .fn()
        .mockResolvedValue({ credentials: [created] })
      window.api.settings.authenticateDeviceCredential = vi
        .fn()
        .mockResolvedValue({ credentials: [created] })
      vi.mocked(window.api.settings.listDeviceCredentials).mockResolvedValue({
        credentials: [created]
      })
      const onDone = vi.fn()
      await act(async () =>
        root.render(
          <DeviceCredentialEditor
            initialKind={kind}
            initialResourceUri="https://mcp.example.test/"
            onDone={onDone}
            onCancel={vi.fn()}
          />
        )
      )
      fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'Saved token' } })
      if (kind === 'token') {
        const input = container.querySelector<HTMLInputElement>('input[type="password"]')!
        fireEvent.paste(input, {
          clipboardData: { getData: () => 'fictional-secret', setData: vi.fn() }
        })
      }
      await act(async () =>
        fireEvent.click(
          screen.getByRole('button', { name: kind === 'oauth' ? 'Save and sign in' : 'Save' })
        )
      )
      expect(container.textContent).toContain('Credential saved. The list could not refresh.')
      expect(container.textContent).toContain('Edit credential')
      expect(onDone).not.toHaveBeenCalled()
      expect(window.api.settings.authenticateDeviceCredential).not.toHaveBeenCalled()
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry' })))
      expect(container.querySelector('[role="alert"]')).toBeNull()
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })))
      expect(window.api.settings.createDeviceCredential).toHaveBeenCalledOnce()
      expect(window.api.settings.updateDeviceCredential).toHaveBeenCalledWith({
        id: created.id,
        displayName: 'Saved token'
      })
      expect(onDone).toHaveBeenCalledWith(created)
    }
  )

  it('keeps saved rows visible when a forced refresh fails', async () => {
    useSettingsStore.setState({
      deviceCredentials: snapshot.credentials,
      deviceCredentialsLoaded: true
    })
    await act(async () => root.render(<CredentialsPanel {...props} view={{ kind: 'list' }} />))
    vi.mocked(window.api.settings.listDeviceCredentials).mockRejectedValueOnce(
      new Error('Read failed')
    )
    await act(async () => {
      await useSettingsStore
        .getState()
        .loadDeviceCredentials(true)
        .catch(() => undefined)
    })
    expect(screen.getByText('Saved token')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDefined()
    expect(container.textContent).not.toContain('No Connector credentials yet.')
  })
})
