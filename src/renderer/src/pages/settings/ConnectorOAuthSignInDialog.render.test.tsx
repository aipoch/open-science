// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'
import { ConnectorOAuthSignInDialog } from './ConnectorOAuthSignInDialog'

const server = {
  id: 'oauth-mcp',
  name: 'oauth-mcp',
  displayName: 'OAuth MCP',
  transport: 'streamable_http' as const,
  enabled: false,
  url: 'https://mcp.example.test',
  oauth: { hasTokens: false }
}

describe('ConnectorOAuthSignInDialog', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    useSettingsStore.setState({
      ...createInitialSettingsState(),
      authenticateCustomServer: vi.fn().mockResolvedValue(undefined),
      cancelCustomServerAuthentication: vi.fn().mockResolvedValue(undefined)
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

  it('starts authentication and reports successful completion', async () => {
    const onAuthenticated = vi.fn()
    await act(async () =>
      root.render(
        <ConnectorOAuthSignInDialog
          server={server}
          onAuthenticated={onAuthenticated}
          onFinish={vi.fn()}
        />
      )
    )

    expect(useSettingsStore.getState().authenticateCustomServer).toHaveBeenCalledWith({
      id: 'oauth-mcp'
    })
    expect(onAuthenticated).toHaveBeenCalledOnce()
  })

  it('cancels a pending attempt and ignores its later rejection', async () => {
    let rejectAuthentication!: (error: Error) => void
    useSettingsStore.setState({
      authenticateCustomServer: vi.fn(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectAuthentication = reject
          })
      )
    })
    const onFinish = vi.fn()
    act(() => {
      root.render(
        <ConnectorOAuthSignInDialog server={server} onAuthenticated={vi.fn()} onFinish={onFinish} />
      )
    })

    const cancel = [...document.body.querySelectorAll('button')].find(
      (button) => button.textContent === 'Cancel'
    )
    act(() => cancel?.click())

    expect(useSettingsStore.getState().cancelCustomServerAuthentication).toHaveBeenCalledWith({
      id: 'oauth-mcp'
    })
    expect(onFinish).toHaveBeenCalledOnce()

    await act(async () => rejectAuthentication(new Error('cancelled')))
    expect(document.body.textContent).not.toContain('cancelled')
  })

  it('does not restart a pending attempt when the server projection object refreshes', () => {
    useSettingsStore.setState({
      authenticateCustomServer: vi.fn(() => new Promise<void>(() => undefined))
    })
    act(() => {
      root.render(
        <ConnectorOAuthSignInDialog server={server} onAuthenticated={vi.fn()} onFinish={vi.fn()} />
      )
    })
    act(() => {
      root.render(
        <ConnectorOAuthSignInDialog
          server={{ ...server, displayName: 'Renamed OAuth MCP' }}
          onAuthenticated={vi.fn()}
          onFinish={vi.fn()}
        />
      )
    })

    expect(useSettingsStore.getState().authenticateCustomServer).toHaveBeenCalledOnce()
    expect(useSettingsStore.getState().cancelCustomServerAuthentication).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Sign in to Renamed OAuth MCP')
  })

  it('keeps a failed attempt open and retries from the same dialog', async () => {
    const authenticate = vi
      .fn()
      .mockRejectedValueOnce(new Error('Authorization denied'))
      .mockResolvedValueOnce(undefined)
    useSettingsStore.setState({ authenticateCustomServer: authenticate })
    const onAuthenticated = vi.fn()
    await act(async () =>
      root.render(
        <ConnectorOAuthSignInDialog
          server={server}
          onAuthenticated={onAuthenticated}
          onFinish={vi.fn()}
        />
      )
    )

    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(
      'Authorization denied'
    )
    const retry = [...document.body.querySelectorAll('button')].find(
      (button) => button.textContent === 'Try again'
    )
    await act(async () => retry?.click())

    expect(authenticate).toHaveBeenCalledTimes(2)
    expect(onAuthenticated).toHaveBeenCalledOnce()
  })
})
