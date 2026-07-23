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

describe('ProviderStep', () => {
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

  it('returns to the previous step from the Back button', async () => {
    readyClaudeEnvironment()
    const onBack = vi.fn()

    await renderStep({ onBack })
    await clickButton(/^back$/i)

    expect(onBack).toHaveBeenCalledOnce()
  })

  it('verifies a pasted Claude setup-token before activating and advancing', async () => {
    const persistProvider = vi.fn().mockResolvedValue('builtin-claude-isolated')
    const loginIsolatedClaude = vi
      .fn()
      .mockResolvedValue({ ok: true, category: 'ok', applied: true })
    const setActiveProvider = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      persistProvider,
      loginIsolatedClaude,
      setActiveProvider
    })
    readyClaudeEnvironment()
    const onAdvance = vi.fn()

    await renderStep({ onAdvance })
    await selectOption('Provider type', 'Claude subscription')
    const input = container.querySelector<HTMLInputElement>('[aria-label="Claude setup token"]')
    if (!input) throw new Error('Claude setup token input not found')
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, 'sk-ant-valid')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await clickButton(/test & continue/i)

    expect(persistProvider).toHaveBeenCalledOnce()
    expect(loginIsolatedClaude).toHaveBeenCalledWith('sk-ant-valid')
    expect(setActiveProvider).toHaveBeenCalledWith('builtin-claude-isolated')
    expect(onAdvance).toHaveBeenCalledOnce()
  })

  it('shows a rejected Claude setup-token and stays on the provider step', async () => {
    const setActiveProvider = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      persistProvider: vi.fn().mockResolvedValue('builtin-claude-isolated'),
      loginIsolatedClaude: vi.fn().mockResolvedValue({
        ok: false,
        category: 'auth',
        applied: true,
        message: 'Claude rejected the setup token. Run `claude setup-token` again.'
      }),
      setActiveProvider
    })
    readyClaudeEnvironment()
    const onAdvance = vi.fn()

    await renderStep({ onAdvance })
    await selectOption('Provider type', 'Claude subscription')
    const input = container.querySelector<HTMLInputElement>('[aria-label="Claude setup token"]')
    if (!input) throw new Error('Claude setup token input not found')
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, 'sk-ant-expired')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await clickButton(/test & continue/i)

    expect(setActiveProvider).not.toHaveBeenCalled()
    expect(onAdvance).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Claude rejected the setup token')
  })

  it('prefills the existing Codex subscription profile for Codex on mount', async () => {
    useSettingsStore.setState(codexReadyState())

    // No Continue click needed anymore: entering the step with Codex selected and an untouched
    // form applies the prefill immediately.
    await renderStep()

    expect(container.querySelector('[aria-label="Provider type"]')?.textContent).toContain(
      'Codex subscription'
    )
    expect(container.querySelector('[aria-label="Codex authentication"]')?.textContent).toContain(
      'Use existing Codex profile'
    )
    expect(container.querySelector('[aria-label="Base URL"]')).toBeNull()
    expect(container.querySelector('[aria-label="Model"]')).toBeNull()
    expect(container.querySelector('[aria-label="API format"]')).toBeNull()
    expect(container.querySelector('[aria-label="API key"]')).toBeNull()
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
})
