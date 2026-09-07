// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runEnvironmentCheck } from '../../../../main/settings/environment-check'
import type { AgentFrameworkId, EnvironmentCheckResult } from '../../../../shared/settings'
import { i18next } from '@/i18n'
import { useSettingsStore } from '@/stores/settings-store'
import { OnboardingWizard } from './OnboardingWizard'
import {
  clickButton,
  fillRequiredProviderFields,
  findButton,
  readyClaudeState,
  resetOnboardingStores,
  selectOption,
  stubWindowApi
} from './onboarding-test-utils'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  resetOnboardingStores()
  stubWindowApi()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  delete (window as unknown as { api?: unknown }).api
  await i18next.changeLanguage('en')
})

const renderWizard = async (): Promise<void> => {
  await act(async () => root.render(<OnboardingWizard />))
}

const section = (label: string): Element | null =>
  container.querySelector(`section[aria-label="${label}"]`)

const goToProvider = async (): Promise<void> => {
  readyClaudeState()
  await renderWizard()
  await clickButton(/^continue$/i)
  await clickButton(/^continue$/i)
  await clickButton(/^continue$/i)
  expect(section('Configure model')).not.toBeNull()
  await fillRequiredProviderFields(container)
}

const configureUnavailableRegistries = async (
  failure?: 'storage' | 'system' | 'no-runtime',
  alternative: AgentFrameworkId = 'opencode',
  selected: AgentFrameworkId = 'claude-code'
): Promise<void> => {
  const frameworks = [
    { id: selected, label: selected, runtime: { found: false } },
    { id: alternative, label: alternative, runtime: { found: failure !== 'no-runtime' } }
  ]
  const probeRegistry = vi.fn().mockRejectedValue(new Error('Installation source unreachable'))
  const inspect = (agentFrameworkId: AgentFrameworkId): Promise<EnvironmentCheckResult> =>
    runEnvironmentCheck({
      storageRoot: '/fixture/data',
      agentFrameworkId,
      frameworks,
      encryptionAvailable: true,
      deps: {
        platform: 'darwin',
        architecture: 'arm64',
        verifyStorage: async () => {
          if (failure === 'storage') throw new Error('Permission denied')
        },
        resolveManagedPlatform: () => {
          if (failure === 'system') throw new Error('Unsupported system')
          return { key: 'darwin-arm64' }
        },
        findPython: async () => undefined,
        detectAvx2: () => true,
        probeRegistry,
        now: () => 1
      }
    })
  const environmentCheck = await inspect(selected)
  expect(probeRegistry).toHaveBeenCalledTimes(2)
  expect(environmentCheck).toMatchObject({ ready: false, canAutoInstall: false })
  expect(environmentCheck.checks.find((check) => check.id === 'install-network')?.status).toBe(
    'failed'
  )
  if (failure !== 'no-runtime') {
    expect(
      environmentCheck.checks.find((check) => check.label === `${alternative} runtime`)?.status
    ).toBe('passed')
  }
  useSettingsStore.setState({
    agentFrameworkId: selected,
    environmentCheck,
    agentFrameworks: frameworks.map(({ id, label }) => ({
      id,
      displayName: label,
      supportsSkills: true
    })),
    preflight: {
      claudeReady: alternative === 'claude-code' && failure !== 'no-runtime',
      opencodeReady: alternative === 'opencode' && failure !== 'no-runtime',
      codexReady: alternative === 'codex' && failure !== 'no-runtime',
      codebuddyReady: alternative === 'codebuddy' && failure !== 'no-runtime',
      agentFrameworkId: selected,
      agentReady: false,
      activeProviderReady: false
    },
    setAgentFramework: vi.fn(async (agentFrameworkId: AgentFrameworkId) => {
      useSettingsStore.setState({ agentFrameworkId })
    }),
    checkEnvironment: vi.fn(async () => {
      const result = await inspect(useSettingsStore.getState().agentFrameworkId)
      useSettingsStore.setState({ environmentCheck: result })
      return result
    })
  })
}

describe('Onboarding navigation regressions', () => {
  it.each(['claude-code', 'codex', 'codebuddy'] as const)(
    'checks the installed %s alternative before continuing',
    async (alternative) => {
      await configureUnavailableRegistries(
        undefined,
        alternative,
        alternative === 'claude-code' ? 'opencode' : 'claude-code'
      )
      await renderWizard()
      expect(useSettingsStore.getState().setAgentFramework).toHaveBeenCalledWith(alternative)
      expect(useSettingsStore.getState().environmentCheck).toMatchObject({
        ready: true,
        agentFrameworkId: alternative
      })
      expect(findButton(/^continue$/i)?.disabled).toBe(false)
    }
  )

  it('does not select an unsupported Codex adapter as an installed alternative', async () => {
    await configureUnavailableRegistries(undefined, 'codex')
    useSettingsStore.setState({ codex: { version: '0.0.1' } })
    await renderWizard()
    expect(useSettingsStore.getState().setAgentFramework).not.toHaveBeenCalled()
    expect(findButton(/^continue$/i)?.disabled).toBe(true)
  })

  it('waits for the selected alternative check and preserves the selection on Back', async () => {
    await configureUnavailableRegistries()
    const inspect = useSettingsStore.getState().checkEnvironment
    const pending = Promise.withResolvers<void>()
    useSettingsStore.setState({
      checkEnvironment: vi.fn(async () => {
        await pending.promise
        return inspect()
      })
    })
    await renderWizard()
    expect(useSettingsStore.getState().agentFrameworkId).toBe('opencode')
    expect(findButton(/^continue$/i)?.disabled).toBe(true)
    await act(async () => pending.resolve())
    expect(findButton(/^continue$/i)?.disabled).toBe(false)
    await clickButton(/^continue$/i)
    await clickButton(/^back$/i)
    expect(useSettingsStore.getState().setAgentFramework).toHaveBeenCalledOnce()
  })

  it('allows setup with an installed alternative when installation sources are unreachable', async () => {
    await configureUnavailableRegistries()
    await renderWizard()

    expect(section('Prepare environment')).not.toBeNull()
    expect(findButton(/^continue$/i)?.disabled).toBe(false)
    await clickButton(/^continue$/i)
    expect(section('Choose data location')).not.toBeNull()
    await clickButton(/^continue$/i)
    expect(useSettingsStore.getState().setAgentFramework).toHaveBeenCalledWith('opencode')
    expect(useSettingsStore.getState().installOpencode).not.toHaveBeenCalled()
    expect(useSettingsStore.getState().installClaude).not.toHaveBeenCalled()
  })

  it.each(['storage', 'system', 'no-runtime'] as const)(
    'keeps setup blocked when the remaining requirement is %s',
    async (failure) => {
      await configureUnavailableRegistries(failure)
      await renderWizard()
      expect(findButton(/^continue$/i)?.disabled).toBe(true)
      await clickButton(/^continue$/i)
      expect(section('Prepare environment')).not.toBeNull()
    }
  )

  it('preserves the current location step when a provider test succeeds after Back', async () => {
    const pending =
      Promise.withResolvers<
        Awaited<ReturnType<ReturnType<typeof useSettingsStore.getState>['saveAndActivateProvider']>>
      >()
    const save = vi.fn().mockReturnValue(pending.promise)
    useSettingsStore.setState({ saveAndActivateProvider: save })
    await goToProvider()
    await clickButton(/test & continue/i)
    expect(save).toHaveBeenCalledOnce()
    await clickButton(/^back$/i)
    await clickButton(/^back$/i)
    expect(section('Choose data location')).not.toBeNull()

    await act(async () => {
      pending.resolve({ providerId: 'saved-1', validation: { ok: true, category: 'ok' } })
    })

    expect.soft(section('Choose data location')).not.toBeNull()
    expect.soft(section('Notebook runtime (optional)')).toBeNull()
    expect(useSettingsStore.getState().completeOnboarding).not.toHaveBeenCalled()
  })

  it('updates the saved provider identity after returning from Notebook', async () => {
    const save = vi.fn().mockResolvedValue({
      providerId: 'saved-1',
      validation: { ok: true, category: 'ok' }
    })
    useSettingsStore.setState({ saveAndActivateProvider: save })
    await goToProvider()
    await clickButton(/test & continue/i)
    expect(section('Notebook runtime (optional)')).not.toBeNull()
    expect(save.mock.calls[0][0].id).toBeUndefined()
    await clickButton(/^back$/i)
    await clickButton(/test & continue/i)

    expect(save).toHaveBeenCalledTimes(2)
    expect(save.mock.calls[1][0]).toMatchObject({ ...save.mock.calls[0][0], id: 'saved-1' })
    expect(section('Notebook runtime (optional)')).not.toBeNull()
  })

  it('keeps a remounted provider page open when its previous test completes', async () => {
    const pending = Promise.withResolvers<{
      providerId: string
      validation: { ok: true; category: 'ok' }
    }>()
    const save = vi
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue({
        providerId: 'saved-1',
        validation: { ok: true, category: 'ok' }
      })
    useSettingsStore.setState({ saveAndActivateProvider: save })
    await goToProvider()
    await clickButton(/test & continue/i)
    await clickButton(/^back$/i)
    await clickButton(/^continue$/i)
    await act(async () => {
      pending.resolve({ providerId: 'saved-1', validation: { ok: true, category: 'ok' } })
    })
    expect(section('Configure model')).not.toBeNull()
    await clickButton(/test & continue/i)
    expect(save.mock.calls[1][0]).toMatchObject({ id: 'saved-1', requireExisting: true })
    expect(section('Notebook runtime (optional)')).not.toBeNull()
  })

  it('reuses the committed identity after failed validation and edited connection fields', async () => {
    const save = vi.fn().mockResolvedValue({
      providerId: 'saved-1',
      validation: { ok: false, category: 'network' }
    })
    useSettingsStore.setState({ saveAndActivateProvider: save })
    await goToProvider()
    await clickButton(/test & continue/i)
    expect(section('Configure model')).not.toBeNull()
    await act(async () => {
      fireEvent.change(container.querySelector('#provider-base-url')!, {
        target: { value: 'https://replacement.example' }
      })
    })
    await clickButton(/test & continue/i)
    expect(save.mock.calls[1][0]).toMatchObject({
      id: 'saved-1',
      requireExisting: true,
      baseUrl: 'https://replacement.example'
    })
  })

  it('starts a new identity after changing provider kind and returning to custom', async () => {
    await goToProvider()
    await clickButton(/test & continue/i)
    await clickButton(/^back$/i)
    await selectOption('Provider type', 'Anthropic')
    expect(container.querySelector('[aria-label="Provider type"]')?.textContent).toContain(
      'Anthropic'
    )
    await selectOption('Provider type', 'Custom Gateway')
    await fillRequiredProviderFields(container)
    await clickButton(/test & continue/i)
    const save = vi.mocked(useSettingsStore.getState().saveAndActivateProvider)
    expect(save).toHaveBeenCalledTimes(2)
    expect(save.mock.calls[1][0].id).toBeUndefined()
  })

  it('does not attach a late saved identity to a new provider draft', async () => {
    const pending = Promise.withResolvers<{
      providerId: string
      validation: { ok: true; category: 'ok' }
    }>()
    const save = vi
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue({
        providerId: 'saved-2',
        validation: { ok: true, category: 'ok' }
      })
    useSettingsStore.setState({ saveAndActivateProvider: save })
    await goToProvider()
    await clickButton(/test & continue/i)
    await clickButton(/^back$/i)
    await clickButton(/^continue$/i)
    await selectOption('Provider type', 'Anthropic')
    expect(container.querySelector('[aria-label="Provider type"]')?.textContent).toContain(
      'Anthropic'
    )
    await selectOption('Provider type', 'Custom Gateway')
    await fillRequiredProviderFields(container)
    await act(async () => {
      pending.resolve({ providerId: 'saved-1', validation: { ok: true, category: 'ok' } })
    })
    expect(section('Configure model')).not.toBeNull()
    await clickButton(/test & continue/i)
    expect(save.mock.calls[1][0].id).toBeUndefined()
  })

  it('requires the saved entity to exist and starts a new one only on an explicit retry', async () => {
    const save = vi
      .fn()
      .mockResolvedValueOnce({ providerId: 'saved-1', validation: { ok: true, category: 'ok' } })
      .mockRejectedValueOnce(new Error('Provider no longer exists.'))
      .mockResolvedValueOnce({ providerId: 'saved-2', validation: { ok: true, category: 'ok' } })
    useSettingsStore.setState({ saveAndActivateProvider: save })
    await goToProvider()
    await clickButton(/test & continue/i)
    await clickButton(/^back$/i)
    await clickButton(/test & continue/i)
    expect(save.mock.calls[1][0]).toMatchObject({ id: 'saved-1', requireExisting: true })
    expect(section('Configure model')).not.toBeNull()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Provider no longer exists.'
    )
    await clickButton(/test & continue/i)
    expect(save.mock.calls[2][0].id).toBeUndefined()
  })

  it('localizes an incompatible provider draft after switching to Codex', async () => {
    await goToProvider()
    await clickButton(/^back$/i)
    await act(async () => {
      const state = useSettingsStore.getState()
      useSettingsStore.setState({
        agentFrameworkId: 'codex',
        agentFrameworks: [
          {
            id: 'codex',
            displayName: 'Codex',
            supportedApiTypes: ['responses'],
            supportsSkills: true
          }
        ],
        preflight: {
          ...state.preflight,
          agentFrameworkId: 'codex',
          agentReady: true,
          codexReady: true
        },
        environmentCheck: { ...state.environmentCheck!, agentFrameworkId: 'codex' }
      })
    })
    await clickButton(/^continue$/i)
    expect(section('Configure model')).not.toBeNull()
    await act(async () => i18next.changeLanguage('zh-Hans'))
    await clickButton(/测试并继续/)

    expect(useSettingsStore.getState().saveAndActivateProvider).not.toHaveBeenCalled()
    const alert = container.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('Codex')
    expect(alert?.textContent).toMatch(/不兼容/)
    expect(alert?.textContent).not.toContain("This provider isn't compatible")
  })

  it('advances on a current successful test and finishes only on explicit Finish', async () => {
    await goToProvider()
    await clickButton(/test & continue/i)
    expect(section('Notebook runtime (optional)')).not.toBeNull()
    expect(useSettingsStore.getState().completeOnboarding).not.toHaveBeenCalled()
    await clickButton(/^finish$/i)
    expect(useSettingsStore.getState().completeOnboarding).toHaveBeenCalledOnce()
  })
})
