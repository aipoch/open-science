// @vitest-environment jsdom
import { act, createElement, useLayoutEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createInitialSessionState, useSessionStore } from '@/stores/session-store'
import { useNavigationStore } from '@/stores/navigation-store'
import {
  createInitialPreviewWorkbenchState,
  usePreviewWorkbenchStore
} from '@/stores/preview-workbench-store'
import { useResearchWorkspaceStore } from '@/stores/research-workspace-store'
import type { PersistedChatSession } from '../../../../shared/session-persistence'
import type { ResearchWorkspaceSnapshot } from '../../../../shared/research-workspace'
import {
  useWorkspaceResearchController,
  type ResearchWorkspaceController
} from './workspace-research-controller'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: translate }) }))
const translate = (text: string): string => text
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const source: PersistedChatSession = {
  id: 'import-source',
  projectId: 'project',
  title: 'Research',
  cwd: '',
  status: 'idle',
  messages: [],
  createdAt: 1,
  updatedAt: 1,
  packageOrigin: {
    importId: 'receipt',
    sourceProjectId: 'remote',
    sourceSessionId: 'remote-session',
    importedAt: 1,
    manifestChecksum: 'a'.repeat(64)
  }
}
const discussion: PersistedChatSession = {
  ...source,
  id: 'discussion',
  packageOrigin: undefined,
  title: 'Discussion'
}
const base: ResearchWorkspaceSnapshot = {
  projectId: 'project',
  sourceSessionId: source.id,
  sourceTitle: source.title,
  sourceStatus: 'available',
  discussionStatus: 'none',
  linkRevision: 0
}
const linked = (): ResearchWorkspaceSnapshot => ({
  ...base,
  discussionStatus: 'available',
  discussionSessionId: discussion.id,
  discussionSession: discussion,
  linkRevision: 1
})
const deferred = <T,>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
let root: Root
let container: HTMLDivElement
let value: ResearchWorkspaceController
let api: {
  get: ReturnType<typeof vi.fn>
  list: ReturnType<typeof vi.fn>
  ensureDiscussion: ReturnType<typeof vi.fn>
}
const Harness = (): null => {
  const current = useWorkspaceResearchController('project', true)
  useLayoutEffect(() => {
    value = current
  })
  return null
}
const mount = async (): Promise<void> => {
  await act(async () => {
    root.render(createElement(Harness))
  })
}

beforeEach(() => {
  useSessionStore.setState(createInitialSessionState())
  useSessionStore.getState().upsertPersistedSession(source)
  useSessionStore.getState().selectSession(source.id)
  useNavigationStore.setState({
    view: 'workspace',
    activeProjectId: 'project',
    researchWorkspace: undefined,
    explicitNavigationRevision: 1
  })
  usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
  usePreviewWorkbenchStore.getState().activateProject('project')
  useResearchWorkspaceStore.setState({ snapshots: {}, pendingQuestion: undefined })
  api = {
    get: vi.fn().mockResolvedValue(base),
    list: vi.fn().mockResolvedValue([]),
    ensureDiscussion: vi.fn().mockResolvedValue(linked())
  }
  window.api = { researchWorkspaces: api } as unknown as typeof window.api
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('imported research workspace navigation', () => {
  it('opens paused replay with a source-specific draft, without creating a discussion or reopening a closed tab', async () => {
    await mount()
    expect(value.research?.sourceSessionId).toBe(source.id)
    expect(value.draftKey).toBe('research:project:import-source')
    expect(api.ensureDiscussion).not.toHaveBeenCalled()
    expect(useSessionStore.getState().selectedSessionId).toBeUndefined()
    expect(usePreviewWorkbenchStore.getState().activeItemId).toBe(`tool:${source.id}:replay`)
    await act(async () => {
      usePreviewWorkbenchStore.getState().collapsePanel()
      value.retry()
    })
    expect(usePreviewWorkbenchStore.getState().panelState).toBe('collapsed')
  })

  it('keeps the source draft until first-send acceptance and does not select a late result after navigation', async () => {
    await mount()
    api.get.mockResolvedValue(linked())
    let id!: string
    await act(async () => {
      id = await value.prepareDiscussion!()
    })
    expect(id).toBe(discussion.id)
    expect(useSessionStore.getState().selectedSessionId).toBeUndefined()
    await act(async () => value.acceptDiscussion(id))
    expect(useSessionStore.getState().selectedSessionId).toBe(discussion.id)
    expect(useNavigationStore.getState().researchWorkspace?.sourceSessionId).toBe(source.id)
  })

  it('ignores a source lookup that completes after the user leaves', async () => {
    const waiting = deferred<ResearchWorkspaceSnapshot>()
    api.get.mockReturnValue(waiting.promise)
    await mount()
    await act(async () => {
      useNavigationStore.setState({
        view: 'home',
        activeProjectId: undefined,
        researchWorkspace: undefined,
        explicitNavigationRevision: 2
      })
      useSessionStore.getState().clearSelection()
      waiting.resolve(linked())
    })
    expect(useNavigationStore.getState().view).toBe('home')
    expect(useSessionStore.getState().selectedSessionId).toBeUndefined()
    expect(usePreviewWorkbenchStore.getState().items).toHaveLength(0)
  })

  it('retries the active relationship and blocks an archived discussion without blocking solely on an archived source', async () => {
    api.get.mockResolvedValue(linked())
    await mount()
    expect(value.blocked).toBe(false)
    api.get.mockResolvedValue({ ...linked(), sourceStatus: 'archived' })
    await act(async () => value.retry())
    expect(value.blocked).toBe(false)
    api.get.mockResolvedValue({
      ...linked(),
      discussionStatus: 'archived',
      discussionSession: { ...discussion, archivedAt: 10 }
    })
    await act(async () => value.retry())
    expect(value.blocked).toBe(true)
    expect(useSessionStore.getState().selectedSessionId).toBe(discussion.id)
  })

  it('does not navigate when explicit discussion replacement completes after another selection', async () => {
    api.get.mockResolvedValue({
      ...base,
      discussionStatus: 'missing',
      discussionSessionId: discussion.id,
      linkRevision: 2
    })
    await mount()
    const waiting = deferred<ResearchWorkspaceSnapshot>()
    api.ensureDiscussion.mockReturnValue(waiting.promise)
    let replacement!: Promise<void>
    act(() => {
      replacement = value.recreateDiscussion()
    })
    await act(async () => {
      useNavigationStore.getState().recordUserNavigation()
      waiting.resolve(linked())
      await replacement
    })
    expect(useNavigationStore.getState().researchWorkspace).toBeUndefined()
    expect(useSessionStore.getState().selectedSessionId).toBeUndefined()
  })
})
