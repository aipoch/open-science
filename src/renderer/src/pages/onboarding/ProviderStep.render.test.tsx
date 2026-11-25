// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { OFFICIAL_VENDORS, resolveVendorModelApiEndpoints } from '@aipoch/providers'
import { fireEvent } from '@testing-library/react'
import { getOfficialVendorModelIds } from '../../../../shared/provider-model-policy'
import type {
  ProviderView,
  ValidateProviderResult,
  XaiOAuthLoginResult
} from '../../../../shared/settings'
import { i18next } from '@/i18n'
import { useSettingsStore } from '@/stores/settings-store'
import { ProviderStep } from './ProviderStep'

vi.mock('@/components/react-bits/Silk', () => ({
  default: () => <div data-testid="silk" />
}))
import { useProviderStepOperation } from './use-provider-step-operation'
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
  useSettingsStore.setState({
    detectClaude: vi
      .fn()
      .mockResolvedValue({ found: true, path: '/bin/claude', version: '2.1.209' })
  })
  stubWindowApi()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  delete (window as unknown as { api?: unknown }).api
  await i18next.changeLanguage('en')
})

type HarnessProps = {
  onBack?: () => void
  onAdvance?: () => void
  initialValue?: ProviderFormValue
  variant?: 'form' | 'quick'
}

// The provider draft lives in the wizard shell in production; the harness plays that role so the
// step can be mounted directly.
const Harness = ({
  onBack = vi.fn(),
  onAdvance = vi.fn(),
  initialValue,
  variant = 'form'
}: HarnessProps): React.JSX.Element => {
  const [value, setValue] = useState<ProviderFormValue>(
    () => initialValue ?? createEmptyProviderFormValue()
  )
  const operation = useProviderStepOperation()
  return (
    <ProviderStep
      operation={operation}
      formValue={value}
      setFormValue={setValue}
      onBack={onBack}
      onAdvance={onAdvance}
      variant={variant}
    />
  )
}

const renderStep = async (props: HarnessProps = {}): Promise<void> => {
  await act(async () => {
    root.render(<Harness {...props} />)
  })
}

const readyClaudeEnvironment = (): void => {
  useSettingsStore.setState({
    agentFrameworkId: 'claude-code',
    preflight: {
      claudeReady: true,
      opencodeReady: false,
      codexReady: false,
      codebuddyReady: false,
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
  it('lists every official vendor as a distinct quick-connect card', async () => {
    await renderStep({ variant: 'quick' })

    for (const vendor of OFFICIAL_VENDORS) {
      const cards = container.querySelectorAll(`.onboarding-provider-card-${vendor.id}`)
      expect(cards, vendor.label).toHaveLength(1)
      expect(cards[0].querySelector('h2')?.textContent).toBe(vendor.label)
    }
    expect(container.querySelectorAll('.onboarding-provider-card')).toHaveLength(
      OFFICIAL_VENDORS.length + 1
    )
    expect(container.textContent).toContain('Custom Gateway')
  })

  it('keeps Silk mounted across hover and pause', async () => {
    await renderStep({ variant: 'quick' })

    const card = container.querySelector<HTMLElement>('.onboarding-provider-card-openai')!
    const silk = card.querySelector('[data-testid="silk"]')
    expect(silk).not.toBeNull()

    fireEvent.pointerEnter(card, { pointerType: 'touch' })
    expect(card.querySelector('.onboarding-provider-silk.is-active')).toBeNull()
    fireEvent.pointerLeave(card, { pointerType: 'touch' })
    fireEvent.pointerEnter(card, { pointerType: 'mouse' })
    expect(card.querySelector('[data-testid="silk"]')).not.toBeNull()
    expect(card.querySelector('.onboarding-provider-silk')?.classList.contains('is-active')).toBe(
      true
    )

    fireEvent.pointerLeave(card, { pointerType: 'mouse' })
    expect(card.querySelector('[data-testid="silk"]')).toBe(silk)
    expect(card.querySelector('.onboarding-provider-silk.is-active')).toBeNull()
  })

  it('keeps quick-connect API keys separate and submits the selected vendor', async () => {
    readyClaudeEnvironment()
    const saveValidatedProvider = vi
      .fn()
      .mockResolvedValue({ providerId: 'p1', validation: { ok: true, category: 'ok' } })
    useSettingsStore.setState({ saveValidatedProvider, setActiveProvider: vi.fn() })
    await renderStep({ variant: 'quick' })
    const deepseek = container.querySelector<HTMLInputElement>('#onboarding-key-deepseek')
    const minimax = container.querySelector<HTMLInputElement>('#onboarding-key-minimax')
    expect(deepseek).not.toBeNull()
    expect(minimax).not.toBeNull()
    await act(async () => {
      fireEvent.change(deepseek!, { target: { value: 'test-deepseek-key' } })
      fireEvent.change(minimax!, { target: { value: 'test-minimax-key' } })
    })
    expect(deepseek!.value).toBe('test-deepseek-key')
    expect(minimax!.value).toBe('test-minimax-key')
    await act(async () => fireEvent.submit(deepseek!.closest('form')!))
    expect(saveValidatedProvider).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'official', vendorId: 'deepseek', key: 'test-deepseek-key' })
    )
  })

  it('replaces a failed installation with the next card’s key validation error', async () => {
    const install = vi.fn().mockResolvedValue({ ok: false, error: 'Installation interrupted' })
    useSettingsStore.setState({
      installClaude: install,
      detectClaude: vi.fn().mockResolvedValue({ found: false }),
      saveValidatedProvider: vi.fn().mockResolvedValue({
        validation: { ok: false, category: 'auth', status: 401, message: 'upstream diagnostic' }
      })
    })
    await renderStep({ variant: 'quick' })
    await clickButton(/Continue with Anthropic/)
    const message = (): string | undefined =>
      container.querySelector('.onboarding-quick-feedback [role="alert"]')?.textContent
    expect(message()).toBe('Could not install Claude Code. Try again.')
    const details = (): HTMLDetailsElement =>
      container.querySelector('.onboarding-quick-feedback details')!
    expect(details().open).toBe(false)
    expect(details().textContent).toContain('Installation interrupted')
    const input = container.querySelector<HTMLInputElement>('#onboarding-key-deepseek')!
    await act(async () => fireEvent.change(input, { target: { value: 'rejected' } }))
    await act(async () => fireEvent.submit(input.form!))
    expect(message()).toBe('Authentication failed. Check the API key.')
    expect(details().open).toBe(false)
    expect(details().textContent).toContain('HTTP 401')
    expect(details().textContent).toContain('upstream diagnostic')
    expect(install).toHaveBeenCalledTimes(1)
    expect(container.querySelector('.onboarding-quick-feedback')?.textContent).not.toContain(
      'Installation interrupted'
    )
  })

  it('shows a loading indicator while testing a quick-connect API key', async () => {
    readyClaudeEnvironment()
    let resolveSave: ((value: ValidateProviderResult) => void) | undefined
    const saveValidatedProvider = vi.fn(
      () =>
        new Promise<{ providerId: string; validation: ValidateProviderResult }>((resolve) => {
          resolveSave = () =>
            resolve({ providerId: 'p1', validation: { ok: true, category: 'ok' } })
        })
    )
    useSettingsStore.setState({ saveValidatedProvider, setActiveProvider: vi.fn() })
    await renderStep({ variant: 'quick' })

    const deepseek = container.querySelector<HTMLInputElement>('#onboarding-key-deepseek')!
    await act(async () => {
      fireEvent.change(deepseek, { target: { value: 'test-deepseek-key' } })
      fireEvent.submit(deepseek.closest('form')!)
    })

    const submitButton = deepseek.closest('form')?.querySelector('button[type="submit"]')
    expect(submitButton?.getAttribute('aria-label')).toBe('Test connection and connect')
    expect((submitButton as HTMLButtonElement | null)?.disabled).toBe(true)
    expect(submitButton?.querySelector('.animate-spin')).not.toBeNull()
    const minimax = container.querySelector<HTMLInputElement>('#onboarding-key-minimax')!
    expect(minimax.closest('form')?.querySelector('.animate-spin')).toBeNull()

    await act(async () => {
      resolveSave?.({ ok: true, category: 'ok' })
    })
  })

  it('offers Claude subscription and switches to Claude Code before signing in', async () => {
    const setAgentFramework = vi.fn(async () => {
      useSettingsStore.setState({ agentFrameworkId: 'claude-code' })
    })
    const persistProvider = vi.fn().mockResolvedValue('claude-account')
    const loginSharedClaude = vi.fn(async () => {
      expect(useSettingsStore.getState().agentFrameworkId).toBe('claude-code')
      return { ok: true, category: 'ok' as const }
    })
    const setActiveProvider = vi.fn().mockResolvedValue(undefined)
    const onAdvance = vi.fn()
    useSettingsStore.setState({
      agentFrameworkId: 'open-science-agent',
      setAgentFramework,
      persistProvider,
      loginSharedClaude,
      setActiveProvider
    })
    await renderStep({ variant: 'quick', onAdvance })
    const card = container.querySelector('.onboarding-provider-card-anthropic')!
    expect(card.textContent).toContain('Use your eligible Claude subscription')
    expect(card.querySelector('input')).toBeNull()
    await clickButton(/Continue with Anthropic/)
    expect(setAgentFramework).toHaveBeenCalledWith('claude-code', { runtimeAlreadyDetected: true })
    expect(useSettingsStore.getState().installClaude).not.toHaveBeenCalled()
    expect(persistProvider).toHaveBeenCalledWith(expect.objectContaining({ type: 'claude-shared' }))
    expect(loginSharedClaude).toHaveBeenCalledOnce()
    expect(setActiveProvider).toHaveBeenCalledWith('claude-account')
    expect(onAdvance).toHaveBeenCalledOnce()
  })

  it('keeps the authorizing card open and ignores a cancelled login even after retry', async () => {
    const attempts: Array<(result: ValidateProviderResult) => void> = []
    const cancelSharedClaudeLogin = vi.fn().mockResolvedValue(undefined)
    const setActiveProvider = vi.fn().mockResolvedValue(undefined)
    const onAdvance = vi.fn()
    useSettingsStore.setState({
      persistProvider: vi.fn().mockResolvedValue('claude-account'),
      loginSharedClaude: vi.fn(
        () => new Promise<ValidateProviderResult>((resolve) => attempts.push(resolve))
      ),
      cancelSharedClaudeLogin,
      setActiveProvider
    })
    await renderStep({ variant: 'quick', onAdvance })
    const card = container.querySelector('.onboarding-provider-card-anthropic')!
    await clickButton(/Continue with Anthropic/)
    fireEvent.pointerLeave(card, { pointerType: 'mouse' })
    expect(container.querySelectorAll('.is-authorizing')).toHaveLength(1)
    expect(card.classList.contains('is-authorizing')).toBe(true)
    expect(card.querySelector('.onboarding-provider-silk.is-active')).toBeNull()
    const cancel = card.querySelector<HTMLButtonElement>('button[aria-label="Cancel sign-in"]')!
    expect(cancel.previousElementSibling?.textContent).toBe('Signing in…')
    await act(async () => cancel.click())
    expect(cancelSharedClaudeLogin).toHaveBeenCalledOnce()
    expect(card.classList.contains('is-authorizing')).toBe(false)
    await clickButton(/Continue with Anthropic/)
    await act(async () => attempts[0]({ ok: true, category: 'ok' }))
    expect(setActiveProvider).not.toHaveBeenCalled()
    expect(onAdvance).not.toHaveBeenCalled()
    expect(card.classList.contains('is-authorizing')).toBe(true)
    await act(async () => attempts[1]({ ok: true, category: 'ok' }))
    expect(onAdvance).toHaveBeenCalledOnce()
  })

  it.each([
    ['local launch error', { cliLaunchFailed: true }, 1],
    ['account or network rejection', {}, 0],
    ['cancelled authorization', { cancelled: true }, 0]
  ] as const)('only repairs a broken CLI: %s', async (_name, flags, count) => {
    const login = vi.fn().mockResolvedValue({ ok: false, category: 'unknown', ...flags })
    useSettingsStore.setState({
      loginSharedClaude: login,
      persistProvider: vi.fn().mockResolvedValue('claude')
    })
    const onAdvance = vi.fn()
    await renderStep({ variant: 'quick', onAdvance })
    await clickButton(/Continue with Anthropic/)
    expect(useSettingsStore.getState().installClaude).toHaveBeenCalledTimes(count)
    expect(login).toHaveBeenCalledTimes(1 + count)
    expect(onAdvance).not.toHaveBeenCalled()
  })

  it('shows install failures below the cards and retries without advancing a cancelled installation', async () => {
    const pending = Promise.withResolvers<{ installId: string; ok: boolean }>()
    const login = vi.fn().mockResolvedValue({ ok: true, category: 'ok' })
    const install = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: 'Download interrupted' })
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue({ ok: true })
    const cancel = vi.fn(async () => {
      pending.resolve({ installId: 'second', ok: true })
    })
    const onAdvance = vi.fn()
    useSettingsStore.setState({
      detectClaude: vi.fn().mockResolvedValue({ found: false }),
      installClaude: install,
      loginSharedClaude: login,
      cancelSharedClaudeLogin: cancel,
      persistProvider: vi.fn().mockResolvedValue('claude'),
      setActiveProvider: vi.fn()
    })
    await renderStep({ variant: 'quick', onAdvance })
    const card = container.querySelector('.onboarding-provider-card-anthropic')!
    await clickButton(/Continue with Anthropic/)
    expect(container.querySelector('.onboarding-quick-feedback details pre')?.textContent).toBe(
      'Download interrupted'
    )
    expect(login).not.toHaveBeenCalled()
    await clickButton(/Continue with Anthropic/)
    expect(card.querySelector('progress')?.hasAttribute('value')).toBe(false)
    await act(async () =>
      card.querySelector<HTMLButtonElement>('[aria-label="Cancel sign-in"]')!.click()
    )
    expect(cancel).toHaveBeenCalledWith(install.mock.calls[1][2])
    expect(login).not.toHaveBeenCalled()
    expect(onAdvance).not.toHaveBeenCalled()
    await clickButton(/Continue with Anthropic/)
    expect(login).toHaveBeenCalledOnce()
    expect(onAdvance).toHaveBeenCalledOnce()
  })

  it('stops subscription login if the compatible framework cannot be selected', async () => {
    const persistProvider = vi.fn()
    const loginSharedClaude = vi.fn()
    const onAdvance = vi.fn()
    useSettingsStore.setState({
      agentFrameworkId: 'open-science-agent',
      setAgentFramework: vi.fn().mockRejectedValue(new Error('framework save failed')),
      persistProvider,
      loginSharedClaude
    })
    await renderStep({ variant: 'quick', onAdvance })
    await clickButton(/Continue with Anthropic/)
    expect(container.textContent).toContain('framework save failed')
    expect(persistProvider).not.toHaveBeenCalled()
    expect(loginSharedClaude).not.toHaveBeenCalled()
    expect(onAdvance).not.toHaveBeenCalled()
    expect(container.querySelector('button:disabled')).toBeNull()
  })

  it('can choose an OpenAI subscription after selecting Claude Code', async () => {
    const setAgentFramework = vi.fn(async () => {
      useSettingsStore.setState({ agentFrameworkId: 'codex' })
    })
    const onAdvance = vi.fn()
    const saveProvider = vi
      .fn()
      .mockResolvedValue({ providerId: 'openai-account', validation: { ok: true, category: 'ok' } })
    const setActiveProvider = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      agentFrameworkId: 'claude-code',
      setAgentFramework,
      saveProvider,
      setActiveProvider
    })
    await renderStep({ variant: 'quick', onAdvance })
    await clickButton(/^Import existing Codex sign-in$/)
    expect(setAgentFramework).toHaveBeenCalledWith('codex')
    expect(saveProvider).toHaveBeenCalledWith(expect.objectContaining({ type: 'codex-shared' }))
    expect(onAdvance).toHaveBeenCalledOnce()
  })

  it('keeps isolated Codex sign-in on the card through preparation failure, cancellation and retry', async () => {
    const pending = Promise.withResolvers<{ ok: boolean; installId: string }>()
    const prepare = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: 'Download interrupted' })
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue({ ok: true })
    const login = vi.fn().mockResolvedValue({ ok: true, category: 'ok' })
    const cancel = vi.fn(async () => {
      pending.resolve({ ok: true, installId: 'cancelled' })
    })
    const onAdvance = vi.fn()
    useSettingsStore.setState({
      ...codexReadyState(),
      installCodex: prepare,
      cancelCodexLogin: cancel,
      loginIsolatedCodex: login,
      persistProvider: vi.fn().mockResolvedValue('isolated'),
      setActiveProvider: vi.fn()
    })
    await renderStep({ variant: 'quick', onAdvance })
    const card = container.querySelector('.onboarding-provider-card-openai')!
    await clickButton(/^Sign in with Open-Science$/)
    expect(container.querySelector('.onboarding-quick-feedback details pre')?.textContent).toBe(
      'Download interrupted'
    )
    await clickButton(/^Retry$/)
    await act(async () => {
      const states = useSettingsStore.getState().installStates
      useSettingsStore.setState({
        installStates: {
          ...states,
          codex: {
            ...states.codex,
            installProgress: {
              kind: 'progress',
              phase: 'downloading',
              installId: 'x',
              receivedBytes: 1,
              totalBytes: 4
            }
          }
        }
      })
    })
    expect(card.querySelector('progress')?.value).toBe(0.25)
    await act(async () =>
      card.querySelector<HTMLButtonElement>('[aria-label="Cancel sign-in"]')!.click()
    )
    expect(cancel).toHaveBeenCalledWith(prepare.mock.calls[1][1])
    expect(login).not.toHaveBeenCalled()
    expect(onAdvance).not.toHaveBeenCalled()
    await clickButton(/^Sign in with Open-Science$/)
    expect(login).toHaveBeenCalledOnce()
    expect(onAdvance).toHaveBeenCalledOnce()
  })

  it('allows dismissing a failed Codex import and manually switching to cancellable browser sign-in', async () => {
    let finishLogin!: (result: ValidateProviderResult) => void
    const loginIsolatedCodex = vi.fn(
      () =>
        new Promise<ValidateProviderResult>((resolve) => {
          finishLogin = resolve
        })
    )
    const rawError =
      "Error invoking remote method 'settings:upsert-provider': Error: Open-Science could not find a file-backed Codex credential to import. Your existing Codex sign-in may be stored in the system credential store, which Open-Science cannot import from. Continue with the Open-Science Codex sign-in instead."
    const saveProvider = vi.fn().mockRejectedValue(new Error(rawError))
    const persistProvider = vi.fn().mockResolvedValue('builtin-codex-isolated')
    const cancelCodexLogin = vi.fn().mockResolvedValue(undefined)
    const setActiveProvider = vi.fn().mockResolvedValue(undefined)
    const onAdvance = vi.fn()
    useSettingsStore.setState({
      ...codexReadyState(),
      saveProvider,
      persistProvider,
      loginIsolatedCodex,
      cancelCodexLogin,
      setActiveProvider
    })
    await renderStep({ variant: 'quick', onAdvance })
    const card = container.querySelector('.onboarding-provider-card-openai')!
    const [importButton, signInButton] = card.querySelectorAll<HTMLButtonElement>(
      '[aria-label="Codex authentication"] button'
    )
    expect(importButton?.textContent).toBe('Import existing Codex sign-in')
    expect(signInButton?.textContent).toBe('Sign in with Open-Science')
    expect(card.textContent).not.toContain('Continue with OpenAI')
    await act(async () => importButton.click())
    expect(saveProvider).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'codex-shared', reimportCodexAuthentication: true })
    )
    const warning = container.querySelector('[data-notice-level="warning"]')!
    const summary = warning.querySelector('[role="alert"]')!
    expect(summary.textContent).toContain('No Codex sign-in file was found')
    expect(summary.textContent).not.toContain(rawError)
    const details = warning.querySelector('details')!
    expect(details.open).toBe(false)
    expect(details.querySelector('pre')?.textContent).toBe(rawError)
    expect(warning.querySelector('svg')).not.toBeNull()
    expect(loginIsolatedCodex).not.toHaveBeenCalled()
    expect(warning.closest('.onboarding-quick-feedback')).not.toBeNull()
    await act(async () =>
      warning.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]')!.click()
    )
    expect(container.contains(warning)).toBe(false)
    await clickButton(/^Sign in with Open-Science$/)
    expect(saveProvider).toHaveBeenCalledTimes(1)
    expect(persistProvider).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'codex-isolated' })
    )
    expect(loginIsolatedCodex).toHaveBeenCalledOnce()
    fireEvent.pointerLeave(card, { pointerType: 'mouse' })
    expect(card.classList.contains('is-authorizing')).toBe(true)
    expect(card.querySelector('button[aria-busy="true"]')).not.toBeNull()
    const cancel = card.querySelector<HTMLButtonElement>('[aria-label="Cancel sign-in"]')!
    await act(async () => cancel.click())
    expect(cancelCodexLogin).toHaveBeenCalledOnce()
    await act(async () => finishLogin({ ok: true, category: 'ok' }))
    expect(setActiveProvider).not.toHaveBeenCalled()
    expect(onAdvance).not.toHaveBeenCalled()
    expect(
      Array.from(card.querySelectorAll('button')).find(
        (button) => button.textContent === 'Sign in with Open-Science'
      )?.disabled
    ).toBe(false)
  })

  it('keeps the Claude API-key option without changing the framework', async () => {
    const setAgentFramework = vi.fn()
    useSettingsStore.setState({ agentFrameworkId: 'open-science-agent', setAgentFramework })
    await renderStep({ variant: 'quick' })
    const card = container.querySelector('.onboarding-provider-card-anthropic')!
    const keyButton = Array.from(card.querySelectorAll('button')).find(
      (button) => button.textContent === 'Have an API key?'
    )!
    await act(async () => keyButton.click())
    expect(card.querySelector('input')).not.toBeNull()
    expect(setAgentFramework).not.toHaveBeenCalled()
  })

  it('offers OpenCode Go and Zen when OpenCode is the active framework', async () => {
    useSettingsStore.setState({
      agentFrameworkId: 'opencode',
      agentFrameworks: [
        {
          id: 'opencode',
          displayName: 'OpenCode',
          supportedApiTypes: ['chat-completions', 'messages'],
          supportsSkills: true
        }
      ]
    })

    await renderStep()

    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Provider type"]')
    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(document.body.textContent).toContain('OpenCode Go')
    expect(document.body.textContent).toContain('OpenCode Zen')
  })

  it('defaults an untouched custom gateway to the active framework API format', async () => {
    useSettingsStore.setState({
      agentFrameworkId: 'opencode',
      agentFrameworks: [
        {
          id: 'opencode',
          displayName: 'OpenCode',
          supportedApiTypes: ['chat-completions', 'messages'],
          supportsSkills: true
        }
      ]
    })

    await renderStep()

    expect(container.querySelector('[aria-label="API format"]')?.textContent).toContain(
      '/v1/chat/completions'
    )
  })

  it('reuses an active validated provider configured before Web onboarding', async () => {
    const onAdvance = vi.fn()
    const addOnboardingKiloProvider = vi.fn()
    const provider: ProviderView = {
      id: 'provider-1',
      type: 'custom',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-pro',
      apiEndpoints: ['chat-completions'],
      models: ['deepseek-v4-pro'],
      supportsImageInput: false,
      hasKey: true,
      needsKey: false,
      lastValidatedAt: 1
    }
    useSettingsStore.setState({
      agentFrameworkId: 'opencode',
      agentFrameworks: [
        {
          id: 'opencode',
          displayName: 'OpenCode',
          supportedApiTypes: ['chat-completions', 'messages'],
          supportsSkills: true
        }
      ],
      activeProviderId: provider.id,
      providers: [provider],
      addOnboardingKiloProvider
    })

    await renderStep({ onAdvance })

    expect(container.textContent).toContain('Already configured: DeepSeek (deepseek-v4-pro)')
    await clickButton(/use configured provider/i)

    expect(onAdvance).toHaveBeenCalledOnce()
    expect(addOnboardingKiloProvider).not.toHaveBeenCalled()
  })

  it('preserves a manually chosen API format when revisiting an otherwise blank draft', async () => {
    useSettingsStore.setState({
      agentFrameworkId: 'opencode',
      agentFrameworks: [
        {
          id: 'opencode',
          displayName: 'OpenCode',
          supportedApiTypes: ['chat-completions', 'messages'],
          supportsSkills: true
        }
      ]
    })

    await renderStep({
      initialValue: {
        ...createEmptyProviderFormValue({ apiEndpoint: 'messages' }),
        providerFormTouched: true
      }
    })

    expect(container.querySelector('[aria-label="API format"]')?.textContent).toContain(
      '/v1/messages'
    )
  })

  it('preserves any user-edited custom draft when the active framework changes', async () => {
    await renderStep()

    await clickButton(/Advanced settings/)
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

  it('localizes an application-generated provider limit error', async () => {
    readyClaudeEnvironment()
    useSettingsStore.setState({
      saveAndActivateProvider: vi.fn().mockRejectedValue(new Error('Provider limit of 64 reached.'))
    })

    await renderStep()
    await fillRequiredProviderFields(container)
    await act(async () => i18next.changeLanguage('zh-Hans'))
    await clickButton(/测试并继续/)

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      '服务商数量已达到 64 个的上限。'
    )
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

  it('includes custom model token limits in the provider request', async () => {
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
        contextWindow: '400000',
        maxInputTokens: '272000',
        maxOutputTokens: '128000'
      })
    })
    await clickButton(/test & continue/i)

    expect(saveAndActivateProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        contextWindow: 400_000,
        maxInputTokens: 272_000,
        maxOutputTokens: 128_000
      })
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

  it('localizes an oversized pasted Claude token error', async () => {
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
    useSettingsStore.setState({
      persistProvider: vi.fn().mockResolvedValue('builtin-claude-isolated'),
      loginIsolatedClaudeBrowser: vi.fn(() => browserLogin),
      loginIsolatedClaude: vi
        .fn()
        .mockRejectedValue(new Error('Claude sign-in token must not exceed 16384 bytes.')),
      cancelIsolatedClaudeLogin
    })
    readyClaudeEnvironment()

    await renderStep()
    await switchToIsolatedClaudeSignIn()
    await clickButton(/sign in & continue/i)
    await act(async () => i18next.changeLanguage('zh-Hans'))

    const modal = document.body.querySelector<HTMLElement>('[role="alertdialog"]')
    const input = modal?.querySelector<HTMLInputElement>('#claude-setup-token-input')
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, 'sk-ant-oversized')
      input?.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const submit = Array.from(modal?.querySelectorAll('button') ?? []).at(-1)
    await act(async () => submit?.click())

    expect(document.body.textContent).toContain('Claude 令牌不得超过 16384 字节。')
    expect(document.body.textContent).not.toContain(
      'Claude sign-in token must not exceed 16384 bytes.'
    )
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

  it('lets Claude Code add a mixed-protocol Zen provider before choosing an active model', async () => {
    readyClaudeEnvironment()
    useSettingsStore.setState({
      agentFrameworks: [
        {
          id: 'claude-code',
          displayName: 'Claude Code',
          supportedApiTypes: ['messages'],
          supportsSkills: true
        }
      ]
    })
    const saveAndActivateProvider = vi
      .fn()
      .mockResolvedValue({ providerId: 'zen', validation: { ok: true, category: 'ok' } })
    useSettingsStore.setState({ saveAndActivateProvider })

    await renderStep({
      initialValue: createEmptyProviderFormValue({
        ...providerKindPatch('official:opencode'),
        key: 'sk-test'
      })
    })
    await clickButton(/test & continue/i)

    expect(container.textContent).not.toContain("isn't compatible with Claude Code")
    expect(saveAndActivateProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        vendorId: 'opencode',
        model: expect.any(String),
        apiEndpoints: ['messages']
      })
    )
    const { model } = saveAndActivateProvider.mock.calls[0][0]
    expect(getOfficialVendorModelIds('opencode')).toContain(model)
    expect(resolveVendorModelApiEndpoints('opencode', model)).toContain('messages')
  })

  // Switches the auth picker to the isolated "Sign in with Open-Science" mode — the only path that
  // runs the browser login (loginIsolatedCodex).
  const switchToIsolatedSignIn = async (): Promise<void> => {
    await selectOption('Codex authentication', 'Sign in with Open-Science')
  }

  it.each(['Import existing Codex sign-in', 'Sign in with Open-Science'])(
    'offers %s with the built-in Agent',
    async (mode) => {
      useSettingsStore.setState({
        agentFrameworkId: 'open-science-agent',
        agentFrameworks: [
          {
            id: 'open-science-agent',
            displayName: 'Open-Science Agent',
            supportedApiTypes: ['responses', 'messages', 'chat-completions'],
            supportsSkills: true
          }
        ]
      })
      await renderStep()
      await selectOption('Provider type', 'Codex subscription')
      if (mode === 'Sign in with Open-Science') await switchToIsolatedSignIn()
      expect(container.querySelector('[aria-label="Codex authentication"]')?.textContent).toContain(
        mode
      )
      expect(container.querySelector('[aria-label="API key"]')).toBeNull()
      expect(container.querySelector('[aria-label="Base URL"]')).toBeNull()
    }
  )

  it('runs the isolated Codex sign-in then advances', async () => {
    const persistProvider = vi.fn().mockResolvedValue('builtin-codex-isolated')
    const loginIsolatedCodex = vi
      .fn()
      .mockResolvedValue({ ok: true, category: 'ok', applied: true })
    const setActiveProvider = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      ...codexReadyState(),
      agentFrameworks: [
        {
          id: 'codex',
          displayName: 'Codex',
          supportedApiTypes: ['responses'],
          supportsSkills: true
        }
      ],
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

  it.each<ValidateProviderResult>([
    { ok: true, category: 'ok', applied: true },
    { ok: false, category: 'auth', status: 401, applied: true },
    { ok: false, category: 'network', applied: true },
    { ok: true, category: 'ok', applied: false }
  ])(
    'reuses xAI login validation before advancing ($category, applied: $applied)',
    async (validation) => {
      let finishLogin!: (result: XaiOAuthLoginResult) => void
      const waitXaiOAuthLogin = vi.fn(
        () =>
          new Promise<XaiOAuthLoginResult>((resolve) => {
            finishLogin = resolve
          })
      )
      const persistProvider = vi.fn().mockResolvedValue('builtin-xai-subscription')
      const validateProvider = vi
        .fn()
        .mockResolvedValue({ ok: true, category: 'ok', applied: true })
      const setActiveProvider = vi.fn().mockResolvedValue(undefined)
      useSettingsStore.setState({
        ...codexReadyState(),
        agentFrameworks: [
          {
            id: 'codex',
            displayName: 'Codex',
            supportedApiTypes: ['responses'],
            supportsSkills: true
          }
        ],
        persistProvider,
        beginXaiOAuthLogin: vi.fn().mockResolvedValue({
          userCode: 'GROK-2468',
          verificationUri: 'https://auth.x.ai/activate',
          expiresAt: Date.now() + 300_000
        }),
        waitXaiOAuthLogin,
        validateProvider,
        setActiveProvider
      })
      const onAdvance = vi.fn()

      await renderStep({ onAdvance })
      await selectOption('Provider type', 'xAI (Grok) OAuth')
      await clickButton(/sign in & continue/i)

      await vi.waitFor(() => {
        expect(document.body.textContent).toContain('GROK-2468')
      })
      expect(setActiveProvider).not.toHaveBeenCalled()

      await act(async () => finishLogin({ accountEmail: 'researcher@example.com', validation }))

      await vi.waitFor(() => {
        expect(persistProvider).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'xai-subscription', model: 'grok-4.7' })
        )
        expect(waitXaiOAuthLogin).toHaveBeenCalledOnce()
        expect(validateProvider).not.toHaveBeenCalled()
        if (validation.ok && validation.applied !== false) {
          expect(setActiveProvider).toHaveBeenCalledWith('builtin-xai-subscription')
          expect(onAdvance).toHaveBeenCalledOnce()
        } else {
          expect(setActiveProvider).not.toHaveBeenCalled()
          expect(onAdvance).not.toHaveBeenCalled()
        }
      })
    }
  )

  it.each(['access_denied', 'expired_token'])(
    'closes a failed xAI device session and obtains a fresh code after %s',
    async (failure) => {
      const first = Promise.withResolvers<XaiOAuthLoginResult>()
      const second = Promise.withResolvers<XaiOAuthLoginResult>()
      const session = {
        verificationUri: 'https://auth.x.ai/activate',
        intervalSeconds: 1,
        expiresAt: Date.now() + 300000
      }
      const begin = vi
        .fn()
        .mockResolvedValueOnce({ ...session, userCode: 'FIRST-CODE' })
        .mockResolvedValueOnce({ ...session, userCode: 'SECOND-CODE' })
      const onAdvance = vi.fn()
      useSettingsStore.setState({
        ...codexReadyState(),
        persistProvider: vi.fn().mockResolvedValue('xai'),
        setActiveProvider: vi.fn(),
        beginXaiOAuthLogin: begin,
        waitXaiOAuthLogin: vi
          .fn()
          .mockReturnValueOnce(first.promise)
          .mockReturnValueOnce(second.promise)
      })
      await renderStep({ variant: 'quick', onAdvance })
      await clickButton(/Continue with xAI/)
      expect(document.body.textContent).toContain('FIRST-CODE')
      await act(async () => first.reject(new Error(failure)))
      expect(document.body.textContent).not.toContain('FIRST-CODE')
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        failure === 'access_denied' ? 'Permission denied' : 'Authorization expired'
      )
      expect(container.querySelector('details pre')?.textContent).toBe(failure)
      expect(onAdvance).not.toHaveBeenCalled()
      await clickButton(/Continue with xAI/)
      expect(document.body.textContent).toContain('SECOND-CODE')
      await act(async () => second.resolve({ validation: { ok: true, category: 'ok' } }))
      expect(onAdvance).toHaveBeenCalledOnce()
    }
  )

  it('cancels xAI device authorization while the device session is starting', async () => {
    let finishBegin!: (session: {
      userCode: string
      verificationUri: string
      expiresAt: number
      intervalSeconds: number
    }) => void
    const beginXaiOAuthLogin = vi.fn(
      () =>
        new Promise<{
          userCode: string
          verificationUri: string
          expiresAt: number
          intervalSeconds: number
        }>((resolve) => {
          finishBegin = resolve
        })
    )
    const waitXaiOAuthLogin = vi.fn()
    const cancelXaiOAuthLogin = vi.fn().mockResolvedValue(undefined)
    const onAdvance = vi.fn()
    useSettingsStore.setState({
      ...codexReadyState(),
      agentFrameworks: [
        {
          id: 'codex',
          displayName: 'Codex',
          supportedApiTypes: ['responses'],
          supportsSkills: true
        }
      ],
      persistProvider: vi.fn().mockResolvedValue('builtin-xai-subscription'),
      beginXaiOAuthLogin,
      waitXaiOAuthLogin,
      cancelXaiOAuthLogin
    })

    await renderStep({ onAdvance })
    await selectOption('Provider type', 'xAI (Grok) OAuth')
    await clickButton(/sign in & continue/i)
    await clickButton(/cancel sign-in/i)

    expect(cancelXaiOAuthLogin).toHaveBeenCalledOnce()
    await act(async () =>
      finishBegin({
        userCode: 'GROK-0000',
        verificationUri: 'https://auth.x.ai/activate',
        expiresAt: Date.now() + 300_000,
        intervalSeconds: 1
      })
    )
    expect(waitXaiOAuthLogin).not.toHaveBeenCalled()
    expect(onAdvance).not.toHaveBeenCalled()
  })

  it('cancels an in-flight xAI device authorization when the step unmounts', async () => {
    const cancelXaiOAuthLogin = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      ...codexReadyState(),
      agentFrameworks: [
        {
          id: 'codex',
          displayName: 'Codex',
          supportedApiTypes: ['responses'],
          supportsSkills: true
        }
      ],
      persistProvider: vi.fn().mockResolvedValue('builtin-xai-subscription'),
      beginXaiOAuthLogin: vi.fn().mockResolvedValue({
        userCode: 'GROK-1357',
        verificationUri: 'https://auth.x.ai/activate',
        expiresAt: Date.now() + 300_000
      }),
      waitXaiOAuthLogin: vi.fn(() => new Promise<XaiOAuthLoginResult>(() => undefined)),
      cancelXaiOAuthLogin
    })

    await renderStep()
    await selectOption('Provider type', 'xAI (Grok) OAuth')
    await clickButton(/sign in & continue/i)
    await vi.waitFor(() => expect(document.body.textContent).toContain('GROK-1357'))

    await act(async () => root.unmount())
    expect(cancelXaiOAuthLogin).toHaveBeenCalledOnce()
    root = createRoot(container)
  })

  it('keeps the quick-connect action tray translucent over Silk', () => {
    const css = readFileSync(resolve(__dirname, '../../assets/main.css'), 'utf8')
    const actionRule = css.slice(
      css.indexOf('.onboarding-provider-card-actions {'),
      css.indexOf('.onboarding-provider-card-actions small {')
    )

    expect(actionRule).toContain('backdrop-filter: blur(18px) saturate(1.12);')
    expect(actionRule).toContain('border-top: 0;')
    expect(actionRule).toContain('color-mix(in oklab, var(--bg-10) 46%, transparent)')
  })

  it('uses one provider card treatment across color schemes', () => {
    const css = readFileSync(resolve(__dirname, '../../assets/main.css'), 'utf8')
    const cardRule = css.slice(
      css.indexOf('.onboarding-provider-card {'),
      css.indexOf('.onboarding-provider-card-surface {')
    )

    expect(cardRule).toContain('--silk-idle-opacity: 0.52;')
    expect(cardRule).toContain('--silk-hover-opacity: 0.68;')
    expect(cardRule).toContain('--bg-10: hsl(60 3% 10%);')
    expect(cardRule).toContain('--primary: oklch(0.72 0.1 184);')
    expect(cardRule).toContain('background-size: 180% 180%;')
    expect(css).not.toContain('.dark .onboarding-provider-card {')
    expect(css).not.toContain('.dark .onboarding-provider-card-actions {')
  })

  it('lets quick feedback and actions flow without reserving an empty spacer', () => {
    const css = readFileSync(resolve(__dirname, '../../assets/main.css'), 'utf8')
    const footerRule = css.match(
      /\.onboarding-quick-footer,\n\.onboarding-ready-actions \{[\s\S]*?\n\}/
    )?.[0]
    const readyActionsRule = css.match(/\.onboarding-ready-actions \{\s+margin-top: auto;\n\}/)?.[0]

    expect(footerRule).toBeDefined()
    expect(readyActionsRule).toBeDefined()
    expect(footerRule).not.toContain('margin-top: auto;')
    expect(readyActionsRule).toContain('margin-top: auto;')
  })

  it('sizes the quick-connect popup to content before capping overflow', () => {
    const css = readFileSync(resolve(__dirname, '../../assets/main.css'), 'utf8')
    const quickConnectRule = css.match(/\.onboarding-quick-connect \{[\s\S]*?\n\}/)?.[0]
    const quickFeedbackRule = css.match(/\.onboarding-quick-feedback \{[\s\S]*?\n\}/)?.[0]

    expect(quickConnectRule).toBeDefined()
    expect(quickFeedbackRule).toBeDefined()
    expect(quickConnectRule).toContain('max-height: inherit;')
    expect(quickConnectRule).not.toMatch(/^\s*(?:min-)?height:/m)
    expect(quickFeedbackRule).toContain('overflow-y: auto;')
  })
})
