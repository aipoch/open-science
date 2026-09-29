// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createI18nTestStub } from '../../../../../test/i18n-test-stub'
import { useNavigationStore } from '@/stores/navigation-store'
import { useSessionStore, type ChatSession } from '@/stores/session-store'
import { useResearchWorkspaceStore } from '@/stores/research-workspace-store'
import { usePreviewWorkbenchStore, type PreviewToolItem } from '@/stores/preview-workbench-store'
import type { ReplayDocument, ReplayStep } from '../../../../shared/replay'
import type {
  ReplayViewState,
  ResearchWorkspaceSnapshot
} from '../../../../shared/research-workspace'
import { ResearchReplayPreview } from './ResearchReplayPreview'
import type { ReplayPanelProps } from './replay/ReplayPanel'

const mocks = vi.hoisted(() => ({ load: vi.fn(), panel: vi.fn(), get: vi.fn(), save: vi.fn() }))
vi.mock('react-i18next', () => createI18nTestStub())
vi.mock('@/lib/replay', () => ({ loadReplayDocument: mocks.load }))
vi.mock('@/lib/session-fork', () => ({ sessionForkAvailable: () => false, forkSession: vi.fn() }))
vi.mock('./replay/ReplayPanel', () => ({
  ReplayPanel: (props: ReplayPanelProps) => {
    mocks.panel(props)
    return (
      <div data-testid="replay-panel" data-active={String(props.active)}>
        {props.document.source.title}
      </div>
    )
  }
}))
const step: ReplayStep = {
  id: 'message-step',
  kind: 'message',
  branchId: 'main',
  message: {
    id: 'message',
    role: 'user',
    content: 'Complete original recorded question',
    status: 'complete',
    eventIds: [],
    createdAt: 1,
    updatedAt: 1
  },
  evidence: [],
  activities: [],
  runs: [],
  resourceIds: [],
  issues: [],
  startMs: 0,
  durationMs: 1000,
  endMs: 1000
}
const doc = (id = 'source'): ReplayDocument => ({
  generatorVersion: 2,
  presentationVersion: 2,
  source: { projectId: 'project', sessionId: id, title: id, fingerprint: id },
  defaultBranchId: 'main',
  branches: [{ id: 'main', kind: 'conversation', steps: [step], durationMs: 1000 }],
  resources: [],
  issues: []
})
const item = (id = 'source'): PreviewToolItem => ({
  id: `replay:${id}`,
  type: 'tool',
  toolKind: 'replay',
  projectId: 'project',
  sessionId: id,
  replaySourceSessionId: id,
  title: 'Research replay'
})
const view: ReplayViewState = {
  fingerprint: 'source',
  generatorVersion: 2,
  branchId: 'main',
  timeMs: 1,
  rate: 1
}
const snapshot = (sourceSessionId: string, revision = 0): ResearchWorkspaceSnapshot => ({
  projectId: 'project',
  sourceSessionId,
  sourceStatus: 'available',
  discussionStatus: 'none',
  linkRevision: 0,
  ...(revision ? { view: { state: view, revision } } : {})
})
const props = (): ReplayPanelProps => mocks.panel.mock.lastCall![0]
const session = (id: string): ChatSession => ({
  id,
  projectId: 'project',
  title: id,
  status: 'idle' as const,
  cwd: '',
  messages: [],
  createdAt: 1,
  updatedAt: 1
})
beforeEach(() => {
  vi.clearAllMocks()
  useSessionStore.setState({ sessions: [session('source'), session('other')] })
  useResearchWorkspaceStore.setState({ snapshots: {}, pendingQuestion: undefined })
  usePreviewWorkbenchStore.setState({ expandedToolItemId: null })
  mocks.load.mockImplementation(async (_api, request) => doc(request.sessionId))
  mocks.get.mockImplementation(async (request) =>
    snapshot(request.sourceSessionId, request.sourceSessionId === 'other' ? 7 : 1)
  )
  mocks.save.mockResolvedValue({ status: 'saved', revision: 2 })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { researchWorkspaces: { get: mocks.get, saveView: mocks.save } }
  })
})
afterEach(cleanup)

describe('ResearchReplayPreview lifecycle', () => {
  it('uses shared preview expansion and returns Ask to the discussion without losing its context', async () => {
    useNavigationStore.setState({
      activeProjectId: 'project',
      researchWorkspace: { projectId: 'project', sourceSessionId: 'source', sourceTitle: 'source' }
    })
    render(<ResearchReplayPreview item={item()} />)
    await screen.findByTestId('replay-panel')
    expect(props().expanded).toBe(false)
    act(() => props().onToggleExpanded?.())
    expect(props().expanded).toBe(true)
    const context = {
      projectId: 'project',
      sourceSessionId: 'source',
      sourceTitle: 'source',
      fingerprint: 'source',
      branchId: 'main',
      stepId: step.id,
      stepOffsetMs: 30,
      evidence: [],
      excerpt: 'question at recorded step'
    }
    act(() => props().onAskStep?.(context))
    expect(props().expanded).toBe(false)
    expect(useResearchWorkspaceStore.getState().pendingQuestion).toEqual(context)
  })
  it('keeps pending Ask context if cross-source navigation fails', async () => {
    const openSession = vi
      .spyOn(useNavigationStore.getState(), 'openSession')
      .mockReturnValue(false)
    useNavigationStore.setState({ activeProjectId: 'project', researchWorkspace: undefined })
    render(<ResearchReplayPreview item={item()} />)
    await screen.findByTestId('replay-panel')
    const context = {
      projectId: 'project',
      sourceSessionId: 'source',
      sourceTitle: 'source',
      fingerprint: 'source',
      branchId: 'main',
      stepId: step.id,
      stepOffsetMs: 0,
      evidence: [],
      excerpt: 'saved pending question'
    }
    act(() => props().onAskStep?.(context))
    expect(useResearchWorkspaceStore.getState().pendingQuestion).toEqual(context)
    expect(screen.getByText('The source research is unavailable.')).toBeTruthy()
    openSession.mockRestore()
  })

  it('loads paused history and forwards active visibility changes', async () => {
    const mounted = render(<ResearchReplayPreview item={item()} />)
    await screen.findByTestId('replay-panel')
    expect(props().initialView).toEqual(view)
    expect(props().active).toBe(true)
    mounted.rerender(<ResearchReplayPreview item={item()} isActive={false} />)
    expect(props().active).toBe(false)
  })

  it('isolates old save replies from a newly selected source', async () => {
    let finish!: (value: unknown) => void
    mocks.save.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    const mounted = render(<ResearchReplayPreview item={item()} />)
    await screen.findByTestId('replay-panel')
    act(() => props().onViewChange?.(view))
    mounted.rerender(<ResearchReplayPreview item={item('other')} />)
    await waitFor(() => expect(props().document.source.sessionId).toBe('other'))
    await act(async () => finish({ status: 'saved', revision: 99 }))
    act(() => props().onViewChange?.({ ...view, fingerprint: 'other' }))
    expect(mocks.save.mock.calls[1][0]).toMatchObject({
      sourceSessionId: 'other',
      expectedRevision: 7
    })
  })

  it('shows first-load failures with a retry that revalidates the source', async () => {
    mocks.load.mockRejectedValueOnce(new Error('Source read failed'))
    render(<ResearchReplayPreview item={item()} />)
    await screen.findByText('Source read failed')
    expect(screen.queryByTestId('replay-panel')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByTestId('replay-panel')
    expect(mocks.load).toHaveBeenCalledTimes(2)
  })

  it('does not publish a stale initial load after source removal and can retry a restored source', async () => {
    let finish!: (document: ReplayDocument) => void
    mocks.load.mockReturnValueOnce(
      new Promise<ReplayDocument>((resolve) => {
        finish = resolve
      })
    )
    render(<ResearchReplayPreview item={item()} />)
    act(() => useSessionStore.setState({ sessions: [session('other')] }))
    await act(async () => finish(doc()))
    expect(screen.queryByTestId('replay-panel')).toBeNull()
    expect(screen.getByText('The source research is unavailable.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByTestId('replay-panel')
    expect(mocks.load).toHaveBeenCalledTimes(2)
  })

  it('unmounts playback when the loaded source is deleted and ignores late writer callbacks', async () => {
    let fail!: (reason: Error) => void
    mocks.save.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        fail = reject
      })
    )
    render(<ResearchReplayPreview item={item()} />)
    await screen.findByTestId('replay-panel')
    const previous = props()
    act(() => previous.onViewChange?.(view))
    act(() => useSessionStore.setState({ sessions: [session('other')] }))
    expect(screen.queryByTestId('replay-panel')).toBeNull()
    expect(screen.getByText('The source research is unavailable.')).toBeTruthy()
    await act(async () => fail(new Error('Old failed checkpoint')))
    expect(screen.queryByText('Old failed checkpoint')).toBeNull()
    act(() => previous.onViewChange?.(view))
    expect(mocks.save).toHaveBeenCalledTimes(1)
  })

  it('opens complete static step evidence and pauses until returning', async () => {
    render(<ResearchReplayPreview item={item()} />)
    await screen.findByTestId('replay-panel')
    act(() => props().onOpenEvidence(undefined, step))
    expect(screen.getByText('Complete original recorded question')).toBeTruthy()
    expect(props().active).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Back to replay' }))
    expect(screen.queryByText('Complete original recorded question')).toBeNull()
    expect(props().active).toBe(true)
  })

  it('pins exact artifact versions and reports unavailable evidence without a head fallback', async () => {
    const open = vi.spyOn(usePreviewWorkbenchStore.getState(), 'upsertAndActivateItem')
    render(<ResearchReplayPreview item={item()} />)
    await screen.findByTestId('replay-panel')
    const resource = {
      id: 'artifact-version:v1',
      name: 'figure.png',
      projectId: 'project',
      sessionId: 'source',
      artifactId: 'figure',
      versionId: 'v1',
      locator: '/mutable/figure.png',
      availability: 'recorded' as const
    }
    act(() => props().onOpenEvidence(resource, step))
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({
        selectedVersionId: 'v1',
        artifactId: 'figure',
        path: expect.stringContaining('v1')
      })
    )
    expect(open.mock.calls[0][0]).not.toHaveProperty('path', resource.locator)
    act(() => props().onOpenEvidence({ ...resource, versionId: undefined }, step))
    expect(open).toHaveBeenCalledTimes(1)
    expect(screen.getByText('The recorded evidence is unavailable.')).toBeTruthy()
    open.mockRestore()
  })
})
