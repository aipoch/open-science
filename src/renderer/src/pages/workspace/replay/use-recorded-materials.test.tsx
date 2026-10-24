// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useNavigationStore } from '@/stores/navigation-store'
import { useRunObservationQuestionStore } from '@/stores/run-observation-question-store'
import type { ReplayDocument, ReplayResource } from '../../../../../shared/replay'
import type { ResearchDemoHistory, ResearchDemoSource } from '../../../../../shared/research-demo'
import {
  recordedFileSelectionForPayload,
  type RecordedObservationPayload,
  type RecordedProjectPayload
} from '../../../../../shared/run-observation-recorded'
import type { ProjectRecording } from '../../../../../shared/project-recording'
import type { RecordingCandidate } from './recording-discovery'
import { useRecordingDiscovery, type RecordingDiscovery } from './use-recording-discovery'
import { useRecordedMaterials } from './use-recorded-materials'
import { browserPayloadFixture } from './BrowserRecording.test-support'
import { recordedMediaResource } from '@/lib/replay/recorded-results'
import { ReplayMaterialActionProvider, type ReplayMaterialAction } from './replay-material-action'

const recovery = vi.hoisted(() => ({ onClick: vi.fn() }))
vi.mock('./use-observation-question-recovery', () => ({
  useObservationQuestionRecovery: () => ({ label: 'Discuss', onClick: recovery.onClick })
}))

const receiving = {
  projectId: 'receiver-project',
  sessionId: 'receiver-session',
  artifactId: 'index-artifact',
  versionId: 'index-version'
}
const source: ResearchDemoSource = {
  projectId: receiving.projectId,
  sourceSessionId: receiving.sessionId,
  sourceImportId: 'receiving-import'
}
const documentFixture = (sessionId = receiving.sessionId): ReplayDocument => ({
  generatorVersion: 3,
  presentationVersion: 2,
  source: {
    projectId: receiving.projectId,
    sessionId,
    title: 'Imported research',
    fingerprint: sessionId
  },
  defaultBranchId: 'main',
  branches: [],
  resources: [],
  issues: []
})
const recordingFixture = (): ProjectRecording => ({
  format: 'open-science-project-recording',
  version: 1,
  recordingId: 'project-only',
  startedAt: 10,
  endedAt: 80,
  media: [
    {
      mediaKey: 'frame-image',
      name: 'frame.png',
      mimeType: 'image/png',
      checksum: 'a'.repeat(64),
      sizeBytes: 20,
      sourceVersionId: 'author-image-version'
    }
  ],
  frames: [
    {
      frameId: 'frame-0',
      sequence: 0,
      recordedAt: 20,
      mediaKey: 'frame-image',
      provenance: {
        kind: 'capture',
        source: 'project-export',
        startedAt: 10,
        finishedAt: 20,
        width: 1,
        height: 1
      }
    }
  ],
  states: [],
  events: [],
  coverage: {
    kind: 'sampled-project-recording',
    stopReason: 'finished',
    failures: 0,
    unchangedSamples: 0,
    droppedSamples: 0,
    missingMediaKeys: []
  }
})
const projectPayload = (): RecordedProjectPayload => ({
  receiving,
  recording: recordingFixture(),
  media: [
    {
      mediaKey: 'frame-image',
      artifactId: 'receiver-image-artifact',
      versionId: 'receiver-image-version',
      checksum: 'a'.repeat(64),
      sizeBytes: 20
    }
  ]
})
const legacyPayload = (): RecordedObservationPayload => ({
  receiving,
  archive: {
    format: 'open-science-run-observation',
    version: 1,
    recordingId: 'legacy',
    capturedAt: 80,
    coverage: {
      kind: 'sampled-observations',
      includesPreObservationHistory: false,
      firstObservedAt: 20,
      lastObservedAt: 20,
      droppedEarlierObservations: false,
      terminalRunObserved: false,
      stopReason: 'manual',
      logTruncation: false,
      redactedContent: false,
      missingMediaKeys: []
    },
    records: [
      {
        stepKey: 'legacy-step',
        observedAt: 20,
        phase: 'running',
        sourceEvidence: {
          identity: {
            projectId: 'sender-project',
            sessionId: 'sender-session',
            runId: 'sender-run'
          },
          cursor: { epoch: 'sender-epoch', sequence: 0 },
          stepId: 'run:sender-run'
        },
        run: {
          kernelKind: 'bash',
          status: 'running',
          startedAt: 10,
          logs: {
            stdout: { text: 'Saved output', truncated: false, redacted: false },
            stderr: { text: '', truncated: false, redacted: false },
            traceback: { text: '', truncated: false, redacted: false }
          }
        },
        artifactEvidence: [],
        artifactsTruncated: false
      }
    ],
    media: []
  },
  media: []
})
const candidate = (target = receiving): RecordingCandidate => ({
  target,
  format: 'project-recording',
  resource: {
    id: target.versionId,
    name: 'Independent project recording',
    ...target,
    availability: 'recorded'
  }
})
const discovery = (recordings: RecordingCandidate[] = []): RecordingDiscovery => ({
  recordings,
  nextOffset: recordings.length,
  unchecked: 0,
  unavailable: 0,
  loading: false,
  supported: true,
  loadMore: vi.fn(),
  retry: vi.fn()
})
const deferred = <T,>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((finish) => {
    resolve = finish
  })
  return { promise, resolve }
}
const preview = (
  content = 'aW1hZ2U='
): { content: string; encoding: 'base64'; truncated: boolean } => ({
  content,
  encoding: 'base64' as const,
  truncated: false
})
const runtime = { start: vi.fn(), stop: vi.fn(), list: vi.fn(), get: vi.fn() }
const api = {
  sessionReplay: { readObservationBindings: vi.fn() },
  researchDemos: { ...runtime, readHistory: vi.fn() },
  observations: {
    ...runtime,
    openRecorded: vi.fn(),
    revoke: vi.fn(),
    readRecorded: vi.fn(),
    readProjectRecording: vi.fn(),
    selectRecordedFile: vi.fn()
  },
  projectRecordings: { selection: vi.fn(), read: vi.fn() },
  artifacts: { readPreview: vi.fn() },
  uploads: { readPreview: vi.fn() },
  notebook: { ...runtime }
}
type HarnessProps = {
  document?: ReplayDocument
  discovery: RecordingDiscovery
  legacySource?: ResearchDemoSource
  externalCandidate?: RecordingCandidate
}
function Harness(props: HarnessProps): React.JSX.Element {
  const materials = useRecordedMaterials(props.document, props.discovery, props.legacySource)
  const view = materials.views.find((item) => item.id === 'project')!
  return (
    <>
      <output data-testid="material-request">
        {materials.request ? JSON.stringify(materials.request) : 'none'}
      </output>
      {props.externalCandidate ? (
        <button onClick={() => materials.choose(props.externalCandidate!)}>
          Choose discovered recording
        </button>
      ) : null}
      {typeof view.content === 'function' ? view.content(true) : view.content}
    </>
  )
}
const select = (target = receiving): void => {
  fireEvent.change(screen.getByRole('combobox', { name: 'Project recording' }), {
    target: { value: JSON.stringify(target) }
  })
}
const expectNoExecution = (): void => {
  for (const operation of Object.values(runtime)) expect(operation).not.toHaveBeenCalled()
}

beforeEach(() => {
  vi.clearAllMocks()
  api.researchDemos.readHistory.mockResolvedValue({ receipts: [] })
  api.observations.revoke.mockResolvedValue(undefined)
  api.observations.openRecorded.mockImplementation(async ({ target, format }) => ({
    mode: 'recorded',
    format,
    viewerId: 'recorded',
    target,
    expiresAt: 999999,
    url: `http://viewer-recorded.localhost:56789/__open_science_viewer?grant=${'a'.repeat(64)}`
  }))
  api.projectRecordings.selection.mockResolvedValue(null)
  api.observations.readRecorded.mockResolvedValue(legacyPayload())
  api.observations.readProjectRecording.mockImplementation(async () => projectPayload())
  api.observations.selectRecordedFile.mockImplementation(async () =>
    recordedFileSelectionForPayload(projectPayload(), 'frame-image')
  )
  api.artifacts.readPreview.mockResolvedValue(preview())
  recovery.onClick.mockResolvedValue(undefined)
  Object.defineProperty(window, 'api', { configurable: true, value: api })
  useNavigationStore.setState({ explicitNavigationRevision: 0 })
  useRunObservationQuestionStore.setState({
    destination: undefined,
    pending: undefined,
    lastAdded: undefined
  })
})
afterEach(() => {
  cleanup()
  useRunObservationQuestionStore.setState({
    destination: undefined,
    pending: undefined,
    lastAdded: undefined
  })
})

describe('useRecordedMaterials read-only ownership', () => {
  it('derives an elapsed document only for the selected receiving recording and releases it on source change', async () => {
    const payload = browserPayloadFixture()
    payload.receiving = receiving
    payload.recording.source = { projectId: receiving.projectId, sessionId: receiving.sessionId }
    api.projectRecordings.read.mockResolvedValue(payload)
    const document = documentFixture()
    document.branches = [
      {
        id: 'main',
        kind: 'conversation',
        durationMs: 5000,
        steps: [
          {
            id: 'last',
            branchId: 'main',
            kind: 'artifact',
            startMs: 0,
            endMs: 2500,
            durationMs: 2500,
            recordedAt: 9000,
            activities: [],
            runs: [],
            resourceIds: [],
            evidence: [],
            issues: []
          },
          {
            id: 'first',
            branchId: 'main',
            kind: 'message',
            startMs: 2500,
            endMs: 5000,
            durationMs: 2500,
            recordedAt: 500,
            activities: [],
            runs: [],
            resourceIds: [],
            evidence: [],
            issues: []
          }
        ]
      }
    ]
    const recording = { ...candidate(), format: 'web-recording' as const }
    const { result, rerender } = renderHook(
      ({ doc }) => useRecordedMaterials(doc, discovery([recording])),
      { initialProps: { doc: document } }
    )
    act(() => result.current.choose(recording))
    await waitFor(() => expect(result.current.recordedTimeOrigins).toEqual({ main: 500 }))
    expect(result.current.playbackDocument?.branches[0].steps.map((step) => step.id)).toEqual([
      'first',
      'last'
    ])
    expect(result.current.playbackDocument?.branches[0].durationMs).toBe(8500)
    expect(document.branches[0].steps[0].id).toBe('last')
    rerender({ doc: documentFixture('other-session') })
    expect(result.current.playbackDocument).toBeUndefined()
    expectNoExecution()
  })

  it('reads legacy local history without resuming runs or acquiring live viewers', async () => {
    const receipt = {
      source,
      requestId: 'old-run',
      demoVersionId: 'demo-version',
      title: 'Saved local evidence',
      substitutions: [],
      purpose: 'offline-demo' as const,
      state: 'completed' as const,
      createdAt: 10,
      updatedAt: 80
    }
    const history: ResearchDemoHistory = {
      receipts: [
        { ...receipt, recordingTarget: receiving },
        { ...receipt, requestId: 'interrupted-run', title: 'Interrupted run', state: 'interrupted' }
      ]
    }
    api.researchDemos.readHistory.mockResolvedValue(history)
    render(<Harness document={documentFixture()} discovery={discovery()} legacySource={source} />)
    await screen.findByRole('option', { name: 'Local historical run · Saved local evidence' })
    expect(api.researchDemos.readHistory).toHaveBeenCalledWith(source)
    expect(
      screen.getByText(
        'Some local runs have no saved recording. Viewing history does not resume them.'
      )
    ).toBeTruthy()
    expect(api.observations.readRecorded).not.toHaveBeenCalled()
    expect(screen.getByTestId('material-request').textContent).toBe('none')
    select()
    await waitFor(() =>
      expect(api.observations.readRecorded).toHaveBeenCalledWith({ target: receiving })
    )
    await screen.findByText(
      'No project images were recorded. Other research materials remain available.'
    )
    expect(
      screen.getByText(
        'Recorded on this device. This is separate from the imported author’s evidence.'
      )
    ).toBeTruthy()
    expectNoExecution()
  })

  it('selects an independent ProjectRecording without Notebook and references its exact receiving media', async () => {
    const destination = {
      projectId: receiving.projectId,
      sessionId: 'discussion-session',
      draftKey: 'discussion-draft'
    }
    useRunObservationQuestionStore.setState({ destination })
    render(<Harness document={documentFixture()} discovery={discovery([candidate()])} />)
    select()
    fireEvent.load(await screen.findByRole('img'))
    expect(api.observations.readProjectRecording).toHaveBeenCalledWith({ target: receiving })
    expect(api.observations.readRecorded).not.toHaveBeenCalled()
    expect(api.artifacts.readPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: receiving.projectId,
        sessionId: receiving.sessionId,
        fileId: 'receiver-image-artifact',
        versionId: 'receiver-image-version',
        encoding: 'base64'
      })
    )
    expect(screen.queryByText('Notebook')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Ask about this frame' }))
    await waitFor(() =>
      expect(useRunObservationQuestionStore.getState().pending?.destination).toEqual(destination)
    )
    expect(api.observations.selectRecordedFile).toHaveBeenCalledWith({
      target: receiving,
      mediaKey: 'frame-image',
      format: 'project-recording'
    })
    expect(useRunObservationQuestionStore.getState().pending?.selection).toEqual(
      recordedFileSelectionForPayload(projectPayload(), 'frame-image')
    )
    expect(recovery.onClick).not.toHaveBeenCalled()
    expectNoExecution()
  })

  it('preselects saved source footage after discovery without changing the material tab or overriding an explicit choice', async () => {
    const doc = documentFixture()
    const { rerender } = render(
      <Harness document={doc} discovery={{ ...discovery(), loading: true }} />
    )
    rerender(
      <Harness
        document={doc}
        discovery={discovery([candidate()])}
        externalCandidate={candidate()}
      />
    )
    expect(screen.getByRole('option', { name: 'Independent project recording' })).toBeTruthy()
    fireEvent.load(await screen.findByRole('img'))
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe(
      JSON.stringify(receiving)
    )
    expect(screen.getByTestId('material-request').textContent).toBe('none')
    expect(api.observations.readProjectRecording).toHaveBeenCalledTimes(1)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '' } })
    expect(
      screen.queryByText(
        'No project images were recorded. Other research materials remain available.'
      )
    ).toBeNull()
    rerender(
      <Harness
        document={doc}
        discovery={discovery([candidate()])}
        externalCandidate={candidate()}
      />
    )
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('')
    fireEvent.click(screen.getByRole('button', { name: 'Choose discovered recording' }))
    fireEvent.load(await screen.findByRole('img'))
    expect(JSON.parse(screen.getByTestId('material-request').textContent!)).toEqual({
      id: 'project',
      revision: 1
    })
    expectNoExecution()
  })

  it.each(['unmount', 'navigation', 'destination', 'source'] as const)(
    'discards a pending file question after %s changes',
    async (change) => {
      const pending = deferred<ReturnType<typeof recordedFileSelectionForPayload>>()
      api.observations.selectRecordedFile.mockReturnValue(pending.promise)
      const props = { document: documentFixture(), discovery: discovery([candidate()]) }
      const { rerender, unmount } = render(<Harness {...props} />)
      select()
      fireEvent.load(await screen.findByRole('img'))
      fireEvent.click(screen.getByRole('button', { name: 'Ask about this frame' }))
      await waitFor(() => expect(api.observations.selectRecordedFile).toHaveBeenCalledTimes(1))
      if (change === 'unmount') unmount()
      if (change === 'navigation')
        act(() => useNavigationStore.setState({ explicitNavigationRevision: 1 }))
      if (change === 'destination')
        act(() =>
          useRunObservationQuestionStore.setState({
            destination: {
              projectId: receiving.projectId,
              sessionId: 'new-session',
              draftKey: 'new-draft'
            }
          })
        )
      if (change === 'source')
        rerender(<Harness document={documentFixture('new-source')} discovery={discovery()} />)
      await act(async () =>
        pending.resolve(recordedFileSelectionForPayload(projectPayload(), 'frame-image'))
      )
      expect(useRunObservationQuestionStore.getState().pending).toBeUndefined()
      expect(recovery.onClick).not.toHaveBeenCalled()
    }
  )

  it('shows author-declared state without fabricating an image when media were never recorded', async () => {
    const payload = projectPayload()
    payload.recording.media = []
    payload.recording.frames = []
    payload.recording.states = [
      {
        stateId: 'state-0',
        sequence: 0,
        recordedAt: 20,
        source: 'author-declared',
        value: { actions: 4 }
      }
    ]
    api.observations.readProjectRecording.mockResolvedValue({ ...payload, media: [] })
    render(<Harness document={documentFixture()} discovery={discovery([candidate()])} />)
    select()
    await screen.findByText('Recorded states and events')
    expect(
      screen.getByText(
        'No project images were recorded. Other research materials remain available.'
      )
    ).toBeTruthy()
    expect(screen.queryByRole('img')).toBeNull()
    expect(api.artifacts.readPreview).not.toHaveBeenCalled()
    expectNoExecution()
  })

  it('degrades a missing receiving media mapping without falling back to a live project', async () => {
    api.observations.readProjectRecording.mockResolvedValue({ ...projectPayload(), media: [] })
    render(<Harness document={documentFixture()} discovery={discovery([candidate()])} />)
    select()
    await screen.findByText('This recorded media file is not included.')
    expect(screen.queryByRole('img')).toBeNull()
    expect(api.artifacts.readPreview).not.toHaveBeenCalled()
    expectNoExecution()
  })

  it('ignores a late old image after another recording has been chosen and its media read failed', async () => {
    const pending = deferred<ReturnType<typeof preview>>()
    const nextTarget = { ...receiving, artifactId: 'second-index', versionId: 'second-version' }
    const next = projectPayload()
    next.recording.recordingId = 'second-recording'
    api.observations.readProjectRecording
      .mockResolvedValueOnce(projectPayload())
      .mockResolvedValueOnce({ ...next, receiving: nextTarget })
    api.artifacts.readPreview
      .mockReturnValueOnce(pending.promise)
      .mockRejectedValueOnce(new Error('missing historical image'))
    render(
      <Harness
        document={documentFixture()}
        discovery={discovery([candidate(), candidate(nextTarget)])}
      />
    )
    select()
    await waitFor(() => expect(api.artifacts.readPreview).toHaveBeenCalledTimes(1))
    select(nextTarget)
    await screen.findByText('Could not read the recorded material.')
    await act(async () => pending.resolve(preview('b2xkLWltYWdl')))
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByText('Could not read the recorded material.')).toBeTruthy()
    expectNoExecution()
  })
})

it('prioritizes the final web index and keeps its catalog stable while checking later pages', async () => {
  const recordingId = 'fc7a7883-8c41-4c55-8b32-3a15ef8a7021'
  const document = documentFixture()
  document.resources = Array.from({ length: 34 }, (_, n) => ({
    id: `v-${n}`,
    ...receiving,
    artifactId: `a-${n}`,
    versionId: `v-${n}`,
    name:
      n === 0
        ? `web-recording-${recordingId}-checkpoint-1.json`
        : n === 33
          ? `web-recording-${recordingId}.json`
          : `ordinary-${n}.json`,
    availability: 'recorded',
    mimeType: 'application/json'
  }))
  api.artifacts.readPreview.mockImplementation(async ({ versionId }) => ({
    encoding: 'utf8',
    truncated: false,
    content: JSON.stringify(
      versionId === 'v-0' || versionId === 'v-33'
        ? { format: 'open-science-web-recording', version: 1, recordingId }
        : { ordinary: true }
    )
  }))
  const { result } = renderHook(() => useRecordingDiscovery(document))
  await waitFor(() =>
    expect(result.current.recordings.map((item) => item.target.versionId)).toEqual(['v-33'])
  )
  expect(result.current.unchecked).toBe(2)
  act(() => result.current.loadMore())
  await waitFor(() => expect(result.current.unchecked).toBe(0))
  expect(result.current.recordings.map((item) => item.target.versionId)).toEqual(['v-33'])
  expect(api.observations.openRecorded).not.toHaveBeenCalled()
})

it('keeps an explicitly opened checkpoint on its exact receiving version when discovery finds the final index', async () => {
  const document = documentFixture()
  const checkpoint: RecordingCandidate = { ...candidate(), format: 'web-recording' }
  checkpoint.resource.name = 'web-recording-checkpoint.json'
  const final: RecordingCandidate = {
    ...candidate({ ...receiving, artifactId: 'final-artifact', versionId: 'final-version' }),
    format: 'web-recording'
  }
  final.resource.name = 'web-recording-final.json'
  const view = render(<Harness document={document} discovery={discovery([checkpoint])} />)
  select(checkpoint.target)
  await waitFor(() => expect(api.observations.openRecorded).toHaveBeenCalledTimes(1))
  expect(api.observations.openRecorded.mock.calls[0][0]).toMatchObject({
    target: checkpoint.target,
    format: 'web-recording'
  })
  view.rerender(<Harness document={document} discovery={discovery([final])} />)
  expect(
    (screen.getByRole('combobox', { name: 'Project recording' }) as HTMLSelectElement).value
  ).toBe(JSON.stringify(checkpoint.target))
  expect(
    [...screen.getAllByRole('option')].find(
      (option) => (option as HTMLOptionElement).value === JSON.stringify(checkpoint.target)
    )
  ).toHaveProperty('disabled', true)
  fireEvent.click(screen.getByRole('button', { name: 'Recording details' }))
  expect(screen.getByText(checkpoint.resource.name)).toBeTruthy()
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
  expect(screen.getByTitle(checkpoint.resource.name)).toBeTruthy()
  expect(api.observations.openRecorded).toHaveBeenCalledTimes(1)
  select(final.target)
  await waitFor(() => expect(api.observations.openRecorded).toHaveBeenCalledTimes(2))
  expect(api.observations.openRecorded.mock.calls[1][0]).toMatchObject({
    target: final.target,
    format: 'web-recording'
  })
  expect(screen.queryByRole('option', { name: checkpoint.resource.name })).toBeNull()
  expectNoExecution()
})

it('freezes captured image support IDs before playback without hiding scientific report attachments', async () => {
  const document = documentFixture()
  const payload = projectPayload()
  payload.recording.media.push({
    mediaKey: 'report',
    name: 'report.csv',
    mimeType: 'text/csv',
    checksum: 'b'.repeat(64),
    sizeBytes: 20,
    sourceVersionId: 'author-report'
  })
  const saved = {
    ...payload,
    media: [
      ...payload.media,
      {
        mediaKey: 'report',
        artifactId: 'receiver-report-artifact',
        versionId: 'receiver-report-version',
        checksum: 'b'.repeat(64),
        sizeBytes: 20
      }
    ]
  }
  api.observations.readProjectRecording.mockResolvedValue(saved)
  document.resources = [
    candidate().resource,
    {
      ...candidate().resource,
      id: 'frame-resource',
      artifactId: 'receiver-image-artifact',
      versionId: 'receiver-image-version',
      name: 'frame.png'
    },
    {
      ...candidate().resource,
      id: 'report-resource',
      artifactId: 'receiver-report-artifact',
      versionId: 'receiver-report-version',
      name: 'report.csv'
    }
  ]
  document.branches = [
    {
      id: 'main',
      kind: 'conversation',
      durationMs: 10000,
      steps: [
        {
          id: 'request',
          kind: 'message',
          branchId: 'main',
          startMs: 0,
          endMs: 1000,
          durationMs: 1000,
          recordedAt: 0,
          evidence: [],
          resourceIds: [],
          runs: [],
          activities: [],
          issues: []
        },
        ...document.resources.map((resource, index) => ({
          id: resource.id,
          kind: 'artifact' as const,
          branchId: 'main',
          startMs: 1000 + index * 1000,
          endMs: 2000 + index * 1000,
          durationMs: 1000,
          recordedAt: 10 + index * 10,
          evidence: [],
          resourceIds: [resource.id],
          runs: [],
          activities: [],
          issues: []
        }))
      ]
    }
  ]
  const catalog = discovery([candidate()])
  const { result } = renderHook(() => useRecordedMaterials(document, catalog))
  await waitFor(() => expect(result.current.timingReady).toBe(true))
  expect(result.current.playbackDocument?.branches[0].steps.map((step) => step.id)).toEqual([
    'request',
    'report-resource'
  ])
  expect(api.observations.readProjectRecording).toHaveBeenCalledTimes(1)
  expect(result.current.request).toBeUndefined()
  const frozen = result.current.playbackDocument
  act(() => result.current.choose(candidate()))
  expect(result.current.playbackDocument).toBe(frozen)
  expectNoExecution()
})

it('keeps research results independent of project selection and asks the exact result owner', async () => {
  const one = projectPayload(),
    two = projectPayload()
  const secondTarget = { ...receiving, artifactId: 'second-index', versionId: 'second-version' }
  const attach = (value: RecordedProjectPayload, suffix: string): void => {
    value.recording.recordingId = `recording-${suffix}`
    value.recording.title = `Saved source ${suffix}`
    value.recording.media.push({
      mediaKey: 'report',
      name: `${suffix}-report.txt`,
      mimeType: 'text/plain',
      checksum: 'b'.repeat(64),
      sizeBytes: 6,
      sourceVersionId: `author-${suffix}`
    })
    ;(value.media as Array<RecordedProjectPayload['media'][number]>).push({
      mediaKey: 'report',
      artifactId: `report-${suffix}`,
      versionId: `report-${suffix}-v1`,
      checksum: 'b'.repeat(64),
      sizeBytes: 6
    })
  }
  attach(one, 'one')
  attach(two, 'two')
  const second = { ...two, receiving: secondTarget }
  api.observations.readProjectRecording.mockImplementation(async ({ target }) =>
    target.versionId === secondTarget.versionId ? second : one
  )
  api.observations.selectRecordedFile.mockImplementation(async ({ target, mediaKey }) =>
    recordedFileSelectionForPayload(
      target.versionId === secondTarget.versionId ? second : one,
      mediaKey
    )
  )
  api.artifacts.readPreview.mockResolvedValue({
    content: 'Report',
    encoding: 'utf8',
    truncated: false
  })
  const doc = documentFixture()
  doc.resources = [
    { ...recordedMediaResource(one, 'report'), createdAt: 10 },
    { ...recordedMediaResource(second, 'report'), createdAt: 50 }
  ]
  const candidates = discovery([candidate(), candidate(secondTarget)])
  const changed = vi.fn<(action: ReplayMaterialAction | undefined) => void>()
  function ResultsHarness(): React.JSX.Element {
    const materials = useRecordedMaterials(doc, candidates)
    const view = materials.views.find((item) => item.id === 'results')!
    return (
      <ReplayMaterialActionProvider onActionChange={changed}>
        <button onClick={() => materials.choose(candidate(secondTarget))}>Change footage</button>
        {typeof view.content === 'function' ? view.content(true) : view.content}
      </ReplayMaterialActionProvider>
    )
  }
  render(<ResultsHarness />)
  await screen.findByRole('option', { name: 'Saved source one' })
  fireEvent.click(await screen.findByRole('button', { name: 'one-report.txt' }))
  await screen.findByText('Report')
  expect(screen.queryByRole('combobox', { name: 'Project recording' })).toBeNull()
  expect(screen.getByRole('button', { name: 'two-report.txt' })).toBeTruthy()
  expect(changed.mock.calls.at(-1)?.[0]?.recordedAt).toBe(10)
  fireEvent.click(screen.getByRole('button', { name: 'Change footage' }))
  expect(screen.getByRole('button', { name: 'one-report.txt' })).toHaveProperty(
    'ariaPressed',
    'true'
  )
  const action = changed.mock.calls.at(-1)![0]!
  await act(async () => action.onAsk())
  await waitFor(() =>
    expect(api.observations.selectRecordedFile).toHaveBeenCalledWith({
      target: receiving,
      mediaKey: 'report',
      format: 'project-recording'
    })
  )
  expect(recovery.onClick).toHaveBeenCalledWith(
    recordedFileSelectionForPayload(one, 'report'),
    expect.any(AbortSignal)
  )
  expectNoExecution()
})

it.each(['artifact', 'upload'] as const)(
  'reads a fixed %s result whose catalog resource has no locator',
  async (source) => {
    const doc = documentFixture()
    const resource: ReplayResource = {
      id: 'stored-result',
      name: 'Stored output.txt',
      source,
      projectId: receiving.projectId,
      sessionId: receiving.sessionId,
      ...(source === 'artifact' ? { artifactId: 'stored-file' } : { fileId: 'stored-file' }),
      versionId: 'stored-version',
      availability: 'recorded',
      checksum: 'c'.repeat(64),
      mimeType: 'text/plain'
    }
    doc.resources = [
      resource,
      {
        ...resource,
        id: 'contradictory',
        name: 'Invalid output.txt',
        locator: '/mutable/latest.txt'
      }
    ]
    const catalog = discovery()
    const reader = source === 'artifact' ? api.artifacts.readPreview : api.uploads.readPreview
    reader.mockResolvedValue({
      content: 'Original immutable result',
      encoding: 'utf8',
      truncated: false
    })
    function ResultsHarness(): React.JSX.Element {
      const materials = useRecordedMaterials(doc, catalog, undefined, undefined, 'research')
      const view = materials.views.find((item) => item.id === 'results')!
      return (
        <>
          <output data-testid="ready">{String(materials.timingReady)}</output>
          {typeof view.content === 'function' ? view.content(true) : view.content}
        </>
      )
    }
    render(<ResultsHarness />)
    await waitFor(() => expect(screen.getByTestId('ready').textContent).toBe('true'))
    expect(screen.queryByRole('button', { name: 'Invalid output.txt' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Stored output.txt' }))
    await screen.findByText('Original immutable result')
    expect(reader).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        projectId: receiving.projectId,
        sessionId: receiving.sessionId,
        fileId: 'stored-file',
        versionId: 'stored-version',
        encoding: 'utf8',
        path: expect.stringContaining('stored-version')
      })
    )
    expect(
      source === 'artifact' ? api.uploads.readPreview : api.artifacts.readPreview
    ).not.toHaveBeenCalled()
    expect(resource.locator).toBeUndefined()
    expectNoExecution()
  }
)

it('stages only the selected immutable intermediate observation in the existing discussion flow', async () => {
  const document = documentFixture()
  document.branches = [
    {
      id: 'main',
      kind: 'conversation',
      durationMs: 90,
      steps: [
        {
          id: 'owner',
          branchId: 'main',
          kind: 'notebook',
          recordedAt: 10,
          recordedEndAt: 100,
          startMs: 0,
          endMs: 90,
          durationMs: 90,
          activities: [],
          resourceIds: [],
          evidence: [],
          issues: [],
          runs: [
            {
              runId: 'mapped-run',
              cellId: 'cell',
              source: 'agent',
              kernelKind: 'bash',
              status: 'completed',
              startedAt: 10,
              endedAt: 100
            }
          ]
        }
      ]
    }
  ]
  const payload = legacyPayload()
  document.resources = [
    {
      ...receiving,
      id: receiving.versionId,
      name: 'States.json',
      availability: 'recorded',
      checksum: 'a'.repeat(64)
    }
  ]
  const discovered = discovery([{ ...candidate(), format: undefined }])
  api.observations.readRecorded.mockResolvedValue(payload)
  api.sessionReplay.readObservationBindings.mockResolvedValue({
    sourceFingerprint: document.source.fingerprint,
    bindings: [
      {
        target: receiving,
        recordingId: payload.archive.recordingId,
        archiveChecksum: 'a'.repeat(64),
        runId: 'mapped-run',
        branchIds: ['main'],
        basis: 'import-receipt'
      }
    ],
    unavailableTargets: []
  })
  const { result } = renderHook(() => useRecordedMaterials(document, discovered))
  await waitFor(() => expect(result.current.executionTracks).toHaveLength(1))
  const track = result.current.executionTracks![0]
  const selected = track.select(track.snapshots[0])
  const watching = { branchId: 'main', stepId: 'owner', runId: 'mapped-run', timeMs: 40 }
  await act(async () => {
    await result.current.askObservation(selected, watching)
  })
  const captured = recovery.onClick.mock.calls[0][0]
  expect(captured).toMatchObject({
    kind: 'recorded-run-observation',
    receiving,
    stepKey: 'legacy-step',
    record: { observedAt: 20, run: { logs: { stdout: { text: 'Saved output' } } } }
  })
  expect(captured.selectionId).toBeTruthy()
  payload.archive.records[0].run!.logs.stdout.text = 'later mutation'
  expect(captured.record.run.logs.stdout.text).toBe('Saved output')
  await expect(result.current.askObservation(selected, { ...watching, timeMs: 0 })).rejects.toThrow(
    'unavailable'
  )
  await expect(
    result.current.askObservation(
      { ...selected, receiving: { ...receiving, versionId: 'forged' } },
      watching
    )
  ).rejects.toThrow('unavailable')
  expect(recovery.onClick).toHaveBeenCalledTimes(1)
  expectNoExecution()
})

it('follows successive native recordings without pausing or seeking and keeps an explicit choice until follow resumes', async () => {
  const doc = documentFixture()
  doc.branches = [
    {
      id: 'main',
      kind: 'conversation',
      durationMs: 20000,
      steps: [
        {
          id: 'request',
          branchId: 'main',
          kind: 'message',
          recordedAt: 0,
          startMs: 0,
          endMs: 20000,
          durationMs: 20000,
          evidence: [],
          resourceIds: [],
          runs: [],
          activities: [],
          issues: []
        }
      ]
    }
  ]
  const first = browserPayloadFixture(),
    second = browserPayloadFixture()
  first.receiving = receiving
  first.recording.source = {
    projectId: receiving.projectId,
    sessionId: receiving.sessionId,
    operationId: 'first'
  }
  second.receiving = { ...receiving, artifactId: 'second', versionId: 'second-v1' }
  second.recording.recordingId = 'second'
  second.recording.startedAt = 10000
  second.recording.source = { ...first.recording.source, operationId: 'second' }
  api.projectRecordings.read.mockImplementation(async ({ target }) =>
    target.versionId === second.receiving.versionId ? second : first
  )
  const catalog = discovery([
    { ...candidate(), format: 'web-recording' },
    { ...candidate(second.receiving), format: 'web-recording' }
  ])
  const onPause = vi.fn(),
    onSeekRecordedAt = vi.fn()
  function FollowingHarness({ at }: { at: number }): React.JSX.Element {
    const materials = useRecordedMaterials(doc, catalog, undefined, undefined, 'research')
    const view = materials.views.find((view) => view.id === 'project')!
    return (
      <>
        {typeof view.content === 'function'
          ? view.content(true, {
              branchId: 'main',
              recordedAt: at,
              playing: true,
              speed: 1,
              continuous: true,
              onPause,
              onSeekRecordedAt
            })
          : view.content}
      </>
    )
  }
  const view = render(<FollowingHarness at={1500} />)
  const chooser = (await screen.findByRole('combobox', {
    name: 'Project recording'
  })) as HTMLSelectElement
  await screen.findByRole('button', { name: 'Following replay' })
  await waitFor(() => expect(chooser.value).toBe(JSON.stringify(first.receiving)))
  view.rerender(<FollowingHarness at={11000} />)
  await waitFor(() => expect(chooser.value).toBe(JSON.stringify(second.receiving)))
  select(first.receiving)
  await screen.findByRole('button', { name: 'Follow replay' })
  view.rerender(<FollowingHarness at={12000} />)
  expect(chooser.value).toBe(JSON.stringify(first.receiving))
  fireEvent.click(screen.getByRole('button', { name: 'Follow replay' }))
  await waitFor(() => expect(chooser.value).toBe(JSON.stringify(second.receiving)))
  expect(onPause).not.toHaveBeenCalled()
  expect(onSeekRecordedAt).not.toHaveBeenCalled()
  expectNoExecution()
})
