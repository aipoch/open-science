// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Project } from '../../../../shared/projects'
import type { EnvironmentCheckResult } from '../../../../shared/settings'
import { EMPTY_SNAPSHOT, useNotificationInboxStore } from '@/stores/notification-inbox-store'
import { createInitialProjectState, useProjectStore } from '@/stores/project-store'
import { useNavigationStore } from '@/stores/navigation-store'
import {
  createInitialSessionState,
  type ChatSession,
  useSessionStore
} from '@/stores/session-store'
import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'
import { clickRadixMenuItem, openRadixMenu } from '../settings/test-utils'
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
  useNotificationInboxStore.setState({
    ...EMPTY_SNAPSHOT,
    status: 'idle',
    error: undefined
  })
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
  it('matches the shared session menu and opens Project Settings', async () => {
    useProjectStore.setState({
      ...createInitialProjectState(),
      projects: [project],
      isLoaded: true
    })

    await act(async () =>
      root.render(
        <HomePage canDeleteProjects hasCompleteSessionCatalog onOpenGlobalSearch={vi.fn()} />
      )
    )

    openRadixMenu(
      container.querySelector<HTMLButtonElement>('[aria-label="Open actions for Research project"]')
    )

    const menu = document.body.querySelector<HTMLElement>('[aria-label="Project actions"]')
    const items = Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'))
    expect(menu?.className).toContain('text-popover-foreground')
    expect(menu?.className).toContain('w-max')
    expect(menu?.className).toContain('min-w-0')
    expect(items.map((item) => item.textContent?.trim())).toEqual(['Settings', 'Archive', 'Delete'])

    const settingsItem = items.find((item) => item.textContent?.trim() === 'Settings')
    clickRadixMenuItem(settingsItem)
    await act(async () => Promise.resolve())

    expect(document.body.textContent).toContain('Project Settings')
    expect(document.body.textContent).toContain('Update this project’s name and description.')
    expect(document.body.textContent).toContain('Save')
    expect(document.body.textContent).not.toContain('Save changes')
  })

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

    const activeSection = container.querySelector<HTMLElement>('[aria-label="Session updates"]')
    const scroller = activeSection?.firstElementChild
    const cards = activeSection?.querySelectorAll<HTMLButtonElement>('button') ?? []
    expect(scroller?.classList.contains('overflow-x-auto')).toBe(true)
    expect(scroller?.classList.contains('-mx-2')).toBe(true)
    expect(scroller?.classList.contains('scroll-px-2')).toBe(true)
    expect(scroller?.classList.contains('px-2')).toBe(true)
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
    const runningCard = container.querySelector<HTMLElement>(
      '[aria-label="Open session Running analysis, running"]'
    )
    const runningBadge = Array.from(runningCard?.querySelectorAll('span') ?? []).find(
      (element) => element.textContent?.trim() === 'Running'
    )
    const runningProjectCount = container.querySelector<HTMLElement>('[aria-label="1 running"]')
    expect(runningBadge?.classList.contains('bg-session-running/10')).toBe(true)
    expect(runningBadge?.classList.contains('text-session-running')).toBe(true)
    expect(runningBadge?.querySelector('svg')?.classList.contains('animate-spin')).toBe(true)
    expect(
      runningBadge?.querySelector('svg')?.classList.contains('motion-reduce:animate-none')
    ).toBe(true)
    expect(runningProjectCount?.querySelector('svg')?.classList.contains('animate-spin')).toBe(true)

    await act(async () => cards[0]?.click())

    expect(openSession).toHaveBeenCalledWith(project.id, 'plan', 'user')
    nowSpy.mockRestore()
  })

  it('updates an active card while Home remains mounted', async () => {
    useProjectStore.setState({
      ...createInitialProjectState(),
      projects: [project],
      isLoaded: true
    })
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [session('live', 'Live analysis', 'running', 600_000)]
    })

    await act(async () =>
      root.render(
        <HomePage canDeleteProjects hasCompleteSessionCatalog onOpenGlobalSearch={vi.fn()} />
      )
    )

    expect(
      container.querySelector('[aria-label="Open session Live analysis, running"]')
    ).not.toBeNull()

    await act(async () => {
      useSessionStore.getState().setPermissionPending('live')
    })

    expect(
      container.querySelector('[aria-label="Open session Live analysis, needs you"]')
    ).not.toBeNull()
  })

  it('shows an unread completed session until its result is marked read', async () => {
    const now = 600_000
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now)
    const openSession = vi.fn()
    const completedItem = {
      id: 'completed-1',
      sequence: 1,
      dedupeKey: 'task:completed:finished',
      kind: 'task.completed' as const,
      projectId: project.id,
      sessionId: 'finished',
      originId: 'finished-run',
      title: 'Finished analysis',
      summary: 'A task completed.',
      createdAt: now
    }
    useProjectStore.setState({
      ...createInitialProjectState(),
      projects: [project],
      isLoaded: true
    })
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [session('finished', 'Finished analysis', 'idle', now - 10 * 60_000)]
    })
    useNotificationInboxStore.setState({
      revision: 1,
      unreadCount: 1,
      latestSequence: 1,
      status: 'ready',
      items: [completedItem]
    })
    useNavigationStore.setState({ openSession } as never)

    await act(async () =>
      root.render(
        <HomePage canDeleteProjects hasCompleteSessionCatalog onOpenGlobalSearch={vi.fn()} />
      )
    )

    const completedCard = container.querySelector<HTMLButtonElement>(
      '[aria-label="Open session Finished analysis, completed"]'
    )
    const completedBadge = Array.from(completedCard?.querySelectorAll('span') ?? []).find(
      (element) => element.textContent?.trim() === 'Completed'
    )
    expect(completedCard?.textContent).toContain('Completed')
    expect(completedCard?.textContent).toContain('just now')
    expect(completedBadge?.classList.contains('text-success-000')).toBe(true)
    expect(completedBadge?.querySelector('svg')?.classList.contains('animate-spin')).toBe(false)

    await act(async () => completedCard?.click())

    expect(openSession).toHaveBeenCalledWith(project.id, 'finished', 'user')

    await act(async () => {
      useNotificationInboxStore.setState({
        revision: 2,
        unreadCount: 0,
        items: [{ ...completedItem, readAt: now }]
      })
    })

    expect(
      container.querySelector('[aria-label="Open session Finished analysis, completed"]')
    ).toBeNull()
    nowSpy.mockRestore()
  })

  it('labels recent sessions with their Project name instead of repeating the session title', async () => {
    const recentSession: ChatSession = {
      ...session('recent', 'Live analysis', 'idle', 600_000),
      messages: [
        {
          id: 'recent-prompt',
          role: 'user',
          content: 'Live analysis',
          status: 'complete',
          eventIds: [],
          createdAt: 600_000,
          updatedAt: 600_000
        }
      ]
    }
    useProjectStore.setState({
      ...createInitialProjectState(),
      projects: [project],
      isLoaded: true
    })
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [recentSession]
    })

    await act(async () =>
      root.render(
        <HomePage canDeleteProjects hasCompleteSessionCatalog onOpenGlobalSearch={vi.fn()} />
      )
    )

    const recentRow = container.querySelector<HTMLElement>('[aria-label="Recent sessions"] button')
    expect(recentRow?.textContent).toContain(project.name)
    expect(recentRow?.textContent?.match(/Live analysis/g)).toHaveLength(1)
  })
})
