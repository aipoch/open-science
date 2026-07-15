// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { EnvironmentCheckResult } from '../../../../shared/settings'
import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'
import { OnboardingWizard } from './OnboardingWizard'

let container: HTMLDivElement
let root: Root

const environment = (ready: boolean): EnvironmentCheckResult => ({
  checkedAt: 1,
  platform: 'darwin',
  architecture: 'arm64',
  ready,
  canAutoInstall: !ready,
  recommendedRegistry: ready ? undefined : 'npmmirror',
  claude: ready ? { found: true, path: '/bin/claude', version: '2.1.0' } : { found: false },
  checks: [
    {
      id: 'claude',
      label: 'Claude runtime',
      status: ready ? 'passed' : 'failed',
      summary: ready ? 'Claude is ready.' : 'Claude is not installed yet.'
    }
  ]
})

beforeEach(() => {
  // Reset to a clean store, then stub the actions the wizard calls. Merge (not replace) so the
  // real store's other actions stay intact — matches the pattern used by the other render tests
  // (e.g. SettingsPage.render.test.tsx), since a full replace would need every SettingsStore action
  // stubbed, not just the ones this wizard touches.
  useSettingsStore.setState({
    ...createInitialSettingsState(),
    checkEnvironment: vi.fn().mockResolvedValue(undefined),
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
  it('keeps first-time users on the environment summary until they explicitly continue', async () => {
    useSettingsStore.setState({
      preflight: { claudeReady: true, activeProviderReady: false },
      claude: { resolvedPath: '/bin/claude', version: '2.1.0' },
      environmentCheck: environment(true)
    })

    await act(async () => {
      root.render(<OnboardingWizard />)
    })

    expect(container.querySelector('main')?.className).toContain('overflow-y-auto')
    expect(container.querySelector('section[aria-label="Prepare environment"]')).not.toBeNull()
    expect(container.querySelector('section[aria-label="Configure model"]')).toBeNull()

    const continueButton = Array.from(container.querySelectorAll('button')).find((button) =>
      /continue/i.test(button.textContent ?? '')
    )
    await act(async () => continueButton?.click())

    expect(container.querySelector('section[aria-label="Configure model"]')).not.toBeNull()
  })

  it('blocks continuation while any required environment check fails', async () => {
    useSettingsStore.setState({
      preflight: { claudeReady: false, activeProviderReady: false },
      environmentCheck: environment(false)
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
    expect(container.textContent).toContain('Complete every required item above to continue.')
  })

  it('Back returns from the model step to the Claude step', async () => {
    useSettingsStore.setState({
      preflight: { claudeReady: true, activeProviderReady: false },
      claude: { resolvedPath: '/bin/claude', version: '2.1.0' },
      environmentCheck: environment(true)
    })

    await act(async () => {
      root.render(<OnboardingWizard />)
    })

    const continueButton = Array.from(container.querySelectorAll('button')).find((button) =>
      /continue/i.test(button.textContent ?? '')
    )
    await act(async () => continueButton?.click())

    expect(container.querySelector('section[aria-label="Configure model"]')).not.toBeNull()

    const backButton = Array.from(container.querySelectorAll('button')).find((button) =>
      /back/i.test(button.textContent ?? '')
    )
    await act(async () => {
      backButton?.click()
    })

    expect(container.querySelector('section[aria-label="Prepare environment"]')).not.toBeNull()
  })

  it('defaults to automatic detection and keeps the original installer under the manual tab', async () => {
    useSettingsStore.setState({
      preflight: { claudeReady: false, activeProviderReady: false },
      environmentCheck: environment(false)
    })

    await act(async () => {
      root.render(<OnboardingWizard />)
    })

    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain(
      'Automatic detection'
    )
    expect(container.querySelector('[role="combobox"][aria-label="Install source"]')).toBeNull()

    const manualTab = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    ).find((button) => button.textContent?.includes('Manual setup'))
    await act(async () => manualTab?.click())

    expect(container.querySelector('[role="combobox"][aria-label="Install source"]')).not.toBeNull()
  })

  it('uses the recommended mirror and surfaces the actual automatic install error', async () => {
    const installClaude = vi
      .fn()
      .mockResolvedValue({ installId: 'i', ok: false, error: 'download integrity failed' })
    useSettingsStore.setState({
      preflight: { claudeReady: false, activeProviderReady: false },
      environmentCheck: environment(false),
      installClaude
    })

    await act(async () => {
      root.render(<OnboardingWizard />)
    })

    const installButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.includes('Install missing runtime')
    )
    await act(async () => installButton?.click())

    expect(installClaude).toHaveBeenCalledWith('managed', 'npmmirror')
    expect(container.textContent).toContain('download integrity failed')
  })

  it('re-checks after a successful install and waits for explicit continuation', async () => {
    const checkEnvironment = vi.fn().mockImplementation(async () => {
      useSettingsStore.setState({
        environmentCheck: environment(true),
        preflight: { claudeReady: true, activeProviderReady: false },
        claude: { resolvedPath: '/managed/claude', version: '2.1.0' }
      })
      return environment(true)
    })
    useSettingsStore.setState({
      preflight: { claudeReady: false, activeProviderReady: false },
      environmentCheck: environment(false),
      checkEnvironment
    })

    await act(async () => {
      root.render(<OnboardingWizard />)
    })

    const installButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.includes('Install missing runtime')
    )
    await act(async () => installButton?.click())

    expect(checkEnvironment).toHaveBeenCalledOnce()
    expect(container.querySelector('section[aria-label="Prepare environment"]')).not.toBeNull()
    expect(container.querySelector('section[aria-label="Configure model"]')).toBeNull()

    const continueButton = Array.from(container.querySelectorAll('button')).find((button) =>
      /continue/i.test(button.textContent ?? '')
    )
    await act(async () => continueButton?.click())

    expect(container.querySelector('section[aria-label="Configure model"]')).not.toBeNull()
  })

  it('shows structured install progress and a copyable technical log', async () => {
    useSettingsStore.setState({
      preflight: { claudeReady: false, activeProviderReady: false },
      environmentCheck: environment(false),
      isInstalling: true,
      installLogs: ['Downloading Claude — 5 MB / 10.0 MB']
    })

    await act(async () => {
      root.render(<OnboardingWizard />)
    })

    expect(container.querySelector('[role="status"]')?.textContent).toContain('50%')
    expect(container.querySelector('[aria-label="Automatic setup log"]')?.textContent).toContain(
      'Downloading Claude'
    )
  })

  it('uses a focused repair screen for previously completed onboarding', async () => {
    useSettingsStore.setState({
      onboardingCompletedAt: 1234,
      preflight: { claudeReady: false, activeProviderReady: true },
      environmentCheck: environment(false)
    })

    await act(async () => {
      root.render(<OnboardingWizard />)
    })

    expect(container.textContent).toContain('Open Science needs attention')
    expect(container.querySelector('section[aria-label="Prepare environment"]')).not.toBeNull()
    expect(container.querySelector('section[aria-label="Configure model"]')).toBeNull()
  })

  it('returns a repaired completed user to the app without opening model setup', async () => {
    const closeEnvironmentRepair = vi.fn()
    useSettingsStore.setState({
      onboardingCompletedAt: 1234,
      preflight: { claudeReady: true, activeProviderReady: true },
      environmentCheck: environment(true),
      closeEnvironmentRepair
    })

    await act(async () => {
      root.render(<OnboardingWizard />)
    })

    const returnButton = Array.from(container.querySelectorAll('button')).find((button) =>
      /return to open science/i.test(button.textContent ?? '')
    )
    await act(async () => returnButton?.click())

    expect(closeEnvironmentRepair).toHaveBeenCalledOnce()
    expect(container.querySelector('section[aria-label="Configure model"]')).toBeNull()
  })

  it('defers required-field errors until the first submit attempt', async () => {
    useSettingsStore.setState({
      preflight: { claudeReady: true, activeProviderReady: false },
      claude: { resolvedPath: '/bin/claude', version: '2.1.0' },
      environmentCheck: environment(true)
    })

    await act(async () => {
      root.render(<OnboardingWizard />)
    })

    const continueButton = Array.from(container.querySelectorAll('button')).find((button) =>
      /continue/i.test(button.textContent ?? '')
    )
    await act(async () => continueButton?.click())

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
