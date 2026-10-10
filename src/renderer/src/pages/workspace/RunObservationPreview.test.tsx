// @vitest-environment jsdom
import { StrictMode, useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RunObservationSelection } from '../../../../shared/run-observation'
import type { RunObservationViewerAccess } from '../../../../shared/run-observation-viewer'
import { RunObservationPreview } from './RunObservationPreview'
import { useRunObservationQuestion } from './use-run-observation-question'
import { useRunObservationQuestionStore } from '@/stores/run-observation-question-store'
import { usePreviewWorkbenchStore } from '@/stores/preview-workbench-store'
import type { ComposerDoc } from './composer/composer-doc'
const target = { projectId: 'p', sessionId: 's', runId: 'run' }
const access = (viewerId = 'viewer', scope = target): RunObservationViewerAccess => ({
  viewerId,
  target: scope,
  expiresAt: 999999,
  url: `http://viewer-${viewerId}.localhost:56789/__open_science_viewer?grant=${'a'.repeat(64)}`
})
const selected = (): RunObservationSelection => ({
  selectionId: 'selected',
  identity: target,
  cursor: { epoch: 'e', sequence: 1 },
  stepId: 'run:run',
  selectedAt: 3000,
  snapshot: {
    identity: target,
    cursor: { epoch: 'e', sequence: 1 },
    observedAt: 2000,
    phase: 'running',
    stepId: 'run:run',
    run: {
      runId: 'run',
      status: 'running',
      kernelKind: 'bash',
      startedAt: 1000,
      logs: {
        stdout: { text: 'real log', truncated: false, redacted: false },
        stderr: { text: '', truncated: false, redacted: false },
        traceback: { text: '', truncated: false, redacted: false }
      }
    },
    artifacts: [],
    artifactsTruncated: false
  }
})
const install = (): {
  open: ReturnType<typeof vi.fn>
  selection: ReturnType<typeof vi.fn>
  revoke: ReturnType<typeof vi.fn>
} => {
  const api = {
    open: vi.fn().mockResolvedValue(access()),
    selection: vi.fn().mockResolvedValue(null),
    revoke: vi.fn().mockResolvedValue(undefined)
  }
  Object.defineProperty(window, 'api', { configurable: true, value: { observations: api } })
  return api
}
const deferred = <T,>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
afterEach(() => {
  cleanup()
  useRunObservationQuestionStore.setState({
    destination: undefined,
    pending: undefined,
    lastAdded: undefined
  })
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('desktop scoped Run observation preview', () => {
  it('opts into the shared clock without changing the exact desktop navigation grant URL', async () => {
    const api = install()
    const receiving = {
      projectId: 'p',
      sessionId: 's',
      artifactId: 'recording',
      versionId: 'version'
    }
    const issued = {
      ...access('recorded'),
      target: receiving,
      mode: 'recorded',
      format: 'web-recording'
    }
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        observations: { ...api, openRecorded: vi.fn().mockResolvedValue(issued) }
      }
    })
    render(
      <RunObservationPreview
        title="Shared project recording"
        mode="recorded"
        format="web-recording"
        target={receiving}
        isActive
        playback={{ recordedAt: 1000, playing: false, speed: 2, onSeekRecordedAt: vi.fn() }}
      />
    )
    const frame = await screen.findByTitle('Shared project recording')
    expect(frame.getAttribute('src')).toBe(issued.url)
    expect(new URL(frame.getAttribute('src')!).hash).toBe('')
    expect(frame.getAttribute('name')).toBe('open-science-research-clock')
  })

  it('does not restart selection polling when a shared clock recreates callback props', async () => {
    vi.useFakeTimers()
    const api = install()
    const view = render(
      <RunObservationPreview title="Study" target={target} isActive onAskSelection={vi.fn()} />
    )
    await act(async () => {})
    expect(api.selection).toHaveBeenCalledTimes(1)
    for (let frame = 0; frame < 20; frame++) {
      view.rerender(
        <RunObservationPreview title="Study" target={target} isActive onAskSelection={vi.fn()} />
      )
      await act(async () => {
        await vi.advanceTimersByTimeAsync(16)
      })
    }
    expect(api.selection).toHaveBeenCalledTimes(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(750)
    })
    expect(api.selection).toHaveBeenCalledTimes(2)
  })

  it('opens the saved archive as a recorded preview and keeps the current draft and recorded Ask owner', async () => {
    const live = install()
    const archive = {
      projectId: 'p',
      sessionId: 's',
      artifactId: 'saved-archive',
      versionId: 'saved-version'
    }
    const selection = {
      kind: 'recorded-run-observation' as const,
      selectionId: 'transition-ask',
      selectedAt: 1000,
      receiving: archive,
      recordingId: 'saved-recording',
      stepKey: 'step-1',
      mediaKeys: [],
      record: {
        stepKey: 'step-1',
        observedAt: 500,
        phase: 'completed' as const,
        sourceEvidence: {
          identity: { projectId: 'author-p', sessionId: 'author-s', runId: 'author-run' },
          cursor: { epoch: 'author-e', sequence: 0 },
          stepId: 'author-step'
        },
        run: null,
        artifactEvidence: [],
        artifactsTruncated: false
      }
    }
    const openRecorded = vi
      .fn()
      .mockResolvedValue({ ...access('recorded-viewer'), mode: 'recorded', target: archive })
    const recordingSelection = vi.fn().mockResolvedValue(selection)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        observations: {
          ...live,
          openRecorded,
          recordingSelection,
          recordingStatus: vi.fn().mockResolvedValue({ target, state: 'saved', archive })
        }
      }
    })
    usePreviewWorkbenchStore.setState({ activeProjectId: 'p', items: [], activeItemId: undefined })
    const Harness = (): React.JSX.Element => {
      const [doc, setDoc] = useState<ComposerDoc>({
        nodes: [{ type: 'text', text: 'Existing draft before archive' }]
      })
      useRunObservationQuestion({
        projectId: 'p',
        sessionId: 's',
        draftKey: 'transition-draft',
        editable: true,
        appendText: (_draftKey, text) => {
          setDoc((current) => ({ nodes: [...current.nodes, { type: 'text', text }] }))
          return true
        }
      })
      const item = usePreviewWorkbenchStore((state) =>
        state.items.find((entry) => entry.id === state.activeItemId)
      )
      const receiving = item?.type === 'tool' ? item.replayRecordingTarget : undefined
      return (
        <>
          <div data-testid="transition-draft">{JSON.stringify(doc)}</div>
          {receiving ? (
            <RunObservationPreview
              mode="recorded"
              target={receiving}
              title="Saved replay"
              isActive
              onAskArchiveSelection={(selected) => {
                if (!useRunObservationQuestionStore.getState().askRecorded(selected))
                  throw new Error('Draft unavailable')
              }}
            />
          ) : (
            <RunObservationPreview target={target} title="Live replay" isActive />
          )}
        </>
      )
    }
    const rendered = render(<Harness />)
    fireEvent.click(await screen.findByRole('button', { name: 'View archived replay' }))
    await screen.findByTitle('Saved replay')
    await screen.findByText('Selected step added to the current draft. Review it before sending.')
    const draft = screen.getByTestId('transition-draft').textContent
    expect(draft).toContain('Existing draft before archive')
    expect(draft).toContain('open-science-selected-recorded-evidence')
    expect(draft).toContain('saved-version')
    expect(draft).toContain('author-run')
    expect(openRecorded).toHaveBeenCalledExactlyOnceWith({ target: archive })
    expect(live.open).toHaveBeenCalledOnce()
    expect(live.revoke).toHaveBeenCalledWith({ viewerId: 'viewer' })
    expect(live.selection).not.toHaveBeenCalled()
    expect(recordingSelection).toHaveBeenCalledWith({ viewerId: 'recorded-viewer' })
    rendered.unmount()
    usePreviewWorkbenchStore.setState({ items: [], activeItemId: undefined })
  })

  it('acknowledges a selected step only after the current composer has accepted it', async () => {
    const api = install()
    api.selection.mockResolvedValue(selected())
    const Harness = (): React.JSX.Element => {
      const [doc, setDoc] = useState<ComposerDoc>({
        nodes: [{ type: 'text', text: 'Existing draft' }]
      })
      useRunObservationQuestion({
        projectId: 'p',
        sessionId: 's',
        draftKey: 'draft',
        editable: true,
        appendText: (_draftKey, text) => {
          setDoc((current) => ({ nodes: [...current.nodes, { type: 'text', text }] }))
          return true
        }
      })
      return (
        <>
          <div data-testid="actual-draft">{JSON.stringify(doc)}</div>
          <RunObservationPreview
            target={target}
            title="Run viewer"
            isActive
            onAskSelection={(snapshot) => {
              if (!useRunObservationQuestionStore.getState().ask(snapshot))
                throw new Error('Unavailable draft')
            }}
          />
        </>
      )
    }
    render(<Harness />)
    await screen.findByText('Selected step added to the current draft. Review it before sending.')
    expect(screen.getByTestId('actual-draft').textContent).toContain('Existing draft')
    expect(screen.getByTestId('actual-draft').textContent).toContain('real log')
  })
  it('offers guarded source navigation after a locked draft rejects a question, without silently navigating', async () => {
    const api = install(),
      openSource = vi.fn()
    api.selection.mockResolvedValue(selected())
    render(
      <RunObservationPreview
        target={target}
        title="Run viewer"
        isActive
        onAskSelection={() => {
          throw new Error('Locked')
        }}
        questionRecovery={{ label: 'Open source Session', onClick: openSource }}
      />
    )
    const button = await screen.findByRole('button', { name: 'Open source Session' })
    expect(openSource).not.toHaveBeenCalled()
    expect(
      screen.queryByText('Selected step added to the current draft. Review it before sending.')
    ).toBeNull()
    fireEvent.click(button)
    await waitFor(() => expect(openSource).toHaveBeenCalledOnce())
    expect(openSource.mock.calls[0][0]).toEqual(selected())
    expect(openSource.mock.calls[0][1]).toBeInstanceOf(AbortSignal)
  })
  it('recovers the frozen archived step into a new discussion draft without reopening its viewer', async () => {
    const live = install()
    const receiving = { projectId: 'p', sessionId: 'imported', artifactId: 'a', versionId: 'v' }
    const captured = {
      kind: 'recorded-run-observation' as const,
      selectionId: 'recover-ask',
      receiving,
      recordingId: 'recording',
      stepKey: 'recorded-step',
      mediaKeys: ['original-image'],
      record: {
        stepKey: 'recorded-step',
        observedAt: 500,
        phase: 'completed' as const,
        sourceEvidence: {
          identity: { projectId: 'author', sessionId: 'author-session', runId: 'author-run' },
          cursor: { epoch: 'e', sequence: 1 },
          stepId: 'author-step'
        },
        run: null,
        artifactEvidence: [],
        artifactsTruncated: false
      }
    }
    const openRecorded = vi
      .fn()
      .mockResolvedValue({ ...access('recorded'), mode: 'recorded', target: receiving })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        observations: {
          ...live,
          openRecorded,
          recordingSelection: vi.fn().mockResolvedValue(captured)
        }
      }
    })
    const recover = vi.fn()
    const Harness = (): React.JSX.Element => {
      const [editable, setEditable] = useState(false)
      const [doc, changeDoc] = useState<ComposerDoc>({
        nodes: [{ type: 'text', text: 'Unsent draft text' }]
      })
      useRunObservationQuestion({
        projectId: 'p',
        sessionId: editable ? undefined : 'imported',
        draftKey: editable ? 'new-research' : 'imported',
        editable,
        appendText: (_draftKey, text) => {
          changeDoc((current) => ({ nodes: [...current.nodes, { type: 'text', text }] }))
          return true
        }
      })
      return (
        <>
          <div data-testid="recovered-draft">{JSON.stringify(doc)}</div>
          <RunObservationPreview
            mode="recorded"
            target={receiving}
            title="Exact archived step"
            isActive
            onAskArchiveSelection={(selection) => {
              if (!useRunObservationQuestionStore.getState().askRecorded(selection))
                throw new Error('Locked')
            }}
            questionRecovery={{
              label: 'Discuss',
              onClick: (selection, signal) => {
                recover(selection)
                setEditable(true)
                useRunObservationQuestionStore
                  .getState()
                  .recover(
                    selection,
                    { projectId: 'p', draftKey: 'new-research' },
                    () => !signal?.aborted
                  )
              }
            }}
          />
        </>
      )
    }
    render(<Harness />)
    const button = await screen.findByRole('button', { name: 'Discuss' })
    const frame = screen.getByTitle('Exact archived step')
    expect(recover).not.toHaveBeenCalled()
    captured.mediaKeys.push('later-image')
    fireEvent.click(button)
    await screen.findByText('Selected step added to the current draft. Review it before sending.')
    expect(screen.getByTestId('recovered-draft').textContent).toContain('Unsent draft text')
    expect(screen.getByTestId('recovered-draft').textContent).toContain('original-image')
    expect(screen.getByTestId('recovered-draft').textContent).not.toContain('later-image')
    expect(screen.getByTitle('Exact archived step')).toBe(frame)
    expect(openRecorded).toHaveBeenCalledOnce()
    expect(live.revoke).not.toHaveBeenCalled()
    expect(recover).toHaveBeenCalledOnce()
    expect(useRunObservationQuestionStore.getState().destination?.sessionId).toBeUndefined()
    expect(screen.queryByText('Could not reference this recorded step.')).toBeNull()
  })
  it('keeps its one-use iframe across equivalent target, title and active changes, then revokes on close', async () => {
    const api = install()
    const view = render(<RunObservationPreview target={target} title="Run viewer" isActive />)
    const frame = await screen.findByTitle('Run viewer')
    view.rerender(
      <RunObservationPreview target={{ ...target }} title="Changed title" isActive={false} />
    )
    expect(screen.getByTitle('Changed title')).toBe(frame)
    expect(api.open).toHaveBeenCalledTimes(1)
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin allow-forms')
    view.unmount()
    expect(api.revoke).toHaveBeenCalledExactlyOnceWith({ viewerId: 'viewer' })
  })
  it('revokes a StrictMode open that arrives after cleanup without replacing the current iframe', async () => {
    const api = install(),
      first = deferred<RunObservationViewerAccess>(),
      second = deferred<RunObservationViewerAccess>()
    api.open.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const view = render(
      <StrictMode>
        <RunObservationPreview target={target} title="Run viewer" isActive />
      </StrictMode>
    )
    expect(api.open).toHaveBeenCalledTimes(2)
    await act(async () => {
      second.resolve(access('second'))
    })
    const frame = screen.getByTitle('Run viewer')
    await act(async () => {
      first.resolve(access('first'))
    })
    expect(screen.getByTitle('Run viewer')).toBe(frame)
    expect(api.revoke).toHaveBeenCalledWith({ viewerId: 'first' })
    expect(frame.getAttribute('src')).toContain('viewer-second.localhost')
    view.unmount()
    expect(api.revoke).toHaveBeenCalledWith({ viewerId: 'second' })
  })
  it('delivers only an explicitly selected server snapshot and never repeats a selection', async () => {
    const api = install(),
      onAsk = vi.fn()
    api.selection.mockResolvedValueOnce(null).mockResolvedValue(selected())
    render(
      <RunObservationPreview target={target} title="Run viewer" isActive onAskSelection={onAsk} />
    )
    await screen.findByTitle('Run viewer')
    expect(onAsk).not.toHaveBeenCalled()
    await waitFor(() => expect(onAsk).toHaveBeenCalledExactlyOnceWith(selected(), 'viewer'), {
      timeout: 2000
    })
    await waitFor(() => expect(api.selection.mock.calls.length).toBeGreaterThanOrEqual(3), {
      timeout: 2000
    })
    expect(onAsk).toHaveBeenCalledTimes(1)
    expect(api.selection.mock.calls.every(([request]) => request.viewerId === 'viewer')).toBe(true)
  })
  it('ignores a selected result after navigation to another Run and revokes the old scope', async () => {
    const api = install(),
      pending = deferred<RunObservationSelection | null>(),
      onAsk = vi.fn()
    api.selection.mockReturnValueOnce(pending.promise)
    api.open
      .mockResolvedValueOnce(access())
      .mockResolvedValueOnce(access('next', { ...target, runId: 'next' }))
    const view = render(
      <RunObservationPreview target={target} title="Run viewer" isActive onAskSelection={onAsk} />
    )
    await waitFor(() => expect(api.selection).toHaveBeenCalled())
    view.rerender(
      <RunObservationPreview
        target={{ ...target, runId: 'next' }}
        title="Next viewer"
        isActive
        onAskSelection={onAsk}
      />
    )
    await screen.findByTitle('Next viewer')
    await act(async () => {
      pending.resolve(selected())
    })
    expect(onAsk).not.toHaveBeenCalled()
    expect(api.revoke).toHaveBeenCalledWith({ viewerId: 'viewer' })
  })
  it('rejects a foreign selection and an unscoped iframe admission', async () => {
    const api = install(),
      onAsk = vi.fn(),
      foreign = { ...selected(), identity: { ...target, sessionId: 'elsewhere' } }
    api.selection.mockResolvedValue(foreign)
    const view = render(
      <RunObservationPreview target={target} title="Run viewer" isActive onAskSelection={onAsk} />
    )
    await screen.findByText('Could not reference this recorded step.')
    expect(onAsk).not.toHaveBeenCalled()
    view.unmount()
    api.open.mockResolvedValue({ ...access(), url: 'https://example.com/' })
    render(<RunObservationPreview target={target} title="Rejected" isActive />)
    await screen.findByText('Could not open the research viewer.')
    expect(screen.queryByTitle('Rejected')).toBeNull()
    expect(api.revoke).toHaveBeenCalledWith({ viewerId: 'viewer' })
  })
})

it('dispatches repeated recorded Ask actions by server selection identity, never by the author Run', async () => {
  const live = install(),
    receiving = { projectId: 'p', sessionId: 'imported', artifactId: 'a', versionId: 'v' }
  const captured = {
    kind: 'recorded-run-observation' as const,
    selectionId: 'ask-1',
    selectedAt: 1000,
    receiving,
    recordingId: 'recording',
    stepKey: 'step',
    mediaKeys: [],
    record: {
      stepKey: 'step',
      observedAt: 500,
      phase: 'completed' as const,
      sourceEvidence: {
        identity: { projectId: 'author-p', sessionId: 'author-s', runId: 'author-run' },
        cursor: { epoch: 'author-e', sequence: 0 },
        stepId: 'author-step'
      },
      run: null,
      artifactEvidence: [],
      artifactsTruncated: false
    }
  }
  const openRecorded = vi
    .fn()
    .mockResolvedValue({ ...access(), target: receiving, mode: 'recorded' })
  const recordingSelection = vi.fn().mockResolvedValue(null),
    onAsk = vi.fn()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { observations: { ...live, openRecorded, recordingSelection } }
  })
  render(
    <RunObservationPreview
      mode="recorded"
      target={receiving}
      title="Archive viewer"
      isActive
      onAskArchiveSelection={onAsk}
    />
  )
  await screen.findByTitle('Archive viewer')
  expect(onAsk).not.toHaveBeenCalled()
  recordingSelection.mockResolvedValue(captured)
  await waitFor(() => expect(onAsk).toHaveBeenCalledTimes(1), { timeout: 2000 })
  recordingSelection.mockResolvedValue({ ...captured, selectionId: 'ask-2', selectedAt: 1100 })
  await waitFor(() => expect(onAsk).toHaveBeenCalledTimes(2), { timeout: 2000 })
  expect(onAsk.mock.calls.map(([value]) => value.selectionId)).toEqual(['ask-1', 'ask-2'])
  expect(live.open).not.toHaveBeenCalled()
  expect(live.selection).not.toHaveBeenCalled()
  expect(openRecorded).toHaveBeenCalledExactlyOnceWith({ target: receiving })
})

it('pauses a disconnected recorded viewer and reconnects the same Version without losing the playhead or draft', async () => {
  const api = install()
  const receiving = {
    projectId: 'p',
    sessionId: 'imported',
    artifactId: 'recording',
    versionId: 'fixed-version'
  }
  const openRecorded = vi
    .fn()
    .mockResolvedValueOnce({
      ...access('first'),
      target: receiving,
      mode: 'recorded',
      format: 'web-recording'
    })
    .mockResolvedValueOnce({
      ...access('second'),
      target: receiving,
      mode: 'recorded',
      format: 'web-recording'
    })
  const selection = vi.fn().mockImplementation(async ({ viewerId }) => {
    if (viewerId === 'first') throw new Error('Viewer expired')
    return null
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { observations: { ...api, openRecorded }, projectRecordings: { selection } }
  })
  const onSeek = vi.fn(),
    onAsk = vi.fn()
  function Harness(): React.JSX.Element {
    const [playing, setPlaying] = useState(true)
    const [position, setPosition] = useState(12875)
    const [draft, setDraft] = useState('Keep this question in my draft')
    return (
      <>
        <input
          aria-label="Draft"
          value={draft}
          onChange={(event) => setDraft(event.currentTarget.value)}
        />
        <output data-testid="playback-state">
          {JSON.stringify({ playing, position, speed: 2 })}
        </output>
        <RunObservationPreview
          title="Saved project footage"
          mode="recorded"
          format="web-recording"
          target={receiving}
          isActive
          onAskBrowserMoment={onAsk}
          playback={{
            recordedAt: position,
            playing,
            speed: 2,
            onSeekRecordedAt: (value) => {
              onSeek(value)
              setPosition(value)
              setPlaying(false)
            }
          }}
        />
      </>
    )
  }
  render(<Harness />)
  await screen.findByText('Replay connection interrupted')
  expect(onSeek).toHaveBeenCalledExactlyOnceWith(12875)
  expect(JSON.parse(screen.getByTestId('playback-state').textContent!)).toEqual({
    playing: false,
    position: 12875,
    speed: 2
  })
  fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
  await waitFor(() =>
    expect(screen.getByTitle('Saved project footage').getAttribute('src')).toContain(
      'viewer-second.localhost'
    )
  )
  expect(openRecorded).toHaveBeenCalledTimes(2)
  expect(openRecorded.mock.calls.map(([request]) => request)).toEqual([
    { target: receiving, format: 'web-recording' },
    { target: receiving, format: 'web-recording' }
  ])
  expect(api.revoke).toHaveBeenCalledWith({ viewerId: 'first' })
  expect(screen.queryByText('Replay connection interrupted')).toBeNull()
  expect(screen.getByRole('textbox', { name: 'Draft' })).toHaveProperty(
    'value',
    'Keep this question in my draft'
  )
  expect(JSON.parse(screen.getByTestId('playback-state').textContent!)).toEqual({
    playing: false,
    position: 12875,
    speed: 2
  })
  expect(onAsk).not.toHaveBeenCalled()
  expect(api.open).not.toHaveBeenCalled()
})
