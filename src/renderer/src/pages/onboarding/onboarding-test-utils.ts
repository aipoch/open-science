// Shared fixtures, DOM helpers, and store/api stubs for the onboarding step render tests. The
// wizard's old single-file suite was split per step; everything the split suites share lives here
// so each step file only carries its own scenario setup.
import { act } from 'react'
import { vi } from 'vitest'

import type { EnvironmentCheckResult } from '../../../../shared/settings'
import type { StorageInfo } from '../../../../shared/storage'
import { createInitialNotebookEnvState, useNotebookEnvStore } from '@/stores/notebook-env-store'
import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'

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

const DEFAULT_DATA_ROOT = '/home/u/.open-science'

// A Claude-framework host inspection. `ready=false` models "only the agent runtime is missing":
// the host checks all passed, so the main process reports canAutoInstall — the Environment step
// treats that as continuable, the Agent step as not.
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

// A ready Claude environment with the preflight + claude info to match, so the Agent step's
// Continue gate (environmentReady) opens and the flow can walk forward.
const readyClaudeState = (): void => {
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

// A Codex-ready environment so the wizard/steps open straight onto Codex-aware surfaces.
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

const storageInfo = (overrides: Partial<StorageInfo> = {}): StorageInfo => ({
  dataRoot: DEFAULT_DATA_ROOT,
  isDefault: true,
  defaultDataRoot: DEFAULT_DATA_ROOT,
  defaultParent: '/home/u',
  dataRootMissing: false,
  legacyDataMovePrompt: false,
  usage: { categories: [], totalBytes: 0 },
  availableBytes: 500_000_000_000,
  ...overrides
})

// Searches document.body (not just the mount container) because dialogs/select options are
// portaled directly to the body, same as the reference pattern in SettingsPage.render.test.tsx.
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
const fillRequiredProviderFields = async (container: HTMLElement): Promise<void> => {
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

// Opens a Radix Select trigger and clicks an option by visible text (options portal to body).
// Mirrors the proven ActiveModelSelect.render.test.tsx pattern, since jsdom needs the pointer events.
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

// Resets both stores to a clean baseline and stubs the actions the onboarding surfaces call. Merge
// (not replace) on the settings store so its other actions stay intact — matches the pattern used
// by the other render tests (e.g. SettingsPage.render.test.tsx), since a full replace would need
// every SettingsStore action stubbed, not just the ones onboarding touches. The notebook-env store
// gets a full replace (needs every action typed) so a stray real bridge call can never sneak in.
const resetOnboardingStores = (): {
  envInit: ReturnType<typeof vi.fn>
  envProvision: ReturnType<typeof vi.fn>
} => {
  useSettingsStore.setState({
    ...createInitialSettingsState(),
    checkEnvironment: vi.fn().mockResolvedValue(undefined),
    detectClaude: vi.fn().mockResolvedValue({ found: false }),
    detectCodex: vi.fn().mockResolvedValue(undefined),
    installClaude: vi.fn().mockResolvedValue({ installId: 'i', ok: true }),
    installCodex: vi.fn().mockResolvedValue({ installId: 'i', ok: true }),
    installOpencode: vi.fn().mockResolvedValue({ installId: 'i', ok: true }),
    setAgentFramework: vi.fn().mockResolvedValue(undefined),
    completeOnboarding: vi.fn().mockResolvedValue(undefined),
    cancelCodexLogin: vi.fn().mockResolvedValue(undefined),
    cancelIsolatedClaudeLogin: vi.fn().mockResolvedValue(undefined),
    cancelSharedClaudeLogin: vi.fn().mockResolvedValue(undefined),
    saveAndActivateProvider: vi
      .fn()
      .mockResolvedValue({ providerId: 'p1', validation: { ok: true, category: 'ok' } })
  })

  const envInit = vi.fn(async () => {})
  const envProvision = vi.fn(async () => {})
  useNotebookEnvStore.setState(
    {
      ...createInitialNotebookEnvState(),
      init: envInit,
      provision: envProvision,
      cancel: vi.fn(async () => {}),
      retry: vi.fn(async () => {}),
      reset: vi.fn(async () => {})
    },
    true
  )
  return { envInit, envProvision }
}

const stubWindowApi = (): void => {
  ;(window as unknown as { api: unknown }).api = {
    storage: {
      getInfo: vi.fn().mockResolvedValue(storageInfo()),
      pickDirectory: vi.fn().mockResolvedValue(null),
      inspectDataRoot: vi
        .fn()
        .mockResolvedValue({ kind: 'move', dataRoot: '/mnt/data/OpenScience' }),
      setDataRootAndRelaunch: vi.fn().mockResolvedValue({ ok: true })
    },
    // The reused RuntimesPanel lists detected interpreters on mount; stub so the effect resolves.
    runtime: {
      listEnvironments: vi.fn().mockResolvedValue({ python: [], r: [] }),
      getEnablement: vi.fn().mockResolvedValue({ enabled: {}, installAuthorized: {} }),
      setEnvironmentEnabled: vi.fn().mockResolvedValue({ enabled: {}, installAuthorized: {} }),
      registerInterpreter: vi.fn().mockResolvedValue([]),
      pickInterpreter: vi.fn().mockResolvedValue(null)
    }
  }
}

export {
  DEFAULT_DATA_ROOT,
  clickButton,
  codexReadyState,
  environment,
  fillRequiredProviderFields,
  findButton,
  readyClaudeState,
  resetOnboardingStores,
  selectOption,
  storageInfo,
  stubWindowApi
}
