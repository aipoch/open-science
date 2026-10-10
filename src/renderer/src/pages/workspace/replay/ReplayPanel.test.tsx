import { useSessionReplayStore } from '@/stores/session-replay-store'
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReplayDocument, ReplayStep } from '../../../../../shared/replay'
import { projectReplayScene } from '@/lib/replay'
import { ReplayPanel } from './ReplayPanel'
import { ReplayControls } from './ReplayControls'
import { ReplayStage } from './ReplayStage'
import { useReplayMaterialAction } from './replay-material-action'
import * as notebookCell from '../NotebookRecordCell'
import { createReplayPresentation } from './replay-presentation'
import type { SessionDiscussionCapture } from './replay-context'
import { requestReplaySeek } from './replay-context'
import type { ReplayPreparedResource } from './replay-resources'

vi.mock('../previews/PreviewFileContent', () => ({
  PreviewFileContent: ({
    item,
    readOnly
  }: {
    item: { selectedVersionId?: string; managedFileId?: string; source?: string; format: string }
    readOnly?: boolean
  }) => (
    <div
      data-testid="workspace-file-preview"
      data-version={item.selectedVersionId}
      data-file={item.managedFileId}
      data-source={item.source}
      data-format={item.format}
      data-read-only={readOnly}
    />
  )
}))

const step = (id: string, startMs: number, content: string): ReplayStep => ({
  id,
  branchId: 'main',
  kind: 'message',
  startMs,
  durationMs: 1000,
  endMs: startMs + 1000,
  message: {
    id,
    role: 'agent',
    status: 'complete',
    content,
    eventIds: [],
    createdAt: 1,
    updatedAt: 1
  },
  activities: [],
  runs: [],
  resourceIds: [],
  evidence: [{ kind: 'message', id, projectId: 'p', sessionId: 's', branchId: 'main' }],
  issues: [],
  recordedAt: 0
})
const makeDocument = (): ReplayDocument => {
  const one = step('one', 0, 'Initial observation')
  const two = { ...step('two', 1000, 'Interpret saved evidence'), resourceIds: ['v1'] }
  const three = {
    ...step('three', 2000, 'Final result'),
    resourceIds: ['v2'],
    runs: [
      {
        runId: 'run1',
        cellId: 'c1',
        source: 'agent' as const,
        kernelKind: 'python' as const,
        script: 'print(42)',
        status: 'completed' as const,
        startedAt: 0,
        text: { stdout: '42', stderr: '', traceback: '', plain: [] },
        outputs: [],
        artifacts: [],
        workingFiles: []
      }
    ]
  }
  return {
    generatorVersion: 3,
    presentationVersion: 2,
    source: { projectId: 'p', sessionId: 's', title: 'Archived research', fingerprint: 'fp' },
    defaultBranchId: 'main',
    branches: [
      {
        id: 'main',
        label: 'Main branch',
        kind: 'conversation',
        durationMs: 3000,
        steps: [one, two, three]
      },
      {
        id: 'other',
        label: 'Other branch',
        kind: 'conversation',
        durationMs: 1000,
        steps: [
          { ...step('other-step', 0, 'Other findings'), branchId: 'other', resourceIds: ['v2'] }
        ]
      }
    ],
    resources: ['v1', 'v2'].map((id) => ({
      id,
      name: `${id}.txt`,
      projectId: 'p',
      sessionId: 's',
      artifactId: 'file',
      versionId: id,
      locator: `version:${id}`,
      availability: 'recorded'
    })),
    issues: []
  }
}
const prepared: ReplayPreparedResource = {
  status: 'ready',
  kind: 'text',
  content: 'historical material',
  mimeType: 'text/plain',
  truncated: false
}
// Inferred mock signatures preserve call argument inspection in these interaction tests.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const callbacks = () => ({
  onAskStep: vi.fn(),
  onOpenEvidence: vi.fn(),
  readResource: vi.fn().mockResolvedValue(prepared),
  readNotebookRun: vi.fn().mockResolvedValue({
    status: 'ready',
    run: {
      runId: 'run1',
      cellId: 'c1',
      source: 'agent',
      kernelKind: 'python',
      script: 'print(42)',
      status: 'completed',
      startedAt: 0,
      text: { stdout: '42', stderr: '', traceback: '', plain: [] },
      outputs: [],
      workingFiles: []
    },
    bytes: 1000
  })
})

beforeEach(() => {
  vi.stubGlobal('PointerEvent', MouseEvent)
  HTMLElement.prototype.scrollIntoView = vi.fn()

  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {
        /* test viewport stays fixed */
      }
      unobserve(): void {
        /* Radix releases the measured slider thumb. */
      }
      disconnect(): void {
        /* no external observer */
      }
    }
  )
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  }))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// Supply layout and pointer capture missing from jsdom; exercise the real Slider handler.
const seekProgress = (position: number): void => {
  const slider = screen.getByRole('slider', { name: 'Replay progress' })
  const track = screen.getByTestId('replay-progress-track')
  vi.spyOn(track, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1000, 32))
  track.setPointerCapture = vi.fn()
  track.hasPointerCapture = () => true
  track.releasePointerCapture = vi.fn()
  const clientX = (position / Number(slider.getAttribute('aria-valuemax'))) * 1000
  fireEvent.pointerDown(track, { clientX, button: 0 })
  fireEvent.pointerUp(track, { clientX, button: 0 })
}
const chooseBranch = (label: string): void => {
  fireEvent.keyDown(screen.getByRole('combobox', { name: 'Replay branch' }), { key: 'Enter' })
  fireEvent.click(screen.getByRole('option', { name: new RegExp(label) }))
}

const openMaterials = (): void => {
  const trigger = screen.getByRole('button', { name: 'Notebook' })
  if (trigger.getAttribute('aria-expanded') !== 'true') fireEvent.click(trigger)
}

describe('research replay interaction', () => {
  it('owns the material clock, forwards pause/speed/seek, and restores the requested material after a timeline change', async () => {
    const onMaterialViewChange = vi.fn()
    const doc = makeDocument()
    doc.resources = []
    doc.branches = [
      { ...doc.branches[0], steps: [step('one', 0, 'First'), step('two', 1000, 'Second')] }
    ]
    let playback: import('./ReplayStage').ReplayMaterialPlayback | undefined
    const views = [
      {
        id: 'project',
        label: 'Project replay',
        content: (_active: boolean, value?: import('./ReplayStage').ReplayMaterialPlayback) => {
          playback = value
          return null
        }
      }
    ]
    render(
      <ReplayPanel
        document={doc}
        {...callbacks()}
        materialViews={views}
        onMaterialViewChange={onMaterialViewChange}
        materialViewRequest={{ id: 'project', revision: 1 }}
        recordedTimeOrigins={{ main: 10000 }}
      />
    )
    expect(
      screen.getByRole('button', { name: 'Project replay' }).getAttribute('aria-pressed')
    ).toBe('true')
    expect(playback).toMatchObject({ recordedAt: 10000, continuous: true, playing: false })
    seekProgress(1500)
    expect(playback?.recordedAt).toBe(11500)
    fireEvent.click(screen.getByRole('button', { name: 'Play replay' }))
    await waitFor(() => expect(playback?.playing).toBe(true))
    fireEvent.click(screen.getByRole('button', { name: 'Pause replay' }))
    expect(playback?.playing).toBe(false)
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Playback speed' }), { key: 'Enter' })
    fireEvent.click(screen.getByRole('option', { name: '4×' }))
    expect(playback?.speed).toBe(4)
    act(() => playback?.onSeekRecordedAt(10500))
    expect(
      screen.getByRole('slider', { name: 'Replay progress' }).getAttribute('aria-valuenow')
    ).toBe('500')
    expect(playback).toMatchObject({
      recordedAt: 10500,
      playing: false,
      branchId: 'main',
      positionMs: 500
    })
    fireEvent.click(screen.getByRole('button', { name: 'Notebook' }))
    expect(onMaterialViewChange).toHaveBeenLastCalledWith('notebook')
    expect(
      screen.getByRole('slider', { name: 'Replay progress' }).getAttribute('aria-valuenow')
    ).toBe('500')
  })

  it('exposes the visible playhead during playback and captures its latest position on demand', () => {
    const props = callbacks()
    const document = makeDocument()
    const { rerender, unmount } = render(<ReplayPanel document={document} {...props} />)
    const playhead = useSessionReplayStore.getState().playhead!
    expect(playhead.capture().stepId).toBe('one')
    fireEvent.click(screen.getByLabelText('Play replay'))
    expect(useSessionReplayStore.getState().playhead).toBe(playhead)
    fireEvent.click(screen.getByLabelText('Pause replay'))
    const track = screen.getByTestId('replay-progress-track')
    vi.spyOn(track, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1000, 32))
    track.setPointerCapture = vi.fn()
    track.hasPointerCapture = () => true
    track.releasePointerCapture = vi.fn()
    fireEvent.pointerDown(track, { clientX: 800, button: 0 })
    fireEvent.pointerUp(track, { clientX: 800, button: 0 })
    expect(playhead.capture()).toMatchObject({ stepId: 'three', stepNumber: 3 })
    act(() => requestReplaySeek({ ...playhead.capture(), stepId: 'one', stepOffsetMs: 0 }))
    expect(playhead.capture().stepId).toBe('one')
    expect(useSessionReplayStore.getState().playhead).toBe(playhead)
    rerender(<ReplayPanel document={document} {...props} active={false} />)
    expect(useSessionReplayStore.getState().playhead).toBeUndefined()
    unmount()
  })

  it('starts a whole-research discussion without selecting the current playback step', () => {
    const props = callbacks()
    render(<ReplayPanel document={makeDocument()} {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Discuss the entire research' }))
    expect(props.onAskStep).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'session',
        sourceSessionId: 's',
        stepTitle: 'Entire research',
        stepNumber: undefined
      })
    )
  })

  it('browses only the selected branch, pauses, and returns focus after a direct step jump', async () => {
    const props = callbacks()
    render(<ReplayPanel document={makeDocument()} {...props} />)
    fireEvent.click(screen.getByLabelText('Play replay'))
    const browse = screen.getByRole('button', { name: 'Browse steps' })
    browse.focus()
    fireEvent.click(browse)
    const directory = screen.getByRole('dialog', { name: 'Browse steps' })
    expect(screen.getByLabelText('Play replay')).toBeTruthy()
    expect(browse.getAttribute('aria-expanded')).toBe('true')
    expect(within(directory).getAllByRole('listitem')).toHaveLength(3)
    expect(directory.textContent).toContain('Final result')
    expect(directory.textContent).not.toContain('Other findings')
    expect(
      within(directory)
        .getByRole('button', { name: 'Go to step 1: Initial observation' })
        .getAttribute('aria-current')
    ).toBe('step')
    fireEvent.click(
      within(directory).getByRole('button', { name: 'Go to step 2: Interpret saved evidence' })
    )
    expect(screen.getByLabelText('Replay progress').getAttribute('aria-valuenow')).toBe('1000')
    expect(screen.queryByRole('dialog', { name: 'Browse steps' })).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(browse))
    expect(browse.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(screen.getByText('Ask about this step'))
    expect(props.onAskStep.mock.calls[0][0]).toMatchObject({
      branchId: 'main',
      stepId: 'two',
      stepOffsetMs: 0
    })
    fireEvent.click(browse)
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Browse steps' }), { key: 'Escape' })
    await waitFor(() => expect(document.activeElement).toBe(browse))
    await act(async () => {})
  })

  it('bounds directory rendering and opens the current step page without loading future material', async () => {
    const replayDocument = makeDocument()
    replayDocument.branches[0].steps = Array.from({ length: 85 }, (_, index) =>
      step(`step-${index}`, index * 1000, `Finding ${index}`)
    )
    replayDocument.branches[0].durationMs = 85000
    const props = callbacks()
    render(<ReplayPanel document={replayDocument} {...props} />)
    seekProgress(42000)
    fireEvent.click(screen.getByRole('button', { name: 'Browse steps' }))
    let directory = screen.getByRole('dialog', { name: 'Browse steps' })
    expect(within(directory).getAllByRole('listitem')).toHaveLength(40)
    expect(within(directory).getByText('Page 2 of 3')).toBeTruthy()
    expect(
      within(directory)
        .getByRole('button', { name: 'Go to step 43: Finding 42' })
        .getAttribute('aria-current')
    ).toBe('step')
    fireEvent.click(within(directory).getByRole('button', { name: 'Next page' }))
    expect(within(directory).getAllByRole('listitem')).toHaveLength(5)
    fireEvent.click(within(directory).getByRole('button', { name: 'Go to step 85: Finding 84' }))
    expect(screen.getByLabelText('Replay progress').getAttribute('aria-valuenow')).toBe('84000')
    fireEvent.click(screen.getByRole('button', { name: 'Browse steps' }))
    directory = screen.getByRole('dialog', { name: 'Browse steps' })
    expect(within(directory).getByText('Page 3 of 3')).toBeTruthy()
    expect(props.readResource).not.toHaveBeenCalled()
    expect(props.readNotebookRun).not.toHaveBeenCalled()
    chooseBranch('Other branch')
    expect(screen.queryByRole('dialog', { name: 'Browse steps' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Browse steps' }))
    expect(
      within(screen.getByRole('dialog', { name: 'Browse steps' })).getAllByRole('listitem')
    ).toHaveLength(1)
    await act(async () => {})
  })

  it('opens the selected step original record from details without seeking or reading unrelated material', async () => {
    const document = makeDocument()
    const target = document.branches[0].steps[1]
    target.recordedEndAt = 1500
    target.issues = [{ code: 'artifact-unavailable', detail: 'Missing archived file' }]
    const props = callbacks()
    render(<ReplayPanel document={document} {...props} />)
    expect(screen.queryByRole('button', { name: 'View step evidence' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Play replay' }))
    screen.getByRole('button', { name: 'Browse steps' }).focus()
    fireEvent.click(screen.getByRole('button', { name: 'Browse steps' }))
    expect(screen.getByRole('button', { name: 'Play replay' })).toBeTruthy()
    const directory = screen.getByRole('dialog', { name: 'Browse steps' })
    const row = within(directory).getAllByRole('listitem')[1]
    fireEvent.click(within(row).getByRole('button', { name: 'Details for step 2' }))
    expect(within(directory).getByText('Recorded duration: 1.5 s')).toBeTruthy()
    expect(
      within(directory).getByText('Some source material is incomplete or unavailable.')
    ).toBeTruthy()
    fireEvent.click(within(directory).getByRole('button', { name: 'Open original evidence' }))
    expect(props.onOpenEvidence).toHaveBeenCalledExactlyOnceWith(undefined, target)
    expect(screen.getByLabelText('Replay progress').getAttribute('aria-valuenow')).toBe('0')
    expect(props.readResource).not.toHaveBeenCalled()
    expect(props.readNotebookRun).not.toHaveBeenCalled()
    fireEvent.keyDown(directory, { key: 'Escape' })
    fireEvent.keyDown(directory, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Browse steps' })).toBeNull()
    await waitFor(() =>
      expect(globalThis.document.activeElement).toBe(
        screen.getByRole('button', { name: 'Browse steps' })
      )
    )
    fireEvent.click(screen.getByRole('button', { name: 'Next step' }))
    expect(screen.getByText('Some source material is incomplete or unavailable.')).toBeTruthy()
    expect(screen.getByLabelText('Replay progress').getAttribute('aria-valuenow')).toBe('1000')
    await act(async () => {})
  })

  it.each([
    ['notebook_execute', 'Notebook run'],
    ['repl_execute', 'Agent SDK'],
    ['bash_execute', 'Shell']
  ])('uses a readable %s chapter title and keeps Ask bound to that step', async (tool, title) => {
    const document = makeDocument()
    document.branches[0].steps[1].title = `mcp__open-science-notebook__${tool}`
    const props = callbacks()
    render(<ReplayPanel document={document} {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Next step' }))
    expect(screen.getByRole('button', { name: 'Browse steps' }).textContent).toContain(title)
    fireEvent.click(screen.getByRole('button', { name: 'Ask about this step' }))
    expect(props.onAskStep.mock.calls[0][0]).toMatchObject({ stepId: 'two', branchId: 'main' })
    await act(async () => {})
  })

  it('closes the step list when following a saved reference', async () => {
    render(<ReplayPanel document={makeDocument()} {...callbacks()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Browse steps' }))
    act(() =>
      requestReplaySeek({
        projectId: 'p',
        sourceSessionId: 's',
        branchId: 'other',
        stepId: 'other-step',
        stepOffsetMs: 400
      })
    )
    expect(screen.queryByRole('dialog', { name: 'Browse steps' })).toBeNull()
    expect(screen.getByLabelText('Replay progress').getAttribute('aria-valuenow')).toBe('400')
    await act(async () => {})
  })

  it('omits the branch picker for a single branch and disables step actions for empty archives', async () => {
    const document = makeDocument()
    document.branches = [{ ...document.branches[0], steps: [], durationMs: 0 }]
    render(<ReplayPanel document={document} {...callbacks()} />)
    expect(screen.queryByRole('combobox', { name: 'Replay branch' })).toBeNull()
    for (const name of ['Browse steps', 'Ask about this step', 'Play replay']) {
      expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true)
    }
    expect(screen.getAllByText('No recorded steps are available.').length).toBeGreaterThan(0)
    await act(async () => {})
  })

  it('keeps shared selectors and the custom progress control keyboard accessible', () => {
    render(<ReplayPanel document={makeDocument()} {...callbacks()} />)
    const stage = screen.getByTestId('replay-stage')
    expect(stage.style.width).toBe('100%')
    expect(stage.dataset.replayLayout).toBe('interactive')
    const slider = screen.getByRole('slider', { name: 'Replay progress' })
    fireEvent.keyDown(slider, { key: 'End' })
    expect(slider.getAttribute('aria-valuenow')).toBe('3000')
    fireEvent.keyDown(slider, { key: 'Home' })
    fireEvent.keyDown(slider, { key: 'ArrowRight' })
    expect(slider.getAttribute('aria-valuenow')).toBe('3000')
    fireEvent.keyDown(slider, { key: 'ArrowLeft' })
    expect(slider.getAttribute('aria-valuenow')).toBe('0')
    expect(screen.getByRole('combobox', { name: 'Replay branch' }).tagName).toBe('BUTTON')
    const speed = screen.getByRole('combobox', { name: 'Playback speed' })
    expect(speed.textContent).toContain('2×')
    fireEvent.keyDown(speed, { key: 'Enter' })
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      '1×',
      '2×',
      '4×'
    ])
    fireEvent.click(screen.getByRole('option', { name: '4×' }))
    expect(speed.textContent).toContain('4×')
  })

  it('starts paused, captures an immutable step reference, seeks back without future output, and keeps source actions explicit', async () => {
    const document = makeDocument()
    const props = callbacks()
    render(<ReplayPanel document={document} {...props} />)
    expect(screen.getByLabelText('Play replay')).toBeTruthy()
    seekProgress(1500)
    fireEvent.click(screen.getByText('Ask about this step'))
    const captured = props.onAskStep.mock.calls[0][0] as SessionDiscussionCapture
    expect(captured.stepId).toBe('two')
    expect(captured.excerpt).toBe('Interpret saved evidence'.slice(0, 20))
    fireEvent.click(screen.getByLabelText('Next step'))
    await waitFor(() =>
      expect(
        window.document.querySelector('[data-replay-notebook-run="run1"] code')?.textContent
      ).toContain('print(42)')
    )
    seekProgress(0)
    expect(window.document.querySelector('[data-replay-notebook-run="run1"]')).toBeNull()
    expect(captured.stepId).toBe('two')
    expect(props.onOpenEvidence).not.toHaveBeenCalled()
    await act(async () => {})
  })

  it('pauses on branch changes, manual inspection, hidden tabs, and seeks a saved reference', async () => {
    const document = makeDocument()
    const props = callbacks()
    const view = render(<ReplayPanel document={document} {...props} />)
    fireEvent.click(screen.getByLabelText('Play replay'))
    fireEvent.wheel(screen.getByTestId('replay-stage'))
    expect(screen.getByLabelText('Play replay')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Play replay'))
    chooseBranch('Other branch')
    expect(screen.getByLabelText('Play replay')).toBeTruthy()
    expect(screen.getByTestId('replay-stage').textContent).toContain('Ot')
    fireEvent.click(screen.getByLabelText('Play replay'))
    view.rerender(<ReplayPanel document={document} active={false} {...props} />)
    expect(screen.getByLabelText('Play replay')).toBeTruthy()
    act(() =>
      requestReplaySeek({ projectId: 'p', sourceSessionId: 's', branchId: 'main', stepId: 'two' })
    )
    expect(screen.getByLabelText('Replay branch').textContent).toContain('Main branch')
    expect(screen.getByLabelText('Replay progress').getAttribute('aria-valuenow')).toBe('1000')
    await act(async () => {})
  })

  it('does not replace current branch material with a late request from a previously selected branch', async () => {
    const pending = new Map<string, (value: ReplayPreparedResource) => void>()
    const readResource = vi.fn(
      (resource) =>
        new Promise<ReplayPreparedResource>((resolve) => pending.set(resource.id, resolve))
    )
    render(<ReplayPanel document={makeDocument()} {...callbacks()} readResource={readResource} />)
    seekProgress(1500)
    await act(async () => {})
    chooseBranch('Other branch')
    seekProgress(1000)
    openMaterials()
    fireEvent.click(screen.getByRole('button', { name: 'View files' }))
    fireEvent.click(screen.getByRole('button', { name: 'v2.txt' }))
    await act(async () => pending.get('v2')!({ ...prepared, content: 'current branch bytes' }))
    await waitFor(() => expect(screen.getByText('current branch bytes')).toBeTruthy())
    await act(async () => pending.get('v1')!({ ...prepared, content: 'stale branch bytes' }))
    expect(screen.queryByText('stale branch bytes')).toBeNull()
    expect(screen.getByText('current branch bytes')).toBeTruthy()
  })

  it('loads the displayed run limit and retains those figures after a later artifact step', async () => {
    const document = makeDocument()
    const last = document.branches[0].steps[2]
    last.runs = Array.from({ length: 6 }, (_, index) => ({
      ...last.runs[0],
      runId: `run-${index}`
    }))
    document.branches[0].steps.push({
      ...step('later-file', 3000, 'Saved file'),
      resourceIds: ['v2']
    })
    document.branches[0].durationMs = 4000
    const result = await callbacks().readNotebookRun()
    const readNotebookRun = vi.fn(
      async (_source: ReplayDocument['source'], index: ReplayStep['runs'][number]) => ({
        ...result,
        status: 'ready' as const,
        run: { ...result.run, runId: index.runId }
      })
    )
    render(<ReplayPanel document={document} {...callbacks()} readNotebookRun={readNotebookRun} />)
    seekProgress(2900)
    await waitFor(() =>
      expect(screen.getByTestId('replay-stage').getAttribute('data-replay-frame-ready')).toBe(
        'true'
      )
    )
    expect(readNotebookRun.mock.calls.map(([, index]) => index.runId)).toEqual([
      'run-0',
      'run-1',
      'run-2',
      'run-3'
    ])
    seekProgress(4000)
    await waitFor(() =>
      expect(within(screen.getByTestId('replay-stage')).getByText('Saved file')).toBeTruthy()
    )
    expect(readNotebookRun).toHaveBeenCalledTimes(4)
  })

  it('previews a generated file in replay using its recorded version and restores focus on return', async () => {
    const document = makeDocument()
    for (const item of document.branches[0].steps.slice(1)) {
      item.kind = 'artifact'
      item.message = undefined
      item.runs = []
    }
    const props = callbacks()
    const readResource = vi.fn(async (resource: ReplayDocument['resources'][number]) => ({
      ...prepared,
      content: `Recorded ${resource.versionId}`
    }))
    render(<ReplayPanel document={document} {...props} readResource={readResource} />)
    seekProgress(1000)
    expect(
      (screen.getByRole('button', { name: 'Preview generated file v1.txt' }) as HTMLButtonElement)
        .disabled
    ).toBe(false)
    const original = screen.getByRole('button', { name: 'Preview generated file v1.txt' })
    original.focus()
    fireEvent.click(original)
    await waitFor(() => expect(screen.getByText('Recorded v1')).toBeTruthy())
    expect(screen.queryByText('Recorded v2')).toBeNull()
    expect(screen.queryByRole('tab')).toBeNull()
    expect(screen.getByRole('region', { name: 'Research materials' })).toBe(
      globalThis.document.activeElement
    )
    expect(props.onOpenEvidence).not.toHaveBeenCalled()
    expect(readResource.mock.calls.some(([resource]) => resource.versionId === 'v1')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Back to conversation' }))
    await waitFor(() => expect(globalThis.document.activeElement).toBe(original))
    expect(screen.queryByText('Recorded v2')).toBeNull()
    fireEvent.click(original)
    chooseBranch('Other branch')
    expect(screen.queryByRole('button', { name: 'Back to conversation' })).toBeNull()
    expect(screen.queryByText('Recorded v1')).toBeNull()
    await act(async () => {})
  })

  it.each([0.5, 1.5] as const)(
    'restores a legacy %s× checkpoint at 2× without losing position',
    async (rate) => {
      render(
        <ReplayPanel
          document={makeDocument()}
          initialView={{
            fingerprint: 'fp',
            generatorVersion: 3,
            branchId: 'main',
            timeMs: 1500,
            rate
          }}
          {...callbacks()}
        />
      )
      expect(screen.getByLabelText('Playback speed').textContent).toContain('2×')
      expect(
        screen.getByRole('slider', { name: 'Replay progress' }).getAttribute('aria-valuenow')
      ).toBe('1500')
      await act(async () => {})
    }
  )

  it('restores an exact saved checkpoint paused with a plain completed status', async () => {
    const document = makeDocument()
    const props = callbacks()
    render(
      <ReplayPanel
        document={document}
        initialView={{
          fingerprint: 'fp',
          generatorVersion: 3,
          branchId: 'main',
          stepId: 'three',
          timeMs: 3000,
          rate: 4
        }}
        {...props}
      />
    )
    expect(screen.getByLabelText('Watch again')).toBeTruthy()
    expect(screen.getByLabelText('Playback speed').textContent).toContain('4×')
    expect(screen.getByText('Completed')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Browse steps' }))
    expect(screen.getByText('Completed')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Close step list' }))
    expect(screen.getByText('Completed')).toBeTruthy()
    expect(screen.queryByRole('dialog', { name: 'Replay complete' })).toBeNull()
    expect(screen.getByText('Completed').closest('button')).toBeNull()
    await act(async () => {})
  })
})

describe('standalone replay stage', () => {
  it('does not rerender unchanged Notebook cells on interactive clock ticks', async () => {
    const cell = vi.spyOn(notebookCell, 'NotebookRecordCell')
    const document = makeDocument()
    document.branches[0].steps[2].kind = 'notebook'
    const props = {
      document,
      fitContainer: true,
      materialsOpen: true,
      presentation: createReplayPresentation(),
      resources: { v1: prepared, v2: prepared },
      runDetails: { run1: await callbacks().readNotebookRun() }
    }
    const view = render(
      <ReplayStage {...props} scene={projectReplayScene(document, 'main', 2600)} />
    )
    await waitFor(() =>
      expect(screen.getByTestId('replay-stage').getAttribute('data-replay-frame-ready')).toBe(
        'true'
      )
    )
    expect(cell).toHaveBeenCalled()
    cell.mockClear()
    for (const time of [2650, 2700, 2750]) {
      view.rerender(<ReplayStage {...props} scene={projectReplayScene(document, 'main', time)} />)
      expect(screen.getByTestId('replay-stage').getAttribute('data-replay-frame-ready')).toBe(
        'true'
      )
    }
    expect(cell).not.toHaveBeenCalled()
    view.rerender(<ReplayStage {...props} scene={projectReplayScene(document, 'main', 2050)} />)
    expect(cell).toHaveBeenCalled()
  })

  it('projects the same historical frame through incremental advances or a direct seek', async () => {
    const document = makeDocument()
    const resources = { v1: prepared, v2: prepared }
    const runDetails = { run1: await callbacks().readNotebookRun() }
    const view = render(
      <ReplayStage
        document={document}
        scene={projectReplayScene(document, 'main', 0)}
        resources={resources}
        runDetails={runDetails}
      />
    )
    for (const time of [500, 1000, 1500, 2000, 2600])
      view.rerender(
        <ReplayStage
          document={document}
          scene={projectReplayScene(document, 'main', time)}
          resources={resources}
          runDetails={runDetails}
        />
      )
    await waitFor(() =>
      expect(screen.getByTestId('replay-stage').getAttribute('data-replay-frame-ready')).toBe(
        'true'
      )
    )
    const advanced = screen.getByTestId('replay-stage').innerHTML
    view.unmount()
    render(
      <ReplayStage
        document={document}
        scene={projectReplayScene(document, 'main', 2600)}
        resources={resources}
        runDetails={runDetails}
      />
    )
    await waitFor(() =>
      expect(screen.getByTestId('replay-stage').getAttribute('data-replay-frame-ready')).toBe(
        'true'
      )
    )
    expect(screen.getByTestId('replay-stage').innerHTML).toBe(advanced)
    expect(screen.getByTestId('replay-stage').style.width).toBe('1280px')
    expect(screen.getByTestId('replay-stage').style.height).toBe('720px')
  })
})

describe('replay source and evidence isolation', () => {
  it('consumes a seek queued before mounting and preserves the step offset in discussion context', async () => {
    requestReplaySeek({
      projectId: 'p',
      sourceSessionId: 's',
      branchId: 'main',
      stepId: 'two',
      stepOffsetMs: 750
    })
    const props = callbacks()
    render(<ReplayPanel document={makeDocument()} {...props} />)
    expect(screen.getByLabelText('Replay progress').getAttribute('aria-valuenow')).toBe('1750')
    fireEvent.click(screen.getByText('Ask about this step'))
    expect(props.onAskStep.mock.calls[0][0].stepOffsetMs).toBe(750)
    expect(props.onAskStep.mock.calls[0][0].excerpt).toBe('Interpret saved evidence')
    await act(async () => {})
  })

  it('resets state and cached material when another import shares the package fingerprint', async () => {
    const first = makeDocument()
    const props = callbacks()
    const view = render(<ReplayPanel document={first} {...props} />)
    seekProgress(1700)
    openMaterials()
    fireEvent.click(screen.getByRole('button', { name: 'View files' }))
    fireEvent.click(screen.getByRole('button', { name: 'v1.txt' }))
    await waitFor(() => expect(screen.getByText('historical material')).toBeTruthy())
    const second = makeDocument()
    second.source.sessionId = 'second-import'
    second.branches[0].steps[0].message!.content = 'Different imported conversation'
    view.rerender(<ReplayPanel document={second} {...props} />)
    expect(screen.getByLabelText('Replay progress').getAttribute('aria-valuenow')).toBe('0')
    expect(screen.queryByText('historical material')).toBeNull()
    expect(screen.getByLabelText('Play replay')).toBeTruthy()
    await act(async () => {})
  })

  it('does not reveal Notebook results or artifact evidence during input, including reduced motion', async () => {
    const document = makeDocument()
    const execution = document.branches[0].steps[2]
    execution.kind = 'notebook'
    execution.evidence.push(
      { kind: 'notebook-run', id: 'run1', projectId: 'p', sessionId: 's' },
      {
        kind: 'artifact-version',
        id: 'v2',
        artifactId: 'file',
        versionId: 'v2',
        projectId: 'p',
        sessionId: 's'
      }
    )
    const props = callbacks()
    render(<ReplayPanel document={document} {...props} />)
    seekProgress(2100)
    await waitFor(() =>
      expect(
        window.document.querySelector('[data-replay-notebook-run="run1"] code')?.textContent
      ).toContain('print(42)')
    )
    expect(screen.queryByTestId('notebook-text-output')).toBeNull()
    expect(screen.queryByText('v2.txt')).toBeNull()
    fireEvent.click(screen.getByText('Ask about this step'))
    const context = props.onAskStep.mock.calls[0][0] as SessionDiscussionCapture
    expect(context.evidence.some((item) => item.kind === 'artifact-version')).toBe(false)
    expect(context.evidence.find((item) => item.kind === 'notebook-run')?.part).toBe('input')
    seekProgress(2800)
    expect(screen.getByTestId('notebook-text-output')).toBeTruthy()
    expect(screen.getByText('42', { selector: 'pre' })).toBeTruthy()
    openMaterials()
    fireEvent.click(screen.getByRole('button', { name: 'View files' }))
    expect(screen.getByRole('button', { name: 'v2.txt' })).toBeTruthy()
  })
})

describe('replay readiness clock', () => {
  it('keeps resources available while a seek waits for paint and cancels the preceding frame', async () => {
    let sequence = 0
    const frames = new Map<number, FrameRequestCallback>()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++sequence, callback)
      return sequence
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
    const tick = async (time: number): Promise<void> => {
      await act(async () => {
        const scheduled = [...frames.values()]
        frames.clear()
        scheduled.forEach((callback) => callback(time))
      })
    }
    const document = makeDocument()
    const onReady = vi.fn()
    const view = render(
      <ReplayStage
        document={document}
        scene={projectReplayScene(document, 'main', 0)}
        onReady={onReady}
      />
    )
    await tick(0)
    expect(onReady).toHaveBeenLastCalledWith(
      expect.objectContaining({ ready: false, resourcesReady: true, positionMs: 0 })
    )
    await tick(16)
    await tick(32)
    expect(onReady).toHaveBeenLastCalledWith(
      expect.objectContaining({ ready: true, resourcesReady: true, positionMs: 0 })
    )
    view.rerender(
      <ReplayStage
        document={document}
        scene={projectReplayScene(document, 'main', 500)}
        onReady={onReady}
      />
    )
    await tick(48)
    expect(onReady).toHaveBeenLastCalledWith(
      expect.objectContaining({ ready: false, resourcesReady: true, positionMs: 500 })
    )
    view.rerender(
      <ReplayStage
        document={document}
        scene={projectReplayScene(document, 'main', 750)}
        onReady={onReady}
      />
    )
    await tick(64)
    expect(onReady).toHaveBeenLastCalledWith(
      expect.objectContaining({ ready: false, resourcesReady: true, positionMs: 750 })
    )
    expect(onReady.mock.calls.some(([value]) => value.ready && value.positionMs === 500)).toBe(
      false
    )
    await tick(80)
    expect(onReady).toHaveBeenLastCalledWith(
      expect.objectContaining({ ready: true, resourcesReady: true, positionMs: 750 })
    )
  })

  it('freezes logical time while required bytes are pending, then resumes without adding wait time', async () => {
    let resolveMaterial!: (value: ReplayPreparedResource) => void
    const pending = new Promise<ReplayPreparedResource>((resolve) => {
      resolveMaterial = resolve
    })
    let sequence = 0
    const frames = new Map<number, FrameRequestCallback>()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++sequence, callback)
      return sequence
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
    const tick = async (time: number): Promise<void> => {
      await act(async () => {
        const ready = [...frames.values()]
        frames.clear()
        ready.forEach((callback) => callback(time))
      })
    }
    render(
      <ReplayPanel
        document={makeDocument()}
        initialView={{
          fingerprint: 'fp',
          generatorVersion: 3,
          branchId: 'main',
          timeMs: 0,
          rate: 1
        }}
        {...callbacks()}
        readResource={() => pending}
      />
    )
    seekProgress(1500)
    fireEvent.click(screen.getByLabelText('Play replay'))
    await tick(1000)
    await tick(5000)
    expect(screen.getByLabelText('Replay progress').getAttribute('aria-valuenow')).toBe('1500')
    const pauseButton = screen.getByRole('button', { name: 'Pause replay' })
    const pauseIcon = pauseButton.querySelector('.lucide-pause')
    expect(pauseIcon).not.toBeNull()
    await act(async () => resolveMaterial(prepared))
    await tick(5100)
    await tick(5200)
    await tick(5300)
    await tick(5400)
    expect(screen.getByRole('button', { name: 'Pause replay' })).toBe(pauseButton)
    expect(pauseButton.querySelector('.lucide-pause')).toBe(pauseIcon)
    expect(
      Number(screen.getByLabelText('Replay progress').getAttribute('aria-valuenow'))
    ).toBeGreaterThan(1500)
    expect(
      Number(screen.getByLabelText('Replay progress').getAttribute('aria-valuenow'))
    ).toBeLessThan(2000)
    const position = Number(screen.getByLabelText('Replay progress').getAttribute('aria-valuenow'))
    // Stay within this step (the next starts at 2000 ms). Its capture readiness is pending
    // as logical time advances; the paint barrier must not throttle the player.
    for (const time of [5416, 5432, 5448]) await tick(time)
    expect(Number(screen.getByLabelText('Replay progress').getAttribute('aria-valuenow'))).toBe(
      position + 48
    )
    fireEvent.click(pauseButton)
    expect(
      screen.getByRole('button', { name: 'Play replay' }).querySelector('.lucide-play')
    ).not.toBeNull()
  })
})

describe('replay source metadata and final results', () => {
  it('keeps imported package origin and excluded files inspectable beside the replay', async () => {
    const document = makeDocument()
    document.source.packageOrigin = {
      importId: 'import',
      sourceProjectId: 'original-project',
      sourceSessionId: 'original-session',
      importedAt: 1700000000000,
      manifestChecksum: 'a'.repeat(64),
      excludedFiles: [{ storageKey: 'large', filename: 'large-dataset.csv', sizeBytes: 10000000 }]
    }
    render(<ReplayPanel document={document} {...callbacks()} />)
    expect(screen.queryByText('Imported research history')).toBeNull()
    expect(screen.queryByText('Recorded steps: 3; files: 2')).toBeNull()
    const trigger = screen.getByRole('button', { name: 'Session information: Archived research' })
    trigger.focus()
    fireEvent.click(trigger)
    expect(screen.getByRole('dialog', { name: 'Archived research' })).toBeTruthy()
    expect(screen.getByText('Recorded steps: 3; files: 2')).toBeTruthy()
    expect(screen.getByText('original-project')).toBeTruthy()
    expect(screen.getByText('original-session')).toBeTruthy()
    fireEvent.click(screen.getByText('Not included in this package'))
    expect(screen.getByText('large-dataset.csv')).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(globalThis.document.activeElement).toBe(trigger))
    expect(screen.queryByText('original-project')).toBeNull()
    chooseBranch('Other branch')
    fireEvent.click(trigger)
    expect(screen.getByText('Recorded steps: 1; files: 2')).toBeTruthy()
    await act(async () => {})
  })

  it('offers all reached branch file results at the end, not only files owned by the last message', async () => {
    const document = makeDocument()
    const props = callbacks()
    render(<ReplayPanel document={document} {...props} />)
    seekProgress(3000)
    fireEvent.click(screen.getByRole('button', { name: 'View files' }))
    const results = screen.getByRole('complementary', { name: 'Files' })
    expect(results.textContent).toContain('v1.txt')
    expect(results.textContent).toContain('v2.txt')
    fireEvent.click(within(results).getByRole('button', { name: 'v1.txt' }))
    expect(props.onOpenEvidence).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Back to files' })).toBeTruthy()
    expect(screen.queryByRole('dialog', { name: 'View research materials' })).toBeNull()
    await act(async () => {})
  })
})

it('opens the inline material pane and returns keyboard focus when it closes', async () => {
  render(<ReplayPanel document={makeDocument()} {...callbacks()} />)
  const trigger = screen.getByRole('button', { name: 'Notebook' })
  trigger.focus()
  openMaterials()
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole('region', { name: 'Research materials' }))
  )
  expect(screen.getByText('No materials at this point.')).toBeTruthy()
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.keyDown(screen.getByRole('region', { name: 'Research materials' }), {
    key: 'Escape'
  })
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  expect(document.activeElement).toBe(trigger)
  expect(screen.getByRole('region', { name: 'Historical conversation' })).toBeTruthy()
  await act(async () => {})
})

it.each([false, true])(
  'defaults both panes open on modal entry, including a mounted modal (%s)',
  async (initiallyExpanded) => {
    const props = { document: makeDocument(), ...callbacks() }
    const mounted = render(<ReplayPanel {...props} expanded={initiallyExpanded} />)
    const notebook = screen.getByRole('button', { name: 'Notebook' })
    const files = screen.getByRole('button', { name: 'View files' })
    expect(notebook.getAttribute('aria-expanded')).toBe(String(initiallyExpanded))
    expect(files.getAttribute('aria-expanded')).toBe(String(initiallyExpanded))
    mounted.rerender(<ReplayPanel {...props} expanded />)
    expect(notebook.getAttribute('aria-expanded')).toBe('true')
    expect(files.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Close files' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close research materials' }))
    mounted.rerender(<ReplayPanel {...props} expanded />)
    expect(notebook.getAttribute('aria-expanded')).toBe('false')
    expect(files.getAttribute('aria-expanded')).toBe('false')
    mounted.rerender(<ReplayPanel {...props} expanded={false} />)
    mounted.rerender(<ReplayPanel {...props} expanded />)
    expect(notebook.getAttribute('aria-expanded')).toBe('true')
    expect(files.getAttribute('aria-expanded')).toBe('true')
    await act(async () => {})
  }
)

it('keeps modal panes side by side while its entrance animation scales the visible bounds', async () => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1150)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(0, 0, 1092.5, 800)
  )
  render(<ReplayPanel document={makeDocument()} {...callbacks()} expanded />)
  const conversation = screen.getByRole('region', { name: 'Historical conversation', hidden: true })
  expect(conversation.classList.contains('hidden')).toBe(false)
  expect(screen.getByRole('complementary', { name: 'Files' }).classList.contains('absolute')).toBe(
    false
  )
  fireEvent.click(screen.getByRole('button', { name: 'Close files' }))
  expect(conversation.classList.contains('hidden')).toBe(false)
  expect(screen.getByRole('region', { name: 'Research materials' })).toBeTruthy()
  await act(async () => {})
})

it.each([false, true])(
  'preserves playback on modal transitions (playing: %s), but pauses for inspection',
  async (playing) => {
    const onToggleExpanded = vi.fn()
    const props = { document: makeDocument(), ...callbacks(), onToggleExpanded }
    const mounted = render(<ReplayPanel {...props} />)
    seekProgress(1500)
    if (playing) fireEvent.click(screen.getByLabelText('Play replay'))
    fireEvent.click(screen.getByLabelText('Enter full screen'))
    expect(onToggleExpanded).toHaveBeenCalledOnce()
    mounted.rerender(<ReplayPanel {...props} expanded />)
    expect(screen.getByLabelText(playing ? 'Pause replay' : 'Play replay')).toBeTruthy()
    expect(screen.getByLabelText('Replay progress').getAttribute('aria-valuenow')).toBe('1500')
    fireEvent.click(screen.getByLabelText('Exit full screen'))
    expect(onToggleExpanded).toHaveBeenCalledTimes(2)
    mounted.rerender(<ReplayPanel {...props} expanded={false} />)
    expect(screen.getByLabelText(playing ? 'Pause replay' : 'Play replay')).toBeTruthy()
    if (!playing) fireEvent.click(screen.getByLabelText('Play replay'))
    fireEvent.keyDown(screen.getByLabelText('Research materials'), { key: 'PageDown' })
    expect(screen.getByLabelText('Play replay')).toBeTruthy()
    expect(screen.getByLabelText('Replay progress').getAttribute('aria-valuenow')).toBe('1500')
    await act(async () => {})
  }
)

it('shows only reached materials from the selected branch and hides them when seeking backward', async () => {
  const source = makeDocument()
  source.resources.push({
    ...source.resources[0],
    id: 'other-only',
    versionId: 'other-only',
    name: 'other-only.txt'
  })
  source.branches[1].steps[0].resourceIds = ['other-only']
  const props = callbacks()
  render(<ReplayPanel document={source} {...props} />)
  openMaterials()
  fireEvent.click(screen.getByRole('button', { name: 'View files' }))
  expect(screen.queryByRole('combobox', { name: 'Material scope' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'v2.txt' })).toBeNull()
  expect(document.querySelector('[data-replay-notebook-run]')).toBeNull()
  seekProgress(3000)
  expect(screen.getByRole('button', { name: 'v1.txt' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'v2.txt' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'other-only.txt' })).toBeNull()
  await waitFor(() =>
    expect(document.querySelector('[data-replay-notebook-run="run1"] code')?.textContent).toContain(
      'print(42)'
    )
  )
  fireEvent.click(screen.getByRole('button', { name: 'v2.txt' }))
  fireEvent.click(screen.getByRole('button', { name: 'Back to files' }))
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'v2.txt' }))
  )
  expect(screen.getByLabelText('Replay progress').getAttribute('aria-valuenow')).toBe('3000')
  seekProgress(0)
  expect(screen.queryByRole('button', { name: 'v2.txt' })).toBeNull()
  expect(document.querySelector('[data-replay-notebook-run]')).toBeNull()
  chooseBranch('Other branch')
  seekProgress(1000)
  expect(screen.getByRole('button', { name: 'other-only.txt' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'v1.txt' })).toBeNull()
  expect(props.onOpenEvidence).not.toHaveBeenCalled()
})

it('bounds Notebook and file pagination independently and keeps the selected version on return', async () => {
  const source = makeDocument()
  source.resources = Array.from({ length: 85 }, (_, index) => ({
    ...source.resources[0],
    id: `v${index}`,
    versionId: `v${index}`,
    name: `file-${index}.png`,
    mimeType: 'image/png'
  }))
  source.branches[0].steps[2].runs = Array.from({ length: 10 }, (_, index) => ({
    ...source.branches[0].steps[2].runs[0],
    runId: `run${index}`
  }))
  source.branches[0].steps[2].resourceIds = source.resources.map((resource) => resource.id)
  render(<ReplayPanel document={source} {...callbacks()} />)
  openMaterials()
  fireEvent.click(screen.getByRole('button', { name: 'View files' }))
  seekProgress(3000)
  const files = screen.getByRole('complementary', { name: 'Files' })
  expect(within(files).getAllByRole('button', { name: /file-/ })).toHaveLength(40)
  expect(screen.getByText('Page 1 of 3')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Load earlier runs' })).toBeTruthy()
  await waitFor(() =>
    expect(document.querySelectorAll('[data-replay-notebook-run]')).toHaveLength(4)
  )
  fireEvent.click(screen.getByRole('button', { name: 'Load earlier runs' }))
  await waitFor(() =>
    expect(document.querySelectorAll('[data-replay-notebook-run]')).toHaveLength(8)
  )
  fireEvent.click(within(files).getByRole('button', { name: 'Next page' }))
  fireEvent.click(within(files).getByRole('button', { name: 'file-40.png' }))
  fireEvent.keyDown(screen.getByRole('region', { name: 'Research materials' }), {
    key: 'Escape'
  })
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'file-40.png' }))
  )
  expect(
    within(screen.getByRole('complementary', { name: 'Files' })).getByText('Page 2 of 3')
  ).toBeTruthy()
  expect(screen.getByLabelText('Replay progress').getAttribute('aria-valuenow')).toBe('3000')
})

it('clears completion on seek and restarts with the existing play control', async () => {
  render(<ReplayPanel document={makeDocument()} {...callbacks()} />)
  seekProgress(3000)
  expect(screen.getByText('Completed').closest('button')).toBeNull()
  seekProgress(1000)
  expect(screen.queryByText('Completed')).toBeNull()
  seekProgress(3000)
  fireEvent.click(screen.getByRole('button', { name: 'Watch again' }))
  expect(screen.getByRole('slider').getAttribute('aria-valuenow')).toBe('0')
  expect(screen.queryByText('Completed')).toBeNull()
  expect(screen.getByRole('button', { name: 'Pause replay' })).toBeTruthy()
  chooseBranch('Other branch')
  seekProgress(1000)
  expect(screen.getByText('Completed').closest('button')).toBeNull()
  await act(async () => {})
})

it('shows an empty archive without claiming completion or offering playback', async () => {
  const document = makeDocument()
  document.branches = [{ ...document.branches[0], steps: [], durationMs: 0 }]
  render(<ReplayPanel document={document} {...callbacks()} />)
  expect(screen.queryByText('Completed')).toBeNull()
  expect(screen.getAllByText('No steps').some((node) => !node.closest('button'))).toBe(true)
  expect(screen.getByRole('button', { name: 'Play replay' }).hasAttribute('disabled')).toBe(true)
  expect(screen.queryByRole('dialog')).toBeNull()
  await act(async () => {})
})

it('retains each branch position in the existing checkpoint and restores it after remount', async () => {
  const document = makeDocument()
  const onViewChange = vi.fn()
  const props = callbacks()
  const view = render(<ReplayPanel document={document} {...props} onViewChange={onViewChange} />)
  seekProgress(1600)
  chooseBranch('Other branch')
  seekProgress(500)
  chooseBranch('Main branch')
  expect(screen.getByLabelText('Replay progress').getAttribute('aria-valuenow')).toBe('1600')
  await waitFor(() => expect(onViewChange).toHaveBeenCalled())
  const saved = onViewChange.mock.calls.at(-1)![0]
  expect(saved.branchPositions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ branchId: 'main', timeMs: 1600 }),
      expect.objectContaining({ branchId: 'other', timeMs: 500 })
    ])
  )
  view.unmount()
  render(<ReplayPanel document={document} {...props} initialView={saved} />)
  chooseBranch('Other branch')
  expect(screen.getByLabelText('Replay progress').getAttribute('aria-valuenow')).toBe('500')
  expect(screen.getByLabelText('Play replay')).toBeTruthy()
})

it('relocates unvisited branch checkpoints by stable step when the generator changes', () => {
  const document = makeDocument()
  const other = document.branches.find((branch) => branch.id === 'other')!
  render(
    <ReplayPanel
      document={document}
      {...callbacks()}
      initialView={{
        fingerprint: document.source.fingerprint,
        generatorVersion: 2,
        branchId: 'main',
        timeMs: 0,
        rate: 1,
        branchPositions: [
          { branchId: 'other', stepId: other.steps[0].id, stepOffsetMs: 250, timeMs: 99999 }
        ]
      }}
    />
  )
  chooseBranch('Other branch')
  expect(screen.getByLabelText('Replay progress').getAttribute('aria-valuenow')).toBe('250')
})

it('keeps the saved step when independently recorded reviews shift the timeline', () => {
  const document = makeDocument()
  render(
    <ReplayPanel
      document={document}
      {...callbacks()}
      initialView={{
        fingerprint: document.source.fingerprint,
        generatorVersion: document.generatorVersion,
        branchId: 'main',
        stepId: 'two',
        stepOffsetMs: 250,
        timeMs: 250,
        rate: 1
      }}
    />
  )
  expect(screen.getByLabelText('Replay progress').getAttribute('aria-valuenow')).toBe('1250')
})

it('reports missing Reviewer evidence while retaining the conversation', () => {
  render(
    <ReplayPanel
      document={{ ...makeDocument(), issues: [{ code: 'review-unavailable' }] }}
      {...callbacks()}
    />
  )
  expect(screen.getByText('Session Reviewer: The recorded evidence is unavailable.')).toBeTruthy()
  expect(screen.getByLabelText('Replay progress')).toBeTruthy()
})

it('explains progress-dependent material visibility and does not promise missing branch records', () => {
  const source = makeDocument()
  source.branches[1].steps[0].resourceIds = []
  render(<ReplayPanel document={source} {...callbacks()} />)
  openMaterials()
  const material = screen.getByRole('region', { name: 'Research materials' })
  expect(within(material).getByRole('button', { name: 'Close research materials' })).toBeTruthy()
  expect(within(material).getByRole('heading', { name: 'Notebook' })).toBeTruthy()
  expect(within(material).getByText('No materials at this point.')).toBeTruthy()
  chooseBranch('Other branch')
  expect(within(material).getByText('No materials recorded in this branch.')).toBeTruthy()
  expect(within(material).queryByRole('button', { name: 'Jump to first material' })).toBeNull()
  expect(within(material).queryByText(/Play or move the progress bar/)).toBeNull()
})

it('jumps from the empty materials pane to its first recorded output', async () => {
  render(<ReplayPanel document={makeDocument()} {...callbacks()} />)
  openMaterials()
  fireEvent.click(screen.getByRole('button', { name: 'Jump to first material' }))
  await screen.findByRole('button', { name: 'v1.txt' })
  expect(screen.queryByText('No materials at this point.')).toBeNull()
  expect(
    Number(screen.getByLabelText('Replay progress').getAttribute('aria-valuenow'))
  ).toBeGreaterThan(0)
})

it('identifies artifact versions and opens normal records without an intermediate detail page', async () => {
  const source = makeDocument()
  source.resources.forEach((resource, index) => {
    resource.name = 'result.png'
    resource.versionNumber = index + 1
    source.branches[0].steps[index + 1].kind = 'artifact'
  })
  const props = callbacks()
  render(<ReplayPanel document={source} {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Browse steps' }))
  const directory = screen.getByRole('dialog', { name: 'Browse steps' })
  expect(within(directory).getByText('result.png · Version 1')).toBeTruthy()
  expect(within(directory).getByText('result.png · Version 2')).toBeTruthy()
  fireEvent.click(
    within(directory).getByRole('button', { name: 'Open original evidence for step 2' })
  )
  expect(props.onOpenEvidence).toHaveBeenCalledExactlyOnceWith(
    undefined,
    source.branches[0].steps[1]
  )
  expect(screen.queryByRole('dialog', { name: 'Browse steps' })).toBeNull()
  expect(screen.getByLabelText('Replay progress').getAttribute('aria-valuenow')).toBe('0')
  await act(async () => {})
})

it.each([
  [{ status: 'unavailable', reason: 'not-recorded' }, false],
  [{ status: 'unsupported' }, false],
  [{ status: 'unavailable', reason: 'read-failed' }, true],
  [{ status: 'timeout' }, true]
] as const)(
  'only offers resource retry for recoverable failures: %j',
  async (result, retryable) => {
    const props = callbacks()
    props.readResource.mockResolvedValue(result)
    render(<ReplayPanel document={makeDocument()} {...props} />)
    seekProgress(3000)
    openMaterials()
    fireEvent.click(screen.getByRole('button', { name: 'View files' }))
    fireEvent.click(await screen.findByRole('button', { name: 'v1.txt' }))
    await screen.findByText('Some source material is incomplete or unavailable.')
    expect(Boolean(screen.queryByRole('button', { name: 'Prepare material again' }))).toBe(
      retryable
    )
  }
)

it('checkpoints continuous playback every five seconds and stops the timer on pause', async () => {
  vi.useFakeTimers()
  try {
    const onViewChange = vi.fn()
    const view = render(
      <ReplayPanel document={makeDocument()} {...callbacks()} onViewChange={onViewChange} />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Play replay' }))
    await act(async () => {
      vi.advanceTimersByTime(4999)
    })
    expect(onViewChange).not.toHaveBeenCalled()
    await act(async () => {
      vi.advanceTimersByTime(1)
    })
    expect(onViewChange).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Pause replay' }))
    await act(async () => {
      vi.advanceTimersByTime(250)
    })
    onViewChange.mockClear()
    await act(async () => {
      vi.advanceTimersByTime(10000)
    })
    expect(onViewChange).not.toHaveBeenCalled()
    view.unmount()
  } finally {
    vi.useRealTimers()
  }
})

it('keeps the pause action stable through material preparation and allows pausing while waiting', () => {
  const props = {
    playing: true,
    ready: true,
    positionMs: 1000,
    durationMs: 3000,
    stepIndex: 1,
    steps: makeDocument().branches[0].steps,
    speed: 1 as const,
    onPause: vi.fn(),
    onOpenEvidence: vi.fn(),
    onToggle: vi.fn(),
    onPrevious: vi.fn(),
    onNext: vi.fn(),
    onSeek: vi.fn(),
    onSpeed: vi.fn(),
    onAsk: vi.fn()
  }
  const view = render(<ReplayControls {...props} />)
  const button = screen.getByRole('button', { name: 'Pause replay' })
  const icon = button.querySelector('.lucide-pause')
  expect(icon).not.toBeNull()
  for (const ready of [false, true, false]) {
    view.rerender(<ReplayControls {...props} ready={ready} />)
    expect(screen.getByRole('button', { name: 'Pause replay' })).toBe(button)
    expect(button.querySelector('.lucide-pause')).toBe(icon)
    expect(within(button).getByRole('status').textContent).toBe(
      ready ? '' : 'Preparing recorded material…'
    )
  }
  fireEvent.click(button)
  expect(props.onToggle).toHaveBeenCalledOnce()
  view.rerender(<ReplayControls {...props} playing={false} ready={false} />)
  expect(
    screen.getByRole('button', { name: 'Play replay' }).querySelector('.lucide-play')
  ).not.toBeNull()
})

it('groups adjacent generated files in one gallery without changing timeline steps or reveal order', async () => {
  const source = makeDocument()
  source.branches[0].steps = [
    step('message', 0, 'Result'),
    ...['v1', 'v2'].map((id, index) => ({
      ...step(id, (index + 1) * 1000, ''),
      kind: 'artifact' as const,
      message: undefined,
      resourceIds: [id]
    }))
  ]
  render(<ReplayPanel document={source} {...callbacks()} expanded />)
  seekProgress(3000)
  expect(screen.getAllByText('GENERATED · 2')).toHaveLength(1)
  const cards = screen.getAllByRole('button', { name: /Preview generated file/ })
  expect(cards).toHaveLength(2)
  expect(cards[0].parentElement).toBe(cards[1].parentElement)
  expect(source.branches[0].steps).toHaveLength(3)
  seekProgress(1000)
  expect(screen.getByRole('button', { name: 'Preview generated file v1.txt' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Preview generated file v2.txt' })).toBeNull()
  seekProgress(2000)
  expect(screen.getAllByText('GENERATED · 2')).toHaveLength(1)
  expect(
    screen.getByRole('button', { name: 'Preview generated file v1.txt' }).hasAttribute('disabled')
  ).toBe(false)
  expect(
    screen.getByRole('button', { name: 'Preview generated file v2.txt' }).hasAttribute('disabled')
  ).toBe(false)
  seekProgress(0)
  expect(screen.queryByRole('button', { name: /Preview generated file/ })).toBeNull()
  await act(async () => {})
})

it.each([false, true])(
  'restores the prior Notebook panel after Back and Escape from a conversation file (open: %s)',
  async (notebookOpen) => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1150)
    const source = makeDocument()
    source.branches[0].steps[1].kind = 'artifact'
    source.branches[0].steps[1].message = undefined
    render(<ReplayPanel document={source} {...callbacks()} expanded />)
    seekProgress(3000)
    const notebook = screen.getByRole('button', { name: 'Notebook' })
    if (!notebookOpen) fireEvent.click(notebook)
    const original = screen.getByRole('button', { name: 'Preview generated file v1.txt' })
    const conversation = screen.getByRole('region', { name: 'Historical conversation' })
    const notebookViewport = globalThis.document.querySelector<HTMLElement>(
      '[data-replay-notebook-scroll]'
    )!
    for (const close of ['back', 'escape']) {
      conversation.scrollTop = 73
      notebookViewport.scrollTop = 91
      original.focus()
      fireEvent.click(original)
      await screen.findByRole('button', { name: 'Back to conversation' })
      if (close === 'back')
        fireEvent.click(screen.getByRole('button', { name: 'Back to conversation' }))
      else fireEvent.keyDown(screen.getByTestId('replay-stage'), { key: 'Escape' })
      await waitFor(() => expect(globalThis.document.activeElement).toBe(original))
      expect(notebook.getAttribute('aria-expanded')).toBe(String(notebookOpen))
      expect(screen.queryByRole('button', { name: 'Back to conversation' })).toBeNull()
      expect(conversation.scrollTop).toBe(73)
      expect(notebookViewport.scrollTop).toBe(91)
    }
  }
)

it.each([false, true])(
  'keeps playback running when toggling Notebook and Files (expanded: %s)',
  async (expanded) => {
    render(<ReplayPanel document={makeDocument()} {...callbacks()} expanded={expanded} />)
    fireEvent.click(screen.getByRole('button', { name: 'Play replay' }))
    for (const name of ['Notebook', 'View files', 'Notebook', 'View files']) {
      fireEvent.click(screen.getByRole('button', { name }))
      expect(screen.getByRole('button', { name: 'Pause replay' })).toBeTruthy()
    }
    await act(async () => {})
  }
)

it.each(['artifact', 'upload'] as const)(
  'opens a recorded DOCX through the workspace renderer with an exact %s version',
  async (sourceKind) => {
    vi.stubGlobal('api', {})
    const source = makeDocument()
    source.resources[0] = {
      ...source.resources[0],
      source: sourceKind,
      fileId: 'upload-file',
      name: 'report.docx'
    }
    const props = callbacks()
    props.readResource.mockResolvedValue({ status: 'unsupported' })
    render(<ReplayPanel document={source} {...props} expanded />)
    expect(screen.queryByTestId('workspace-file-preview')).toBeNull()
    seekProgress(3000)
    fireEvent.click(screen.getByRole('button', { name: 'report.docx' }))
    const preview = await screen.findByTestId('workspace-file-preview')
    expect(preview.dataset).toMatchObject({
      version: 'v1',
      file: sourceKind === 'upload' ? 'upload-file' : 'file',
      source: sourceKind,
      format: 'word',
      readOnly: 'true'
    })
    fireEvent.click(screen.getByRole('button', { name: 'Back to files' }))
    expect(screen.queryByTestId('workspace-file-preview')).toBeNull()
  }
)

it('pages back to the first conversation record without exposing future steps and resets on seek/branch', async () => {
  const source = makeDocument()
  source.branches[0].steps = Array.from({ length: 30 }, (_, index) =>
    step(`history-${index}`, index * 1000, `Observation ${index}`)
  )
  source.branches[0].durationMs = 30000
  render(<ReplayPanel document={source} {...callbacks()} />)
  seekProgress(19500)
  const conversation = screen.getByRole('region', { name: 'Historical conversation' })
  const records = (): HTMLElement[] => [
    ...conversation.querySelectorAll<HTMLElement>('[data-replay-step]')
  ]
  expect(records()).toHaveLength(12)
  expect(records()[0].dataset.replayStep).toBe('history-8')
  expect(conversation.textContent).not.toContain('Observation 20')
  fireEvent.click(within(conversation).getByRole('button', { name: 'Load earlier messages' }))
  expect(records()).toHaveLength(20)
  expect(records()[0].dataset.replayStep).toBe('history-0')
  expect(within(conversation).queryByRole('button', { name: 'Load earlier messages' })).toBeNull()
  fireEvent.click(within(conversation).getByRole('button', { name: 'Return to current step' }))
  expect(records()).toHaveLength(12)
  fireEvent.click(within(conversation).getByRole('button', { name: 'Load earlier messages' }))
  seekProgress(25000)
  expect(records()).toHaveLength(12)
  expect(records()[0].dataset.replayStep).toBe('history-14')
  expect(within(conversation).queryByRole('button', { name: 'Return to current step' })).toBeNull()
  fireEvent.click(within(conversation).getByRole('button', { name: 'Load earlier messages' }))
  chooseBranch('Other branch')
  expect(records()).toHaveLength(1)
  expect(records()[0].dataset.replayStep).toBe('other-step')
  expect(conversation.textContent).not.toContain('Observation')
})

it('preserves the visible conversation record when earlier steps are prepended at the top', () => {
  const source = makeDocument()
  source.branches[0].steps = Array.from({ length: 30 }, (_, index) =>
    step(`history-${index}`, index * 1000, `Observation ${index}`)
  )
  source.branches[0].durationMs = 30000
  render(<ReplayPanel document={source} {...callbacks()} />)
  seekProgress(29500)
  const conversation = screen.getByRole('region', { name: 'Historical conversation' })
  conversation.scrollTop = 0
  const visible = conversation.querySelector<HTMLElement>('[data-replay-step]')!
  // The same DOM record moves down by the inserted history batch.
  vi.spyOn(visible, 'getBoundingClientRect')
    .mockReturnValueOnce(new DOMRect(0, 40, 300, 100))
    .mockReturnValueOnce(new DOMRect(0, 40, 300, 100))
    .mockReturnValue(new DOMRect(0, 1240, 300, 100))
  fireEvent.click(within(conversation).getByRole('button', { name: 'Load earlier messages' }))
  expect(conversation.scrollTop).toBe(1200)
  expect(visible.isConnected).toBe(true)
  expect(conversation.querySelectorAll('[data-replay-step]')).toHaveLength(24)
  fireEvent.click(within(conversation).getByRole('button', { name: 'Load earlier messages' }))
  expect(conversation.querySelectorAll('[data-replay-step]')).toHaveLength(30)
})

it('keeps standalone capture bounded when the interactive history is expanded', () => {
  const source = makeDocument()
  source.branches[0].steps = Array.from({ length: 30 }, (_, index) =>
    step(`history-${index}`, index * 1000, `Observation ${index}`)
  )
  source.branches[0].durationMs = 30000
  const { container } = render(
    <ReplayStage document={source} scene={projectReplayScene(source, 'main', 29500)} />
  )
  expect(container.querySelectorAll('[data-replay-step]')).toHaveLength(12)
  expect(screen.queryByRole('button', { name: 'Load earlier messages' })).toBeNull()
})

it('keeps replay following delayed automatic scroll and resumes after manual browsing', () => {
  const resizeCallbacks: ResizeObserverCallback[] = []
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback)
      }
      observe = vi.fn()
      disconnect = vi.fn()
    }
  )
  const resize = (): void => {
    act(() => resizeCallbacks.forEach((callback) => callback([], {} as ResizeObserver)))
  }
  const source = makeDocument()
  const scene = projectReplayScene(source, 'main', 1500)
  const mounted = render(<ReplayStage fitContainer document={source} scene={scene} />)
  const conversation = screen.getByRole('region', { name: 'Historical conversation' })
  const returnButton = (): HTMLElement | null =>
    within(conversation).queryByRole('button', { name: 'Return to current step' })
  Object.defineProperties(conversation, {
    clientHeight: { configurable: true, value: 400 },
    scrollHeight: { configurable: true, writable: true, value: 1000 },
    scrollTop: { configurable: true, writable: true, value: 0 }
  })
  resize()
  expect(conversation.scrollTop).toBe(600)
  // The prior automatic scroll event arrives after the next text chunk grew the transcript.
  Object.defineProperty(conversation, 'scrollHeight', { value: 1400 })
  fireEvent.scroll(conversation)
  expect(returnButton()).toBeNull()
  resize()
  expect(conversation.scrollTop).toBe(1000)

  conversation.scrollTop = 200
  fireEvent.scroll(conversation)
  expect(returnButton()).toBeTruthy()
  Object.defineProperty(conversation, 'scrollHeight', { value: 1800 })
  resize()
  expect(conversation.scrollTop).toBe(200)
  conversation.scrollTop = 1400
  fireEvent.scroll(conversation)
  expect(returnButton()).toBeNull()
  Object.defineProperty(conversation, 'scrollHeight', { value: 2200 })
  resize()
  expect(conversation.scrollTop).toBe(1800)

  conversation.scrollTop = 200
  fireEvent.scroll(conversation)
  fireEvent.click(returnButton()!)
  expect(returnButton()).toBeNull()
  expect(conversation.scrollTop).toBe(1800)
  conversation.scrollTop = 200
  fireEvent.scroll(conversation)
  mounted.rerender(
    <ReplayStage fitContainer document={source} scene={scene} conversationFocusRequest={1} />
  )
  expect(returnButton()).toBeNull()
  expect(conversation.scrollTop).toBe(1800)
})

describe('portable research replay', () => {
  it('does not publish a desktop playhead or consume desktop navigation in a browser host', async () => {
    const nativePlayhead = { projectId: 'other', sourceSessionId: 'other', capture: vi.fn() }
    useSessionReplayStore.setState({ playhead: nativePlayhead })
    const view = render(<ReplayPanel document={makeDocument()} host={null} {...callbacks()} />)
    expect(useSessionReplayStore.getState().playhead).toBe(nativePlayhead)
    act(() =>
      requestReplaySeek({ projectId: 'p', sourceSessionId: 's', branchId: 'main', stepId: 'three' })
    )
    expect(screen.getByLabelText('Replay progress').getAttribute('aria-valuenow')).toBe('0')
    view.unmount()
    expect(useSessionReplayStore.getState().playhead).toBe(nativePlayhead)
    useSessionReplayStore.setState({ playhead: undefined })
  })
  it('keeps original context beside narrow materials and allows saved history inspection without seeking', () => {
    const document = makeDocument()
    render(
      <ReplayPanel
        document={document}
        host={null}
        {...callbacks()}
        materialViews={[
          { id: 'project', label: 'Project replay', content: <div>Recorded project image</div> }
        ]}
        materialViewRequest={{ id: 'project', revision: 1 }}
      />
    )
    expect(screen.getByTestId('replay-current-context').textContent).toContain(
      'Initial observation'
    )
    expect(screen.getByText('Recorded project image')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Browse original conversation' }))
    expect(screen.getByText('Browsing saved history; playback position is unchanged.')).toBeTruthy()
    expect(screen.getAllByText('Final result').length).toBeGreaterThan(0)
    expect(screen.getByLabelText('Replay progress').getAttribute('aria-valuenow')).toBe('0')
    fireEvent.click(screen.getByRole('button', { name: 'Follow playback' }))
    expect(screen.queryByText('Browsing saved history; playback position is unchanged.')).toBeNull()
    expect(screen.getByText('Recorded project image')).toBeTruthy()
  })
})

describe('recorded clock checkpoint migration', () => {
  it.each([
    { saved: { stepId: 'two', stepOffsetMs: 250 }, expected: 1000 },
    { saved: { anchor: { kind: 'message' as const, id: 'two' } }, expected: 1000 },
    { saved: {}, expected: 0 }
  ])(
    'uses stable evidence rather than a legacy presentation offset: $saved',
    ({ saved, expected }) => {
      render(
        <ReplayPanel
          document={makeDocument()}
          host={null}
          {...callbacks()}
          recordedTimeOrigins={{ main: 1000 }}
          initialView={{
            fingerprint: 'fp',
            generatorVersion: 3,
            presentationVersion: 2,
            branchId: 'main',
            timeMs: 1250,
            rate: 1,
            ...saved
          }}
        />
      )
      expect(screen.getByLabelText('Replay progress').getAttribute('aria-valuenow')).toBe(
        String(expected)
      )
      if (!expected)
        expect(
          screen.getByText('The saved step is unavailable. Replay starts at the beginning.')
        ).toBeTruthy()
    }
  )
  it('resumes a recorded checkpoint including its recorded offset and labels new saves', async () => {
    const onViewChange = vi.fn()
    render(
      <ReplayPanel
        document={makeDocument()}
        host={null}
        {...callbacks()}
        onViewChange={onViewChange}
        recordedTimeOrigins={{ main: 1000 }}
        initialView={{
          fingerprint: 'fp',
          generatorVersion: 3,
          branchId: 'main',
          clock: 'recorded',
          stepId: 'two',
          stepOffsetMs: 250,
          timeMs: 1250,
          rate: 1
        }}
      />
    )
    expect(screen.getByLabelText('Replay progress').getAttribute('aria-valuenow')).toBe('1250')
    await waitFor(() =>
      expect(onViewChange).toHaveBeenCalledWith(
        expect.objectContaining({
          clock: 'recorded',
          stepOffsetMs: 250,
          branchPositions: expect.arrayContaining([
            expect.objectContaining({ branchId: 'main', clock: 'recorded' })
          ])
        })
      )
    )
  })
})

describe('single-material research presentation', () => {
  it.each([false, true])(
    'preserves the shared clock across mouse and keyboard material tab changes (playing: %s)',
    async (playing) => {
      let sequence = 0
      let timestamp = 0
      const frames = new Map<number, FrameRequestCallback>()
      vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        frames.set(++sequence, callback)
        return sequence
      })
      vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
      const tick = async (): Promise<void> => {
        await act(async () => {
          timestamp += 100
          const pending = [...frames.values()]
          frames.clear()
          pending.forEach((callback) => callback(timestamp))
        })
      }
      let playback: import('./ReplayStage').ReplayMaterialPlayback | undefined
      const source = makeDocument()
      source.resources = []
      source.branches = [
        {
          ...source.branches[0],
          durationMs: 10000,
          steps: [{ ...source.branches[0].steps[0], durationMs: 10000, endMs: 10000 }]
        }
      ]
      render(
        <ReplayPanel
          document={source}
          {...callbacks()}
          host={null}
          presentationMode="research"
          initialView={{
            fingerprint: 'fp',
            generatorVersion: 3,
            branchId: 'main',
            timeMs: 0,
            rate: 1
          }}
          recordedTimeOrigins={{ main: 10000 }}
          materialViews={[
            {
              id: 'project',
              label: 'Project replay',
              content: (_active, value) => {
                playback = value
                return <p>Saved project pixels</p>
              }
            },
            { id: 'results', label: 'Results', content: <p>Saved results</p> }
          ]}
        />
      )
      seekProgress(300)
      // Settle the recorded-material paint barrier before starting the shared clock.
      for (let frame = 0; frame < 5; frame++) await tick()
      if (playing) fireEvent.click(screen.getByRole('button', { name: 'Play replay' }))
      await tick()
      const position = (): number =>
        Number(
          screen.getByRole('slider', { name: 'Replay progress' }).getAttribute('aria-valuenow')
        )
      const verifyClock = async (changeTab: () => void): Promise<void> => {
        const before = position()
        expect(screen.getByTestId('replay-stage').getAttribute('data-replay-frame-ready')).toBe(
          'true'
        )
        changeTab()
        expect(position()).toBe(before)
        expect(
          screen.getByRole('button', { name: playing ? 'Pause replay' : 'Play replay' })
        ).toBeTruthy()
        await tick()
        await tick()
        if (playing) {
          expect(position()).toBeGreaterThan(before)
          expect(position()).toBeLessThanOrEqual(before + 200)
        } else expect(position()).toBe(before)
      }
      for (const name of [
        'Project replay',
        'Original conversation',
        'Notebook',
        'Results',
        'Project replay'
      ]) {
        await verifyClock(() => fireEvent.click(screen.getByRole('tab', { name })))
      }
      const project = screen.getByRole('tab', { name: 'Project replay' })
      project.focus()
      await verifyClock(() => fireEvent.keyDown(project, { key: 'Home' }))
      expect(document.activeElement).toBe(
        screen.getByRole('tab', { name: 'Original conversation' })
      )
      await verifyClock(() => fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' }))
      expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Notebook' }))
      await verifyClock(() => fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' }))
      expect(playback).toMatchObject({
        positionMs: position(),
        recordedAt: 10000 + position(),
        playing,
        speed: 1
      })
    }
  )

  it('keeps one primary pane and one clock even when the native preview is expanded', async () => {
    const cb = callbacks()
    render(
      <ReplayPanel
        document={makeDocument()}
        {...cb}
        host={null}
        presentationMode="research"
        expanded
        materialViews={[
          { id: 'project', label: 'Project replay', content: <p>Saved project pixels</p> },
          { id: 'results', label: 'Results', content: <p>Saved results</p> }
        ]}
      />
    )
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Original conversation',
      'Notebook',
      'Project replay',
      'Results'
    ])
    expect(
      screen.getByRole('tab', { name: 'Original conversation' }).getAttribute('aria-selected')
    ).toBe('true')
    expect(screen.queryByTestId('replay-process-kind')).toBeNull()
    expect(screen.getByTestId('replay-stage').getAttribute('data-replay-layout')).toBe('research')
    expect(screen.getAllByRole('slider')).toHaveLength(1)
    seekProgress(1500)
    fireEvent.click(screen.getByRole('tab', { name: 'Project replay' }))
    expect(screen.getByRole('slider').getAttribute('aria-valuenow')).toBe('1500')
    expect(
      screen
        .getByRole('region', { name: 'Historical conversation', hidden: true })
        .closest('[data-replay-pane]')
        ?.getAttribute('data-replay-pane-visible')
    ).toBe('false')
    expect(screen.getByTestId('replay-question-footer')).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: 'Ask about this content' }) as HTMLButtonElement).disabled
    ).toBe(true)
    fireEvent.click(screen.getByRole('tab', { name: 'Original conversation' }))
    expect(screen.getByRole('slider').getAttribute('aria-valuenow')).toBe('1500')
    const conversation = screen.getByRole('tab', { name: 'Original conversation' })
    conversation.focus()
    fireEvent.keyDown(conversation, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Notebook' }))
    expect(screen.getByRole('tab', { name: 'Notebook' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tabpanel', { name: 'Notebook' }).id).toBe(
      screen.getByRole('tab', { name: 'Notebook' }).getAttribute('aria-controls')
    )
    fireEvent.keyDown(document.activeElement!, { key: 'End' })
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Results' }))
    fireEvent.keyDown(document.activeElement!, { key: 'Home' })
    expect(document.activeElement).toBe(conversation)
  })

  it('asks about an inspected older conversation record without changing the research clock', async () => {
    const cb = callbacks()
    render(
      <ReplayPanel document={makeDocument()} {...cb} host={null} presentationMode="research" />
    )
    seekProgress(2500)
    const article = screen.getByTestId('replay-stage').querySelector('[data-replay-step="one"]')!
    fireEvent.pointerDown(article)
    expect(article.getAttribute('data-replay-selected')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Ask about this record' }))
    expect(cb.onAskStep).toHaveBeenCalledWith(expect.objectContaining({ stepId: 'one' }))
    expect(screen.getByRole('slider').getAttribute('aria-valuenow')).toBe('2500')
    fireEvent.click(screen.getByRole('button', { name: 'Play replay' }))
    expect(article.getAttribute('data-replay-selected')).toBeNull()
  })

  it('references the inspected saved Notebook run through its associated step', async () => {
    const cb = callbacks()
    const document = makeDocument()
    document.branches[0].steps.push(step('later', 3000, 'Later interpretation'))
    document.branches[0].durationMs = 4000
    render(<ReplayPanel document={document} {...cb} host={null} presentationMode="research" />)
    seekProgress(3500)
    fireEvent.click(screen.getByRole('tab', { name: 'Notebook' }))
    const run = await waitFor(() => {
      const run = screen.getByTestId('replay-stage').querySelector('[data-replay-run-item="run1"]')
      expect(run).toBeTruthy()
      return run!
    })
    fireEvent.pointerDown(run)
    fireEvent.click(screen.getByRole('button', { name: 'Ask about this run' }))
    expect(cb.onAskStep).toHaveBeenCalledWith(expect.objectContaining({ stepId: 'three' }))
    expect(screen.getByRole('slider').getAttribute('aria-valuenow')).toBe('3500')
  })

  it('moves material questions into the footer and retains the action when clicking the active tab again', async () => {
    const askMoment = vi.fn()
    function Material({ active }: { active: boolean }): React.JSX.Element {
      const shared = useReplayMaterialAction(
        active ? { label: 'Ask about this moment', onAsk: askMoment } : undefined
      )
      return <p>{shared ? 'Shared question footer' : 'Independent question action'}</p>
    }
    const cb = callbacks()
    render(
      <ReplayPanel
        document={makeDocument()}
        {...cb}
        host={null}
        presentationMode="research"
        materialViews={[
          {
            id: 'project',
            label: 'Project replay',
            content: (active) => <Material active={active} />
          }
        ]}
      />
    )
    fireEvent.click(screen.getByRole('tab', { name: 'Project replay' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Project replay' }))
    fireEvent.click(screen.getByRole('button', { name: 'Play replay' }))
    fireEvent.click(screen.getByRole('button', { name: 'Ask about this moment' }))
    expect(askMoment).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Play replay' })).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: 'Original conversation' }))
    expect(screen.queryByRole('button', { name: 'Ask about this moment' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Ask about this record' })).toBeTruthy()
  })

  it('shows true footage coverage independently of progress and seeks exact gaps', () => {
    render(
      <ReplayPanel
        document={makeDocument()}
        {...callbacks()}
        host={null}
        presentationMode="research"
        recordedTimeOrigins={{ main: 1000 }}
        recordedCoverage={{
          main: [
            { startedAt: 1500, endedAt: 2000 },
            { startedAt: 2500, endedAt: 4000 }
          ]
        }}
      />
    )
    const coverage = screen.getByTestId('replay-recording-coverage')
    const footage = within(coverage).getByRole('button', { name: 'Footage: 0:00.5–0:01' })
    expect(footage.style.left).toBe(`${(500 / 3000) * 100}%`)
    fireEvent.click(within(coverage).getByRole('button', { name: 'No footage: 0:01–0:01.5' }))
    expect(screen.getByRole('slider').getAttribute('aria-valuenow')).toBe('1000')
    expect(footage.style.left).toBe(`${(500 / 3000) * 100}%`)
    fireEvent.click(within(coverage).getByRole('button', { name: 'Footage: 0:01.5–0:03' }))
    expect(screen.getByRole('slider').getAttribute('aria-valuenow')).toBe('1500')
  })

  it('displays a real subsecond encoder gap distinctly and seeks its exact start', () => {
    const document = makeDocument()
    document.branches[0].durationMs = 90000
    render(
      <ReplayPanel
        document={document}
        {...callbacks()}
        host={null}
        presentationMode="research"
        recordedTimeOrigins={{ main: 100000 }}
        recordedCoverage={{
          main: [
            { startedAt: 183000, endedAt: 185435 },
            { startedAt: 185551, endedAt: 187000 }
          ]
        }}
      />
    )
    const coverage = screen.getByTestId('replay-recording-coverage')
    const gapLabel = 'No footage: 1:25.435–1:25.551'
    fireEvent.click(within(coverage).getByRole('button', { name: gapLabel }))
    expect(screen.getByRole('slider').getAttribute('aria-valuenow')).toBe('85435')
    fireEvent.click(within(coverage).getByRole('button', { name: 'Recording gaps' }))
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: gapLabel })).toBeTruthy()
  })

  it('distinguishes the selected material timestamp from the research playhead and pauses on media failure', async () => {
    let pauseMedia: (() => void) | undefined
    function Material({ active }: { active: boolean }): React.JSX.Element {
      useReplayMaterialAction(
        active
          ? {
              label: 'Ask about this moment',
              recordedAt: 1700,
              title: 'Decoded frame',
              onAsk: vi.fn()
            }
          : undefined
      )
      return <p>Recorded frame</p>
    }
    render(
      <ReplayPanel
        document={makeDocument()}
        {...callbacks()}
        host={null}
        presentationMode="research"
        recordedTimeOrigins={{ main: 1000 }}
        materialViews={[
          {
            id: 'project',
            label: 'Project replay',
            content: (active, playback) => {
              pauseMedia = playback?.onPause
              return <Material active={active} />
            }
          }
        ]}
      />
    )
    seekProgress(2500)
    fireEvent.click(screen.getByRole('tab', { name: 'Project replay' }))
    expect(screen.getByText('Reference time: 0:00.7')).toBeTruthy()
    expect(screen.getByText('Playback position: 0:02.5')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Play replay' }))
    expect(screen.getByRole('button', { name: 'Pause replay' })).toBeTruthy()
    act(() => pauseMedia?.())
    expect(screen.getByRole('button', { name: 'Play replay' })).toBeTruthy()
    expect(screen.getByRole('slider').getAttribute('aria-valuenow')).toBe('2500')
    expect(screen.getByText('Reference time: 0:00.7')).toBeTruthy()
  })

  it('keeps browser fullscreen distinct from expanding the native preview', async () => {
    const expand = vi.fn()
    render(
      <ReplayPanel
        document={makeDocument()}
        {...callbacks()}
        host={null}
        presentationMode="research"
        onToggleExpanded={expand}
      />
    )
    const panel = screen.getByTestId('replay-panel')
    panel.requestFullscreen = vi.fn().mockResolvedValue(undefined)
    fireEvent.click(screen.getByRole('button', { name: 'Enter full screen' }))
    expect(panel.requestFullscreen).toHaveBeenCalledTimes(1)
    const frame = screen.getByTestId('replay-stage')
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: panel })
    fireEvent(document, new Event('fullscreenchange'))
    fireEvent.click(screen.getByTestId('replay-information-trigger'))
    expect(panel.contains(screen.getByRole('dialog'))).toBe(true)
    expect(screen.getByTestId('replay-stage')).toBe(frame)
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null })
    fireEvent(document, new Event('fullscreenchange'))
    expect(panel.contains(screen.getByRole('dialog'))).toBe(false)
    expect(expand).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Expand preview' }))
    expect(expand).toHaveBeenCalledTimes(1)
  })

  it('preserves the chosen question destination focus while Escape still returns to the menu trigger', async () => {
    render(
      <>
        <input aria-label="Discussion destination" />
        <ReplayPanel
          document={makeDocument()}
          {...callbacks()}
          host={null}
          presentationMode="research"
          onAskStep={() => screen.getByRole('textbox', { name: 'Discussion destination' }).focus()}
        />
      </>
    )
    const trigger = screen.getByRole('button', { name: 'Question options' })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('button', { name: 'Ask about this step' }))
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('textbox', { name: 'Discussion destination' })
      )
    )
    fireEvent.click(trigger)
    fireEvent.keyDown(screen.getByRole('button', { name: 'Ask about this step' }), {
      key: 'Escape'
    })
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  it('dismisses source details when another inspector takes over without reopening on return', async () => {
    const props = {
      document: makeDocument(),
      ...callbacks(),
      host: null,
      presentationMode: 'research' as const
    }
    const view = render(<ReplayPanel {...props} />)
    fireEvent.click(screen.getByTestId('replay-information-trigger'))
    expect(screen.getByRole('dialog')).toBeTruthy()
    view.rerender(<ReplayPanel {...props} active={false} />)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    view.rerender(<ReplayPanel {...props} active />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('keeps navigation mounted but disables every research question when the connection is inactive', () => {
    const cb = callbacks()
    const replayDocument = makeDocument()
    const view = render(
      <ReplayPanel document={replayDocument} {...cb} host={null} presentationMode="research" />
    )
    seekProgress(1500)
    view.rerender(
      <ReplayPanel
        document={replayDocument}
        {...cb}
        host={null}
        presentationMode="research"
        active={false}
      />
    )
    expect(screen.getByRole('button', { name: 'Ask about this record' })).toHaveProperty(
      'disabled',
      true
    )
    fireEvent.click(screen.getByRole('button', { name: 'Ask about this record' }))
    fireEvent.click(screen.getByRole('button', { name: 'Question options' }))
    expect(screen.getByRole('button', { name: 'Ask about this step' })).toHaveProperty(
      'disabled',
      true
    )
    expect(screen.getByRole('button', { name: 'Discuss the entire research' })).toHaveProperty(
      'disabled',
      true
    )
    expect(screen.getByRole('slider').getAttribute('aria-valuenow')).toBe('1500')
    expect(cb.onAskStep).not.toHaveBeenCalled()
  })

  it('preserves the canonical capture layout when research presentation is requested without fitContainer', () => {
    const document = makeDocument()
    render(
      <ReplayStage
        document={document}
        scene={projectReplayScene(document, 'main', 0)}
        presentationMode="research"
      />
    )
    expect(screen.getByTestId('replay-stage').getAttribute('data-replay-layout')).toBe('capture')
    expect(screen.queryByTestId('replay-current-context')).toBeNull()
  })
})

describe('optional research execution observations', () => {
  const setup = (): {
    document: ReplayDocument
    tracks: import('@/lib/replay/recorded-execution').RecordedExecutionTrack[]
    cb: ReturnType<typeof callbacks>
  } => {
    const document = makeDocument()
    const original = document.branches[0].steps[2]
    document.branches = [
      {
        ...document.branches[0],
        durationMs: 5000,
        steps: [
          {
            ...original,
            startMs: 0,
            endMs: 5000,
            durationMs: 5000,
            resourceIds: [],
            recordedAt: 1000,
            recordedEndAt: 6000,
            runs: original.runs.map((run) => ({ ...run, startedAt: 1000, endedAt: 6000 }))
          }
        ]
      }
    ]
    const receiving = { projectId: 'p', sessionId: 's', artifactId: 'archive', versionId: 'av' }
    const snapshots: import('../../../../../shared/run-observation').RunObservationSnapshot[] = [
      1200, 3000, 5500
    ].map((observedAt, index) => ({
      identity: { projectId: 'p', sessionId: 's', runId: 'projection' },
      cursor: { epoch: 'epoch', sequence: index },
      stepId: `sample-${index}`,
      observedAt,
      phase: 'running',
      run: {
        runId: 'projection',
        kernelKind: 'bash',
        status: 'running',
        startedAt: 1000,
        logs: {
          stdout: {
            text: ['recording ready', 'actions completed', 'window ended'][index],
            truncated: false,
            redacted: false
          },
          stderr: { text: '', truncated: false, redacted: false },
          traceback: { text: '', truncated: false, redacted: false }
        }
      },
      artifacts: [],
      artifactsTruncated: false
    }))
    const tracks: import('@/lib/replay/recorded-execution').RecordedExecutionTrack[] = [
      {
        id: 'track',
        branchId: 'main',
        stepId: 'three',
        runId: 'run1',
        origin: 1000,
        snapshots,
        coverage: {
          kind: 'sampled-observations',
          includesPreObservationHistory: false,
          firstObservedAt: 1200,
          lastObservedAt: 5500,
          droppedEarlierObservations: false,
          terminalRunObserved: false,
          stopReason: 'manual',
          logTruncation: false,
          redactedContent: false,
          missingMediaKeys: []
        },
        select: (snapshot) => ({
          kind: 'recorded-run-observation',
          receiving,
          recordingId: 'archive',
          stepKey: snapshot.stepId,
          record: {
            stepKey: snapshot.stepId,
            observedAt: snapshot.observedAt,
            phase: snapshot.phase,
            sourceEvidence: {
              identity: { projectId: 'sender', sessionId: 'sender', runId: 'source-run' },
              cursor: snapshot.cursor,
              stepId: 'source-step'
            },
            run: snapshot.run,
            artifactEvidence: [],
            artifactsTruncated: false
          },
          mediaKeys: []
        })
      }
    ]
    const cb = callbacks()
    cb.readNotebookRun.mockResolvedValue({
      status: 'ready',
      bytes: 10,
      run: {
        runId: 'run1',
        cellId: 'c1',
        source: 'agent',
        kernelKind: 'python',
        script: 'print(42)',
        status: 'completed',
        startedAt: 1000,
        endedAt: 6000,
        text: { stdout: 'final scientific output', stderr: '', traceback: '', plain: [] },
        outputs: [],
        workingFiles: []
      }
    })
    return { document, tracks, cb }
  }

  it('shows only the current snapshot, retracts later logs on rewind, and preserves the final-output gate', async () => {
    const { document, tracks, cb } = setup()
    render(
      <ReplayPanel
        document={document}
        {...cb}
        host={null}
        presentationMode="research"
        recordedTimeOrigins={{ main: 1000 }}
        executionTracks={tracks}
      />
    )
    fireEvent.click(screen.getByRole('tab', { name: 'Notebook' }))
    expect(
      screen.getAllByText('No execution status has been recorded at this point.').length
    ).toBeGreaterThan(0)
    seekProgress(400)
    await waitFor(() => expect(screen.getByText('recording ready')).toBeTruthy())
    expect(screen.queryByText('actions completed')).toBeNull()
    expect(screen.queryByText('final scientific output')).toBeNull()
    seekProgress(2200)
    expect(screen.getByText('actions completed')).toBeTruthy()
    expect(screen.queryByText('window ended')).toBeNull()
    seekProgress(400)
    expect(screen.getByText('recording ready')).toBeTruthy()
    expect(screen.queryByText('actions completed')).toBeNull()
    seekProgress(5000)
    await waitFor(() => expect(screen.getByText('final scientific output')).toBeTruthy())
    expect(screen.getByText('Saved execution observations')).toBeTruthy()
  })

  it('seeks the next saved state without adding a research step or another clock', () => {
    const { document, tracks, cb } = setup()
    render(
      <ReplayPanel
        document={document}
        {...cb}
        host={null}
        presentationMode="research"
        recordedTimeOrigins={{ main: 1000 }}
        executionTracks={tracks}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Next status record' }))
    expect(
      screen.getByRole('slider', { name: 'Replay progress' }).getAttribute('aria-valuenow')
    ).toBe('200')
    fireEvent.click(screen.getByRole('button', { name: 'Next status record' }))
    expect(
      screen.getByRole('slider', { name: 'Replay progress' }).getAttribute('aria-valuenow')
    ).toBe('2000')
    expect(screen.getByRole('button', { name: 'Next step' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getAllByRole('slider')).toHaveLength(1)
  })

  it('captures the exact sampled time separately from watching time and retains Ask about this run', async () => {
    const { document, tracks, cb } = setup()
    const onAskObservation = vi.fn()
    render(
      <ReplayPanel
        document={document}
        {...cb}
        host={null}
        presentationMode="research"
        recordedTimeOrigins={{ main: 1000 }}
        executionTracks={tracks}
        onAskObservation={onAskObservation}
      />
    )
    seekProgress(2400)
    fireEvent.click(screen.getByRole('tab', { name: 'Notebook' }))
    await waitFor(() => expect(screen.getByText('actions completed')).toBeTruthy())
    expect(screen.getByTestId('replay-reference-time').textContent).toContain(
      'Reference time: 0:02'
    )
    expect(screen.getByTestId('replay-reference-time').textContent).toContain(
      'Playback position: 0:02.4'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Ask about this status' }))
    await waitFor(() => expect(onAskObservation).toHaveBeenCalledOnce())
    expect(onAskObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        stepKey: 'sample-1',
        record: expect.objectContaining({ observedAt: 3000 })
      }),
      { branchId: 'main', stepId: 'three', runId: 'run1', timeMs: 2400 }
    )
    expect(cb.onAskStep).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Question options' }))
    fireEvent.click(screen.getByRole('button', { name: 'Ask about this run' }))
    expect(cb.onAskStep).toHaveBeenCalledOnce()
  })

  it('keeps failed reference preparation local and permits an explicit retry', async () => {
    const { document, tracks, cb } = setup()
    const onAskObservation = vi
      .fn()
      .mockRejectedValueOnce(new Error('source gone'))
      .mockResolvedValue(undefined)
    render(
      <ReplayPanel
        document={document}
        {...cb}
        host={null}
        presentationMode="research"
        recordedTimeOrigins={{ main: 1000 }}
        executionTracks={tracks}
        onAskObservation={onAskObservation}
      />
    )
    seekProgress(2400)
    fireEvent.click(screen.getByRole('tab', { name: 'Notebook' }))
    fireEvent.click(screen.getByRole('button', { name: 'Ask about this status' }))
    expect(await screen.findByText('Could not prepare this observation reference.')).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Original conversation' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(onAskObservation).toHaveBeenCalledTimes(2))
    expect(screen.queryByText('Could not prepare this observation reference.')).toBeNull()
  })

  it('explains absent intermediate records only for hosts that opt into execution tracks', async () => {
    const { document, cb } = setup()
    const view = render(
      <ReplayPanel
        document={document}
        {...cb}
        host={null}
        presentationMode="research"
        recordedTimeOrigins={{ main: 1000 }}
      />
    )
    fireEvent.click(screen.getByRole('tab', { name: 'Notebook' }))
    expect(
      screen.queryByText('No linked intermediate observations are available for this run.')
    ).toBeNull()
    view.rerender(
      <ReplayPanel
        document={document}
        {...cb}
        host={null}
        presentationMode="research"
        recordedTimeOrigins={{ main: 1000 }}
        executionTracks={[]}
      />
    )
    expect(
      screen.getByText('No linked intermediate observations are available for this run.')
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Ask about this run' })).toBeTruthy()
  })
  it('shows saved observations even when final Notebook details cannot be loaded', async () => {
    const { document, tracks, cb } = setup()
    const readNotebookRun = vi
      .fn()
      .mockResolvedValue({ status: 'unavailable', reason: 'load-failed' })
    render(
      <ReplayPanel
        document={document}
        {...cb}
        readNotebookRun={readNotebookRun}
        host={null}
        presentationMode="research"
        recordedTimeOrigins={{ main: 1000 }}
        executionTracks={tracks}
      />
    )
    seekProgress(400)
    fireEvent.click(screen.getByRole('tab', { name: 'Notebook' }))
    expect(screen.getByText('recording ready')).toBeTruthy()
    expect(await screen.findByText('Could not read the recorded material.')).toBeTruthy()
    expect(screen.queryByText('actions completed')).toBeNull()
  })

  it('does not attribute one run observation to an ambiguous current multi-run step', () => {
    const { document, tracks, cb } = setup()
    document.branches[0].steps[0].runs.push({
      ...document.branches[0].steps[0].runs[0],
      runId: 'second-run'
    })
    render(
      <ReplayPanel
        document={document}
        {...cb}
        host={null}
        presentationMode="research"
        recordedTimeOrigins={{ main: 1000 }}
        executionTracks={tracks}
        onAskObservation={vi.fn()}
      />
    )
    seekProgress(400)
    const context = screen.getByTestId('replay-current-context')
    expect(within(context).queryByTestId('replay-execution-state')).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: 'Notebook' }))
    expect(screen.getByText('recording ready')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Ask about this status' })).toBeNull()
    const run = screen.getByTestId('replay-stage').querySelector('[data-replay-run-item="run1"]')!
    fireEvent.pointerDown(run)
    expect(screen.getByRole('button', { name: 'Ask about this status' })).toBeTruthy()
  })

  it('keeps the clock running while switching tabs with observation logs present', async () => {
    let sequence = 0,
      timestamp = 0
    const frames = new Map<number, FrameRequestCallback>()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++sequence, callback)
      return sequence
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
    const tick = async (): Promise<void> => {
      await act(async () => {
        timestamp += 100
        const pending = [...frames.values()]
        frames.clear()
        pending.forEach((callback) => callback(timestamp))
      })
    }
    const { document, tracks, cb } = setup()
    render(
      <ReplayPanel
        document={document}
        {...cb}
        host={null}
        presentationMode="research"
        recordedTimeOrigins={{ main: 1000 }}
        executionTracks={tracks}
        materialViews={[
          { id: 'project', label: 'Project replay', content: <p>Project pixels</p> },
          { id: 'results', label: 'Results', content: <p>Saved files</p> }
        ]}
      />
    )
    seekProgress(400)
    for (let i = 0; i < 5; i++) await tick()
    fireEvent.click(screen.getByRole('button', { name: 'Play replay' }))
    await tick()
    for (const name of [
      'Notebook',
      'Project replay',
      'Results',
      'Original conversation',
      'Notebook'
    ]) {
      const before = Number(screen.getByRole('slider').getAttribute('aria-valuenow'))
      fireEvent.click(screen.getByRole('tab', { name }))
      expect(screen.getByRole('button', { name: 'Pause replay' })).toBeTruthy()
      await tick()
      await tick()
      expect(Number(screen.getByRole('slider').getAttribute('aria-valuenow'))).toBeGreaterThan(
        before
      )
    }
    // Stable panes no longer interrupt readiness when switching tabs: ten 100 ms
    // frames at 2× advance from 400 ms to 2400 ms, past the second saved observation.
    expect(screen.getByRole('slider').getAttribute('aria-valuenow')).toBe('2400')
    expect(screen.getByText('actions completed')).toBeTruthy()
    expect(screen.queryByText('recording ready')).toBeNull()
    expect(screen.queryByText('window ended')).toBeNull()
    expect(screen.queryByText('final scientific output')).toBeNull()
  })
})
