// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatSession } from '@/stores/session-store'
import type { SessionDiscussionCapture } from './replay/replay-context'
import { useResearchWorkspaceStore } from '@/stores/research-workspace-store'
import { researchDraftKey } from './research-draft-identity'
import { readResearchProjectDestination } from '@/lib/research-project-entry'
import {
  openResearchDiscussion,
  openResearchWorkspace,
  stageSessionDiscussion
} from './workspace-discussion-navigation'

const mocks = vi.hoisted(() => ({
  find: vi.fn(),
  context: vi.fn(),
  openSession: vi.fn(),
  openProject: vi.fn(),
  clearSelection: vi.fn(),
  ask: vi.fn(),
  preview: vi.fn(),
  expand: vi.fn(),
  navigation: {
    activeProjectId: 'source-project' as string | undefined,
    explicitNavigationRevision: 1
  },
  selectedSessionId: 'source' as string | undefined,
  sessions: [] as ChatSession[],
  projects: [] as Array<{ id: string; archivedAt?: number }>,
  draft: undefined as { projectId: string; sourceSessionId: string; draftKey: string } | undefined
}))
vi.mock('@/stores/navigation-store', () => ({
  useNavigationStore: {
    getState: () => ({
      ...mocks.navigation,
      openSession: mocks.openSession,
      openProject: mocks.openProject
    })
  }
}))
vi.mock('@/stores/project-store', () => ({
  useProjectStore: { getState: () => ({ projects: mocks.projects }) }
}))
vi.mock('@/stores/session-store', () => ({
  useSessionStore: {
    getState: () => ({
      selectedSessionId: mocks.selectedSessionId,
      sessions: mocks.sessions,
      clearSelection: mocks.clearSelection,
      selectSession: (sessionId: string) => {
        mocks.selectedSessionId = sessionId
      }
    })
  }
}))
vi.mock('@/stores/session-replay-store', () => ({
  useSessionReplayStore: {
    getState: () => ({ ask: mocks.ask, draftDiscussion: mocks.draft })
  }
}))
vi.mock('@/stores/preview-workbench-store', () => ({
  usePreviewWorkbenchStore: {
    getState: () => ({
      activeProjectId: mocks.navigation.activeProjectId,
      items: [],
      upsertAndActivateItem: mocks.preview,
      setToolItemExpanded: mocks.expand
    })
  }
}))
vi.mock('./workspace-session-actions', () => ({
  loadSessionDiscussionContext: mocks.context,
  createSessionReplayItem: (
    projectId: string,
    sourceSessionId: string,
    sourceTitle: string,
    workspaceProjectId: string
  ) => ({
    id: `replay:${sourceSessionId}`,
    projectId,
    sourceSessionId,
    sourceTitle,
    workspaceProjectId
  })
}))

const capture: SessionDiscussionCapture = {
  projectId: 'source-project',
  sourceSessionId: 'source',
  sourceTitle: 'Original research',
  scope: 'step',
  fingerprint: 'source-version',
  branchId: 'source-branch',
  stepId: 'step-28',
  stepOffsetMs: 40,
  evidence: [],
  excerpt: 'Selected observation'
}
const sourceMembership = {
  sourceProjectId: 'source-project',
  sourceSessionId: 'source',
  sourceImportId: 'import',
  sourceTitle: 'Original research'
}
const sourceSession = (): ChatSession => ({
  id: 'source',
  projectId: 'source-project',
  title: 'Original research',
  cwd: '',
  status: 'idle',
  messages: [],
  createdAt: 1,
  updatedAt: 1,
  packageOrigin: {
    importId: 'import',
    sourceProjectId: 'foreign',
    sourceSessionId: 'foreign-source',
    importedAt: 1,
    manifestChecksum: 'a'.repeat(64)
  }
})
const receiver = (id = 'discussion', projectId = 'source-project'): ChatSession => ({
  id,
  projectId,
  title: 'Research questions',
  researchMembership: sourceMembership,
  status: 'idle',
  cwd: '/project',
  messages: [],
  createdAt: 1,
  updatedAt: 1,
  runtimeContext: {
    version: 1,
    revision: 2,
    sessionContext: {
      version: 1,
      bindings: [
        {
          projectId: capture.projectId,
          sessionId: capture.sourceSessionId,
          title: capture.sourceTitle,
          contextId: 'previous-question',
          branchId: capture.branchId,
          promptMessageId: 'previous-prompt'
        }
      ]
    }
  }
})
const navigate = (
  projectId: string,
  sessionId: string | undefined,
  callback?: () => void
): boolean => {
  mocks.navigation = {
    activeProjectId: projectId,
    explicitNavigationRevision: mocks.navigation.explicitNavigationRevision + 1
  }
  mocks.selectedSessionId = sessionId
  callback?.()
  return true
}
const deferredLookup = (): ((result: { sessionId: string } | null) => void) => {
  let finish!: (result: { sessionId: string } | null) => void
  mocks.find.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve
    })
  )
  return (result) => finish(result)
}
const expectNoHandoff = (): void => {
  expect(mocks.ask).not.toHaveBeenCalled()
  expect(mocks.preview).not.toHaveBeenCalled()
  expect(mocks.clearSelection).not.toHaveBeenCalled()
}

beforeEach(() => {
  localStorage.clear()
  vi.resetAllMocks()
  mocks.navigation = { activeProjectId: 'source-project', explicitNavigationRevision: 1 }
  mocks.selectedSessionId = 'source'
  mocks.sessions = [receiver(), sourceSession()]
  mocks.projects = [{ id: 'source-project' }, { id: 'other-project' }]
  mocks.draft = undefined
  useResearchWorkspaceStore.setState({ draftResearchByProject: {}, lastDiscussionByResearch: {} })
  mocks.context.mockResolvedValue({ ...capture, scope: 'session' })
  mocks.find.mockResolvedValue(null)
  mocks.openSession.mockImplementation((projectId, sessionId, _origin, callback, canNavigate) =>
    canNavigate?.() === false ? false : navigate(projectId, sessionId, callback)
  )
  mocks.openProject.mockImplementation((projectId, _origin, callback, canNavigate) =>
    // openProject normally selects a recent Session; staging a new draft must clear it afterward.
    canNavigate?.() === false ? false : navigate(projectId, 'most-recent-unrelated', callback)
  )
  mocks.clearSelection.mockImplementation(() => {
    mocks.selectedSessionId = undefined
  })
  vi.stubGlobal('api', { sessionReplay: { findDiscussion: mocks.find } })
})
afterEach(() => vi.unstubAllGlobals())

describe('direct research discussion navigation', () => {
  it.each([true, false])(
    'preserves the recorded viewer and reports the exact admitted destination (existing: %s)',
    async (existing) => {
      if (existing) mocks.find.mockResolvedValue({ sessionId: 'discussion' })
      const afterNavigate = vi.fn()
      await openResearchWorkspace(sourceMembership, { preservePreview: true, afterNavigate })
      expect(mocks.preview).not.toHaveBeenCalled()
      expect(mocks.context).not.toHaveBeenCalled()
      expect(mocks.ask).not.toHaveBeenCalled()
      expect(afterNavigate).toHaveBeenCalledWith({
        projectId: 'source-project',
        draftKey: researchDraftKey(sourceMembership)
      })
      expect(readResearchProjectDestination('source-project')).toEqual({
        kind: 'research',
        sourceSessionId: 'source',
        sourceImportId: 'import'
      })
    }
  )

  it('cancels an admitted research-entry continuation when a later project request aborts it', async () => {
    const controller = new AbortController()
    const afterNavigate = vi.fn()
    let resume!: () => boolean
    mocks.openSession.mockImplementation((projectId, sessionId, _origin, callback, canNavigate) => {
      resume = () => (canNavigate?.() === false ? false : navigate(projectId, sessionId, callback))
      return false
    })
    await openResearchWorkspace(sourceMembership, { signal: controller.signal, afterNavigate })
    controller.abort()
    expect(resume()).toBe(false)
    expect(afterNavigate).not.toHaveBeenCalled()
    expect(readResearchProjectDestination('source-project')).toBeUndefined()
    expectNoHandoff()
  })

  it('does not remember a research destination or hand off before deferred navigation is admitted', async () => {
    mocks.find.mockResolvedValue({ sessionId: 'discussion' })
    let resume!: () => void
    mocks.openSession.mockImplementation((projectId, sessionId, _origin, callback) => {
      resume = () => {
        navigate(projectId, sessionId, callback)
      }
      return false
    })
    const afterNavigate = vi.fn()
    expect(
      await openResearchWorkspace(sourceMembership, { preservePreview: true, afterNavigate })
    ).toBe(false)
    expect(readResearchProjectDestination('source-project')).toBeUndefined()
    expect(afterNavigate).not.toHaveBeenCalled()
    resume()
    expect(afterNavigate).toHaveBeenCalledOnce()
    expect(readResearchProjectDestination('source-project')?.kind).toBe('research')
  })

  it('preserves ordinary Session discussion without assigning research membership', async () => {
    mocks.sessions = [{ ...sourceSession(), packageOrigin: undefined }]
    useResearchWorkspaceStore.getState().openDraft(sourceMembership)
    expect(await openResearchDiscussion(capture)).toBe(true)
    expect(mocks.ask).toHaveBeenCalledWith(
      capture,
      expect.objectContaining({ draftKey: 'new:source-project' })
    )
    expect(
      useResearchWorkspaceStore.getState().draftResearchByProject['source-project']
    ).toBeUndefined()
    expect(mocks.find).not.toHaveBeenCalled()
  })

  it('can find an owned durable discussion when asking from outside the source', async () => {
    mocks.selectedSessionId = undefined
    mocks.find.mockResolvedValue({ sessionId: 'discussion' })
    expect(await openResearchDiscussion(capture)).toBe(true)
    expect(mocks.find).toHaveBeenCalledWith({
      projectId: 'source-project',
      sourceSessionId: 'source'
    })
    expect(mocks.openSession).toHaveBeenCalledWith(
      'source-project',
      'discussion',
      'user',
      expect.any(Function),
      expect.any(Function)
    )
    expect(mocks.ask).toHaveBeenCalledWith(
      capture,
      expect.objectContaining({
        projectId: 'source-project',
        sessionId: 'discussion',
        navigationRevision: 2
      })
    )
    expect(mocks.preview).toHaveBeenCalledWith({
      id: 'replay:source',
      projectId: 'source-project',
      sourceSessionId: 'source',
      sourceTitle: 'Original research',
      workspaceProjectId: 'source-project',
      replayAutomatic: true
    })
    expect(mocks.clearSelection).not.toHaveBeenCalled()
  })

  it('stages a distinct source draft without creating a Session', async () => {
    mocks.navigation.activeProjectId = 'other-project'
    mocks.selectedSessionId = undefined
    expect(await openResearchDiscussion(capture)).toBe(true)
    expect(mocks.ask).toHaveBeenCalledWith(
      capture,
      expect.objectContaining({
        projectId: 'source-project',
        draftKey: researchDraftKey(sourceMembership),
        sessionId: undefined
      })
    )
    expect(useResearchWorkspaceStore.getState().draftResearchByProject['source-project']).toEqual(
      sourceMembership
    )
    expect(mocks.selectedSessionId).toBe('source')
    expect(mocks.sessions).toHaveLength(2)
  })

  it('uses the current owned discussion even after its reading binding changes', async () => {
    mocks.selectedSessionId = 'discussion'
    mocks.sessions[0].runtimeContext = undefined
    expect(await openResearchDiscussion(capture)).toBe(true)
    expect(mocks.find).not.toHaveBeenCalled()
    expect(mocks.openSession).toHaveBeenCalledWith(
      'source-project',
      'discussion',
      'user',
      expect.any(Function),
      expect.any(Function)
    )
  })

  it.each(['source-project', 'other-project'])(
    'never hijacks an ordinary conversation that happens to quote this research in %s',
    async (projectId) => {
      mocks.sessions = [
        { ...receiver('ordinary', projectId), researchMembership: undefined },
        sourceSession()
      ]
      mocks.selectedSessionId = 'ordinary'
      mocks.navigation.activeProjectId = projectId
      mocks.draft = { projectId: 'source-project', sourceSessionId: 'source', draftKey: 'ordinary' }
      expect(await openResearchDiscussion(capture)).toBe(true)
      expect(mocks.find).toHaveBeenCalledOnce()
      expect(mocks.selectedSessionId).toBe('source')
      expect(mocks.ask).toHaveBeenCalledWith(
        capture,
        expect.objectContaining({ draftKey: researchDraftKey(sourceMembership) })
      )
    }
  )

  it('keeps the explicitly opened unsent research draft ahead of an older discussion', async () => {
    mocks.selectedSessionId = undefined
    useResearchWorkspaceStore.getState().openDraft(sourceMembership)
    expect(await openResearchDiscussion(capture)).toBe(true)
    expect(mocks.find).not.toHaveBeenCalled()
    expect(mocks.ask).toHaveBeenCalledWith(
      capture,
      expect.objectContaining({ draftKey: researchDraftKey(sourceMembership) })
    )
  })

  it('ignores stale or mismatched membership from a lookup result', async () => {
    mocks.sessions[0].researchMembership = { ...sourceMembership, sourceImportId: 'other-import' }
    mocks.find.mockResolvedValue({ sessionId: 'discussion' })
    mocks.selectedSessionId = undefined
    await openResearchDiscussion(capture)
    expect(mocks.selectedSessionId).toBe('source')
  })

  it.each(['navigation', 'selection', 'unselected', 'abort'])(
    'does not take over after %s changes during lookup',
    async (change) => {
      mocks.selectedSessionId = 'other'
      const finish = deferredLookup()
      const controller = new AbortController()
      const opening = openResearchDiscussion(capture, controller.signal)
      if (change === 'navigation') mocks.navigation.explicitNavigationRevision += 1
      if (change === 'selection') mocks.selectedSessionId = 'another'
      if (change === 'unselected') mocks.selectedSessionId = undefined
      if (change === 'abort') controller.abort()
      finish({ sessionId: 'discussion' })
      expect(await opening).toBe(true)
      expectNoHandoff()
    }
  )

  it('does not replace a failed catalog lookup with an empty conversation', async () => {
    mocks.selectedSessionId = undefined
    mocks.find.mockRejectedValue(new Error('Local Session catalog unavailable'))
    await expect(openResearchDiscussion(capture)).rejects.toThrow(
      'Local Session catalog unavailable'
    )
    expectNoHandoff()
  })

  it('honors an already aborted request', async () => {
    const controller = new AbortController()
    controller.abort()
    expect(await openResearchDiscussion(capture, controller.signal)).toBe(true)
    expect(mocks.find).not.toHaveBeenCalled()
    expectNoHandoff()
  })

  it('opens the original research even when a last visited discussion exists', async () => {
    useResearchWorkspaceStore.getState().rememberDiscussion(sourceMembership, 'discussion')
    expect(await openResearchWorkspace(sourceMembership)).toBe(true)
    expect(mocks.openSession).toHaveBeenCalledWith(
      'source-project',
      'source',
      'user',
      expect.any(Function),
      expect.any(Function)
    )
    expect(mocks.find).not.toHaveBeenCalled()
    expect(mocks.context).not.toHaveBeenCalled()
    expect(mocks.ask).not.toHaveBeenCalled()
    expect(mocks.preview).toHaveBeenCalledOnce()
  })

  it('opens an empty archive as its original record without fabricating evidence', async () => {
    expect(await openResearchWorkspace(sourceMembership)).toBe(true)
    expect(useResearchWorkspaceStore.getState().draftResearchByProject['source-project']).toEqual(
      sourceMembership
    )
    expect(mocks.selectedSessionId).toBe('source')
    expect(mocks.preview).toHaveBeenCalledWith(
      expect.objectContaining({ sourceSessionId: 'source' })
    )
    expect(mocks.ask).not.toHaveBeenCalled()
    expect(mocks.sessions).toHaveLength(2)
  })

  it('explicit new discussion returns to the original source and its unsent draft', async () => {
    mocks.selectedSessionId = 'discussion'
    expect(await openResearchWorkspace(sourceMembership, { newDiscussion: true })).toBe(true)
    expect(mocks.selectedSessionId).toBe('source')
    expect(mocks.find).not.toHaveBeenCalled()
    expect(mocks.context).not.toHaveBeenCalled()
    expect(mocks.ask).not.toHaveBeenCalled()
    expect(mocks.sessions).toHaveLength(2)
  })

  it('Ask on the original research stays in its source draft rather than resuming an older discussion', async () => {
    useResearchWorkspaceStore.getState().rememberDiscussion(sourceMembership, 'discussion')
    expect(await openResearchDiscussion(capture)).toBe(true)
    expect(mocks.selectedSessionId).toBe('source')
    expect(mocks.find).not.toHaveBeenCalled()
    expect(mocks.ask).toHaveBeenCalledWith(
      capture,
      expect.objectContaining({
        draftKey: researchDraftKey(sourceMembership),
        sessionId: undefined
      })
    )
    expect(mocks.sessions).toHaveLength(2)
  })

  it('freezes the selected step before a deferred navigation confirmation', async () => {
    let confirm!: () => void
    mocks.openSession.mockImplementation((projectId, sessionId, _origin, callback) => {
      confirm = () => navigate(projectId, sessionId, callback)
      return true
    })
    const mutable = structuredClone(capture)
    await openResearchDiscussion(mutable)
    mutable.stepId = 'step-99'
    confirm()
    expect(mocks.ask).toHaveBeenCalledWith(
      expect.objectContaining({ stepId: 'step-28' }),
      expect.anything()
    )
  })
})

describe('guarded discussion handoff', () => {
  it.each([
    'missing',
    'imported',
    'archived',
    'pending',
    'wrong-project',
    'source',
    'missing-project',
    'archived-project'
  ])('rejects a %s destination before navigating', (state) => {
    const target = { projectId: 'source-project', sessionId: 'discussion' }
    if (state === 'missing') mocks.sessions = []
    if (state === 'imported')
      mocks.sessions[0].packageOrigin = {
        importId: 'import',
        sourceProjectId: 'foreign',
        sourceSessionId: 'foreign-source',
        importedAt: 1,
        manifestChecksum: 'a'.repeat(64)
      }
    if (state === 'archived') mocks.sessions[0].archivedAt = 1
    if (state === 'pending') mocks.sessions[0].isPending = true
    if (state === 'wrong-project') mocks.sessions[0].projectId = 'other-project'
    if (state === 'source') target.sessionId = 'source'
    if (state === 'missing-project') mocks.projects = []
    if (state === 'archived-project') mocks.projects[0].archivedAt = 1
    expect(stageSessionDiscussion(capture, target)).toBe(false)
    expect(mocks.openSession).not.toHaveBeenCalled()
    expectNoHandoff()
  })

  it.each(['receiver-archived', 'receiver-deleted', 'project-archived'])(
    'revalidates %s after a dirty-preview navigation confirmation was deferred',
    (change) => {
      let confirm!: () => void
      mocks.openSession.mockImplementation((_projectId, _sessionId, _origin, callback) => {
        confirm = callback
        return true
      })
      const staged = vi.fn()
      expect(
        stageSessionDiscussion(
          capture,
          { projectId: 'source-project', sessionId: 'discussion' },
          staged
        )
      ).toBe(true)
      expectNoHandoff()
      if (change === 'receiver-archived') mocks.sessions[0].archivedAt = 1
      if (change === 'receiver-deleted') mocks.sessions = []
      if (change === 'project-archived') mocks.projects[0].archivedAt = 1
      confirm()
      expectNoHandoff()
      expect(staged).not.toHaveBeenCalled()
    }
  )

  it('captures the admitted receiver’s active frame after deferred navigation, rather than the stale frame at the click', () => {
    let confirm!: () => void
    mocks.openSession.mockImplementation((projectId, sessionId, _origin, callback) => {
      confirm = () => {
        navigate(projectId, sessionId, callback)
      }
      return true
    })
    const staged = vi.fn()
    stageSessionDiscussion(
      capture,
      { projectId: 'source-project', sessionId: 'discussion' },
      staged
    )
    mocks.sessions[0].conversationGraph = {
      activeFrameId: 'current-frame',
      frames: [{ id: 'current-frame', activeBranchId: 'current-branch' }]
    } as ChatSession['conversationGraph']
    confirm()
    expect(mocks.ask).toHaveBeenCalledWith(
      capture,
      expect.objectContaining({
        frameId: 'current-frame',
        branchId: 'current-branch',
        navigationRevision: 2
      })
    )
    expect(staged).toHaveBeenCalledOnce()
  })

  it('leaves the current draft and replay alone when the navigation guard declines the handoff', () => {
    mocks.openSession.mockReturnValue(false)
    expect(
      stageSessionDiscussion(capture, { projectId: 'source-project', sessionId: 'discussion' })
    ).toBe(false)
    expectNoHandoff()
  })
})
