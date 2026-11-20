// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { OnboardingWizard } from './OnboardingWizard'
import {
  clickButton,
  fillRequiredProviderFields,
  readyClaudeState,
  resetOnboardingStores,
  stubWindowApi
} from './onboarding-test-utils'
import { useSettingsStore } from '@/stores/settings-store'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  resetOnboardingStores()
  stubWindowApi()
  readyClaudeState()
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
})
