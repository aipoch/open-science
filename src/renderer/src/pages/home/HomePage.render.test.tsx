// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProjectFilesChangedEvent } from '../../../../shared/project-files'
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
let getProjectFilesOverview: ReturnType<typeof vi.fn>
let onProjectFilesChanged: ((event: ProjectFilesChangedEvent) => void) | undefined
let removeProjectFilesChanged: ReturnType<typeof vi.fn>

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
  onProjectFilesChanged = undefined
  removeProjectFilesChanged = vi.fn()
  getProjectFilesOverview = vi.fn().mockResolvedValue({
    totalCount: 0,
    uploadCount: 0,
    artifactCount: 0,
    artifactGroupCount: 0,
    isIndexComplete: true
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      projectFiles: {
        getOverview: getProjectFilesOverview,
        onChanged: vi.fn((listener: (event: ProjectFilesChangedEvent) => void) => {
          onProjectFilesChanged = listener
          return removeProjectFilesChanged
        })
      }
    }
  })
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
    expect(items.map((item) => item.textContent?.trim())).toEqual([
      'Pin project',
      'Settings',
      'Archive',
      'Delete'
    ])

    const settingsItem = items.find((item) => item.textContent?.trim() === 'Settings')
    clickRadixMenuItem(settingsItem)
    await act(async () => Promise.resolve())

    expect(document.body.textContent).toContain('Project Settings')
    expect(document.body.textContent).toContain('Update this project’s name and description.')
    expect(document.body.textContent).toContain('Save')
    expect(document.body.textContent).not.toContain('Save changes')
  })

  it('pins and unpins a Project from the first menu action', async () => {
    const updateProject = vi.fn(async ({ pinned }: { pinned?: boolean }) => {
      const updated = { ...project, pinned }
      useProjectStore.setState({ projects: [updated] })
      return updated
    })
    useProjectStore.setState({
      ...createInitialProjectState(),
      projects: [project],
      isLoaded: true,
      updateProject
    } as never)

    await act(async () =>
      root.render(
        <HomePage canDeleteProjects hasCompleteSessionCatalog onOpenGlobalSearch={vi.fn()} />
      )
    )

    openRadixMenu(
      container.querySelector<HTMLButtonElement>('[aria-label="Open actions for Research project"]')
    )
    clickRadixMenuItem(
      Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
        (item) => item.textContent?.trim() === 'Pin project'
      )
    )
    await act(async () => Promise.resolve())

    expect(updateProject).toHaveBeenCalledWith({ id: project.id, pinned: true })
    expect(container.textContent).toContain('Pinned project')

    openRadixMenu(
      container.querySelector<HTMLButtonElement>('[aria-label="Open actions for Research project"]')
    )
    const unpinItem = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')
    ).find((item) => item.textContent?.trim() === 'Unpin project')
    expect(unpinItem).toBeDefined()
    clickRadixMenuItem(unpinItem)
    await act(async () => Promise.resolve())

    expect(updateProject).toHaveBeenLastCalledWith({ id: project.id, pinned: false })
  })

  it('groups pinned Projects first while preserving recent activity order inside both groups', async () => {
    const projects: Project[] = [
      { ...project, id: 'unpinned-new', name: 'Unpinned new', updatedAt: 400 },
      { ...project, id: 'pinned-old', name: 'Pinned old', pinned: true, updatedAt: 100 },
      { ...project, id: 'unpinned-old', name: 'Unpinned old', updatedAt: 300 },
      { ...project, id: 'pinned-new', name: 'Pinned new', pinned: true, updatedAt: 200 }
    ]
    useProjectStore.setState({
      ...createInitialProjectState(),
      projects,
      isLoaded: true
    })

    await act(async () =>
      root.render(
        <HomePage canDeleteProjects hasCompleteSessionCatalog onOpenGlobalSearch={vi.fn()} />
      )
    )

    expect(
      Array.from(container.querySelectorAll<HTMLElement>('[aria-label^="Open actions for "]')).map(
        (action) => action.getAttribute('aria-label')
      )
    ).toEqual([
      'Open actions for Pinned new',
      'Open actions for Pinned old',
      'Open actions for Unpinned new',
      'Open actions for Unpinned old'
    ])
  })

  it('shows complete artifact counts only while the entire Recent sessions list is empty', async () => {
    getProjectFilesOverview.mockResolvedValue({
      totalCount: 114,
      uploadCount: 0,
      artifactCount: 114,
      artifactGroupCount: 1,
      isIndexComplete: true
    })
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
    await act(async () => Promise.resolve())

    expect(container.textContent).toContain('114 artifacts')
    expect(getProjectFilesOverview).toHaveBeenCalledWith({ projectId: project.id })

    getProjectFilesOverview.mockResolvedValue({
      totalCount: 115,
      uploadCount: 0,
      artifactCount: 115,
      artifactGroupCount: 1,
      isIndexComplete: true
    })
    await act(async () => {
      onProjectFilesChanged?.({
        projectId: project.id,
        sessionId: 'session-1',
        sources: ['artifact'],
        kind: 'upsert'
      })
      await Promise.resolve()
    })

    expect(container.textContent).toContain('115 artifacts')
    expect(getProjectFilesOverview).toHaveBeenCalledTimes(2)

    await act(async () => {
      useSessionStore.setState({
        ...createInitialSessionState(),
        sessions: [session('recent', 'Recent analysis', 'idle', 600_000)]
      })
    })

    expect(container.textContent).not.toContain('114 artifacts')
    expect(container.textContent).not.toContain('115 artifacts')
    expect(removeProjectFilesChanged).toHaveBeenCalledOnce()
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
    const home = container.querySelector('main')
    const cardGrid = activeSection?.firstElementChild
    const cards = activeSection?.querySelectorAll<HTMLButtonElement>('button') ?? []
    expect(home?.classList.contains('h-svh')).toBe(true)
    expect(home?.classList.contains('overflow-y-auto')).toBe(true)
    expect(cardGrid?.classList.contains('grid')).toBe(true)
    expect(cardGrid?.classList.contains('grid-cols-1')).toBe(true)
    expect(cardGrid?.classList.contains('md:grid-cols-2')).toBe(true)
    expect(cardGrid?.classList.contains('overflow-x-auto')).toBe(false)
    expect(cards[0]?.classList.contains('cursor-pointer')).toBe(true)
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
    expect(runningCard?.querySelector('.home-session-title-running')?.textContent?.trim()).toBe(
      'Running analysis'
    )
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

  it('dismisses every backend completion for a session without opening it', async () => {
    const now = 600_000
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now)
    const openSession = vi.fn()
    const markSessionCompletionsRead = vi.fn().mockResolvedValue(undefined)
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
      revision: 2,
      unreadCount: 2,
      latestSequence: 2,
      status: 'ready',
      items: [
        completedItem,
        {
          ...completedItem,
          id: 'completed-2',
          sequence: 2,
          dedupeKey: 'task:completed:finished:follow-up',
          createdAt: now - 1
        }
      ],
      markSessionCompletionsRead
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
    expect(completedCard?.classList.contains('cursor-pointer')).toBe(true)

    const dismissButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Mark completed session Finished analysis as read"]'
    )
    expect(dismissButton?.classList.contains('home-session-dismiss')).toBe(true)
    expect(dismissButton?.classList.contains('cursor-pointer')).toBe(true)

    await act(async () => dismissButton?.click())

    expect(markSessionCompletionsRead).toHaveBeenCalledWith(['finished'])
    expect(openSession).not.toHaveBeenCalled()

    markSessionCompletionsRead.mockRejectedValueOnce(new Error('read failed'))
    await act(async () => dismissButton?.click())

    expect(
      container.querySelector(
        '[aria-label="Retry marking completed session Finished analysis as read"]'
      )
    ).not.toBeNull()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Could not mark this completed session as read.'
    )

    await act(async () => completedCard?.click())

    expect(openSession).toHaveBeenCalledWith(project.id, 'finished', 'user')

    await act(async () => {
      useNotificationInboxStore.setState({
        revision: 3,
        unreadCount: 0,
        items: [
          { ...completedItem, readAt: now },
          {
            ...completedItem,
            id: 'completed-2',
            sequence: 2,
            dedupeKey: 'task:completed:finished:follow-up',
            createdAt: now - 1,
            readAt: now
          }
        ]
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
