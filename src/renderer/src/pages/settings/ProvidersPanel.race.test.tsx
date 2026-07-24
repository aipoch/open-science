// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'
import { ProvidersPanel } from './ProvidersPanel'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useSettingsStore.setState({
    ...createInitialSettingsState(),
    agentFrameworkId: 'claude-code',
    providers: [
      {
        id: 'builtin-claude-isolated',
        type: 'claude-isolated',
        name: 'Claude subscription',
        models: [],
        model: undefined,
        maskedKey: undefined,
        hasKey: false,
        lastValidatedAt: undefined,
        needsKey: false,
        supportsImageInput: false
      }
    ]
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

const render = (): void => {
  act(() => {
    root.render(
      <ProvidersPanel
        onCreateProvider={vi.fn()}
        onEditProvider={vi.fn()}
        onBusyProviderChange={vi.fn()}
      />
    )
  })
}

describe('ProvidersPanel: claude-isolated browser + paste race', () => {
  it('suppresses the cancel error when the user explicitly cancels the browser sign-in', async () => {
    // Browser login that never resolves on its own (simulates waiting for browser callback).
    let resolveLogin!: (r: { ok: boolean; category: string; applied?: boolean }) => void
    const browserLoginPromise = new Promise<{ ok: boolean; category: string; applied?: boolean }>(
      (res) => {
        resolveLogin = res
      }
    )

    useSettingsStore.setState({
      ...useSettingsStore.getState(),
      loginIsolatedClaudeBrowser: vi.fn(() => browserLoginPromise) as never,
      cancelIsolatedClaudeLogin: vi.fn() as never
    })

    render()

    // Click "Sign in with browser" to start the browser flow.
    const signInBtn = Array.from(document.body.querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-label') === 'Sign in with browser'
    )
    await act(async () => {
      signInBtn?.click()
    })

    // While pending, click the cancel button.
    const cancelBtn = Array.from(document.body.querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-label') === 'Cancel sign-in'
    )
    await act(async () => {
      cancelBtn?.click()
    })

    // Resolve the login as cancelled — should NOT show a "Sign-in cancelled" error.
    await act(async () => {
      resolveLogin({ ok: false, category: 'unknown', applied: false })
    })

    // No error text should be visible in the panel.
    expect(container.textContent).not.toContain('Sign-in cancelled')
    expect(container.textContent).not.toContain('Could not sign in')
  })

  it('auto-closes the paste modal when the browser callback succeeds', async () => {
    let resolveLogin!: (r: { ok: boolean; category: string; applied?: boolean }) => void
    const browserLoginPromise = new Promise<{ ok: boolean; category: string; applied?: boolean }>(
      (res) => {
        resolveLogin = res
      }
    )

    useSettingsStore.setState({
      ...useSettingsStore.getState(),
      loginIsolatedClaudeBrowser: vi.fn(() => browserLoginPromise) as never,
      cancelIsolatedClaudeLogin: vi.fn() as never,
      refreshPreflight: vi.fn(async () => {}) as never
    })

    render()

    // Start browser login — modal opens alongside.
    const signInBtn = Array.from(document.body.querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-label') === 'Sign in with browser'
    )
    await act(async () => {
      signInBtn?.click()
    })

    // The paste modal should be visible while the browser flow is pending.
    expect(document.body.querySelector('[role="alertdialog"]')).not.toBeNull()

    // Resolve the browser login as successful.
    await act(async () => {
      resolveLogin({ ok: true, category: 'ok', applied: true })
    })

    // Modal should be closed after success.
    await act(async () => {})
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull()
  })

  it('cancels the browser flow before submitting a pasted token', async () => {
    let resolveLogin!: (result: {
      ok: boolean
      category: string
      applied?: boolean
      cancelled?: boolean
    }) => void
    const browserLoginPromise = new Promise<{
      ok: boolean
      category: string
      applied?: boolean
      cancelled?: boolean
    }>((resolve) => {
      resolveLogin = resolve
    })
    const cancelIsolatedClaudeLogin = vi.fn().mockImplementation(async () => {
      resolveLogin({ ok: false, category: 'unknown', applied: false, cancelled: true })
    })
    const loginIsolatedClaude = vi
      .fn()
      .mockResolvedValue({ ok: true, category: 'ok', applied: true })

    useSettingsStore.setState({
      ...useSettingsStore.getState(),
      loginIsolatedClaudeBrowser: vi.fn(() => browserLoginPromise) as never,
      cancelIsolatedClaudeLogin: cancelIsolatedClaudeLogin as never,
      loginIsolatedClaude: loginIsolatedClaude as never
    })

    render()
    const signInBtn = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.getAttribute('aria-label') === 'Sign in with browser'
    )
    await act(async () => signInBtn?.click())

    const modal = document.body.querySelector<HTMLElement>('[role="alertdialog"]')
    const tokenInput = modal?.querySelector<HTMLInputElement>('[aria-label="Claude setup token"]')
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      )?.set
      setter?.call(tokenInput, 'sk-ant-pasted')
      tokenInput?.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const modalSignIn = Array.from(modal?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent?.trim() === 'Sign in'
    )
    await act(async () => modalSignIn?.click())

    expect(cancelIsolatedClaudeLogin).toHaveBeenCalledOnce()
    expect(loginIsolatedClaude).toHaveBeenCalledWith('sk-ant-pasted')
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull()
  })

  it('cancels an isolated browser login when the panel unmounts', async () => {
    const cancelIsolatedClaudeLogin = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      ...useSettingsStore.getState(),
      loginIsolatedClaudeBrowser: vi.fn(() => new Promise(() => undefined)) as never,
      cancelIsolatedClaudeLogin: cancelIsolatedClaudeLogin as never
    })

    render()
    const signInBtn = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.getAttribute('aria-label') === 'Sign in with browser'
    )
    await act(async () => signInBtn?.click())
    expect(cancelIsolatedClaudeLogin).not.toHaveBeenCalled()

    await act(async () => root.render(<div />))

    expect(cancelIsolatedClaudeLogin).toHaveBeenCalledOnce()
  })
})

describe('ProvidersPanel: claude-shared disconnect', () => {
  it('uses app-local wording when disconnect fails without a message', async () => {
    useSettingsStore.setState({
      ...useSettingsStore.getState(),
      providers: [
        {
          id: 'builtin-claude-shared',
          type: 'claude-shared',
          name: 'Claude subscription',
          models: [],
          model: undefined,
          maskedKey: undefined,
          hasKey: false,
          lastValidatedAt: 1,
          needsKey: false,
          supportsImageInput: false
        }
      ],
      logoutSharedClaude: vi.fn().mockResolvedValue({ ok: false, category: 'unknown' }) as never
    })

    render()
    const disconnect = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="Disconnect from Open Science"]'
    )
    await act(async () => disconnect?.click())

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Could not disconnect Claude from Open Science.'
    )
  })
})
