// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  validateRunObservationArchive,
  type RunObservationArchive
} from '../../../../shared/run-observation-archive'
import { RecordedRunObservationPreview } from './RecordedRunObservationPreview'
import * as recordedProjection from '@/lib/replay/recorded-observation'
const receiving = {
  projectId: 'receiver-project',
  sessionId: 'receiver-session',
  artifactId: 'recording-artifact',
  versionId: 'recording-version'
}
const fixture = (): RunObservationArchive =>
  validateRunObservationArchive({
    format: 'open-science-run-observation',
    version: 1,
    recordingId: 'recording',
    capturedAt: 300,
    coverage: {
      kind: 'sampled-observations',
      includesPreObservationHistory: false,
      firstObservedAt: 100,
      lastObservedAt: 200,
      droppedEarlierObservations: false,
      terminalRunObserved: false,
      stopReason: 'manual',
      logTruncation: false,
      redactedContent: false,
      missingMediaKeys: ['missing-screen']
    },
    records: [0, 1].map((sequence) => ({
      stepKey: `step-${sequence}`,
      observedAt: sequence ? 200 : 100,
      phase: 'running',
      sourceEvidence: {
        identity: { projectId: 'sender-project', sessionId: 'sender-session', runId: 'sender-run' },
        cursor: { epoch: 'sender-epoch', sequence },
        stepId: 'run:sender-run'
      },
      run: {
        kernelKind: 'bash',
        status: 'running',
        startedAt: 90,
        logs: {
          stdout: {
            text: sequence ? 'second archived output' : 'first archived output',
            truncated: false,
            redacted: false
          },
          stderr: { text: '', truncated: false, redacted: false },
          traceback: { text: '', truncated: false, redacted: false }
        }
      },
      artifactEvidence: [],
      artifactsTruncated: false
    })),
    media: []
  })
const attachmentFixture = (): {
  archive: RunObservationArchive
  media: recordedProjection.ResolvedObservationMedia[]
} => {
  const archive = fixture()
  archive.media = [
    {
      mediaKey: 'result',
      name: 'result.json',
      mimeType: 'application/json',
      checksum: 'b'.repeat(64),
      sizeBytes: 16,
      stepKeys: []
    },
    {
      mediaKey: 'step-result',
      name: 'step-result.json',
      mimeType: 'application/json',
      checksum: 'c'.repeat(64),
      sizeBytes: 16,
      stepKeys: ['step-1']
    },
    {
      mediaKey: 'unlinked-capture',
      name: 'capture.png',
      mimeType: 'image/png',
      checksum: 'd'.repeat(64),
      sizeBytes: 16,
      stepKeys: [],
      capture: {
        source: 'host-view',
        association: 'current-observation',
        startedAt: 210,
        finishedAt: 220,
        observedAt: 200,
        width: 1,
        height: 1
      }
    }
  ]
  return {
    archive: validateRunObservationArchive(archive),
    media: archive.media.map((entry) => ({
      mediaKey: entry.mediaKey,
      artifactId: `receiver-${entry.mediaKey}`,
      versionId: `receiver-${entry.mediaKey}-v1`,
      checksum: entry.checksum,
      sizeBytes: entry.sizeBytes
    }))
  }
}
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
describe('recorded Run observation preview', () => {
  const showMaterial = (name: string): void => {
    const toggle = screen.getByRole('button', { name: 'Research materials' })
    if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle)
    fireEvent.click(screen.getByRole('button', { name }))
  }
  it.each(['Project replay', 'Results'])(
    'selects the %s tab on its first pointer click without pausing the current view',
    (label) => {
      const { archive, media } = attachmentFixture()
      render(
        <RecordedRunObservationPreview
          archive={archive}
          receiving={receiving}
          media={media}
          title="Recorded experiment"
          readResource={vi.fn(async () => ({ status: 'unavailable' as const }))}
          onAskArchiveSelection={vi.fn()}
        />
      )
      fireEvent.click(screen.getByRole('button', { name: /^Research materials$/ }))
      const tab = screen.getByRole('button', { name: new RegExp(`^${label}$`) })
      const status = screen.getByTestId('replay-live-status')
      expect(status.textContent).toContain('Run history')
      fireEvent.pointerDown(tab)
      expect(screen.queryByText('Inspecting recorded evidence')).toBeNull()
      expect(tab.getAttribute('aria-pressed')).toBe('false')
      fireEvent.pointerUp(tab)
      fireEvent.click(tab)
      expect(tab.getAttribute('aria-pressed')).toBe('true')
      expect(screen.getByRole('button', { name: /^Notebook$/ }).getAttribute('aria-pressed')).toBe(
        'false'
      )
      expect(screen.getByTestId('replay-live-status')).toBe(status)
      expect(status.textContent).toContain('Run history')
      expect(screen.queryByText('Inspecting recorded evidence')).toBeNull()
      expect(screen.queryByRole('button', { name: 'Show latest record' })).toBeNull()
      if (label === 'Results')
        expect(screen.getByRole('button', { name: /^result.json/ })).toBeTruthy()
      else expect(screen.getByRole('region', { name: 'Project replay' })).toBeTruthy()
    }
  )
  it('keeps results independent of frame and Notebook selection, with exact file-level Ask', async () => {
    const { archive, media } = attachmentFixture(),
      ask = vi.fn(),
      askFile = vi.fn()
    const readRawResource = vi.fn(async () => ({
      content: '{"score":4}',
      mimeType: 'application/json',
      truncated: false
    }))
    render(
      <RecordedRunObservationPreview
        archive={archive}
        receiving={receiving}
        media={media}
        title="Recorded experiment"
        readResource={vi.fn(async () => ({ status: 'unavailable' as const }))}
        readRawResource={readRawResource}
        onAskArchiveSelection={ask}
        onAskArchiveFile={askFile}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Previous step' }))
    const replay = screen.getByTestId('recorded-replay-view')
    showMaterial('Results')
    fireEvent.click(screen.getByRole('button', { name: /^result.json/ }))
    await screen.findByText('{"score":4}')
    fireEvent.click(screen.getByRole('button', { name: 'Ask about this file' }))
    expect(askFile.mock.calls[0][0]).toMatchObject({
      kind: 'recorded-observation-file',
      scope: 'recording',
      stepKeys: [],
      resource: { versionId: 'receiver-result-v1' }
    })
    expect(askFile.mock.calls[0][0]).not.toHaveProperty('stepKey')
    fireEvent.click(screen.getByRole('button', { name: 'Close research materials' }))
    expect(screen.getByTestId('recorded-replay-view')).toBe(replay)
    expect(screen.getByText('first archived output')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Ask about this step' }))
    expect(ask.mock.calls[0][0].stepKey).toBe('step-0')
  })
  it('does not offer or read files whose receiving authorization is missing', () => {
    const { archive } = attachmentFixture(),
      read = vi.fn()
    render(
      <RecordedRunObservationPreview
        archive={archive}
        receiving={receiving}
        media={[]}
        title="Recorded experiment"
        readResource={read}
        readRawResource={read}
        onAskArchiveSelection={vi.fn()}
      />
    )
    showMaterial('Results')
    expect(screen.getByText('No recorded results are available.')).toBeTruthy()
    expect(read).not.toHaveBeenCalled()
  })
  it('shows the saved Run outcome without presenting archive publication as ongoing work', () => {
    const archive = fixture()
    archive.records[1].phase = 'collecting'
    archive.records[1].run!.status = 'completed'
    const ask = vi.fn()
    render(
      <RecordedRunObservationPreview
        archive={archive}
        receiving={receiving}
        media={[]}
        title="Archived run"
        readResource={vi.fn()}
        onAskArchiveSelection={ask}
      />
    )
    expect(screen.getByText('Recorded run: Completed')).toBeTruthy()
    expect(screen.getByTestId('observation-phase').textContent).toBe('Completed')
    expect(screen.queryByText('Saving results')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Ask about this step' }))
    expect(ask.mock.calls[0][0].record).toMatchObject({
      phase: 'collecting',
      run: { status: 'completed' }
    })
  })
  it('shows a saved capture in its exact archive step with actual capture time and no live page', async () => {
    const archive = fixture()
    archive.media = [
      {
        mediaKey: 'screen',
        name: 'screen.png',
        mimeType: 'image/png',
        checksum: 'a'.repeat(64),
        sizeBytes: 5,
        stepKeys: ['step-1'],
        capture: {
          source: 'host-view',
          association: 'current-observation',
          startedAt: 180,
          finishedAt: 190,
          observedAt: 100,
          width: 1,
          height: 1
        }
      }
    ]
    const read = vi.fn().mockResolvedValue({
      status: 'ready',
      kind: 'image',
      content: 'data:image/png;base64,cGl4ZWw=',
      mimeType: 'image/png',
      truncated: false
    })
    render(
      <RecordedRunObservationPreview
        archive={validateRunObservationArchive(archive)}
        receiving={receiving}
        media={[
          {
            mediaKey: 'screen',
            artifactId: 'screen',
            versionId: 'screen-v1',
            checksum: 'a'.repeat(64),
            sizeBytes: 5
          }
        ]}
        title="Recorded experiment"
        readResource={read}
        onAskArchiveSelection={vi.fn()}
      />
    )
    showMaterial('Project replay')
    const capturedImage = await screen.findByRole('img', { name: 'Recorded project image' })
    fireEvent.load(capturedImage)
    expect(screen.getByText('1970-01-01T00:00:00.190Z')).toBeTruthy()
    expect(document.querySelector('iframe')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Previous step' }))
    expect(screen.queryByRole('img', { name: 'Recorded project image' })).toBeNull()
    expect(screen.getByText('No project image was recorded at this time.')).toBeTruthy()
  })
  it.each([
    [
      'snapshots',
      'Recording stopped at the observation count limit. Earlier records are preserved; later activity was not recorded.'
    ],
    [
      'record-bytes',
      'Recording stopped at this recording’s size limit. Earlier records are preserved; later activity was not recorded.'
    ],
    [
      'global-bytes',
      'Recording stopped at the total recording storage limit. Earlier records are preserved; later activity was not recorded.'
    ]
  ] as const)(
    'explains %s capacity without declaring that the experiment stopped',
    (capacityLimit, message) => {
      const source = fixture()
      const archive = validateRunObservationArchive({
        ...source,
        coverage: { ...source.coverage, stopReason: 'capacity', capacityLimit }
      })
      render(
        <RecordedRunObservationPreview
          archive={archive}
          receiving={receiving}
          media={[]}
          title="Archive"
          readResource={vi.fn()}
          onAskArchiveSelection={vi.fn()}
        />
      )
      expect(screen.getByText(message)).toBeTruthy()
      expect(screen.getByText('Recorded run: Running')).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Stop run' })).toBeNull()
    }
  )
  it('shows original provenance and coverage without connecting a local Run or enabling live controls', () => {
    const read = vi.fn(),
      ask = vi.fn()
    render(
      <RecordedRunObservationPreview
        archive={fixture()}
        receiving={receiving}
        media={[]}
        title="Recorded experiment"
        readResource={read}
        onAskArchiveSelection={ask}
      />
    )
    expect(screen.getByText('sender-project')).toBeTruthy()
    expect(screen.getByText('sender-session')).toBeTruthy()
    expect(screen.getByText('sender-run')).toBeTruthy()
    expect(
      screen.getByText('This recording has gaps or ended before the Run finished.')
    ).toBeTruthy()
    expect(
      screen.getByText('Some recorded media could not be resolved on this device.')
    ).toBeTruthy()
    expect(screen.getByText('Recorded run: Running')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Stop run' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Pause following' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Back to live' })).toBeNull()
    showMaterial('Project replay')
    expect(
      screen.getByText(
        'No project images were recorded. Other research materials remain available.'
      )
    ).toBeTruthy()
    expect(document.querySelector('iframe')).toBeNull()
    expect(read).not.toHaveBeenCalled()
  })
  it('navigates archive steps and asks with frozen source evidence and receiver recording Version', () => {
    const ask = vi.fn(),
      archive = fixture()
    render(
      <RecordedRunObservationPreview
        archive={archive}
        receiving={receiving}
        media={[]}
        title="Recorded experiment"
        readResource={vi.fn()}
        onAskArchiveSelection={ask}
      />
    )
    expect(screen.getByText('second archived output')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Previous step' }))
    expect(screen.getByText('first archived output')).toBeTruthy()
    expect(screen.queryByText('second archived output')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Ask about this step' }))
    expect(ask).toHaveBeenCalledTimes(1)
    const selection = ask.mock.calls[0][0]
    expect(selection).toMatchObject({
      receiving,
      recordingId: 'recording',
      stepKey: 'step-0',
      record: { sourceEvidence: { identity: { runId: 'sender-run' } } }
    })
    expect(selection.record.run.logs.stdout.text).toBe('first archived output')
    expect(Object.isFrozen(selection.record)).toBe(true)
  })
  it('rejects unrecognized media mappings before invoking any receiver reader', () => {
    const read = vi.fn()
    render(
      <RecordedRunObservationPreview
        archive={fixture()}
        receiving={receiving}
        media={[
          {
            mediaKey: 'invented',
            artifactId: 'a',
            versionId: 'v',
            checksum: 'a'.repeat(64),
            sizeBytes: 5
          }
        ]}
        title="Recorded experiment"
        readResource={read}
        onAskArchiveSelection={vi.fn()}
      />
    )
    expect(screen.getByText('The recorded evidence is unavailable.')).toBeTruthy()
    expect(read).not.toHaveBeenCalled()
  })
  it('does not rebuild a recording or move the selected step when a host recreates the same receiving identity', () => {
    const project = vi.spyOn(recordedProjection, 'projectRecordedObservation')
    const props = {
      archive: fixture(),
      receiving,
      media: [],
      title: 'Recorded experiment',
      readResource: vi.fn(),
      onAskArchiveSelection: vi.fn()
    }
    const view = render(<RecordedRunObservationPreview {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Previous step' }))
    const node = screen.getByTestId('recorded-replay-view')
    view.rerender(<RecordedRunObservationPreview {...props} receiving={{ ...receiving }} />)
    expect(project).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('recorded-replay-view')).toBe(node)
    expect(screen.getByText('first archived output')).toBeTruthy()
  })
})
