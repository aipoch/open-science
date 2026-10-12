// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
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
  discuss: vi.fn(),
  file: vi.fn()
}))
vi.mock('./workspace-discussion-navigation', () => ({
  openResearchDiscussion: mocks.discuss,
  researchSourceFromSession: () => undefined
}))
vi.mock('./replay/ReplayFilePreview', () => ({
  default: (props: { resource: ReplayResource }) => {
    mocks.file(props.resource)
    return <div data-testid="static-file" />
  }
}))
vi.mock('react-i18next', () => createI18nTestStub())
vi.mock('@/lib/replay', () => ({ loadReplayDocument: mocks.load }))
vi.mock('@/lib/session-fork', () => ({ sessionForkAvailable: () => false, forkSession: vi.fn() }))
vi.mock('./replay/ResearchDemoPanel', () => ({
  ResearchDemoPanel: ({ source }: { source: { sourceImportId: string } }) => (
    <div data-testid="offline-demo-panel" data-source-import={source.sourceImportId} />
  )
}))
vi.mock('./replay/ReplayPanel', () => ({
  ReplayPanel: (props: ReplayPanelProps) => {
    mocks.panel(props)
    const [timeMs, setTimeMs] = useState(props.initialView?.timeMs ?? 0)
    return (
      <div data-testid="replay-panel" data-active={String(props.active)} data-time-ms={timeMs}>
        {props.document.source.title}
        {props.active ? props.info : null}
        <button onClick={() => setTimeMs(500)}>Play</button>
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
  it('keeps imported Replay read-only and leaves discussion and execution separate', async () => {
    useSessionStore.setState({
      sessions: [{ ...session('source'), importedResearch: { importId: 'exact-import' } }],
      selectedSessionId: 'discussion'
    })
    render(<SessionReplayPreview item={item()} />)
    await screen.findByTestId('replay-panel')
    expect(screen.queryByRole('button', { name: 'Offline demo' })).toBeNull()
    expect(props().materialViews?.map((view) => view.id)).toEqual(['project', 'results'])
    expect(useSessionStore.getState().selectedSessionId).toBe('discussion')
    expect(mocks.discuss).not.toHaveBeenCalled()
  })
  it('discovers each saved recording version and opens its receiving identity without changing the conversation', async () => {
    mocks.load.mockResolvedValue({
      ...doc(),
      resources: [1, 2].map((number) => ({
        id: `v${number}`,
        projectId: 'project',
        sessionId: 'source',
        artifactId: 'archive',
        versionId: `v${number}`,
        versionNumber: number,
        name: 'renamed.json',
        mimeType: 'application/json',
        availability: 'recorded'
      }))
    })
    Object.assign(window.api, {
      artifacts: {
        readPreview: vi.fn().mockResolvedValue({
          content: '{"format":"open-science-run-observation","version":1}',
          encoding: 'utf8',
          truncated: false,
          size: 58
        })
      },
      observations: { openRecorded: vi.fn() }
    })
    const selected = useSessionStore.getState().selectedSessionId
    render(<SessionReplayPreview item={item()} />)
    await screen.findByTestId('replay-panel')
    expect(props().active).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Run recordings' }))
    const open = await screen.findAllByRole('button', { name: 'View saved run recording' })
    expect(open).toHaveLength(2)
    expect(
      screen.getByRole('button', { name: 'Run recordings' }).getAttribute('aria-pressed')
    ).toBe('true')
    expect(props().active).toBe(false)
    fireEvent.click(open[0])
    expect(props().materialViewRequest?.id).toBe('project')
    expect(props().active).toBe(true)
    expect(usePreviewWorkbenchStore.getState().items).toHaveLength(0)
    expect(window.api.observations.openRecorded).not.toHaveBeenCalled()
    expect(useSessionStore.getState().selectedSessionId).toBe(selected)
  })

  it('keeps the user-selected materials view when recording discovery arrives later', async () => {
    let resolve!: (value: unknown) => void
    mocks.load.mockResolvedValue({
      ...doc(),
      resources: [
        {
          id: 'v',
          projectId: 'project',
          sessionId: 'source',
          artifactId: 'archive',
          versionId: 'v',
          name: 'saved.json',
          availability: 'recorded'
        }
      ]
    })
    Object.assign(window.api, {
      artifacts: {
        readPreview: vi.fn().mockImplementation(
          () =>
            new Promise((done) => {
              resolve = done
            })
        )
      },
      observations: { openRecorded: vi.fn() }
    })
    render(<SessionReplayPreview item={item()} />)
    await screen.findByText('Preparing recorded material…')
    fireEvent.click(screen.getByRole('button', { name: 'Source files' }))
    await act(async () =>
      resolve({
        content: '{"format":"open-science-run-observation","version":1}',
        encoding: 'utf8',
        truncated: false,
        size: 58
      })
    )
    expect(screen.getByRole('button', { name: 'Source files' }).getAttribute('aria-pressed')).toBe(
      'true'
    )
    expect(screen.queryByRole('button', { name: 'View saved run recording' })).toBeNull()
  })

  it.each(['play', 'pointer-seek', 'seek-key', 'wheel'] as const)(
    'initializes one clock before %s and retains it while inspecting discovered archives',
    async (interaction) => {
      let resolve!: (value: unknown) => void
      mocks.load.mockResolvedValue({
        ...doc(),
        resources: [
          {
            id: 'v',
            projectId: 'project',
            sessionId: 'source',
            artifactId: 'archive',
            versionId: 'v',
            name: 'saved.json',
            availability: 'recorded'
          }
        ]
      })
      Object.assign(window.api, {
        artifacts: {
          readPreview: vi.fn().mockImplementation(
            () =>
              new Promise((done) => {
                resolve = done
              })
          )
        },
        observations: { openRecorded: vi.fn() }
      })
      render(<SessionReplayPreview item={item()} />)
      await screen.findByText('Preparing recorded material…')
      expect(screen.queryByTestId('replay-panel')).toBeNull()
      await act(async () =>
        resolve({
          content: '{"format":"open-science-run-observation","version":1}',
          encoding: 'utf8',
          truncated: false,
          size: 58
        })
      )
      const player = await screen.findByTestId('replay-panel')
      // Exercise each input path independently so a click cannot mask a missing keyboard,
      // pointer-seek or wheel capture handler. The player remains mounted at its own position.
      if (interaction === 'play') {
        fireEvent.click(screen.getByRole('button', { name: 'Play' }))
      } else if (interaction === 'pointer-seek') {
        fireEvent.pointerDown(player)
      } else if (interaction === 'seek-key') {
        fireEvent.keyDown(player, { key: 'ArrowRight' })
      } else {
        fireEvent.wheel(player, { deltaY: 80 })
      }
      const playhead = player.getAttribute('data-time-ms')
      expect(
        screen.getByRole('button', { name: 'Session process' }).getAttribute('aria-pressed')
      ).toBe('true')
      expect(props().active).toBe(true)
      expect(screen.getByTestId('replay-panel')).toBe(player)
      expect(player.getAttribute('data-time-ms')).toBe(playhead)
      if (interaction === 'play') expect(playhead).toBe('500')
      expect(screen.queryByRole('button', { name: 'View saved run recording' })).toBeNull()
    }
  )

  it('honors an explicit Notebook reveal of the saved-recordings tab', async () => {
    const mounted = render(<SessionReplayPreview item={item()} />)
    await screen.findByTestId('replay-panel')
    mounted.rerender(
      <SessionReplayPreview
        item={{ ...item(), replayRevealMode: 'runs', replayRevealRequest: 10 }}
      />
    )
    expect(
      screen.getByRole('button', { name: 'Run recordings' }).getAttribute('aria-pressed')
    ).toBe('true')
    expect(props().active).toBe(false)
    expect(mocks.load).toHaveBeenCalledTimes(1)
  })

  it('never displays a late recording candidate from the previously selected import', async () => {
    let resolve!: (value: unknown) => void
    mocks.load.mockImplementation(async (_api, request) => ({
      ...doc(request.sessionId),
      resources:
        request.sessionId === 'source'
          ? [
              {
                id: 'v',
                projectId: 'project',
                sessionId: 'source',
                artifactId: 'archive',
                versionId: 'v',
                name: 'prior-import.json',
                availability: 'recorded'
              }
            ]
          : []
    }))
    Object.assign(window.api, {
      artifacts: {
        readPreview: vi.fn().mockImplementation(
          () =>
            new Promise((done) => {
              resolve = done
            })
        )
      },
      observations: { openRecorded: vi.fn() }
    })
    const mounted = render(<SessionReplayPreview item={item()} />)
    await screen.findByText('Preparing recorded material…')
    mounted.rerender(<SessionReplayPreview item={item('other')} />)
    await waitFor(() => expect(props().document.source.sessionId).toBe('other'))
    await act(async () =>
      resolve({
        content: '{"format":"open-science-run-observation","version":1}',
        encoding: 'utf8',
        truncated: false,
        size: 58
      })
    )
    fireEvent.click(screen.getByRole('button', { name: 'Run recordings' }))
    expect(screen.queryByText('prior-import.json')).toBeNull()
    expect(
      await screen.findByText(
        'No saved run recordings were found. The session process is available in the other tab.'
      )
    ).toBeTruthy()
  })

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
      const invokingControl = document.createElement('button')
      invokingControl.textContent = 'View replay from conversation'
      document.body.append(invokingControl)
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
      invokingControl.remove()
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
    fireEvent.click(screen.getByRole('button', { name: 'Session process' }))
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
  it.each(['question', 'chooser'] as const)(
    'freezes the %s reference before leaving research fullscreen and waits before native handoff',
    async (action) => {
      useNavigationStore.setState({ activeProjectId: 'project' })
      let finish!: () => void
      const exit = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve
          })
      )
      const full = document.createElement('div')
      full.dataset.replayPresentation = 'research'
      Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => full })
      Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: exit })
      try {
        render(<SessionReplayPreview item={item()} />)
        await screen.findByTestId('replay-panel')
        const capture = {
          projectId: 'project',
          sourceSessionId: 'source',
          sourceTitle: 'Study',
          fingerprint: 'hash',
          branchId: 'main',
          stepId: step.id,
          stepOffsetMs: 123,
          evidence: [],
          excerpt: 'Original frozen question',
          stepTitle: 'Original frozen title'
        }
        act(() =>
          action === 'question'
            ? props().onAskStep(capture)
            : props().onChooseConversation?.(capture)
        )
        capture.excerpt = 'Changed after capture'
        capture.stepTitle = 'Changed after capture'
        expect(exit).toHaveBeenCalledTimes(1)
        expect(mocks.discuss).not.toHaveBeenCalled()
        expect(screen.queryByRole('dialog')).toBeNull()
        await act(async () => finish())
        if (action === 'question') {
          expect(mocks.discuss).toHaveBeenCalledWith(
            expect.objectContaining({ stepOffsetMs: 123, excerpt: 'Original frozen question' }),
            expect.any(AbortSignal)
          )
        } else {
          expect(await screen.findByRole('dialog', { name: 'Ask in a conversation' })).toBeTruthy()
          expect(screen.getByText('Original frozen title')).toBeTruthy()
        }
      } finally {
        Reflect.deleteProperty(document, 'fullscreenElement')
        Reflect.deleteProperty(document, 'exitFullscreen')
      }
    }
  )

  it('does not deliver a fullscreen question after its source preview was replaced', async () => {
    let finish!: () => void
    const full = document.createElement('div')
    full.dataset.replayPresentation = 'research'
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => full })
    Object.defineProperty(document, 'exitFullscreen', {
      configurable: true,
      value: () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    })
    try {
      const mounted = render(<SessionReplayPreview item={item()} />)
      await screen.findByTestId('replay-panel')
      act(() =>
        props().onAskStep({
          projectId: 'project',
          sourceSessionId: 'source',
          sourceTitle: 'Study',
          fingerprint: 'hash',
          branchId: 'main',
          stepId: step.id,
          stepOffsetMs: 123,
          evidence: [],
          excerpt: 'Old source'
        })
      )
      mounted.rerender(<SessionReplayPreview item={item('other')} />)
      await waitFor(() => expect(props().document.source.sessionId).toBe('other'))
      await act(async () => finish())
      expect(mocks.discuss).not.toHaveBeenCalled()
    } finally {
      Reflect.deleteProperty(document, 'fullscreenElement')
      Reflect.deleteProperty(document, 'exitFullscreen')
    }
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
    act(() => props().onOpenEvidence?.(undefined, step))
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

  it('pins exact artifact versions in the inert reader and reports unavailable evidence without a head fallback', async () => {
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
    act(() => props().onOpenEvidence?.(resource, step))
    expect(mocks.file.mock.lastCall![0]).toMatchObject({
      versionId: 'v1',
      artifactId: 'figure',
      locator: expect.stringContaining('v1')
    })
    expect(mocks.file.mock.lastCall![0].locator).not.toBe(resource.locator)
    expect(props().active).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Back to recording' }))
    act(() => props().onOpenEvidence?.({ ...resource, versionId: undefined }, step))
    expect(screen.getByText('The recorded evidence is unavailable.')).toBeTruthy()
  })
  it.each(['archive.zip', 'notes.txt'])(
    'opens archived upload %s at its exact Version and original owner in the static reader',
    async (name) => {
      const resource: ReplayResource = {
        id: 'upload-version:old-version',
        source: 'upload',
        name,
        projectId: 'project',
        sessionId: 'original-upload-owner',
        fileId: 'uploaded-file',
        versionId: 'old-version',
        versionNumber: 2,
        availability: 'recorded'
      }
      mocks.load.mockResolvedValue({ ...doc(), resources: [resource] })
      render(<SessionReplayPreview item={item()} />)
      await screen.findByTestId('replay-panel')
      act(() => props().onOpenEvidence?.(resource, step))
      expect(mocks.file.mock.lastCall![0]).toMatchObject({
        ...resource,
        locator: 'upload-version:project/original-upload-owner/uploaded-file/old-version'
      })
      expect(usePreviewWorkbenchStore.getState().items).toHaveLength(0)
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
      act(() => props().onOpenEvidence?.(invalid, step))
    expect(open).not.toHaveBeenCalled()
    expect(screen.getByText('The recorded evidence is unavailable.')).toBeTruthy()
    open.mockRestore()
  })
})

it('keeps available history visible with a retryable Notebook error without saving an incomplete timeline', async () => {
  mocks.load.mockResolvedValueOnce({ ...doc(), issues: [{ code: 'notebook-unavailable' }] })
  render(<SessionReplayPreview item={item()} />)
  expect(await screen.findByText('Recorded Notebook details are unavailable.')).toBeTruthy()
  expect(await screen.findByTestId('replay-panel')).toBeTruthy()
  expect(mocks.panel.mock.lastCall?.[0].onViewChange).toBeUndefined()
  fireEvent.click(screen.getByRole('button', { name: /^Retry$/ }))
  await screen.findByTestId('replay-panel')
  expect(mocks.panel.mock.lastCall?.[0].onViewChange).toEqual(expect.any(Function))
  expect(mocks.load).toHaveBeenCalledTimes(2)
})
