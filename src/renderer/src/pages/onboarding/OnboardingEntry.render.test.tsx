// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { OnboardingWizard } from './OnboardingWizard'
import {
  clickButton,
  fillRequiredProviderFields,
  readyBuiltInState,
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

  it('embeds three compact advanced steps in the same dialog', async () => {
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
    expect(container.querySelectorAll('ol[aria-label="Setup progress"] > li')).toHaveLength(3)
    expect(container.textContent).toContain('Where should Open-Science store your data?')
    await clickButton(/^Continue$/)
    expect(container.textContent).toContain('Set up the agent runtime')
    const model = container.querySelector('section[aria-label="Configure model"]')!
    const agent = container.querySelector('.onboarding-advanced-agent')!
    expect(model.compareDocumentPosition(agent) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(agent.querySelector('.onboarding-agent-panel')).not.toBeNull()
    expect(agent.querySelector('.onboarding-agent-panel')?.classList.contains('p-5')).toBe(false)
    expect(container.querySelector('[role="dialog"]')).toBe(dialog)
    await fillRequiredProviderFields(container)
    await clickButton(/^Back$/)
    expect(container.textContent).toContain('Where should Open-Science store your data?')
    await clickButton(/^Continue$/)
    expect(container.querySelector<HTMLInputElement>('#provider-base-url')?.value).toBe(
      'https://gateway.example'
    )
    await clickButton(/Test & continue/)
    expect(container.textContent).toContain('Notebook runtime (optional)')
    await clickButton(/^Finish$/)
    expect(container.querySelector('[data-onboarding-entry="ready"]')).not.toBeNull()
    expect(container.querySelector('[role="dialog"]')).toBe(dialog)
    expect(useSettingsStore.getState().completeOnboarding).not.toHaveBeenCalled()
  })
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

  it('keeps model submission blocked while the selected runtime checks are incomplete', async () => {
    await renderEntry()
    await finishWelcomeAnimation()
    await clickButton(/^Next$/)
    await clickButton(/Advanced options/)
    await clickButton(/^Continue$/)
    await act(async () => useSettingsStore.setState({ isCheckingEnvironment: true }))
    const submit = Array.from(container.querySelectorAll('button')).find((button) =>
      /Test & continue/.test(button.textContent ?? '')
    )!
    expect(submit.disabled).toBe(true)
    await clickButton(/Test & continue/)
    expect(useSettingsStore.getState().saveAndActivateProvider).not.toHaveBeenCalled()
  })

  it('resumes Model and Agent after restarting from the welcome entry with a new data location', async () => {
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
    ).toContain('Model and Agent')
    expect(container.querySelector('section[aria-label="Configure model"]')).not.toBeNull()
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
