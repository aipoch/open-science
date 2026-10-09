// @vitest-environment jsdom
import { useEffect, useState } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { buildObservationReplayDocument } from '@/lib/replay/live-source'
import type { ReplayDocument, ReplayStep } from '../../../../../shared/replay'
import type { RunObservationSnapshot } from '../../../../../shared/run-observation'
import { ReplayPanel, type ReplayPanelProps } from './ReplayPanel'
import type { ReplayMaterialPlayback, ReplayMaterialView } from './ReplayStage'
import { useReplayMaterialAction } from './replay-material-action'

const makeDocument = (): ReplayDocument => {
  const step: ReplayStep = {
    id: 'record-one',
    branchId: 'main',
    kind: 'message',
    startMs: 0,
    endMs: 60_000,
    durationMs: 60_000,
    recordedAt: 10_000,
    message: {
      id: 'message-one',
      role: 'agent',
      status: 'complete',
      content: 'Original research observation',
      eventIds: [],
      createdAt: 10_000,
      updatedAt: 10_000
    },
    activities: [],
    runs: [],
    resourceIds: [],
    evidence: [
      {
        kind: 'message',
        id: 'message-one',
        projectId: 'layout-project',
        sessionId: 'layout-session'
      }
    ],
    issues: []
  }
  return {
    generatorVersion: 3,
    presentationVersion: 2,
    source: {
      projectId: 'layout-project',
      sessionId: 'layout-session',
      title: 'Layout regression research',
      fingerprint: 'layout-fingerprint'
    },
    defaultBranchId: 'main',
    branches: [
      { id: 'main', label: 'Main branch', kind: 'conversation', durationMs: 60_000, steps: [step] }
    ],
    resources: [],
    issues: []
  }
}

type MaterialId = 'project' | 'results'
type MaterialProbe = {
  mounts: Record<MaterialId, number>
  unmounts: Record<MaterialId, number>
  active: Partial<Record<MaterialId, boolean>>
  playback: Partial<Record<MaterialId, ReplayMaterialPlayback | undefined>>
  ask: Record<MaterialId, Mock<(revision: number) => void>>
  refresh: Partial<Record<MaterialId, () => void>>
  onMount: (id: MaterialId) => void
  onUnmount: (id: MaterialId) => void
  onUpdate: (
    id: MaterialId,
    active: boolean,
    playback: ReplayMaterialPlayback | undefined,
    refresh: () => void
  ) => void
}

const Material = ({
  id,
  active,
  playback,
  probe
}: {
  id: MaterialId
  active: boolean
  playback?: ReplayMaterialPlayback
  probe: MaterialProbe
}): React.JSX.Element => {
  const [draft, setDraft] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    probe.onUpdate(id, active, playback, () => setRevision((value) => value + 1))
  }, [id, active, playback, probe])
  useEffect(() => {
    probe.onMount(id)
    return () => probe.onUnmount(id)
  }, [id, probe])
  useReplayMaterialAction(
    active
      ? {
          label: id === 'project' ? 'Ask about this frame' : 'Ask about this file',
          recordedAt: (id === 'project' ? 10_100 : 10_200) + revision,
          onAsk: () => probe.ask[id](revision)
        }
      : undefined
  )
  return (
    <div data-testid={`${id}-material`}>
      <input
        aria-label={`${id} reader draft`}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      <button onClick={() => setRevision((value) => value + 1)}>{`Refresh ${id} reference`}</button>
    </div>
  )
}

const harness = (
  props: Partial<ReplayPanelProps> = {}
): MaterialProbe & { rerender: (props: Partial<ReplayPanelProps>) => void } => {
  const probe: MaterialProbe = {
    mounts: { project: 0, results: 0 },
    unmounts: { project: 0, results: 0 },
    active: {},
    playback: {},
    ask: { project: vi.fn(), results: vi.fn() },
    refresh: {},
    onMount: (id) => {
      probe.mounts[id] += 1
    },
    onUnmount: (id) => {
      probe.unmounts[id] += 1
    },
    onUpdate: (id, active, playback, refresh) => {
      probe.active[id] = active
      probe.playback[id] = playback
      probe.refresh[id] = refresh
    }
  }
  const materialViews: ReplayMaterialView[] = (['project', 'results'] as const).map((id) => ({
    id,
    label: id === 'project' ? 'Project replay' : 'Results',
    content: (active, playback) => (
      <Material id={id} active={active} playback={playback} probe={probe} />
    )
  }))
  let panelProps: ReplayPanelProps = {
    host: null,
    presentationMode: 'research',
    document: makeDocument(),
    materialViews,
    recordedTimeOrigins: { main: 10_000 },
    initialView: {
      fingerprint: 'layout-fingerprint',
      generatorVersion: 3,
      presentationVersion: 2,
      clock: 'recorded',
      branchId: 'main',
      timeMs: 300,
      rate: 1
    },
    onAskStep: vi.fn(),
    readResource: vi.fn().mockResolvedValue({ status: 'unavailable', reason: 'not-recorded' }),
    readNotebookRun: vi.fn().mockResolvedValue({ status: 'unavailable', reason: 'not-recorded' }),
    ...props
  }
  const mounted = render(<ReplayPanel {...panelProps} />)
  return {
    ...probe,
    rerender: (next) => {
      panelProps = { ...panelProps, ...next }
      mounted.rerender(<ReplayPanel {...panelProps} />)
    }
  }
}

let frameSequence = 0
let timestamp = 0
const frames = new Map<number, FrameRequestCallback>()
const tick = async (count = 1): Promise<void> => {
  for (let index = 0; index < count; index++) {
    await act(async () => {
      timestamp += 100
      const pending = [...frames.values()]
      frames.clear()
      pending.forEach((callback) => callback(timestamp))
    })
  }
}
const originalFullscreen = Object.getOwnPropertyDescriptor(document, 'fullscreenElement')
let fullscreenElement: Element | null = null
const changeFullscreen = (element: Element | null): void => {
  fullscreenElement = element
  fireEvent(document, new Event('fullscreenchange'))
}

beforeEach(() => {
  frameSequence = 0
  timestamp = 0
  frames.clear()
  fullscreenElement = null
  localStorage.clear()
  sessionStorage.clear()
  Object.defineProperty(document, 'fullscreenElement', {
    configurable: true,
    get: () => fullscreenElement
  })
  vi.stubGlobal('PointerEvent', MouseEvent)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++frameSequence, callback)
    return frameSequence
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {
        /* No browser geometry in this ownership test. */
      }
      unobserve(): void {
        /* No browser geometry in this ownership test. */
      }
      disconnect(): void {
        /* No external observer is installed. */
      }
    }
  )
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  }))
  HTMLElement.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  cleanup()
  if (originalFullscreen) Object.defineProperty(document, 'fullscreenElement', originalFullscreen)
  else Reflect.deleteProperty(document, 'fullscreenElement')
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const pane = (id: string): HTMLElement => {
  const element = screen
    .getByTestId('replay-stage')
    .querySelector<HTMLElement>(`[data-replay-pane="${id}"]`)
  expect(element, `Replay should retain its ${id} pane`).not.toBeNull()
  return element!
}
const visible = (id: string): boolean =>
  pane(id).getAttribute('data-replay-pane-visible') === 'true'
const position = (): number =>
  Number(screen.getByRole('slider', { name: 'Replay progress' }).getAttribute('aria-valuenow'))
const enterFullscreen = (): HTMLElement => {
  const panel = screen.getByTestId('replay-panel')
  panel.requestFullscreen = vi.fn(async () => changeFullscreen(panel))
  fireEvent.click(screen.getByRole('button', { name: 'Enter full screen' }))
  expect(panel.requestFullscreen).toHaveBeenCalledOnce()
  return panel
}
const changeLayout = (name: 'Side-by-side' | 'Expand into columns'): void => {
  const trigger = screen.getByRole('button', { name: 'Replay layout' })
  fireEvent.click(trigger)
  fireEvent.click(screen.getByRole('radio', { name }))
  if (trigger.getAttribute('aria-expanded') === 'true') fireEvent.click(trigger)
}
const showAll = (): void => {
  const trigger = screen.getByRole('button', { name: 'Replay layout' })
  fireEvent.click(trigger)
  fireEvent.click(screen.getByRole('button', { name: 'Show all panes' }))
  if (trigger.getAttribute('aria-expanded') === 'true') fireEvent.click(trigger)
}

describe('research replay layout', () => {
  it('supports native expanded preview layouts without remounting materials or interrupting playback', async () => {
    const probe = harness({ host: undefined })
    await tick(5)
    const panel = screen.getByTestId('replay-panel')
    const stage = screen.getByTestId('replay-stage')
    expect(screen.queryByRole('button', { name: 'Replay layout' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Play replay' }))
    await tick(2)
    const before = position()

    probe.rerender({ expanded: true })
    expect(document.fullscreenElement).toBeNull()
    expect(panel.getAttribute('data-replay-layout-mode')).toBe('split')
    expect(visible('conversation')).toBe(true)
    expect(visible('notebook')).toBe(true)
    expect(position()).toBe(before)
    expect(screen.getByRole('button', { name: 'Pause replay' })).toBeTruthy()
    showAll()
    expect(panel.getAttribute('data-replay-layout-mode')).toBe('columns')
    const project = screen.getByTestId('project-material')
    fireEvent.change(within(project).getByRole('textbox'), {
      target: { value: 'Expanded preview reading' }
    })
    await tick(2)
    expect(position()).toBeGreaterThan(before)
    const expandedPosition = position()

    probe.rerender({ expanded: false })
    expect(panel.getAttribute('data-replay-layout-mode')).toBe('tabs')
    expect(screen.queryByRole('button', { name: 'Replay layout' })).toBeNull()
    expect(screen.getByRole('tab', { name: 'Original conversation' })).toBeTruthy()
    expect(position()).toBe(expandedPosition)
    expect(screen.getByRole('button', { name: 'Pause replay' })).toBeTruthy()
    await tick(2)
    expect(position()).toBeGreaterThan(expandedPosition)

    probe.rerender({ expanded: true })
    expect(panel.getAttribute('data-replay-layout-mode')).toBe('columns')
    expect(screen.getByTestId('replay-stage')).toBe(stage)
    expect(screen.getByTestId('project-material')).toBe(project)
    expect((within(project).getByRole('textbox') as HTMLInputElement).value).toBe(
      'Expanded preview reading'
    )
    expect(probe.mounts).toEqual({ project: 1, results: 1 })
    expect(probe.unmounts).toEqual({ project: 0, results: 0 })
  })

  it('keeps native expanded layout independent of DOM fullscreen entry and exit', async () => {
    const onToggleExpanded = vi.fn()
    const probe = harness({ host: undefined, expanded: true, onToggleExpanded })
    await tick(5)
    expect(screen.getByRole('button', { name: 'Collapse preview' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Enter full screen' })).toBeTruthy()
    const panel = enterFullscreen()
    const exit = vi.fn(async () => changeFullscreen(null))
    const originalExit = Object.getOwnPropertyDescriptor(document, 'exitFullscreen')
    Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: exit })
    try {
      showAll()
      fireEvent.click(screen.getByRole('button', { name: 'Exit full screen' }))
      expect(exit).toHaveBeenCalledOnce()
      expect(onToggleExpanded).not.toHaveBeenCalled()
      expect(document.fullscreenElement).toBeNull()
      expect(panel.getAttribute('data-replay-layout-mode')).toBe('columns')
      expect(screen.getByRole('button', { name: 'Replay layout' })).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Enter full screen' })).toBeTruthy()

      enterFullscreen()
      probe.rerender({ expanded: false })
      expect(document.fullscreenElement).toBe(panel)
      expect(panel.getAttribute('data-replay-layout-mode')).toBe('columns')
      expect(screen.getByRole('button', { name: 'Expand preview' })).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'Exit full screen' }))
      expect(panel.getAttribute('data-replay-layout-mode')).toBe('tabs')
      expect(screen.queryByRole('button', { name: 'Replay layout' })).toBeNull()
    } finally {
      if (originalExit) Object.defineProperty(document, 'exitFullscreen', originalExit)
      else Reflect.deleteProperty(document, 'exitFullscreen')
    }
  })

  it('saves a completed native expanded preview resize across fullscreen and collapse transitions', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement
    ) {
      return new DOMRect(0, 0, this.hasAttribute('data-replay-pane-group') ? 1601 : 0, 800)
    })
    vi.stubGlobal(
      'PointerEvent',
      class extends MouseEvent {
        readonly pointerId: number
        constructor(type: string, options: PointerEventInit = {}) {
          super(type, options)
          this.pointerId = options.pointerId ?? 1
        }
      }
    )
    const probe = harness({ host: undefined, expanded: true })
    await tick(5)
    fireEvent.click(screen.getByRole('tab', { name: 'Project replay' }))
    const separator = screen.getByRole('separator', {
      name: 'Resize Original conversation and Project replay'
    })
    let captured = false
    separator.setPointerCapture = vi.fn(() => {
      captured = true
    })
    separator.hasPointerCapture = vi.fn(() => captured)
    separator.releasePointerCapture = vi.fn(() => {
      captured = false
    })
    expect(separator.getAttribute('aria-valuenow')).toBe('35')
    fireEvent.pointerDown(separator, { button: 0, clientX: 560, pointerId: 1 })
    fireEvent.pointerMove(separator, { clientX: 656, pointerId: 1 })
    expect(separator.getAttribute('aria-valuenow')).toBe('41')
    expect(JSON.parse(localStorage.getItem('research-replay-layout:v1')!).widthsByLayout).toEqual(
      {}
    )
    fireEvent.pointerUp(separator, { clientX: 656, pointerId: 1 })
    expect(captured).toBe(false)
    expect(JSON.parse(localStorage.getItem('research-replay-layout:v1')!).widthsByLayout).toEqual({
      'split:conversation,project': { conversation: 41, project: 59 }
    })

    enterFullscreen()
    changeFullscreen(null)
    expect(separator.getAttribute('aria-valuenow')).toBe('41')
    probe.rerender({ expanded: false })
    expect(screen.queryByRole('separator')).toBeNull()
    probe.rerender({ expanded: true })
    expect(
      screen
        .getByRole('separator', { name: 'Resize Original conversation and Project replay' })
        .getAttribute('aria-valuenow')
    ).toBe('41')
  })

  it('keeps browser expanded previews tabbed until the panel enters DOM fullscreen', async () => {
    const probe = harness({ expanded: true })
    await tick(5)
    const panel = screen.getByTestId('replay-panel')
    expect(panel.getAttribute('data-replay-layout-mode')).toBe('tabs')
    expect(screen.queryByRole('button', { name: 'Replay layout' })).toBeNull()
    enterFullscreen()
    expect(panel.getAttribute('data-replay-layout-mode')).toBe('split')
    changeFullscreen(null)
    expect(panel.getAttribute('data-replay-layout-mode')).toBe('tabs')
    expect(screen.queryByRole('button', { name: 'Replay layout' })).toBeNull()
    probe.rerender({ expanded: false })
    expect(panel.getAttribute('data-replay-layout-mode')).toBe('tabs')
  })

  it('keeps ordinary native replay in its existing presentation when the preview expands', () => {
    harness({ host: undefined, presentationMode: undefined, expanded: true })
    expect(screen.getByTestId('replay-panel').getAttribute('data-replay-presentation')).toBeNull()
    expect(screen.getByTestId('replay-stage').getAttribute('data-replay-layout')).toBe(
      'interactive'
    )
    expect(screen.queryByRole('button', { name: 'Replay layout' })).toBeNull()
    expect(screen.queryByRole('tab', { name: 'Original conversation' })).toBeNull()
  })

  it.each(['live', 'recorded'] as const)(
    'keeps %s execution evidence in its existing presentation even with research mode and expanded preview',
    (kind) => {
      const snapshot: RunObservationSnapshot = {
        identity: {
          projectId: 'layout-project',
          sessionId: 'layout-session',
          operationId: 'operation'
        },
        cursor: { epoch: 'epoch', sequence: 1 },
        observedAt: 10_000,
        phase: 'preparing',
        stepId: 'operation:operation',
        run: null,
        artifacts: [],
        artifactsTruncated: false
      }
      const source = {
        sourceIdentity: 'operation:operation',
        snapshot,
        history: [snapshot],
        onAskSelection: vi.fn()
      }
      harness({
        host: undefined,
        expanded: true,
        document: buildObservationReplayDocument([snapshot], 'Execution layout regression'),
        initialView: undefined,
        recordedTimeOrigins: undefined,
        ...(kind === 'live'
          ? { live: { ...source, connection: 'connected' as const } }
          : { recorded: source })
      })
      expect(screen.getByTestId('replay-live-record')).toBeTruthy()
      expect(screen.getByTestId('replay-panel').getAttribute('data-replay-presentation')).toBeNull()
      expect(screen.getByTestId('replay-stage').getAttribute('data-replay-layout')).toBe(
        'interactive'
      )
      expect(screen.queryByRole('button', { name: 'Replay layout' })).toBeNull()
      expect(screen.queryByRole('tab', { name: 'Original conversation' })).toBeNull()
    }
  )

  it('opens fullscreen with the original conversation beside Notebook and keeps the original player on exit', async () => {
    harness()
    await tick(5)
    const stage = screen.getByTestId('replay-stage')
    const panel = enterFullscreen()
    expect(panel.getAttribute('data-replay-layout-mode')).toBe('split')
    expect(visible('conversation')).toBe(true)
    expect(visible('notebook')).toBe(true)
    expect(visible('project')).toBe(false)
    expect(visible('results')).toBe(false)
    expect(screen.queryByRole('tab', { name: 'Original conversation' })).toBeNull()
    expect(screen.getByRole('tab', { name: 'Notebook' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.click(screen.getByRole('tab', { name: 'Project replay' }))
    expect(visible('conversation')).toBe(true)
    expect(visible('project')).toBe(true)
    expect(visible('notebook')).toBe(false)
    changeFullscreen(null)
    expect(panel.getAttribute('data-replay-layout-mode')).toBe('tabs')
    expect(screen.getByTestId('replay-stage')).toBe(stage)
    expect(position()).toBe(300)
  })

  it('retains every material instance and reader draft through column, tab and fullscreen changes', async () => {
    const probe = harness()
    await tick(5)
    enterFullscreen()
    fireEvent.click(screen.getByRole('tab', { name: 'Project replay' }))
    const project = screen.getByTestId('project-material')
    const results = screen.getByTestId('results-material')
    fireEvent.change(within(project).getByRole('textbox'), {
      target: { value: 'Saved project reading' }
    })
    showAll()
    expect(screen.getByTestId('replay-panel').getAttribute('data-replay-layout-mode')).toBe(
      'columns'
    )
    for (const id of ['conversation', 'notebook', 'project', 'results'])
      expect(visible(id)).toBe(true)
    expect(probe.active).toEqual({ project: true, results: true })
    fireEvent.change(within(results).getByRole('textbox'), {
      target: { value: 'Saved result reading' }
    })
    changeLayout('Side-by-side')
    changeFullscreen(null)
    enterFullscreen()
    showAll()
    expect(screen.getByTestId('project-material')).toBe(project)
    expect(screen.getByTestId('results-material')).toBe(results)
    expect((within(project).getByRole('textbox') as HTMLInputElement).value).toBe(
      'Saved project reading'
    )
    expect((within(results).getByRole('textbox') as HTMLInputElement).value).toBe(
      'Saved result reading'
    )
    expect(probe.mounts).toEqual({ project: 1, results: 1 })
    expect(probe.unmounts).toEqual({ project: 0, results: 0 })
  })

  it('uses the focused pane for questions even when a different visible pane updates its reference', async () => {
    const onAskStep = vi.fn()
    const probe = harness({ onAskStep })
    await tick(5)
    enterFullscreen()
    showAll()
    fireEvent.pointerDown(screen.getByTestId('results-material'))
    expect(screen.getByRole('button', { name: 'Ask about this file' })).toBeTruthy()
    // Programmatic material updates can arrive from playback without moving the reader's focus.
    act(() => probe.refresh.project?.())
    expect(screen.getByRole('button', { name: 'Ask about this file' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Ask about this file' }))
    expect(probe.ask.results).toHaveBeenCalledOnce()
    expect(probe.ask.project).not.toHaveBeenCalled()
    fireEvent.pointerDown(screen.getByTestId('project-material'))
    fireEvent.click(screen.getByRole('button', { name: 'Ask about this frame' }))
    expect(probe.ask.project).toHaveBeenCalledWith(1)
    const record = pane('conversation').querySelector<HTMLElement>(
      '[data-replay-step="record-one"]'
    )!
    fireEvent.pointerDown(record)
    fireEvent.click(screen.getByRole('button', { name: 'Ask about this record' }))
    expect(onAskStep).toHaveBeenCalledWith(expect.objectContaining({ stepId: 'record-one' }))
    expect(position()).toBe(300)
  })

  it('tracks keyboard focus separately from visible materials and disables a hidden material without unmounting it', async () => {
    const probe = harness()
    await tick(5)
    enterFullscreen()
    showAll()
    act(() => screen.getByRole('textbox', { name: 'project reader draft' }).focus())
    expect(screen.getByRole('button', { name: 'Ask about this frame' })).toBeTruthy()
    act(() => screen.getByRole('textbox', { name: 'results reader draft' }).focus())
    expect(screen.getByRole('button', { name: 'Ask about this file' })).toBeTruthy()
    const trigger = screen.getByRole('button', { name: 'Replay layout' })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Project replay' }))
    fireEvent.click(trigger)
    expect(visible('project')).toBe(false)
    expect(visible('results')).toBe(true)
    expect(probe.active).toEqual({ project: false, results: true })
    expect(probe.mounts).toEqual({ project: 1, results: 1 })
    expect(probe.unmounts).toEqual({ project: 0, results: 0 })
    expect(screen.getByRole('button', { name: 'Ask about this file' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Ask about this file' }))
    expect(probe.ask.results).toHaveBeenCalledOnce()
  })

  it('keeps the shared clock playing across layouts, material tabs and resize controls', async () => {
    const probe = harness()
    await tick(5)
    enterFullscreen()
    fireEvent.click(screen.getByRole('button', { name: 'Play replay' }))
    await tick(2)
    const checkPlaying = async (change: () => void): Promise<void> => {
      const before = position()
      change()
      expect(position()).toBe(before)
      expect(screen.getByRole('button', { name: 'Pause replay' })).toBeTruthy()
      await tick(2)
      expect(position()).toBeGreaterThan(before)
    }
    await checkPlaying(() => fireEvent.click(screen.getByRole('tab', { name: 'Project replay' })))
    await checkPlaying(showAll)
    await checkPlaying(() => {
      const separator = screen.getAllByRole('separator')[0]
      separator.setPointerCapture = vi.fn()
      fireEvent.pointerDown(separator, { button: 0, clientX: 500 })
      fireEvent.pointerUp(separator, { button: 0, clientX: 500 })
      fireEvent.keyDown(separator, { key: 'ArrowRight' })
    })
    await checkPlaying(() => changeLayout('Side-by-side'))
    expect(probe.playback.project).toMatchObject({ playing: true, recordedAt: 10_000 + position() })
  })

  it('keeps playing when the reader scrolls a pane and retains that pane across layout changes', async () => {
    harness()
    await tick(5)
    enterFullscreen()
    fireEvent.click(screen.getByRole('button', { name: 'Play replay' }))
    await tick(2)
    const conversation = screen.getByRole('region', { name: 'Historical conversation' })
    Object.defineProperties(conversation, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 1200 },
      scrollTop: { configurable: true, writable: true, value: 900 }
    })
    fireEvent.scroll(conversation)
    conversation.scrollTop = 120
    fireEvent.wheel(conversation, { deltaY: -200 })
    fireEvent.scroll(conversation)
    const before = position()
    await tick(2)
    expect(screen.getByRole('button', { name: 'Pause replay' })).toBeTruthy()
    expect(position()).toBeGreaterThan(before)
    showAll()
    changeLayout('Side-by-side')
    expect(screen.getByRole('region', { name: 'Historical conversation' })).toBe(conversation)
    expect(conversation.scrollTop).toBe(120)
  })
})
