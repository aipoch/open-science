// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { EnvironmentCheckResult } from '../../../../shared/settings'
import { i18next } from '@/i18n'
import { useSettingsStore } from '@/stores/settings-store'
import { EnvironmentStep } from './EnvironmentStep'
import {
  clickButton,
  environment,
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

afterEach(async () => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  delete (window as unknown as { api?: unknown }).api
  await i18next.changeLanguage('en')
})

const renderStep = async (onContinue: () => void = vi.fn()): Promise<void> => {
  await act(async () => {
    root.render(<EnvironmentStep onContinue={onContinue} />)
  })
}

const continueButton = (): HTMLButtonElement | undefined =>
  Array.from(container.querySelectorAll('button')).find(
    (button) => button.textContent?.trim() === 'Continue'
  ) as HTMLButtonElement | undefined

describe('EnvironmentStep', () => {
  it('localizes completed host checks instead of rendering IPC English', async () => {
    const completedEnvironment = {
      ...environment(true),
      platform: 'darwin',
      architecture: 'arm64',
      checks: [
        {
          id: 'system',
          label: 'System compatibility',
          status: 'passed',
          summary: 'macOS arm64 is supported.',
          detail:
            'Automatic setup uses an app-managed runtime and does not require administrator access.',
          presentation: {
            kind: 'system-supported',
            platform: 'macOS',
            architecture: 'arm64'
          }
        },
        {
          id: 'storage',
          label: 'App storage permission',
          status: 'passed',
          summary: 'Open Science can write to its private data folder.',
          detail: '/tmp/de',
          presentation: { kind: 'storage-writable' }
        },
        {
          id: 'secure-storage',
          label: 'Secure credential storage',
          status: 'passed',
          summary: 'The operating-system credential vault is available.',
          presentation: { kind: 'secure-storage-available' }
        },
        {
          id: 'install-network',
          label: 'Installation network',
          status: 'passed',
          summary: 'No download is needed because Claude Code is already installed.',
          presentation: {
            kind: 'install-network-runtime-present',
            runtime: 'Claude Code'
          }
        }
      ]
    } as EnvironmentCheckResult
    useSettingsStore.setState({ environmentCheck: completedEnvironment })
    await act(async () => i18next.changeLanguage('zh-Hans'))

    await renderStep()

    expect(container.textContent).toContain('系统兼容性')
    expect(container.textContent).toContain('支持 macOS arm64。')
    expect(container.textContent).toContain('自动设置使用由应用管理的运行时，无需管理员权限。')
    expect(container.textContent).toContain('应用存储权限')
    expect(container.textContent).toContain('Open Science 可以写入其专用数据文件夹。')
    expect(container.textContent).toContain('凭据安全存储')
    expect(container.textContent).toContain('操作系统凭据库可用。')
    expect(container.textContent).toContain('安装所需网络')
    expect(container.textContent).toContain('Claude Code 已安装，无需下载。')
    expect(container.textContent).not.toContain('System compatibility')
    expect(container.textContent).not.toContain('Automatic setup uses an app-managed runtime')
  })

  it('localizes German host warnings and failures while preserving diagnostics', async () => {
    const completedEnvironment = {
      ...environment(false),
      platform: 'linux',
      architecture: 'x64',
      checks: [
        {
          id: 'system',
          label: 'System compatibility',
          status: 'warning',
          summary: 'Linux x64 can use the detected Claude Code runtime.',
          detail: 'Unsupported platform for managed install',
          presentation: {
            kind: 'system-detected-runtime',
            platform: 'Linux',
            architecture: 'x64',
            runtime: 'Claude Code'
          }
        },
        {
          id: 'storage',
          label: 'App storage permission',
          status: 'failed',
          summary: 'Open Science cannot write to its private data folder.',
          detail: '/locked — EACCES',
          presentation: { kind: 'storage-unwritable' }
        },
        {
          id: 'secure-storage',
          label: 'Secure credential storage',
          status: 'warning',
          summary: 'The operating-system credential vault is unavailable.',
          detail:
            'Unlock or authorize the system keychain before saving API keys. Keyless runtimes can continue setup.',
          presentation: { kind: 'secure-storage-unavailable' }
        },
        {
          id: 'install-network',
          label: 'Installation network',
          status: 'failed',
          summary: 'Neither the official registry nor the China-friendly mirror is reachable.',
          detail: 'Check the network, proxy, VPN, or firewall, then run the check again.',
          presentation: { kind: 'install-network-unreachable' }
        }
      ]
    } as EnvironmentCheckResult
    useSettingsStore.setState({ environmentCheck: completedEnvironment })
    await act(async () => i18next.changeLanguage('de'))

    await renderStep()

    expect(container.textContent).toContain(
      'Linux x64 kann die erkannte Laufzeit Claude Code verwenden.'
    )
    expect(container.textContent).toContain('Unsupported platform for managed install')
    expect(container.textContent).toContain(
      'Open Science kann nicht in seinen privaten Datenordner schreiben.'
    )
    expect(container.textContent).toContain('/locked — EACCES')
    expect(container.textContent).toContain(
      'Der Anmeldeinformationsspeicher des Betriebssystems ist nicht verfügbar.'
    )
    expect(container.textContent).toContain(
      'Weder die offizielle Registry noch der für China optimierte Mirror ist erreichbar.'
    )
    expect(container.textContent).not.toContain('Open Science cannot write')
    expect(container.textContent).not.toContain('Neither the official registry')
  })

  it('localizes registry display names returned by the host check', async () => {
    const completedEnvironment = {
      ...environment(false),
      checks: [
        {
          id: 'install-network',
          label: 'Installation network',
          status: 'passed',
          summary: 'China-friendly npmmirror is the fastest reachable source.',
          detail:
            'Measured 42 ms. The other trusted source remains available as an automatic fallback.',
          presentation: {
            kind: 'install-network-registry-available',
            registry: 'npmmirror',
            latencyMs: 42
          }
        }
      ]
    } as EnvironmentCheckResult
    useSettingsStore.setState({ environmentCheck: completedEnvironment })
    await act(async () => i18next.changeLanguage('de'))

    await renderStep()

    expect(container.textContent).toContain(
      'Das für China optimierte npmmirror ist die am schnellsten erreichbare Bezugsquelle.'
    )
    expect(container.textContent).toContain(
      'Gemessen: 42 ms. Die andere vertrauenswürdige Quelle bleibt als automatischer Fallback verfügbar.'
    )
    expect(container.textContent).not.toContain('China-friendly')
  })

  it('shows only the host check rows, not the agent or notebook rows', async () => {
    useSettingsStore.setState({
      environmentCheck: {
        ...environment(true),
        checks: [
          {
            id: 'system',
            label: 'Operating system',
            status: 'passed',
            summary: 'macOS is supported.'
          },
          {
            id: 'storage',
            label: 'Disk space',
            status: 'passed',
            summary: 'Plenty of free space.'
          },
          { id: 'agent', label: 'Claude runtime', status: 'passed', summary: 'Claude is ready.' },
          { id: 'python', label: 'Python', status: 'warning', summary: 'Optional.' }
        ]
      }
    })

    await renderStep()

    expect(container.textContent).toContain('Operating system')
    expect(container.textContent).toContain('Disk space')
    // The agent row belongs to the Agent step, the Python row to the Notebook step.
    expect(container.textContent).not.toContain('Claude runtime')
    expect(container.textContent).not.toContain('Python')
  })

  it('enables Continue when every check passed and forwards the click', async () => {
    useSettingsStore.setState({ environmentCheck: environment(true) })
    const onContinue = vi.fn()

    await renderStep(onContinue)

    expect(continueButton()?.disabled).toBe(false)
    expect(container.textContent).toContain('All required environment checks passed.')

    await clickButton(/^continue$/i)
    expect(onContinue).toHaveBeenCalledOnce()
  })

  it('enables Continue when only the agent runtime is missing (canAutoInstall)', async () => {
    // environment(false) models "host checks passed, agent missing": the agent runtime is set up
    // on the NEXT step, so this host-only step must not block on it.
    useSettingsStore.setState({ environmentCheck: environment(false) })

    await renderStep()

    expect(continueButton()?.disabled).toBe(false)
    expect(container.textContent).toContain('All required environment checks passed.')
    // And the missing-agent install block must not leak into this step (no onInstall is passed).
    expect(container.textContent).not.toContain('Install missing runtime')
  })

  it('blocks Continue while a required host check fails', async () => {
    // canAutoInstall false means a HOST item failed (not just the agent) — this step owns that.
    const hostFailed: EnvironmentCheckResult = {
      ...environment(false),
      canAutoInstall: false,
      checks: [
        {
          id: 'storage',
          label: 'Disk space',
          status: 'failed',
          summary: 'Not enough free disk space.'
        }
      ]
    }
    useSettingsStore.setState({ environmentCheck: hostFailed })

    await renderStep()

    expect(continueButton()?.disabled).toBe(true)
    expect(container.textContent).toContain('Complete every required item above to continue.')
    expect(container.textContent).toContain('Not enough free disk space.')
    expect(container.textContent).toContain(
      'Resolve the items marked Action needed, then choose Check again.'
    )
    expect(container.textContent).not.toContain('manual tab')
  })

  it('blocks Continue while a check is in flight or no result has landed yet', async () => {
    useSettingsStore.setState({ environmentCheck: undefined, isCheckingEnvironment: true })

    await renderStep()

    expect(continueButton()?.disabled).toBe(true)
  })

  it('re-runs the host inspection from the Check again button', async () => {
    useSettingsStore.setState({ environmentCheck: environment(true) })

    await renderStep()
    await clickButton(/check again/i)

    expect(useSettingsStore.getState().checkEnvironment).toHaveBeenCalledOnce()
  })
})
