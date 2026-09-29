// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useNavigationStore } from '@/stores/navigation-store'
import { useResearchWorkspaceStore } from '@/stores/research-workspace-store'
import { usePreviewWorkbenchStore } from '@/stores/preview-workbench-store'
import { useWorkspaceResearchContext } from './workspace-research-context'
import { createReplayStepAnnotation, replayAnnotationTarget } from './research-replay-context'
import { consumeReplaySeek, type ReplayStepContext } from './replay/replay-context'
import type { ResearchWorkspaceController } from './workspace-research-controller'
import type { ComposerDoc } from './composer/composer-doc'
import type { ReplayQuestionContext } from '../../../../shared/research-workspace'

const context: ReplayStepContext = {
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
const research = { projectId: 'p', sourceSessionId: 'source', sourceTitle: 'Study' }
const controller: ResearchWorkspaceController = {
  research,
  loading: false,
  blocked: false,
  acceptDiscussion: vi.fn(),
  recreateDiscussion: vi.fn(),
  restoreDiscussion: vi.fn(),
  retry: vi.fn()
}
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
    activeProjectId: 'p',
    explicitNavigationRevision: 1,
    researchWorkspace: research
  })
  useResearchWorkspaceStore.setState({ pendingQuestion: undefined })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('durable whole-frame Ask snapshots', () => {
  it('saves every visible reference before adding an annotation and retains typing during storage', async () => {
    const gate = deferred<void>()
    const saveQuestionContext = vi.fn().mockReturnValue(gate.promise)
    vi.stubGlobal('api', { researchWorkspaces: { saveQuestionContext } })
    const actions = { changeDoc: vi.fn(), addAnnotation: vi.fn(), setError: vi.fn() }
    const { rerender } = renderHook(
      ({ text }) =>
        useWorkspaceResearchContext({
          controller,
          draftKey: 'source-draft',
          editable: true,
          composer: { view: { doc: doc(text), annotations: [] }, actions }
        }),
      { initialProps: { text: 'Why?' } }
    )
    act(() => useResearchWorkspaceStore.getState().ask(context))
    await waitFor(() => expect(saveQuestionContext).toHaveBeenCalledTimes(1))
    expect(saveQuestionContext.mock.calls[0][0].context.evidence).toHaveLength(108)
    expect(actions.addAnnotation).not.toHaveBeenCalled()
    rerender({ text: 'Why? Preserve my newer explanation.' })
    await act(async () => gate.resolve())
    await waitFor(() => expect(actions.addAnnotation).toHaveBeenCalledTimes(1))
    const annotation = actions.addAnnotation.mock.calls[0][0]
    expect(replayAnnotationTarget(annotation)?.contextId).toBe(
      saveQuestionContext.mock.calls[0][0].context.id
    )
    expect(annotation.quote).toContain(context.excerpt)
    expect(annotation.quote).toContain('Preview is truncated.')
    expect(annotation.quote.length).toBeLessThanOrEqual(4000)
    expect(actions.changeDoc.mock.lastCall?.[0]).toEqual(doc('Why? Preserve my newer explanation.'))
    expect(useResearchWorkspaceStore.getState().pendingQuestion).toBeUndefined()
  })
  it('keeps a saved pending question without inserting into a different draft after navigation', async () => {
    const gate = deferred<void>()
    vi.stubGlobal('api', {
      researchWorkspaces: { saveQuestionContext: vi.fn().mockReturnValue(gate.promise) }
    })
    const actions = { changeDoc: vi.fn(), addAnnotation: vi.fn(), setError: vi.fn() }
    renderHook(() =>
      useWorkspaceResearchContext({
        controller,
        draftKey: 'source-draft',
        editable: true,
        composer: { view: { doc: doc('Why?'), annotations: [] }, actions }
      })
    )
    act(() => useResearchWorkspaceStore.getState().ask(context))
    actions.changeDoc.mockClear()
    act(() =>
      useNavigationStore.setState({ activeProjectId: 'elsewhere', explicitNavigationRevision: 2 })
    )
    await act(async () => gate.resolve())
    expect(actions.addAnnotation).not.toHaveBeenCalled()
    expect(actions.changeDoc).not.toHaveBeenCalled()
    expect(useResearchWorkspaceStore.getState().pendingQuestion).toBe(context)
  })
  it('resolves new annotations through the immutable local snapshot and ignores a late reveal after navigation', async () => {
    const gate = deferred<ReplayQuestionContext>()
    const getQuestionContext = vi.fn().mockReturnValue(gate.promise)
    vi.stubGlobal('api', { researchWorkspaces: { getQuestionContext } })
    const open = vi.spyOn(usePreviewWorkbenchStore.getState(), 'upsertAndActivateItem')
    const actions = { changeDoc: vi.fn(), addAnnotation: vi.fn(), setError: vi.fn() }
    renderHook(() =>
      useWorkspaceResearchContext({
        controller,
        draftKey: 'source-draft',
        editable: true,
        composer: { view: { doc: doc('Why?'), annotations: [] }, actions }
      })
    )
    const annotation = createReplayStepAnnotation(context, 'context-id')!
    act(() => {
      document.dispatchEvent(new CustomEvent('annotation-reveal-prepare', { detail: annotation }))
      document.dispatchEvent(new CustomEvent('annotation-reveal', { detail: annotation.id }))
    })
    expect(getQuestionContext).toHaveBeenCalledWith({ projectId: 'p', id: 'context-id' })
    act(() => useNavigationStore.setState({ explicitNavigationRevision: 2 }))
    await act(async () => gate.resolve({ ...context, id: 'context-id' }))
    expect(open).not.toHaveBeenCalled()
  })
  it('reveals the saved position without switching the discussion and reports a missing local snapshot', async () => {
    const getQuestionContext = vi.fn().mockResolvedValue({ ...context, id: 'context-id' })
    vi.stubGlobal('api', { researchWorkspaces: { getQuestionContext } })
    const open = vi
      .spyOn(usePreviewWorkbenchStore.getState(), 'upsertAndActivateItem')
      .mockImplementation(() => {})
    const actions = { changeDoc: vi.fn(), addAnnotation: vi.fn(), setError: vi.fn() }
    renderHook(() =>
      useWorkspaceResearchContext({
        controller,
        draftKey: 'source-draft',
        editable: true,
        composer: { view: { doc: doc('Why?'), annotations: [] }, actions }
      })
    )
    const annotation = createReplayStepAnnotation(context, 'context-id')!
    await act(async () => {
      document.dispatchEvent(new CustomEvent('annotation-reveal-prepare', { detail: annotation }))
      document.dispatchEvent(new CustomEvent('annotation-reveal', { detail: annotation.id }))
    })
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'p', replaySourceSessionId: 'source' })
    )
    expect(consumeReplaySeek('p', 'source')).toMatchObject({
      stepId: context.stepId,
      stepOffsetMs: 123
    })
    expect(useNavigationStore.getState().researchWorkspace).toEqual(research)
    getQuestionContext.mockResolvedValueOnce(undefined)
    await act(async () => {
      document.dispatchEvent(new CustomEvent('annotation-reveal-prepare', { detail: annotation }))
    })
    expect(actions.setError).toHaveBeenCalledWith(
      'This replay reference is unavailable on this device.'
    )
    expect(open).toHaveBeenCalledTimes(1)
  })
})
