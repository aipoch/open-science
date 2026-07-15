// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'
import { OnboardingWizard } from './OnboardingWizard'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  // Reset to a clean store, then stub the actions the wizard calls. Merge (not replace) so the
  // real store's other actions stay intact — matches the pattern used by the other render tests
  // (e.g. SettingsPage.render.test.tsx), since a full replace would need every SettingsStore action
  // stubbed, not just the ones this wizard touches.
  useSettingsStore.setState({
    ...createInitialSettingsState(),
    load: vi.fn().mockResolvedValue(undefined),
    detectClaude: vi.fn().mockResolvedValue({ found: false }),
    installClaude: vi.fn().mockResolvedValue({ installId: 'i', ok: true }),
    completeOnboarding: vi.fn().mockResolvedValue(undefined),
    saveAndActivateProvider: vi
      .fn()
      .mockResolvedValue({ providerId: 'p1', validation: { ok: true, category: 'ok' } })
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

describe('OnboardingWizard', () => {
  it('starts on the Claude step even when Claude is already detected', async () => {
    useSettingsStore.setState({
      preflight: { claudeReady: true, activeProviderReady: false },
      claude: { resolvedPath: '/bin/claude', version: '2.1.0' }
    })

    // The mount effect awaits load() then detectClaude(); flush both inside act.
    await act(async () => {
      root.render(<OnboardingWizard />)
    })

    // The Claude install/status section is present; the model form is not yet shown.
    expect(container.querySelector('section[aria-label="Confirm Claude"]')).not.toBeNull()
    expect(container.querySelector('section[aria-label="Configure model"]')).toBeNull()
  })

  it('renders the approved split shell and advances its accessible progress state', async () => {
    useSettingsStore.setState({
      preflight: { claudeReady: true, activeProviderReady: false },
      claude: { resolvedPath: '/bin/claude', version: '2.1.0' }
    })

    await act(async () => {
      root.render(<OnboardingWizard />)
    })

    const brandLink = Array.from(container.querySelectorAll('a')).find(
      (link) => link.textContent === 'Open Science'
    )

    const layout = container.querySelector('[data-onboarding-layout="split"]')

    expect(layout).not.toBeNull()
    expect(layout?.parentElement?.className).toContain('max-w-[1040px]')
    expect(layout?.className).toContain('grid-cols-[240px_minmax(0,1fr)]')
    expect(layout?.className).toContain('gap-10')
    expect(brandLink?.className).toContain('font-serif')
    expect(brandLink?.className).toContain('text-text-000')
    expect(container.textContent).toContain('Set up your research workspace.')
    expect(container.textContent).toContain(
      'Two quick checks connect the local runtime and the model you want to use.'
    )
    expect(container.querySelector('[aria-current="step"]')?.textContent).toContain(
      'Claude runtime'
    )

    const continueButton = Array.from(container.querySelectorAll('button')).find((button) =>
      /continue/i.test(button.textContent ?? '')
    )

    await act(async () => {
      continueButton?.click()
    })

    expect(container.querySelector('[aria-current="step"]')?.textContent).toContain(
      'Model provider'
    )
    expect(container.textContent).toContain('Connect a model')
    expect(container.textContent).toContain('Test connection & finish')
    expect(container.querySelectorAll('[data-slot="field-help"]')).toHaveLength(3)
  })

  it('Continue is disabled until Claude is ready, then advances to the model step', async () => {
    useSettingsStore.setState({
      preflight: { claudeReady: false, activeProviderReady: false }
    })

    await act(async () => {
      root.render(<OnboardingWizard />)
    })

    const findContinueButton = (): HTMLButtonElement | null => {
      const buttons = Array.from(container.querySelectorAll('button'))
      return (buttons.find((button) => /continue/i.test(button.textContent ?? '')) ??
        null) as HTMLButtonElement | null
    }

    const continueButton = findContinueButton()
    expect(continueButton).not.toBeNull()
    expect(continueButton?.getAttribute('disabled')).not.toBeNull()

    await act(async () => {
      useSettingsStore.setState({ preflight: { claudeReady: true, activeProviderReady: false } })
    })

    const enabled = findContinueButton()
    expect(enabled).not.toBeNull()
    expect(enabled?.getAttribute('disabled')).toBeNull()

    await act(async () => {
      enabled?.click()
    })

    expect(container.querySelector('section[aria-label="Configure model"]')).not.toBeNull()
  })

  it('Back returns from the model step to the Claude step', async () => {
    useSettingsStore.setState({
      preflight: { claudeReady: true, activeProviderReady: false },
      claude: { resolvedPath: '/bin/claude', version: '2.1.0' }
    })

    await act(async () => {
      root.render(<OnboardingWizard />)
    })

    const continueButton = Array.from(container.querySelectorAll('button')).find((button) =>
      /continue/i.test(button.textContent ?? '')
    )
    await act(async () => {
      continueButton?.click()
    })

    expect(container.querySelector('section[aria-label="Configure model"]')).not.toBeNull()

    const backButton = Array.from(container.querySelectorAll('button')).find((button) =>
      /back/i.test(button.textContent ?? '')
    )
    await act(async () => {
      backButton?.click()
    })

    expect(container.querySelector('section[aria-label="Confirm Claude"]')).not.toBeNull()
  })

  it('hides the install source UI once Claude is detected', async () => {
    useSettingsStore.setState({
      preflight: { claudeReady: true, activeProviderReady: false },
      claude: { resolvedPath: '/bin/claude', version: '2.1.0' }
    })

    await act(async () => {
      root.render(<OnboardingWizard />)
    })

    // Nothing to install when claude is already runnable — the install source picker is gone.
    expect(container.querySelector('[role="combobox"][aria-label="Install source"]')).toBeNull()
  })

  it('shows the install source UI when Claude is missing', async () => {
    useSettingsStore.setState({
      preflight: { claudeReady: false, activeProviderReady: false }
    })

    await act(async () => {
      root.render(<OnboardingWizard />)
    })

    expect(container.querySelector('[role="combobox"][aria-label="Install source"]')).not.toBeNull()
  })

  it('defers required-field errors until the first submit attempt', async () => {
    useSettingsStore.setState({
      preflight: { claudeReady: true, activeProviderReady: false },
      claude: { resolvedPath: '/bin/claude', version: '2.1.0' }
    })

    await act(async () => {
      root.render(<OnboardingWizard />)
    })

    // Advance to the model step.
    const continueButton = Array.from(container.querySelectorAll('button')).find((button) =>
      /continue/i.test(button.textContent ?? '')
    )
    await act(async () => {
      continueButton?.click()
    })

    // Untouched form: no "required" errors yet, just the * markers.
    expect(container.textContent).not.toContain('Base URL is required.')

    const testButton = Array.from(container.querySelectorAll('button')).find((button) =>
      /test connection/i.test(button.textContent ?? '')
    )
    await act(async () => {
      testButton?.click()
    })

    // Submitting an incomplete form surfaces the errors and does not attempt to save/validate.
    expect(container.textContent).toContain('Base URL is required.')
    expect(useSettingsStore.getState().saveAndActivateProvider).not.toHaveBeenCalled()
  })
})
