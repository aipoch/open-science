import { researchDraftKey } from './research-draft-identity'
// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useNavigationStore } from '@/stores/navigation-store'
import { useSessionReplayStore } from '@/stores/session-replay-store'
import { usePreviewWorkbenchStore } from '@/stores/preview-workbench-store'
import { FOCUS_COMPOSER_EVENT } from './composer-focus-events'
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
import {
  saveSessionDiscussionSnapshotRequestSchema,
  type SessionDiscussionSnapshot
} from '../../../../shared/session-replay'

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
  it('clears an unavailable-evidence error after a successful retry without replacing the draft', async () => {
    const saveSelectionSnapshot = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('api', { sessionReplay: { saveSelectionSnapshot } })
    const actions = { changeDoc: vi.fn(), addAnnotation: vi.fn(), setError: vi.fn() }
    const draft = doc('Keep this question')
    renderHook(() =>
      useWorkspaceSessionDiscussion({
        draftKey: 'target',
        editable: true,
        composer: { view: { doc: draft, annotations: [] }, actions }
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

  it('delivers a pending Ask only to its matching research draft while keeping ordinary drafts untouched', async () => {
    const source = {
      sourceProjectId: 'target-project',
      sourceSessionId: 'source',
      sourceImportId: 'import',
      sourceTitle: 'Study'
    }
    const draftKey = researchDraftKey(source)
    useSessionStore.getState().clearSelection()
    const saveSelectionSnapshot = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('api', { sessionReplay: { saveSelectionSnapshot } })
    const actions = { changeDoc: vi.fn(), addAnnotation: vi.fn(), setError: vi.fn() }
    const { rerender } = renderHook(
      ({ key }) =>
        useWorkspaceSessionDiscussion({
          draftKey: key,
          editable: true,
          composer: { view: { doc: doc('Question'), annotations: [] }, actions }
        }),
      { initialProps: { key: 'new:target-project' } }
    )
    act(() =>
      useSessionReplayStore
        .getState()
        .ask(context, { projectId: 'target-project', draftKey, navigationRevision: 1 })
    )
    expect(saveSelectionSnapshot).not.toHaveBeenCalled()
    rerender({ key: draftKey })
    await waitFor(() => expect(actions.addAnnotation).toHaveBeenCalledOnce())
    expect(saveSelectionSnapshot).toHaveBeenCalledOnce()
  })

  it('reentering a linked research draft restores typing focus and preserves its chosen step without another snapshot', () => {
    useSessionStore.getState().clearSelection()
    const saveSelectionSnapshot = vi.fn()
    vi.stubGlobal('api', { sessionReplay: { saveSelectionSnapshot } })
    const actions = { changeDoc: vi.fn(), addAnnotation: vi.fn(), setError: vi.fn() }
    const existing = createSessionDiscussionAnnotation(context, 'frozen-step')!
    const draftKey = 'new-research:source'
    const draft = doc('Explain this exact step')
    const editor = document.createElement('input')
    const sidebar = document.createElement('button')
    document.body.append(editor, sidebar)
    const focus = vi.fn(() => editor.focus())
    window.addEventListener(FOCUS_COMPOSER_EVENT, focus)
    try {
      renderHook(() =>
        useWorkspaceSessionDiscussion({
          draftKey,
          editable: true,
          composer: { view: { doc: draft, annotations: [existing] }, actions }
        })
      )
      sidebar.focus()
      act(() =>
        useSessionReplayStore
          .getState()
          .ask(
            { ...context, scope: 'session' },
            { projectId: 'target-project', draftKey, onlyIfUnlinked: true, navigationRevision: 1 }
          )
      )
      expect(document.activeElement).toBe(editor)
      expect(focus).toHaveBeenCalledOnce()
      expect(saveSelectionSnapshot).not.toHaveBeenCalled()
      expect(actions.addAnnotation).not.toHaveBeenCalled()
      expect(actions.changeDoc).not.toHaveBeenCalled()
      expect(useSessionStore.getState().selectedSessionId).toBeUndefined()
      expect(useSessionStore.getState().sessions.map((session) => session.id)).toEqual(['target'])
      expect(useSessionReplayStore.getState().pendingDiscussion).toBeUndefined()
    } finally {
      window.removeEventListener(FOCUS_COMPOSER_EVENT, focus)
      editor.remove()
      sidebar.remove()
    }
  })

  it('does not append a delayed research reference after switching between two unsent research drafts', async () => {
    useSessionStore.getState().clearSelection()
    const gate = deferred<void>()
    const saveSelectionSnapshot = vi.fn(() => gate.promise)
    vi.stubGlobal('api', { sessionReplay: { saveSelectionSnapshot } })
    const actions = { changeDoc: vi.fn(), addAnnotation: vi.fn(), setError: vi.fn() }
    const { rerender } = renderHook(
      ({ key }) =>
        useWorkspaceSessionDiscussion({
          draftKey: key,
          editable: true,
          composer: { view: { doc: doc('Question'), annotations: [] }, actions }
        }),
      { initialProps: { key: 'research-a' } }
    )
    act(() =>
      useSessionReplayStore.getState().ask(context, {
        projectId: 'target-project',
        draftKey: 'research-a',
        navigationRevision: 1
      })
    )
    await waitFor(() => expect(saveSelectionSnapshot).toHaveBeenCalledOnce())
    rerender({ key: 'research-b' })
    await act(async () => gate.resolve())
    expect(actions.addAnnotation).not.toHaveBeenCalled()
    expect(actions.changeDoc).not.toHaveBeenCalled()
  })

  it('saves every visible reference before adding an annotation and retains typing during storage', async () => {
    const gate = deferred<void>()
    const saveSelectionSnapshot = vi.fn().mockReturnValue(gate.promise)
    vi.stubGlobal('api', { sessionReplay: { saveSelectionSnapshot } })
    const actions = { changeDoc: vi.fn(), addAnnotation: vi.fn(), setError: vi.fn() }
    const { rerender } = renderHook(
      ({ text }) =>
        useWorkspaceSessionDiscussion({
          draftKey: 'target',
          editable: true,
          composer: { view: { doc: doc(text), annotations: [] }, actions }
        }),
      { initialProps: { text: 'Why?' } }
    )
    act(() => useSessionReplayStore.getState().ask(context, destination))
    await waitFor(() => expect(saveSelectionSnapshot).toHaveBeenCalledTimes(1))
    expect(saveSelectionSnapshot.mock.calls[0][0].context.evidence).toHaveLength(108)
    expect(actions.addAnnotation).not.toHaveBeenCalled()
    rerender({ text: 'Why? Preserve my newer explanation.' })
    await act(async () => gate.resolve())
    await waitFor(() => expect(actions.addAnnotation).toHaveBeenCalledTimes(1))
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
          composer: { view: { doc: doc('Explain this'), annotations: [] }, actions }
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
        composer: { view: { doc: doc('Why?'), annotations: [] }, actions }
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
        composer: { view: { doc: doc('Why?'), annotations: [] }, actions }
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
        composer: { view: { doc: doc('Why?'), annotations: [] }, actions }
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
        replaySourceSessionId: 'source'
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
        composer: { view: { doc: doc('Keep my draft'), annotations: [] }, actions }
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

it('saves inspected evidence through the unchanged strict native snapshot contract', async () => {
  const saveSelectionSnapshot = vi.fn(async (request: unknown) => {
    saveSessionDiscussionSnapshotRequestSchema.parse(request)
  })
  vi.stubGlobal('api', { sessionReplay: { saveSelectionSnapshot } })
  const actions = { changeDoc: vi.fn(), addAnnotation: vi.fn(), setError: vi.fn() }
  renderHook(() =>
    useWorkspaceSessionDiscussion({
      draftKey: 'target',
      editable: true,
      composer: { view: { doc: doc('Explain this run'), annotations: [] }, actions }
    })
  )
  const inspected: SessionDiscussionCapture = {
    ...context,
    stepOffsetMs: 50000,
    recordedAt: 55000,
    phase: 'result',
    notebookInspection: { runId: 'saved-run', timeMs: 50000 },
    records: [
      {
        id: 'notebook-run:saved-run',
        scope: 'step',
        title: 'Saved run',
        text: 'EXACT SAVED OUTPUT',
        status: 'recorded',
        truncated: false
      }
    ],
    evidence: [
      { kind: 'notebook-run', id: 'saved-run', projectId: 'p', sessionId: 'source', part: 'record' }
    ]
  }
  act(() => useSessionReplayStore.getState().ask(inspected, destination))
  await waitFor(() => expect(actions.addAnnotation).toHaveBeenCalledOnce())
  expect(saveSelectionSnapshot.mock.calls[0][0]).toMatchObject({
    context: {
      stepOffsetMs: 50000,
      recordedAt: 55000,
      phase: 'result',
      records: inspected.records,
      evidence: inspected.evidence
    }
  })
  expect(
    (saveSelectionSnapshot.mock.calls[0][0] as { context: unknown }).context
  ).not.toHaveProperty('notebookInspection')
  expect(actions.setError).toHaveBeenLastCalledWith(null)
})
