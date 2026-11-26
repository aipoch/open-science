// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { OnboardingWizard } from './OnboardingWizard'
import {
  clickButton,
  findButton,
  fillRequiredProviderFields,
  readyBuiltInState,
  selectOption,
  resetOnboardingStores,
  storageInfo,
  codexReadyState,
  stubWindowApi
} from './onboarding-test-utils'
import { useSettingsStore } from '@/stores/settings-store'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  resetOnboardingStores()
  stubWindowApi()
  readyBuiltInState()
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  delete (window as unknown as { api?: unknown }).api
  vi.useRealTimers()
})

const renderEntry = async (): Promise<void> => {
  await act(async () => {
    root.render(<OnboardingWizard showWelcome />)
  })
}

const finishWelcomeAnimation = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
  })
  const fallback = container.querySelector<HTMLElement>('.onboarding-ring-convergence')
  expect(fallback).not.toBeNull()
  await act(async () => {
    if (fallback) fireEvent.animationEnd(fallback, { animationName: 'onboarding-ring-gather' })
    vi.advanceTimersByTime(3_600)
  })
}

describe('Onboarding entry flow', () => {
  it('keeps the welcome action hidden until the animation completes, then opens quick connect', async () => {
    await renderEntry()

    expect(container.querySelector('[data-onboarding-entry="welcome"]')).not.toBeNull()
    expect(container.querySelector('button[data-onboarding-action="next"]')).toBeNull()

    await finishWelcomeAnimation()

    expect(container.querySelector('button[data-onboarding-action="next"]')).not.toBeNull()

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[data-onboarding-action="next"]')?.click()
    })

    expect(container.querySelector('[data-onboarding-entry="connect"]')).not.toBeNull()
    expect(container.textContent).toContain('Bring the AI you already use.')
    expect(document.activeElement).toBe(container.querySelector('[role="dialog"]'))
    expect(container.querySelector('.onboarding-provider-card:focus-within')).toBeNull()
    expect(container.textContent).toContain('Advanced options')
  })

  it('applies the defaults and opens the full provider picker from the last card', async () => {
    useSettingsStore.setState(codexReadyState())
    const pending = Promise.withResolvers<void>()
    const checkEnvironment = vi.fn(async () => {
      await pending.promise
      readyBuiltInState()
      return useSettingsStore.getState().environmentCheck
    })
    useSettingsStore.setState({ checkEnvironment })
    await renderEntry()
    await finishWelcomeAnimation()
    await clickButton(/^Next$/)
    await clickButton(/^Advanced mode$/)

    expect(useSettingsStore.getState().setAgentFramework).toHaveBeenCalledWith('open-science-agent')
    expect(checkEnvironment).toHaveBeenCalledOnce()
    for (const label of [/^Advanced mode$/, /^Advanced options$/, /^Back$/, /free Kilo models/]) {
      expect(findButton(label)?.disabled).toBe(true)
    }
    await act(async () =>
      fireEvent.keyDown(container.querySelector('[role="dialog"]')!, { key: 'Escape' })
    )
    expect(useSettingsStore.getState().completeOnboarding).not.toHaveBeenCalled()
    await act(async () => pending.resolve())
    expect(window.api.storage.setDataRootAndRelaunch).not.toHaveBeenCalled()
    expect(container.querySelector('[aria-current="step"]')?.textContent).toContain(
      'Model provider'
    )
    const picker = container.querySelector('[data-slot="provider-picker"]')!
    for (const id of ['cloudflare-ai-gateway', 'aws-bedrock', 'microsoft-foundry', 'vectrust']) {
      expect(picker.querySelector(`[data-provider-kind="official:${id}"]`), id).not.toBeNull()
    }
    await act(async () =>
      picker
        .querySelector<HTMLButtonElement>('[data-provider-kind="official:cloudflare-ai-gateway"]')!
        .click()
    )
    expect(container.querySelector('#provider-cloudflare-mode')).not.toBeNull()
  })

  it('opens the Agent step for repair when the default runtime fails its check', async () => {
    useSettingsStore.setState((state) => ({
      environmentCheck: { ...state.environmentCheck!, ready: false }
    }))
    await renderEntry()
    await finishWelcomeAnimation()
    await clickButton(/^Next$/)
    await clickButton(/^Advanced mode$/)
    expect(container.querySelector('[aria-current="step"]')?.textContent).toContain('Agent runtime')
    expect(findButton(/^Continue$/)?.disabled).toBe(true)
  })

  it('keeps an older success from unlocking Agent repair after a failed check', async () => {
    useSettingsStore.setState({ environmentCheckError: 'The latest check failed.' })
    await renderEntry()
    await finishWelcomeAnimation()
    await clickButton(/^Next$/)
    await clickButton(/^Advanced mode$/)
    expect(container.querySelector('[aria-current="step"]')?.textContent).toContain('Agent runtime')
    expect(findButton(/^Continue$/)?.disabled).toBe(true)
  })

  it('requires the runtime to remain ready before continuing from the provider picker', async () => {
    await renderEntry()
    await finishWelcomeAnimation()
    await clickButton(/^Next$/)
    await clickButton(/^Advanced mode$/)
    expect(findButton(/^Skip$/)?.disabled).toBe(false)
    await act(async () => useSettingsStore.setState({ environmentCheckError: 'Check failed.' }))
    expect(findButton(/^Skip$/)?.disabled).toBe(true)
    await clickButton(/^Skip$/)
    expect(useSettingsStore.getState().addOnboardingKiloProvider).not.toHaveBeenCalled()
  })

  it('requires the missing active data folder to recover before continuing', async () => {
    vi.mocked(window.api.storage.getInfo)
      .mockResolvedValueOnce(storageInfo({ dataRootMissing: true, isDefault: false }))
      .mockResolvedValue(storageInfo())
    await renderEntry()
    await finishWelcomeAnimation()
    await clickButton(/^Next$/)
    await clickButton(/^Advanced mode$/)
    expect(container.querySelector('[aria-current="step"]')?.textContent).toContain('Data location')
    expect(findButton(/^Continue$/)?.disabled).toBe(true)
    await clickButton(/^Retry$/)
    expect(findButton(/^Continue$/)?.disabled).toBe(false)
  })

  it('opens data location for recovery when the default is unavailable', async () => {
    vi.mocked(window.api.storage.getInfo).mockRejectedValue(new Error('Storage unavailable'))
    await renderEntry()
    await finishWelcomeAnimation()
    await clickButton(/^Next$/)
    await clickButton(/^Advanced mode$/)
    expect(container.querySelector('[aria-current="step"]')?.textContent).toContain('Data location')
    expect(findButton(/^Continue$/)?.disabled).toBe(true)
    expect(useSettingsStore.getState().setAgentFramework).not.toHaveBeenCalled()
  })

  it('returns to quick connect after closing targeted Notebook settings', async () => {
    await renderEntry()
    await finishWelcomeAnimation()
    await clickButton(/^Next$/)
    await act(async () => useSettingsStore.getState().openSettingsToPanel('runtimes'))
    const panel = document.querySelector('[data-testid="runtimes-panel"]')
    expect(panel).not.toBeNull()
    const close = panel!
      .closest('[role="dialog"]')!
      .querySelector<HTMLButtonElement>('button[aria-label="Close"]')!
    await act(async () => close.click())
    expect(document.querySelector('[data-testid="runtimes-panel"]')).toBeNull()
    expect(container.querySelector('[data-onboarding-entry="connect"]')).not.toBeNull()
  })

  it('walks four advanced steps and keeps the model draft when returning from agent selection', async () => {
    await renderEntry()
    await finishWelcomeAnimation()
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[data-onboarding-action="next"]')?.click()
    })

    const dialog = container.querySelector('[role="dialog"]')
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[data-onboarding-action="advanced"]')
        ?.click()
    })

    expect(container.querySelector('[data-onboarding-layout="split"]')).toBeNull()
    expect(container.querySelector('[role="dialog"]')).toBe(dialog)
    expect(container.querySelectorAll('ol[aria-label="Setup progress"] > li')).toHaveLength(4)
    expect(container.textContent).toContain('Where should Open-Science store your data?')
    await clickButton(/^Continue$/)
    expect(container.textContent).toContain('Set up the agent runtime')
    expect(container.querySelector('[data-slot="provider-picker"]')).toBeNull()
    await clickButton(/^Continue$/)
    const pick = async (key: string): Promise<void> => {
      const card = container.querySelector<HTMLButtonElement>(`[data-provider-kind="${key}"]`)!
      await act(async () => card.click())
    }
    expect(container.querySelector('[data-provider-kind="codex-subscription"]')).not.toBeNull()
    expect(container.querySelector('[data-provider-kind="claude-subscription"]')).toBeNull()
    await pick('custom')
    await clickButton(/^Change$/)
    await pick('custom')
    await fillRequiredProviderFields(container)
    await clickButton(/^Back$/)
    expect(container.querySelector('[data-slot="provider-picker"]')).not.toBeNull()
    await clickButton(/^Back$/)
    expect(container.textContent).toContain('Set up the agent runtime')
    await clickButton(/^Continue$/)
    await pick('custom')
    expect(container.querySelector<HTMLInputElement>('#provider-base-url')?.value).toBe(
      'https://gateway.example'
    )
    await clickButton(/Test & continue/)
    expect(container.textContent).toContain('Notebook runtime (optional)')
    await clickButton(/^Finish$/)
    expect(container.querySelector('[data-onboarding-entry="ready"]')).not.toBeNull()
    expect(container.querySelector('[role="dialog"]')).toBe(dialog)
    await clickButton(/^Back$/)
    expect(container.textContent).toContain('Notebook runtime (optional)')
    await clickButton(/^Finish$/)
    expect(container.querySelector('[data-onboarding-entry="ready"]')).not.toBeNull()
    expect(useSettingsStore.getState().completeOnboarding).not.toHaveBeenCalled()
  })

  it('uses the selected framework’s subscription options and authorizes the selected CodeBuddy site', async () => {
    const codeBuddyAccount = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, category: 'auth' })
      .mockResolvedValueOnce({ ok: true, category: 'ok' })
    const setActiveProvider = vi.fn()
    useSettingsStore.setState({ codeBuddyAccount, setActiveProvider })
    await renderEntry()
    await finishWelcomeAnimation()
    await clickButton(/^Next$/)
    await clickButton(/Advanced options/)
    await clickButton(/^Continue$/)
    const chooseAgent = async (agentFrameworkId: 'claude-code' | 'codebuddy'): Promise<void> => {
      await act(async () =>
        useSettingsStore.setState((state) => ({
          agentFrameworkId,
          environmentCheck: { ...state.environmentCheck!, ready: true, agentFrameworkId }
        }))
      )
      await clickButton(/^Continue$/)
    }
    await chooseAgent('claude-code')
    expect(container.querySelector('[data-provider-kind="claude-subscription"]')).not.toBeNull()
    expect(container.querySelector('[data-provider-kind="codex-subscription"]')).toBeNull()
    expect(container.querySelector('[data-provider-kind="builtin-codebuddy-china"]')).toBeNull()
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[data-provider-kind="claude-subscription"]')!
        .click()
    )
    await clickButton(/^Back$/)
    await clickButton(/^Back$/)
    await chooseAgent('codebuddy')
    expect(container.querySelector('[data-provider-kind="claude-subscription"]')).toBeNull()
    expect(container.querySelector('[data-provider-kind="builtin-codebuddy-china"]')).not.toBeNull()
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[data-provider-kind="builtin-codebuddy-international"]')!
        .click()
    )
    await clickButton(/^Sign in & continue$/)
    expect(codeBuddyAccount).toHaveBeenCalledWith({
      site: 'external',
      action: 'login',
      mode: 'isolated'
    })
    expect(setActiveProvider).not.toHaveBeenCalled()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'CodeBuddy account request failed.'
    )
    await selectOption('Authentication', 'Use existing CodeBuddy CLI sign-in')
    await clickButton(/^Sign in & continue$/)
    expect(codeBuddyAccount).toHaveBeenLastCalledWith({
      site: 'external',
      action: 'login',
      mode: 'shared'
    })
    expect(setActiveProvider).toHaveBeenCalledWith('builtin-codebuddy-international')
    expect(container.textContent).toContain('Notebook runtime (optional)')
  })

  it('returns from Ready to quick connect and can advance again', async () => {
    useSettingsStore.setState({
      ...codexReadyState(),
      saveProvider: vi.fn().mockResolvedValue({ providerId: 'verified', validation: { ok: true } }),
      setActiveProvider: vi.fn()
    })
    await renderEntry()
    await finishWelcomeAnimation()
    await clickButton(/^Next$/)
    await clickButton(/^Import existing Codex sign-in$/)
    expect(container.querySelector('[data-onboarding-entry="ready"]')).not.toBeNull()
    await clickButton(/^Back$/)
    expect(container.querySelector('[data-onboarding-entry="connect"]')).not.toBeNull()
    await clickButton(/^Import existing Codex sign-in$/)
    expect(container.querySelector('[data-onboarding-entry="ready"]')).not.toBeNull()
    expect(useSettingsStore.getState().completeOnboarding).not.toHaveBeenCalled()
  })

  it.each([
    ['new free Kilo', 'official', 'kilo', 'kilo-auto/free', false, 'Using free Kilo models'],
    ['saved Codex', 'codex-shared', undefined, 'gpt-5', false, 'Connected with your account'],
    ['saved Kilo with key', 'official', 'kilo', 'paid-model', true, 'Connected with API key'],
    ['local gateway', 'custom', undefined, 'local-model', false, 'Connected']
  ] as const)(
    'shows the actual advanced connection for %s',
    async (name, type, vendorId, model, hasKey, summary) => {
      const provider = {
        id: 'configured',
        name,
        type,
        vendorId,
        model,
        models: [model],
        hasKey,
        supportsImageInput: false,
        needsKey: false,
        lastValidatedAt: 1
      }
      const selection = { providers: [provider], activeProviderId: provider.id, activeModel: model }
      const addOnboardingKiloProvider = vi.fn(async () => useSettingsStore.setState(selection))
      const provisionFree = name === 'new free Kilo'
      if (type === 'codex-shared') useSettingsStore.setState(codexReadyState())
      useSettingsStore.setState({ ...(!provisionFree && selection), addOnboardingKiloProvider })
      await renderEntry()
      await finishWelcomeAnimation()
      await clickButton(/^Next$/)
      await clickButton(/Advanced options/)
      await clickButton(/^Continue$/)
      await clickButton(/^Continue$/)
      await clickButton(provisionFree ? /^Skip$/ : /^Use configured provider$/)
      await clickButton(/^Finish$/)
      const badge = container.querySelector('.onboarding-connection-summary')
      expect(badge?.textContent).toContain(name)
      expect(badge?.textContent).toContain(summary)
      if (!hasKey) expect(badge?.textContent).not.toContain('API key')
      expect(addOnboardingKiloProvider).toHaveBeenCalledTimes(provisionFree ? 1 : 0)
    }
  )

  it('returns from advanced data location to quick connect without leaving the dialog', async () => {
    await renderEntry()
    await finishWelcomeAnimation()
    await clickButton(/^Next$/)
    const dialog = container.querySelector('[role="dialog"]')
    await clickButton(/Advanced options/)
    await clickButton(/^Back$/)
    expect(container.querySelector('[data-onboarding-entry="connect"]')).not.toBeNull()
    expect(container.querySelector('[role="dialog"]')).toBe(dialog)
  })

  it('requires the selected agent to pass its checks before opening the model picker', async () => {
    await renderEntry()
    await finishWelcomeAnimation()
    await clickButton(/^Next$/)
    await clickButton(/Advanced options/)
    await clickButton(/^Continue$/)
    await act(async () => useSettingsStore.setState({ isCheckingEnvironment: true }))
    expect(findButton(/^Continue$/)?.disabled).toBe(true)
    await clickButton(/^Continue$/)
    expect(container.querySelector('[data-slot="provider-picker"]')).toBeNull()
    expect(useSettingsStore.getState().saveAndActivateProvider).not.toHaveBeenCalled()
  })

  it('resumes agent selection after restarting from the welcome entry with a new data location', async () => {
    const dataRoot = '/mnt/research/OpenScience'
    vi.mocked(window.api.storage.pickDirectory).mockResolvedValue('/mnt/research')
    vi.mocked(window.api.storage.inspectDataRoot).mockResolvedValue({ kind: 'move', dataRoot })
    await renderEntry()
    await finishWelcomeAnimation()
    await clickButton(/^Next$/)
    await clickButton(/Advanced options/)
    await clickButton(/Browse/i)
    await clickButton(/^Continue$/)
    await clickButton(/^Restart$/i)
    expect(window.api.storage.setDataRootAndRelaunch).toHaveBeenCalledWith(
      dataRoot,
      false,
      undefined
    )
    await act(async () => root.unmount())
    root = createRoot(container)
    vi.mocked(window.api.storage.getInfo).mockResolvedValue(
      storageInfo({ dataRoot, isDefault: false })
    )
    await renderEntry()
    expect(
      container.querySelector('[data-onboarding-entry="advanced"] [aria-current="step"]')
        ?.textContent
    ).toContain('Agent runtime')
    expect(container.querySelector('section[aria-label="Set up the agent runtime"]')).not.toBeNull()
  })

  it.each(['account', 'api-key'] as const)(
    'finishes with the verified %s connection on Ready Escape',
    async (method) => {
      const saved = { providerId: 'verified', validation: { ok: true } }
      const setActiveProvider = vi.fn(async (id: string, model?: string) => {
        useSettingsStore.setState({ activeProviderId: id, activeModel: model })
      })
      useSettingsStore.setState({
        ...codexReadyState(),
        saveProvider: vi.fn().mockResolvedValue(saved),
        saveValidatedProvider: vi.fn().mockResolvedValue(saved),
        setActiveProvider
      })
      if (method === 'api-key') readyBuiltInState()
      await renderEntry()
      await finishWelcomeAnimation()
      await clickButton(/^Next$/)
      if (method === 'account') {
        await clickButton(/^Import existing Codex sign-in$/)
      } else {
        const key = container.querySelector<HTMLInputElement>('#onboarding-key-deepseek')!
        await act(async () => fireEvent.change(key, { target: { value: 'valid' } }))
        await act(async () => fireEvent.submit(key.form!))
      }

      const ready = container.querySelector('[data-onboarding-entry="ready"]')!
      expect(ready).not.toBeNull()
      expect(setActiveProvider).toHaveBeenCalledOnce()
      const { activeModel } = useSettingsStore.getState()
      await act(async () => fireEvent.keyDown(ready, { key: 'Escape' }))
      const settings = useSettingsStore.getState()
      expect(settings.completeOnboarding).toHaveBeenCalledOnce()
      expect(settings.addOnboardingKiloProvider).not.toHaveBeenCalled()
      expect(settings.activeProviderId).toBe('verified')
      expect(settings.activeModel).toBe(activeModel)
      expect(setActiveProvider).toHaveBeenCalledOnce()
    }
  )

  it('summarizes final save failures, discloses details on demand and retries without replacing the connection', async () => {
    const cause = 'IPC settings:complete-onboarding failed: EIO'
    const pending = Promise.withResolvers<void>()
    const completeOnboarding = vi
      .fn()
      .mockRejectedValueOnce(new Error(cause))
      .mockReturnValueOnce(pending.promise)
    useSettingsStore.setState({
      ...codexReadyState(),
      completeOnboarding,
      saveProvider: vi.fn().mockResolvedValue({ providerId: 'verified', validation: { ok: true } }),
      setActiveProvider: vi.fn()
    })
    await renderEntry()
    await finishWelcomeAnimation()
    await clickButton(/^Next$/)
    await clickButton(/^Import existing Codex sign-in$/)
    const ready = container.querySelector('[data-onboarding-entry="ready"]')!
    await act(async () => fireEvent.keyDown(ready, { key: 'Escape' }))
    expect(ready.querySelector('[role="alert"]')?.textContent).toBe('Could not finish setup.')
    const details = ready.querySelector('details')!
    expect(details.open).toBe(false)
    expect(details.querySelector('summary')?.textContent).toContain('Error details')
    await act(async () => details.querySelector('summary')!.click())
    expect(details.open).toBe(true)
    expect(details.querySelector('pre')?.textContent).toBe(cause)
    await act(async () => ready.querySelector<HTMLButtonElement>('[aria-label="Dismiss"]')!.click())
    expect(ready.querySelector('[role="alert"]')).toBeNull()
    expect(ready.querySelector('details')).toBeNull()
    await clickButton(/^Start exploring$/)
    await act(async () => fireEvent.keyDown(ready, { key: 'Escape' }))
    expect(completeOnboarding).toHaveBeenCalledTimes(2)
    await act(async () => pending.resolve())
    expect(ready.querySelector('[role="alert"]')).toBeNull()
    expect(useSettingsStore.getState().setActiveProvider).toHaveBeenCalledOnce()
    expect(useSettingsStore.getState().addOnboardingKiloProvider).not.toHaveBeenCalled()
  })

  it('honors disabled Skip when Escape is pressed during authorization', async () => {
    const pending = Promise.withResolvers<never>()
    useSettingsStore.setState({
      ...codexReadyState(),
      saveProvider: vi.fn().mockReturnValue(pending.promise)
    })
    await renderEntry()
    await finishWelcomeAnimation()
    await clickButton(/^Next$/)
    await clickButton(/^Import existing Codex sign-in$/)
    const skip = container.querySelector<HTMLButtonElement>('[data-onboarding-action="skip"]')!
    expect(skip.disabled).toBe(true)
    await act(async () =>
      fireEvent.keyDown(container.querySelector('[role="dialog"]')!, { key: 'Escape' })
    )
    expect(useSettingsStore.getState().completeOnboarding).not.toHaveBeenCalled()
    await act(async () => pending.reject(new Error('Import failed')))
    expect(skip.disabled).toBe(false)
    await act(async () => fireEvent.keyDown(skip, { key: 'Escape' }))
    expect(useSettingsStore.getState().completeOnboarding).toHaveBeenCalledOnce()
  })

  it('blocks competing quick actions until a pending Kilo skip settles', async () => {
    const pending = Promise.withResolvers<void>()
    const addOnboardingKiloProvider = vi.fn().mockReturnValue(pending.promise)
    const saveValidatedProvider = vi.fn()
    const saveProvider = vi.fn()
    useSettingsStore.setState({ addOnboardingKiloProvider, saveValidatedProvider, saveProvider })
    await renderEntry()
    await finishWelcomeAnimation()
    await clickButton(/^Next$/)
    const key = container.querySelector<HTMLInputElement>('#onboarding-key-deepseek')!
    await act(async () => fireEvent.change(key, { target: { value: 'valid' } }))
    await clickButton(/free Kilo models/)
    const skip = findButton(/free Kilo models/)!
    const controls = [
      key,
      key.form!.querySelector('button')!,
      findButton(/^Back$/)!,
      findButton(/Advanced options/)!,
      findButton(/^Advanced mode$/)!,
      findButton(/Import existing Codex sign-in/)!,
      skip
    ]
    for (const control of controls) {
      expect(control.disabled).toBe(true)
      await act(async () => control.click())
    }
    await act(async () => {
      fireEvent.submit(key.form!)
      fireEvent.keyDown(container.querySelector('[role="dialog"]')!, { key: 'Escape' })
    })
    expect(addOnboardingKiloProvider).toHaveBeenCalledOnce()
    expect(saveValidatedProvider).not.toHaveBeenCalled()
    expect(saveProvider).not.toHaveBeenCalled()
    expect(useSettingsStore.getState().completeOnboarding).not.toHaveBeenCalled()
    expect(container.querySelector('[data-onboarding-entry="connect"]')).not.toBeNull()
    await act(async () => pending.reject(new Error('offline')))
    for (const control of controls) expect(control.disabled).toBe(false)
    await clickButton(/Advanced options/)
    expect(container.querySelector('[data-onboarding-entry="advanced"]')).not.toBeNull()
  })

  it('provisions free Kilo after an invalid quick key and Skip', async () => {
    const setActiveProvider = vi.fn()
    const addOnboardingKiloProvider = vi.fn().mockResolvedValue(undefined)
    const saveValidatedProvider = vi
      .fn()
      .mockResolvedValue({ validation: { ok: false, category: 'auth', status: 401 } })
    useSettingsStore.setState({
      activeProviderId: 'working',
      addOnboardingKiloProvider,
      saveValidatedProvider,
      setActiveProvider
    })
    await renderEntry()
    await finishWelcomeAnimation()
    await clickButton(/^Next$/)
    const key = container.querySelector<HTMLInputElement>('#onboarding-key-deepseek')!
    await act(async () => fireEvent.change(key, { target: { value: 'invalid' } }))
    await act(async () => fireEvent.submit(key.form!))
    expect(saveValidatedProvider).toHaveBeenCalledOnce()
    expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/401|auth/i)
    await clickButton(/free Kilo models/)
    expect(addOnboardingKiloProvider).toHaveBeenCalledOnce()
    expect(useSettingsStore.getState().completeOnboarding).toHaveBeenCalledOnce()
    expect(useSettingsStore.getState().saveAndActivateProvider).not.toHaveBeenCalled()
    expect(setActiveProvider).not.toHaveBeenCalled()
  })

  it('summarizes a failed quick skip and lets the user inspect and dismiss the cause', async () => {
    const cause = 'IPC settings:add-onboarding-kilo-provider failed: ECONNRESET'
    useSettingsStore.setState({
      addOnboardingKiloProvider: vi.fn().mockRejectedValue(new Error(cause))
    })
    await renderEntry()
    await finishWelcomeAnimation()
    await clickButton(/^Next$/)
    await clickButton(/free Kilo models/)
    const region = container.querySelector('.onboarding-quick-feedback')!
    expect(region.querySelector('[role="alert"]')?.textContent).toBe(
      'Could not skip setup. You can retry or use Advanced options.'
    )
    const details = region.querySelector('details')!
    expect(details.open).toBe(false)
    await act(async () => details.querySelector('summary')!.click())
    expect(details.open).toBe(true)
    expect(details.querySelector('pre')?.textContent).toBe(cause)
    await act(async () =>
      region.querySelector<HTMLButtonElement>('[aria-label="Dismiss"]')!.click()
    )
    expect(region.querySelector('[role="alert"]')).toBeNull()
    expect(region.querySelector('[data-onboarding-action="advanced"]')).not.toBeNull()
  })

  it('keeps the second-stage feedback and navigation inside one scrollable content region', async () => {
    await renderEntry()
    await finishWelcomeAnimation()
    await clickButton(/^Next$/)

    const cards = container.querySelector('.onboarding-provider-viewport')
    const feedback = container.querySelector('.onboarding-quick-feedback')
    expect(cards?.nextElementSibling).toBe(feedback)
    expect(feedback?.querySelector('[data-onboarding-action="advanced"]')).not.toBeNull()
    expect(feedback?.querySelector('[data-onboarding-action="skip"]')).not.toBeNull()
  })
})
