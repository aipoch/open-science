// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReplayDocument, ReplayStep } from '../../../../../shared/replay'
import { projectReplayScene } from '@/lib/replay'
import { ReplayPanel } from './ReplayPanel'
import { ReplayStage } from './ReplayStage'
import type { ReplayStepContext } from './replay-context'
import { requestReplaySeek } from './replay-context'
import type { ReplayPreparedResource } from './replay-resources'

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
    generatorVersion: 2,
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
  onContinueResearch: vi.fn(),
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
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {
        /* test viewport stays fixed */
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

describe('research replay interaction', () => {
  it('starts paused, captures an immutable step reference, seeks back without future output, and keeps source actions explicit', async () => {
    const document = makeDocument()
    const props = callbacks()
    render(<ReplayPanel document={document} {...props} />)
    expect(screen.getByLabelText('Play replay')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Replay progress'), { target: { value: '1500' } })
    fireEvent.click(screen.getByText('Ask about this step'))
    const captured = props.onAskStep.mock.calls[0][0] as ReplayStepContext
    expect(captured.stepId).toBe('two')
    expect(captured.excerpt).toBe('Interpret saved evidence'.slice(0, 20) + '\nInitial observation')
    fireEvent.click(screen.getByLabelText('Next step'))
    await waitFor(() => expect(screen.getByText('print(42)')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('Replay progress'), { target: { value: '0' } })
    expect(screen.queryByText('print(42)')).toBeNull()
    expect(captured.stepId).toBe('two')
    expect(props.onContinueResearch).not.toHaveBeenCalled()
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
    fireEvent.change(screen.getByLabelText('Replay branch'), { target: { value: 'other' } })
    expect(screen.getByLabelText('Play replay')).toBeTruthy()
    expect(screen.getByTestId('replay-stage').textContent).toContain('Ot')
    fireEvent.click(screen.getByLabelText('Play replay'))
    view.rerender(<ReplayPanel document={document} active={false} {...props} />)
    expect(screen.getByLabelText('Play replay')).toBeTruthy()
    act(() =>
      requestReplaySeek({ projectId: 'p', sourceSessionId: 's', branchId: 'main', stepId: 'two' })
    )
    expect((screen.getByLabelText('Replay branch') as HTMLSelectElement).value).toBe('main')
    expect((screen.getByLabelText('Replay progress') as HTMLInputElement).value).toBe('1000')
    await act(async () => {})
  })

  it('does not replace current branch material with a late request from a previously selected branch', async () => {
    const pending = new Map<string, (value: ReplayPreparedResource) => void>()
    const readResource = vi.fn(
      (resource) =>
        new Promise<ReplayPreparedResource>((resolve) => pending.set(resource.id, resolve))
    )
    render(<ReplayPanel document={makeDocument()} {...callbacks()} readResource={readResource} />)
    fireEvent.change(screen.getByLabelText('Replay progress'), { target: { value: '1500' } })
    await act(async () => {})
    fireEvent.change(screen.getByLabelText('Replay branch'), { target: { value: 'other' } })
    await act(async () => pending.get('v2')!({ ...prepared, content: 'current branch bytes' }))
    await waitFor(() => expect(screen.getByText('current branch bytes')).toBeTruthy())
    await act(async () => pending.get('v1')!({ ...prepared, content: 'stale branch bytes' }))
    expect(screen.queryByText('stale branch bytes')).toBeNull()
    expect(screen.getByText('current branch bytes')).toBeTruthy()
  })

  it('restores an exact saved checkpoint paused and returns explicit end actions', async () => {
    const document = makeDocument()
    const props = callbacks()
    render(
      <ReplayPanel
        document={document}
        initialView={{
          fingerprint: 'fp',
          generatorVersion: 2,
          branchId: 'main',
          stepId: 'three',
          timeMs: 3000,
          rate: 1.5
        }}
        {...props}
      />
    )
    expect(screen.getByLabelText('Play replay')).toBeTruthy()
    expect((screen.getByLabelText('Playback speed') as HTMLSelectElement).value).toBe('1.5')
    expect(screen.getByText('Replay complete')).toBeTruthy()
    fireEvent.click(screen.getByText('Create a copy to continue research'))
    expect(props.onContinueResearch).toHaveBeenCalledOnce()
    await act(async () => {})
  })
})

describe('standalone replay stage', () => {
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
    expect((screen.getByLabelText('Replay progress') as HTMLInputElement).value).toBe('1750')
    fireEvent.click(screen.getByText('Ask about this step'))
    expect(props.onAskStep.mock.calls[0][0].stepOffsetMs).toBe(750)
    expect(props.onAskStep.mock.calls[0][0].excerpt).toBe(
      'Interpret saved evidence\nInitial observation'
    )
    await act(async () => {})
  })

  it('resets state and cached material when another import shares the package fingerprint', async () => {
    const first = makeDocument()
    const props = callbacks()
    const view = render(<ReplayPanel document={first} {...props} />)
    fireEvent.change(screen.getByLabelText('Replay progress'), { target: { value: '1700' } })
    await waitFor(() => expect(screen.getByText('historical material')).toBeTruthy())
    const second = makeDocument()
    second.source.sessionId = 'second-import'
    second.branches[0].steps[0].message!.content = 'Different imported conversation'
    view.rerender(<ReplayPanel document={second} {...props} />)
    expect((screen.getByLabelText('Replay progress') as HTMLInputElement).value).toBe('0')
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
    fireEvent.change(screen.getByLabelText('Replay progress'), { target: { value: '2100' } })
    await waitFor(() => expect(screen.getByText('print(42)')).toBeTruthy())
    expect(screen.queryByText('Saved output')).toBeNull()
    expect(screen.queryByText('v2.txt')).toBeNull()
    fireEvent.click(screen.getByText('Ask about this step'))
    const context = props.onAskStep.mock.calls[0][0] as ReplayStepContext
    expect(context.evidence.some((item) => item.kind === 'artifact-version')).toBe(false)
    expect(context.evidence.find((item) => item.kind === 'notebook-run')?.part).toBe('input')
    fireEvent.change(screen.getByLabelText('Replay progress'), { target: { value: '2800' } })
    expect(screen.getByText('Saved output')).toBeTruthy()
    expect(screen.getByText('42')).toBeTruthy()
    expect(screen.getByText('v2.txt')).toBeTruthy()
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
    render(<ReplayPanel document={makeDocument()} {...callbacks()} readResource={() => pending} />)
    fireEvent.change(screen.getByLabelText('Replay progress'), { target: { value: '1500' } })
    fireEvent.click(screen.getByLabelText('Play replay'))
    await tick(1000)
    await tick(5000)
    expect((screen.getByLabelText('Replay progress') as HTMLInputElement).value).toBe('1500')
    await act(async () => resolveMaterial(prepared))
    await tick(5100)
    await tick(5200)
    await tick(5300)
    await tick(5400)
    await tick(5500)
    expect(
      Number((screen.getByLabelText('Replay progress') as HTMLInputElement).value)
    ).toBeGreaterThan(1500)
    expect(
      Number((screen.getByLabelText('Replay progress') as HTMLInputElement).value)
    ).toBeLessThan(2000)
    const position = Number((screen.getByLabelText('Replay progress') as HTMLInputElement).value)
    // Capture readiness is pending as logical time advances; it must not throttle the player.
    for (const time of [5516, 5532, 5548]) await tick(time)
    expect(Number((screen.getByLabelText('Replay progress') as HTMLInputElement).value)).toBe(
      position + 48
    )
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
    fireEvent.click(screen.getByText('Imported research history'))
    expect(screen.getByText('original-project')).toBeTruthy()
    expect(screen.getByText('original-session')).toBeTruthy()
    fireEvent.click(screen.getByText('Not included in this package'))
    expect(screen.getByText('large-dataset.csv')).toBeTruthy()
    await act(async () => {})
  })

  it('offers all reached branch file results at the end, not only files owned by the last message', async () => {
    const document = makeDocument()
    const props = callbacks()
    render(<ReplayPanel document={document} {...props} />)
    fireEvent.change(screen.getByLabelText('Replay progress'), { target: { value: '3000' } })
    fireEvent.click(screen.getByRole('button', { name: 'View results' }))
    const results = screen.getByRole('region', { name: 'View results' })
    expect(results.textContent).toContain('v1.txt')
    expect(results.textContent).toContain('v2.txt')
    fireEvent.click(screen.getByRole('button', { name: 'v1.txt' }))
    expect(props.onOpenEvidence.mock.calls[0][0].versionId).toBe('v1')
    await act(async () => {})
  })
})

it('opens complete material at the start and restores keyboard focus after evidence inspection', async () => {
  const props = callbacks()
  render(<ReplayPanel document={makeDocument()} {...props} />)
  const materialButton = screen.getByRole('button', { name: 'View research materials' })
  materialButton.focus()
  fireEvent.click(materialButton)
  expect(screen.getByRole('button', { name: 'Close evidence' })).toBe(document.activeElement)
  expect(screen.getByRole('button', { name: 'v2.txt' })).toBeTruthy()
  expect((screen.getByLabelText('Replay progress') as HTMLInputElement).value).toBe('0')
  fireEvent.keyDown(screen.getByRole('region', { name: 'View research materials' }), {
    key: 'Escape'
  })
  expect(document.activeElement).toBe(materialButton)
  expect(screen.queryByRole('region', { name: 'View research materials' })).toBeNull()
  await act(async () => {})
})

it('pauses on expand and keyboard inspection without losing the playhead', async () => {
  const onToggleExpanded = vi.fn()
  render(
    <ReplayPanel document={makeDocument()} {...callbacks()} onToggleExpanded={onToggleExpanded} />
  )
  fireEvent.change(screen.getByLabelText('Replay progress'), { target: { value: '1500' } })
  fireEvent.click(screen.getByLabelText('Play replay'))
  fireEvent.click(screen.getByLabelText('Enter full screen'))
  expect(onToggleExpanded).toHaveBeenCalledOnce()
  expect(screen.getByLabelText('Play replay')).toBeTruthy()
  fireEvent.click(screen.getByLabelText('Play replay'))
  fireEvent.keyDown(screen.getByLabelText('Historical code and results'), { key: 'PageDown' })
  expect(screen.getByLabelText('Play replay')).toBeTruthy()
  expect((screen.getByLabelText('Replay progress') as HTMLInputElement).value).toBe('1500')
  await act(async () => {})
})
