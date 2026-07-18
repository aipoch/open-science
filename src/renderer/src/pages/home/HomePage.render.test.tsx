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

  it('shows a required-item alert and opens repair only after the user clicks it', async () => {
    const openEnvironmentRepair = vi.fn()
    useSettingsStore.setState({
      environmentCheck: environment([
        {
          id: 'agent',
          label: 'Claude runtime',
          status: 'failed',
          summary: 'Claude is missing.'
        }
      ]),
      openEnvironmentRepair
    })

    await act(async () => root.render(<HomePage />))

    const repairButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Open environment repair"]'
    )
    expect(repairButton?.textContent).toContain('Claude runtime needs attention')
    expect(openEnvironmentRepair).not.toHaveBeenCalled()

    await act(async () => repairButton?.click())

    expect(openEnvironmentRepair).toHaveBeenCalledOnce()
  })
})
