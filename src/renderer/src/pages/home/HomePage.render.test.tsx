// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { EnvironmentCheckResult } from '../../../../shared/settings'
import { createInitialProjectState, useProjectStore } from '@/stores/project-store'
import { createInitialSessionState, useSessionStore } from '@/stores/session-store'
import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'
import { HomePage } from './HomePage'

vi.mock('@/components/GitHubStarBadge', () => ({ GitHubStarBadge: () => null }))
vi.mock('@/components/UpdateCapsule', () => ({ UpdateCapsule: () => null }))

let container: HTMLDivElement
let root: Root

const environment = (checks: EnvironmentCheckResult['checks']): EnvironmentCheckResult => ({
  checkedAt: 1,
  platform: 'darwin',
  architecture: 'arm64',
  checks,
  ready: checks.every((check) => check.status !== 'failed'),
  canAutoInstall: false,
  agentFrameworkId: 'claude-code',
  runtime: { found: true, path: '/bin/claude', version: '2.1.0' }
})

beforeEach(() => {
  useProjectStore.setState(createInitialProjectState())
  useSessionStore.setState(createInitialSessionState())
  useSettingsStore.setState(createInitialSettingsState())
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

describe('HomePage environment repair notice', () => {
  it('does not alert for optional Python or secure-storage warnings', async () => {
    useSettingsStore.setState({
      environmentCheck: environment([
        {
          id: 'python',
          label: 'Python for Notebook',
          status: 'warning',
          summary: 'Python is optional.'
        },
        {
          id: 'secure-storage',
          label: 'Secure credential storage',
          status: 'warning',
          summary: 'Reduced protection is available.'
        }
      ])
    })

    await act(async () => root.render(<HomePage />))

    expect(container.querySelector('[aria-label="Open environment repair"]')).toBeNull()
  })

  it('opens the Agent settings panel for a failed selected runtime only after the alert is clicked', async () => {
    const openSettingsToPanel = vi.fn()
    useSettingsStore.setState({
      environmentCheck: environment([
        {
          id: 'agent',
          label: 'Claude runtime',
          status: 'failed',
          summary: 'Claude is missing.'
        }
      ]),
      openSettingsToPanel
    } as never)

    await act(async () => root.render(<HomePage />))

    const repairButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Open environment repair"]'
    )
    expect(repairButton?.textContent).toContain('Claude runtime needs attention')
    expect(openSettingsToPanel).not.toHaveBeenCalled()

    await act(async () => repairButton?.click())

    expect(openSettingsToPanel).toHaveBeenCalledWith('agent')
  })

  it('opens Storage before Agent when both required checks fail', async () => {
    const openSettingsToPanel = vi.fn()
    useSettingsStore.setState({
      environmentCheck: environment([
        {
          id: 'agent',
          label: 'Claude runtime',
          status: 'failed',
          summary: 'Claude is missing.'
        },
        {
          id: 'storage',
          label: 'Application storage',
          status: 'failed',
          summary: 'The application storage directory is unavailable.'
        }
      ]),
      openSettingsToPanel
    } as never)

    await act(async () => root.render(<HomePage />))
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Open environment repair"]')?.click()
    )

    expect(openSettingsToPanel).toHaveBeenCalledWith('storage')
  })

  it('opens Storage settings when application storage is the only failed check', async () => {
    const openSettingsToPanel = vi.fn()
    useSettingsStore.setState({
      environmentCheck: environment([
        {
          id: 'storage',
          label: 'Application storage',
          status: 'failed',
          summary: 'The application storage directory is unavailable.'
        }
      ]),
      openSettingsToPanel
    } as never)

    await act(async () => root.render(<HomePage />))
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Open environment repair"]')?.click()
    )

    expect(openSettingsToPanel).toHaveBeenCalledWith('storage')
  })

  it('opens Agent settings for an install-network blocker', async () => {
    const openSettingsToPanel = vi.fn()
    useSettingsStore.setState({
      environmentCheck: environment([
        {
          id: 'install-network',
          label: 'Installation network',
          status: 'failed',
          summary: 'Managed and npm install sources are unavailable.'
        }
      ]),
      openSettingsToPanel
    } as never)

    await act(async () => root.render(<HomePage />))
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Open environment repair"]')?.click()
    )

    expect(openSettingsToPanel).toHaveBeenCalledWith('agent')
  })

  it('opens Agent settings for a system compatibility blocker', async () => {
    const openSettingsToPanel = vi.fn()
    useSettingsStore.setState({
      environmentCheck: environment([
        {
          id: 'system',
          label: 'System compatibility',
          status: 'failed',
          summary: 'No app-managed runtime is available for this host.'
        }
      ]),
      openSettingsToPanel
    } as never)

    await act(async () => root.render(<HomePage />))
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Open environment repair"]')?.click()
    )

    expect(openSettingsToPanel).toHaveBeenCalledWith('agent')
  })
})
