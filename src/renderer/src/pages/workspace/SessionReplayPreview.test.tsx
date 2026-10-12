// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createI18nTestStub } from '../../../../../test/i18n-test-stub'
import { useNavigationStore } from '@/stores/navigation-store'
import { useSessionStore, type ChatSession } from '@/stores/session-store'
import { useSessionReplayStore } from '@/stores/session-replay-store'
import { usePreviewWorkbenchStore, type PreviewToolItem } from '@/stores/preview-workbench-store'
import type { ReplayDocument, ReplayResource, ReplayStep } from '../../../../shared/replay'
import type { ReplayViewState, SessionReplaySnapshot } from '../../../../shared/session-replay'
import { SessionReplayPreview } from './SessionReplayPreview'
import type { ReplayPanelProps } from './replay/ReplayPanel'

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  panel: vi.fn(),
  get: vi.fn(),
  save: vi.fn(),
  discuss: vi.fn()
}))
vi.mock('./workspace-discussion-navigation', () => ({ openResearchDiscussion: mocks.discuss }))
vi.mock('react-i18next', () => createI18nTestStub())
vi.mock('@/lib/replay', () => ({ loadReplayDocument: mocks.load }))
vi.mock('@/lib/session-fork', () => ({ sessionForkAvailable: () => false, forkSession: vi.fn() }))
vi.mock('./replay/ReplayPanel', () => ({
  ReplayPanel: (props: ReplayPanelProps) => {
    mocks.panel(props)
    return (
      <div data-testid="replay-panel" data-active={String(props.active)}>
        {props.document.source.title}
        <button data-replay-browse-steps>Browse steps</button>
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
  generatorVersion: 3,
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
  generatorVersion: 3,
  branchId: 'main',
  timeMs: 1,
  rate: 1
}
const snapshot = (sourceSessionId: string, revision = 0): SessionReplaySnapshot => ({
  projectId: 'project',
  sourceSessionId,
  sourceStatus: 'available',
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
  useSessionReplayStore.setState({ snapshots: {}, pendingDiscussion: undefined })
  usePreviewWorkbenchStore.setState({ expandedToolItemId: null })
  mocks.load.mockImplementation(async (_api, request) => doc(request.sessionId))
  mocks.get.mockImplementation(async (request) =>
    snapshot(request.sourceSessionId, request.sourceSessionId === 'other' ? 7 : 1)
  )
  mocks.discuss.mockResolvedValue(true)
  mocks.save.mockResolvedValue({ status: 'saved', revision: 2 })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { sessionReplay: { get: mocks.get, saveView: mocks.save } }
  })
})
afterEach(cleanup)

describe('SessionReplayPreview lifecycle', () => {
  it.each(['Source files', 'Original records', 'evidence'])(
    'reveals the existing player from %s without reloading or stealing focus',
    async (mode) => {
      const mounted = render(<SessionReplayPreview item={item()} />)
      const player = await screen.findByTestId('replay-panel')
      const initialView = props().initialView
      fireEvent.click(
        screen.getByRole('button', { name: mode === 'evidence' ? 'Original records' : mode })
      )
      if (mode === 'evidence') {
        fireEvent.click(screen.getByRole('button', { name: /Complete original recorded question/ }))
        await waitFor(() =>
          expect(document.activeElement).toBe(
            screen.getByRole('button', { name: 'Back to original records' })
          )
        )
      }
      expect(props().active).toBe(false)
      // An ordinary tab round-trip must retain the selected materials view.
      mounted.rerender(<SessionReplayPreview item={item()} isActive={false} />)
      mounted.rerender(<SessionReplayPreview item={item()} isActive />)
      expect(props().active).toBe(false)
      // The invoking control remains focused when explicit navigation exits evidence.
      const invokingControl = screen.getByRole('button', { name: 'Replay' })
      invokingControl.focus()
      mounted.rerender(
        <SessionReplayPreview item={{ ...item(), replayRevealRequest: 1 }} isActive />
      )
      expect(props().active).toBe(true)
      expect(screen.getByTestId('replay-panel')).toBe(player)
      expect(props().initialView).toBe(initialView)
      expect(screen.queryByRole('region', { name: 'Original recorded evidence' })).toBeNull()
      await act(async () => {
        await new Promise((resolve) => requestAnimationFrame(resolve))
      })
      expect(document.activeElement).toBe(invokingControl)
      expect(mocks.load).toHaveBeenCalledTimes(1)
      expect(mocks.get).toHaveBeenCalledTimes(1)

      fireEvent.click(screen.getByRole('button', { name: 'Source files' }))
      mounted.rerender(
        <SessionReplayPreview item={{ ...item(), replayRevealRequest: 1 }} isActive />
      )
      expect(props().active).toBe(false)
      mounted.rerender(
        <SessionReplayPreview item={{ ...item(), replayRevealRequest: 2 }} isActive />
      )
      expect(props().active).toBe(true)
      expect(screen.getByTestId('replay-panel')).toBe(player)
    }
  )

  it('browses original records and source files without changing conversation or restarting replay', async () => {
    render(<SessionReplayPreview item={item()} />)
    await screen.findByTestId('replay-panel')
    const selected = useSessionStore.getState().selectedSessionId
    fireEvent.click(screen.getByRole('button', { name: 'Original records' }))
    expect(props().active).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: /Complete original recorded question/ }))
    expect(await screen.findByRole('region', { name: 'Original recorded evidence' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Back to original records' }))
    fireEvent.click(screen.getByRole('button', { name: 'Source files' }))
    expect(screen.getByText('No source files are available.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Replay' }))
    expect(props().active).toBe(true)
    expect(mocks.load).toHaveBeenCalledTimes(1)
    expect(useSessionStore.getState().selectedSessionId).toBe(selected)
  })

  it('defers restored background archives until activation and retains them across tab switches', async () => {
    const mounted = render(<SessionReplayPreview item={item()} isActive={false} />)
    await act(async () => {})
    expect(mocks.load).not.toHaveBeenCalled()
    expect(mocks.get).not.toHaveBeenCalled()
    mounted.rerender(<SessionReplayPreview item={item()} isActive />)
    await screen.findByTestId('replay-panel')
    mounted.rerender(<SessionReplayPreview item={item()} isActive={false} />)
    mounted.rerender(<SessionReplayPreview item={item()} isActive />)
    expect(mocks.load).toHaveBeenCalledTimes(1)
    expect(mocks.get).toHaveBeenCalledTimes(1)
    expect(props().active).toBe(true)
  })

  it('opens the conversation chooser only through the explicit secondary action', async () => {
    useNavigationStore.setState({ activeProjectId: 'project' })
    render(<SessionReplayPreview item={item()} />)
    await screen.findByTestId('replay-panel')
    act(() =>
      props().onChooseConversation?.({
        projectId: 'project',
        sourceSessionId: 'source',
        sourceTitle: 'Study',
        fingerprint: 'hash',
        branchId: 'main',
        stepId: step.id,
        stepOffsetMs: 0,
        evidence: [],
        excerpt: 'Question'
      })
    )
    expect(await screen.findByRole('dialog', { name: 'Ask in a conversation' })).toBeTruthy()
    expect(useSessionReplayStore.getState().pendingDiscussion).toBeUndefined()
  })
  it('opens discussion directly and prevents duplicate lookup while it is pending', async () => {
    let finish!: (value: boolean) => void
    mocks.discuss.mockReturnValue(
      new Promise<boolean>((resolve) => {
        finish = resolve
      })
    )
    render(<SessionReplayPreview item={item()} />)
    await screen.findByTestId('replay-panel')
    const capture = {
      projectId: 'project',
      sourceSessionId: 'source',
      sourceTitle: 'Study',
      fingerprint: 'hash',
      branchId: 'main',
      stepId: step.id,
      stepOffsetMs: 0,
      evidence: [],
      excerpt: 'Question'
    }
    act(() => {
      props().onAskStep(capture)
      props().onAskStep(capture)
    })
    expect(mocks.discuss).toHaveBeenCalledTimes(1)
    expect(props().discussionPending).toBe(true)
    expect(screen.queryByRole('dialog')).toBeNull()
    await act(async () => finish(false))
    expect(props().discussionPending).toBe(false)
    expect(screen.getByText('Could not open the research discussion. Please retry.')).toBeTruthy()
  })
  it('loads paused history and forwards active visibility changes', async () => {
    const mounted = render(<SessionReplayPreview item={item()} />)
    await screen.findByTestId('replay-panel')
    expect(props().initialView).toEqual(view)
    expect(props().active).toBe(true)
    mounted.rerender(<SessionReplayPreview item={item()} isActive={false} />)
    expect(props().active).toBe(false)
  })

  it('offers an explicit retry for a failed checkpoint without reloading the replay', async () => {
    mocks.save.mockRejectedValueOnce(new Error('Storage unavailable'))
    render(<SessionReplayPreview item={item()} />)
    await screen.findByTestId('replay-panel')
    act(() => props().onViewChange?.(view))
    await screen.findByText('Storage unavailable')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.queryByText('Storage unavailable')).toBeNull())
    expect(mocks.load).toHaveBeenCalledTimes(1)
    expect(mocks.save).toHaveBeenCalledTimes(2)
    expect(mocks.save.mock.calls[1][0]).toMatchObject({ state: view, expectedRevision: 1 })
  })

  it('isolates old save replies from a newly selected source', async () => {
    let finish!: (value: unknown) => void
    mocks.save.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    const mounted = render(<SessionReplayPreview item={item()} />)
    await screen.findByTestId('replay-panel')
    act(() => props().onViewChange?.(view))
    mounted.rerender(<SessionReplayPreview item={item('other')} />)
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
    render(<SessionReplayPreview item={item()} />)
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
    render(<SessionReplayPreview item={item()} />)
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
    render(<SessionReplayPreview item={item()} />)
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
    render(<SessionReplayPreview item={item()} />)
    await screen.findByTestId('replay-panel')
    act(() => props().onOpenEvidence(undefined, step))
    expect(screen.getByText('Complete original recorded question')).toBeTruthy()
    expect(props().active).toBe(false)
    const back = screen.getByRole('button', { name: 'Back to replay' })
    await waitFor(() => expect(document.activeElement).toBe(back))
    fireEvent.keyDown(back, { key: 'Escape' })
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Browse steps' }))
    )
    expect(screen.queryByText('Complete original recorded question')).toBeNull()
    expect(props().active).toBe(true)
  })

  it('pins exact artifact versions and reports unavailable evidence without a head fallback', async () => {
    const open = vi.spyOn(usePreviewWorkbenchStore.getState(), 'upsertAndActivateItem')
    const resource: ReplayResource = {
      id: 'artifact-version:v1',
      name: 'figure.png',
      projectId: 'project',
      sessionId: 'source',
      artifactId: 'figure',
      versionId: 'v1',
      locator: '/mutable/figure.png',
      availability: 'recorded'
    }
    mocks.load.mockResolvedValue({ ...doc(), resources: [resource] })
    render(<SessionReplayPreview item={item()} />)
    await screen.findByTestId('replay-panel')
    act(() => props().onOpenEvidence(resource, step))
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({
        selectedVersionId: 'v1',
        artifactId: 'figure',
        managedFileId: 'figure',
        source: 'artifact',
        path: expect.stringContaining('v1')
      })
    )
    expect(open.mock.calls[0][0]).not.toHaveProperty('path', resource.locator)
    act(() => props().onOpenEvidence({ ...resource, versionId: undefined }, step))
    expect(open).toHaveBeenCalledTimes(1)
    expect(screen.getByText('The recorded evidence is unavailable.')).toBeTruthy()
    open.mockRestore()
  })

  it.each(['archive.zip', 'notes.txt'])(
    'opens archived upload %s at its exact Version and original storage owner',
    async (name) => {
      const open = vi.spyOn(usePreviewWorkbenchStore.getState(), 'upsertAndActivateItem')
      const resource: ReplayResource = {
        id: 'upload-version:old-version',
        source: 'upload',
        name,
        projectId: 'project',
        sessionId: 'original-upload-owner',
        fileId: 'uploaded-file',
        versionId: 'old-version',
        versionNumber: 2,
        locator: '/mutable/latest-file',
        availability: 'recorded'
      }
      const resourceStep = { ...step, resourceIds: [resource.id] }
      mocks.load.mockResolvedValue({
        ...doc(),
        resources: [resource],
        branches: [{ ...doc().branches[0], steps: [resourceStep] }]
      })
      render(<SessionReplayPreview item={item()} />)
      await screen.findByTestId('replay-panel')
      act(() => props().onOpenEvidence(resource, resourceStep))
      expect(open).toHaveBeenLastCalledWith(
        expect.objectContaining({
          projectId: 'project',
          sessionId: 'original-upload-owner',
          source: 'upload',
          name,
          managedFileId: 'uploaded-file',
          selectedVersionId: 'old-version',
          versionNumber: 2,
          path: 'upload-version:project/original-upload-owner/uploaded-file/old-version'
        })
      )
      expect(open.mock.lastCall![0]).not.toHaveProperty('artifactId')
      expect(open.mock.lastCall![0]).toHaveProperty(
        'format',
        name.endsWith('.zip') ? 'unknown' : 'text'
      )
      // The static evidence view uses the same archive-scoped upload action as the material drawer.
      act(() => props().onOpenEvidence(undefined, resourceStep))
      fireEvent.click(screen.getByRole('button', { name: `${name} Version 2` }))
      expect(open).toHaveBeenCalledTimes(2)
      expect(open.mock.calls[1][0]).toEqual(open.mock.calls[0][0])
      expect(screen.queryByText('The recorded evidence is unavailable.')).toBeNull()
      open.mockRestore()
    }
  )

  it('rejects foreign and incomplete resources instead of trusting caller metadata or a mutable path', async () => {
    const open = vi.spyOn(usePreviewWorkbenchStore.getState(), 'upsertAndActivateItem')
    const resource: ReplayResource = {
      id: 'upload-version:old-version',
      source: 'upload',
      name: 'archived.txt',
      projectId: 'project',
      sessionId: 'upload-owner',
      fileId: 'upload',
      versionId: 'old-version',
      availability: 'recorded'
    }
    const unavailable = { ...resource, id: 'unavailable', availability: 'unavailable' as const }
    const unversioned = {
      ...resource,
      id: 'unversioned',
      versionId: undefined,
      locator: '/mutable/latest'
    }
    const foreignProject = { ...resource, id: 'foreign-project', projectId: 'another-project' }
    const foreignArtifact = {
      ...resource,
      id: 'foreign-artifact',
      source: 'artifact' as const,
      artifactId: 'foreign',
      fileId: undefined
    }
    mocks.load.mockResolvedValue({
      ...doc(),
      resources: [resource, unavailable, unversioned, foreignProject, foreignArtifact]
    })
    render(<SessionReplayPreview item={item()} />)
    await screen.findByTestId('replay-panel')
    for (const invalid of [
      { ...resource, id: 'not-in-this-archive' },
      { ...resource, projectId: 'another-project' },
      { ...resource, sessionId: 'another-owner' },
      { ...resource, fileId: 'another-file' },
      { ...resource, versionId: 'latest-version' },
      { ...resource, source: 'artifact' as const, artifactId: 'upload' },
      unavailable,
      unversioned,
      foreignProject,
      foreignArtifact
    ])
      act(() => props().onOpenEvidence(invalid, step))
    expect(open).not.toHaveBeenCalled()
    expect(screen.getByText('The recorded evidence is unavailable.')).toBeTruthy()
    open.mockRestore()
  })
})

it('keeps available history visible with a retryable Notebook error without saving an incomplete timeline', async () => {
  mocks.load.mockResolvedValueOnce({ ...doc(), issues: [{ code: 'notebook-unavailable' }] })
  render(<SessionReplayPreview item={item()} />)
  expect(await screen.findByText('Recorded Notebook details are unavailable.')).toBeTruthy()
  expect(screen.getByTestId('replay-panel')).toBeTruthy()
  expect(mocks.panel.mock.lastCall?.[0].onViewChange).toBeUndefined()
  fireEvent.click(screen.getByRole('button', { name: /^Retry$/ }))
  await screen.findByTestId('replay-panel')
  expect(mocks.panel.mock.lastCall?.[0].onViewChange).toEqual(expect.any(Function))
  expect(mocks.load).toHaveBeenCalledTimes(2)
})
