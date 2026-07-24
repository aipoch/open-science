// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { EnvironmentCheckResult, ValidateProviderResult } from '../../../../shared/settings'
import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'
import { OnboardingWizard } from './OnboardingWizard'

// The Codex authentication picker is a Radix Select, which calls pointer-capture and scroll APIs
// jsdom does not implement.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = (): boolean => false
  Element.prototype.setPointerCapture = (): void => undefined
  Element.prototype.releasePointerCapture = (): void => undefined
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = (): void => undefined
}

let container: HTMLDivElement
let root: Root

const DEFAULT_DATA_ROOT = '/home/u/.open-science'

const environment = (ready: boolean): EnvironmentCheckResult => ({
  checkedAt: 1,
  platform: 'darwin',
  architecture: 'arm64',
  ready,
  canAutoInstall: !ready,
  recommendedRegistry: ready ? undefined : 'npmmirror',
  agentFrameworkId: 'claude-code',
  runtime: ready ? { found: true, path: '/bin/claude', version: '2.1.0' } : { found: false },
  checks: [
    {
      id: 'agent',
      label: 'Claude runtime',
      status: ready ? 'passed' : 'failed',
      summary: ready ? 'Claude is ready.' : 'Claude is not installed yet.'
    }
  ]
})

// Searches document.body (not just container) because the confirm dialog is portaled directly to
// the body, same as the reference pattern in SettingsPage.render.test.tsx.
const findButton = (matcher: RegExp): HTMLButtonElement | null =>
  (Array.from(document.body.querySelectorAll('button')).find((button) =>
    matcher.test(button.textContent ?? '')
  ) ?? null) as HTMLButtonElement | null

const clickButton = async (matcher: RegExp): Promise<void> => {
  const button = findButton(matcher)
  await act(async () => {
    button?.click()
  })
}

// Fills the custom-provider required fields (base URL, key, model) so "Test & continue" proceeds
// to saveAndActivateProvider instead of stopping on required-field errors.
const fillRequiredProviderFields = async (): Promise<void> => {
  const dispatch = (input: HTMLInputElement, value: string): void => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }

  await act(async () => {
    const baseUrl = container.querySelector<HTMLInputElement>('#provider-base-url')
    const key = container.querySelector<HTMLInputElement>('#provider-key')
    const model = container.querySelector<HTMLInputElement>('#provider-model')
    if (baseUrl) dispatch(baseUrl, 'https://gateway.example')
    if (key) dispatch(key, 'sk-test')
    if (model) dispatch(model, 'claude-sonnet-4-5')
  })
}

// Location is the last step: reaching it means walking through Environment -> Model -> a successful
// "Test & continue" first, same as a real user would. Assumes environment(true) is set up.
const goToLocationStep = async (): Promise<void> => {
  await clickButton(/continue/i)
  await fillRequiredProviderFields()
  await clickButton(/test & continue/i)
}

// Opens a Radix Select trigger and clicks an option by visible text (options portal to body). Mirrors
// the proven ActiveModelSelect.render.test.tsx pattern, since jsdom needs the pointer events.
const selectOption = async (triggerLabel: string, optionText: string): Promise<void> => {
  const trigger = document.body.querySelector<HTMLButtonElement>(`[aria-label="${triggerLabel}"]`)
  await act(async () => {
    trigger?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  const option = Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]')).find(
    (candidate) => candidate.textContent?.includes(optionText)
  )
  await act(async () => {
    option?.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }))
    option?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

// A Codex-ready environment so the wizard opens straight onto the Codex provider step on Continue.
const codexReadyState = (): Partial<ReturnType<typeof createInitialSettingsState>> => ({
  agentFrameworkId: 'codex' as const,
  preflight: {
    claudeReady: false,
    opencodeReady: false,
    codexReady: true,
    agentFrameworkId: 'codex' as const,
    agentReady: true,
    activeProviderReady: false
  },
  environmentCheck: { ...environment(true), agentFrameworkId: 'codex' as const }
})

// Walks to the Codex provider step and switches the auth picker to the isolated "Sign in with Open
// Science" mode — the only path that runs the browser login (loginIsolatedCodex).
const goToIsolatedCodexStep = async (): Promise<void> => {
  await clickButton(/^continue$/i)
  await selectOption('Codex authentication', 'Sign in with Open Science')
}

beforeEach(() => {
  // Reset to a clean store, then stub the actions the wizard calls. Merge (not replace) so the
  // real store's other actions stay intact — matches the pattern used by the other render tests
  // (e.g. SettingsPage.render.test.tsx), since a full replace would need every SettingsStore action
  // stubbed, not just the ones this wizard touches.
  useSettingsStore.setState({
    ...createInitialSettingsState(),
    checkEnvironment: vi.fn().mockResolvedValue(undefined),
    detectClaude: vi.fn().mockResolvedValue({ found: false }),
    detectCodex: vi.fn().mockResolvedValue(undefined),
    installClaude: vi.fn().mockResolvedValue({ installId: 'i', ok: true }),
    installCodex: vi.fn().mockResolvedValue({ installId: 'i', ok: true }),
    completeOnboarding: vi.fn().mockResolvedValue(undefined),
    saveAndActivateProvider: vi
      .fn()
      .mockResolvedValue({ providerId: 'p1', validation: { ok: true, category: 'ok' } })
  })

  ;(window as unknown as { api: unknown }).api = {
    storage: {
      getInfo: vi.fn().mockResolvedValue({
        dataRoot: DEFAULT_DATA_ROOT,
        isDefault: true,
        usage: { categories: [], totalBytes: 0 },
        availableBytes: 500_000_000_000
      }),
      pickDirectory: vi.fn().mockResolvedValue(null),
      inspectDataRoot: vi
        .fn()
        .mockResolvedValue({ kind: 'move', dataRoot: '/mnt/data/OpenScience' }),
      setDataRootAndRelaunch: vi.fn().mockResolvedValue({ ok: true })
    },
    // The optional RuntimeChoiceCard lists detected interpreters on mount; stub so the effect resolves.
    runtime: {
      listEnvironments: vi.fn().mockResolvedValue({ python: [], r: [] }),
      getEnablement: vi.fn().mockResolvedValue({ enabled: {}, installAuthorized: {} }),
      setEnvironmentEnabled: vi.fn().mockResolvedValue({ enabled: {}, installAuthorized: {} }),
      registerInterpreter: vi.fn().mockResolvedValue([]),
      pickInterpreter: vi.fn().mockResolvedValue(null)
    }
  }

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

describe('OnboardingWizard', () => {
  it('offers all three agent frameworks and switches to Codex on selection', async () => {
    const setAgentFramework = vi.fn().mockResolvedValue(undefined)
    const checkEnvironment = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      agentFrameworkId: 'claude-code',
      agentFrameworks: [
        { id: 'claude-code', displayName: 'Claude Code', supportsSkills: true },
        { id: 'opencode', displayName: 'OpenCode', supportsSkills: true },
        { id: 'codex', displayName: 'Codex', supportsSkills: true }
      ],
      setAgentFramework,
      checkEnvironment,
      environmentCheck: environment(true)
    })

    act(() => {
      root.render(<OnboardingWizard />)
    })

    const radios = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radio"]'))
    expect(radios.map((r) => r.textContent)).toEqual(['Claude Code', 'OpenCode', 'Codex'])
    expect(radios[0].getAttribute('aria-checked')).toBe('true')

    await act(async () => {
      radios[2].click()
    })

    expect(setAgentFramework).toHaveBeenCalledWith('codex')
    expect(checkEnvironment).toHaveBeenCalled()
  })

  it('disables Continue when the latest check is for a different framework than selected', async () => {
    // The env result is a READY Claude check, but OpenCode is now selected — Continue must stay
    // disabled until a re-check for OpenCode lands (the stale Claude result must not slip through).
    useSettingsStore.setState({
      agentFrameworkId: 'opencode',
      agentFrameworks: [
        { id: 'claude-code', displayName: 'Claude Code', supportsSkills: true },
        { id: 'opencode', displayName: 'OpenCode', supportsSkills: true }
      ],
      setAgentFramework: vi.fn().mockResolvedValue(undefined),
      checkEnvironment: vi.fn().mockResolvedValue(undefined),
      environmentCheck: environment(true) // agentFrameworkId: 'claude-code'
    })

    act(() => {
      root.render(<OnboardingWizard />)
    })

    const continueButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Continue'
    )
    expect(continueButton?.disabled).toBe(true)
  })

  it('keeps first-time users on the environment summary until they explicitly continue', async () => {
    useSettingsStore.setState({
      preflight: {
        claudeReady: true,
        opencodeReady: false,
        codexReady: false,
        agentFrameworkId: 'claude-code',
        agentReady: true,
        activeProviderReady: false
      },
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
      preflight: {
        claudeReady: false,
        opencodeReady: false,
        codexReady: false,
        agentFrameworkId: 'claude-code',
        agentReady: false,
        activeProviderReady: false
      },
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
      preflight: {
        claudeReady: true,
        opencodeReady: false,
        codexReady: false,
        agentFrameworkId: 'claude-code',
        agentReady: true,
        activeProviderReady: false
      },
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
      preflight: {
        claudeReady: false,
        opencodeReady: false,
        codexReady: false,
        agentFrameworkId: 'claude-code',
        agentReady: false,
        activeProviderReady: false
      },
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
    // The manual tab shows ONLY the selected framework's runtime (default: Claude), not the other.
    expect(container.textContent).toContain('Claude')
    expect(container.textContent).not.toContain('OpenCode not detected')
  })

  it('routes the manual OpenCode install button to installOpencode, not installClaude', async () => {
    const installOpencode = vi.fn().mockResolvedValue({ installId: 'i', ok: true })
    const installClaude = vi.fn().mockResolvedValue({ installId: 'i', ok: true })
    useSettingsStore.setState({
      // OpenCode is the selected framework, so the manual tab shows only its (not-detected) card and
      // its install button must route to installOpencode, never installClaude.
      agentFrameworkId: 'opencode',
      preflight: {
        claudeReady: true,
        opencodeReady: false,
        codexReady: false,
        agentFrameworkId: 'opencode',
        agentReady: false,
        activeProviderReady: false
      },
      claude: { resolvedPath: '/bin/claude', version: '2.1.0' },
      environmentCheck: environment(false),
      installOpencode,
      installClaude
    })

    await act(async () => {
      root.render(<OnboardingWizard />)
    })

    const manualTab = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    ).find((button) => button.textContent?.includes('Manual setup'))
    await act(async () => manualTab?.click())

    // Only the selected (OpenCode) runtime shows, so there is exactly one install button — its own.
    expect(container.textContent).toContain('OpenCode not detected')
    const installButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button')
    ).filter((button) => /install with one click/i.test(button.textContent ?? ''))
    expect(installButtons).toHaveLength(1)
    await act(async () => installButtons[0].click())

    // Default source is 'managed'; the OpenCode card must route to installOpencode, never installClaude.
    expect(installOpencode).toHaveBeenCalledWith('managed')
    expect(installClaude).not.toHaveBeenCalled()
  })

  it('uses Codex detection and the managed Codex installer in manual setup', async () => {
    const detectCodex = vi.fn().mockResolvedValue(undefined)
    const checkEnvironment = vi.fn().mockResolvedValue(undefined)
    const installCodex = vi.fn().mockResolvedValue({ installId: 'codex-i', ok: true })
    const installClaude = vi.fn().mockResolvedValue({ installId: 'claude-i', ok: true })
    const installOpencode = vi.fn().mockResolvedValue({ installId: 'opencode-i', ok: true })
    useSettingsStore.setState({
      agentFrameworkId: 'codex',
      codex: {},
      preflight: {
        claudeReady: true,
        opencodeReady: true,
        codexReady: false,
        agentFrameworkId: 'codex',
        agentReady: false,
        activeProviderReady: false
      },
      environmentCheck: environment(false),
      detectCodex,
      checkEnvironment,
      installCodex,
      installClaude,
      installOpencode
    })

    await act(async () => {
      root.render(<OnboardingWizard />)
    })
    await clickButton(/manual setup/i)

    expect(container.textContent).toContain('Codex not detected')
    expect(container.textContent).not.toContain('ChatGPT')
    const source = container.querySelector<HTMLButtonElement>('[aria-label="Install source"]')
    expect(source?.getAttribute('role')).toBe('combobox')
    expect(source?.textContent).toContain('App-managed download (recommended)')
    expect(container.textContent).not.toContain('Official install')

    await clickButton(/re-detect/i)
    expect(detectCodex).toHaveBeenCalledOnce()
    expect(checkEnvironment).toHaveBeenCalledOnce()

    await clickButton(/install with one click/i)
    expect(installCodex).toHaveBeenCalledWith('managed')
    expect(installClaude).not.toHaveBeenCalled()
    expect(installOpencode).not.toHaveBeenCalled()
  })

  it('routes automatic Codex installation through installCodex', async () => {
    const installCodex = vi.fn().mockResolvedValue({ installId: 'codex-i', ok: true })
    const checkEnvironment = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      agentFrameworkId: 'codex',
      preflight: {
        claudeReady: false,
        opencodeReady: false,
        codexReady: false,
        agentFrameworkId: 'codex',
        agentReady: false,
        activeProviderReady: false
      },
      environmentCheck: { ...environment(false), agentFrameworkId: 'codex' },
      installCodex,
      checkEnvironment
    })

    await act(async () => {
      root.render(<OnboardingWizard />)
    })
    await clickButton(/install missing runtime/i)

    expect(installCodex).toHaveBeenCalledWith('managed')
    expect(checkEnvironment).toHaveBeenCalledOnce()
  })

  it('prefills the existing Codex subscription profile for Codex', async () => {
    useSettingsStore.setState({
      agentFrameworkId: 'codex',
      preflight: {
        claudeReady: false,
        opencodeReady: false,
        codexReady: true,
        agentFrameworkId: 'codex',
        agentReady: true,
        activeProviderReady: false
      },
      environmentCheck: { ...environment(true), agentFrameworkId: 'codex' }
    })

    await act(async () => {
      root.render(<OnboardingWizard />)
    })
    await clickButton(/^continue$/i)

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

  it('runs the isolated Codex sign-in then advances to the location step', async () => {
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

    await act(async () => {
      root.render(<OnboardingWizard />)
    })
    await goToIsolatedCodexStep()
    await clickButton(/sign in & continue/i)

    // Persist happens before the browser login, and only a recorded success activates + advances.
    expect(persistProvider).toHaveBeenCalledOnce()
    expect(loginIsolatedCodex).toHaveBeenCalledOnce()
    expect(setActiveProvider).toHaveBeenCalledWith('builtin-codex-isolated')
    expect(container.textContent).toContain('Where should Open Science store your data?')
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

    await act(async () => {
      root.render(<OnboardingWizard />)
    })
    await goToIsolatedCodexStep()
    await clickButton(/sign in & continue/i)

    // A failed sign-in never activates and never leaves the provider step; the reason is surfaced.
    expect(setActiveProvider).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Codex sign-in was cancelled.')
    expect(container.textContent).not.toContain('Where should Open Science store your data?')
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

    await act(async () => {
      root.render(<OnboardingWizard />)
    })
    await goToIsolatedCodexStep()
    await clickButton(/sign in & continue/i)

    expect(setActiveProvider).not.toHaveBeenCalled()
    expect(container.textContent).toContain('The Codex provider changed during sign-in')
    expect(container.textContent).not.toContain('Where should Open Science store your data?')
  })

  it('verifies a pasted Claude setup-token before activating and advancing', async () => {
    const persistProvider = vi.fn().mockResolvedValue('builtin-claude-isolated')
    const loginIsolatedClaude = vi
      .fn()
      .mockResolvedValue({ ok: true, category: 'ok', applied: true })
    const setActiveProvider = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      preflight: {
        claudeReady: true,
        opencodeReady: false,
        codexReady: false,
        agentFrameworkId: 'claude-code',
        agentReady: true,
        activeProviderReady: false
      },
      claude: { resolvedPath: '/bin/claude', version: '2.1.0' },
      environmentCheck: environment(true),
      persistProvider,
      loginIsolatedClaude,
      setActiveProvider
    })

    await act(async () => root.render(<OnboardingWizard />))
    await clickButton(/^continue$/i)
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
    expect(container.textContent).toContain('Where should Open Science store your data?')
  })

  it('shows a rejected Claude setup-token and stays on the provider step', async () => {
    const setActiveProvider = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      preflight: {
        claudeReady: true,
        opencodeReady: false,
        codexReady: false,
        agentFrameworkId: 'claude-code',
        agentReady: true,
        activeProviderReady: false
      },
      claude: { resolvedPath: '/bin/claude', version: '2.1.0' },
      environmentCheck: environment(true),
      persistProvider: vi.fn().mockResolvedValue('builtin-claude-isolated'),
      loginIsolatedClaude: vi.fn().mockResolvedValue({
        ok: false,
        category: 'auth',
        applied: true,
        message: 'Claude rejected the setup token. Run `claude setup-token` again.'
      }),
      setActiveProvider
    })

    await act(async () => root.render(<OnboardingWizard />))
    await clickButton(/^continue$/i)
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
    expect(container.textContent).toContain('Claude rejected the setup token')
    expect(container.textContent).not.toContain('Where should Open Science store your data?')
  })

  it('cancels an in-flight isolated sign-in when the wizard unmounts', async () => {
    const cancelCodexLogin = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      ...codexReadyState(),
      persistProvider: vi.fn().mockResolvedValue('builtin-codex-isolated'),
      // Never resolves: the login is still pending when the wizard unmounts (app quit/relaunch).
      loginIsolatedCodex: vi.fn(() => new Promise<ValidateProviderResult>(() => undefined)),
      cancelCodexLogin
    })

    await act(async () => {
      root.render(<OnboardingWizard />)
    })
    await goToIsolatedCodexStep()
    await clickButton(/sign in & continue/i)

    // Teardown must abort the main-process login so the next attempt starts clean.
    expect(cancelCodexLogin).not.toHaveBeenCalled()
    await act(async () => root.unmount())
    expect(cancelCodexLogin).toHaveBeenCalledOnce()
  })

  const twoFrameworks = [
    { id: 'claude-code' as const, displayName: 'Claude Code', supportsSkills: true },
    { id: 'opencode' as const, displayName: 'OpenCode', supportsSkills: true }
  ]

  const threeFrameworks = [
    ...twoFrameworks,
    { id: 'codex' as const, displayName: 'Codex', supportsSkills: true }
  ]

  it('auto-selects OpenCode when Claude is not installed but OpenCode is', async () => {
    const setAgentFramework = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      agentFrameworkId: 'claude-code',
      agentFrameworks: twoFrameworks,
      setAgentFramework,
      // Claude missing, OpenCode present: the prefer-installed rule switches to OpenCode.
      preflight: {
        claudeReady: false,
        opencodeReady: true,
        codexReady: false,
        agentFrameworkId: 'claude-code',
        agentReady: false,
        activeProviderReady: false
      },
      environmentCheck: environment(false)
    })

    await act(async () => {
      root.render(<OnboardingWizard />)
    })

    expect(setAgentFramework).toHaveBeenCalledWith('opencode')
  })

  it('auto-selects Codex when it is the only installed runtime', async () => {
    const setAgentFramework = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      agentFrameworkId: 'claude-code',
      agentFrameworks: threeFrameworks,
      setAgentFramework,
      preflight: {
        claudeReady: false,
        opencodeReady: false,
        codexReady: true,
        agentFrameworkId: 'claude-code',
        agentReady: false,
        activeProviderReady: false
      },
      environmentCheck: environment(false)
    })

    await act(async () => {
      root.render(<OnboardingWizard />)
    })

    expect(setAgentFramework).toHaveBeenCalledWith('codex')
  })

  it('prefers Claude and does not auto-switch when Claude is installed', async () => {
    const setAgentFramework = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      agentFrameworkId: 'claude-code',
      agentFrameworks: twoFrameworks,
      setAgentFramework,
      // Both installed → keep the Claude default; no auto-switch.
      preflight: {
        claudeReady: true,
        opencodeReady: true,
        codexReady: false,
        agentFrameworkId: 'claude-code',
        agentReady: true,
        activeProviderReady: false
      },
      environmentCheck: environment(true)
    })

    await act(async () => {
      root.render(<OnboardingWizard />)
    })

    expect(setAgentFramework).not.toHaveBeenCalled()
  })

  it('does not auto-switch for a returning (recovery) user', async () => {
    const setAgentFramework = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      onboardingCompletedAt: 1234,
      agentFrameworkId: 'claude-code',
      agentFrameworks: twoFrameworks,
      setAgentFramework,
      preflight: {
        claudeReady: false,
        opencodeReady: true,
        codexReady: false,
        agentFrameworkId: 'claude-code',
        agentReady: false,
        activeProviderReady: false
      },
      environmentCheck: environment(false)
    })

    await act(async () => {
      root.render(<OnboardingWizard />)
    })

    expect(setAgentFramework).not.toHaveBeenCalled()
  })

  it('collapses the switcher to a "Change agent" link when the selected agent is ready', async () => {
    useSettingsStore.setState({
      agentFrameworkId: 'claude-code',
      agentFrameworks: twoFrameworks,
      claude: { resolvedPath: '/bin/claude', version: '2.1.0' },
      preflight: {
        claudeReady: true,
        opencodeReady: false,
        codexReady: false,
        agentFrameworkId: 'claude-code',
        agentReady: true,
        activeProviderReady: false
      },
      environmentCheck: environment(true)
    })

    await act(async () => {
      root.render(<OnboardingWizard />)
    })

    // Ready → the toggle is hidden; only a "Change agent" affordance shows.
    expect(container.querySelector('[role="radiogroup"][aria-label="Agent framework"]')).toBeNull()
    const changeButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => /change agent/i.test(button.textContent ?? '')
    )
    expect(changeButton).not.toBeUndefined()

    // Revealing it exposes the full Claude Code / OpenCode toggle.
    await act(async () => changeButton?.click())
    expect(
      container.querySelector('[role="radiogroup"][aria-label="Agent framework"]')
    ).not.toBeNull()
  })

  it('drops a second framework switch while the first is still in flight', async () => {
    let releaseSwitch: (() => void) | undefined
    const setAgentFramework = vi
      .fn()
      .mockImplementation(() => new Promise<void>((resolve) => (releaseSwitch = resolve)))
    useSettingsStore.setState({
      agentFrameworkId: 'claude-code',
      agentFrameworks: twoFrameworks,
      setAgentFramework,
      checkEnvironment: vi.fn().mockResolvedValue(undefined),
      preflight: {
        claudeReady: false,
        opencodeReady: false,
        codexReady: false,
        agentFrameworkId: 'claude-code',
        agentReady: false,
        activeProviderReady: false
      },
      environmentCheck: environment(false)
    })

    await act(async () => {
      root.render(<OnboardingWizard />)
    })

    const opencodeRadio = (): HTMLButtonElement | undefined =>
      Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radio"]')).find((button) =>
        /opencode/i.test(button.textContent ?? '')
      )
    // Two rapid clicks before the first switch resolves: the in-flight guard collapses them into one.
    await act(async () => opencodeRadio()?.click())
    await act(async () => opencodeRadio()?.click())

    expect(setAgentFramework).toHaveBeenCalledTimes(1)

    await act(async () => releaseSwitch?.())
  })

  it('disables all framework choices while Codex detection is in flight', async () => {
    useSettingsStore.setState({
      agentFrameworkId: 'claude-code',
      agentFrameworks: threeFrameworks,
      isDetectingCodex: true,
      preflight: {
        claudeReady: false,
        opencodeReady: false,
        codexReady: false,
        agentFrameworkId: 'claude-code',
        agentReady: false,
        activeProviderReady: false
      },
      environmentCheck: environment(false)
    })

    await act(async () => {
      root.render(<OnboardingWizard />)
    })

    const radios = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radio"]'))
    expect(radios).toHaveLength(3)
    expect(radios.every((radio) => radio.disabled)).toBe(true)
  })

  it('uses the recommended mirror and surfaces the actual automatic install error', async () => {
    const installClaude = vi
      .fn()
      .mockResolvedValue({ installId: 'i', ok: false, error: 'download integrity failed' })
    useSettingsStore.setState({
      preflight: {
        claudeReady: false,
        opencodeReady: false,
        codexReady: false,
        agentFrameworkId: 'claude-code',
        agentReady: false,
        activeProviderReady: false
      },
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
        preflight: {
          claudeReady: true,
          opencodeReady: false,
          codexReady: false,
          agentFrameworkId: 'claude-code',
          agentReady: true,
          activeProviderReady: false
        },
        claude: { resolvedPath: '/managed/claude', version: '2.1.0' }
      })
      return environment(true)
    })
    useSettingsStore.setState({
      preflight: {
        claudeReady: false,
        opencodeReady: false,
        codexReady: false,
        agentFrameworkId: 'claude-code',
        agentReady: false,
        activeProviderReady: false
      },
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
      preflight: {
        claudeReady: false,
        opencodeReady: false,
        codexReady: false,
        agentFrameworkId: 'claude-code',
        agentReady: false,
        activeProviderReady: false
      },
      environmentCheck: environment(false),
      installStates: {
        'claude-code': {
          isInstalling: true,
          installLogs: ['Downloading Claude — 5 MB / 10.0 MB'],
          installProgress: null,
          installError: undefined
        },
        opencode: {
          isInstalling: false,
          installLogs: [],
          installProgress: null,
          installError: undefined
        },
        codex: {
          isInstalling: false,
          installLogs: [],
          installProgress: null,
          installError: undefined
        }
      }
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
      preflight: {
        claudeReady: false,
        opencodeReady: false,
        codexReady: false,
        agentFrameworkId: 'claude-code',
        agentReady: false,
        activeProviderReady: true
      },
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
      preflight: {
        claudeReady: true,
        opencodeReady: false,
        codexReady: false,
        agentFrameworkId: 'claude-code',
        agentReady: true,
        activeProviderReady: true
      },
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
      preflight: {
        claudeReady: true,
        opencodeReady: false,
        codexReady: false,
        agentFrameworkId: 'claude-code',
        agentReady: true,
        activeProviderReady: false
      },
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
      /test & continue/i.test(button.textContent ?? '')
    )
    await act(async () => {
      testButton?.click()
    })

    // Submitting an incomplete form surfaces the errors and does not attempt to save/validate.
    expect(container.textContent).toContain('Base URL is required.')
    expect(useSettingsStore.getState().saveAndActivateProvider).not.toHaveBeenCalled()
  })

  describe('data location step', () => {
    // These tests always start from a ready environment so Continue is enabled and the flow can
    // reach the model and, finally, the location step.
    const readyEnvironment = (): void => {
      useSettingsStore.setState({
        preflight: {
          claudeReady: true,
          opencodeReady: false,
          codexReady: false,
          agentFrameworkId: 'claude-code',
          agentReady: true,
          activeProviderReady: false
        },
        claude: { resolvedPath: '/bin/claude', version: '2.1.0' },
        environmentCheck: environment(true)
      })
    }

    it('model validation success advances to Location and does not complete onboarding', async () => {
      readyEnvironment()

      await act(async () => {
        root.render(<OnboardingWizard />)
      })
      await goToLocationStep()

      expect(container.querySelector('section[aria-label="Choose data location"]')).not.toBeNull()
      expect(container.querySelector('section[aria-label="Configure model"]')).toBeNull()
      expect(useSettingsStore.getState().completeOnboarding).not.toHaveBeenCalled()
      expect(window.api.storage.setDataRootAndRelaunch).not.toHaveBeenCalled()
    })

    it('Back returns from the Location step to the Model step', async () => {
      readyEnvironment()

      await act(async () => {
        root.render(<OnboardingWizard />)
      })
      await goToLocationStep()

      expect(container.querySelector('section[aria-label="Choose data location"]')).not.toBeNull()

      await clickButton(/back/i)

      expect(container.querySelector('section[aria-label="Configure model"]')).not.toBeNull()
    })

    it('shows the default location fetched from storage.getInfo', async () => {
      readyEnvironment()

      await act(async () => {
        root.render(<OnboardingWizard />)
      })
      await goToLocationStep()

      expect(container.textContent).toContain(DEFAULT_DATA_ROOT)
    })

    it('shows the warning callout on the Location step', async () => {
      readyEnvironment()

      await act(async () => {
        root.render(<OnboardingWizard />)
      })
      await goToLocationStep()

      expect(container.textContent).toContain('Open Science manages this folder')
      expect(container.textContent).toContain(
        "Don't move, rename, or delete files inside it — doing so can break your projects and history."
      )
    })

    it('Browse with a valid path shows the final path and the restart note', async () => {
      window.api.storage.pickDirectory = vi.fn().mockResolvedValue('/mnt/data')
      window.api.storage.inspectDataRoot = vi
        .fn()
        .mockResolvedValue({ kind: 'move', dataRoot: '/mnt/data/OpenScience' })
      readyEnvironment()

      await act(async () => {
        root.render(<OnboardingWizard />)
      })
      await goToLocationStep()
      await clickButton(/browse/i)

      expect(window.api.storage.inspectDataRoot).toHaveBeenCalledWith('/mnt/data')
      expect(container.textContent).toContain('/mnt/data/OpenScience')
      expect(container.textContent).toContain('Open Science will restart to set this up')
    })

    it('Browse with an adopt path shows the used-as-is note', async () => {
      window.api.storage.pickDirectory = vi.fn().mockResolvedValue('/mnt/existing')
      window.api.storage.inspectDataRoot = vi
        .fn()
        .mockResolvedValue({ kind: 'adopt', dataRoot: '/mnt/existing/OpenScience' })
      readyEnvironment()

      await act(async () => {
        root.render(<OnboardingWizard />)
      })
      await goToLocationStep()
      await clickButton(/browse/i)

      expect(container.textContent).toContain('/mnt/existing/OpenScience')
      expect(container.textContent).toContain('already contains Open Science data')
      expect(container.textContent).toContain('used as-is')
    })

    it('Browse with an invalid path shows the inline error and does not set the field', async () => {
      window.api.storage.pickDirectory = vi.fn().mockResolvedValue('/mnt/bad')
      window.api.storage.inspectDataRoot = vi.fn().mockResolvedValue({
        kind: 'invalid',
        dataRoot: '/mnt/bad/OpenScience',
        error: 'The selected folder is not writable.'
      })
      readyEnvironment()

      await act(async () => {
        root.render(<OnboardingWizard />)
      })
      await goToLocationStep()
      await clickButton(/browse/i)

      expect(container.textContent).toContain('The selected folder is not writable.')
      expect(container.textContent).not.toContain('/mnt/bad/OpenScience')
    })

    it('Browse cancelled (null) leaves the default location untouched', async () => {
      window.api.storage.pickDirectory = vi.fn().mockResolvedValue(null)
      readyEnvironment()

      await act(async () => {
        root.render(<OnboardingWizard />)
      })
      await goToLocationStep()
      await clickButton(/browse/i)

      expect(window.api.storage.inspectDataRoot).not.toHaveBeenCalled()
      expect(container.textContent).not.toContain('restart to set this up')
    })

    it('"Use default location" clears a previously chosen path', async () => {
      window.api.storage.pickDirectory = vi.fn().mockResolvedValue('/mnt/data')
      window.api.storage.inspectDataRoot = vi
        .fn()
        .mockResolvedValue({ kind: 'move', dataRoot: '/mnt/data/OpenScience' })
      readyEnvironment()

      await act(async () => {
        root.render(<OnboardingWizard />)
      })
      await goToLocationStep()
      await clickButton(/browse/i)
      expect(container.textContent).toContain('/mnt/data/OpenScience')

      await clickButton(/use default location/i)

      expect(container.textContent).not.toContain('restart to set this up')
    })

    it('Finish with the default location kept completes onboarding without relaunching', async () => {
      readyEnvironment()

      await act(async () => {
        root.render(<OnboardingWizard />)
      })
      await goToLocationStep()
      await clickButton(/finish/i)

      expect(useSettingsStore.getState().completeOnboarding).toHaveBeenCalledTimes(1)
      expect(window.api.storage.setDataRootAndRelaunch).not.toHaveBeenCalled()
      expect(document.body.querySelector('[role="alertdialog"]')).toBeNull()
    })

    it('Finish with a chosen non-default path shows a restart confirm dialog', async () => {
      window.api.storage.pickDirectory = vi.fn().mockResolvedValue('/mnt/data')
      window.api.storage.inspectDataRoot = vi
        .fn()
        .mockResolvedValue({ kind: 'move', dataRoot: '/mnt/data/OpenScience' })
      readyEnvironment()

      await act(async () => {
        root.render(<OnboardingWizard />)
      })
      await goToLocationStep()
      await clickButton(/browse/i)
      await clickButton(/finish/i)

      expect(document.body.querySelector('[role="alertdialog"]')).not.toBeNull()
      expect(document.body.textContent).toContain('/mnt/data/OpenScience')
      // The dialog gates the relaunch; nothing has happened yet.
      expect(window.api.storage.setDataRootAndRelaunch).not.toHaveBeenCalled()
    })

    it('Restart in the confirm dialog calls setDataRootAndRelaunch without flipping the renderer gate', async () => {
      window.api.storage.pickDirectory = vi.fn().mockResolvedValue('/mnt/data')
      window.api.storage.inspectDataRoot = vi
        .fn()
        .mockResolvedValue({ kind: 'move', dataRoot: '/mnt/data/OpenScience' })
      window.api.storage.setDataRootAndRelaunch = vi.fn().mockResolvedValue({ ok: true })
      readyEnvironment()

      await act(async () => {
        root.render(<OnboardingWizard />)
      })
      await goToLocationStep()
      await clickButton(/browse/i)
      await clickButton(/finish/i)
      await clickButton(/^restart$/i)

      expect(window.api.storage.setDataRootAndRelaunch).toHaveBeenCalledWith('/mnt/data', true)
      // The renderer-side gate must not flip before the main-process relaunch step: only main marks
      // onboarding complete now, inside set-data-root-and-relaunch, so this must never be called.
      expect(useSettingsStore.getState().completeOnboarding).not.toHaveBeenCalled()
    })

    it('a setDataRootAndRelaunch failure shows the inline error and keeps the wizard on Location', async () => {
      window.api.storage.pickDirectory = vi.fn().mockResolvedValue('/mnt/data')
      window.api.storage.inspectDataRoot = vi
        .fn()
        .mockResolvedValue({ kind: 'move', dataRoot: '/mnt/data/OpenScience' })
      window.api.storage.setDataRootAndRelaunch = vi
        .fn()
        .mockResolvedValue({ ok: false, error: 'Disk is full.' })
      readyEnvironment()

      await act(async () => {
        root.render(<OnboardingWizard />)
      })
      await goToLocationStep()
      await clickButton(/browse/i)
      await clickButton(/finish/i)
      await clickButton(/^restart$/i)

      // Never marked complete (main only marks it on success), and the gate was never flipped, so
      // the wizard - not Home - is still what's rendered, with the error visible on Location.
      expect(useSettingsStore.getState().completeOnboarding).not.toHaveBeenCalled()
      expect(container.textContent).toContain('Disk is full.')
      expect(container.querySelector('section[aria-label="Choose data location"]')).not.toBeNull()
    })

    it('Keep default in the confirm dialog completes onboarding without relaunching', async () => {
      window.api.storage.pickDirectory = vi.fn().mockResolvedValue('/mnt/data')
      window.api.storage.inspectDataRoot = vi
        .fn()
        .mockResolvedValue({ kind: 'move', dataRoot: '/mnt/data/OpenScience' })
      readyEnvironment()

      await act(async () => {
        root.render(<OnboardingWizard />)
      })
      await goToLocationStep()
      await clickButton(/browse/i)
      await clickButton(/finish/i)
      await clickButton(/keep default/i)

      expect(useSettingsStore.getState().completeOnboarding).toHaveBeenCalledTimes(1)
      expect(window.api.storage.setDataRootAndRelaunch).not.toHaveBeenCalled()
    })

    it('shows a full-screen "Setting up" state while the relaunch call is in flight', async () => {
      let releaseRelaunch: (() => void) | undefined
      window.api.storage.pickDirectory = vi.fn().mockResolvedValue('/mnt/data')
      window.api.storage.inspectDataRoot = vi
        .fn()
        .mockResolvedValue({ kind: 'move', dataRoot: '/mnt/data/OpenScience' })
      window.api.storage.setDataRootAndRelaunch = vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            releaseRelaunch = () => resolve({ ok: true })
          })
      )
      readyEnvironment()

      await act(async () => {
        root.render(<OnboardingWizard />)
      })
      await goToLocationStep()
      await clickButton(/browse/i)
      await clickButton(/finish/i)
      await clickButton(/^restart$/i)

      expect(document.body.textContent).toContain('Setting up your workspace')

      // Clean up the still-pending promise so it doesn't leak into later tests.
      await act(async () => {
        releaseRelaunch?.()
      })
    })
  })
})
