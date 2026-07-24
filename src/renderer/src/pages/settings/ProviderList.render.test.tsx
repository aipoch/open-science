// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ClaudeSubscriptionProviderId, ProviderView } from '../../../../shared/settings'
import { ProviderList } from './ProviderList'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const provider = (overrides: Partial<ProviderView> = {}): ProviderView => ({
  id: 'p1',
  type: 'custom',
  name: 'Gateway',
  baseUrl: 'https://g/v1',
  model: 'claude-sonnet-4-5',
  models: ['claude-sonnet-4-5'],
  supportsImageInput: false,
  maskedKey: 'sk-a…wxyz',
  hasKey: true,
  needsKey: false,
  lastValidatedAt: 1,
  ...overrides
})

const noop = vi.fn()

const renderList = (
  providers: ProviderView[],
  activeId?: string,
  busyId?: string,
  callbacks: {
    onCancel?: () => void
    onLogin?: () => void
    onLogout?: () => void
    isCodexLoginPending?: boolean
    isClaudeSharedLoginPending?: boolean
    onLoginSharedClaude?: () => void
    onCancelSharedClaudeLogin?: () => void
    onLogoutSharedClaude?: () => void
    isClaudeIsolatedLoginPending?: boolean
    onLoginIsolatedClaude?: () => void
    onCancelIsolatedClaudeLogin?: () => void
    onLoginIsolatedClaudePaste?: () => void
    onLogoutIsolatedClaude?: () => void
    claudeSubscriptionProviderId?: ClaudeSubscriptionProviderId
  } = {}
): void => {
  act(() => {
    root.render(
      <ProviderList
        providers={providers}
        activeProviderId={activeId}
        busyProviderId={busyId}
        onEdit={noop}
        onDelete={noop}
        onTest={noop}
        isCodexLoginPending={callbacks.isCodexLoginPending}
        onCancelCodexLogin={callbacks.onCancel}
        onLoginIsolatedCodex={callbacks.onLogin}
        onLogoutIsolatedCodex={callbacks.onLogout}
        isClaudeSharedLoginPending={callbacks.isClaudeSharedLoginPending}
        onLoginSharedClaude={callbacks.onLoginSharedClaude}
        onCancelSharedClaudeLogin={callbacks.onCancelSharedClaudeLogin}
        onLogoutSharedClaude={callbacks.onLogoutSharedClaude}
        isClaudeIsolatedLoginPending={callbacks.isClaudeIsolatedLoginPending}
        onLoginIsolatedClaude={callbacks.onLoginIsolatedClaude}
        onCancelIsolatedClaudeLogin={callbacks.onCancelIsolatedClaudeLogin}
        onLoginIsolatedClaudePaste={callbacks.onLoginIsolatedClaudePaste}
        onLogoutIsolatedClaude={callbacks.onLogoutIsolatedClaude}
        claudeSubscriptionProviderId={callbacks.claudeSubscriptionProviderId}
      />
    )
  })
}

// Finds an icon action button by its accessible name.
const buttonByLabel = (label: string): HTMLButtonElement | undefined =>
  Array.from(container.querySelectorAll('button')).find(
    (button) => button.getAttribute('aria-label') === label
  )

describe('ProviderList', () => {
  it('shows the masked key and model but never a plaintext key', () => {
    renderList([provider()])

    expect(container.querySelector('[data-slot="settings-list-row"]')).not.toBeNull()
    expect(container.textContent).toContain('sk-a…wxyz')
    expect(container.textContent).toContain('claude-sonnet-4-5')
    // A masked hint is displayed, but there is no way to render a real secret here.
    expect(container.textContent).not.toContain('sk-abcdefwxyz')
  })

  it('does not show any provider-level active/select control (selection is by model)', () => {
    renderList([provider()], 'p1')

    // No per-provider "Select"/"Selected" control, and no "active provider" wording.
    const labels = Array.from(container.querySelectorAll('button')).map((button) =>
      button.textContent?.trim()
    )
    expect(labels).not.toContain('Select')
    expect(container.textContent).not.toContain('Selected')
    expect(container.textContent).not.toContain('Active')
  })

  it('renders edit/delete/test as icon-only buttons with accessible labels', () => {
    renderList([provider()])

    const test = buttonByLabel('Test connection')
    const edit = buttonByLabel('Edit')
    const del = buttonByLabel('Delete')

    expect(test).toBeDefined()
    expect(edit).toBeDefined()
    expect(del).toBeDefined()
    // Icon-only: the button shows an SVG, not a visible text name.
    expect(edit?.querySelector('svg')).not.toBeNull()
    expect(del?.querySelector('svg')).not.toBeNull()
    expect(edit?.textContent?.trim()).toBe('')
    expect(del?.textContent?.trim()).toBe('')
  })

  it('disables delete for the selected provider so it cannot drop back to onboarding', () => {
    renderList([provider({ id: 'p1' }), provider({ id: 'p2', name: 'Other' })], 'p1')

    const deletes = Array.from(container.querySelectorAll('button')).filter(
      (button) => button.getAttribute('aria-label') === 'Delete'
    )
    // p1 is selected -> its delete is disabled; p2 is unselected with siblings -> enabled.
    expect((deletes[0] as HTMLButtonElement).disabled).toBe(true)
    expect((deletes[1] as HTMLButtonElement).disabled).toBe(false)
  })

  it('disables delete when only one provider remains', () => {
    renderList([provider()])

    expect((buttonByLabel('Delete') as HTMLButtonElement).disabled).toBe(true)
  })

  it('exposes an icon action name as a hover tooltip on focus', async () => {
    renderList([provider()])

    const edit = buttonByLabel('Edit')

    await act(async () => {
      edit?.focus()
    })

    // Radix opens the tooltip on focus and portals its content to the document body.
    expect(document.body.textContent).toContain('Edit')
  })

  it('flags a provider whose key needs re-entry', () => {
    renderList([provider({ needsKey: true })])

    expect(container.textContent).toContain('Key needs re-entry')
  })

  it('flags a provider whose last test failed with the reason', () => {
    renderList([
      provider({ lastValidatedAt: 1, lastValidationFailure: { at: 2, category: 'auth' } })
    ])

    expect(container.textContent).toContain('authentication rejected')
  })

  it('does not flag a provider whose latest validation succeeded', () => {
    // A stale failure older than the last success is not a warning.
    renderList([
      provider({ lastValidatedAt: 5, lastValidationFailure: { at: 2, category: 'auth' } })
    ])

    expect(container.textContent).not.toContain('Test failed')
  })

  it('marks a provider whose test passed with a verified check', () => {
    renderList([provider({ lastValidatedAt: 5 })])

    expect(container.querySelector('[aria-label="Connection verified"]')).not.toBeNull()
    expect(container.textContent).not.toContain('Test failed')
  })

  it('shows a testing state (and no check/warning) while a provider is being validated', () => {
    renderList([provider({ id: 'p1', lastValidatedAt: 5 })], undefined, 'p1')

    expect(container.textContent).toContain('Testing…')
    expect(container.querySelector('[aria-label="Connection verified"]')).toBeNull()
  })

  it('keeps shared Codex account management under Codex CLI', () => {
    renderList([
      provider({
        id: 'builtin-codex-shared',
        type: 'codex-shared',
        name: 'Existing Codex profile',
        models: [],
        model: undefined,
        maskedKey: undefined,
        hasKey: false
      })
    ])

    expect(container.textContent).toContain('Managed by Codex CLI')
    expect(buttonByLabel('Check Codex login')).toBeDefined()
    expect(buttonByLabel('Edit')).toBeDefined()
    expect(buttonByLabel('Delete')).toBeDefined()
    expect(buttonByLabel('Sign out')).toBeUndefined()
  })

  it('renders shared and isolated Codex modes as one subscription card', () => {
    renderList([
      provider({
        id: 'builtin-codex-shared',
        type: 'codex-shared',
        name: 'Existing Codex profile'
      }),
      provider({
        id: 'builtin-codex-isolated',
        type: 'codex-isolated',
        name: 'Open Science Codex login'
      })
    ])

    expect(container.querySelectorAll('[data-slot="settings-list-row"]')).toHaveLength(1)
    expect(container.textContent).toContain('Codex subscription')
  })

  it('offers sign in for an unverified isolated provider, cancel while pending, sign out after', () => {
    const onCancel = vi.fn()
    const onLogin = vi.fn()
    const onLogout = vi.fn()
    const isolated = provider({
      id: 'builtin-codex-isolated',
      type: 'codex-isolated',
      name: 'Open Science Codex login',
      models: [],
      model: undefined,
      maskedKey: undefined,
      hasKey: false,
      lastValidatedAt: undefined
    })

    // Not signed in yet: the explicit sign-in action is offered alongside the read-only check.
    renderList([isolated], undefined, undefined, { onLogin })
    act(() => buttonByLabel('Sign in')?.click())
    expect(onLogin).toHaveBeenCalledOnce()
    expect(buttonByLabel('Check Codex login')).toBeDefined()

    // While the browser login is open: cancel replaces the check and no second sign-in is offered.
    renderList([isolated], undefined, undefined, { onCancel, isCodexLoginPending: true })
    act(() => buttonByLabel('Cancel sign-in')?.click())
    expect(onCancel).toHaveBeenCalledOnce()
    expect(buttonByLabel('Sign in')).toBeUndefined()
    expect(buttonByLabel('Check Codex login')).toBeUndefined()

    // Signed in (verified): sign-in goes away, sign out is offered.
    renderList([{ ...isolated, lastValidatedAt: 1 }], undefined, undefined, { onLogout })
    act(() => buttonByLabel('Sign out')?.click())
    expect(onLogout).toHaveBeenCalledOnce()
    expect(buttonByLabel('Sign in')).toBeUndefined()
    expect(buttonByLabel('Edit')).toBeDefined()
    expect(buttonByLabel('Delete')).toBeDefined()
  })

  it('offers browser + setup-token sign-in for claude-isolated, cancel while pending, sign out after', () => {
    const onLoginIsolatedClaude = vi.fn()
    const onLoginIsolatedClaudePaste = vi.fn()
    const onCancelIsolatedClaudeLogin = vi.fn()
    const onLogoutIsolatedClaude = vi.fn()
    const isolated = provider({
      id: 'builtin-claude-isolated',
      type: 'claude-isolated',
      name: 'Claude subscription',
      models: [],
      model: undefined,
      maskedKey: undefined,
      hasKey: false,
      lastValidatedAt: undefined
    })

    // Not signed in: the browser sign-in is primary and a setup-token fallback sits beside it.
    renderList([isolated], undefined, undefined, {
      onLoginIsolatedClaude,
      onLoginIsolatedClaudePaste
    })
    act(() => buttonByLabel('Sign in with browser')?.click())
    expect(onLoginIsolatedClaude).toHaveBeenCalledOnce()
    act(() => buttonByLabel('Use setup token')?.click())
    expect(onLoginIsolatedClaudePaste).toHaveBeenCalledOnce()

    // While the browser sign-in is open: cancel is offered and the sign-in actions + test go away.
    renderList([isolated], undefined, undefined, {
      isClaudeIsolatedLoginPending: true,
      onCancelIsolatedClaudeLogin
    })
    act(() => buttonByLabel('Cancel sign-in')?.click())
    expect(onCancelIsolatedClaudeLogin).toHaveBeenCalledOnce()
    expect(buttonByLabel('Sign in with browser')).toBeUndefined()
    expect(buttonByLabel('Use setup token')).toBeUndefined()
    expect(buttonByLabel('Test connection')).toBeUndefined()
    // The pending row guides the user to the setup-token fallback in case the browser never opened.
    expect(container.textContent).toContain("Didn't open? Cancel and use a setup token")

    // Signed in (verified): sign-in actions go away, sign out is offered.
    renderList([{ ...isolated, lastValidatedAt: 1 }], undefined, undefined, {
      onLogoutIsolatedClaude
    })
    act(() => buttonByLabel('Sign out')?.click())
    expect(onLogoutIsolatedClaude).toHaveBeenCalledOnce()
    expect(buttonByLabel('Sign in with browser')).toBeUndefined()
  })

  it('swaps the claude-shared sign-in for a cancel action while the browser login is pending', () => {
    const onLoginSharedClaude = vi.fn()
    const onCancelSharedClaudeLogin = vi.fn()
    const onLogoutSharedClaude = vi.fn()
    const shared = provider({
      id: 'builtin-claude-shared',
      type: 'claude-shared',
      name: 'Claude subscription',
      models: [],
      model: undefined,
      maskedKey: undefined,
      hasKey: false,
      lastValidatedAt: undefined
    })

    // Not signed in: the browser sign-in is offered.
    renderList([shared], undefined, undefined, { onLoginSharedClaude })
    act(() => buttonByLabel('Sign in with browser')?.click())
    expect(onLoginSharedClaude).toHaveBeenCalledOnce()

    // While the browser sign-in is open: sign-in + test go away, cancel takes over (like OpenAI).
    renderList([shared], undefined, undefined, {
      isClaudeSharedLoginPending: true,
      onCancelSharedClaudeLogin
    })
    expect(buttonByLabel('Sign in with browser')).toBeUndefined()
    expect(buttonByLabel('Test connection')).toBeUndefined()
    act(() => buttonByLabel('Cancel sign-in')?.click())
    expect(onCancelSharedClaudeLogin).toHaveBeenCalledOnce()

    // Signed in (verified): sign-in actions go away, sign out is offered.
    renderList([{ ...shared, lastValidatedAt: 1 }], undefined, undefined, { onLogoutSharedClaude })
    act(() => buttonByLabel('Sign out')?.click())
    expect(onLogoutSharedClaude).toHaveBeenCalledOnce()
    expect(buttonByLabel('Sign in with browser')).toBeUndefined()
  })

  it('keeps the preferred Claude mode visible while a custom provider is active', () => {
    const shared = provider({
      id: 'builtin-claude-shared',
      type: 'claude-shared',
      name: 'Claude subscription',
      models: [],
      model: undefined,
      hasKey: false,
      lastValidatedAt: undefined
    })
    const isolated = provider({
      id: 'builtin-claude-isolated',
      type: 'claude-isolated',
      name: 'Claude subscription',
      models: [],
      model: undefined,
      hasKey: false,
      lastValidatedAt: undefined
    })

    renderList([shared, isolated, provider()], 'p1', undefined, {
      claudeSubscriptionProviderId: 'builtin-claude-isolated'
    })

    expect(buttonByLabel('Use setup token')).toBeDefined()
  })

  it('renders an empty state with no providers', () => {
    renderList([])

    expect(container.textContent).toContain('No providers yet')
  })

  it('badges the chat endpoint a provider speaks, defaulting to Anthropic when unset', () => {
    renderList([provider({ apiEndpoints: undefined })])

    const badge = container.querySelector('[aria-label="Speaks the /v1/messages endpoint"]')
    expect(badge).not.toBeNull()
    // Shows the raw route path (not a vendor name) plus a route icon, so it can't be read as a provider.
    expect(badge?.textContent).toContain('/v1/messages')
    expect(badge?.querySelector('svg')).not.toBeNull()
  })

  it('badges an OpenAI-compatible provider distinctly', () => {
    renderList([provider({ apiEndpoints: ['openai'] })])

    const badge = container.querySelector('[aria-label="Speaks the /v1/chat/completions endpoint"]')
    expect(badge).not.toBeNull()
    expect(badge?.textContent).toContain('/v1/chat/completions')
  })

  it('badges a Responses provider distinctly', () => {
    renderList([provider({ apiEndpoints: ['responses'] })])

    const badge = container.querySelector('[aria-label="Speaks the /v1/responses endpoint"]')
    expect(badge).not.toBeNull()
    expect(badge?.textContent).toContain('/v1/responses')
  })

  it('badges a dual-endpoint provider with both routes', () => {
    renderList([provider({ apiEndpoints: ['anthropic', 'openai'] })])

    expect(container.textContent).toContain('/v1/messages · /v1/chat/completions')
  })
})
