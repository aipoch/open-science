// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useNavigationStore } from '@/stores/navigation-store'
import { useSessionReplayStore } from '@/stores/session-replay-store'
import { usePreviewWorkbenchStore } from '@/stores/preview-workbench-store'
import {
  availableDraftAnnotations,
  configureComposerDraftStorage,
  revokeComposerDraftStorage
} from './composer-draft-storage'
import { FOCUS_COMPOSER_EVENT } from './composer-focus-events'
import { openDiscussionDraft } from './workspace-session-actions'
import { useWorkspaceSessionDiscussion } from './workspace-session-discussion'
import {
  createSessionDiscussionAnnotation,
  replayAnnotationTarget
} from './session-discussion-annotation'
import { consumeReplaySeek, type SessionDiscussionCapture } from './replay/replay-context'
import { createInitialSessionState, useSessionStore } from '@/stores/session-store'
import { useProjectStore } from '@/stores/project-store'
import { createLinearConversationGraph } from '../../../../shared/conversation-graph'
import type { ComposerDoc } from './composer/composer-doc'
import type { SessionDiscussionSnapshot } from '../../../../shared/session-replay'

const context: SessionDiscussionCapture = {
  projectId: 'p',
  sourceSessionId: 'source',
  sourceTitle: 'Study',
  fingerprint: 'hash',
  branchId: 'main',
  stepId: 'tool-step',
  stepOffsetMs: 123,
  excerpt: 'Mean = 4.50 from the visible saved output',
  evidence: Array.from({ length: 108 }, (_, index) => ({
    kind: 'activity',
    id: `tool-${index}-${'x'.repeat(60)}`,
    projectId: 'p',
    sessionId: 'source',
    part: 'record'
  }))
}
const destination = { projectId: 'target-project', sessionId: 'target', navigationRevision: 1 }
const doc = (text: string): ComposerDoc => ({
  nodes: [
    { type: 'session', sessionId: 'source', title: 'Study' },
    { type: 'text', text }
  ]
})
const deferred = <T,>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
beforeEach(() => {
  useNavigationStore.setState({
    view: 'workspace',
    activeProjectId: 'target-project',
    explicitNavigationRevision: 1
  })
  useSessionStore.setState(createInitialSessionState())
  useSessionStore.getState().upsertPersistedSession({
    id: 'target',
    projectId: 'target-project',
    title: 'Target',
    cwd: '',
    status: 'idle',
    messages: [],
    createdAt: 1,
    updatedAt: 1
  })
  useSessionStore.getState().selectSession('target')
  useProjectStore.setState({
    projects: [
      {
        id: 'target-project',
        name: 'Target',
        description: '',
        isExample: false,
        createdAt: 1,
        updatedAt: 1
      }
    ]
  })
  useSessionReplayStore.setState({ pendingDiscussion: undefined, discussionDestination: undefined })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('durable step-scoped Ask snapshots', () => {
  it.each(['missing', 'deleted'] as const)(
    'checks a restored draft before sending when the source is %s',
    async (sourceStatus) => {
      configureComposerDraftStorage('scope')
      try {
        const sourceSessionId = 'import-removed'
        const annotation = createSessionDiscussionAnnotation(
          { ...context, sourceSessionId },
          'snapshot'
        )!
        const lookup = deferred<{ sourceStatus: typeof sourceStatus }>()
        const get = vi.fn(() => lookup.promise)
        vi.stubGlobal('api', { sessionReplay: { get } })
        const { result } = renderHook(() =>
          useWorkspaceSessionDiscussion({
            draftKey: 'new:p',
            editable: true,
            composer: {
              lifecycle: { discussionDraftConflict: () => false },
              view: { doc: doc('Keep my question'), annotations: [annotation] },
              actions: { changeDoc: vi.fn(), addAnnotation: vi.fn(), setError: vi.fn() }
            }
          })
        )
        expect(result.current).toBe(true)
        expect(get).toHaveBeenCalledWith({ projectId: 'p', sourceSessionId })
        await act(async () => lookup.resolve({ sourceStatus }))
        expect(result.current).toBe(false)
        expect(availableDraftAnnotations([annotation])).toEqual(
          sourceStatus === 'deleted' ? [] : [annotation]
        )
      } finally {
        revokeComposerDraftStorage()
      }
    }
  )

  it('clears an unavailable-evidence error after a successful retry without replacing the draft', async () => {
    const saveSelectionSnapshot = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('api', { sessionReplay: { saveSelectionSnapshot } })
    const actions = { changeDoc: vi.fn(), addAnnotation: vi.fn(), setError: vi.fn() }
    const draft = doc('Keep this question')
    renderHook(() =>
      useWorkspaceSessionDiscussion({
        draftKey: 'target',
        editable: true,
        composer: {
          lifecycle: { discussionDraftConflict: () => false },
          view: { doc: draft, annotations: [] },
          actions
        }
      })
    )
    act(() => useSessionReplayStore.getState().ask({ ...context, evidence: [] }, destination))
    await waitFor(() =>
      expect(actions.setError).toHaveBeenCalledWith('The recorded evidence is unavailable.')
    )
    expect(actions.addAnnotation).not.toHaveBeenCalled()
    act(() => useSessionReplayStore.getState().ask(context, destination))
    await waitFor(() => expect(actions.addAnnotation).toHaveBeenCalledOnce())
    expect(actions.changeDoc).toHaveBeenCalledWith(draft)
    expect(actions.setError).toHaveBeenLastCalledWith(null)
  })

  it('strips renderer inspection state before the Ask snapshot crosses IPC', async () => {
    const saveSelectionSnapshot = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('api', { sessionReplay: { saveSelectionSnapshot } })
    const actions = { changeDoc: vi.fn(), addAnnotation: vi.fn(), setError: vi.fn() }
    renderHook(() =>
      useWorkspaceSessionDiscussion({
        draftKey: 'target',
        editable: true,
        composer: {
          lifecycle: { discussionDraftConflict: () => false },
          view: { doc: doc('Why?'), annotations: [] },
          actions
        }
      })
    )
    act(() =>
      useSessionReplayStore.getState().ask(
        {
          ...context,
          notebookInspection: { open: true },
          stepInspection: { tab: 'output' }
        } as SessionDiscussionCapture & { notebookInspection: unknown; stepInspection: unknown },
        destination
      )
    )
    await waitFor(() => expect(saveSelectionSnapshot).toHaveBeenCalledTimes(1))
    const saved = saveSelectionSnapshot.mock.calls[0][0].context
    expect(saved).not.toHaveProperty('notebookInspection')
    expect(saved).not.toHaveProperty('stepInspection')
  })

  it('saves every visible reference before adding an annotation and retains typing during storage', async () => {
    const gate = deferred<void>()
    const saveSelectionSnapshot = vi.fn().mockReturnValue(gate.promise)
    vi.stubGlobal('api', { sessionReplay: { saveSelectionSnapshot } })
    const actions = { changeDoc: vi.fn(), addAnnotation: vi.fn(), setError: vi.fn() }
    const { rerender, result } = renderHook(
      ({ text }) =>
        useWorkspaceSessionDiscussion({
          draftKey: 'target',
          editable: true,
          composer: {
            lifecycle: { discussionDraftConflict: () => false },
            view: { doc: doc(text), annotations: [] },
            actions
          }
        }),
      { initialProps: { text: 'Why?' } }
    )
    act(() => useSessionReplayStore.getState().ask(context, destination))
    await waitFor(() => expect(saveSelectionSnapshot).toHaveBeenCalledTimes(1))
    expect(result.current).toBe(true)
    expect(saveSelectionSnapshot.mock.calls[0][0].context.evidence).toHaveLength(108)
    expect(actions.addAnnotation).not.toHaveBeenCalled()
    rerender({ text: 'Why? Preserve my newer explanation.' })
    await act(async () => gate.resolve())
    await waitFor(() => expect(actions.addAnnotation).toHaveBeenCalledTimes(1))
    expect(result.current).toBe(false)
    const annotation = actions.addAnnotation.mock.calls[0][0]
    expect(replayAnnotationTarget(annotation)?.contextId).toBe(
      saveSelectionSnapshot.mock.calls[0][0].context.id
    )
    expect(annotation.quote).toContain(`Session: ${context.sourceTitle}`)
    expect(annotation.quote).not.toContain(context.excerpt)
    expect(annotation.quote).not.toContain('readReference')
    expect(annotation.quote).not.toContain('Preview is truncated.')
    expect(annotation.quote.length).toBeLessThanOrEqual(4000)
    expect(actions.changeDoc.mock.lastCall?.[0]).toEqual(doc('Why? Preserve my newer explanation.'))
    expect(useSessionReplayStore.getState().pendingDiscussion).toBeUndefined()
  })
  it('does not steal timeline focus when a delayed Ask finishes', async () => {
    const gate = deferred<void>()
    vi.stubGlobal('api', { sessionReplay: { saveSelectionSnapshot: vi.fn(() => gate.promise) } })
    const actions = { changeDoc: vi.fn(), addAnnotation: vi.fn(), setError: vi.fn() }
    const editor = document.createElement('input')
    const timeline = document.createElement('button')
    document.body.append(editor, timeline)
    const focus = vi.fn(() => editor.focus())
    window.addEventListener(FOCUS_COMPOSER_EVENT, focus)
    try {
      renderHook(() =>
        useWorkspaceSessionDiscussion({
          draftKey: 'target',
          editable: true,
          composer: {
            lifecycle: { discussionDraftConflict: () => false },
            view: { doc: doc('Explain this'), annotations: [] },
            actions
          }
        })
      )
      act(() => useSessionReplayStore.getState().ask(context, destination))
      expect(editor).toBe(document.activeElement)
      timeline.focus()
      await act(async () => gate.resolve())
      expect(actions.addAnnotation).toHaveBeenCalledOnce()
      expect(focus).toHaveBeenCalledOnce()
      expect(timeline).toBe(document.activeElement)
    } finally {
      window.removeEventListener(FOCUS_COMPOSER_EVENT, focus)
      editor.remove()
      timeline.remove()
    }
  })

  it('opens a project draft when Ask is clicked while the selected child is still pending', () => {
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((row) => ({
        ...row,
        parentSessionId: context.sourceSessionId,
        isPending: true
      }))
    }))
    const secondStep = { ...context, projectId: destination.projectId, stepId: 'second' }
    expect(openDiscussionDraft(secondStep, true)).toBe(true)
    expect(useSessionStore.getState().selectedSessionId).toBeUndefined()
    expect(useSessionReplayStore.getState().discussionDestination?.sessionId).toBeUndefined()
    expect(useSessionReplayStore.getState().pendingDiscussion?.stepId).toBe('second')
  })

  it('does not attach a delayed snapshot when its destination is pending at completion', async () => {
    const gate = deferred<void>()
    const saveSelectionSnapshot = vi.fn(() => gate.promise)
    vi.stubGlobal('api', { sessionReplay: { saveSelectionSnapshot } })
    const actions = { changeDoc: vi.fn(), addAnnotation: vi.fn(), setError: vi.fn() }
    renderHook(() =>
      useWorkspaceSessionDiscussion({
        draftKey: 'target',
        editable: true,
        composer: {
          lifecycle: { discussionDraftConflict: () => false },
          view: { doc: doc('Keep my question'), annotations: [] },
          actions
        }
      })
    )
    act(() => useSessionReplayStore.getState().ask(context, destination))
    await waitFor(() => expect(saveSelectionSnapshot).toHaveBeenCalledOnce())
    act(() =>
      useSessionStore.setState((state) => ({
        sessions: state.sessions.map((row) => ({ ...row, isPending: true }))
      }))
    )
    await act(async () => gate.resolve())
    expect(actions.addAnnotation).not.toHaveBeenCalled()
    expect(actions.changeDoc).not.toHaveBeenCalled()
    expect(useSessionReplayStore.getState().pendingDiscussion).toBeUndefined()
  })

  it('discards a stale insertion without writing into a different draft after navigation', async () => {
    const gate = deferred<void>()
    vi.stubGlobal('api', {
      sessionReplay: { saveSelectionSnapshot: vi.fn().mockReturnValue(gate.promise) }
    })
    const actions = { changeDoc: vi.fn(), addAnnotation: vi.fn(), setError: vi.fn() }
    renderHook(() =>
      useWorkspaceSessionDiscussion({
        draftKey: 'target',
        editable: true,
        composer: {
          lifecycle: { discussionDraftConflict: () => false },
          view: { doc: doc('Why?'), annotations: [] },
          actions
        }
      })
    )
    act(() => useSessionReplayStore.getState().ask(context, destination))
    actions.changeDoc.mockClear()
    act(() =>
      useNavigationStore.setState({ activeProjectId: 'elsewhere', explicitNavigationRevision: 2 })
    )
    await act(async () => gate.resolve())
    expect(actions.addAnnotation).not.toHaveBeenCalled()
    expect(actions.changeDoc).not.toHaveBeenCalled()
    expect(useSessionReplayStore.getState().pendingDiscussion).toBeUndefined()
  })
  it('resolves new annotations through the immutable local snapshot and ignores a late reveal after navigation', async () => {
    const gate = deferred<SessionDiscussionSnapshot>()
    const getSelectionSnapshot = vi.fn().mockReturnValue(gate.promise)
    vi.stubGlobal('api', { sessionReplay: { getSelectionSnapshot } })
    const open = vi.spyOn(usePreviewWorkbenchStore.getState(), 'upsertAndActivateItem')
    const actions = { changeDoc: vi.fn(), addAnnotation: vi.fn(), setError: vi.fn() }
    renderHook(() =>
      useWorkspaceSessionDiscussion({
        draftKey: 'target',
        editable: true,
        composer: {
          lifecycle: { discussionDraftConflict: () => false },
          view: { doc: doc('Why?'), annotations: [] },
          actions
        }
      })
    )
    const annotation = createSessionDiscussionAnnotation(context, 'context-id')!
    act(() => {
      document.dispatchEvent(new CustomEvent('annotation-reveal-prepare', { detail: annotation }))
      document.dispatchEvent(new CustomEvent('annotation-reveal', { detail: annotation.id }))
    })
    expect(getSelectionSnapshot).toHaveBeenCalledWith({ projectId: 'p', id: 'context-id' })
    act(() => useNavigationStore.setState({ explicitNavigationRevision: 2 }))
    await act(async () => gate.resolve({ ...context, id: 'context-id' }))
    expect(open).not.toHaveBeenCalled()
  })
  it('reveals the saved position in another project without switching the target conversation and reports a missing local snapshot', async () => {
    const getSelectionSnapshot = vi.fn().mockResolvedValue({ ...context, id: 'context-id' })
    vi.stubGlobal('api', { sessionReplay: { getSelectionSnapshot } })
    const open = vi
      .spyOn(usePreviewWorkbenchStore.getState(), 'upsertAndActivateItem')
      .mockImplementation(() => {})
    const actions = { changeDoc: vi.fn(), addAnnotation: vi.fn(), setError: vi.fn() }
    renderHook(() =>
      useWorkspaceSessionDiscussion({
        draftKey: 'target',
        editable: true,
        composer: {
          lifecycle: { discussionDraftConflict: () => false },
          view: { doc: doc('Why?'), annotations: [] },
          actions
        }
      })
    )
    const annotation = createSessionDiscussionAnnotation(context, 'context-id')!
    await act(async () => {
      document.dispatchEvent(new CustomEvent('annotation-reveal-prepare', { detail: annotation }))
      document.dispatchEvent(new CustomEvent('annotation-reveal', { detail: annotation.id }))
    })
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'target-project',
        replaySourceProjectId: 'p',
        replaySourceSessionId: 'source',
        title: context.sourceTitle
      })
    )
    expect(consumeReplaySeek('p', 'source')).toMatchObject({
      stepId: context.stepId,
      stepOffsetMs: 123
    })
    expect(useSessionStore.getState().selectedSessionId).toBe('target')
    getSelectionSnapshot.mockResolvedValueOnce(undefined)
    await act(async () => {
      document.dispatchEvent(new CustomEvent('annotation-reveal-prepare', { detail: annotation }))
    })
    expect(actions.setError).toHaveBeenCalledWith(
      'This replay reference is unavailable on this device.'
    )
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('does not insert a captured reference after the target branch changes during storage', async () => {
    const graph = createLinearConversationGraph({
      sessionId: 'target',
      messages: [],
      createdAt: 1,
      updatedAt: 1
    })
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((row) => ({ ...row, conversationGraph: graph }))
    }))
    const gate = deferred<void>()
    const saveSelectionSnapshot = vi.fn().mockReturnValue(gate.promise)
    vi.stubGlobal('api', { sessionReplay: { saveSelectionSnapshot } })
    const actions = { changeDoc: vi.fn(), addAnnotation: vi.fn(), setError: vi.fn() }
    renderHook(() =>
      useWorkspaceSessionDiscussion({
        draftKey: 'target',
        editable: true,
        composer: {
          lifecycle: { discussionDraftConflict: () => false },
          view: { doc: doc('Keep my draft'), annotations: [] },
          actions
        }
      })
    )
    act(() => useSessionReplayStore.getState().ask(context, destination))
    await waitFor(() => expect(saveSelectionSnapshot).toHaveBeenCalledTimes(1))
    act(() =>
      useSessionStore.setState((state) => ({
        sessions: state.sessions.map((row) => ({
          ...row,
          conversationGraph: {
            ...graph,
            frames: graph.frames.map((frame) => ({ ...frame, activeBranchId: 'changed-branch' }))
          }
        }))
      }))
    )
    await act(async () => gate.resolve())
    expect(actions.changeDoc).not.toHaveBeenCalled()
    expect(actions.addAnnotation).not.toHaveBeenCalled()
    expect(useSessionReplayStore.getState().pendingDiscussion).toBeUndefined()
  })

  it('stages a standalone Notebook reference in an ordinary new draft with its source project', async () => {
    useSessionStore.getState().clearSelection()
    const saveSelectionSnapshot = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('api', { sessionReplay: { saveSelectionSnapshot } })
    const actions = { changeDoc: vi.fn(), addAnnotation: vi.fn(), setError: vi.fn() }
    renderHook(() =>
      useWorkspaceSessionDiscussion({
        draftKey: 'new:target-project',
        editable: true,
        composer: {
          lifecycle: { discussionDraftConflict: () => false },
          view: { doc: { nodes: [{ type: 'text', text: 'Already typing' }] }, annotations: [] },
          actions
        }
      })
    )
    act(() =>
      useSessionReplayStore.getState().ask(
        {
          ...context,
          evidence: [
            {
              kind: 'notebook-run',
              id: 'run-1',
              projectId: 'p',
              sessionId: 'source',
              part: 'record'
            }
          ]
        },
        { ...destination, sessionId: undefined }
      )
    )
    await waitFor(() => expect(actions.changeDoc).toHaveBeenCalledTimes(1))
    const draft = actions.changeDoc.mock.calls[0][0] as ComposerDoc
    expect(draft.nodes).toContainEqual({ type: 'text', text: 'Already typing' })
    expect(draft.nodes.some((node) => node.type === 'session')).toBe(false)
    expect(JSON.stringify(draft)).not.toContain('#session-replay:')
    expect(actions.addAnnotation).toHaveBeenCalledWith(
      expect.objectContaining({
        source: {
          kind: 'session-item',
          sessionId: 'source',
          itemId: 'run-1',
          itemType: 'notebook-run'
        }
      })
    )
    expect(useSessionStore.getState().selectedSessionId).toBeUndefined()
    expect(useSessionStore.getState().sessions).toHaveLength(1)
  })
})
