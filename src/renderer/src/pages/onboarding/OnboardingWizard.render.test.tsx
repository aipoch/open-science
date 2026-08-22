// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { useSettingsStore } from '@/stores/settings-store'
import { OnboardingWizard } from './OnboardingWizard'
import {
  clickButton,
  fillRequiredProviderFields,
  readyClaudeState,
  resetOnboardingStores,
  stubWindowApi
} from './onboarding-test-utils'

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

const renderWizard = async (): Promise<void> => {
  await act(async () => {
    root.render(<OnboardingWizard />)
  })
}

const currentSection = (label: string): Element | null =>
  container.querySelector(`section[aria-label="${label}"]`)

describe('OnboardingWizard flow', () => {
  it('uses a single-column layout before the desktop breakpoint', async () => {
    readyClaudeState()

    await renderWizard()

    const layout = container.querySelector<HTMLElement>('[data-onboarding-layout="split"]')
    expect(layout?.className).toContain('grid-cols-1')
    expect(layout?.className).toContain('md:grid-cols-[240px_minmax(0,1fr)]')
  })

  it('places background preparation beside the onboarding explanation', async () => {
    readyClaudeState()

    await act(async () => {
      root.render(<OnboardingWizard backgroundStatus={<span data-testid="background-status" />} />)
    })

    const introduction = container.querySelector(
      '[aria-labelledby="onboarding-introduction-title"]'
    )
    expect(introduction?.querySelector('[data-testid="background-status"]')).not.toBeNull()
  })

  it('shows only Agent and Model decisions, then completes after provider validation', async () => {
    readyClaudeState()

    await renderWizard()

    expect(currentSection('Set up the agent runtime')).not.toBeNull()
    const progressItems = Array.from(
      container.querySelectorAll('ol[aria-label="Setup progress"] li')
    )
    expect(progressItems.map((item) => item.textContent)).toEqual([
      '1Agent runtime',
      '2Model provider'
    ])
    expect(container.textContent).not.toContain('Notebook runtime')
    expect(container.textContent).not.toContain('Data location')

    await clickButton(/^continue$/i)
    expect(currentSection('Configure model')).not.toBeNull()

    await fillRequiredProviderFields(container)
    await clickButton(/test & continue/i)

    expect(useSettingsStore.getState().completeOnboarding).toHaveBeenCalledOnce()
    expect(window.api.storage.getInfo).not.toHaveBeenCalled()
    expect(window.api.storage.setDataRootAndRelaunch).not.toHaveBeenCalled()
  })

  it('keeps the provider draft after returning to the Agent step', async () => {
    readyClaudeState()

    await renderWizard()
    await clickButton(/^continue$/i)
    await fillRequiredProviderFields(container)
    await clickButton(/^back$/i)
    expect(currentSection('Set up the agent runtime')).not.toBeNull()

    await clickButton(/^continue$/i)
    expect(container.querySelector<HTMLInputElement>('#provider-base-url')?.value).toBe(
      'https://gateway.example'
    )
  })

  it('starts the environment check when mounted outside App without a result', async () => {
    await renderWizard()

    expect(useSettingsStore.getState().checkEnvironment).toHaveBeenCalledOnce()
  })
})
