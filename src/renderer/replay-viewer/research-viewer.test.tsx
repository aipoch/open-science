// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ResearchReplayViewerApp } from './ResearchReplayViewerApp'
import { recordedFixture } from '../../main/run-observation/recorded-viewer.test-support'
import { captureRecordedObservationSelection } from '../../shared/recorded-observation-selection'
import { researchPosition } from './research-materials'
import { ResearchReplayClient } from './research-client'
import type { ResearchReplayViewerContext } from './client'
import { ReplayViewerClient } from './client'
import { useViewerObservation } from './use-viewer-observation'
import { renderHook } from '@testing-library/react'
import {
  researchFixture,
  researchRecordingFixture,
  researchSelectionFixture
} from './research-replay.test-support'
import { createResearchReplayTimeline } from '../src/lib/replay/recorded-time'
import { useSessionReplayStore } from '../src/stores/session-replay-store'

const context: ResearchReplayViewerContext = {
  mode: 'research',
  viewerId: 'research-viewer',
  target: { projectId: 'local-project', sessionId: 'local-session' },
  expiresAt: 123456,
  canInteract: false,
  canCancel: false,
  canReadArtifacts: true,
  presentation: 'browser'
}
const json = (value: unknown): Response =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
beforeEach(() => {
  vi.stubGlobal('PointerEvent', MouseEvent)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {
        /* No layout observer in jsdom. */
      }
      unobserve(): void {
        /* No layout observer in jsdom. */
      }
      disconnect(): void {
        /* No layout observer in jsdom. */
      }
    }
  )
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  }))
  HTMLElement.prototype.scrollIntoView = vi.fn()
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined)
  sessionStorage.clear()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function makeClient(
  research = researchFixture(),
  recording = researchRecordingFixture()
): {
  client: ResearchReplayClient
  fetcher: ReturnType<typeof vi.fn<typeof fetch>>
} {
  const fetcher = vi.fn<typeof fetch>(async (path, options) => {
    if (path === '/api/research/document') return json(research)
    if (path === '/api/context') return json(context)
    if (path === '/api/research/selection') return json(null)
    if (path === '/api/research/read') return json(recording)
    if (path === '/api/research/select')
      return json(researchSelectionFixture(research.document, JSON.parse(String(options?.body))))
    throw new Error(`Unexpected endpoint ${path}`)
  })
  return { client: new ResearchReplayClient(fetcher), fetcher }
}
const seek = (time: number): void => {
  const slider = screen.getByRole('slider', { name: 'Replay progress' })
  const track = screen.getByTestId('replay-progress-track')
  vi.spyOn(track, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1000, 32))
  track.setPointerCapture = vi.fn()
  track.hasPointerCapture = () => true
  track.releasePointerCapture = vi.fn()
  const clientX = (time / Number(slider.getAttribute('aria-valuemax'))) * 1000
  fireEvent.pointerDown(track, { clientX, button: 0 })
  fireEvent.pointerUp(track, { clientX, button: 0 })
}

describe('complete browser research Replay', () => {
  it('refreshes the selected failed result after reconnect without changing its selection', async () => {
    const research = researchFixture()
    research.document.resources.push({
      id: 'report',
      name: 'report.txt',
      projectId: 'local-project',
      sessionId: 'local-session',
      versionId: 'report-v1',
      artifactId: 'report',
      availability: 'recorded',
      createdAt: 3000
    })
    const { client, fetcher } = makeClient(research)
    const base = fetcher.getMockImplementation()!
    let reads = 0
    fetcher.mockImplementation(async (...args) => {
      if (String(args[0]).startsWith('/api/research/resource?')) {
        if (++reads === 1) throw new Error('offline')
        return new Response('Saved result after reconnect', {
          headers: { 'content-type': 'text/plain' }
        })
      }
      return base(...args)
    })
    render(<ResearchReplayViewerApp context={context} client={client} />)
    await screen.findByTestId('research-replay-viewer')
    seek(4500)
    fireEvent.click(screen.getByRole('tab', { name: 'Results' }))
    fireEvent.click(await screen.findByRole('button', { name: 'report.txt' }))
    await screen.findByText('Replay connection interrupted')
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    await screen.findByText('Saved result after reconnect')
    expect(screen.getByRole('button', { name: 'report.txt' }).getAttribute('aria-pressed')).toBe(
      'true'
    )
    expect(
      screen.getByRole('slider', { name: 'Replay progress' }).getAttribute('aria-valuenow')
    ).toBe('4500')
    expect(reads).toBe(2)
  })

  it('does not clear revoked authorization when an older media connection check succeeds', async () => {
    const { client, fetcher } = makeClient()
    render(<ResearchReplayViewerApp context={context} client={client} />)
    await screen.findByTestId('research-replay-viewer')
    fireEvent.click(screen.getByRole('tab', { name: 'Project replay' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Jump to recorded footage' }))
    let resolveContext!: (value: Response) => void
    fetcher.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveContext = resolve
        })
    )
    fireEvent.error(await screen.findByLabelText('Recorded webpage'))
    await waitFor(() => expect(resolveContext).toBeDefined())
    fetcher.mockResolvedValueOnce(new Response('', { status: 403 }))
    await act(async () => {
      await client.context().catch(() => undefined)
    })
    await screen.findByText('This observation link is no longer authorized.')
    await act(async () => resolveContext(json(context)))
    expect(screen.getByText('This observation link is no longer authorized.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull()
  })
  it('pauses on a lost media connection and retries in place without recreating the research', async () => {
    const { client, fetcher } = makeClient()
    render(<ResearchReplayViewerApp context={context} client={client} />)
    await screen.findByTestId('research-replay-viewer')
    fireEvent.click(screen.getByRole('tab', { name: 'Project replay' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Jump to recorded footage' }))
    const before = screen
      .getByRole('slider', { name: 'Replay progress' })
      .getAttribute('aria-valuenow')
    const video = await screen.findByLabelText('Recorded webpage')
    fetcher.mockRejectedValueOnce(new Error('offline'))
    fireEvent.error(video)
    await screen.findByText('Replay connection interrupted')
    expect(
      screen.getByRole('button', { name: 'Ask about this content' }).hasAttribute('disabled')
    ).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    await waitFor(() => expect(screen.queryByText('Replay connection interrupted')).toBeNull())
    expect(
      screen.getByRole('slider', { name: 'Replay progress' }).getAttribute('aria-valuenow')
    ).toBe(before)
    expect(screen.getByRole('tab', { name: 'Project replay' }).getAttribute('aria-selected')).toBe(
      'true'
    )
    expect(fetcher.mock.calls.filter(([path]) => path === '/api/research/document')).toHaveLength(1)
    expect(
      fetcher.mock.calls
        .map(([path]) => String(path))
        .every((path) => path.startsWith('/api/research/') || path === '/api/context')
    ).toBe(true)
  })

  it('retains loaded records but never renews an expired grant from the browser', async () => {
    const { client, fetcher } = makeClient()
    render(<ResearchReplayViewerApp context={context} client={client} />)
    await screen.findByTestId('research-replay-viewer')
    seek(4500)
    fetcher.mockResolvedValueOnce(new Response('', { status: 401 }))
    await act(async () => {
      await client.context().catch(() => undefined)
    })
    await screen.findByText('This observation link is no longer authorized.')
    expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull()
    expect(
      screen.getByRole('slider', { name: 'Replay progress' }).getAttribute('aria-valuenow')
    ).toBe('4500')
    expect(
      screen.getByRole('button', { name: 'Ask about this record' }).hasAttribute('disabled')
    ).toBe(true)
  })
  it('routes research without polling live observations or recording controls', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json(context))
    const client = new ReplayViewerClient(fetcher)
    const { result } = renderHook(() => useViewerObservation(client, 0))
    await waitFor(() => expect(result.current.connection).toBe('connected'))
    expect(result.current.context).toEqual(context)
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual(['/api/context'])
  })
  it('shows conversation context, independent materials and one clock without a desktop API', async () => {
    const { client, fetcher } = makeClient()
    const oldPlayhead = useSessionReplayStore.getState().playhead
    render(<ResearchReplayViewerApp context={context} client={client} />)
    await screen.findByTestId('research-replay-viewer')
    expect(
      screen.getByRole('slider', { name: 'Replay progress' }).getAttribute('aria-valuemax')
    ).toBe('10000')
    expect(screen.getAllByText('Compare fruit collection decisions.').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('tab', { name: 'Project replay' }))
    await screen.findByText('The project recording has not started yet.')
    expect(screen.getAllByRole('slider')).toHaveLength(1)
    expect(screen.queryByLabelText('Recorded webpage')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Jump to recorded footage' }))
    await screen.findByLabelText('Recorded webpage')
    expect(
      screen.getByRole('slider', { name: 'Replay progress' }).getAttribute('aria-valuenow')
    ).toBe('2000')
    fireEvent.click(screen.getByRole('tab', { name: 'Results' }))
    expect(
      screen.getByRole('slider', { name: 'Replay progress' }).getAttribute('aria-valuenow')
    ).toBe('2000')
    expect(
      screen.getByRole('slider', { name: 'Replay progress' }).getAttribute('aria-valuemax')
    ).toBe('10000')
    expect(useSessionReplayStore.getState().playhead).toBe(oldPlayhead)
    expect(
      fetcher.mock.calls
        .map(([path]) => String(path))
        .every((path) => path.startsWith('/api/research/'))
    ).toBe(true)
  })
  it('preserves source-owned branch attribution and trailing duration after technical publication steps were removed', async () => {
    const research = researchFixture()
    const recording = researchRecordingFixture()
    recording.recording.startedAt = 20000
    const main = research.document.branches[0]
    const resource = {
      id: 'published-index',
      source: 'artifact' as const,
      name: 'index.json',
      ...recording.receiving,
      availability: 'recorded' as const
    }
    research.document.resources.push(resource)
    main.steps.push({
      id: 'technical-publication',
      branchId: main.id,
      kind: 'artifact',
      recordedAt: 27000,
      startMs: 0,
      endMs: 0,
      durationMs: 0,
      evidence: [],
      activities: [],
      runs: [],
      resourceIds: [resource.id],
      issues: []
    })
    research.document.branches.push({
      ...structuredClone(main),
      id: 'other',
      steps: main.steps
        .filter((step) => step.id !== 'technical-publication')
        .map((step) => ({ ...step, id: `other-${step.id}`, branchId: 'other' }))
    })
    // The service associates this exact index publication with main before suppressing it.
    const original = createResearchReplayTimeline(research.document, [recording], [resource.id])
    research.document = original.document
    research.supportingResourceIds = [...original.supportingResourceIds]
    research.timing = {
      recordedTimeOrigins: original.recordedTimeOrigins,
      coverage: original.coverage,
      timelineCoverage: original.timelineCoverage,
      unalignedBranchIds: original.unalignedBranchIds
    }
    expect(
      research.document.branches[0].steps.some((step) => step.id === 'technical-publication')
    ).toBe(false)
    expect(research.document.branches[0].durationMs).toBe(26000)
    expect(research.timing.coverage.main).toHaveLength(1)
    // Reprojection cannot recover the suppressed evidence and is deliberately non-idempotent.
    const repeated = createResearchReplayTimeline(
      research.document,
      [recording],
      research.supportingResourceIds
    )
    expect(repeated.coverage.main).toEqual([])
    expect(repeated.document.branches[0].durationMs).toBe(10000)
    const { client } = makeClient(research, recording)
    render(<ResearchReplayViewerApp context={context} client={client} />)
    await screen.findByTestId('research-replay-viewer')
    expect(
      screen.getByRole('slider', { name: 'Replay progress' }).getAttribute('aria-valuemax')
    ).toBe('26000')
    fireEvent.click(screen.getByRole('tab', { name: 'Project replay' }))
    await screen.findByText('The project recording has not started yet.')
    fireEvent.click(screen.getByRole('button', { name: 'Jump to recorded footage' }))
    await screen.findByLabelText('Recorded webpage')
    expect(
      screen.getByRole('slider', { name: 'Replay progress' }).getAttribute('aria-valuenow')
    ).toBe('19000')
    expect(
      screen.getByRole('slider', { name: 'Replay progress' }).getAttribute('aria-valuemax')
    ).toBe('26000')
    fireEvent.click(screen.getByRole('tab', { name: 'Results' }))
    expect(
      screen.getByRole('slider', { name: 'Replay progress' }).getAttribute('aria-valuemax')
    ).toBe('26000')
  })
  it('freezes a selected step while later navigation continues and restores only this viewer', async () => {
    const { client } = makeClient()
    const view = render(<ResearchReplayViewerApp context={context} client={client} />)
    await screen.findByTestId('research-replay-viewer')
    seek(4500)
    fireEvent.click(screen.getByRole('button', { name: 'Ask about this record' }))
    fireEvent.click(await screen.findByText('Saved reference details'))
    const reference = (await screen.findByRole('textbox', {
      name: 'Recorded step reference'
    })) as HTMLTextAreaElement
    const saved = JSON.parse(reference.value)
    expect(saved.position).toMatchObject({
      branchId: 'main',
      stepId: 'activity',
      timeMs: 4500,
      recordedAt: 5500
    })
    seek(7000)
    expect(JSON.parse(reference.value)).toEqual(saved)
    view.unmount()
    render(<ResearchReplayViewerApp context={context} client={client} />)
    await screen.findByTestId('research-replay-viewer')
    expect(
      screen.getByRole('slider', { name: 'Replay progress' }).getAttribute('aria-valuenow')
    ).toBe('7000')
    cleanup()
    render(
      <ResearchReplayViewerApp context={{ ...context, viewerId: 'other-viewer' }} client={client} />
    )
    await screen.findByTestId('research-replay-viewer')
    expect(
      screen.getByRole('slider', { name: 'Replay progress' }).getAttribute('aria-valuenow')
    ).toBe('0')
  })
  it('maps decoded footage moments using the captured branch, never a stale checkpoint', () => {
    const { document, recordedTimeOrigins } = createResearchReplayTimeline(
      researchFixture().document,
      [researchRecordingFixture()]
    )
    const playback = {
      branchId: 'main',
      positionMs: 2300,
      recordedAt: 3300,
      continuous: true,
      playing: true,
      speed: 2,
      onSeekRecordedAt: vi.fn()
    }
    expect(researchPosition(document, recordedTimeOrigins, playback, 4250)).toEqual({
      branchId: 'main',
      stepId: 'activity',
      timeMs: 3250,
      recordedAt: 4250
    })
    expect(researchPosition(document, recordedTimeOrigins, undefined, 4250)).toBeUndefined()
  })
  it('keeps source history visible when a saved recording is missing', async () => {
    const { client } = makeClient()
    vi.spyOn(client, 'researchRecording').mockRejectedValue(new Error('Missing segment index'))
    render(<ResearchReplayViewerApp context={context} client={client} />)
    await screen.findByText(
      'Some saved recordings are unavailable. Other research records remain available.'
    )
    expect(
      screen.getByRole('slider', { name: 'Replay progress' }).getAttribute('aria-valuemax')
    ).toBe('10000')
    expect(screen.getAllByText('Compare fruit collection decisions.').length).toBeGreaterThan(0)
  })
})

it('sends the inspected Notebook run and actual master clock after an overlapping message', async () => {
  const research = researchFixture()
  const runStep = research.document.branches[0].steps[1]
  runStep.kind = 'notebook'
  runStep.message = undefined
  runStep.recordedEndAt = 7000
  runStep.endMs = 6000
  runStep.durationMs = 4500
  const run = {
    runId: 'saved-run',
    cellId: 'cell',
    source: 'agent' as const,
    kernelKind: 'python' as const,
    status: 'completed' as const,
    startedAt: 2500,
    endedAt: 7000
  }
  runStep.runs = [run]
  runStep.evidence = [
    {
      kind: 'notebook-run',
      id: run.runId,
      projectId: context.target.projectId,
      sessionId: context.target.sessionId
    }
  ]
  const later = research.document.branches[0].steps[2]
  later.recordedAt = 5000
  later.startMs = 4000
  const { client, fetcher } = makeClient(research)
  vi.spyOn(client, 'notebook').mockResolvedValue({
    status: 'ready',
    bytes: 100,
    run: {
      ...run,
      script: 'print(7)',
      outputs: [],
      text: { stdout: 'SAVED SEVEN', stderr: '', traceback: '', plain: [] },
      workingFiles: []
    }
  })
  render(<ResearchReplayViewerApp context={context} client={client} />)
  await screen.findByTestId('research-replay-viewer')
  fireEvent.click(screen.getByRole('tab', { name: 'Notebook' }))
  seek(8000)
  const cell = await waitFor(() => {
    const item = document.querySelector('[data-replay-run-item="saved-run"]')
    expect(item).toBeTruthy()
    expect(item?.textContent).toContain('SAVED SEVEN')
    return item!
  })
  fireEvent.pointerDown(cell)
  fireEvent.click(screen.getByRole('button', { name: 'Ask about this run' }))
  await waitFor(() =>
    expect(fetcher.mock.calls.some(([path]) => path === '/api/research/select')).toBe(true)
  )
  const request = fetcher.mock.calls.find(([path]) => path === '/api/research/select')!
  expect(JSON.parse(String(request[1]?.body))).toMatchObject({
    stepId: runStep.id,
    notebookRunId: run.runId,
    timeMs: 8000,
    recordedAt: 9000
  })
  expect(screen.getByRole('slider').getAttribute('aria-valuenow')).toBe('8000')
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Ask about this run' })).not.toHaveProperty(
      'disabled',
      true
    )
  )
  fireEvent.click(screen.getByRole('tab', { name: 'Original conversation' }))
  fireEvent.pointerDown(document.querySelector('[data-replay-step="request"]')!)
  fireEvent.click(screen.getByRole('button', { name: 'Ask about this record' }))
  await waitFor(() =>
    expect(fetcher.mock.calls.filter(([path]) => path === '/api/research/select')).toHaveLength(2)
  )
  const inspectedRecord = fetcher.mock.calls.filter(([path]) => path === '/api/research/select')[1]
  expect(JSON.parse(String(inspectedRecord[1]?.body))).toMatchObject({
    stepId: 'request',
    inspectStep: 'visible',
    timeMs: 8000,
    recordedAt: 9000
  })
})

it('shows imported intermediate states on the master clock and references the exact earlier sample', async () => {
  const research = researchFixture()
  const payload = {
    ...recordedFixture().payload,
    receiving: { ...context.target, artifactId: 'states', versionId: 'states-v1' }
  }
  const sample = payload.archive.records[0]
  payload.archive.records = [3000, 7000].map((observedAt, index) => ({
    ...structuredClone(sample),
    stepKey: `observation-${index}`,
    sourceEvidence: {
      ...sample.sourceEvidence,
      cursor: { ...sample.sourceEvidence.cursor, sequence: index }
    },
    observedAt,
    phase: 'running',
    run: {
      ...sample.run!,
      status: 'running',
      startedAt: 2500,
      endedAt: undefined,
      logs: {
        ...sample.run!.logs,
        stdout: {
          text: index ? 'LATER SAVED STATE' : 'EARLY SAVED STATE',
          truncated: false,
          redacted: false
        }
      }
    }
  }))
  Object.assign(payload.archive.coverage, {
    firstObservedAt: 3000,
    lastObservedAt: 7000,
    terminalRunObserved: false,
    stopReason: 'manual'
  })
  payload.archive.capturedAt = 7500
  const run = {
    runId: 'mapped-run',
    cellId: 'cell',
    source: 'agent' as const,
    kernelKind: 'bash' as const,
    status: 'completed' as const,
    startedAt: 2500,
    endedAt: 10000
  }
  const owner = research.document.branches[0].steps[1]
  Object.assign(owner, {
    kind: 'notebook',
    message: undefined,
    runs: [run],
    recordedEndAt: 10000,
    endMs: 9000,
    durationMs: 7500
  })
  const descriptor = {
    id: 'states-v1',
    kind: 'run-observation' as const,
    target: payload.receiving,
    name: 'Saved states'
  }
  research.recordings.push(descriptor)
  research.document.resources.push({
    id: descriptor.id,
    ...payload.receiving,
    name: 'States.json',
    availability: 'recorded',
    checksum: 'a'.repeat(64)
  })
  research.observationBindings = [
    {
      target: payload.receiving,
      recordingId: payload.archive.recordingId,
      archiveChecksum: 'a'.repeat(64),
      runId: run.runId,
      branchIds: ['main'],
      basis: 'import-receipt'
    }
  ]
  const { client, fetcher } = makeClient(research)
  const base = fetcher.getMockImplementation()!
  fetcher.mockImplementation(async (...args) => {
    const [path, options] = args
    const body = options?.body ? JSON.parse(String(options.body)) : undefined
    if (path === '/api/research/read' && body?.recordingId === descriptor.id) return json(payload)
    if (path === '/api/research/select' && body?.observation) {
      const selected = researchSelectionFixture(research.document, body)
      return json({
        ...selected,
        inspection: 'recorded-observation',
        observation: captureRecordedObservationSelection(payload, body.observation.stepKey, {
          selectionId: selected.selectionId,
          selectedAt: selected.selectedAt
        })
      })
    }
    return base(...args)
  })
  vi.spyOn(client, 'notebook').mockResolvedValue({
    status: 'ready',
    bytes: 100,
    run: {
      ...run,
      script: 'record()',
      outputs: [],
      text: { stdout: 'FUTURE FINAL OUTPUT', stderr: '', traceback: '', plain: [] },
      workingFiles: []
    }
  })
  render(<ResearchReplayViewerApp context={context} client={client} />)
  await screen.findByTestId('research-replay-viewer')
  fireEvent.click(screen.getByRole('tab', { name: 'Notebook' }))
  seek(4000)
  await screen.findByText('EARLY SAVED STATE')
  expect(screen.queryByText('LATER SAVED STATE')).toBeNull()
  expect(screen.queryByText('FUTURE FINAL OUTPUT')).toBeNull()
  seek(7500)
  await screen.findByText('LATER SAVED STATE')
  expect(screen.queryByText('EARLY SAVED STATE')).toBeNull()
  seek(4000)
  await screen.findByText('EARLY SAVED STATE')
  fireEvent.click(screen.getByRole('button', { name: 'Ask about this status' }))
  await screen.findByText('Recorded state reference')
  const request = fetcher.mock.calls.find(([path]) => path === '/api/research/select')!
  expect(JSON.parse(String(request[1]?.body))).toMatchObject({
    stepId: owner.id,
    timeMs: 4000,
    recordedAt: 5000,
    observation: { recordingId: 'states-v1', stepKey: 'observation-0' }
  })
  expect(
    screen.getByRole('slider', { name: 'Replay progress' }).getAttribute('aria-valuenow')
  ).toBe('4000')
  expect(fetcher.mock.calls.every(([path]) => !String(path).includes('/execute'))).toBe(true)
})

it('follows the verified browser recording at the master time and resumes after an explicit source choice', async () => {
  const research = researchFixture(),
    first = researchRecordingFixture(),
    second = researchRecordingFixture()
  second.receiving = { ...second.receiving, artifactId: 'second', versionId: 'second-v1' }
  second.recording.recordingId = 'second'
  second.recording.startedAt = 12000
  research.recordings.push({
    id: 'second-v1',
    kind: 'web-recording',
    name: 'Second trial',
    target: second.receiving
  })
  const projected = createResearchReplayTimeline(research.document, [first, second])
  research.document = projected.document
  research.timing = {
    recordedTimeOrigins: projected.recordedTimeOrigins,
    coverage: projected.coverage,
    timelineCoverage: projected.timelineCoverage,
    unalignedBranchIds: projected.unalignedBranchIds
  }
  const { client } = makeClient(research)
  vi.spyOn(client, 'researchRecording').mockImplementation(async (descriptor) =>
    descriptor.id === 'second-v1' ? second : first
  )
  render(<ResearchReplayViewerApp context={context} client={client} />)
  await screen.findByTestId('research-replay-viewer')
  fireEvent.click(screen.getByRole('tab', { name: 'Project replay' }))
  seek(13000)
  const chooser = (await screen.findByRole('combobox', {
    name: 'Project recording'
  })) as HTMLSelectElement
  await waitFor(() => expect(chooser.value).toBe('second-v1'))
  expect(
    screen.getByRole('slider', { name: 'Replay progress' }).getAttribute('aria-valuenow')
  ).toBe('13000')
  fireEvent.change(chooser, { target: { value: 'index-version' } })
  await screen.findByRole('button', { name: 'Follow replay' })
  seek(14000)
  expect(chooser.value).toBe('index-version')
  fireEvent.click(screen.getByRole('button', { name: 'Play replay' }))
  await screen.findByRole('button', { name: 'Pause replay' })
  fireEvent.click(screen.getByRole('button', { name: 'Follow replay' }))
  await waitFor(() => expect(chooser.value).toBe('second-v1'))
  expect(screen.getByRole('button', { name: 'Pause replay' })).toBeTruthy()
  expect(
    screen.getByRole('slider', { name: 'Replay progress' }).getAttribute('aria-valuenow')
  ).toBe('14000')
  seek(4000)
  await waitFor(() => expect(chooser.value).toBe('index-version'))
})
