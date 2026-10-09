// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunObservationSnapshot } from '../../../../../shared/run-observation'
import { useSessionReplayStore } from '@/stores/session-replay-store'
import { LiveReplayView, type LiveReplayViewProps } from './LiveReplayView'
import { requestReplaySeek } from './replay-context'

const snapshot = (sequence: number, stdout = `output ${sequence}`): RunObservationSnapshot => ({
  identity: { projectId: 'p', sessionId: 's', operationId: 'operation', runId: 'run' },
  cursor: { epoch: 'epoch', sequence },
  observedAt: 1000 + sequence * 100,
  phase: 'running',
  stepId: 'run:run',
  run: {
    runId: 'run',
    kernelKind: 'bash',
    status: 'running',
    startedAt: 1000,
    logs: {
      stdout: { text: stdout, truncated: false, redacted: false },
      stderr: { text: '', truncated: false, redacted: false },
      traceback: { text: '', truncated: false, redacted: false }
    }
  },
  artifacts: [],
  artifactsTruncated: false
})
const props = (record = snapshot(1)): LiveReplayViewProps => ({
  title: 'Observed study',
  sourceIdentity: 'operation:operation',
  snapshot: record,
  connection: 'connected',
  readResource: vi.fn().mockResolvedValue({ status: 'unavailable' }),
  onAskSelection: vi.fn(),
  onStop: vi.fn()
})

beforeEach(() => {
  vi.stubGlobal('PointerEvent', MouseEvent)
  HTMLElement.prototype.scrollIntoView = vi.fn()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {
        /* The unit viewport is fixed. */
      }
      unobserve(): void {
        /* The unit viewport is fixed. */
      }
      disconnect(): void {
        /* No external observer survives. */
      }
    }
  )
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  }))
  // This host has no Electron preload. Readers and actions must come from props.
  Object.defineProperty(window, 'api', { configurable: true, value: undefined })
  useSessionReplayStore.setState({ playhead: undefined })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('shared live Replay viewer', () => {
  it.each([
    ['process-exited', 'completed', 'The run has ended.'],
    ['time-limit', 'timeout', 'The viewing time limit was reached.'],
    ['stopped', 'cancelled', 'The run was stopped.'],
    ['failed', 'failed', 'The run failed.'],
    ['interrupted', 'interrupted', 'The run was interrupted.']
  ] as const)(
    'keeps selected-step evidence visible after a demo ends: %s',
    (endReason, status, message) => {
      const before = snapshot(1)
      const completed: RunObservationSnapshot = {
        ...snapshot(2),
        phase: status,
        run: { ...snapshot(2).run!, status, endedAt: 1200 },
        artifacts: [{ name: 'result.json', versionId: 'result-version' }],
        executionContext: {
          purpose: 'offline-demo',
          conditionChanges: [],
          demoViewing: { mode: 'until-stop-or-timeout', timeoutMs: 60000, endReason }
        }
      }
      const first = props(before)
      const view = render(<LiveReplayView {...first} />)
      fireEvent.click(screen.getByRole('button', { name: 'Project interface' }))
      view.rerender(
        <LiveReplayView {...first} snapshot={completed} history={[before, completed]} />
      )
      expect(screen.getByText(message)).toBeTruthy()
      expect(screen.getByText('The live project page is closed.')).toBeTruthy()
      const evidence = screen.getByRole('region', { name: 'Evidence from the selected step' })
      expect(within(evidence).getByText('output 2')).toBeTruthy()
      expect(within(evidence).getByText('result.json')).toBeTruthy()
      expect(document.querySelector('iframe')).toBeNull()
      expect(screen.queryByRole('button', { name: 'Stop demo' })).toBeNull()
    }
  )

  it('updates the end notice without replacing an inspected step, its files or its question', async () => {
    const earlier = {
      ...snapshot(1, 'earlier evidence'),
      artifacts: [{ name: 'earlier.json', versionId: 'earlier-version' }]
    }
    const latest = snapshot(2)
    const first = props(latest)
    const view = render(<LiveReplayView {...first} history={[earlier, latest]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Previous step' }))
    fireEvent.click(screen.getByRole('button', { name: 'Project interface' }))
    const terminal: RunObservationSnapshot = {
      ...snapshot(3, 'final output'),
      phase: 'completed',
      run: { ...snapshot(3, 'final output').run!, status: 'completed' },
      artifacts: [{ name: 'final.json', versionId: 'final-version' }]
    }
    view.rerender(
      <LiveReplayView {...first} snapshot={terminal} history={[earlier, latest, terminal]} />
    )
    expect(screen.getByTestId('replay-live-record').dataset.observationRecord).toBe('epoch:1')
    expect(screen.getByText('The live project page is closed.')).toBeTruthy()
    const evidence = screen.getByRole('region', { name: 'Evidence from the selected step' })
    expect(within(evidence).getByText('earlier evidence')).toBeTruthy()
    expect(within(evidence).getByText('earlier.json')).toBeTruthy()
    expect(within(evidence).queryByText('final.json')).toBeNull()
    expect(within(evidence).queryByText('final output')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Ask about this step' }))
    await waitFor(() => expect(first.onAskSelection).toHaveBeenCalledExactlyOnceWith(earlier))
    expect(first.onStop).not.toHaveBeenCalled()
  })

  it('uses the ordinary run timeout outcome without claiming a demo viewing limit or ending on disconnect', () => {
    const first = props()
    const view = render(<LiveReplayView {...first} connection="disconnected" />)
    fireEvent.click(screen.getByRole('button', { name: 'Project interface' }))
    expect(screen.queryByTestId('project-run-ended')).toBeNull()
    view.rerender(
      <LiveReplayView
        {...first}
        snapshot={{
          ...snapshot(2),
          phase: 'timeout',
          run: { ...snapshot(2).run!, status: 'timeout' }
        }}
      />
    )
    expect(screen.getByText('The run timed out.')).toBeTruthy()
    expect(screen.queryByText('The viewing time limit was reached.')).toBeNull()
    expect(screen.getByText('No result files were recorded at this step.')).toBeTruthy()
  })

  it('uses the ordinary stop action for a verified offline run', () => {
    const first = props({
      ...snapshot(1),
      executionContext: { purpose: 'offline-demo', conditionChanges: [] }
    })
    render(<LiveReplayView {...first} />)
    fireEvent.click(screen.getByRole('button', { name: 'Stop run' }))
    expect(first.onStop).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: 'Stop demo' })).toBeNull()
  })

  it('keeps legacy purpose unknown even when a completed run or title suggests reproduction', () => {
    render(
      <LiveReplayView
        {...props({ ...snapshot(1), phase: 'completed' })}
        title="Successful scientific reproduction"
      />
    )
    expect(screen.getByText('Execution purpose not recorded')).toBeTruthy()
    expect(screen.queryByText('Research execution')).toBeNull()
  })

  it('shows verified demo purpose and declared conditions without interpreting them as success', () => {
    render(
      <LiveReplayView
        {...props({
          ...snapshot(1),
          executionContext: {
            purpose: 'offline-demo',
            conditionChanges: ['Recorded provider answers']
          }
        })}
      />
    )
    expect(screen.getByText('Offline run')).toBeTruthy()
    expect(
      screen.getByText(
        'This run uses packaged offline inputs. It does not reproduce the original external environment.'
      )
    ).toBeTruthy()
    fireEvent.click(screen.getByText('Execution conditions'))
    expect(screen.getByText('Recorded provider answers')).toBeTruthy()
  })

  it('distinguishes research intent from successful reproduction and names the recorded configuration', () => {
    render(
      <LiveReplayView
        {...props({
          ...snapshot(1),
          phase: 'completed',
          executionContext: {
            purpose: 'research',
            profileName: 'Recipient account',
            conditionChanges: ['Different model version']
          }
        })}
      />
    )
    expect(screen.getByText('Research execution')).toBeTruthy()
    expect(
      screen.getByText(
        'A research execution is not, by itself, evidence of successful reproduction.'
      )
    ).toBeTruthy()
    fireEvent.click(screen.getByText('Execution conditions'))
    expect(screen.getByText('Recorded configuration: Recipient account')).toBeTruthy()
    expect(screen.getByText('Different model version')).toBeTruthy()
  })

  it('follows real revisions without replacing its viewport and never exposes a simulated clock', async () => {
    const first = props()
    const view = render(<LiveReplayView {...first} />)
    expect(screen.getByText('output 1')).toBeTruthy()
    const viewport = screen.getByRole('region', { name: 'Execution record' })
    view.rerender(
      <LiveReplayView {...first} snapshot={snapshot(2)} history={[first.snapshot, snapshot(2)]} />
    )
    expect(screen.getByText('output 2')).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Execution record' })).toBe(viewport)
    expect(screen.queryByRole('slider', { name: 'Replay progress' })).toBeNull()
    expect(screen.queryByRole('combobox', { name: 'Playback speed' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Play replay' })).toBeNull()
    expect(first.onStop).not.toHaveBeenCalled()
  })

  it('freezes logs and exact cursor on inspection while later records arrive, then resumes explicitly', async () => {
    const first = props()
    const view = render(<LiveReplayView {...first} />)
    fireEvent.click(screen.getByRole('button', { name: 'Pause following' }))
    const paused = screen.getByRole('button', { name: 'Back to live' })
    paused.focus()
    view.rerender(
      <LiveReplayView {...first} snapshot={snapshot(2)} history={[first.snapshot, snapshot(2)]} />
    )
    expect(screen.getByText('output 1')).toBeTruthy()
    expect(screen.queryByText('output 2')).toBeNull()
    expect(document.activeElement).toBe(paused)
    fireEvent.click(screen.getByRole('button', { name: 'Ask about this step' }))
    expect(first.onAskSelection).toHaveBeenCalledWith(first.snapshot)
    expect(first.onStop).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Back to live' }))
    expect(screen.getByText('output 2')).toBeTruthy()
  })

  it('manual wheel inspection freezes output without cancelling or moving a focused control', () => {
    const first = props()
    const view = render(<LiveReplayView {...first} />)
    const viewport = screen.getByRole('region', { name: 'Execution record' })
    fireEvent.wheel(viewport, { deltaY: -10 })
    view.rerender(<LiveReplayView {...first} snapshot={snapshot(2)} />)
    expect(screen.getByText('output 1')).toBeTruthy()
    expect(
      screen.getByText('Viewing is paused. The experiment continues independently.')
    ).toBeTruthy()
    expect(first.onStop).not.toHaveBeenCalled()
  })

  it.each([
    ['edge', 'pointer'],
    ['edge', 'wheel'],
    ['edge', 'keyboard'],
    ['gap', 'pointer'],
    ['gap', 'wheel'],
    ['gap', 'keyboard']
  ] as const)(
    'keeps the live project visible after %s %s interaction and still pauses when browsing logs',
    (location, interaction) => {
      const first = props()
      const surface = {
        runId: 'run',
        content: <iframe title="Current project" src="about:blank" />
      }
      const view = render(<LiveReplayView {...first} runtimeSurface={surface} />)
      fireEvent.click(screen.getByRole('button', { name: 'Project interface' }))
      const frame = screen.getByTitle('Current project')
      const interact = (target: HTMLElement): void => {
        if (interaction === 'pointer') fireEvent.pointerDown(target)
        else if (interaction === 'wheel') fireEvent.wheel(target, { deltaY: -10 })
        else fireEvent.keyDown(target, { key: 'PageUp' })
      }
      interact(
        location === 'edge'
          ? screen.getByRole('region', { name: 'Execution record' })
          : screen.getByTestId('replay-live-record')
      )
      expect(screen.getByText('Following live')).toBeTruthy()
      expect(frame.closest('[hidden], [inert]')).toBeNull()
      view.rerender(
        <LiveReplayView
          {...first}
          snapshot={snapshot(2)}
          history={[first.snapshot, snapshot(2)]}
          runtimeSurface={surface}
        />
      )
      expect(screen.getByTestId('replay-live-record').getAttribute('data-observation-record')).toBe(
        'epoch:2'
      )
      expect(screen.getByTitle('Current project')).toBe(frame)
      expect(frame.closest('[hidden], [inert]')).toBeNull()

      fireEvent.click(screen.getByRole('button', { name: 'Execution record' }))
      interact(screen.getByRole('region', { name: 'Execution record' }))
      expect(screen.getByRole('button', { name: 'Back to live' })).toBeTruthy()
      expect(screen.getByText('Inspecting recorded evidence')).toBeTruthy()
      expect(first.onStop).not.toHaveBeenCalled()
    }
  )

  it.each(['recorded', 'completed'] as const)(
    'still inspects project-pane history when the observation is %s',
    (state) => {
      const record =
        state === 'completed' ? { ...snapshot(1), phase: 'completed' as const } : snapshot(1)
      render(<LiveReplayView {...props(record)} recorded={state === 'recorded'} />)
      expect(screen.getByTestId('replay-panel').getAttribute('aria-label')).toBe(
        state === 'recorded' ? 'Research replay' : 'Run observation'
      )
      fireEvent.click(screen.getByRole('button', { name: 'Project interface' }))
      expect(screen.getByText('Run history')).toBeTruthy()
      fireEvent.pointerDown(screen.getByRole('region', { name: 'Execution record' }))
      expect(screen.getByText('Inspecting recorded evidence')).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Show latest record' })).toBeTruthy()
    }
  )

  it.each(['pointer', 'Escape'] as const)(
    'dismisses the narrow files overlay with a project-edge %s interaction without pausing the project',
    (interaction) => {
      const first = props()
      render(
        <LiveReplayView
          {...first}
          runtimeSurface={{
            runId: 'run',
            content: <iframe title="Current project" src="about:blank" />
          }}
        />
      )
      const projectButton = screen.getByRole('button', { name: 'Project interface' })
      fireEvent.click(projectButton)
      const frame = screen.getByTitle('Current project')
      const filesButton = screen.getByRole('button', { name: 'View files' })
      fireEvent.click(filesButton)
      expect(screen.getByRole('button', { name: 'Close files' })).toBeTruthy()
      // Existing marked project controls retain their own event handling.
      fireEvent.pointerDown(projectButton)
      expect(filesButton.getAttribute('aria-expanded')).toBe('true')

      const viewport = screen.getByRole('region', { name: 'Execution record' })
      if (interaction === 'pointer') fireEvent.pointerDown(viewport)
      else fireEvent.keyDown(viewport, { key: 'Escape' })

      expect(filesButton.getAttribute('aria-expanded')).toBe('false')
      expect(screen.queryByRole('button', { name: 'Close files' })).toBeNull()
      expect(screen.getByText('Following live')).toBeTruthy()
      expect(screen.getByTitle('Current project')).toBe(frame)
      expect(frame.closest('[hidden], [inert]')).toBeNull()
      expect(first.onStop).not.toHaveBeenCalled()
    }
  )

  it('keeps a live project page mounted across revisions and blocks it during inspection, disconnect and completion', () => {
    const first = props()
    const surface = { runId: 'run', content: <iframe title="Current project" src="about:blank" /> }
    const view = render(<LiveReplayView {...first} runtimeSurface={surface} />)
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Project interface' }))
    fireEvent.click(screen.getByRole('button', { name: 'Project interface' }))
    const frame = screen.getByTitle('Current project')
    view.rerender(<LiveReplayView {...first} snapshot={snapshot(2)} runtimeSurface={surface} />)
    expect(screen.getByTitle('Current project')).toBe(frame)
    fireEvent.click(screen.getByRole('button', { name: 'Pause following' }))
    expect(screen.getByTitle('Current project')).toBe(frame)
    expect(frame.closest('[inert]')).not.toBeNull()
    expect(
      screen.getByText(
        'No project screen was recorded for this step. The current live page is not historical evidence.'
      )
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Back to live' }))
    expect(screen.getByTitle('Current project')).toBe(frame)
    fireEvent.click(screen.getByRole('button', { name: 'Execution record' }))
    expect(screen.getByTitle('Current project')).toBe(frame)
    expect(frame.closest('[hidden]')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Project interface' }))
    expect(screen.getByTitle('Current project')).toBe(frame)
    view.rerender(
      <LiveReplayView
        {...first}
        snapshot={snapshot(3)}
        runtimeSurface={surface}
        connection="reconnecting"
      />
    )
    expect(screen.queryByTitle('Current project')).toBeNull()
    view.rerender(
      <LiveReplayView
        {...first}
        snapshot={{ ...snapshot(4), phase: 'completed' }}
        runtimeSurface={surface}
      />
    )
    expect(screen.queryByTitle('Current project')).toBeNull()
    expect(screen.getByText('Run history')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Pause following' })).toBeNull()
  })

  it('never mounts a page belonging to another run', () => {
    render(
      <LiveReplayView
        {...props()}
        runtimeSurface={{ runId: 'wrong-run', content: <iframe title="Wrong project" /> }}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Project interface' }))
    expect(screen.queryByTitle('Wrong project')).toBeNull()
  })

  it.each(['reconnecting', 'disconnected', 'recorded', 'history'] as const)(
    'never activates a current project lease from a %s surface',
    (mode) => {
      const onOpen = vi.fn()
      const first = props(snapshot(2))
      render(
        <LiveReplayView
          {...first}
          history={[snapshot(1), snapshot(2)]}
          recorded={mode === 'recorded'}
          connection={mode === 'reconnecting' || mode === 'disconnected' ? mode : 'connected'}
          projectActivation={{ opening: false, onOpen }}
        />
      )
      if (mode === 'history') fireEvent.click(screen.getByRole('button', { name: 'Previous step' }))
      fireEvent.click(screen.getByRole('button', { name: 'Project interface' }))
      expect(onOpen).not.toHaveBeenCalled()
    }
  )

  it('history selection reads only the selected actual snapshot, including after that revision leaves the incoming buffer', async () => {
    const one = snapshot(1),
      two = snapshot(2)
    const first = props(two)
    const view = render(<LiveReplayView {...first} history={[one, two]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Previous step' }))
    expect(screen.getByText('output 1')).toBeTruthy()
    view.rerender(
      <LiveReplayView {...first} snapshot={snapshot(4)} history={[snapshot(3), snapshot(4)]} />
    )
    expect(screen.getByText('output 1')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Ask about this step' }))
    expect(first.onAskSelection).toHaveBeenCalledWith(one)
  })

  it('isolates two viewers and ignores historical-session global seek events', () => {
    const first = props(),
      second = props()
    render(
      <>
        <LiveReplayView {...first} />
        <LiveReplayView {...second} />
      </>
    )
    const viewers = screen.getAllByTestId('live-replay-view')
    fireEvent.click(within(viewers[0]).getByRole('button', { name: 'Pause following' }))
    expect(within(viewers[1]).getByRole('button', { name: 'Pause following' })).toBeTruthy()
    act(() =>
      requestReplaySeek({
        projectId: 'p',
        sourceSessionId: 's',
        branchId: 'historical',
        stepId: 'old'
      })
    )
    expect(screen.queryByText('The referenced step is no longer available.')).toBeNull()
    expect(useSessionReplayStore.getState().playhead).toBeUndefined()
    fireEvent.click(within(viewers[0]).getByRole('button', { name: 'Ask about this step' }))
    expect(first.onAskSelection).toHaveBeenCalledTimes(1)
    expect(second.onAskSelection).not.toHaveBeenCalled()
  })

  it('stop requests are explicit, deduplicated and do not claim termination until actual evidence arrives', async () => {
    const first = props()
    const view = render(<LiveReplayView {...first} />)
    fireEvent.click(screen.getByRole('button', { name: 'Stop run' }))
    await waitFor(() => expect(first.onStop).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('button', { name: 'Waiting for the run to stop…' })).toHaveProperty(
      'disabled',
      true
    )
    expect(screen.getByTestId('observation-phase').textContent).toBe('Running')
    view.rerender(<LiveReplayView {...first} snapshot={{ ...snapshot(2), phase: 'cancelled' }} />)
    expect(screen.getByTestId('observation-phase').textContent).toBe('Cancelled')
    expect(screen.queryByRole('button', { name: 'Waiting for the run to stop…' })).toBeNull()
    view.unmount()
    expect(first.onStop).toHaveBeenCalledTimes(1)
  })

  it('shows failed selection feedback without silently selecting a newer snapshot', async () => {
    const first = props()
    first.onAskSelection = vi.fn().mockRejectedValue(new Error('expired'))
    render(<LiveReplayView {...first} />)
    fireEvent.click(screen.getByRole('button', { name: 'Ask about this step' }))
    await screen.findByText('Could not reference this recorded step.')
    expect(first.onAskSelection).toHaveBeenCalledTimes(1)
    expect(screen.getByText('output 1')).toBeTruthy()
  })

  it('rejects mixed-run history before rendering or requesting resources', () => {
    const first = props()
    render(
      <LiveReplayView
        {...first}
        history={[{ ...snapshot(0), identity: { ...snapshot(0).identity, runId: 'foreign' } }]}
      />
    )
    expect(
      screen.getByText('Observation records do not match this run. Reconnect to load a fresh view.')
    ).toBeTruthy()
    expect(first.readResource).not.toHaveBeenCalled()
    expect(first.onAskSelection).not.toHaveBeenCalled()
  })
  it('scrollbar movement pauses following and later logs preserve the viewport position', () => {
    const first = props()
    const view = render(<LiveReplayView {...first} />)
    const viewport = screen.getByRole('region', { name: 'Execution record' })
    Object.defineProperties(viewport, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 100 }
    })
    viewport.scrollTop = 900
    fireEvent.scroll(viewport)
    viewport.scrollTop = 200
    fireEvent.scroll(viewport)
    view.rerender(<LiveReplayView {...first} snapshot={snapshot(2)} />)
    expect(screen.getByText('output 1')).toBeTruthy()
    expect(viewport.scrollTop).toBe(200)
    expect(first.onStop).not.toHaveBeenCalled()
  })

  it('keeps an inspected file at its exact Version while newer results are published', async () => {
    const one = {
      ...snapshot(1),
      artifacts: [{ versionId: 'version-1', name: 'first.txt', producerRunId: 'run' }]
    }
    const two = {
      ...snapshot(2),
      artifacts: [
        ...one.artifacts,
        { versionId: 'version-2', name: 'second.txt', producerRunId: 'run' }
      ]
    }
    const first = props(one)
    first.readResource = vi.fn(async (resource) => ({
      status: 'ready' as const,
      kind: 'text' as const,
      content: `exact bytes ${resource.versionId}`,
      mimeType: 'text/plain',
      truncated: false
    }))
    const view = render(<LiveReplayView {...first} />)
    fireEvent.click(screen.getByRole('button', { name: 'View files' }))
    fireEvent.click(screen.getByRole('button', { name: 'first.txt' }))
    await screen.findByText('exact bytes version-1')
    view.rerender(<LiveReplayView {...first} snapshot={two} history={[one, two]} />)
    expect(screen.getByText('exact bytes version-1')).toBeTruthy()
    expect(screen.queryByText('exact bytes version-2')).toBeNull()
    expect(first.readResource).not.toHaveBeenCalledWith(
      expect.objectContaining({ versionId: 'version-2' })
    )
    fireEvent.click(screen.getByRole('button', { name: 'Ask about this step' }))
    expect(first.onAskSelection).toHaveBeenCalledWith(one)
  })

  it('a source replacement resets private inspection and a former run cannot supply the project page', () => {
    const first = props()
    const view = render(
      <LiveReplayView
        {...first}
        runtimeSurface={{ runId: 'run', content: <iframe title="Original project" /> }}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Pause following' }))
    const changed = {
      ...snapshot(1, 'new source'),
      identity: { projectId: 'p', sessionId: 's', operationId: 'new-operation', runId: 'new-run' },
      run: { ...snapshot(1, 'new source').run!, runId: 'new-run' }
    }
    view.rerender(
      <LiveReplayView
        {...first}
        sourceIdentity="operation:new-operation"
        snapshot={changed}
        runtimeSurface={{ runId: 'run', content: <iframe title="Original project" /> }}
      />
    )
    expect(screen.getByText('new source')).toBeTruthy()
    expect(screen.queryByText('output 1')).toBeNull()
    expect(screen.getByRole('button', { name: 'Pause following' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Project interface' }))
    expect(screen.queryByTitle('Original project')).toBeNull()
  })

  it('a failed stop request is retryable and never changes the actual status', async () => {
    const first = props()
    first.onStop = vi.fn().mockRejectedValue(new Error('offline'))
    render(<LiveReplayView {...first} />)
    fireEvent.click(screen.getByRole('button', { name: 'Stop run' }))
    await screen.findByText('Could not request the run to stop.')
    expect(screen.getByTestId('observation-phase').textContent).toBe('Running')
    expect(screen.getByRole('button', { name: 'Stop run' })).toHaveProperty('disabled', false)
    expect(first.onStop).toHaveBeenCalledTimes(1)
  })

  it('does not repeat an asynchronous question while its exact selection is being saved', async () => {
    let finish: (() => void) | undefined
    const first = props()
    first.onAskSelection = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    render(<LiveReplayView {...first} />)
    fireEvent.click(screen.getByRole('button', { name: 'Ask about this step' }))
    fireEvent.click(screen.getByRole('button', { name: 'Ask about this step' }))
    expect(first.onAskSelection).toHaveBeenCalledTimes(1)
    await act(async () => finish?.())
    expect(screen.getByRole('button', { name: 'Ask about this step' })).toHaveProperty(
      'disabled',
      false
    )
  })
  it('archived running snapshots are history and cannot resume a live project or request a stop', () => {
    const first = props()
    render(
      <LiveReplayView
        {...first}
        recorded
        connection="disconnected"
        historyTruncated
        runtimeSurface={{ runId: 'run', content: <iframe title="Live project" /> }}
      />
    )
    expect(screen.getByText('Run history')).toBeTruthy()
    expect(screen.queryByText('Live connection unavailable')).toBeNull()
    expect(screen.getByText('Recorded run: Running')).toBeTruthy()
    expect(
      screen.getByText('Earlier observed records are no longer available in this view.')
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Stop demo' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Pause following' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Project interface' }))
    expect(screen.queryByTitle('Live project')).toBeNull()
    expect(first.onStop).not.toHaveBeenCalled()
  })
  it('saving a question never blocks the independent stop action', async () => {
    const first = props()
    let finish: (() => void) | undefined
    first.onAskSelection = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    render(<LiveReplayView {...first} />)
    fireEvent.click(screen.getByRole('button', { name: 'Ask about this step' }))
    fireEvent.click(screen.getByRole('button', { name: 'Stop run' }))
    await waitFor(() => expect(first.onStop).toHaveBeenCalledTimes(1))
    await act(async () => finish?.())
  })
})
