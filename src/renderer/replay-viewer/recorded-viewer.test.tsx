// @vitest-environment jsdom
import { cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  recordedObservationPayloadSchema,
  recordedProjectPayloadSchema,
  recordedFileSelectionForPayload,
  type RecordedObservationPayload,
  type RecordedRunObservationSelection
} from '../../shared/run-observation-recorded'
import { ReplayViewerClient, type RecordedReplayViewerContext } from './client'
import { ViewerApp } from './ViewerApp'
import { useViewerObservation } from './use-viewer-observation'
import { projectRecordedObservation } from '../src/lib/replay/recorded-observation'
import * as recordedProjection from '../src/lib/replay/recorded-observation'
const payload = (): RecordedObservationPayload =>
  recordedObservationPayloadSchema.parse({
    receiving: {
      projectId: 'local-project',
      sessionId: 'local-session',
      artifactId: 'local-recording',
      versionId: 'local-recording-version'
    },
    archive: {
      format: 'open-science-run-observation',
      version: 1,
      recordingId: 'recording',
      capturedAt: 300,
      coverage: {
        kind: 'sampled-observations',
        includesPreObservationHistory: false,
        firstObservedAt: 100,
        lastObservedAt: 100,
        droppedEarlierObservations: false,
        terminalRunObserved: true,
        stopReason: 'run-ended',
        logTruncation: false,
        redactedContent: false,
        missingMediaKeys: []
      },
      records: [
        {
          stepKey: 'step',
          observedAt: 100,
          phase: 'completed',
          sourceEvidence: {
            identity: {
              projectId: 'foreign-project',
              sessionId: 'foreign-session',
              runId: 'foreign-run'
            },
            cursor: { epoch: 'foreign-epoch', sequence: 0 },
            stepId: 'run:foreign-run'
          },
          run: {
            kernelKind: 'bash',
            status: 'completed',
            startedAt: 50,
            endedAt: 100,
            logs: {
              stdout: { text: 'original archived output', truncated: false, redacted: false },
              stderr: { text: '', truncated: false, redacted: false },
              traceback: { text: '', truncated: false, redacted: false }
            }
          },
          artifactEvidence: [],
          artifactsTruncated: false
        }
      ],
      media: [
        {
          mediaKey: 'saved-file',
          name: 'saved.txt',
          mimeType: 'text/plain',
          checksum: 'a'.repeat(64),
          sizeBytes: 5,
          sourceVersionId: 'foreign-version',
          stepKeys: ['step']
        }
      ]
    },
    media: [
      {
        mediaKey: 'saved-file',
        artifactId: 'local-file',
        versionId: 'local-file-version',
        checksum: 'a'.repeat(64),
        sizeBytes: 5
      }
    ]
  })
const context = (recording: RecordedObservationPayload): RecordedReplayViewerContext => ({
  viewerId: 'recorded-viewer',
  mode: 'recorded' as const,
  target: recording.receiving,
  expiresAt: 999999,
  canInteract: false as const,
  canCancel: false as const,
  canReadArtifacts: true
})
const selection = (recording: RecordedObservationPayload): RecordedRunObservationSelection => ({
  kind: 'recorded-run-observation',
  recordingId: recording.archive.recordingId,
  receiving: recording.receiving,
  stepKey: 'step',
  record: recording.archive.records[0],
  mediaKeys: ['saved-file']
})
const json = (value: unknown): Response =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {
        /* Fixed unit viewport. */
      }
      unobserve(): void {
        /* Fixed unit viewport. */
      }
      disconnect(): void {
        /* No external observer. */
      }
    }
  )
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  }))
  HTMLElement.prototype.scrollIntoView = vi.fn()
  Object.defineProperty(window, 'api', { configurable: true, value: undefined })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
describe('recorded browser viewer', () => {
  it('loads a project-only recording through the same read-only client and validates its file selection', async () => {
    const legacy = payload()
    const media = { ...legacy.archive.media[0], stepKeys: undefined }
    delete media.stepKeys
    const recording = recordedProjectPayloadSchema.parse({
      receiving: legacy.receiving,
      media: legacy.media,
      recording: {
        format: 'open-science-project-recording',
        version: 1,
        recordingId: 'project-only',
        startedAt: 100,
        endedAt: 300,
        media: [media],
        frames: [],
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
      }
    })
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(recording))
    const client = new ReplayViewerClient(fetcher)
    expect(await client.recording()).toEqual(recording)
    const selected = {
      ...recordedFileSelectionForPayload(recording, 'saved-file'),
      selectionId: 'file-reference',
      selectedAt: 400
    }
    fetcher.mockResolvedValue(json(selected))
    expect(await client.selectRecordingFile(recording, 'saved-file')).toEqual(selected)
    expect(selected.source).toBe('project-recording')
    expect(selected.scope).toBe('recording')
    expect(selected.stepKeys).toEqual([])
    vi.spyOn(client, 'context').mockResolvedValue({
      ...context(legacy),
      format: 'project-recording' as const
    })
    const read = vi.spyOn(client, 'recording').mockResolvedValue(recording)
    const history = vi.spyOn(client, 'history')
    const { result } = renderHook(() => useViewerObservation(client, 0))
    await waitFor(() => expect(result.current.recording).toEqual(recording))
    expect(read).toHaveBeenCalledOnce()
    expect(history).not.toHaveBeenCalled()
    expect(result.current.history).toBeUndefined()
  })
  it('rejects a legacy payload for a capability pinned to project recordings', async () => {
    const recording = payload(),
      client = new ReplayViewerClient()
    vi.spyOn(client, 'context').mockResolvedValue({
      ...context(recording),
      format: 'project-recording' as const
    })
    vi.spyOn(client, 'recording').mockResolvedValue(recording)
    const { result } = renderHook(() => useViewerObservation(client, 0))
    await waitFor(() => expect(result.current.error).toBe('unavailable'))
    expect(result.current.recording).toBeUndefined()
  })
  it('uses a separate authenticated file-selection route and rejects substituted immutable evidence', async () => {
    const recording = payload()
    const selection = {
      ...recordedFileSelectionForPayload(recording, 'saved-file'),
      selectionId: 'selection-1',
      selectedAt: 100
    }
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify(selection), { headers: { 'content-type': 'application/json' } })
      )
    const client = new ReplayViewerClient(fetcher)
    expect(await client.selectRecordingFile(recording, 'saved-file')).toEqual(selection)
    expect(fetcher).toHaveBeenCalledWith(
      '/api/recording/file-selection',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        body: JSON.stringify({ mediaKey: 'saved-file' })
      })
    )
    fetcher.mockResolvedValue(
      new Response(JSON.stringify(selection), { headers: { 'content-type': 'application/json' } })
    )
    expect(await client.recordedFileSelection(recording)).toEqual(selection)
    fetcher.mockResolvedValue(
      new Response(
        JSON.stringify({
          ...selection,
          resource: { ...selection.resource, versionId: 'replacement' }
        }),
        { headers: { 'content-type': 'application/json' } }
      )
    )
    await expect(client.recordedFileSelection(recording)).rejects.toMatchObject({
      kind: 'invalid-response'
    })
    fetcher.mockClear()
    await expect(
      client.selectRecordingFile({ ...recording, media: [] }, 'saved-file')
    ).rejects.toMatchObject({ kind: 'unavailable' })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('shows server-validated demo context without adding purpose to archive v1 or treating it as a live run', async () => {
    const recording: RecordedObservationPayload = {
      ...payload(),
      executionContext: {
        purpose: 'offline-demo',
        conditionChanges: ['Offline recorded responses']
      }
    }
    const client = new ReplayViewerClient()
    const archiveBefore = JSON.stringify(recording.archive)
    vi.spyOn(client, 'context').mockResolvedValue(context(recording))
    vi.spyOn(client, 'recording').mockResolvedValue(recording)
    vi.spyOn(client, 'recordedSelection').mockResolvedValue(null)
    render(<ViewerApp client={client} />)
    expect(await screen.findByText('Offline run')).toBeTruthy()
    fireEvent.click(screen.getByText('Execution conditions'))
    expect(screen.getByText('Offline recorded responses')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Stop run' })).toBeNull()
    expect(JSON.stringify(recording.archive)).toBe(archiveBefore)
  })

  it('shows archive-specific loading and failure without implying that a Run is connecting', async () => {
    const recording = payload(),
      client = new ReplayViewerClient()
    vi.spyOn(client, 'context').mockResolvedValue(context(recording))
    let reject!: (error: Error) => void
    vi.spyOn(client, 'recording').mockImplementation(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail
        })
    )
    render(<ViewerApp client={client} />)
    await screen.findByText('Loading archived observation…')
    expect(screen.queryByText('Connecting to the research run…')).toBeNull()
    reject(new Error('offline'))
    await screen.findByText(
      'The archived observation could not be loaded. Retry to read this saved Version.'
    )
    expect(
      screen.queryByText('The viewer could not connect. The experiment may still be running.')
    ).toBeNull()
  })
  it('keeps all 4096 durable records selectable with a bounded step list and exact first, middle and last questions', async () => {
    const recording = { ...payload(), media: [] }
    const base = recording.archive.records[0]
    const count = 4096
    recording.archive.records = Array.from({ length: count }, (_, index) => ({
      ...structuredClone(base),
      // Equal adjacent timestamps and reverse lexical keys must not reorder source evidence.
      stepKey: `step-${count - index}`,
      observedAt: 100 + Math.floor(index / 2),
      sourceEvidence: {
        ...base.sourceEvidence,
        cursor: { epoch: 'foreign-epoch', sequence: index * 2 }
      },
      run: {
        ...base.run!,
        logs: {
          ...base.run!.logs,
          stdout: { text: `recorded output ${index}`, truncated: false, redacted: false }
        }
      }
    }))
    recording.archive.media = []
    recording.archive.capturedAt = 100 + count
    recording.archive.coverage.lastObservedAt = recording.archive.records.at(-1)!.observedAt
    recording.archive.coverage.sourceCursorGaps = count - 1
    const captures: RecordedRunObservationSelection[] = []
    const fetcher = vi.fn<typeof fetch>(async (path, options) => {
      if (path === '/api/context') return json(context(recording))
      if (path === '/api/recording') return json(recording)
      if (path === '/api/recording/selection') return json(null)
      if (path === '/api/recording/select') {
        const { stepKey } = JSON.parse(options!.body as string)
        const record = recording.archive.records.find((item) => item.stepKey === stepKey)!
        const frozen: RecordedRunObservationSelection = {
          kind: 'recorded-run-observation',
          selectionId: `selected-${captures.length}`,
          selectedAt: 9000,
          recordingId: recording.archive.recordingId,
          receiving: recording.receiving,
          stepKey,
          record,
          mediaKeys: []
        }
        captures.push(frozen)
        return json(frozen)
      }
      throw new Error(`Unexpected live or media endpoint: ${path}`)
    })
    const project = vi.spyOn(recordedProjection, 'projectRecordedObservation')
    const client = new ReplayViewerClient(fetcher)
    render(<ViewerApp client={client} />)
    await screen.findByText(`recorded output ${count - 1}`)
    expect(project).toHaveBeenCalledTimes(1)
    const projected = project.mock.results[0].value
    expect(projected.snapshots).toHaveLength(count)
    const node = screen.getByTestId('recorded-replay-view')
    for (const index of [0, 2047, count - 1]) {
      fireEvent.click(screen.getByRole('button', { name: 'Browse steps' }))
      const input = await screen.findByRole('spinbutton', { name: 'Step number' })
      // The complete archive stays addressable while only one 40-row page reaches the DOM.
      expect(
        screen.getAllByRole('button', { name: /^Go to step \d+:/ }).length
      ).toBeLessThanOrEqual(40)
      expect(document.querySelectorAll('*').length).toBeLessThan(2000)
      fireEvent.change(input, { target: { value: String(count + 1) } })
      expect(
        (screen.getByRole('button', { name: 'Go to step' }) as HTMLButtonElement).disabled
      ).toBe(true)
      fireEvent.change(input, { target: { value: String(index + 1) } })
      fireEvent.click(screen.getByRole('button', { name: 'Go to step' }))
      expect(screen.getByText(`recorded output ${index}`)).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'Ask about this step' }))
      await waitFor(() => {
        const reference = screen.getByRole('textbox', {
          name: 'Recorded step reference'
        }) as HTMLTextAreaElement
        expect(JSON.parse(reference.value).stepKey).toBe(`step-${count - index}`)
      })
      expect(captures.at(-1)!.record.sourceEvidence.cursor.sequence).toBe(index * 2)
      expect(captures.at(-1)!.record.run!.logs.stdout.text).toBe(`recorded output ${index}`)
      // Reference updates and navigation reuse the same player and immutable projection.
      expect(screen.getByTestId('recorded-replay-view')).toBe(node)
      expect(project).toHaveBeenCalledTimes(1)
    }
    expect(captures).toHaveLength(3)
  })
  it('loads an exact receiving recording without starting a live polling loop', async () => {
    const recording = payload(),
      client = new ReplayViewerClient()
    vi.spyOn(client, 'context').mockResolvedValue(context(recording))
    const get = vi.spyOn(client, 'recording').mockResolvedValue(recording)
    const history = vi.spyOn(client, 'history'),
      changes = vi.spyOn(client, 'changes'),
      snapshot = vi.spyOn(client, 'snapshot')
    const { result } = renderHook(() => useViewerObservation(client, 0))
    await waitFor(() => expect(result.current.recording).toEqual(recording))
    expect(get).toHaveBeenCalledTimes(1)
    expect(result.current.history).toBeUndefined()
    expect(history).not.toHaveBeenCalled()
    expect(changes).not.toHaveBeenCalled()
    expect(snapshot).not.toHaveBeenCalled()
  })
  it('does not publish an archive from another receiving Artifact Version', async () => {
    const recording = payload(),
      client = new ReplayViewerClient()
    vi.spyOn(client, 'context').mockResolvedValue(context(recording))
    vi.spyOn(client, 'recording').mockResolvedValue({
      ...recording,
      receiving: { ...recording.receiving, versionId: 'wrong' }
    })
    const { result } = renderHook(() => useViewerObservation(client, 0))
    await waitFor(() => expect(result.current.error).toBe('unavailable'))
    expect(result.current.recording).toBeUndefined()
  })
  it('renders archived evidence with no live controls and copies only the server-confirmed recorded reference', async () => {
    const recording = payload(),
      client = new ReplayViewerClient()
    vi.spyOn(client, 'context').mockResolvedValue(context(recording))
    vi.spyOn(client, 'recording').mockResolvedValue(recording)
    vi.spyOn(client, 'recordedSelection').mockResolvedValue(null)
    vi.spyOn(client, 'readRecordedResource').mockResolvedValue({
      status: 'ready',
      kind: 'text',
      content: 'saved',
      mimeType: 'text/plain',
      truncated: false
    })
    const capture = vi.spyOn(client, 'selectRecording').mockResolvedValue(selection(recording))
    const liveSelection = vi.spyOn(client, 'selection'),
      project = vi.spyOn(client, 'projectView'),
      cancel = vi.spyOn(client, 'cancel')
    render(<ViewerApp client={client} />)
    await screen.findByText('original archived output')
    expect(screen.getByText('Execution purpose not recorded')).toBeTruthy()
    expect(screen.queryByTestId('open-project-interface')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Stop run' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Back to live' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Ask about this step' }))
    const reference = await screen.findByRole('textbox', { name: 'Recorded step reference' })
    const value = JSON.parse((reference as HTMLTextAreaElement).value)
    expect(value).toMatchObject({
      kind: 'open-science-recorded-observation',
      viewerId: 'recorded-viewer',
      receiving: recording.receiving,
      stepKey: 'step'
    })
    expect(capture).toHaveBeenCalledExactlyOnceWith(recording, 'step')
    expect(value.runId).toBeUndefined()
    expect(liveSelection).not.toHaveBeenCalled()
    expect(project).not.toHaveBeenCalled()
    expect(cancel).not.toHaveBeenCalled()
  })
  it('sends only stepKey to archive selection and rejects altered source evidence', async () => {
    const recording = payload(),
      fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(selection(recording)))
    const client = new ReplayViewerClient(fetcher)
    expect(await client.selectRecording(recording, 'step')).toEqual(selection(recording))
    expect(fetcher).toHaveBeenCalledWith(
      '/api/recording/select',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ stepKey: 'step' }),
        credentials: 'same-origin'
      })
    )
    const altered = structuredClone(selection(recording))
    altered.record.run!.logs.stdout.text = 'unselected output'
    fetcher.mockResolvedValueOnce(json(altered))
    await expect(client.selectRecording(recording, 'step')).rejects.toMatchObject({
      kind: 'invalid-response'
    })
  })
  it.each(['unknown', 'offline-demo', 'research'] as const)(
    'accepts Main-owned recorded selection purpose %s without changing archive evidence',
    async (purpose) => {
      const recording: RecordedObservationPayload = {
        ...payload(),
        ...(purpose !== 'unknown'
          ? { executionContext: { purpose, conditionChanges: ['Declared difference'] } }
          : {})
      }
      const selected = {
        ...selection(recording),
        executionContext: recording.executionContext ?? { purpose: 'unknown', conditionChanges: [] }
      }
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(selected))
      const client = new ReplayViewerClient(fetcher)
      expect(await client.selectRecording(recording, 'step')).toEqual(selected)
      expect(await client.recordedSelection(recording)).toEqual(selected)
      expect(recording.archive).not.toHaveProperty('executionContext')
      fetcher.mockResolvedValueOnce(
        json({
          ...selected,
          executionContext: { purpose, conditionChanges: ['Unselected difference'] }
        })
      )
      await expect(client.selectRecording(recording, 'step')).rejects.toMatchObject({
        kind: 'invalid-response'
      })
    }
  )
  it('reads media only by an authorized mapping key, never an original source Version or pathname', async () => {
    const recording = payload(),
      projected = projectRecordedObservation(
        recording.archive,
        recording.receiving,
        recording.media
      )
    const resource = projected.resources.get('local-file-version')!,
      fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('saved', { headers: { 'content-type': 'text/plain' } }))
    const client = new ReplayViewerClient(fetcher)
    expect(await client.readRecordedResource(recording, resource)).toMatchObject({
      status: 'ready',
      content: 'saved'
    })
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      '/api/recording/media?mediaKey=saved-file',
      expect.objectContaining({ method: 'GET' })
    )
    await expect(
      client.recordedMedia(recording, { ...resource, versionId: 'foreign-version' })
    ).rejects.toMatchObject({ kind: 'unavailable' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
