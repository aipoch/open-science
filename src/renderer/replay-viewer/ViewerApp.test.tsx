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
import { createHash, webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunObservationSnapshot } from '../../shared/run-observation'
import type { RuntimeViewAccess } from '../../shared/runtime-view'
import { ViewerApp } from './ViewerApp'
import { ReplayViewerClient } from './client'
import { staticHtml } from './static-html'
import { ReferencePanel } from './ReferencePanel'
import { setI18nLocale } from '../src/i18n'
import type { ObservationViewerCapture } from '../../shared/run-observation-capture'
import { useViewerCaptures } from './use-viewer-captures'
const snapshot: RunObservationSnapshot = {
  identity: { projectId: 'p', sessionId: 's', operationId: 'op', runId: 'run' },
  cursor: { epoch: 'epoch', sequence: 1 },
  observedAt: 1000,
  phase: 'running',
  stepId: 'run:run',
  run: {
    runId: 'run',
    kernelKind: 'bash',
    status: 'running',
    startedAt: 500,
    logs: {
      stdout: { text: 'actual browser host output', truncated: false, redacted: false },
      stderr: { text: '', truncated: false, redacted: false },
      traceback: { text: '', truncated: false, redacted: false }
    }
  },
  artifacts: [],
  artifactsTruncated: false
}
const context = {
  viewerId: 'viewer',
  target: { projectId: 'p', sessionId: 's', operationId: 'op' },
  expiresAt: 10000,
  canInteract: false,
  canCancel: false,
  canReadArtifacts: false
}
const captureFixture = (captureId = 'frame'): ObservationViewerCapture => ({
  captureId,
  recordingId: 'recording',
  stepKey: 'durable-step',
  artifactId: 'image',
  versionId: `image-${captureId}`,
  checksum: 'a'.repeat(64),
  sizeBytes: 5,
  mimeType: 'image/png',
  publication: 'published',
  capture: {
    source: 'project-export',
    association: 'current-observation',
    startedAt: 1100,
    finishedAt: 1200,
    observedAt: snapshot.observedAt,
    width: 1,
    height: 1
  },
  viewerEvidence: {
    cursor: snapshot.cursor,
    observedAt: snapshot.observedAt,
    stepId: snapshot.stepId
  }
})
const projectAccess: RuntimeViewAccess = {
  url: `http://rv-view.localhost:1234/__open_science_view?grant=${'a'.repeat(64)}`,
  view: {
    viewId: 'view',
    scope: {
      projectId: 'p',
      sessionId: 's',
      runId: 'run',
      environmentId: 'env',
      generationId: 'generation'
    },
    title: 'Live project',
    state: 'ready',
    createdAt: '2026-10-06T00:00:00Z',
    expiresAt: '2026-10-06T01:00:00Z',
    embeddingAdapted: true
  }
}
const makeClient = (): ReplayViewerClient => {
  const client = new ReplayViewerClient()
  vi.spyOn(client, 'context').mockResolvedValue(context)
  vi.spyOn(client, 'history').mockResolvedValue({
    coverage: 'process-local',
    truncated: false,
    snapshots: [snapshot]
  })
  vi.spyOn(client, 'changes').mockResolvedValue({
    kind: 'delta',
    from: snapshot.cursor,
    cursor: snapshot.cursor,
    changes: []
  })
  vi.spyOn(client, 'selection').mockResolvedValue(null)
  vi.spyOn(client, 'recordingStatus').mockResolvedValue({
    target: context.target,
    state: 'not-recorded'
  })
  return client
}
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {
        /* fixed viewport */
      }
      unobserve(): void {
        /* fixed viewport */
      }
      disconnect(): void {
        /* fixed viewport */
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
  setI18nLocale('en')
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})
describe('standalone browser viewer', () => {
  it('keeps the selected second image and its evidence when the live process ends', async () => {
    const client = makeClient()
    vi.mocked(client.context).mockResolvedValue({
      ...context,
      canCapture: true,
      canReadArtifacts: true
    })
    vi.spyOn(client, 'captureOptions').mockResolvedValue({ hostView: false, projectExports: [] })
    vi.spyOn(client, 'captures').mockResolvedValue([
      captureFixture('first'),
      {
        ...captureFixture('second'),
        capture: { ...captureFixture().capture, startedAt: 1300, finishedAt: 1400 }
      }
    ])
    const image = vi
      .spyOn(client, 'captureImage')
      .mockResolvedValue('data:image/png;base64,cGl4ZWw=')
    const project = vi.spyOn(client, 'projectView')
    let ended = false
    const terminal: RunObservationSnapshot = {
      ...snapshot,
      cursor: { epoch: 'epoch', sequence: 2 },
      observedAt: 2000,
      phase: 'completed',
      run: { ...snapshot.run!, status: 'completed', endedAt: 1900 }
    }
    vi.mocked(client.changes).mockImplementation(async (previous) => ({
      kind: 'delta',
      from: previous.cursor,
      cursor: ended ? terminal.cursor : previous.cursor,
      changes: ended && previous.cursor.sequence < 2 ? [terminal] : []
    }))
    render(<ViewerApp client={client} />)
    await screen.findByText('actual browser host output')
    expect(screen.getByText('Run observation')).toBeTruthy()
    expect(screen.getByTestId('replay-panel').getAttribute('aria-label')).toBe('Run observation')
    expect(screen.queryByText('Research replay')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Pause following' }))
    fireEvent.click(screen.getByRole('button', { name: 'Project interface' }))
    await screen.findByRole('img', { name: 'Recorded project image' })
    fireEvent.click(screen.getByRole('button', { name: 'Next image' }))
    const secondImage = await screen.findByRole('img', { name: 'Recorded project image' })
    expect(screen.getByText('Recorded project image 2 of 2')).toBeTruthy()
    ended = true
    await screen.findByText('The live project page is closed.', {}, { timeout: 3000 })
    expect(await screen.findByRole('img', { name: 'Recorded project image' })).toBe(secondImage)
    expect(screen.getByText('Recorded project image 2 of 2')).toBeTruthy()
    expect(
      screen.getByText('Captured from 1970-01-01T00:00:01.300Z to 1970-01-01T00:00:01.400Z.')
    ).toBeTruthy()
    expect(screen.getByText('Source step: observation:epoch:1')).toBeTruthy()
    expect(screen.getByText('This is a recorded image, not a live project page.')).toBeTruthy()
    expect(screen.getByText('actual browser host output')).toBeTruthy()
    expect(screen.getByTestId('replay-live-record').dataset.observationRecord).toBe('epoch:1')
    expect(image.mock.calls.map(([frame]) => frame.captureId)).toEqual(['first', 'second'])
    expect(project).not.toHaveBeenCalled()
    expect(document.querySelector('iframe')).toBeNull()
  })

  it('applies the desktop language after an initial bootstrap context read failed', async () => {
    const client = makeClient()
    vi.mocked(client.context)
      .mockRejectedValueOnce(new Error('temporarily offline'))
      .mockResolvedValue({ ...context, presentation: 'desktop', locale: 'zh-Hans' })
    expect(await client.initialLocale('en')).toBe('en')
    render(<ViewerApp client={client} />)
    await screen.findAllByText('运行观察')
    expect(document.documentElement.lang).toBe('zh-Hans')
  })

  it.each(['browser', 'desktop'] as const)(
    'keeps step copying but shows manual conversation instructions only in the browser: %s',
    (presentation) => {
      render(<ReferencePanel reference='{"stepKey":"one"}' presentation={presentation} />)
      expect(screen.getByRole('button', { name: 'Copy step reference' })).toBeTruthy()
      const instructions = screen.queryByText(
        'Paste this reference into your conversation. Your agent can read the saved selection through the Open Science SDK.'
      )
      expect(Boolean(instructions)).toBe(presentation === 'browser')
    }
  )

  it('retries archive admission without reopening the completed project or losing the current evidence', async () => {
    const client = makeClient()
    const archive = {
      projectId: 'p',
      sessionId: 's',
      artifactId: 'archive',
      versionId: 'archive-v'
    }
    const terminal: RunObservationSnapshot = {
      ...snapshot,
      phase: 'completed',
      run: { ...snapshot.run!, status: 'completed', endedAt: 2000 }
    }
    vi.mocked(client.context).mockResolvedValue({ ...context, presentation: 'browser' })
    vi.mocked(client.history).mockResolvedValue({
      coverage: 'process-local',
      truncated: false,
      snapshots: [terminal]
    })
    vi.mocked(client.recordingStatus).mockResolvedValue({
      target: context.target,
      state: 'saved',
      archive
    })
    const url = `http://viewer-retry.localhost:12345/__open_science_viewer?grant=${'a'.repeat(64)}`
    const open = vi
      .spyOn(client, 'openArchive')
      .mockRejectedValueOnce(new Error('private failure'))
      .mockResolvedValue({
        mode: 'recorded',
        viewerId: 'retry',
        target: archive,
        expiresAt: 10000,
        url
      })
    const project = vi.spyOn(client, 'projectView'),
      navigate = vi.fn()
    render(<ViewerApp client={client} navigateToArchive={navigate} />)
    fireEvent.click(await screen.findByRole('button', { name: 'View archived replay' }))
    const retry = await screen.findByRole('button', { name: 'Retry' })
    expect(screen.queryByText('private failure')).toBeNull()
    expect(screen.getByText('actual browser host output')).toBeTruthy()
    expect(navigate).not.toHaveBeenCalled()
    fireEvent.click(retry)
    await waitFor(() => expect(navigate).toHaveBeenCalledExactlyOnceWith(url))
    expect(open.mock.calls).toEqual([[archive], [archive]])
    expect(project).not.toHaveBeenCalled()
  })

  it.each(['browser', 'desktop'] as const)(
    'offers the correct terminal archive handoff for %s without misreporting saved images',
    async (presentation) => {
      const client = makeClient()
      const terminal: RunObservationSnapshot = {
        ...snapshot,
        cursor: { ...snapshot.cursor, sequence: 2 },
        observedAt: 3000,
        phase: 'completed',
        run: { ...snapshot.run!, status: 'completed', endedAt: 2900 }
      }
      const archive = {
        projectId: 'p',
        sessionId: 's',
        artifactId: 'archive',
        versionId: 'archive-v'
      }
      vi.mocked(client.context).mockResolvedValue({
        ...context,
        presentation,
        canCapture: true,
        canReadArtifacts: true
      })
      vi.mocked(client.history).mockResolvedValue({
        coverage: 'process-local',
        truncated: false,
        snapshots: [snapshot, terminal]
      })
      vi.mocked(client.changes).mockResolvedValue({
        kind: 'delta',
        from: terminal.cursor,
        cursor: terminal.cursor,
        changes: []
      })
      vi.mocked(client.recordingStatus).mockResolvedValue({
        target: context.target,
        state: 'saved',
        archive
      })
      const url = `http://viewer-saved.localhost:12345/__open_science_viewer?grant=${'a'.repeat(64)}`
      const open = vi.spyOn(client, 'openArchive').mockResolvedValue({
        mode: 'recorded',
        viewerId: 'saved',
        target: archive,
        expiresAt: 10000,
        url
      })
      const capture = vi.spyOn(client, 'capture'),
        project = vi.spyOn(client, 'projectView'),
        navigate = vi.fn()
      render(<ViewerApp client={client} navigateToArchive={navigate} />)
      await screen.findByText('Observation archive saved')
      fireEvent.click(screen.getByRole('button', { name: 'Previous step' }))
      fireEvent.click(screen.getByRole('button', { name: 'Project interface' }))
      expect(screen.getByText('The live project page is closed.')).toBeTruthy()
      expect(screen.getByText('actual browser host output')).toBeTruthy()
      expect(
        screen.queryByText(
          'No project screen was recorded for this step. The current live page is not historical evidence.'
        )
      ).toBeNull()
      if (presentation === 'browser') {
        fireEvent.click(screen.getAllByRole('button', { name: 'View archived replay' })[0])
        await waitFor(() => expect(navigate).toHaveBeenCalledExactlyOnceWith(url))
        expect(open).toHaveBeenCalledExactlyOnceWith(archive)
      } else {
        expect(screen.queryByRole('button', { name: 'View archived replay' })).toBeNull()
        expect(open).not.toHaveBeenCalled()
        expect(navigate).not.toHaveBeenCalled()
      }
      expect(capture).not.toHaveBeenCalled()
      expect(project).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['saving', 'Saving observation archive…'],
    ['failed', 'Observation recording could not be saved. The Run status is separate.']
  ] as const)(
    'shows truthful terminal %s guidance instead of declaring the captured image absent',
    async (state, text) => {
      const client = makeClient()
      const terminal: RunObservationSnapshot = {
        ...snapshot,
        phase: 'completed',
        run: { ...snapshot.run!, status: 'completed', endedAt: 2000 }
      }
      vi.mocked(client.history).mockResolvedValue({
        coverage: 'process-local',
        truncated: false,
        snapshots: [terminal]
      })
      vi.mocked(client.recordingStatus).mockResolvedValue({ target: context.target, state })
      render(<ViewerApp client={client} />)
      await screen.findByText(text)
      fireEvent.click(screen.getByRole('button', { name: 'Project interface' }))
      expect(screen.getAllByText(text).length).toBeGreaterThan(0)
      expect(
        screen.queryByText(
          'No project screen was recorded for this step. The current live page is not historical evidence.'
        )
      ).toBeNull()
      expect(screen.queryByRole('button', { name: 'View archived replay' })).toBeNull()
    }
  )

  it('shows only images explicitly associated with the inspected viewer cursor and keeps multiple capture times distinct', async () => {
    const client = makeClient()
    vi.mocked(client.context).mockResolvedValue({
      ...context,
      canCapture: true,
      canReadArtifacts: true
    })
    vi.spyOn(client, 'captureOptions').mockResolvedValue({ hostView: false, projectExports: [] })
    const frame = {
      captureId: 'first',
      recordingId: 'recording',
      stepKey: 'different-durable-observer-step',
      artifactId: 'a',
      versionId: 'v',
      checksum: 'a'.repeat(64),
      sizeBytes: 5,
      mimeType: 'image/png' as const,
      publication: 'awaiting-publication' as const,
      capture: {
        source: 'project-export' as const,
        association: 'current-observation' as const,
        startedAt: 2000,
        finishedAt: 2100,
        observedAt: 900,
        width: 1,
        height: 1
      },
      viewerEvidence: {
        cursor: snapshot.cursor,
        observedAt: snapshot.observedAt,
        stepId: snapshot.stepId
      }
    }
    vi.spyOn(client, 'captures').mockResolvedValue([
      { ...frame, captureId: 'unassociated', viewerEvidence: undefined },
      {
        ...frame,
        captureId: 'wrong-epoch',
        viewerEvidence: {
          ...frame.viewerEvidence,
          cursor: { ...snapshot.cursor, epoch: 'durable-epoch' }
        }
      },
      frame,
      {
        ...frame,
        captureId: 'second',
        capture: { ...frame.capture, startedAt: 3000, finishedAt: 3100 }
      }
    ])
    const read = vi
      .spyOn(client, 'captureImage')
      .mockResolvedValue('data:image/png;base64,cGl4ZWw=')
    render(<ViewerApp client={client} />)
    await screen.findByText('actual browser host output')
    fireEvent.click(screen.getByRole('button', { name: 'Pause following' }))
    fireEvent.click(screen.getByRole('button', { name: 'Project interface' }))
    await screen.findByRole('img', { name: 'Recorded project image' })
    expect(screen.getByText('Recorded project image 1 of 2')).toBeTruthy()
    expect(
      screen.getByText('Captured from 1970-01-01T00:00:02.000Z to 1970-01-01T00:00:02.100Z.')
    ).toBeTruthy()
    expect(screen.getByText('This captured image is awaiting archive publication.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Next image' }))
    await screen.findByRole('img', { name: 'Recorded project image' })
    expect(
      screen.getByText('Captured from 1970-01-01T00:00:03.000Z to 1970-01-01T00:00:03.100Z.')
    ).toBeTruthy()
    expect(read.mock.calls.map(([capture]) => capture.captureId)).toEqual(['first', 'second'])
    expect(document.querySelector('iframe')).toBeNull()
  })
  it('keeps capture controls out of inspect and history instead of capturing an apparent past frame', async () => {
    const client = makeClient()
    vi.mocked(client.context).mockResolvedValue({ ...context, canCapture: true })
    vi.spyOn(client, 'captureOptions').mockResolvedValue({
      hostView: false,
      projectExports: ['frame']
    })
    const capture = vi.spyOn(client, 'capture')
    render(<ViewerApp client={client} />)
    await screen.findByRole('button', { name: 'Save project image: frame' })
    fireEvent.click(screen.getByRole('button', { name: 'Pause following' }))
    expect(screen.queryByRole('button', { name: 'Save project image: frame' })).toBeNull()
    expect(capture).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Back to live' }))
    await screen.findByRole('button', { name: 'Save project image: frame' })
    expect(capture).not.toHaveBeenCalled()
  })
  it('shows actual evidence without a preload bridge and does not turn read access into project interaction or stopping', async () => {
    const client = makeClient(),
      project = vi.spyOn(client, 'projectView'),
      cancel = vi.spyOn(client, 'cancel')
    render(<ViewerApp client={client} />)
    await screen.findByText('actual browser host output')
    expect(screen.queryByRole('button', { name: 'Open project interface' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Stop run' })).toBeNull()
    expect(screen.getByText('Project interaction is not enabled for this viewer.')).toBeTruthy()
    expect(project).not.toHaveBeenCalled()
    expect(cancel).not.toHaveBeenCalled()
  })
  it('captures an exact selection and offers a copyable SDK reference without messaging an unknown parent', async () => {
    const client = makeClient(),
      selected = {
        selectionId: 'selection',
        identity: snapshot.identity,
        cursor: snapshot.cursor,
        stepId: snapshot.stepId,
        selectedAt: 2000,
        snapshot
      }
    const select = vi.spyOn(client, 'select').mockResolvedValue(selected),
      notify = vi.spyOn(window, 'postMessage')
    const captured = vi.fn()
    render(<ViewerApp client={client} onSelectionCaptured={captured} />)
    await screen.findByText('actual browser host output')
    fireEvent.click(screen.getByRole('button', { name: 'Ask about this step' }))
    const reference = await screen.findByRole('textbox', { name: 'Recorded step reference' })
    expect(JSON.parse((reference as HTMLTextAreaElement).value)).toMatchObject({
      viewerId: 'viewer',
      selectionId: 'selection',
      runId: 'run'
    })
    expect(select).toHaveBeenCalledWith(snapshot)
    expect(captured).toHaveBeenCalledWith(selected)
    expect(notify).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Discuss the entire research' })).toBeNull()
  })
  it('opens the authorized project exactly on a click and reveals the common Replay project pane', async () => {
    const client = makeClient()
    vi.mocked(client.context).mockResolvedValue({ ...context, canInteract: true })
    const open = vi.spyOn(client, 'projectView').mockResolvedValue(projectAccess)
    render(<ViewerApp client={client} />)
    await screen.findByText('actual browser host output')
    expect(open).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Project interface' }))
    const frame = await screen.findByTitle('Live project')
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-forms allow-same-origin')
    expect(open).toHaveBeenCalledTimes(1)
    expect(
      screen.getByRole('button', { name: 'Project interface' }).getAttribute('aria-pressed')
    ).toBe('true')
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Reopen project interface' })).toHaveProperty(
        'disabled',
        false
      )
    )
    fireEvent.click(screen.getByRole('button', { name: 'Execution record' }))
    fireEvent.click(screen.getByRole('button', { name: 'Project interface' }))
    expect(screen.getByTitle('Live project')).toBe(frame)
    expect(open).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Reopen project interface' }))
    await waitFor(() => expect(open).toHaveBeenCalledTimes(2))
  })
  it('deduplicates pending project-tab activation and distinguishes opening from unavailable', async () => {
    const client = makeClient()
    vi.mocked(client.context).mockResolvedValue({ ...context, canInteract: true })
    const open = vi.spyOn(client, 'projectView').mockReturnValue(new Promise(() => undefined))
    render(<ViewerApp client={client} />)
    await screen.findByText('actual browser host output')
    const toggle = screen.getByRole('button', { name: 'Project interface' })
    fireEvent.click(toggle)
    fireEvent.click(toggle)
    expect(open).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Opening project interface…')).toBeTruthy()
    expect(
      screen.queryByText('The project interface is not available for this run yet.')
    ).toBeNull()
  })
  it('retries a failed project activation from the same project tab', async () => {
    const client = makeClient()
    vi.mocked(client.context).mockResolvedValue({ ...context, canInteract: true })
    const open = vi
      .spyOn(client, 'projectView')
      .mockRejectedValueOnce(new Error('service not ready'))
      .mockResolvedValue(projectAccess)
    render(<ViewerApp client={client} />)
    await screen.findByText('actual browser host output')
    const toggle = screen.getByRole('button', { name: 'Project interface' })
    fireEvent.click(toggle)
    await screen.findByText('Could not open the project interface.')
    fireEvent.click(toggle)
    await screen.findByTitle('Live project')
    expect(open).toHaveBeenCalledTimes(2)
  })
  it.each(['readonly', 'inspection', 'completed'] as const)(
    'does not request a live lease from the project tab when %s',
    async (mode) => {
      const client = makeClient()
      vi.mocked(client.context).mockResolvedValue({ ...context, canInteract: mode !== 'readonly' })
      if (mode === 'completed')
        vi.mocked(client.history).mockResolvedValue({
          coverage: 'process-local',
          truncated: false,
          snapshots: [
            { ...snapshot, phase: 'completed', run: { ...snapshot.run!, status: 'completed' } }
          ]
        })
      const open = vi.spyOn(client, 'projectView').mockResolvedValue(projectAccess)
      render(<ViewerApp client={client} />)
      await screen.findByText('actual browser host output')
      if (mode === 'inspection')
        fireEvent.click(screen.getByRole('button', { name: 'Pause following' }))
      fireEvent.click(screen.getByRole('button', { name: 'Project interface' }))
      expect(open).not.toHaveBeenCalled()
    }
  )
  it('static HTML retains saved content while removing scripts, external URLs, navigation and forms actions', () => {
    const html = staticHtml(
      '<meta http-equiv="refresh" content="0;url=https://elsewhere.test"><script>steal()</script><iframe src="http://localhost"></iframe><a href="https://example.com" onclick="steal()">Result</a><img src="https://tracker.test/pixel"><form action="http://localhost"><button>submit</button></form><p>Saved result</p>'
    )
    expect(html).toContain('Saved result')
    expect(html).toContain('Result')
    expect(html).toContain("default-src 'none'")
    expect(html).not.toContain('steal')
    expect(html).not.toContain('refresh')
    expect(html).not.toContain('https://')
    expect(html).not.toContain('<iframe')
    expect(html).not.toContain('action=')
  })
})

describe('viewer-local retained capture images', () => {
  it('retains only exact checksum-validated bytes and does not fetch uncached images after completion', async () => {
    vi.stubGlobal('crypto', webcrypto)
    const bytes = Buffer.from('verified image bytes')
    const frame = {
      ...captureFixture(),
      sizeBytes: bytes.byteLength,
      checksum: createHash('sha256').update(bytes).digest('hex')
    }
    const corrupt = { ...frame, captureId: 'corrupt', checksum: 'b'.repeat(64) }
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(bytes))
    const client = new ReplayViewerClient(fetcher)
    vi.spyOn(client, 'captures').mockResolvedValue([frame, corrupt])
    const { result, rerender } = renderHook(({ active }) => useViewerCaptures(client, active), {
      initialProps: { active: true }
    })
    await waitFor(() => expect(result.current.captures).toHaveLength(2))
    await expect(result.current.readImage('frame')).resolves.toBe(
      `data:image/png;base64,${bytes.toString('base64')}`
    )
    await expect(result.current.readImage('corrupt')).resolves.toBeNull()
    rerender({ active: false })
    await expect(result.current.readImage('frame')).resolves.toBe(
      `data:image/png;base64,${bytes.toString('base64')}`
    )
    await expect(result.current.readImage('corrupt')).resolves.toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('keeps at most four opened images, with no retention across viewer clients', async () => {
    const client = makeClient()
    vi.spyOn(client, 'captures').mockResolvedValue(
      Array.from({ length: 5 }, (_, i) => captureFixture(`image-${i}`))
    )
    const read = vi
      .spyOn(client, 'captureImage')
      .mockResolvedValue('data:image/png;base64,cGl4ZWw=')
    const { result, rerender } = renderHook(
      ({ client, active }) => useViewerCaptures(client, active),
      { initialProps: { client, active: true } }
    )
    await waitFor(() => expect(result.current.captures).toHaveLength(5))
    for (let i = 0; i < 5; i++) await result.current.readImage(`image-${i}`)
    rerender({ client, active: false })
    await expect(result.current.readImage('image-0')).resolves.toBeNull()
    await expect(result.current.readImage('image-1')).resolves.not.toBeNull()
    expect(read).toHaveBeenCalledTimes(5)
    rerender({ client: makeClient(), active: false })
    expect(result.current.captures).toHaveLength(0)
    await expect(result.current.readImage('image-1')).resolves.toBeNull()
  })

  it('does not retain an image larger than the eight MiB string budget', async () => {
    const client = makeClient()
    vi.spyOn(client, 'captures').mockResolvedValue([captureFixture()])
    const src = `data:image/png;base64,${'A'.repeat(4 * 1024 * 1024)}`
    const read = vi.spyOn(client, 'captureImage').mockResolvedValue(src)
    const { result, rerender } = renderHook(({ active }) => useViewerCaptures(client, active), {
      initialProps: { active: true }
    })
    await waitFor(() => expect(result.current.captures).toHaveLength(1))
    await expect(result.current.readImage('frame')).resolves.toBe(src)
    rerender({ active: false })
    await expect(result.current.readImage('frame')).resolves.toBeNull()
    expect(read).toHaveBeenCalledOnce()
  })

  it('keeps the cached frame association when Main clears captures before the terminal observation', async () => {
    vi.useFakeTimers()
    const client = makeClient()
    vi.spyOn(client, 'captures').mockResolvedValueOnce([captureFixture()]).mockResolvedValue([])
    vi.spyOn(client, 'captureImage').mockResolvedValue('data:image/png;base64,cGl4ZWw=')
    const { result, rerender } = renderHook(({ active }) => useViewerCaptures(client, active), {
      initialProps: { active: true }
    })
    await act(async () => undefined)
    expect(result.current.captures).toHaveLength(1)
    await result.current.readImage('frame')
    await act(async () => vi.advanceTimersByTimeAsync(1500))
    expect(result.current.captures).toHaveLength(1)
    rerender({ active: false })
    await expect(result.current.readImage('frame')).resolves.not.toBeNull()
  })
})
it.each(['collecting', 'completed'] as const)(
  'uses execution publication phase, rather than the finished Notebook Run, to gate web playback: %s',
  async (phase) => {
    const client = makeClient()
    vi.mocked(client.context).mockResolvedValue({
      ...context,
      presentation: 'browser',
      canRecord: true
    })
    vi.mocked(client.history).mockResolvedValue({
      coverage: 'process-local',
      truncated: false,
      snapshots: [{ ...snapshot, phase, run: { ...snapshot.run!, status: 'completed' } }]
    })
    vi.spyOn(client, 'inspectBrowserRecording').mockResolvedValue({
      supported: false,
      active: {
        state: 'finalized',
        recordingId: 'saved',
        elapsedMs: 1200,
        segments: 1,
        bytes: 20,
        droppedFrames: 0,
        target: {
          projectId: 'p',
          sessionId: 's',
          artifactId: 'saved-index',
          versionId: 'saved-version'
        }
      }
    })
    render(<ViewerApp client={client} />)
    const button = await screen.findByRole('button', { name: 'View recording' })
    expect(button.hasAttribute('disabled')).toBe(phase === 'collecting')
    expect(
      Boolean(
        screen.queryByText('Recording saved. Playback will be available when this run finishes.')
      )
    ).toBe(phase === 'collecting')
  }
)
