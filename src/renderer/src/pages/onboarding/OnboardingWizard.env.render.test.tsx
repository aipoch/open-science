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
    completeOnboarding: vi.fn(async () => {})
  }
  const useSettingsStore = (sel: (s: typeof state) => unknown): unknown => sel(state)
  return { useSettingsStore }
})

let container: HTMLDivElement
let root: Root
const provision = vi.fn(async () => {})
const init = vi.fn(async () => {})
const retry = vi.fn(async () => {})

beforeEach(() => {
  // Full replace (needs all three actions typed) so a stray real bridge call can never sneak in.
  useNotebookEnvStore.setState({ ...createInitialNotebookEnvState(), init, provision, retry }, true)
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
  it('initializes the env store and kicks off python provisioning once on mount', async () => {
    const { OnboardingWizard } = await import('./OnboardingWizard')
    await act(async () => {
      root.render(<OnboardingWizard />)
    })
    expect(init).toHaveBeenCalledOnce()
    expect(provision).toHaveBeenCalledWith('python')
    expect(provision).toHaveBeenCalledOnce()
  })

  it('renders a compact progress row while python is preparing', async () => {
    useNotebookEnvStore.setState({
      status: { pythonReady: false, rReady: false, version: 3, provisioning: true },
      scope: 'python',
      progress: { phase: 'materialize', message: 'Preparing Python environment…', progress: 0.3 }
    })
    const { OnboardingWizard } = await import('./OnboardingWizard')
    await act(async () => {
      root.render(<OnboardingWizard />)
    })
    expect(
      container.querySelector('[data-testid="onboarding-env-progress"]')?.textContent
    ).toContain('Preparing Python environment')
  })
})
