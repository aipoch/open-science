import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  SESSION_MANIFEST_VERSION,
  type PersistedChatSession
} from '../../../shared/session-persistence'
import type { Project } from '../../../shared/projects'
import { recordLastOpenedProject } from '@/lib/last-opened-project'
import { createInitialProjectState, useProjectStore } from './project-store'
import { createInitialSessionState, useSessionStore } from './session-store'
import { useNavigationStore, type PdfReadingDocument } from './navigation-store'
import { previewLeaveGuards, workbenchPreviewGuardScope } from './preview-leave-guard'
import {
  createInitialPreviewWorkbenchState,
  pendingPdfContextSelections,
  usePreviewWorkbenchStore,
  type PreviewFileItem
} from './preview-workbench-store'

vi.mock('@/lib/last-opened-project', () => ({
  recordLastOpenedProject: vi.fn(),
  getLastOpenedProjectId: vi.fn(() => undefined),
  resolveCustomizeProjectId: vi.fn(() => undefined)
}))

const createSession = (overrides: Partial<PersistedChatSession>): PersistedChatSession => ({
  id: 'session-1',
  projectId: 'project-a',
  title: 'Session',
  cwd: '/workspace',
  status: 'idle',
  messages: [],
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

const createProject = (id: string): Project => ({
  id,
  name: id,
  description: '',
  isExample: false,
  createdAt: 1,
  updatedAt: 1
})

beforeEach(() => {
  previewLeaveGuards.clear()
  usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
  useProjectStore.setState({
    ...createInitialProjectState(),
    projects: [
      createProject('project-a'),
      createProject('project-b'),
      createProject('project-empty')
    ],
    isLoaded: true
  })
  useSessionStore.setState(createInitialSessionState())
  useNavigationStore.setState({
    view: 'home',
    activeProjectId: undefined,
    userNavigationRevision: 0,
    explicitNavigationRevision: 0,
    pendingCustomizePrefill: undefined,
    pendingLiteratureReviewPrefill: undefined,
    pendingProjectCreation: false,
    pendingArtifactMention: undefined,
    pendingLiteratureItemId: undefined,
    pendingLiteratureProjectId: undefined,
    pendingLiteratureCollectionId: undefined,
    artifactMentionAvailability: undefined
  })
  vi.mocked(recordLastOpenedProject).mockClear()
})

describe('navigation store', () => {
  it('does not mutate navigation or Session selection when a dirty preview refuses project leave', () => {
    useSessionStore
      .getState()
      .hydrateSessions(
        [
          createSession({ id: 'a', projectId: 'project-a' }),
          createSession({ id: 'b', projectId: 'project-b', updatedAt: 2 })
        ],
        { version: SESSION_MANIFEST_VERSION }
      )
    useSessionStore.getState().selectSession('a')
    useNavigationStore.setState({ view: 'workspace', activeProjectId: 'project-a' })
    usePreviewWorkbenchStore.setState({
      activeProjectId: 'project-a',
      activeItemId: 'file-1'
    })
    previewLeaveGuards.register(workbenchPreviewGuardScope('project-a', 'file-1')!, () => false)

    const opened = useNavigationStore.getState().openProject('project-b', 'user')

    expect(opened).toBe(false)
    expect(useNavigationStore.getState()).toMatchObject({
      view: 'workspace',
      activeProjectId: 'project-a',
      userNavigationRevision: 0
    })
    expect(useSessionStore.getState().selectedSessionId).toBe('a')
    expect(recordLastOpenedProject).not.toHaveBeenCalled()
  })

  it('confirms a cross-project leave once and commits navigation and preview scope atomically', () => {
    useSessionStore
      .getState()
      .hydrateSessions(
        [
          createSession({ id: 'a', projectId: 'project-a' }),
          createSession({ id: 'b', projectId: 'project-b', updatedAt: 2 })
        ],
        { version: SESSION_MANIFEST_VERSION }
      )
    useNavigationStore.setState({ view: 'workspace', activeProjectId: 'project-a' })
    usePreviewWorkbenchStore.setState({ activeProjectId: 'project-a', activeItemId: 'file-1' })
    const guard = vi.fn(() => true)
    previewLeaveGuards.register(workbenchPreviewGuardScope('project-a', 'file-1')!, guard)

    const opened = useNavigationStore.getState().openProject('project-b', 'user')

    expect(opened).toBe(true)
    expect(guard).toHaveBeenCalledOnce()
    expect(useNavigationStore.getState().activeProjectId).toBe('project-b')
    expect(usePreviewWorkbenchStore.getState().activeProjectId).toBe('project-b')
    expect(useSessionStore.getState().selectedSessionId).toBe('b')
  })

  it('runs a project continuation after deferred preview confirmation resumes navigation', () => {
    useSessionStore
      .getState()
      .hydrateSessions(
        [
          createSession({ id: 'a', projectId: 'project-a' }),
          createSession({ id: 'b', projectId: 'project-b', updatedAt: 2 })
        ],
        { version: SESSION_MANIFEST_VERSION }
      )
    useNavigationStore.setState({ view: 'workspace', activeProjectId: 'project-a' })
    usePreviewWorkbenchStore.setState({ activeProjectId: 'project-a', activeItemId: 'file-1' })
    let resumeNavigation: (() => boolean | void) | undefined
    previewLeaveGuards.register(workbenchPreviewGuardScope('project-a', 'file-1')!, (action) => {
      resumeNavigation = action
      return false
    })
    const afterNavigate = vi.fn()

    const opened = useNavigationStore.getState().openProject('project-b', 'user', afterNavigate)

    expect(opened).toBe(false)
    expect(afterNavigate).not.toHaveBeenCalled()
    resumeNavigation?.()
    expect(useNavigationStore.getState().activeProjectId).toBe('project-b')
    expect(afterNavigate).toHaveBeenCalledOnce()
  })

  it('drops a deferred continuation when its destination disappears before confirmation', () => {
    useSessionStore
      .getState()
      .hydrateSessions([createSession({ id: 'b', projectId: 'project-b' })], {
        version: SESSION_MANIFEST_VERSION
      })
    useNavigationStore.setState({ view: 'workspace', activeProjectId: 'project-a' })
    usePreviewWorkbenchStore.setState({ activeProjectId: 'project-a', activeItemId: 'file-1' })
    let resumeNavigation: (() => boolean | void) | undefined
    previewLeaveGuards.register(workbenchPreviewGuardScope('project-a', 'file-1')!, (action) => {
      resumeNavigation = action
      return false
    })
    const afterNavigate = vi.fn()

    useNavigationStore.getState().openSession('project-b', 'b', 'user', afterNavigate)
    useSessionStore.setState({ sessions: [] })
    resumeNavigation?.()

    expect(useNavigationStore.getState().activeProjectId).toBe('project-a')
    expect(afterNavigate).not.toHaveBeenCalled()
  })

  it.each([
    ['missing', 'project-missing'],
    ['archived', 'project-archived']
  ] as const)(
    'rejects a %s Project destination without changing navigation',
    (_kind, projectId) => {
      useProjectStore.setState({
        projects: [
          createProject('project-a'),
          { ...createProject('project-archived'), archivedAt: 2 }
        ]
      })
      useSessionStore.getState().hydrateSessions([createSession({ id: 'a' })], {
        version: SESSION_MANIFEST_VERSION
      })
      useSessionStore.getState().selectSession('a')
      useNavigationStore.setState({ view: 'workspace', activeProjectId: 'project-a' })

      const opened = useNavigationStore.getState().openProject(projectId, 'notification')

      expect(opened).toBe(false)
      expect(useNavigationStore.getState()).toMatchObject({
        view: 'workspace',
        activeProjectId: 'project-a'
      })
      expect(useSessionStore.getState().selectedSessionId).toBe('a')
    }
  )

  it('atomically switches preview scope when opening a session in another project', () => {
    useSessionStore
      .getState()
      .hydrateSessions([createSession({ id: 'b', projectId: 'project-b', updatedAt: 2 })], {
        version: SESSION_MANIFEST_VERSION
      })
    useNavigationStore.setState({ view: 'workspace', activeProjectId: 'project-a' })
    usePreviewWorkbenchStore.setState({ activeProjectId: 'project-a', activeItemId: 'file-1' })
    const guard = vi.fn(() => true)
    previewLeaveGuards.register(workbenchPreviewGuardScope('project-a', 'file-1')!, guard)

    useNavigationStore.getState().openSession('project-b', 'b', 'user')

    expect(guard).toHaveBeenCalledOnce()
    expect(useNavigationStore.getState().activeProjectId).toBe('project-b')
    expect(usePreviewWorkbenchStore.getState().activeProjectId).toBe('project-b')
    expect(useSessionStore.getState().selectedSessionId).toBe('b')
  })

  it('keeps the workspace visible when its dirty preview refuses a home navigation', () => {
    useNavigationStore.setState({ view: 'workspace', activeProjectId: 'project-a' })
    usePreviewWorkbenchStore.setState({
      activeProjectId: 'project-a',
      activeItemId: 'file-1'
    })
    previewLeaveGuards.register(workbenchPreviewGuardScope('project-a', 'file-1')!, () => false)

    useNavigationStore.getState().goHome('user')
    useNavigationStore.getState().requestProjectCreation()

    expect(useNavigationStore.getState()).toMatchObject({
      view: 'workspace',
      activeProjectId: 'project-a',
      pendingProjectCreation: false
    })
  })
  it('opens a project and selects its most recent session', () => {
    useSessionStore
      .getState()
      .hydrateSessions(
        [
          createSession({ id: 'old', projectId: 'project-a', updatedAt: 10 }),
          createSession({ id: 'recent', projectId: 'project-a', updatedAt: 99 }),
          createSession({ id: 'other', projectId: 'project-b', updatedAt: 200 })
        ],
        { version: SESSION_MANIFEST_VERSION }
      )

    useNavigationStore.getState().openProject('project-a', 'user')

    expect(useNavigationStore.getState().view).toBe('workspace')
    expect(useNavigationStore.getState().activeProjectId).toBe('project-a')
    // The most recent session within the project (not the globally newest) is selected.
    expect(useSessionStore.getState().selectedSessionId).toBe('recent')
  })

  it('clears selection when opening a project with no sessions', () => {
    useSessionStore
      .getState()
      .hydrateSessions([createSession({ id: 'a', projectId: 'project-a' })], {
        version: SESSION_MANIFEST_VERSION
      })

    useNavigationStore.getState().openProject('project-empty', 'user')

    expect(useNavigationStore.getState().activeProjectId).toBe('project-empty')
    expect(useSessionStore.getState().selectedSessionId).toBeUndefined()
  })

  it('opens a specific session inside its project', () => {
    useSessionStore
      .getState()
      .hydrateSessions(
        [
          createSession({ id: 'a', projectId: 'project-a', updatedAt: 99 }),
          createSession({ id: 'b', projectId: 'project-b', updatedAt: 1 })
        ],
        { version: SESSION_MANIFEST_VERSION }
      )

    useNavigationStore.getState().openSession('project-b', 'b', 'user')

    expect(useNavigationStore.getState().view).toBe('workspace')
    expect(useNavigationStore.getState().activeProjectId).toBe('project-b')
    expect(useSessionStore.getState().selectedSessionId).toBe('b')
  })

  it('rejects archived or mismatched Session destinations', () => {
    useSessionStore
      .getState()
      .hydrateSessions(
        [
          createSession({ id: 'active', projectId: 'project-a' }),
          createSession({ id: 'archived', projectId: 'project-a', archivedAt: 2 })
        ],
        { version: SESSION_MANIFEST_VERSION }
      )
    useSessionStore.getState().clearSelection()

    useNavigationStore.getState().openSession('project-a', 'archived', 'user')
    useNavigationStore.getState().openSession('project-b', 'active', 'user')
    useProjectStore.setState({ projects: [{ ...createProject('project-a'), archivedAt: 2 }] })
    useNavigationStore.getState().openSession('project-a', 'active', 'user')

    expect(useNavigationStore.getState().view).toBe('home')
    expect(useSessionStore.getState().selectedSessionId).toBeUndefined()
    expect(recordLastOpenedProject).not.toHaveBeenCalled()
  })

  it('opens a session by id alone (desktop-notification click)', () => {
    useSessionStore
      .getState()
      .hydrateSessions([createSession({ id: 'a', projectId: 'project-a' })], {
        version: SESSION_MANIFEST_VERSION
      })

    const opened = useNavigationStore.getState().openSessionById('a', 'notification')

    expect(opened).toBe(true)
    expect(useNavigationStore.getState().view).toBe('workspace')
    expect(useNavigationStore.getState().activeProjectId).toBe('project-a')
    expect(useSessionStore.getState().selectedSessionId).toBe('a')
  })

  it('runs a session-by-id continuation after deferred preview confirmation', () => {
    useSessionStore
      .getState()
      .hydrateSessions([createSession({ id: 'b', projectId: 'project-b' })], {
        version: SESSION_MANIFEST_VERSION
      })
    useNavigationStore.setState({ view: 'workspace', activeProjectId: 'project-a' })
    usePreviewWorkbenchStore.setState({ activeProjectId: 'project-a', activeItemId: 'file-1' })
    let resumeNavigation: (() => boolean | void) | undefined
    previewLeaveGuards.register(workbenchPreviewGuardScope('project-a', 'file-1')!, (action) => {
      resumeNavigation = action
      return false
    })
    const afterNavigate = vi.fn()

    const opened = useNavigationStore.getState().openSessionById('b', 'notification', afterNavigate)

    expect(opened).toBe(false)
    expect(afterNavigate).not.toHaveBeenCalled()
    resumeNavigation?.()
    expect(useNavigationStore.getState().activeProjectId).toBe('project-b')
    expect(afterNavigate).toHaveBeenCalledOnce()
  })

  it('stays put when a notification names a session that no longer exists', () => {
    const opened = useNavigationStore.getState().openSessionById('gone', 'notification')

    expect(opened).toBe(false)
    expect(useNavigationStore.getState().view).toBe('home')
    expect(useNavigationStore.getState().activeProjectId).toBeUndefined()
    expect(useSessionStore.getState().selectedSessionId).toBeUndefined()
  })

  it('returns to the home screen without losing session state', () => {
    useSessionStore
      .getState()
      .hydrateSessions([createSession({})], { version: SESSION_MANIFEST_VERSION })
    useNavigationStore.getState().openSession('project-a', 'session-1', 'user')
    useNavigationStore.getState().goHome('user')

    expect(useNavigationStore.getState().view).toBe('home')
    expect(useNavigationStore.getState().activeProjectId).toBeUndefined()
    expect(useSessionStore.getState().selectedSessionId).toBe('session-1')
  })

  it('opens the user-level Literature Library without changing the active project', () => {
    useNavigationStore.setState({
      activeProjectId: 'project-a',
      pendingLiteratureProjectId: 'project-b'
    })

    useNavigationStore.getState().openLibrary('user')

    expect(useNavigationStore.getState().view).toBe('library')
    expect(useNavigationStore.getState().activeProjectId).toBe('project-a')
    expect(useNavigationStore.getState().pendingLiteratureProjectId).toBeUndefined()
    expect(useNavigationStore.getState().userNavigationRevision).toBe(1)
  })

  it('routes a Project Literature view through a one-shot explicit scope', () => {
    useNavigationStore.setState({ view: 'workspace', activeProjectId: 'project-a' })

    const opened = useNavigationStore.getState().openProjectLiterature('project-a', 'user')

    expect(opened).toBe(true)
    expect(useNavigationStore.getState()).toMatchObject({
      view: 'library',
      activeProjectId: 'project-a',
      pendingLiteratureProjectId: 'project-a',
      userNavigationRevision: 1
    })
    expect(useNavigationStore.getState().consumeLiteratureProject()).toBe('project-a')
    expect(useNavigationStore.getState().consumeLiteratureProject()).toBeUndefined()
  })

  it('routes a Collection Literature view through a one-shot explicit scope', () => {
    useNavigationStore.setState({ view: 'workspace', activeProjectId: 'project-a' })

    const opened = useNavigationStore.getState().openCollectionLiterature('collection-1', 'user')

    expect(opened).toBe(true)
    expect(useNavigationStore.getState()).toMatchObject({
      view: 'library',
      activeProjectId: 'project-a',
      pendingLiteratureCollectionId: 'collection-1',
      userNavigationRevision: 1
    })
    expect(useNavigationStore.getState().consumeLiteratureCollection()).toBe('collection-1')
    expect(useNavigationStore.getState().consumeLiteratureCollection()).toBeUndefined()
  })

  it('routes to one Literature Item through a one-shot Library intent', () => {
    useNavigationStore.getState().openLiteratureItem('item-1', 'user')

    expect(useNavigationStore.getState()).toMatchObject({
      view: 'library',
      pendingLiteratureItemId: 'item-1',
      userNavigationRevision: 1
    })
    expect(useNavigationStore.getState().consumeLiteratureItem()).toBe('item-1')
    expect(useNavigationStore.getState().consumeLiteratureItem()).toBeUndefined()
  })

  it('routes a New Project request home as a one-shot intent', () => {
    useNavigationStore.getState().openProject('project-a', 'automatic')

    useNavigationStore.getState().requestProjectCreation()

    expect(useNavigationStore.getState()).toMatchObject({
      view: 'home',
      pendingProjectCreation: true
    })
    useNavigationStore.getState().consumeProjectCreation()
    expect(useNavigationStore.getState().pendingProjectCreation).toBe(false)
  })

  it('advances user navigation revision only for explicit user actions', () => {
    useNavigationStore.getState().goHome('automatic')
    expect(useNavigationStore.getState().userNavigationRevision).toBe(0)
    expect(useNavigationStore.getState().explicitNavigationRevision).toBe(0)

    useNavigationStore.getState().goHome('notification')
    expect(useNavigationStore.getState().userNavigationRevision).toBe(0)
    expect(useNavigationStore.getState().explicitNavigationRevision).toBe(1)

    useNavigationStore.getState().goHome('user')
    expect(useNavigationStore.getState().userNavigationRevision).toBe(1)
    expect(useNavigationStore.getState().explicitNavigationRevision).toBe(2)

    useNavigationStore.getState().recordUserNavigation()
    expect(useNavigationStore.getState().userNavigationRevision).toBe(2)
    expect(useNavigationStore.getState().explicitNavigationRevision).toBe(3)
  })

  it('records the last-opened project only for explicit user project opens', () => {
    useNavigationStore.getState().openProject('project-a', 'user')
    expect(recordLastOpenedProject).toHaveBeenCalledWith('project-a')

    vi.mocked(recordLastOpenedProject).mockClear()
    useNavigationStore.getState().openProject('project-b', 'automatic')
    expect(recordLastOpenedProject).not.toHaveBeenCalled()
  })

  it('records the last-opened project when a user opens a session', () => {
    useSessionStore.getState().hydrateSessions([createSession({})], {
      version: SESSION_MANIFEST_VERSION
    })
    useNavigationStore.getState().openSession('project-a', 'session-1', 'user')
    expect(recordLastOpenedProject).toHaveBeenCalledWith('project-a')
  })
})

describe('navigation store customize conversation', () => {
  it('starts a customize conversation: opens the project, clears selection, and sets a prefill intent', () => {
    useNavigationStore.getState().startCustomizeConversation('project-a')

    const state = useNavigationStore.getState()
    expect(state.view).toBe('workspace')
    expect(state.activeProjectId).toBe('project-a')
    // New conversation draft: no session selected, so no Specialist binding.
    expect(useSessionStore.getState().selectedSessionId).toBeUndefined()
    expect(state.pendingCustomizePrefill).toEqual({
      projectId: 'project-a',
      goal: 'specialist',
      requestId: 1
    })
  })

  it('records the customize target as the last-opened project', () => {
    useNavigationStore.getState().startCustomizeConversation('project-a')
    expect(recordLastOpenedProject).toHaveBeenCalledWith('project-a')
  })

  it('counts the customize entry as explicit user navigation', () => {
    useNavigationStore.getState().startCustomizeConversation('project-a')
    expect(useNavigationStore.getState().userNavigationRevision).toBe(1)
  })

  it('does not start customization for an archived project', () => {
    useProjectStore.setState({ projects: [{ ...createProject('project-a'), archivedAt: 2 }] })

    useNavigationStore.getState().startCustomizeConversation('project-a')

    expect(useNavigationStore.getState()).toMatchObject({
      view: 'home',
      activeProjectId: undefined,
      pendingCustomizePrefill: undefined
    })
    expect(recordLastOpenedProject).not.toHaveBeenCalled()
  })

  it('clears the pending prefill intent once consumed', () => {
    useNavigationStore.getState().startCustomizeConversation('project-a')
    expect(useNavigationStore.getState().pendingCustomizePrefill).toMatchObject({
      projectId: 'project-a',
      goal: 'specialist'
    })

    useNavigationStore.getState().consumeCustomizePrefill()
    expect(useNavigationStore.getState().pendingCustomizePrefill).toBeUndefined()
  })

  it('carries a Skill goal as a distinct one-shot Customize intent', () => {
    useNavigationStore.getState().startCustomizeConversation('project-a', 'skill')
    expect(useNavigationStore.getState().pendingCustomizePrefill).toEqual({
      projectId: 'project-a',
      goal: 'skill',
      requestId: 1
    })
  })
})

describe('navigation store PDF reading conversation', () => {
  it('stages three distinct PDFs together, activates the first, and refuses a fourth before navigating', () => {
    const documents: PdfReadingDocument[] = [1, 2, 3, 4].map((id) => ({
      item: {
        id: `literature:version-${id}`,
        sessionId: 'literature-library',
        title: `paper-${id}.pdf`,
        name: `paper-${id}.pdf`,
        type: 'file',
        source: 'literature',
        path: `literature-attachment-version:version-${id}`,
        format: 'pdf',
        mimeType: 'application/pdf',
        size: 100
      },
      source: { sourceKind: 'literature-attachment-version', sourceVersionId: `version-${id}` }
    }))
    expect(useNavigationStore.getState().startPdfReadingConversations('project-a', documents)).toBe(
      false
    )
    expect(usePreviewWorkbenchStore.getState().items).toEqual([])
    expect(recordLastOpenedProject).not.toHaveBeenCalled()
    expect(
      useNavigationStore
        .getState()
        .startPdfReadingConversations('project-a', [documents[0], ...documents.slice(0, 3)])
    ).toBe(true)
    const preview = usePreviewWorkbenchStore.getState()
    expect(preview.activeItemId).toBe(documents[0].item.id)
    expect(preview.items).toHaveLength(3)
    expect(
      pendingPdfContextSelections(preview.pendingPdfContextByProject['project-a'])
    ).toHaveLength(3)
    expect(useSessionStore.getState().selectedSessionId).toBeUndefined()
  })
  it('opens a New Conversation draft with the Library PDF previewed and pending as Reading', () => {
    const item: PreviewFileItem = {
      id: 'literature:version-1',
      sessionId: 'literature-library',
      title: 'paper.pdf',
      type: 'file',
      source: 'literature',
      path: 'literature-attachment-version:version-1',
      format: 'pdf',
      name: 'paper.pdf',
      mimeType: 'application/pdf',
      size: 100,
      versionNumber: 1
    }

    const opened = useNavigationStore.getState().startPdfReadingConversation('project-a', item, {
      sourceKind: 'literature-attachment-version',
      sourceVersionId: 'version-1'
    })

    expect(opened).toBe(true)
    expect(useNavigationStore.getState()).toMatchObject({
      view: 'workspace',
      activeProjectId: 'project-a'
    })
    expect(useSessionStore.getState().selectedSessionId).toBeUndefined()
    expect(recordLastOpenedProject).toHaveBeenCalledWith('project-a')
    expect(usePreviewWorkbenchStore.getState()).toMatchObject({
      activeProjectId: 'project-a',
      activeItemId: item.id,
      panelState: 'open',
      pendingPdfContextByProject: {
        'project-a': {
          kind: 'version',
          sourceKind: 'literature-attachment-version',
          sourceVersionId: 'version-1',
          previewItemId: item.id
        }
      }
    })
    expect(usePreviewWorkbenchStore.getState().items).toContainEqual(
      expect.objectContaining({
        ...item,
        projectId: 'project-a'
      })
    )
  })

  it('does not start Reading for an archived project', () => {
    useProjectStore.setState({ projects: [{ ...createProject('project-a'), archivedAt: 2 }] })

    const opened = useNavigationStore.getState().startPdfReadingConversation(
      'project-a',
      {
        id: 'literature:version-1',
        sessionId: 'literature-library',
        title: 'paper.pdf',
        type: 'file',
        source: 'literature',
        path: 'literature-attachment-version:version-1',
        format: 'pdf',
        name: 'paper.pdf',
        mimeType: 'application/pdf',
        size: 100,
        versionNumber: 1
      },
      {
        sourceKind: 'literature-attachment-version',
        sourceVersionId: 'version-1'
      }
    )

    expect(opened).toBe(false)
    expect(useNavigationStore.getState()).toMatchObject({
      view: 'home',
      activeProjectId: undefined
    })
    expect(usePreviewWorkbenchStore.getState().items).toEqual([])
    expect(recordLastOpenedProject).not.toHaveBeenCalled()
  })
})

describe('navigation store Literature review conversation', () => {
  it('opens an editable New Conversation with the selected Literature scope', () => {
    useSessionStore.getState().hydrateSessions([createSession({})], {
      version: SESSION_MANIFEST_VERSION
    })
    useSessionStore.getState().selectSession('session-1')

    const opened = useNavigationStore
      .getState()
      .startLiteratureReviewConversation(
        'project-a',
        { type: 'literature-scope', scope: 'project' },
        'Synthesize this literature into a concise review.'
      )

    expect(opened).toBe(true)
    expect(useNavigationStore.getState()).toMatchObject({
      view: 'workspace',
      activeProjectId: 'project-a',
      pendingLiteratureReviewPrefill: {
        projectId: 'project-a',
        scope: { type: 'literature-scope', scope: 'project' },
        prompt: 'Synthesize this literature into a concise review.',
        requestId: 1
      }
    })
    expect(useSessionStore.getState().selectedSessionId).toBeUndefined()
    expect(recordLastOpenedProject).toHaveBeenCalledWith('project-a')

    useNavigationStore.getState().consumeLiteratureReviewPrefill()
    expect(useNavigationStore.getState().pendingLiteratureReviewPrefill).toBeUndefined()
  })
})

describe('navigation store global Artifact actions', () => {
  it('accepts an Artifact mention only for the active workspace project and clears it after consumption', () => {
    useNavigationStore.getState().openProject('project-a', 'user')
    const file = {
      id: 'artifact-1',
      source: 'artifact' as const,
      sourceFileId: 'artifact-1',
      sourceVersionId: 'version-1',
      projectId: 'project-a',
      sessionId: 'session-1',
      name: 'sin.png',
      path: 'artifact-version:project-a/session-1/artifact-1/version-1',
      size: 12,
      sortAtMs: 1
    }

    useNavigationStore.getState().requestArtifactMention(file)
    expect(useNavigationStore.getState().pendingArtifactMention).toMatchObject(file)

    expect(useNavigationStore.getState().consumeArtifactMention()).toMatchObject(file)
    expect(useNavigationStore.getState().pendingArtifactMention).toBeUndefined()

    useNavigationStore.getState().requestArtifactMention({ ...file, projectId: 'project-b' })
    expect(useNavigationStore.getState().pendingArtifactMention).toBeUndefined()
  })
})
