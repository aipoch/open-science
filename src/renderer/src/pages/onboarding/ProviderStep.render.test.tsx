// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ValidateProviderResult } from '../../../../shared/settings'
import { useSettingsStore } from '@/stores/settings-store'
import { ProviderStep } from './ProviderStep'
import {
  clickButton,
  codexReadyState,
  fillRequiredProviderFields,
  resetOnboardingStores,
  selectOption,
  stubWindowApi
} from './onboarding-test-utils'
import {
  createEmptyProviderFormValue,
  providerKindPatch,
  type ProviderFormValue
} from '../settings/provider-form-value'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  resetOnboardingStores()
  stubWindowApi()
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

type HarnessProps = {
  onBack?: () => void
  onAdvance?: () => void
  initialValue?: ProviderFormValue
}

// The provider draft lives in the wizard shell in production; the harness plays that role so the
// step can be mounted directly.
const Harness = ({
  onBack = vi.fn(),
  onAdvance = vi.fn(),
  initialValue
}: HarnessProps): React.JSX.Element => {
  const [value, setValue] = useState<ProviderFormValue>(
    () => initialValue ?? createEmptyProviderFormValue()
  )
  return (
    <ProviderStep formValue={value} setFormValue={setValue} onBack={onBack} onAdvance={onAdvance} />
  )
}

const renderStep = async (props: HarnessProps = {}): Promise<void> => {
  await act(async () => {
    root.render(<Harness {...props} />)
  })
}

const readyClaudeEnvironment = (): void => {
  useSettingsStore.setState({
    preflight: {
      claudeReady: true,
      opencodeReady: false,
      codexReady: false,
      agentFrameworkId: 'claude-code',
      agentReady: true,
      activeProviderReady: false
    },
    claude: { resolvedPath: '/bin/claude', version: '2.1.0' }
  })
}

const switchToIsolatedClaudeSignIn = async (): Promise<void> => {
  await selectOption('Provider type', 'Claude subscription')
  await selectOption('Claude authentication', 'Sign in separately')
}

const submitClaudeFallbackToken = async (token: string): Promise<void> => {
  const modal = document.body.querySelector<HTMLElement>('[role="alertdialog"]')
  const input = modal?.querySelector<HTMLInputElement>('[aria-label="Claude setup token"]')
  if (!input) throw new Error('Claude setup token input not found')

  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, token)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })

  const signIn = Array.from(modal?.querySelectorAll('button') ?? []).find(
    (button) => button.textContent?.trim() === 'Sign in'
  )
  await act(async () => signIn?.click())
}

describe('ProviderStep', () => {
  it('defaults an untouched custom gateway to the active framework API format', async () => {
    useSettingsStore.setState({
      agentFrameworkId: 'opencode',
      agentFrameworks: [
        {
          id: 'opencode',
          displayName: 'OpenCode',
          supportedApiTypes: ['anthropic', 'openai'],
          supportsSkills: true
        }
      ]
    })

    await renderStep()

    expect(container.querySelector('[aria-label="API format"]')?.textContent).toContain(
      '/v1/chat/completions'
    )
  })

  it('preserves a manually chosen API format when revisiting an otherwise blank draft', async () => {
    useSettingsStore.setState({
      agentFrameworkId: 'opencode',
      agentFrameworks: [
        {
          id: 'opencode',
          displayName: 'OpenCode',
          supportedApiTypes: ['anthropic', 'openai'],
          supportsSkills: true
        }
      ]
    })

    await renderStep({
      initialValue: {
        ...createEmptyProviderFormValue({ apiEndpoint: 'anthropic' }),
        providerFormTouched: true
      }
    })

    expect(container.querySelector('[aria-label="API format"]')?.textContent).toContain(
      '/v1/messages'
    )
  })

  it('preserves any user-edited custom draft when the active framework changes', async () => {
    await renderStep()

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Supports image input"]')?.click()
    })
    await act(async () => {
      useSettingsStore.setState({
        agentFrameworkId: 'codex',
        agentFrameworks: [
          {
            id: 'codex',
            displayName: 'Codex',
            supportedApiTypes: ['responses'],
            supportsSkills: true
          }
        ]
      })
    })

    expect(container.querySelector('[aria-label="Provider type"]')?.textContent).toContain(
      'Custom Gateway'
    )
    expect(
      container.querySelector('[aria-label="Supports image input"]')?.getAttribute('data-state')
    ).toBe('checked')
  })

  it('defers required-field errors until the first submit attempt', async () => {
    readyClaudeEnvironment()

    await renderStep()

    // Untouched form: no "required" errors yet, just the * markers.
    expect(container.textContent).not.toContain('Base URL is required.')

    await clickButton(/test & continue/i)

    // Submitting an incomplete form surfaces the errors and does not attempt to save/validate.
    expect(container.textContent).toContain('Base URL is required.')
    expect(useSettingsStore.getState().saveAndActivateProvider).not.toHaveBeenCalled()
  })

  it('advances to the notebook step after a successful validation', async () => {
    readyClaudeEnvironment()
    const onAdvance = vi.fn()

    await renderStep({ onAdvance })
    await fillRequiredProviderFields(container)
    await clickButton(/test & continue/i)

    expect(useSettingsStore.getState().saveAndActivateProvider).toHaveBeenCalled()
    expect(onAdvance).toHaveBeenCalledOnce()
  })

  it('includes a custom model effort preset in the provider request', async () => {
    readyClaudeEnvironment()
    const saveAndActivateProvider = vi
      .fn()
      .mockResolvedValue({ providerId: 'p1', validation: { ok: true, category: 'ok' } })
    useSettingsStore.setState({ saveAndActivateProvider })

    await renderStep({
      initialValue: createEmptyProviderFormValue({
        type: 'custom',
        name: 'Gateway',
        baseUrl: 'https://gateway.example',
        model: 'model-a',
        key: 'sk-test',
        reasoningEffortPreset: 'none-high'
      })
    })
    await clickButton(/test & continue/i)

    expect(saveAndActivateProvider).toHaveBeenCalledWith(
      expect.objectContaining({ reasoningEffortPreset: 'none-high' })
    )
  })

  it('returns to the previous step from the Back button', async () => {
    readyClaudeEnvironment()
    const onBack = vi.fn()

    await renderStep({ onBack })
    await clickButton(/^back$/i)

    expect(onBack).toHaveBeenCalledOnce()
  })

  it('runs the isolated Claude browser sign-in before activating and advancing', async () => {
    const persistProvider = vi.fn().mockResolvedValue('builtin-claude-isolated')
    const loginIsolatedClaudeBrowser = vi
      .fn()
      .mockResolvedValue({ ok: true, category: 'ok', applied: true })
    const setActiveProvider = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      persistProvider,
      loginIsolatedClaudeBrowser,
      setActiveProvider
    })
    readyClaudeEnvironment()
    const onAdvance = vi.fn()

    await renderStep({ onAdvance })
    await switchToIsolatedClaudeSignIn()
    await clickButton(/sign in & continue/i)

    expect(persistProvider).toHaveBeenCalledOnce()
    expect(loginIsolatedClaudeBrowser).toHaveBeenCalledOnce()
    expect(setActiveProvider).toHaveBeenCalledWith('builtin-claude-isolated')
    expect(onAdvance).toHaveBeenCalledOnce()
  })

  it('shows the fallback modal after a rejected isolated Claude browser sign-in', async () => {
    const setActiveProvider = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      persistProvider: vi.fn().mockResolvedValue('builtin-claude-isolated'),
      loginIsolatedClaudeBrowser: vi.fn().mockResolvedValue({
        ok: false,
        category: 'auth',
        applied: true,
        message: 'Claude rejected the sign-in. Try again.'
      }),
      setActiveProvider
    })
    readyClaudeEnvironment()
    const onAdvance = vi.fn()

    await renderStep({ onAdvance })
    await switchToIsolatedClaudeSignIn()
    await clickButton(/sign in & continue/i)

    expect(setActiveProvider).not.toHaveBeenCalled()
    expect(onAdvance).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Claude rejected the sign-in')
    expect(document.body.querySelector('[role="alertdialog"]')?.textContent).toContain('Step 1')
  })

  it('lets a pasted token cancel the browser flow and advance', async () => {
    let resolveBrowserLogin!: (result: ValidateProviderResult) => void
    const browserLogin = new Promise<ValidateProviderResult>((resolve) => {
      resolveBrowserLogin = resolve
    })
    const cancelIsolatedClaudeLogin = vi.fn().mockImplementation(async () => {
      resolveBrowserLogin({
        ok: false,
        category: 'unknown',
        applied: false,
        cancelled: true
      })
    })
    const loginIsolatedClaude = vi
      .fn()
      .mockResolvedValue({ ok: true, category: 'ok', applied: true })
    const setActiveProvider = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      persistProvider: vi.fn().mockResolvedValue('builtin-claude-isolated'),
      loginIsolatedClaudeBrowser: vi.fn(() => browserLogin),
      loginIsolatedClaude,
      cancelIsolatedClaudeLogin,
      setActiveProvider
    })
    readyClaudeEnvironment()
    const onAdvance = vi.fn()

    await renderStep({ onAdvance })
    await switchToIsolatedClaudeSignIn()
    await clickButton(/sign in & continue/i)
    await submitClaudeFallbackToken('sk-ant-pasted')

    expect(cancelIsolatedClaudeLogin).toHaveBeenCalledOnce()
    expect(loginIsolatedClaude).toHaveBeenCalledWith('sk-ant-pasted')
    expect(setActiveProvider).toHaveBeenCalledWith('builtin-claude-isolated')
    expect(onAdvance).toHaveBeenCalledOnce()
  })

  it('does not advance when a pasted Claude token result was not applied', async () => {
    let resolveBrowserLogin!: (result: ValidateProviderResult) => void
    const cancelIsolatedClaudeLogin = vi.fn().mockImplementation(async () => {
      resolveBrowserLogin({
        ok: false,
        category: 'unknown',
        applied: false,
        cancelled: true
      })
    })
    const setActiveProvider = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      persistProvider: vi.fn().mockResolvedValue('builtin-claude-isolated'),
      loginIsolatedClaudeBrowser: vi.fn(
        () =>
          new Promise<ValidateProviderResult>((resolve) => {
            resolveBrowserLogin = resolve
          })
      ),
      loginIsolatedClaude: vi.fn().mockResolvedValue({ ok: true, category: 'ok', applied: false }),
      cancelIsolatedClaudeLogin,
      setActiveProvider
    })
    readyClaudeEnvironment()
    const onAdvance = vi.fn()

    await renderStep({ onAdvance })
    await switchToIsolatedClaudeSignIn()
    await clickButton(/sign in & continue/i)
    await submitClaudeFallbackToken('sk-ant-stale')

    expect(setActiveProvider).not.toHaveBeenCalled()
    expect(onAdvance).not.toHaveBeenCalled()
    expect(document.body.querySelector('[role="alertdialog"]')?.textContent).toContain(
      'provider changed'
    )
  })

  it('runs shared Claude browser sign-in before activating and advancing', async () => {
    const persistProvider = vi.fn().mockResolvedValue('builtin-claude-shared')
    const loginSharedClaude = vi.fn().mockResolvedValue({ ok: true, category: 'ok', applied: true })
    const setActiveProvider = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({ persistProvider, loginSharedClaude, setActiveProvider })
    readyClaudeEnvironment()
    const onAdvance = vi.fn()

    await renderStep({ onAdvance })
    await selectOption('Provider type', 'Claude subscription')
    await clickButton(/sign in & continue/i)

    expect(persistProvider).toHaveBeenCalledOnce()
    expect(loginSharedClaude).toHaveBeenCalledOnce()
    expect(setActiveProvider).toHaveBeenCalledWith('builtin-claude-shared')
    expect(onAdvance).toHaveBeenCalledOnce()
  })

  it('prefills the Codex authentication import choice on mount', async () => {
    useSettingsStore.setState(codexReadyState())

    // No Continue click needed anymore: entering the step with Codex selected and an untouched
    // form applies the prefill immediately.
    await renderStep()

    expect(container.querySelector('[aria-label="Provider type"]')?.textContent).toContain(
      'Codex subscription'
    )
    expect(container.querySelector('[aria-label="Codex authentication"]')?.textContent).toContain(
      'Import existing Codex sign-in'
    )
    expect(container.querySelector('[aria-label="Base URL"]')).toBeNull()
    expect(container.querySelector('[aria-label="Model"]')).toBeNull()
    expect(container.querySelector('[aria-label="API format"]')).toBeNull()
    expect(container.querySelector('[aria-label="API key"]')).toBeNull()
  })

  it('defaults a Codex custom gateway to the Responses API', async () => {
    useSettingsStore.setState({
      ...codexReadyState(),
      agentFrameworks: [
        {
          id: 'codex',
          displayName: 'Codex',
          supportedApiTypes: ['responses'],
          supportsSkills: true
        }
      ]
    })

    await renderStep()
    await selectOption('Provider type', 'Custom Gateway')

    expect(container.querySelector('[aria-label="API format"]')?.textContent).toContain(
      '/v1/responses'
    )
  })

  it('keeps an existing provider draft when Codex is selected', async () => {
    useSettingsStore.setState(codexReadyState())
    const initialValue = {
      ...createEmptyProviderFormValue(),
      name: 'Existing gateway',
      baseUrl: 'https://gateway.example',
      model: 'gpt-5',
      key: 'sk-existing'
    }

    await renderStep({ initialValue })

    expect(container.querySelector<HTMLInputElement>('[aria-label="Base URL"]')?.value).toBe(
      'https://gateway.example'
    )
    expect(container.querySelector<HTMLInputElement>('[aria-label="Model"]')?.value).toBe('gpt-5')
    expect(container.querySelector('[aria-label="API format"]')?.textContent).toContain(
      '/v1/messages'
    )
  })

  it('lets Codex continue with a bridge-compatible official provider', async () => {
    useSettingsStore.setState({
      ...codexReadyState(),
      agentFrameworks: [
        {
          id: 'codex',
          displayName: 'Codex',
          supportedApiTypes: ['responses'],
          supportsSkills: true
        }
      ]
    })
    const saveAndActivateProvider = vi
      .fn()
      .mockResolvedValue({ providerId: 'p1', validation: { ok: true, category: 'ok' } })
    useSettingsStore.setState({ saveAndActivateProvider })

    await renderStep({
      initialValue: createEmptyProviderFormValue({
        ...providerKindPatch('official:kimiforcode'),
        key: 'sk-test'
      })
    })
    await clickButton(/test & continue/i)

    expect(container.textContent).not.toContain("isn't compatible with Codex")
    expect(saveAndActivateProvider).toHaveBeenCalledOnce()
  })

  // Switches the auth picker to the isolated "Sign in with Open Science" mode — the only path that
  // runs the browser login (loginIsolatedCodex).
  const switchToIsolatedSignIn = async (): Promise<void> => {
    await selectOption('Codex authentication', 'Sign in with Open Science')
  }

  it('runs the isolated Codex sign-in then advances', async () => {
    const persistProvider = vi.fn().mockResolvedValue('builtin-codex-isolated')
    const loginIsolatedCodex = vi
      .fn()
      .mockResolvedValue({ ok: true, category: 'ok', applied: true })
    const setActiveProvider = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      ...codexReadyState(),
      persistProvider,
      loginIsolatedCodex,
      setActiveProvider
    })
    const onAdvance = vi.fn()

    await renderStep({ onAdvance })
    await switchToIsolatedSignIn()
    await clickButton(/sign in & continue/i)

    // Persist happens before the browser login, and only a recorded success activates + advances.
    expect(persistProvider).toHaveBeenCalledOnce()
    expect(loginIsolatedCodex).toHaveBeenCalledOnce()
    expect(setActiveProvider).toHaveBeenCalledWith('builtin-codex-isolated')
    expect(onAdvance).toHaveBeenCalledOnce()
  })

  it('keeps the user on the provider step when the isolated sign-in fails', async () => {
    const setActiveProvider = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      ...codexReadyState(),
      persistProvider: vi.fn().mockResolvedValue('builtin-codex-isolated'),
      loginIsolatedCodex: vi.fn().mockResolvedValue({
        ok: false,
        category: 'auth',
        applied: true,
        message: 'Codex sign-in was cancelled.'
      }),
      setActiveProvider
    })
    const onAdvance = vi.fn()

    await renderStep({ onAdvance })
    await switchToIsolatedSignIn()
    await clickButton(/sign in & continue/i)

    // A failed sign-in never activates and never leaves the provider step; the reason is surfaced.
    expect(setActiveProvider).not.toHaveBeenCalled()
    expect(onAdvance).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Codex sign-in was cancelled.')
  })

  it('does not advance when an authenticated sign-in was discarded (applied:false)', async () => {
    const setActiveProvider = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      ...codexReadyState(),
      persistProvider: vi.fn().mockResolvedValue('builtin-codex-isolated'),
      // ok but discarded: the provider was switched/edited mid-login, so the store never recorded it.
      loginIsolatedCodex: vi.fn().mockResolvedValue({ ok: true, category: 'ok', applied: false }),
      setActiveProvider
    })
    const onAdvance = vi.fn()

    await renderStep({ onAdvance })
    await switchToIsolatedSignIn()
    await clickButton(/sign in & continue/i)

    expect(setActiveProvider).not.toHaveBeenCalled()
    expect(onAdvance).not.toHaveBeenCalled()
    expect(container.textContent).toContain('The Codex provider changed during sign-in')
  })

  it('cancels an in-flight isolated sign-in when the step unmounts', async () => {
    const cancelCodexLogin = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      ...codexReadyState(),
      persistProvider: vi.fn().mockResolvedValue('builtin-codex-isolated'),
      // Never resolves: the login is still pending when the wizard unmounts (app quit/relaunch).
      loginIsolatedCodex: vi.fn(() => new Promise<ValidateProviderResult>(() => undefined)),
      cancelCodexLogin
    })

    await renderStep()
    await switchToIsolatedSignIn()
    await clickButton(/sign in & continue/i)

    // Teardown must abort the main-process login so the next attempt starts clean.
    expect(cancelCodexLogin).not.toHaveBeenCalled()
    await act(async () => root.unmount())
    expect(cancelCodexLogin).toHaveBeenCalledOnce()

    // afterEach unmounts again on an already-unmounted root; remount a blank tree to keep it safe.
    root = createRoot(container)
  })

  it('cancels an in-flight isolated Claude sign-in when the step unmounts', async () => {
    const cancelIsolatedClaudeLogin = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      persistProvider: vi.fn().mockResolvedValue('builtin-claude-isolated'),
      loginIsolatedClaudeBrowser: vi.fn(() => new Promise<ValidateProviderResult>(() => undefined)),
      cancelIsolatedClaudeLogin
    })
    readyClaudeEnvironment()

    await renderStep()
    await switchToIsolatedClaudeSignIn()
    await clickButton(/sign in & continue/i)

    expect(cancelIsolatedClaudeLogin).not.toHaveBeenCalled()
    await act(async () => root.unmount())
    expect(cancelIsolatedClaudeLogin).toHaveBeenCalledOnce()
    root = createRoot(container)
  })

  it('cancels an in-flight shared Claude sign-in when the step unmounts', async () => {
    const cancelSharedClaudeLogin = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      persistProvider: vi.fn().mockResolvedValue('builtin-claude-shared'),
      loginSharedClaude: vi.fn(() => new Promise<ValidateProviderResult>(() => undefined)),
      cancelSharedClaudeLogin
    })
    readyClaudeEnvironment()

    await renderStep()
    await selectOption('Provider type', 'Claude subscription')
    await clickButton(/sign in & continue/i)

    expect(cancelSharedClaudeLogin).not.toHaveBeenCalled()
    await act(async () => root.unmount())
    expect(cancelSharedClaudeLogin).toHaveBeenCalledOnce()
    root = createRoot(container)
  })
})
