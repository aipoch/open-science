// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '../../../../shared/projects'
import {
  useSessionStore,
  type ChatSession,
  createInitialSessionState
} from '@/stores/session-store'
import { useProjectStore, createInitialProjectState } from '@/stores/project-store'
import { useNavigationStore } from '@/stores/navigation-store'
import { useResearchWorkspaceStore } from '@/stores/research-workspace-store'
import {
  createInitialPreviewWorkbenchState,
  usePreviewWorkbenchStore
} from '@/stores/preview-workbench-store'
import { previewLeaveGuards, workbenchPreviewGuardScope } from '@/stores/preview-leave-guard'
import {
  readResearchProjectDestination,
  rememberResearchProjectDestination
} from '@/lib/research-project-entry'
import { openProjectWorkspace } from './project-workspace-entry'
import { useResearchDemoStore } from '@/stores/research-demo-store'

const openResearch = vi.hoisted(() => vi.fn().mockResolvedValue(true))
vi.mock('./workspace-discussion-navigation', () => ({
  openResearchWorkspace: openResearch,
  researchSourceFromSession: (session: ChatSession | undefined) =>
    session?.importedResearch
      ? {
          sourceProjectId: session.projectId,
          sourceSessionId: session.id,
          sourceImportId: session.importedResearch.importId,
          sourceTitle: session.title
        }
      : undefined
}))
const project = (id: string): Project => ({
  id,
  name: id,
  description: '',
  isExample: false,
  createdAt: 1,
  updatedAt: 1
})
const session = (id: string, extra: Partial<ChatSession> = {}): ChatSession => ({
  id,
  projectId: 'project',
  title: id,
  cwd: '',
  status: 'idle',
  messages: [],
  createdAt: 1,
  updatedAt: 1,
  ...extra
})
const source = session('source', { importedResearch: { importId: 'import' } })
const ordinary = session('ordinary', { updatedAt: 2 })
beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  openResearch.mockResolvedValue(true)
  previewLeaveGuards.clear()
  useSessionStore.setState({ ...createInitialSessionState(), sessions: [source, ordinary] })
  useProjectStore.setState({
    ...createInitialProjectState(),
    isLoaded: true,
    projects: [project('project'), project('other')]
  })
  usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
  useNavigationStore.setState({
    view: 'home',
    activeProjectId: undefined,
    explicitNavigationRevision: 0,
    userNavigationRevision: 0
  })
  useResearchWorkspaceStore.setState({ draftResearchByProject: {}, lastDiscussionByResearch: {} })
  useResearchDemoStore.setState({ carriersByProject: {} })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { researchDemos: { carriers: vi.fn().mockResolvedValue([]) } }
  })
})

describe('intentional project entry', () => {
  it('does not let a Main-owned demo carrier replace the most recent ordinary discussion', async () => {
    useSessionStore.setState({
      sessions: [source, ordinary, session('demo-carrier', { updatedAt: 99 })]
    })
    vi.mocked(window.api.researchDemos.carriers).mockResolvedValue([
      {
        sessionId: 'demo-carrier',
        source: { projectId: 'project', sourceSessionId: 'source', sourceImportId: 'import' }
      }
    ])
    await openProjectWorkspace('project')
    expect(useSessionStore.getState().selectedSessionId).toBe('ordinary')
    expect(useSessionStore.getState().sessions.map((item) => item.id)).toContain('demo-carrier')
  })
  it('opens recent ordinary execution as an ordinary Session in a mixed project', async () => {
    await openProjectWorkspace('project')
    expect(useSessionStore.getState().selectedSessionId).toBe('ordinary')
    expect(openResearch).not.toHaveBeenCalled()
    expect(readResearchProjectDestination('project')).toEqual({
      kind: 'session',
      sessionId: 'ordinary'
    })
  })

  it('opens the original research entry on a first imported-only project visit', async () => {
    useSessionStore.setState({ sessions: [source] })
    await openProjectWorkspace('project')
    expect(openResearch).toHaveBeenCalledWith(
      expect.objectContaining({ sourceSessionId: 'source', sourceImportId: 'import' }),
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        afterNavigate: expect.any(Function)
      })
    )
    expect(useSessionStore.getState().sessions).toEqual([source])
  })

  it('restores an older research-draft preference through the source entry without a new Session', async () => {
    const destination = {
      kind: 'research' as const,
      sourceSessionId: source.id,
      sourceImportId: 'import'
    }
    rememberResearchProjectDestination('project', destination, [source, ordinary])
    await openProjectWorkspace('project')
    expect(openResearch).toHaveBeenCalledWith(
      expect.objectContaining({ sourceSessionId: 'source', sourceImportId: 'import' }),
      expect.not.objectContaining({ newDiscussion: true })
    )
    expect(useSessionStore.getState().sessions).toEqual([source, ordinary])
    expect(useSessionStore.getState().selectedSessionId).toBeUndefined()
  })

  it('preserves exact source Session links and restores an explicitly selected original', async () => {
    useNavigationStore.getState().openSession('project', 'source', 'user')
    await openProjectWorkspace('project')
    expect(useSessionStore.getState().selectedSessionId).toBe('source')
    expect(openResearch).not.toHaveBeenCalled()
  })

  it('restores an ordinary draft and leaves the previous research draft mode', async () => {
    rememberResearchProjectDestination('project', { kind: 'draft' }, [source, ordinary])
    useResearchWorkspaceStore.getState().openDraft({
      sourceProjectId: 'project',
      sourceSessionId: 'source',
      sourceImportId: 'import',
      sourceTitle: 'source'
    })
    await openProjectWorkspace('project')
    expect(useSessionStore.getState().selectedSessionId).toBeUndefined()
    expect(useResearchWorkspaceStore.getState().draftResearchByProject.project).toBeUndefined()
  })

  it('does not alter selection or preferences before a dirty-preview handoff is admitted', async () => {
    useNavigationStore.setState({ view: 'workspace', activeProjectId: 'other' })
    useSessionStore.setState({ selectedSessionId: 'other-session' })
    usePreviewWorkbenchStore.setState({ activeProjectId: 'other', activeItemId: 'dirty-file' })
    previewLeaveGuards.register(workbenchPreviewGuardScope('other', 'dirty-file')!, () => false)
    expect(await openProjectWorkspace('project')).toBe(false)
    expect(useSessionStore.getState().selectedSessionId).toBe('other-session')
    expect(readResearchProjectDestination('project')).toBeUndefined()
  })

  it('ignores an older deferred project continuation after a newer project entry', async () => {
    useNavigationStore.setState({ view: 'workspace', activeProjectId: 'other' })
    usePreviewWorkbenchStore.setState({ activeProjectId: 'other', activeItemId: 'dirty-file' })
    let resume!: () => boolean | void
    const unregister = previewLeaveGuards.register(
      workbenchPreviewGuardScope('other', 'dirty-file')!,
      (action) => {
        resume = action
        return false
      }
    )
    const afterNavigate = vi.fn()
    expect(await openProjectWorkspace('project', afterNavigate)).toBe(false)
    unregister()
    await openProjectWorkspace('other')
    expect(resume()).toBe(false)
    expect(useNavigationStore.getState().activeProjectId).toBe('other')
    expect(readResearchProjectDestination('project')).toBeUndefined()
    expect(afterNavigate).not.toHaveBeenCalled()
  })

  it('revalidates an imported original identity before a deferred project entry resumes', async () => {
    rememberResearchProjectDestination('project', { kind: 'session', sessionId: 'source' }, [
      source,
      ordinary
    ])
    useNavigationStore.setState({ view: 'workspace', activeProjectId: 'other' })
    usePreviewWorkbenchStore.setState({ activeProjectId: 'other', activeItemId: 'dirty-file' })
    let resume!: () => boolean | void
    previewLeaveGuards.register(workbenchPreviewGuardScope('other', 'dirty-file')!, (action) => {
      resume = action
      return false
    })
    await openProjectWorkspace('project')
    useSessionStore.setState({
      sessions: [{ ...source, importedResearch: { importId: 'replacement-import' } }, ordinary]
    })
    expect(resume()).toBe(false)
    expect(useNavigationStore.getState().activeProjectId).toBe('other')
    expect(readResearchProjectDestination('project')).toEqual({
      kind: 'session',
      sessionId: 'source',
      sourceImportId: 'import'
    })
  })

  it('ignores an older deferred entry after an exact Session navigation', async () => {
    useSessionStore.setState({
      sessions: [source, ordinary, session('other-session', { projectId: 'other' })]
    })
    useNavigationStore.setState({ view: 'workspace', activeProjectId: 'other' })
    usePreviewWorkbenchStore.setState({ activeProjectId: 'other', activeItemId: 'dirty-file' })
    let resume!: () => boolean | void
    previewLeaveGuards.register(workbenchPreviewGuardScope('other', 'dirty-file')!, (action) => {
      resume = action
      return false
    })
    await openProjectWorkspace('project')
    useNavigationStore.getState().openSession('other', 'other-session', 'user')
    expect(resume()).toBe(false)
    expect(useSessionStore.getState().selectedSessionId).toBe('other-session')
  })

  it('plain projects keep most-recent selection and do not read an old research preference', async () => {
    rememberResearchProjectDestination('project', { kind: 'draft' }, [source, ordinary])
    useSessionStore.setState({ sessions: [ordinary] })
    await openProjectWorkspace('project')
    expect(useSessionStore.getState().selectedSessionId).toBe('ordinary')
    expect(openResearch).not.toHaveBeenCalled()
  })

  it('propagates research entry failure instead of opening a blank substitute', async () => {
    useSessionStore.setState({ sessions: [source] })
    openResearch.mockRejectedValue(new Error('entry unavailable'))
    await expect(openProjectWorkspace('project')).rejects.toThrow('entry unavailable')
    expect(useNavigationStore.getState().view).toBe('home')
  })
})
