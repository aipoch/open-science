// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Project } from '../../../../shared/projects'
import type { EnvironmentCheckResult } from '../../../../shared/settings'
import { createInitialProjectState, useProjectStore } from '@/stores/project-store'
import { useNavigationStore } from '@/stores/navigation-store'
import {
  createInitialSessionState,
  type ChatSession,
  useSessionStore
} from '@/stores/session-store'
import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'
import { HomePage } from './HomePage'

vi.mock('@/components/GitHubStarBadge', () => ({ GitHubStarBadge: () => null }))
vi.mock('@/components/UpdateCapsule', () => ({ UpdateCapsule: () => null }))

let container: HTMLDivElement
let root: Root

const project: Project = {
  id: 'project-1',
  name: 'Research project',
  description: '',
  isExample: false,
  createdAt: 1,
  updatedAt: 1
}

const session = (
  id: string,
  title: string,
  status: ChatSession['status'],
  updatedAt: number
): ChatSession => ({
  id,
  projectId: project.id,
  title,
  cwd: '/workspace/project-1',
  status,
  messages: [],
  ...(status === 'running'
    ? { activeRun: { promptMessageId: `${id}-prompt`, startedAt: updatedAt } }
    : {}),
  createdAt: updatedAt,
  updatedAt
})

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
  useNavigationStore.setState({ pendingProjectCreation: false })
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
  it('consumes a global-search request and opens the New Project dialog', async () => {
    useNavigationStore.setState({ pendingProjectCreation: true })

    await act(async () =>
      root.render(
        <HomePage canDeleteProjects hasCompleteSessionCatalog onOpenGlobalSearch={vi.fn()} />
      )
    )

    expect(document.body.textContent).toContain('Group related sessions under a project.')
    expect(useNavigationStore.getState().pendingProjectCreation).toBe(false)
    expect(container.querySelector('[aria-label^="Messages,"]')).not.toBeNull()
  })

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

    await act(async () =>
      root.render(
        <HomePage canDeleteProjects hasCompleteSessionCatalog onOpenGlobalSearch={vi.fn()} />
      )
    )

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

    await act(async () =>
      root.render(
        <HomePage canDeleteProjects hasCompleteSessionCatalog onOpenGlobalSearch={vi.fn()} />
      )
    )

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

    await act(async () =>
      root.render(
        <HomePage canDeleteProjects hasCompleteSessionCatalog onOpenGlobalSearch={vi.fn()} />
      )
    )
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

    await act(async () =>
      root.render(
        <HomePage canDeleteProjects hasCompleteSessionCatalog onOpenGlobalSearch={vi.fn()} />
      )
    )
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

    await act(async () =>
      root.render(
        <HomePage canDeleteProjects hasCompleteSessionCatalog onOpenGlobalSearch={vi.fn()} />
      )
    )
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

    await act(async () =>
      root.render(
        <HomePage canDeleteProjects hasCompleteSessionCatalog onOpenGlobalSearch={vi.fn()} />
      )
    )
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Open environment repair"]')?.click()
    )

    expect(openSettingsToPanel).toHaveBeenCalledWith('agent')
  })
})

describe('HomePage activity overview', () => {
  it('opens global search from the header and uses the selected Projects icon', async () => {
    const onOpenGlobalSearch = vi.fn()

    await act(async () =>
      root.render(
        <HomePage
          canDeleteProjects
          hasCompleteSessionCatalog
          onOpenGlobalSearch={onOpenGlobalSearch}
        />
      )
    )

    expect(container.querySelector('.lucide-gallery-vertical-end')).not.toBeNull()

    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Search"]')?.click()
    )

    expect(onOpenGlobalSearch).toHaveBeenCalledOnce()
  })

  it('prioritizes needs-you cards and shows separate per-project activity counts', async () => {
    const now = 600_000
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now)
    const openSession = vi.fn()
    useProjectStore.setState({
      ...createInitialProjectState(),
      projects: [project],
      isLoaded: true
    })
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [
        session('running', 'Running analysis', 'running', now - 5 * 60_000),
        session('permission', 'Permission request', 'waiting-permission', now - 3 * 60_000),
        session('plan', 'Plan review', 'waiting-plan-approval', now - 2 * 60_000),
        session('idle', 'Finished work', 'idle', now - 60_000)
      ]
    })
    useNavigationStore.setState({ openSession } as never)

    await act(async () =>
      root.render(
        <HomePage canDeleteProjects hasCompleteSessionCatalog onOpenGlobalSearch={vi.fn()} />
      )
    )

    const activeSection = container.querySelector<HTMLElement>('[aria-label="Active sessions"]')
    const scroller = activeSection?.firstElementChild
    const cards = activeSection?.querySelectorAll<HTMLButtonElement>('button') ?? []
    expect(scroller?.classList.contains('overflow-x-auto')).toBe(true)
    expect(cards[0]?.classList.contains('shrink-0')).toBe(true)
    expect([...cards].map((card) => card.getAttribute('aria-label'))).toEqual([
      'Open session Plan review, needs you',
      'Open session Permission request, needs you',
      'Open session Running analysis, running'
    ])
    expect(activeSection?.textContent).toContain('waiting 2m')
    expect(activeSection?.textContent).toContain('waiting 3m')
    expect(activeSection?.textContent).toContain('running 5m')
    expect(container.textContent).toContain('2 waiting on you')
    expect(container.textContent).toContain('1 running')
    expect(container.querySelector('[aria-label="2 waiting on you"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="1 running"]')).not.toBeNull()

    await act(async () => cards[0]?.click())

    expect(openSession).toHaveBeenCalledWith(project.id, 'plan', 'user')
    nowSpy.mockRestore()
  })
})
