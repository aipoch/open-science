// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { JobSummary } from '../../../../shared/compute'
import type { ProjectFilesChangedEvent } from '../../../../shared/project-files'
import type { Project } from '../../../../shared/projects'
import type { EnvironmentCheckResult } from '../../../../shared/settings'
import type { ActivePlanProjection } from '../../../../shared/session-plan/contract'
import { EMPTY_SNAPSHOT, useNotificationInboxStore } from '@/stores/notification-inbox-store'
import { createInitialProjectState, useProjectStore } from '@/stores/project-store'
import { useNavigationStore } from '@/stores/navigation-store'
import { createInitialSessionJobState, useSessionJobStore } from '@/stores/session-job-store'
import {
  createInitialSessionState,
  type ChatSession,
  useSessionStore
} from '@/stores/session-store'
import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'
import { clickRadixMenuItem, openRadixMenu } from '../settings/test-utils'
import { HomePage } from './HomePage'

vi.mock('@/components/GitHubStarBadge', () => ({ GitHubStarBadge: () => null }))
vi.mock('@/components/UpdateCapsule', () => ({
  UpdateCapsule: () => (
    <button type="button" data-testid="home-update-capsule">
      Update
    </button>
  )
}))

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

const computeJob = (
  sessionId: string,
  status: Extract<JobSummary['status'], 'queued' | 'submitted' | 'running'>
): JobSummary => ({
  job_id: `job-${status}`,
  provider_id: 'ssh:cluster',
  display_name: 'Cluster',
  shape: 'direct_ssh',
  session_id: sessionId,
  status,
  intent: 'Run remote analysis',
  created_at: 500_000,
  started_at: status === 'running' ? 510_000 : undefined,
  finished_at: undefined,
  exit_code: undefined,
  error_code: undefined,
  remote_workdir: undefined,
  stdout_tail: undefined,
  stderr_tail: undefined,
  notified_at: undefined,
  notification_consumed_at: undefined
})

const pendingPlan: ActivePlanProjection = {
  artifactId: 'plan-1',
  artifactVersionId: 'plan-version-1',
  artifactChecksum: 'a'.repeat(64),
  revision: 1,
  approval: 'pending',
  lifecycle: 'awaiting_approval',
  document: {
    schema_version: 1,
    task_summary: 'Review the generated plan',
    phases: [],
    desired_outputs: [],
    feasibility: { confidence: 'high', rationale: 'Ready for review.' }
  },
  stepStatuses: {},
  stepStates: {},
  counts: { phases: 0, delegations: 0, steps: 0, completed: 0, inProgress: 0 }
}

const sessionWithPendingDelegatedQuestion = (
  status: ChatSession['status'],
  updatedAt: number
): ChatSession => ({
  ...session('delegated-question', 'Delegated question', status, updatedAt),
  conversationGraph: {
    schemaVersion: 1,
    rootFrameId: 'root',
    activeFrameId: 'root',
    frames: [
      {
        id: 'root',
        originBindingState: 'root',
        kind: 'root',
        status: status === 'running' ? 'running' : 'completed',
        activeBranchId: 'root-branch',
        createdAt: 1
      },
      {
        id: 'child',
        parentFrameId: 'root',
        originMessageId: 'root-prompt',
        originBindingState: 'validated',
        kind: 'delegate',
        delegateName: 'Researcher',
        status: 'completed',
        activeBranchId: 'child-branch',
        createdAt: 2
      }
    ],
    branches: [
      {
        id: 'root-branch',
        agentFrameId: 'root',
        headMessageId: 'root-prompt',
        createdAt: 1,
        updatedAt: 1
      },
      {
        id: 'child-branch',
        agentFrameId: 'child',
        headMessageId: 'child-message',
        createdAt: 2,
        updatedAt: 2
      }
    ],
    messages: [
      {
        id: 'root-prompt',
        role: 'user',
        content: 'Research this topic',
        status: 'complete',
        eventIds: [],
        agentFrameId: 'root',
        introducedOnBranchId: 'root-branch',
        createdAt: 1,
        updatedAt: 1
      },
      {
        id: 'child-message',
        role: 'agent',
        content: 'I need one detail.',
        status: 'complete',
        eventIds: [],
        agentFrameId: 'child',
        introducedOnBranchId: 'child-branch',
        createdAt: 2,
        updatedAt: 2
      }
    ],
    activities: [],
    activityGroups: [],
    runtimeSegments: []
  },
  runtimeContext: {
    version: 1,
    revision: 1,
    delegatedWork: {
      records: [],
      questionRequests: [
        {
          requestId: 'question-1',
          canonicalDigest: 'a'.repeat(64),
          sourceFrameId: 'child',
          sourceAttemptId: 'attempt-1',
          sourceRuntimeSegmentId: 'runtime-1',
          sourceMessageBranchId: 'child-branch',
          rootOriginMessageId: 'root-prompt',
          rootBranchId: 'root-branch',
          sourceName: 'Researcher',
          questions: [
            { question: 'Which scope?', options: [{ label: 'Narrow' }, { label: 'Broad' }] }
          ],
          sequence: 1,
          askedAt: 2,
          status: 'pending',
          draftAnswers: [],
          draftQuestionIndex: 0
        }
      ]
    }
  }
})

const sessionWithDelegatedRuns = (
  status: ChatSession['status'],
  attempts: readonly Readonly<{
    frameId: string
    originMessageId?: string
    startedAt: number
    status: 'running' | 'completed' | 'cancelled' | 'error'
  }>[]
): ChatSession => {
  const candidate = session('delegated-runs', 'Delegated runs', status, 590_000)
  const inactiveOriginMessageIds = [
    ...new Set(
      attempts
        .map(({ originMessageId }) => originMessageId)
        .filter((id): id is string => Boolean(id && id !== 'root-prompt'))
    )
  ]
  return {
    ...candidate,
    activeRun: undefined,
    conversationGraph: {
      schemaVersion: 1,
      rootFrameId: 'root',
      activeFrameId: 'root',
      frames: [
        {
          id: 'root',
          originBindingState: 'root',
          kind: 'root',
          status: 'completed',
          activeBranchId: 'root-branch',
          createdAt: 1
        },
        ...attempts.map(({ frameId, originMessageId = 'root-prompt', status, startedAt }) => ({
          id: frameId,
          parentFrameId: 'root',
          originMessageId,
          originBindingState: 'validated' as const,
          kind: 'delegate' as const,
          status,
          activeBranchId: `${frameId}-branch`,
          createdAt: startedAt
        }))
      ],
      branches: [
        {
          id: 'root-branch',
          agentFrameId: 'root',
          headMessageId: 'root-prompt',
          createdAt: 1,
          updatedAt: 1
        },
        ...inactiveOriginMessageIds.map((id) => ({
          id: `${id}-branch`,
          agentFrameId: 'root',
          headMessageId: id,
          createdAt: 2,
          updatedAt: 2
        })),
        ...attempts.map(({ frameId, startedAt }) => ({
          id: `${frameId}-branch`,
          agentFrameId: frameId,
          createdAt: startedAt,
          updatedAt: startedAt
        }))
      ],
      messages: [
        {
          id: 'root-prompt',
          role: 'user',
          content: 'Delegate the research',
          status: 'complete',
          eventIds: [],
          agentFrameId: 'root',
          introducedOnBranchId: 'root-branch',
          createdAt: 1,
          updatedAt: 1
        },
        ...inactiveOriginMessageIds.map((id) => ({
          id,
          role: 'user' as const,
          content: 'Delegate work from the alternate branch',
          status: 'complete' as const,
          eventIds: [],
          agentFrameId: 'root',
          introducedOnBranchId: `${id}-branch`,
          createdAt: 2,
          updatedAt: 2
        }))
      ],
      activities: [],
      activityGroups: [],
      runtimeSegments: []
    },
    runtimeContext: {
      version: 1,
      revision: 1,
      delegatedWork: {
        records: attempts.map(({ frameId, startedAt, status }) => ({
          agentFrameId: frameId,
          attempts: [
            {
              id: `${frameId}-attempt`,
              status,
              resolvedAgent: { kind: 'main' },
              runtimeSegmentIds: [],
              startedAt,
              ...(status === 'running' ? {} : { endedAt: startedAt + 1 }),
              ...(status === 'completed' ? { terminalMessageId: `${frameId}-terminal` } : {}),
              ...(status === 'cancelled' ? { cancellationReason: 'main_agent_stop' as const } : {}),
              ...(status === 'error'
                ? { error: { code: 'child_error', message: 'Child failed' } }
                : {})
            }
          ]
        }))
      }
    }
  }
}

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
  useSessionJobStore.setState(createInitialSessionJobState())
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
    expect(repairButton?.className).toContain('cursor-pointer')
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
    expect(document.body.textContent).toContain(
      "Update this project's name, description, and agent context."
    )
    expect(document.body.textContent).toContain('Save')
    expect(document.body.textContent).not.toContain('Save changes')
  })

  it('explains unavailable archive in menu content without relying on native title', async () => {
    useProjectStore.setState({
      ...createInitialProjectState(),
      projects: [project],
      isLoaded: true
    })
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [
        sessionWithDelegatedRuns('idle', [
          {
            frameId: 'branch-a-child',
            originMessageId: 'branch-a-prompt',
            startedAt: 500_000,
            status: 'running'
          }
        ])
      ]
    })

    await act(async () =>
      root.render(
        <HomePage canDeleteProjects hasCompleteSessionCatalog onOpenGlobalSearch={vi.fn()} />
      )
    )
    openRadixMenu(
      container.querySelector<HTMLButtonElement>('[aria-label="Open actions for Research project"]')
    )

    const archiveItem = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')
    ).find((item) => item.textContent?.trim().startsWith('Archive'))
    expect(archiveItem?.getAttribute('aria-disabled')).toBe('true')
    expect(document.body.querySelector('[role="menu"]')?.textContent).toContain(
      'Finish or stop active sessions before archiving this project.'
    )
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

    expect(updateProject).toHaveBeenCalledWith({
      id: project.id,
      pinned: true,
      expectedUpdatedAt: project.updatedAt
    })
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

    expect(updateProject).toHaveBeenLastCalledWith({
      id: project.id,
      pinned: false,
      expectedUpdatedAt: project.updatedAt
    })
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

  it('places the update action beside Settings and before New project', async () => {
    await act(async () =>
      root.render(
        <HomePage canDeleteProjects hasCompleteSessionCatalog onOpenGlobalSearch={vi.fn()} />
      )
    )

    const settings = container.querySelector('[aria-label="Model settings"]')
    const update = container.querySelector('[data-testid="home-update-capsule"]')
    const newProject = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('New project')
    )

    expect(settings).not.toBeNull()
    expect(update).not.toBeNull()
    expect(newProject).toBeDefined()
    expect(settings?.compareDocumentPosition(update!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(update?.compareDocumentPosition(newProject!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  it('prioritizes waiting cards with exact reasons and keeps aggregate activity counts', async () => {
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
      'Open session Plan review, waiting for plan approval',
      'Open session Permission request, waiting for permission',
      'Open session Running analysis, running'
    ])
    expect(activeSection?.textContent).toContain('Waiting for plan approval')
    expect(activeSection?.textContent).toContain('Waiting for permission')
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

  it('shows a running Session as waiting for an answer for an active delegated question', async () => {
    useProjectStore.setState({
      ...createInitialProjectState(),
      projects: [project],
      isLoaded: true
    })
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [sessionWithPendingDelegatedQuestion('running', 600_000)]
    })

    await act(async () =>
      root.render(
        <HomePage canDeleteProjects hasCompleteSessionCatalog onOpenGlobalSearch={vi.fn()} />
      )
    )

    expect(
      container.querySelector(
        '[aria-label="Open session Delegated question, waiting for your answer"]'
      )
    ).not.toBeNull()
    expect(container.textContent).toContain('Waiting for your answer')
    expect(container.querySelector('[aria-label="1 waiting on you"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="1 running"]')).toBeNull()
  })

  it('shows Session credential recovery as waiting for an answer on Home', async () => {
    useProjectStore.setState({
      ...createInitialProjectState(),
      projects: [project],
      isLoaded: true
    })
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [session('credential', 'OpenAlex lookup', 'running', 600_000)]
    })
    useSettingsStore.setState({
      pendingCredentialRequests: [
        {
          id: 'credential-request',
          credentialId: 'openalex',
          connector: 'literature',
          method: 'openalex_search_works',
          sessionId: 'credential'
        }
      ]
    })

    await act(async () =>
      root.render(
        <HomePage canDeleteProjects hasCompleteSessionCatalog onOpenGlobalSearch={vi.fn()} />
      )
    )

    expect(
      container.querySelector(
        '[aria-label="Open session OpenAlex lookup, waiting for your answer"]'
      )
    ).not.toBeNull()
    expect(container.querySelector('[aria-label="1 waiting on you"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="1 running"]')).toBeNull()
  })

  it.each(['idle', 'error'] as const)(
    'shows a current delegated Attempt as Running while the root Session is %s',
    async (status) => {
      const now = 600_000
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now)
      useProjectStore.setState({
        ...createInitialProjectState(),
        projects: [project],
        isLoaded: true
      })
      useSessionStore.setState({
        ...createInitialSessionState(),
        sessions: [
          sessionWithDelegatedRuns(status, [
            { frameId: 'child-later', startedAt: now - 60_000, status: 'running' },
            { frameId: 'child-earlier', startedAt: now - 5 * 60_000, status: 'running' }
          ])
        ]
      })

      await act(async () =>
        root.render(
          <HomePage canDeleteProjects hasCompleteSessionCatalog onOpenGlobalSearch={vi.fn()} />
        )
      )

      const card = container.querySelector('[aria-label="Open session Delegated runs, running"]')
      expect(card).not.toBeNull()
      expect(card?.textContent).toContain('running 5m')
      expect(container.querySelector('[aria-label="1 running"]')).not.toBeNull()
      nowSpy.mockRestore()
    }
  )

  it('tracks the earliest still-running child as delegated Attempts finish', async () => {
    const now = 600_000
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now)
    const initial = sessionWithDelegatedRuns('idle', [
      { frameId: 'child-first', startedAt: now - 5 * 60_000, status: 'running' },
      { frameId: 'child-second', startedAt: now - 2 * 60_000, status: 'running' }
    ])
    useProjectStore.setState({
      ...createInitialProjectState(),
      projects: [project],
      isLoaded: true
    })
    useSessionStore.setState({ ...createInitialSessionState(), sessions: [initial] })

    await act(async () =>
      root.render(
        <HomePage canDeleteProjects hasCompleteSessionCatalog onOpenGlobalSearch={vi.fn()} />
      )
    )
    expect(
      container.querySelector('[aria-label="Open session Delegated runs, running"]')?.textContent
    ).toContain('running 5m')

    const oneRemaining = sessionWithDelegatedRuns('idle', [
      { frameId: 'child-first', startedAt: now - 5 * 60_000, status: 'completed' },
      { frameId: 'child-second', startedAt: now - 2 * 60_000, status: 'running' }
    ])
    await act(async () => useSessionStore.setState({ sessions: [oneRemaining] }))
    expect(
      container.querySelector('[aria-label="Open session Delegated runs, running"]')?.textContent
    ).toContain('running 2m')

    const noneRemaining = sessionWithDelegatedRuns('idle', [
      { frameId: 'child-first', startedAt: now - 5 * 60_000, status: 'completed' },
      { frameId: 'child-second', startedAt: now - 2 * 60_000, status: 'error' }
    ])
    await act(async () => useSessionStore.setState({ sessions: [noneRemaining] }))
    expect(
      container.querySelector('[aria-label="Open session Delegated runs, running"]')
    ).toBeNull()
    nowSpy.mockRestore()
  })

  it.each([
    {
      reason: 'child started first',
      rootStartedAt: 540_000,
      childStartedAt: 300_000,
      expected: 'running 5m'
    },
    {
      reason: 'root started first',
      rootStartedAt: 240_000,
      childStartedAt: 540_000,
      expected: 'running 6m'
    }
  ])('uses the earliest root-or-child start when $reason', async (scenario) => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(600_000)
    const mixed = sessionWithDelegatedRuns('running', [
      { frameId: 'child', startedAt: scenario.childStartedAt, status: 'running' }
    ])
    mixed.activeRun = { promptMessageId: 'root-prompt', startedAt: scenario.rootStartedAt }
    useProjectStore.setState({
      ...createInitialProjectState(),
      projects: [project],
      isLoaded: true
    })
    useSessionStore.setState({ ...createInitialSessionState(), sessions: [mixed] })

    await act(async () =>
      root.render(
        <HomePage canDeleteProjects hasCompleteSessionCatalog onOpenGlobalSearch={vi.fn()} />
      )
    )

    expect(
      container.querySelector('[aria-label="Open session Delegated runs, running"]')?.textContent
    ).toContain(scenario.expected)
    nowSpy.mockRestore()
  })

  it('falls back to the root start for display and ordering after an earlier child terminates', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(600_000)
    const mixed = sessionWithDelegatedRuns('running', [
      { frameId: 'child', startedAt: 300_000, status: 'running' }
    ])
    mixed.activeRun = { promptMessageId: 'root-prompt', startedAt: 540_000 }
    const comparison = session('comparison', 'Comparison run', 'running', 480_000)
    useProjectStore.setState({
      ...createInitialProjectState(),
      projects: [project],
      isLoaded: true
    })
    useSessionStore.setState({ ...createInitialSessionState(), sessions: [comparison, mixed] })

    await act(async () =>
      root.render(
        <HomePage canDeleteProjects hasCompleteSessionCatalog onOpenGlobalSearch={vi.fn()} />
      )
    )
    const labels = (): (string | null)[] =>
      Array.from(container.querySelectorAll<HTMLButtonElement>('[aria-label$=", running"]')).map(
        (card) => card.getAttribute('aria-label')
      )
    expect(labels()).toEqual([
      'Open session Comparison run, running',
      'Open session Delegated runs, running'
    ])
    expect(
      container.querySelector('[aria-label="Open session Delegated runs, running"]')?.textContent
    ).toContain('running 5m')

    const terminal = sessionWithDelegatedRuns('running', [
      { frameId: 'child', startedAt: 300_000, status: 'completed' }
    ])
    terminal.activeRun = { promptMessageId: 'root-prompt', startedAt: 540_000 }
    await act(async () => useSessionStore.setState({ sessions: [comparison, terminal] }))

    expect(labels()).toEqual([
      'Open session Delegated runs, running',
      'Open session Comparison run, running'
    ])
    expect(
      container.querySelector('[aria-label="Open session Delegated runs, running"]')?.textContent
    ).toContain('running 1m')
    nowSpy.mockRestore()
  })

  it('shows Running instead of an unread completion while any current child is running', async () => {
    const candidate = sessionWithDelegatedRuns('idle', [
      { frameId: 'child', startedAt: 500_000, status: 'running' }
    ])
    useProjectStore.setState({
      ...createInitialProjectState(),
      projects: [project],
      isLoaded: true
    })
    useSessionStore.setState({ ...createInitialSessionState(), sessions: [candidate] })
    useNotificationInboxStore.setState({
      revision: 1,
      unreadCount: 1,
      latestSequence: 1,
      status: 'ready',
      items: [
        {
          id: 'completed-while-child-running',
          sequence: 1,
          dedupeKey: 'task:completed:delegated-runs',
          kind: 'task.completed',
          projectId: project.id,
          sessionId: candidate.id,
          originId: 'root-run',
          title: candidate.title,
          summary: 'The root turn completed.',
          createdAt: 590_000
        }
      ]
    })

    await act(async () =>
      root.render(
        <HomePage canDeleteProjects hasCompleteSessionCatalog onOpenGlobalSearch={vi.fn()} />
      )
    )

    expect(
      container.querySelector('[aria-label="Open session Delegated runs, running"]')
    ).not.toBeNull()
    expect(
      container.querySelector('[aria-label="Open session Delegated runs, completed"]')
    ).toBeNull()
  })

  it.each(['queued', 'submitted', 'running'] as const)(
    'shows Running instead of an unread completion while remote compute is %s',
    async (status) => {
      const candidate = session('remote-compute', 'Remote analysis', 'idle', 590_000)
      useProjectStore.setState({
        ...createInitialProjectState(),
        projects: [project],
        isLoaded: true
      })
      useSessionStore.setState({ ...createInitialSessionState(), sessions: [candidate] })
      useSessionJobStore.getState().applyUpdate(computeJob(candidate.id, status))
      useNotificationInboxStore.setState({
        revision: 1,
        unreadCount: 1,
        latestSequence: 1,
        status: 'ready',
        items: [
          {
            id: 'completed-while-compute-active',
            sequence: 1,
            dedupeKey: 'task:completed:remote-compute',
            kind: 'task.completed',
            projectId: project.id,
            sessionId: candidate.id,
            originId: 'root-run',
            title: candidate.title,
            summary: 'The foreground turn completed.',
            createdAt: 590_000
          }
        ]
      })

      await act(async () =>
        root.render(
          <HomePage canDeleteProjects hasCompleteSessionCatalog onOpenGlobalSearch={vi.fn()} />
        )
      )

      expect(
        container.querySelector('[aria-label="Open session Remote analysis, completed"]')
      ).toBeNull()
      expect(
        container.querySelector('[aria-label="Open session Remote analysis, running"]')
      ).not.toBeNull()
    }
  )

  it('keeps inactive-branch delegated work Running until its current Attempt becomes terminal', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(600_000)
    const branchARunning = sessionWithDelegatedRuns('idle', [
      {
        frameId: 'branch-a-child',
        originMessageId: 'branch-a-prompt',
        startedAt: 300_000,
        status: 'running'
      }
    ])
    const rootFrame = branchARunning.conversationGraph?.frames.find(({ id }) => id === 'root')
    if (rootFrame) rootFrame.activeBranchId = 'branch-a-prompt-branch'
    useProjectStore.setState({
      ...createInitialProjectState(),
      projects: [project],
      isLoaded: true
    })
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [branchARunning]
    })

    await act(async () =>
      root.render(
        <HomePage canDeleteProjects hasCompleteSessionCatalog onOpenGlobalSearch={vi.fn()} />
      )
    )

    expect(
      container.querySelector('[aria-label="Open session Delegated runs, running"]')?.textContent
    ).toContain('running 5m')

    const branchBSelected = structuredClone(branchARunning)
    const selectedRoot = branchBSelected.conversationGraph?.frames.find(({ id }) => id === 'root')
    branchBSelected.conversationGraph?.branches.push({
      id: 'branch-b',
      agentFrameId: 'root',
      createdAt: 3,
      updatedAt: 3
    })
    if (selectedRoot) selectedRoot.activeBranchId = 'branch-b'
    await act(async () => useSessionStore.setState({ sessions: [branchBSelected] }))

    expect(
      container.querySelector('[aria-label="Open session Delegated runs, running"]')?.textContent
    ).toContain('running 5m')
    expect(container.querySelector('[aria-label="1 running"]')).not.toBeNull()

    const childTerminal = sessionWithDelegatedRuns('idle', [
      {
        frameId: 'branch-a-child',
        originMessageId: 'branch-a-prompt',
        startedAt: 300_000,
        status: 'completed'
      }
    ])
    const terminalRoot = childTerminal.conversationGraph?.frames.find(({ id }) => id === 'root')
    childTerminal.conversationGraph?.branches.push({
      id: 'branch-b',
      agentFrameId: 'root',
      createdAt: 3,
      updatedAt: 3
    })
    if (terminalRoot) terminalRoot.activeBranchId = 'branch-b'
    await act(async () => useSessionStore.setState({ sessions: [childTerminal] }))

    expect(container.querySelector('[aria-label$=", running"]')).toBeNull()
    expect(container.querySelector('[aria-label="1 running"]')).toBeNull()
    nowSpy.mockRestore()
  })

  it('shows an answer wait ahead of an unread completion for an idle Session', async () => {
    const now = 600_000
    useProjectStore.setState({
      ...createInitialProjectState(),
      projects: [project],
      isLoaded: true
    })
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [sessionWithPendingDelegatedQuestion('idle', now - 60_000)]
    })
    useNotificationInboxStore.setState({
      revision: 1,
      unreadCount: 1,
      latestSequence: 1,
      status: 'ready',
      items: [
        {
          id: 'completed-delegated-question',
          sequence: 1,
          dedupeKey: 'task:completed:delegated-question',
          kind: 'task.completed',
          projectId: project.id,
          sessionId: 'delegated-question',
          originId: 'delegated-question-run',
          title: 'Delegated question',
          summary: 'A task completed.',
          createdAt: now
        }
      ]
    })

    await act(async () =>
      root.render(
        <HomePage canDeleteProjects hasCompleteSessionCatalog onOpenGlobalSearch={vi.fn()} />
      )
    )

    expect(
      container.querySelector(
        '[aria-label="Open session Delegated question, waiting for your answer"]'
      )
    ).not.toBeNull()
    expect(
      container.querySelector('[aria-label="Open session Delegated question, completed"]')
    ).toBeNull()
    expect(
      container.querySelector('[aria-label^="Mark completed session Delegated question"]')
    ).toBeNull()
  })

  it('still shows the answer wait while the user previews the question source Subagent', async () => {
    const candidate = sessionWithPendingDelegatedQuestion('running', 600_000)
    if (candidate.conversationGraph) candidate.conversationGraph.activeFrameId = 'child'
    useProjectStore.setState({
      ...createInitialProjectState(),
      projects: [project],
      isLoaded: true
    })
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [candidate]
    })

    await act(async () =>
      root.render(
        <HomePage canDeleteProjects hasCompleteSessionCatalog onOpenGlobalSearch={vi.fn()} />
      )
    )

    expect(
      container.querySelector(
        '[aria-label="Open session Delegated question, waiting for your answer"]'
      )
    ).not.toBeNull()
  })

  it.each([
    {
      reason: 'the question belongs to an inactive root Branch',
      mutate: (candidate: ChatSession) => {
        const rootFrame = candidate.conversationGraph?.frames.find(({ id }) => id === 'root')
        if (rootFrame) rootFrame.activeBranchId = 'inactive-root-branch'
      }
    },
    {
      reason: 'the source route is invalid',
      mutate: (candidate: ChatSession) => {
        const request = candidate.runtimeContext?.delegatedWork?.questionRequests?.[0]
        if (request) Object.assign(request, { sourceName: 'Unexpected source' })
      }
    },
    {
      reason: 'the question owner is quarantined',
      mutate: (candidate: ChatSession) => {
        const owner = candidate.runtimeContext?.delegatedWork
        if (owner) {
          Object.assign(owner, {
            questionRequestsQuarantine: { reason: 'corrupt question owner' }
          })
        }
      }
    }
  ])('does not show an answer wait when $reason', async ({ mutate }) => {
    const candidate = sessionWithPendingDelegatedQuestion('running', 600_000)
    mutate(candidate)
    useProjectStore.setState({
      ...createInitialProjectState(),
      projects: [project],
      isLoaded: true
    })
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [candidate]
    })

    await act(async () =>
      root.render(
        <HomePage canDeleteProjects hasCompleteSessionCatalog onOpenGlobalSearch={vi.fn()} />
      )
    )

    expect(
      container.querySelector('[aria-label="Open session Delegated question, running"]')
    ).not.toBeNull()
    expect(
      container.querySelector(
        '[aria-label="Open session Delegated question, waiting for your answer"]'
      )
    ).toBeNull()
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
      container.querySelector('[aria-label="Open session Live analysis, waiting for permission"]')
    ).not.toBeNull()
  })

  it('omits an empty Session description from update cards', async () => {
    useProjectStore.setState({
      ...createInitialProjectState(),
      projects: [project],
      isLoaded: true
    })
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [{ ...session('empty', 'Empty description', 'running', 600_000), description: '' }]
    })

    await act(async () =>
      root.render(
        <HomePage canDeleteProjects hasCompleteSessionCatalog onOpenGlobalSearch={vi.fn()} />
      )
    )

    const card = container.querySelector('[aria-label="Open session Empty description, running"]')
    expect(card?.querySelector('[data-testid="session-description-preview"]')).toBeNull()
  })

  it('shows a short Session description in its update card', async () => {
    useProjectStore.setState({
      ...createInitialProjectState(),
      projects: [project],
      isLoaded: true
    })
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [
        {
          ...session('short', 'Short description', 'running', 600_000),
          description: 'Compare the two study cohorts.'
        }
      ]
    })

    await act(async () =>
      root.render(
        <HomePage canDeleteProjects hasCompleteSessionCatalog onOpenGlobalSearch={vi.fn()} />
      )
    )

    const preview = container.querySelector('[data-testid="session-description-preview"]')
    expect(preview?.textContent).toBe('Compare the two study cohorts.')
  })

  it('clamps a long Session description to two lines and exposes the full text on focus', async () => {
    const description =
      'Compare the longitudinal outcomes across both study cohorts while preserving every relevant qualification from the generated Session metadata.'
    useProjectStore.setState({
      ...createInitialProjectState(),
      projects: [project],
      isLoaded: true
    })
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [{ ...session('long', 'Long description', 'running', 600_000), description }]
    })

    await act(async () =>
      root.render(
        <HomePage canDeleteProjects hasCompleteSessionCatalog onOpenGlobalSearch={vi.fn()} />
      )
    )

    const card = container.querySelector<HTMLButtonElement>(
      '[aria-label="Open session Long description, running"]'
    )
    const preview = card?.querySelector('[data-testid="session-description-preview"]')
    expect(card?.tagName).toBe('BUTTON')
    expect(preview?.classList.contains('line-clamp-2')).toBe(true)
    expect(preview?.textContent).toBe(description)

    await act(async () => card?.focus())
    const tooltip = document.body.querySelector<HTMLElement>('[role="tooltip"]')
    expect(tooltip?.textContent).toBe(description)
  })

  it('keeps a timed-out Plan approval visible with its exact wait reason', async () => {
    useProjectStore.setState({
      ...createInitialProjectState(),
      projects: [project],
      isLoaded: true
    })
    useSessionStore.getState().appendUserMessage({
      sessionId: 'plan-session',
      projectId: project.id,
      cwd: '/workspace/project-1',
      content: 'Create a research plan'
    })
    useSessionStore.getState().setActivePlanProjection('plan-session', pendingPlan)
    useSessionStore.getState().finishRun('plan-session')

    await act(async () =>
      root.render(
        <HomePage canDeleteProjects hasCompleteSessionCatalog onOpenGlobalSearch={vi.fn()} />
      )
    )

    expect(
      container.querySelector(
        '[aria-label="Open session Create a research plan, waiting for plan approval"]'
      )
    ).not.toBeNull()
    expect(container.querySelector('[aria-label="1 waiting on you"]')).not.toBeNull()
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

  it('offers a Retry action when loading Projects fails', async () => {
    const loadProjects = vi.fn().mockResolvedValue(undefined)
    useProjectStore.setState({
      ...createInitialProjectState(),
      isLoaded: true,
      loadError: 'database is locked',
      loadProjects
    })

    await act(async () =>
      root.render(
        <HomePage canDeleteProjects hasCompleteSessionCatalog onOpenGlobalSearch={vi.fn()} />
      )
    )

    const retry = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent === 'Retry'
    )
    expect(retry).toBeDefined()
    expect(container.querySelector('[role="alert"] p')?.textContent).toBe(
      'Open Science could not load projects. Retry to continue.'
    )
    expect(container.textContent).not.toContain('database is locked')

    await act(async () => retry?.click())
    expect(loadProjects).toHaveBeenCalledOnce()
  })
})
