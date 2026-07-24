// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useSettingsStore } from '@/stores/settings-store'
import { clickRadixMenuItem, openRadixMenu } from '../settings/test-utils'
import { AgentStep } from './AgentStep'
import {
  clickButton,
  environment,
  resetOnboardingStores,
  stubWindowApi
} from './onboarding-test-utils'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

const twoFrameworks = [
  { id: 'claude-code' as const, displayName: 'Claude Code', supportsSkills: true },
  { id: 'opencode' as const, displayName: 'OpenCode', supportsSkills: true }
]

const threeFrameworks = [
  ...twoFrameworks,
  { id: 'codex' as const, displayName: 'Codex', supportsSkills: true }
]

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

const renderStep = async (
  onBack: () => void = vi.fn(),
  onContinue: () => void = vi.fn()
): Promise<{ onBack: () => void; onContinue: () => void }> => {
  await act(async () => {
    root.render(<AgentStep onBack={onBack} onContinue={onContinue} />)
  })
  return { onBack, onContinue }
}

const continueButton = (): HTMLButtonElement | undefined =>
  Array.from(container.querySelectorAll('button')).find(
    (button) => button.textContent?.trim() === 'Continue'
  ) as HTMLButtonElement | undefined

const installFromManagedSource = async (frameworkName: string): Promise<void> => {
  openRadixMenu(
    document.body.querySelector<HTMLButtonElement>(
      `[aria-label="Install ${frameworkName}"], [aria-label="Repair ${frameworkName}"]`
    )
  )
  const managed = Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
    (item) => item.textContent?.includes('App-managed download (recommended)')
  )

  await act(async () => {
    clickRadixMenuItem(managed)
    await Promise.resolve()
  })
}

describe('AgentStep', () => {
  it('reuses the Settings agent cards without automatic or manual setup modes', async () => {
    useSettingsStore.setState({
      agentFrameworkId: 'claude-code',
      agentFrameworks: threeFrameworks,
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

    await renderStep()

    expect(container.querySelector('[role="tab"]')).toBeNull()
    expect(container.textContent).not.toContain('Automatic detection')
    expect(container.textContent).not.toContain('Manual setup')
    const panel = container.querySelector('section[aria-label="Set up the agent runtime"]')
    expect(panel?.querySelector('h3')?.textContent).toBe('Set up the agent runtime')
    expect(panel?.textContent).toContain(
      'Pick the agent Open Science drives, then install it. Only this agent needs to be installed to continue.'
    )
    expect(panel?.querySelector('button')?.textContent).toContain('Re-detect')
    expect(container.textContent).not.toContain('Agent framework')
    expect(container.textContent).toContain('Installed · 1')
    expect(container.textContent).toContain('Available · 2')
    expect(container.querySelector('[aria-label="Use Claude Agent"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Install OpenCode"]')).not.toBeNull()
    expect(container.textContent).not.toContain('Uninstall')
  })

  it('switches to an installed Codex card and refreshes the onboarding environment gate', async () => {
    const setAgentFramework = vi.fn().mockResolvedValue(undefined)
    const checkEnvironment = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      agentFrameworkId: 'claude-code',
      agentFrameworks: threeFrameworks,
      claude: { resolvedPath: '/bin/claude', version: '2.1.0' },
      opencode: { resolvedPath: '/bin/opencode', version: '1.0.0' },
      codex: { resolvedPath: '/bin/codex-acp', version: '0.9.0' },
      preflight: {
        claudeReady: true,
        opencodeReady: true,
        codexReady: true,
        agentFrameworkId: 'claude-code',
        agentReady: true,
        activeProviderReady: false
      },
      environmentCheck: environment(true),
      setAgentFramework,
      checkEnvironment
    })

    await renderStep()
    await act(async () => {
      container.querySelector<HTMLElement>('[aria-label="Use Codex"]')?.click()
      await Promise.resolve()
    })

    expect(setAgentFramework).toHaveBeenCalledWith('codex')
    expect(checkEnvironment).toHaveBeenCalledOnce()
  })

  it('enables Continue only when the latest check passes for the selected framework', async () => {
    useSettingsStore.setState({
      agentFrameworks: twoFrameworks,
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
    const onContinue = vi.fn()

    await renderStep(vi.fn(), onContinue)

    expect(continueButton()?.disabled).toBe(false)
    await clickButton(/^continue$/i)
    expect(onContinue).toHaveBeenCalledOnce()
  })

  it('disables Continue when the latest check belongs to another framework', async () => {
    useSettingsStore.setState({
      agentFrameworkId: 'opencode',
      agentFrameworks: twoFrameworks,
      opencode: { resolvedPath: '/bin/opencode', version: '1.0.0' },
      preflight: {
        claudeReady: true,
        opencodeReady: true,
        codexReady: false,
        agentFrameworkId: 'opencode',
        agentReady: true,
        activeProviderReady: false
      },
      environmentCheck: environment(true)
    })

    await renderStep()

    expect(continueButton()?.disabled).toBe(true)
  })

  it('blocks continuation while the selected agent is not ready', async () => {
    useSettingsStore.setState({
      agentFrameworks: threeFrameworks,
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

    await renderStep()

    expect(continueButton()?.disabled).toBe(true)
    expect(container.textContent).toContain('Complete every required item above to continue.')
  })

  it('returns to the previous step from Back', async () => {
    useSettingsStore.setState({
      agentFrameworks: twoFrameworks,
      environmentCheck: environment(true)
    })
    const onBack = vi.fn()

    await renderStep(onBack)
    await clickButton(/^back$/i)

    expect(onBack).toHaveBeenCalledOnce()
  })

  it('prefers OpenCode when Claude is missing and OpenCode is installed', async () => {
    const setAgentFramework = vi.fn().mockResolvedValue(undefined)
    const checkEnvironment = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      agentFrameworkId: 'claude-code',
      agentFrameworks: twoFrameworks,
      opencode: { resolvedPath: '/bin/opencode', version: '1.0.0' },
      setAgentFramework,
      checkEnvironment,
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

    await renderStep()

    expect(setAgentFramework).toHaveBeenCalledWith('opencode')
    expect(checkEnvironment).toHaveBeenCalledOnce()
  })

  it('prefers Codex when it is the only installed runtime', async () => {
    const setAgentFramework = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      agentFrameworkId: 'claude-code',
      agentFrameworks: threeFrameworks,
      codex: { resolvedPath: '/bin/codex-acp', version: '0.9.0' },
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

    await renderStep()

    expect(setAgentFramework).toHaveBeenCalledWith('codex')
  })

  it('queues the user choice behind the initial installed-agent preference', async () => {
    let releaseAutoSelect: (() => void) | undefined
    const setAgentFramework = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseAutoSelect = resolve
        })
    )
    useSettingsStore.setState({
      agentFrameworkId: 'claude-code',
      agentFrameworks: threeFrameworks,
      opencode: { resolvedPath: '/bin/opencode', version: '1.0.0' },
      codex: { resolvedPath: '/bin/codex-acp', version: '0.9.0' },
      setAgentFramework,
      preflight: {
        claudeReady: false,
        opencodeReady: true,
        codexReady: true,
        agentFrameworkId: 'claude-code',
        agentReady: false,
        activeProviderReady: false
      },
      environmentCheck: environment(false)
    })

    await renderStep()
    expect(setAgentFramework).toHaveBeenCalledWith('opencode')

    await act(async () => {
      container.querySelector<HTMLElement>('[aria-label="Use Codex"]')?.click()
      await Promise.resolve()
    })
    expect(setAgentFramework).toHaveBeenCalledTimes(1)

    await act(async () => {
      releaseAutoSelect?.()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(setAgentFramework).toHaveBeenNthCalledWith(1, 'opencode')
    expect(setAgentFramework).toHaveBeenNthCalledWith(2, 'codex')
  })

  it('keeps a later user choice when an install-success switch is still in flight', async () => {
    let releaseInstallSwitch: (() => void) | undefined
    const setAgentFramework = vi.fn().mockImplementation((target: string) => {
      if (target !== 'opencode') return Promise.resolve()
      return new Promise<void>((resolve) => {
        releaseInstallSwitch = resolve
      })
    })
    const installOpencode = vi.fn().mockResolvedValue({ installId: 'i', ok: true })
    const checkEnvironment = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      agentFrameworkId: 'claude-code',
      agentFrameworks: threeFrameworks,
      claude: { resolvedPath: '/bin/claude', version: '2.1.0' },
      codex: { resolvedPath: '/bin/codex-acp', version: '0.9.0' },
      installOpencode,
      setAgentFramework,
      checkEnvironment,
      preflight: {
        claudeReady: true,
        opencodeReady: false,
        codexReady: true,
        agentFrameworkId: 'claude-code',
        agentReady: true,
        activeProviderReady: false
      },
      environmentCheck: environment(true)
    })

    await renderStep()
    await installFromManagedSource('OpenCode')
    expect(setAgentFramework).toHaveBeenCalledWith('opencode')

    await act(async () => {
      container.querySelector<HTMLElement>('[aria-label="Use Codex"]')?.click()
      await Promise.resolve()
    })
    // The explicit choice waits for the install-success switch instead of racing it.
    expect(setAgentFramework).toHaveBeenCalledTimes(1)

    await act(async () => {
      releaseInstallSwitch?.()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(setAgentFramework).toHaveBeenNthCalledWith(1, 'opencode')
    expect(setAgentFramework).toHaveBeenNthCalledWith(2, 'codex')
  })

  it('keeps an installed current framework and exposes every installed card', async () => {
    const setAgentFramework = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      agentFrameworkId: 'claude-code',
      agentFrameworks: twoFrameworks,
      claude: { resolvedPath: '/bin/claude', version: '2.1.0' },
      opencode: { resolvedPath: '/bin/opencode', version: '1.0.0' },
      setAgentFramework,
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

    await renderStep()

    expect(setAgentFramework).not.toHaveBeenCalled()
    expect(container.querySelector('[aria-label="Use Claude Agent"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Use OpenCode"]')).not.toBeNull()
  })

  it('locks installed framework cards while detection is in flight', async () => {
    useSettingsStore.setState({
      agentFrameworkId: 'claude-code',
      agentFrameworks: threeFrameworks,
      claude: { resolvedPath: '/bin/claude' },
      opencode: { resolvedPath: '/bin/opencode' },
      codex: { resolvedPath: '/bin/codex-acp' },
      isDetectingCodex: true,
      preflight: {
        claudeReady: true,
        opencodeReady: true,
        codexReady: true,
        agentFrameworkId: 'claude-code',
        agentReady: true,
        activeProviderReady: false
      },
      environmentCheck: environment(true)
    })

    await renderStep()

    const radios = Array.from(container.querySelectorAll<HTMLElement>('[role="radio"]'))
    expect(radios).toHaveLength(3)
    expect(radios.every((radio) => radio.getAttribute('aria-disabled') === 'true')).toBe(true)
  })

  it('routes an OpenCode managed install, selects it, re-checks, and waits for Continue', async () => {
    const installOpencode = vi.fn().mockResolvedValue({ installId: 'i', ok: true })
    const installClaude = vi.fn().mockResolvedValue({ installId: 'c', ok: true })
    const setAgentFramework = vi.fn().mockResolvedValue(undefined)
    const checkEnvironment = vi.fn().mockResolvedValue(undefined)
    const onContinue = vi.fn()
    useSettingsStore.setState({
      agentFrameworkId: 'claude-code',
      agentFrameworks: threeFrameworks,
      installOpencode,
      installClaude,
      setAgentFramework,
      checkEnvironment,
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

    await renderStep(vi.fn(), onContinue)
    await installFromManagedSource('OpenCode')

    expect(installOpencode).toHaveBeenCalledWith('managed')
    expect(installClaude).not.toHaveBeenCalled()
    expect(setAgentFramework).toHaveBeenCalledWith('opencode')
    expect(checkEnvironment).toHaveBeenCalledOnce()
    expect(onContinue).not.toHaveBeenCalled()
  })

  it('passes the recommended mirror to the managed Claude installer', async () => {
    const installClaude = vi.fn().mockResolvedValue({ installId: 'i', ok: false })
    useSettingsStore.setState({
      agentFrameworkId: 'claude-code',
      agentFrameworks: threeFrameworks,
      installClaude,
      preflight: {
        claudeReady: false,
        opencodeReady: false,
        codexReady: false,
        agentFrameworkId: 'claude-code',
        agentReady: false,
        activeProviderReady: false
      },
      environmentCheck: { ...environment(false), recommendedRegistry: 'npmmirror' }
    })

    await renderStep()
    await installFromManagedSource('Claude Agent')

    expect(installClaude).toHaveBeenCalledWith('managed', 'npmmirror')
  })

  it('surfaces an installer rejection without an unhandled event promise', async () => {
    const installClaude = vi.fn().mockRejectedValue(new Error('Installer process could not start.'))
    const detectClaude = vi.fn().mockResolvedValue({ found: false })
    const detectOpencode = vi.fn().mockResolvedValue(undefined)
    const detectCodex = vi.fn().mockResolvedValue(undefined)
    const checkEnvironment = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      agentFrameworkId: 'claude-code',
      agentFrameworks: threeFrameworks,
      installClaude,
      detectClaude,
      detectOpencode,
      detectCodex,
      checkEnvironment,
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

    await renderStep()
    await installFromManagedSource('Claude Agent')

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Installer process could not start.'
    )

    await clickButton(/^re-detect$/i)

    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('re-detects all frameworks and refreshes the environment gate', async () => {
    const detectClaude = vi.fn().mockResolvedValue({ found: false })
    const detectOpencode = vi.fn().mockResolvedValue(undefined)
    const detectCodex = vi.fn().mockResolvedValue(undefined)
    const checkEnvironment = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      agentFrameworks: threeFrameworks,
      detectClaude,
      detectOpencode,
      detectCodex,
      checkEnvironment,
      environmentCheck: environment(false)
    })

    await renderStep()
    await clickButton(/re-detect/i)

    expect(detectClaude).toHaveBeenCalledOnce()
    expect(detectOpencode).toHaveBeenCalledOnce()
    expect(detectCodex).toHaveBeenCalledOnce()
    expect(checkEnvironment).toHaveBeenCalledOnce()
  })

  it('refreshes the selected environment and reports a partial framework detection failure', async () => {
    const detectClaude = vi.fn().mockResolvedValue({ found: true, path: '/bin/claude' })
    const detectOpencode = vi.fn().mockResolvedValue(undefined)
    const detectCodex = vi.fn().mockRejectedValue(new Error('Codex detection failed.'))
    const checkEnvironment = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      agentFrameworks: threeFrameworks,
      detectClaude,
      detectOpencode,
      detectCodex,
      checkEnvironment,
      environmentCheck: environment(false)
    })

    await renderStep()
    await clickButton(/re-detect/i)

    expect(checkEnvironment).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('Codex detection failed.')
  })

  it('clears a previous detection failure when a later repair succeeds', async () => {
    const detectClaude = vi.fn().mockResolvedValue({ found: false })
    const detectOpencode = vi.fn().mockResolvedValue(undefined)
    const detectCodex = vi.fn().mockRejectedValueOnce(new Error('Codex detection failed.'))
    const checkEnvironment = vi.fn().mockResolvedValue(undefined)
    const installClaude = vi.fn().mockResolvedValue({ installId: 'repair-1', ok: true })
    useSettingsStore.setState({
      agentFrameworkId: 'claude-code',
      agentFrameworks: threeFrameworks,
      detectClaude,
      detectOpencode,
      detectCodex,
      checkEnvironment,
      installClaude,
      environmentCheck: environment(false)
    })

    await renderStep()
    await clickButton(/re-detect/i)
    expect(container.textContent).toContain('Codex detection failed.')

    await installFromManagedSource('Claude Agent')

    expect(container.textContent).not.toContain('Codex detection failed.')
  })

  it('shows an environment-check failure that keeps Continue disabled', async () => {
    useSettingsStore.setState({
      agentFrameworks: threeFrameworks,
      environmentCheck: environment(false),
      environmentCheckError: 'Environment inspection failed.'
    })

    await renderStep()

    expect(continueButton()?.disabled).toBe(true)
    expect(container.textContent).toContain('Environment inspection failed.')
  })

  it('shows per-runtime install progress and a copyable log', async () => {
    useSettingsStore.setState({
      agentFrameworkId: 'claude-code',
      agentFrameworks: threeFrameworks,
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
          installLogs: ['Downloading Claude\n'],
          installProgress: {
            kind: 'progress',
            installId: 'test',
            phase: 'downloading',
            receivedBytes: 5,
            totalBytes: 10
          },
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

    await renderStep()

    expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe(
      '50'
    )
    await clickButton(/show log/i)
    expect(container.querySelector('[aria-label="Install log"]')?.textContent).toContain(
      'Downloading Claude'
    )
  })
})
