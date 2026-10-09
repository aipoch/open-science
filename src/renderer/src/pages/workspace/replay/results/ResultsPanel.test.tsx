// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ResultsPanel, type ReplayResultEntry } from './ResultsPanel'
import { ReplayMaterialActionProvider, type ReplayMaterialAction } from '../replay-material-action'
import { RecordedResourcePreview } from './RecordedResourcePreview'
import { createArtifactVersionLocator } from '../../../../../../shared/artifact-provenance'
import { readRecordedResource } from './recorded-resource-reader'
const entry = (name = 'final-result.html'): ReplayResultEntry => ({
  source: { kind: 'project-recording', id: 'recording' },
  scope: { kind: 'recording' },
  stage: 'unspecified',
  mediaKey: 'report',
  resource: {
    source: 'artifact',
    id: 'file-v1',
    name,
    projectId: 'p',
    sessionId: 's',
    artifactId: 'file',
    versionId: 'file-v1',
    availability: 'recorded',
    locator: createArtifactVersionLocator({
      projectId: 'p',
      appSessionId: 's',
      artifactId: 'file',
      versionId: 'file-v1'
    }),
    mimeType: 'text/html',
    checksum: 'a'.repeat(64),
    size: 10
  }
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
describe('independent immutable Results', () => {
  it('opens static HTML without a Notebook or project page and asks about the exact file, not a step', async () => {
    const selected = entry()
    const read = vi.fn().mockResolvedValue({
      content:
        '<h1>Saved report</h1><script>fetch("https://evil.test")</script><a href="https://evil.test">Link</a>',
      mimeType: 'text/html',
      truncated: false
    })
    const ask = vi.fn()
    render(<ResultsPanel entries={[selected]} read={read} onAskFile={ask} />)
    expect(read).not.toHaveBeenCalled()
    expect(screen.getByText(/Stage not specified/)).toBeTruthy()
    expect(screen.queryByText('Final result')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /final-result.html/ }))
    const frame = await screen.findByTitle('final-result.html')
    expect(frame.getAttribute('sandbox')).toBe('')
    expect(frame.getAttribute('src')).toBeNull()
    expect(frame.getAttribute('srcdoc')).toContain('Saved report')
    expect(frame.getAttribute('srcdoc')).toContain("default-src 'none'")
    expect(frame.getAttribute('srcdoc')).not.toMatch(/<script|https:\/\/evil/)
    fireEvent.click(screen.getByRole('button', { name: 'Ask about this file' }))
    expect(ask).toHaveBeenCalledExactlyOnceWith(selected)
    expect(ask.mock.calls[0][0]).not.toHaveProperty('stepId')
    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({ versionId: 'file-v1' }),
      expect.any(AbortSignal)
    )
  })
  it('cannot read unavailable versions or a locator that contradicts the declared scope', () => {
    const a = entry(),
      b = entry('wrong-scope.html')
    a.resource.availability = 'unavailable'
    b.resource.locator = createArtifactVersionLocator({
      projectId: 'other',
      appSessionId: 's',
      artifactId: 'file',
      versionId: 'file-v1'
    })
    const read = vi.fn()
    render(<ResultsPanel entries={[a, b]} read={read} />)
    expect(screen.getByText('No recorded results are available.')).toBeTruthy()
    expect(read).not.toHaveBeenCalled()
  })
  it('only labels stages explicitly and preserves JSON/CSV as inert readable text', async () => {
    const selected = { ...entry('measurements.csv'), stage: 'intermediate' as const }
    selected.resource.mimeType = 'text/csv'
    const read = vi
      .fn()
      .mockResolvedValue({ content: 'trial,score\n1,9', mimeType: 'text/csv', truncated: true })
    render(<ResultsPanel entries={[selected]} read={read} />)
    fireEvent.click(screen.getByRole('button', { name: /measurements.csv/ }))
    expect(await screen.findByText('trial,score 1,9')).toBeTruthy()
    expect(screen.getByText(/Intermediate result/)).toBeTruthy()
    expect(
      screen.getByText('Preview is truncated. Open the evidence for the complete file.')
    ).toBeTruthy()
  })
  it('ignores old bytes after the selected immutable Version changes', async () => {
    let finish!: (result: { content: string; mimeType: string; truncated: boolean }) => void
    const read = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve
          })
      )
      .mockResolvedValue({ content: 'new content', mimeType: 'text/plain', truncated: false })
    const first = entry('one.txt').resource,
      second = {
        ...entry('two.txt').resource,
        id: 'two',
        versionId: 'two-v1',
        locator: createArtifactVersionLocator({
          projectId: 'p',
          appSessionId: 's',
          artifactId: 'file',
          versionId: 'two-v1'
        })
      }
    const view = render(<RecordedResourcePreview resource={first} read={read} />)
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1))
    view.rerender(<RecordedResourcePreview resource={second} read={read} />)
    await screen.findByText('new content')
    await act(async () =>
      finish({ content: 'stale content', mimeType: 'text/plain', truncated: false })
    )
    expect(screen.queryByText('stale content')).toBeNull()
    expect(read.mock.calls[0][1].aborted).toBe(true)
  })
  it('uses only the exact desktop Version reader and refuses mutable paths before IPC', async () => {
    const readPreview = vi
      .fn()
      .mockResolvedValue({ content: '<h1>old</h1>', encoding: 'utf8', truncated: false, size: 12 })
    vi.stubGlobal('api', { artifacts: { readPreview }, uploads: { readPreview: vi.fn() } })
    await expect(readRecordedResource(entry().resource)).resolves.toMatchObject({
      content: '<h1>old</h1>'
    })
    expect(readPreview).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ versionId: 'file-v1', fileId: 'file', maxBytes: 192 * 1024 })
    )
    await expect(
      readRecordedResource({ ...entry().resource, locator: '/mutable/latest.html' })
    ).rejects.toThrow()
    expect(readPreview).toHaveBeenCalledTimes(1)
  })
})

describe('result publication times', () => {
  it('shows known results as of the playhead and explicitly offers later and unknown results', () => {
    const early = { ...entry('early.html'), availableAt: 100 }
    const later = { ...entry('later.html'), availableAt: 300 }
    const unknown = entry('unknown.html')
    const read = vi.fn()
    const view = render(
      <ResultsPanel entries={[early, later, unknown]} recordedAt={200} read={read} />
    )
    expect(screen.getByRole('button', { name: /early.html/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /later.html/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /unknown.html/ })).toBeNull()
    expect(screen.getByText(/Some results have no saved publication time/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'All saved results' }))
    expect(screen.getByRole('button', { name: /later.html/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /unknown.html/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Available at this moment' }))
    view.rerender(<ResultsPanel entries={[early, later, unknown]} recordedAt={50} read={read} />)
    expect(screen.queryByRole('button', { name: /early.html/ })).toBeNull()
    expect(read).not.toHaveBeenCalled()
  })
  it('keeps supporting media files separate without inferring a final result', () => {
    render(<ResultsPanel entries={[{ ...entry('clip.webm'), technical: true }]} read={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /clip.webm/ })).toBeNull()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show technical attachments' }))
    expect(screen.getByRole('button', { name: /clip.webm/ })).toBeTruthy()
    expect(screen.queryByText('Final result')).toBeNull()
  })
})

describe('compact research Results', () => {
  it('keeps current/all/unknown publication rules while moving immutable metadata into details', async () => {
    const known = { ...entry('early.txt'), availableAt: 100 },
      unknown = entry('unknown.txt')
    const read = vi
      .fn()
      .mockResolvedValue({ content: 'Saved result', mimeType: 'text/plain', truncated: false })
    render(
      <ResultsPanel
        presentationMode="research"
        entries={[known, unknown]}
        recordedAt={200}
        read={read}
      />
    )
    expect(screen.getByRole('combobox', { name: 'Result visibility' })).toHaveProperty(
      'value',
      'current'
    )
    expect(screen.queryByRole('button', { name: /unknown.txt/ })).toBeNull()
    expect(screen.getByText(/Some results have no saved publication time/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'early.txt' }))
    await screen.findByText('Saved result')
    const details = screen.getByText('Result details').closest('details')!
    expect(details.open).toBe(false)
    expect(details.textContent).toContain('file-v1')
    expect(details.textContent).toContain('Project recording')
    expect(details.textContent).toContain('Stage not specified')
    fireEvent.change(screen.getByRole('combobox', { name: 'Result visibility' }), {
      target: { value: 'all' }
    })
    expect(screen.getByRole('button', { name: 'unknown.txt' })).toBeTruthy()
    expect(
      screen.getByText('Showing results from the entire research, including later records.')
    ).toBeTruthy()
  })
  it('registers the exact selected file once for the shared footer and clears inactive actions', async () => {
    const selected = entry('report.txt'),
      ask = vi.fn(),
      changed = vi.fn<(action: ReplayMaterialAction | undefined) => void>()
    const read = vi
      .fn()
      .mockResolvedValue({ content: 'Report', mimeType: 'text/plain', truncated: false })
    const view = render(
      <ReplayMaterialActionProvider onActionChange={changed}>
        <ResultsPanel entries={[selected]} read={read} onAskFile={ask} />
      </ReplayMaterialActionProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: 'report.txt' }))
    await screen.findByText('Report')
    expect(screen.queryByRole('button', { name: 'Ask about this file' })).toBeNull()
    const action = changed.mock.calls.at(-1)![0]!
    expect(action.label).toBe('Ask about this file')
    await act(async () => action.onAsk())
    expect(ask).toHaveBeenCalledExactlyOnceWith(selected)
    view.rerender(
      <ReplayMaterialActionProvider onActionChange={changed}>
        <ResultsPanel entries={[selected]} active={false} read={read} onAskFile={ask} />
      </ReplayMaterialActionProvider>
    )
    expect(changed).toHaveBeenLastCalledWith(undefined)
    // Even a stale footer callback cannot ask while its source material is inactive.
    await act(async () => action.onAsk())
    expect(ask).toHaveBeenCalledTimes(1)
  })
  it('withdraws the shared file action when seeking before the selected version was published', async () => {
    const selected = { ...entry('later.txt'), availableAt: 300 },
      changed = vi.fn<(action: ReplayMaterialAction | undefined) => void>()
    const read = vi
        .fn()
        .mockResolvedValue({ content: 'Later output', mimeType: 'text/plain', truncated: false }),
      ask = vi.fn()
    const view = render(
      <ReplayMaterialActionProvider onActionChange={changed}>
        <ResultsPanel entries={[selected]} recordedAt={400} read={read} onAskFile={ask} />
      </ReplayMaterialActionProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: 'later.txt' }))
    await screen.findByText('Later output')
    expect(changed.mock.calls.at(-1)![0]?.label).toBe('Ask about this file')
    view.rerender(
      <ReplayMaterialActionProvider onActionChange={changed}>
        <ResultsPanel entries={[selected]} recordedAt={100} read={read} onAskFile={ask} />
      </ReplayMaterialActionProvider>
    )
    expect(changed).toHaveBeenLastCalledWith(undefined)
    expect(screen.queryByText('Later output')).toBeNull()
    expect(
      screen.getByText('No results have a known publication time before this moment.')
    ).toBeTruthy()
  })
})

it('filters result sources separately, preserves material time, and clears stale actions', async () => {
  const early = {
    ...entry('early.txt'),
    availableAt: 100,
    sourceKey: 'one',
    sourceLabel: 'Source one'
  }
  const later = {
    ...entry('later.txt'),
    availableAt: 300,
    sourceKey: 'two',
    sourceLabel: 'Source two',
    resource: { ...entry('later.txt').resource, id: 'later' }
  }
  const changed = vi.fn<(action: ReplayMaterialAction | undefined) => void>()
  const ask = vi.fn()
  render(
    <ReplayMaterialActionProvider onActionChange={changed}>
      <ResultsPanel
        entries={[early, later]}
        recordedAt={200}
        read={vi.fn().mockResolvedValue({
          content: 'Result',
          mimeType: 'text/plain',
          truncated: false
        })}
        onAskFile={ask}
      />
    </ReplayMaterialActionProvider>
  )
  fireEvent.click(screen.getByRole('button', { name: 'early.txt' }))
  await screen.findByText('Result')
  const previous = changed.mock.calls.at(-1)![0]!
  expect(previous.recordedAt).toBe(100)
  fireEvent.change(screen.getByRole('combobox', { name: 'Result source' }), {
    target: { value: 'two' }
  })
  expect(changed).toHaveBeenLastCalledWith(undefined)
  await act(async () => previous.onAsk())
  expect(ask).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'View all results' }))
  expect(screen.getByRole('combobox', { name: 'Result source' })).toHaveProperty('value', 'two')
  expect(screen.queryByRole('button', { name: 'early.txt' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'later.txt' }))
  await screen.findByText('Result')
  const action = changed.mock.calls.at(-1)![0]!
  expect(action.recordedAt).toBe(300)
  await act(async () => action.onAsk())
  expect(ask).toHaveBeenCalledExactlyOnceWith(later)
})
