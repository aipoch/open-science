// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createInitialNotebookEnvState, useNotebookEnvStore } from '../../stores/notebook-env-store'

// Keep the settings store surface minimal — this test only asserts the env-provisioning side effect.
// Covers every field OnboardingWizard reads from the store, including the automatic environment-check
// surface (checkEnvironment/environmentCheck/etc.) added alongside this notebook-env provisioning.
vi.mock('../../stores/settings-store', () => {
  const state = {
    claude: {},
    preflight: { claudeReady: true, activeProviderReady: false },
    isDetectingClaude: false,
    isInstalling: false,
    installLogs: [] as string[],
    installProgress: undefined,
    installError: undefined,
    npmAvailable: true,
    encryptionAvailable: true,
    onboardingCompletedAt: undefined,
    environmentCheck: {
      checkedAt: 1,
      platform: 'darwin',
      architecture: 'arm64',
      ready: true,
      // Must match `agentFrameworkId` below, or `environmentReady` stays false (the wizard ignores a
      // check whose framework doesn't match the selected one). The Continue-gate tests rely on this.
      agentFrameworkId: 'claude-code',
      canAutoInstall: false,
      recommendedRegistry: undefined,
      claude: { found: true, path: '/x', version: '2.1.0' },
      checks: []
    },
    environmentCheckError: undefined,
    isCheckingEnvironment: false,
    checkEnvironment: vi.fn(async () => {}),
    closeEnvironmentRepair: vi.fn(),
    load: vi.fn(async () => {}),
    detectClaude: vi.fn(async () => ({ found: true, path: '/x' })),
    installClaude: vi.fn(async () => ({ installId: 'i', ok: true })),
    saveAndActivateProvider: vi
      .fn()
      .mockResolvedValue({ providerId: 'p1', validation: { ok: true, category: 'ok' } }),
    completeOnboarding: vi.fn(async () => {}),
    agentFrameworkId: 'claude-code',
    agentFrameworks: [] as unknown[],
    isDetectingOpencode: false,
    installOpencode: vi.fn(async () => ({ installId: 'i', ok: true }))
  }
  const useSettingsStore = (sel: (s: typeof state) => unknown): unknown => sel(state)
  // The wizard reads endpoints via this selector; return a stable default so a provider looks usable.
  const selectFrameworkApiEndpoints = (): string[] => ['anthropic']
  return { useSettingsStore, selectFrameworkApiEndpoints }
})

let container: HTMLDivElement
let root: Root
const provision = vi.fn(async () => {})
const init = vi.fn(async () => {})
const retry = vi.fn(async () => {})
const cancel = vi.fn(async () => {})
const reset = vi.fn(async () => {})

beforeEach(() => {
  // Full replace (needs every action typed) so a stray real bridge call can never sneak in.
  useNotebookEnvStore.setState(
    { ...createInitialNotebookEnvState(), init, provision, cancel, retry, reset },
    true
  )
  // The wizard reads storage info on mount (main's data-root step); stub it so the effect resolves.
  window.api = {
    storage: {
      getInfo: () =>
        Promise.resolve({
          dataRoot: '/tmp/OpenScience',
          isDefault: true,
          defaultDataRoot: '/tmp/OpenScience',
          defaultParent: '/tmp',
          dataRootMissing: false,
          legacyDataMovePrompt: false,
          usage: { categories: [], totalBytes: 0 },
          availableBytes: 0
        })
    },
    // The optional RuntimeChoiceCard lists detected interpreters on mount; stub so the effect resolves.
    runtime: {
      listEnvironments: () => Promise.resolve({ python: [], r: [] }),
      getEnablement: vi.fn(async () => ({ enabled: {}, installAuthorized: {} })),
      setEnvironmentEnabled: vi.fn(async () => ({ enabled: {}, installAuthorized: {} })),
      registerInterpreter: vi.fn(async () => []),
      pickInterpreter: vi.fn(async () => null)
    }
  } as never
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  provision.mockClear()
  init.mockClear()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('OnboardingWizard env provisioning', () => {
  it('initializes (detects) the env store on mount without auto-provisioning python', async () => {
    const { OnboardingWizard } = await import('./OnboardingWizard')
    await act(async () => {
      root.render(<OnboardingWizard />)
    })
    // Detect-only: hydrate the env store, but never eagerly provision. A fresh env is built lazily
    // on first notebook use; an explicit choose/download step comes later.
    expect(init).toHaveBeenCalledOnce()
    expect(provision).not.toHaveBeenCalled()
  })

  it('shows the preparing progress inside the runtime card, not a separate bottom box', async () => {
    useNotebookEnvStore.setState({
      status: { pythonReady: false, rReady: false, version: 3, provisioning: true },
      scope: 'python',
      progress: { phase: 'materialize', message: 'Preparing Python environment…', progress: 0.3 }
    })
    const { OnboardingWizard } = await import('./OnboardingWizard')
    await act(async () => {
      root.render(<OnboardingWizard />)
    })
    // Flush the RuntimeChoiceCard's listEnvironments()/getEnablement() microtasks so it renders.
    await act(async () => {})
    await act(async () => {})
    // The redundant bottom box is gone; the progress lives in the (single) runtime card.
    expect(container.querySelector('[data-testid="onboarding-env-progress"]')).toBeNull()
    const card = container.querySelector('[aria-label="Notebook runtime"]')
    expect(card?.textContent).toContain('Preparing Python environment')
  })

  // The Continue button on the first (environment) step. Selected by its label so the test tracks the
  // real control the user clicks, not an internal handle.
  const continueButton = (): HTMLButtonElement | undefined =>
    Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Continue'
    ) as HTMLButtonElement | undefined

  it('gates Continue while a runtime setup is in flight (envProvisioning), then enables it when idle', async () => {
    // A user-started provision must finish (or be cancelled) before leaving onboarding — continuing
    // mid-create would strand a half-built env. The button must be DISABLED while provisioning even
    // though the environment checks otherwise pass. Guards OnboardingWizard.tsx:766.
    useNotebookEnvStore.setState({
      status: { pythonReady: false, rReady: false, version: 3, provisioning: true },
      scope: 'python',
      progress: { phase: 'materialize', message: 'Preparing Python environment…', progress: 0.3 }
    })
    const { OnboardingWizard } = await import('./OnboardingWizard')
    await act(async () => {
      root.render(<OnboardingWizard />)
    })
    // Flush the RuntimeChoiceCard's async effects.
    await act(async () => {})
    await act(async () => {})

    const provisioning = continueButton()
    expect(provisioning).toBeDefined()
    // environmentReady is true (checks pass + framework matches), so ONLY envProvisioning disables it.
    expect(provisioning?.disabled).toBe(true)
    // The footer explains why the user can't continue yet.
    expect(container.textContent).toContain('Setting up the notebook runtime')

    // Once the provision settles (idle), the same otherwise-ready state re-enables Continue.
    await act(async () => {
      useNotebookEnvStore.setState({
        status: { pythonReady: true, rReady: false, version: 3, provisioning: false }
      })
    })
    await act(async () => {})
    expect(continueButton()?.disabled).toBe(false)
  })
})
