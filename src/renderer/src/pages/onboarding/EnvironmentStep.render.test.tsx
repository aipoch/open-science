// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { EnvironmentCheckResult } from '../../../../shared/settings'
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

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  delete (window as unknown as { api?: unknown }).api
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
