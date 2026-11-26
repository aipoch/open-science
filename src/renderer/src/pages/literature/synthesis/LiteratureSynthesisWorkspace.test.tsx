// @vitest-environment jsdom
import { act, cleanup, createEvent, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createLiteratureTestRenderer } from '../../../../../../test/renderer/literature'
import type { LiteratureRendererHost } from '../renderer-host'
import {
  synthesisNoteSummary,
  type LiteratureSynthesisRequest,
  type LiteratureSynthesisResult,
  type SynthesisCandidate,
  type SynthesisExcerpt,
  type SynthesisNote
} from '../../../../../shared/literature-synthesis'
import { LiteratureSynthesisWorkspace } from './LiteratureSynthesisWorkspace'
import { SynthesisCandidates } from './SynthesisCandidates'
import { SynthesisReferenceSearch } from './SynthesisReferenceSearch'
import { editableBlocks, readSynthesisCandidates } from './synthesis-state'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      key.replace(/{{(\w+)}}/g, (_, name: string) => String(values?.[name] ?? name))
  })
}))
const candidate = (itemId = 'paper-1', annotationId = 'annotation-1'): SynthesisCandidate => ({
  itemId,
  versionId: 'pdf-1',
  annotationId,
  bibliography: { itemId, title: `Title ${itemId}`, authors: 'Researcher', year: '2026' },
  tags: [{ id: itemId, name: `Tag ${itemId}` }],
  annotation: {
    id: annotationId,
    version: 1,
    origin: 'user',
    kind: 'highlight',
    color: 'yellow',
    tagIds: [itemId],
    note: `Comment ${annotationId}`,
    literatureVersionId: 'pdf-1',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    target: {
      source: {
        kind: 'literature-attachment-version',
        sourceFileId: 'file-1',
        versionId: 'pdf-1',
        checksum: 'a'.repeat(64),
        name: 'paper.pdf',
        path: 'literature-attachment-version:pdf-1'
      },
      selector: {
        kind: 'text',
        pageNumber: 1,
        pageRotation: 0,
        coordinateVersion: 1,
        extractorVersion: 'fixture',
        exact: `Quote ${annotationId}`,
        position: { start: 0, end: 10 },
        quads: [{ x: 0.1, y: 0.1, width: 0.1, height: 0.1 }]
      }
    }
  }
})
const baseNote = (): SynthesisNote => ({
  id: 'note-1',
  title: 'Synthesis draft',
  revision: 1,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  blocks: [
    { type: 'text', id: 'prose', text: 'My reasoning' },
    { type: 'excerpt', id: 'excerpt', snapshot: candidate(), sourceStatus: 'current' }
  ]
})
const baseExcerpt = (): SynthesisExcerpt =>
  baseNote().blocks.find((block) => block.type === 'excerpt')!
const search = vi.fn()
const synthesis =
  vi.fn<(request: LiteratureSynthesisRequest) => Promise<LiteratureSynthesisResult>>()
const preview = vi.fn<LiteratureRendererHost['PdfAnnotationPreviewDialog']>(() => null)
const bookmark = vi.fn<LiteratureRendererHost['createBookmarkPreviewItem']>()
const saveBlobFile = vi.fn<LiteratureRendererHost['api']['saveBlobFile']>(async () => ({
  saved: true
}))
const { render } = createLiteratureTestRenderer({
  api: {
    literature: { synthesis, search },
    saveBlobFile
  } as unknown as LiteratureRendererHost['api'],
  createBookmarkPreviewItem: bookmark,
  PdfAnnotationPreviewDialog: preview
})
afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  synthesis.mockImplementation(async (request) => {
    if (request.action === 'list')
      return { action: 'list', notes: [synthesisNoteSummary(baseNote())] }
    if (request.action === 'read') return { action: 'read', note: baseNote() }
    if (request.action === 'source') return { action: 'source', block: baseExcerpt() }
    if (request.action === 'candidates') return { action: 'candidates', candidates: [candidate()] }
    throw new Error('Unexpected test request')
  })
})
const openMoreActions = (): void => {
  fireEvent.pointerDown(screen.getByRole('button', { name: 'More actions' }), {
    button: 0,
    ctrlKey: false,
    pointerType: 'mouse'
  })
}
const chooseMoreAction = (name: string): void => {
  openMoreActions()
  fireEvent.click(screen.getByRole('menuitem', { name }))
}
const openEditor = async (): Promise<void> => {
  fireEvent.click(await screen.findByRole('button', { name: 'Synthesis draft' }))
  await screen.findAllByRole('textbox', { name: /^(Overall|Excerpt) analysis$/ })
}
const toggleTagFilter = (name: string): void => {
  fireEvent.pointerDown(screen.getByRole('button', { name: /Filter by Tags?/ }), {
    button: 0,
    ctrlKey: false,
    pointerType: 'mouse'
  })
  fireEvent.click(screen.getByRole('menuitemcheckbox', { name }))
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
}
it('searches note titles and saved content locally with trimmed case-insensitive keywords', async () => {
  const titles = ['Pathway overview', 'Mechanism review', 'Source findings']
  const quote = candidate('paper-1', 'preserved excerpt quote')
  quote.annotation.note = ''
  const notes: SynthesisNote[] = titles.map((title, index) => ({
    ...baseNote(),
    id: `note-${index + 1}`,
    title,
    blocks:
      index === 1
        ? [{ type: 'text', id: 'analysis', text: 'Enzyme interpretation' }]
        : index === 2
          ? [{ type: 'excerpt', id: 'excerpt', snapshot: quote, sourceStatus: 'current' }]
          : []
  }))
  synthesis.mockImplementation(async (request) => {
    if (request.action === 'list')
      return {
        action: 'list',
        notes: notes.map(synthesisNoteSummary)
      }
    if (request.action === 'read')
      return { action: 'read', note: notes.find((note) => note.id === request.noteId)! }
    throw new Error('Unexpected test request')
  })
  render(<LiteratureSynthesisWorkspace resolveSelectedItemIds={async () => []} onClose={vi.fn()} />)
  await screen.findByRole('button', { name: titles[0] })
  const search = screen.getByRole('searchbox', { name: 'Search synthesis notes' })
  for (const [index, keyword] of [
    '  PATHWAY overview  ',
    '  ENZYME Interpretation  ',
    '  preserved EXCERPT  '
  ].entries()) {
    fireEvent.change(search, { target: { value: keyword } })
    for (const [noteIndex, title] of titles.entries())
      expect(Boolean(screen.queryByRole('button', { name: title }))).toBe(index === noteIndex)
  }
  fireEvent.change(search, { target: { value: 'no matching saved content' } })
  expect(screen.getByRole('status').textContent).toBe('No synthesis notes match this search.')
  expect(
    screen.queryByText('No synthesis notes yet. Select references in the library to get started.')
  ).toBeNull()

  fireEvent.change(search, { target: { value: '   ' } })
  for (const title of titles) expect(screen.getByRole('button', { name: title })).not.toBeNull()
  expect(synthesis.mock.calls.map(([request]) => request.action)).toEqual(['list'])
  fireEvent.change(search, { target: { value: 'preserved excerpt' } })
  fireEvent.click(screen.getByRole('button', { name: titles[2] }))
  await screen.findByRole('textbox', { name: /^(Overall|Excerpt) analysis$/ })
  expect(synthesis).toHaveBeenLastCalledWith({ action: 'read', noteId: 'note-3' })
})
it('keeps modification order when returning from an older note and refreshing', async () => {
  const old = baseNote()
  const latest = { ...old, id: 'latest', title: 'Latest note', updatedAt: '2026-02-01T00:00:00Z' }
  synthesis.mockImplementation(async (request) => {
    if (request.action === 'list')
      return { action: 'list', notes: [latest, old].map(synthesisNoteSummary) }
    if (request.action === 'read') return { action: 'read', note: old }
    throw new Error('Unexpected request')
  })
  render(<LiteratureSynthesisWorkspace resolveSelectedItemIds={async () => []} onClose={vi.fn()} />)
  await openEditor()
  fireEvent.click(screen.getByRole('button', { name: 'Back to synthesis notes' }))
  const titles = (): (string | null)[] =>
    screen
      .getAllByRole('button', { name: /^(Latest note|Synthesis draft)$/ })
      .map((button) => button.textContent)
  expect(titles()).toEqual([latest.title, old.title])
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
  await vi.waitFor(() => expect(screen.queryByText('Loading')).toBeNull())
  expect(titles()).toEqual([latest.title, old.title])
})

it('searches legacy summaries by metadata even when no content search index is present', async () => {
  const note = baseNote()
  synthesis.mockResolvedValue({
    action: 'list',
    notes: [
      {
        id: note.id,
        title: note.title,
        revision: note.revision,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
        sourceMetadata: [
          { title: 'Original paper', authors: 'Original author', tags: ['Earlier tag'] },
          { title: 'Renamed paper', authors: 'New author', tags: ['Later tag'] }
        ]
      }
    ]
  })
  render(<LiteratureSynthesisWorkspace resolveSelectedItemIds={async () => []} onClose={vi.fn()} />)
  await screen.findByRole('button', { name: note.title })
  const search = screen.getByRole('searchbox', { name: 'Search synthesis notes' })
  for (const keyword of [
    'Original paper',
    'Original author',
    'Earlier tag',
    'Renamed paper',
    'New author',
    'Later tag'
  ]) {
    fireEvent.change(search, { target: { value: keyword } })
    expect(screen.getByRole('button', { name: note.title })).not.toBeNull()
  }
  expect(synthesis.mock.calls.map(([request]) => request.action)).toEqual(['list'])
})
it('keeps an empty notes collection distinct from a search with no matches', async () => {
  synthesis.mockResolvedValue({ action: 'list', notes: [] })
  render(<LiteratureSynthesisWorkspace resolveSelectedItemIds={async () => []} onClose={vi.fn()} />)
  await screen.findByText(
    'No synthesis notes yet. Select references in the library to get started.'
  )
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search synthesis notes' }), {
    target: { value: 'anything' }
  })
  expect(screen.queryByText('No synthesis notes match this search.')).toBeNull()
  expect(
    screen.getByRole('button', { name: 'Create from selected references' }).hasAttribute('disabled')
  ).toBe(false)
})
it('searches note summaries by paper title, author and tag metadata', async () => {
  const note = baseNote()
  synthesis.mockResolvedValue({
    action: 'list',
    notes: [synthesisNoteSummary(note)]
  })
  render(<LiteratureSynthesisWorkspace resolveSelectedItemIds={async () => []} onClose={vi.fn()} />)
  await screen.findByRole('button', { name: note.title })
  const search = screen.getByRole('searchbox', { name: 'Search synthesis notes' })

  fireEvent.change(search, { target: { value: 'Title paper-1' } })
  expect(screen.getByRole('button', { name: note.title })).not.toBeNull()
  fireEvent.change(search, { target: { value: 'Researcher' } })
  expect(screen.getByText('Reference')).not.toBeNull()
  expect(screen.getByText('Authors')).not.toBeNull()
  expect(screen.getByText('Researcher')).not.toBeNull()
  expect(screen.queryByText(/Title paper-1.*Researcher/)).toBeNull()
  fireEvent.change(search, { target: { value: 'Tag paper-1' } })
  expect(screen.getByText('Tags: Tag paper-1')).not.toBeNull()
  fireEvent.change(search, { target: { value: 'missing metadata' } })
  expect(screen.queryByRole('button', { name: note.title })).toBeNull()
})
it('shows a saved-content match in a note summary only while the search matches', async () => {
  const searchText = `${'Background context. '.repeat(20)}Enzyme interpretation links the observed pathway to the result. ${'Further context. '.repeat(20)}`
  synthesis.mockResolvedValue({
    action: 'list',
    notes: [{ ...synthesisNoteSummary(baseNote()), title: 'Mechanism review', searchText }]
  })
  render(<LiteratureSynthesisWorkspace resolveSelectedItemIds={async () => []} onClose={vi.fn()} />)
  await screen.findByRole('button', { name: 'Mechanism review' })
  expect(screen.queryByText(/Enzyme interpretation/)).toBeNull()
  const search = screen.getByRole('searchbox', { name: 'Search synthesis notes' })

  fireEvent.change(search, { target: { value: '  ENZYME INTERPRETATION  ' } })
  const summary = screen.getByText(/Enzyme interpretation/)
  expect(summary.textContent).toContain('links the observed pathway')
  expect(summary.textContent!.length).toBeLessThan(searchText.length)
  expect(screen.getByRole('button', { name: 'Mechanism review' })).not.toBeNull()

  fireEvent.change(search, { target: { value: 'a different mechanism' } })
  expect(screen.queryByText(/Enzyme interpretation/)).toBeNull()
  expect(screen.queryByRole('button', { name: 'Mechanism review' })).toBeNull()
  expect(screen.getByRole('status').textContent).toBe('No synthesis notes match this search.')

  fireEvent.change(search, { target: { value: '   ' } })
  expect(screen.getByRole('button', { name: 'Mechanism review' })).not.toBeNull()
  expect(screen.queryByText(/Enzyme interpretation/)).toBeNull()
  expect(synthesis.mock.calls.map(([request]) => request.action)).toEqual(['list'])
})
it('opens each candidate source at its annotation and restores focus to the source button', async () => {
  bookmark.mockReturnValue({
    id: 'preview',
    type: 'file',
    sessionId: 'literature',
    title: 'paper.pdf',
    format: 'pdf',
    path: candidate().annotation.target.source.path,
    name: 'paper.pdf'
  })
  preview.mockImplementation(({ onClose }: { onClose(): void }) => (
    <button onClick={onClose}>Close source preview</button>
  ))
  render(
    <LiteratureSynthesisWorkspace
      createFromSelection
      resolveSelectedItemIds={async () => ['paper-1']}
      onClose={vi.fn()}
    />
  )
  await screen.findByRole('dialog', { name: 'Choose excerpts.' })
  const sourceButton = screen.getByRole('button', { name: 'Open source: Title paper-1' })
  fireEvent.click(sourceButton)
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
  await screen.findByRole('button', { name: 'Close source preview' })
  expect(bookmark).toHaveBeenCalledWith({
    id: 'annotation-1',
    kind: 'pdf',
    ...candidate().annotation.target
  })
  expect(preview.mock.calls.at(-1)?.[0].annotation).toEqual(candidate().annotation)
  fireEvent.click(screen.getByRole('button', { name: 'Close source preview' }))
  await vi.waitFor(() => expect(document.activeElement).toBe(sourceButton))
})
it('reports an unavailable candidate source without opening a preview', async () => {
  bookmark.mockReturnValue(undefined)
  render(
    <LiteratureSynthesisWorkspace
      createFromSelection
      resolveSelectedItemIds={async () => ['paper-1']}
      onClose={vi.fn()}
    />
  )
  await screen.findByRole('dialog', { name: 'Choose excerpts.' })
  fireEvent.click(screen.getByRole('button', { name: 'Open source: Title paper-1' }))
  await screen.findByText('PDF annotations are unavailable for this source.')
  expect(preview).not.toHaveBeenCalled()
})
it('keeps the latest failed-save draft, retries it, and sends immutable excerpt references', async () => {
  let updates = 0
  synthesis.mockImplementation(async (request) => {
    if (request.action === 'list')
      return { action: 'list', notes: [synthesisNoteSummary(baseNote())] }
    if (request.action === 'read') return { action: 'read', note: baseNote() }
    if (request.action === 'update') {
      updates++
      if (updates === 1) throw new Error('Conflict')
      return {
        action: 'update',
        note: {
          ...baseNote(),
          revision: 2,
          blocks: [
            {
              type: 'text',
              id: 'prose',
              text: request.blocks[0].type === 'text' ? request.blocks[0].text : ''
            },
            baseNote().blocks[1]
          ]
        }
      }
    }
    throw new Error('Unexpected test request')
  })
  render(<LiteratureSynthesisWorkspace resolveSelectedItemIds={async () => []} onClose={vi.fn()} />)
  await openEditor()
  fireEvent.change(screen.getByRole('textbox', { name: /^(Overall|Excerpt) analysis$/ }), {
    target: { value: 'Edited argument' }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await screen.findByText(
    'The note could not be saved. Your changes are kept. Retry, or copy your text before closing.'
  )
  expect(
    (screen.getByRole('textbox', { name: /^(Overall|Excerpt) analysis$/ }) as HTMLTextAreaElement)
      .value
  ).toBe('Edited argument')
  fireEvent.change(screen.getByRole('textbox', { name: /^(Overall|Excerpt) analysis$/ }), {
    target: { value: 'Latest argument' }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await screen.findByText('Saved')
  expect(synthesis).toHaveBeenLastCalledWith(
    expect.objectContaining({
      action: 'update',
      blocks: [
        { type: 'text', id: 'prose', text: 'Latest argument' },
        { type: 'excerpt', id: 'excerpt' }
      ]
    })
  )
  expect(screen.getByText('Quote annotation-1')).not.toBeNull()
})
it('guards dirty close, preserves editing after cancellation, and disables export until saved', async () => {
  const close = vi.fn()
  render(<LiteratureSynthesisWorkspace resolveSelectedItemIds={async () => []} onClose={close} />)
  await openEditor()
  fireEvent.change(screen.getByRole('textbox', { name: /^(Overall|Excerpt) analysis$/ }), {
    target: { value: 'Unsaved' }
  })
  openMoreActions()
  expect(
    screen.getByRole('menuitem', { name: 'Export Markdown' }).getAttribute('aria-disabled')
  ).toBe('true')
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
  fireEvent.click(screen.getByRole('button', { name: 'Close' }))
  await screen.findByText('Discard unsaved changes?')
  fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }))
  expect(close).not.toHaveBeenCalled()
  expect(
    (screen.getByRole('textbox', { name: /^(Overall|Excerpt) analysis$/ }) as HTMLTextAreaElement)
      .value
  ).toBe('Unsaved')
  fireEvent.click(screen.getByRole('button', { name: 'Close' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Discard changes' }))
  expect(close).toHaveBeenCalledOnce()
})
it('rejects an older export retry after the user edits the current draft', async () => {
  let exports = 0
  synthesis.mockImplementation(async (request) => {
    if (request.action === 'list')
      return { action: 'list', notes: [synthesisNoteSummary(baseNote())] }
    if (request.action === 'read') return { action: 'read', note: baseNote() }
    if (request.action === 'export') {
      exports++
      return { action: 'export', filename: 'note.md', markdown: '# Saved note' }
    }
    throw new Error('Unexpected request')
  })
  saveBlobFile.mockRejectedValueOnce(new Error('File save failed'))
  render(<LiteratureSynthesisWorkspace resolveSelectedItemIds={async () => []} onClose={vi.fn()} />)
  await openEditor()
  chooseMoreAction('Export Markdown')
  await screen.findByText('The note could not be exported.')
  fireEvent.change(screen.getByRole('textbox', { name: /^(Overall|Excerpt) analysis$/ }), {
    target: { value: 'New draft after failed export' }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await act(async () => {
    await Promise.resolve()
  })
  expect(exports).toBe(1)
  expect(saveBlobFile).toHaveBeenCalledTimes(1)
  await screen.findByText('Unsaved changes', { exact: true })
  expect(
    (screen.getByRole('textbox', { name: /^(Overall|Excerpt) analysis$/ }) as HTMLTextAreaElement)
      .value
  ).toBe('New draft after failed export')
})
it('checks current source availability before preview and never opens an unavailable PDF', async () => {
  render(<LiteratureSynthesisWorkspace resolveSelectedItemIds={async () => []} onClose={vi.fn()} />)
  await openEditor()
  synthesis.mockResolvedValueOnce({
    action: 'source',
    block: { ...baseExcerpt(), sourceStatus: 'unavailable' }
  })
  fireEvent.click(screen.getByRole('button', { name: /Title paper-1.*Page 1/ }))
  await screen.findByText('The source PDF or annotation is unavailable. The saved excerpt is kept.')
  expect(bookmark).not.toHaveBeenCalled()
  expect(preview).not.toHaveBeenCalled()
  expect(screen.getByText('Quote annotation-1')).not.toBeNull()
  expect(synthesis).toHaveBeenLastCalledWith({
    action: 'source',
    noteId: 'note-1',
    blockId: 'excerpt'
  })
  expect(synthesis.mock.calls.filter(([request]) => request.action === 'read')).toHaveLength(1)
})
it('rejects more than 50 selected papers without truncating or requesting candidates', async () => {
  render(
    <LiteratureSynthesisWorkspace
      createFromSelection
      resolveSelectedItemIds={async () => Array.from({ length: 51 }, (_, i) => String(i))}
      onClose={vi.fn()}
    />
  )
  await screen.findByText('Select between 1 and 50 references to choose excerpts.')
  expect(synthesis.mock.calls.some(([request]) => request.action === 'candidates')).toBe(false)
})
it.each([
  { exit: 'Escape', draft: 'both' },
  { exit: 'Close', draft: 'title' },
  { exit: 'Cancel', draft: 'selection' }
])(
  'guards candidate $exit with a $draft draft and restores it and focus after keeping editing',
  async ({ exit, draft }) => {
    const close = vi.fn()
    render(
      <LiteratureSynthesisWorkspace
        createFromSelection
        resolveSelectedItemIds={async () => ['paper-1']}
        onClose={close}
      />
    )
    const checkbox = (await screen.findByRole('checkbox')) as HTMLInputElement
    const title = screen.getByRole('textbox', { name: 'Note title' }) as HTMLInputElement
    if (draft !== 'title') fireEvent.click(checkbox)
    if (draft !== 'selection') fireEvent.change(title, { target: { value: 'Unfinished note' } })
    const requestExit = (): HTMLElement => {
      const initiator = exit === 'Escape' ? title : screen.getByRole('button', { name: exit })
      initiator.focus()
      if (exit === 'Escape') fireEvent.keyDown(initiator, { key: 'Escape' })
      else fireEvent.click(initiator)
      return initiator
    }

    const initiator = requestExit()
    await screen.findByRole('alertdialog', { name: 'Discard unsaved changes?' })
    expect(close).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }))
    await vi.waitFor(() => expect(document.activeElement).toBe(initiator))
    expect(title.value).toBe(draft === 'selection' ? '' : 'Unfinished note')
    expect(checkbox.checked).toBe(draft !== 'title')
    expect(screen.getByRole('dialog', { name: 'Choose excerpts.' })).not.toBeNull()

    requestExit()
    fireEvent.click(await screen.findByRole('button', { name: 'Discard changes' }))
    if (exit === 'Cancel') {
      await screen.findByRole('dialog', { name: 'Synthesis notes' })
      expect(screen.queryByRole('checkbox')).toBeNull()
      expect(close).not.toHaveBeenCalled()
    } else expect(close).toHaveBeenCalledOnce()
  }
)
it.each(['Escape', 'Close', 'Cancel'])(
  'lets candidate $exit proceed when only filters changed',
  async (exit) => {
    const close = vi.fn()
    render(
      <LiteratureSynthesisWorkspace
        createFromSelection
        resolveSelectedItemIds={async () => ['paper-1']}
        onClose={close}
      />
    )
    await screen.findByRole('checkbox')
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search excerpts and notes' }), {
      target: { value: 'Quote' }
    })
    toggleTagFilter('Tag paper-1')
    if (exit === 'Escape') {
      const search = screen.getByRole('searchbox', { name: 'Search excerpts and notes' })
      search.focus()
      fireEvent.keyDown(search, { key: 'Escape' })
    } else fireEvent.click(screen.getByRole('button', { name: exit }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    if (exit === 'Cancel') {
      await screen.findByRole('dialog', { name: 'Synthesis notes' })
      expect(close).not.toHaveBeenCalled()
    } else expect(close).toHaveBeenCalledOnce()
  }
)
it('keeps hidden selected excerpts while filtering and reports a reference without annotations', async () => {
  const first = candidate(),
    second = candidate('paper-2', 'annotation-2'),
    confirm = vi.fn()
  render(
    <SynthesisCandidates
      append
      itemIds={['paper-1', 'paper-2', 'paper-3']}
      candidates={[first, second]}
      titles={{ 'paper-3': 'Unannotated reference' }}
      busy={false}
      onCancel={vi.fn()}
      onConfirm={confirm}
    />
  )
  fireEvent.click(screen.getAllByRole('checkbox')[1])
  toggleTagFilter('Tag paper-1')
  expect(screen.getByText('1 selected excerpts hidden by the filter')).not.toBeNull()
  expect(
    screen.getByText(
      'No unique annotations found for this reference. Shared PDF annotations appear once.'
    )
  ).not.toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Append excerpts (1)' }))
  expect(confirm).toHaveBeenCalledWith('', [second])
})
it('searches excerpt quotes and annotation notes with trimmed case-insensitive keywords', () => {
  const quote = candidate(),
    note = candidate('paper-2', 'annotation-2')
  quote.annotation.note = ''
  render(
    <SynthesisCandidates
      append
      itemIds={['paper-1', 'paper-2']}
      candidates={[quote, note]}
      titles={{}}
      busy={false}
      onCancel={vi.fn()}
      onConfirm={vi.fn()}
    />
  )
  const search = screen.getByRole('searchbox', { name: 'Search excerpts and notes' })
  fireEvent.change(search, { target: { value: '  qUoTe AnNoTaTiOn-1  ' } })
  expect(screen.getAllByRole('checkbox')).toHaveLength(1)
  expect(screen.getByText('Quote annotation-1')).not.toBeNull()
  expect(screen.queryByText('Comment annotation-2')).toBeNull()

  fireEvent.change(search, { target: { value: '  COMMENT annotation-2  ' } })
  expect(screen.getAllByRole('checkbox')).toHaveLength(1)
  expect(screen.getByText('Comment annotation-2')).not.toBeNull()
  expect(screen.queryByText('Quote annotation-1')).toBeNull()

  fireEvent.change(search, { target: { value: 'missing keyword' } })
  expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
  expect(screen.getAllByText('No annotations match these filters.')).toHaveLength(2)
  expect(
    (screen.getByRole('button', { name: 'Select current results' }) as HTMLButtonElement).disabled
  ).toBe(true)
})
it('combines keyword and tag filters before selecting visible excerpts', () => {
  const first = candidate(),
    second = candidate('paper-2', 'annotation-2'),
    confirm = vi.fn()
  render(
    <SynthesisCandidates
      append
      itemIds={['paper-1', 'paper-2']}
      candidates={[first, second]}
      titles={{}}
      busy={false}
      onCancel={vi.fn()}
      onConfirm={confirm}
    />
  )
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search excerpts and notes' }), {
    target: { value: 'Quote annotation-1' }
  })
  toggleTagFilter('Tag paper-2')
  expect(screen.queryAllByRole('checkbox')).toHaveLength(0)

  toggleTagFilter('Tag paper-2')
  toggleTagFilter('Tag paper-1')
  expect(screen.getAllByRole('checkbox')).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: 'Select current results' }))
  fireEvent.click(screen.getByRole('button', { name: 'Append excerpts (1)' }))
  expect(confirm).toHaveBeenCalledWith('', [first])
})
it('retains checked excerpts when changing and clearing a keyword filter', () => {
  const first = candidate(),
    second = candidate('paper-2', 'annotation-2'),
    confirm = vi.fn()
  render(
    <SynthesisCandidates
      append
      itemIds={['paper-1', 'paper-2']}
      candidates={[first, second]}
      titles={{}}
      busy={false}
      onCancel={vi.fn()}
      onConfirm={confirm}
    />
  )
  fireEvent.click(screen.getByRole('checkbox', { name: /Quote annotation-2/ }))
  const search = screen.getByRole('searchbox', { name: 'Search excerpts and notes' })
  fireEvent.change(search, { target: { value: 'annotation-1' } })
  expect(screen.getByText('1 selected excerpts hidden by the filter')).not.toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Select current results' }))

  fireEvent.change(search, { target: { value: 'annotation-2' } })
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true)
  expect(screen.getByRole('status').textContent).toBe('2 selected')

  fireEvent.change(search, { target: { value: '' } })
  expect(screen.getAllByRole('checkbox')).toHaveLength(2)
  expect(
    screen.getAllByRole('checkbox').every((input) => (input as HTMLInputElement).checked)
  ).toBe(true)
  expect(screen.queryByText('1 selected excerpts hidden by the filter')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Append excerpts (2)' }))
  expect(confirm).toHaveBeenCalledWith('', [first, second])
})
const capacityCandidates = (): SynthesisCandidate[] => [
  ...Array.from({ length: 80 }, (_, index) => candidate('paper-1', `alpha-${index}`)),
  ...Array.from({ length: 20 }, (_, index) => candidate('paper-2', `beta-fit-${index}`)),
  ...Array.from({ length: 10 }, (_, index) => candidate('paper-2', `beta-extra-${index}`))
]
it('rejects an oversized batch without partially selecting results and states the available capacity', () => {
  render(
    <SynthesisCandidates
      append
      itemIds={['paper-1', 'paper-2']}
      candidates={capacityCandidates()}
      titles={{}}
      busy={false}
      onCancel={vi.fn()}
      onConfirm={vi.fn()}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Select current results' }))
  expect(screen.getByRole('status').textContent).toBe('0 selected')
  expect(screen.getAllByRole('checkbox').some((input) => (input as HTMLInputElement).checked)).toBe(
    false
  )
  expect(
    screen.getByText(
      '100 more can be selected. Narrow the results or clear part of your selection.'
    )
  ).not.toBeNull()
  expect(
    (screen.getByRole('button', { name: 'Append excerpts (0)' }) as HTMLButtonElement).disabled
  ).toBe(true)
  fireEvent.click(screen.getAllByRole('checkbox')[0])
  expect(screen.getByRole('status').textContent).toBe('1 selected')
  expect(screen.queryByText('Select at most 100 excerpts.')).toBeNull()
})
it('keeps 80 hidden selections when another 30 results exceed capacity and accepts exactly 20 more', () => {
  const confirm = vi.fn()
  const candidates = capacityCandidates()
  render(
    <SynthesisCandidates
      append
      itemIds={['paper-1', 'paper-2']}
      candidates={candidates}
      titles={{}}
      busy={false}
      onCancel={vi.fn()}
      onConfirm={confirm}
    />
  )
  const search = screen.getByRole('searchbox', { name: 'Search excerpts and notes' })
  fireEvent.change(search, { target: { value: 'alpha-' } })
  fireEvent.click(screen.getByRole('button', { name: 'Select current results' }))
  fireEvent.change(search, { target: { value: 'beta-' } })
  fireEvent.click(screen.getByRole('button', { name: 'Select current results' }))
  expect(screen.getByRole('status').textContent).toBe('80 selected')
  expect(screen.getByText('80 selected excerpts hidden by the filter')).not.toBeNull()
  expect(
    screen.getByText('20 more can be selected. Narrow the results or clear part of your selection.')
  ).not.toBeNull()
  const visible = screen.getAllByRole('checkbox')
  expect(visible).toHaveLength(30)
  expect(visible.some((input) => (input as HTMLInputElement).checked)).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Append excerpts (80)' }))
  expect(confirm).toHaveBeenLastCalledWith('', candidates.slice(0, 80))

  fireEvent.change(search, { target: { value: 'beta-fit-' } })
  expect(screen.queryByText('Select at most 100 excerpts.')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Select current results' }))
  expect(screen.getByRole('status').textContent).toBe('100 selected')
  expect(screen.queryByText('Select at most 100 excerpts.')).toBeNull()
  expect(
    screen.getAllByRole('checkbox').every((input) => (input as HTMLInputElement).checked)
  ).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Select current results' }))
  expect(screen.queryByText('Select at most 100 excerpts.')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Append excerpts (100)' }))
  expect(confirm).toHaveBeenLastCalledWith('', candidates.slice(0, 100))

  fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
  const inputs = screen.getAllByRole('checkbox') as HTMLInputElement[]
  expect(inputs.filter((input) => input.checked)).toHaveLength(100)
  expect(inputs.slice(0, 100).every((input) => !input.disabled)).toBe(true)
  expect(inputs.slice(100).every((input) => input.disabled)).toBe(true)
  fireEvent.click(inputs[0])
  expect(screen.getByRole('status').textContent).toBe('99 selected')
  expect(inputs[100].disabled).toBe(false)
  fireEvent.click(inputs[100])
  expect(screen.getByRole('status').textContent).toBe('100 selected')
  expect(inputs[0].disabled).toBe(true)
  expect(inputs[101].disabled).toBe(true)
  expect(inputs[100].checked).toBe(true)
})
it('counts selected tags and requires them on the same excerpt rather than across a reference', () => {
  const alpha = { id: 'alpha', name: 'Alpha' },
    beta = { id: 'beta', name: 'Beta' }
  const first = { ...candidate('paper-1', 'alpha-only'), tags: [alpha] },
    second = { ...candidate('paper-1', 'beta-only'), tags: [beta] },
    both = { ...candidate('paper-1', 'both-tags'), tags: [alpha, beta] },
    confirm = vi.fn()
  render(
    <SynthesisCandidates
      append
      itemIds={['paper-1']}
      candidates={[first, second, both]}
      titles={{}}
      busy={false}
      onCancel={vi.fn()}
      onConfirm={confirm}
    />
  )
  const tagFilter = screen.getByRole('button', { name: 'Filter by Tag' })
  expect(tagFilter.textContent).toBe('All tags')
  toggleTagFilter('Alpha')
  expect(tagFilter.textContent).toMatch(/^1 tags? selected$/)
  expect(screen.getAllByRole('checkbox')).toHaveLength(2)
  toggleTagFilter('Beta')
  expect(tagFilter.textContent).toBe('2 tags selected')
  expect(screen.getAllByRole('checkbox')).toHaveLength(1)
  expect(screen.getByText('Quote both-tags')).not.toBeNull()
  expect(screen.queryByText('Quote alpha-only')).toBeNull()
  expect(screen.queryByText('Quote beta-only')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Select current results' }))
  fireEvent.click(screen.getByRole('button', { name: 'Append excerpts (1)' }))
  expect(confirm).toHaveBeenCalledWith('', [both])
})
it('intersects keyword matches with every selected tag before selecting visible excerpts', () => {
  const alpha = { id: 'alpha', name: 'Alpha' },
    beta = { id: 'beta', name: 'Beta' }
  const first = { ...candidate('paper-1', 'matching-both'), tags: [alpha, beta] },
    second = { ...candidate('paper-1', 'matching-one'), tags: [alpha] },
    third = { ...candidate('paper-1', 'other-both'), tags: [alpha, beta] },
    confirm = vi.fn()
  first.annotation.note = 'Target phrase'
  second.annotation.note = 'Target phrase'
  render(
    <SynthesisCandidates
      append
      itemIds={['paper-1']}
      candidates={[first, second, third]}
      titles={{}}
      busy={false}
      onCancel={vi.fn()}
      onConfirm={confirm}
    />
  )
  toggleTagFilter('Alpha')
  toggleTagFilter('Beta')
  expect(screen.getAllByRole('checkbox')).toHaveLength(2)
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search excerpts and notes' }), {
    target: { value: '  TARGET phrase  ' }
  })
  expect(screen.getAllByRole('checkbox')).toHaveLength(1)
  expect(screen.getByText('Quote matching-both')).not.toBeNull()
  expect(screen.queryByText('Quote matching-one')).toBeNull()
  expect(screen.queryByText('Quote other-both')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Select current results' }))
  fireEvent.click(screen.getByRole('button', { name: 'Append excerpts (1)' }))
  expect(confirm).toHaveBeenCalledWith('', [first])
})
it('preserves selected excerpts while toggling tags and clearing all filters', () => {
  const alpha = { id: 'alpha', name: 'Alpha' },
    beta = { id: 'beta', name: 'Beta' }
  const first = { ...candidate('paper-1', 'both-tags'), tags: [alpha, beta] },
    second = { ...candidate('paper-1', 'beta-only'), tags: [beta] },
    confirm = vi.fn()
  render(
    <SynthesisCandidates
      append
      itemIds={['paper-1']}
      candidates={[first, second]}
      titles={{}}
      busy={false}
      onCancel={vi.fn()}
      onConfirm={confirm}
    />
  )
  fireEvent.click(screen.getByRole('checkbox', { name: /Quote beta-only/ }))
  toggleTagFilter('Alpha')
  toggleTagFilter('Beta')
  expect(screen.getByText('1 selected excerpts hidden by the filter')).not.toBeNull()
  const search = screen.getByRole('searchbox', { name: 'Search excerpts and notes' })
  fireEvent.change(search, { target: { value: 'missing keyword' } })
  expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
  expect(
    screen.getByRole('button', { name: 'Select current results' }).hasAttribute('disabled')
  ).toBe(true)

  fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
  expect((search as HTMLInputElement).value).toBe('')
  expect(screen.getByRole('button', { name: 'Filter by Tag' }).textContent).toBe('All tags')
  expect(screen.getAllByRole('checkbox')).toHaveLength(2)
  expect(
    (screen.getByRole('checkbox', { name: /Quote beta-only/ }) as HTMLInputElement).checked
  ).toBe(true)
  expect(screen.getByRole('status').textContent).toBe('1 selected')
  expect(screen.queryByText('1 selected excerpts hidden by the filter')).toBeNull()

  toggleTagFilter('Alpha')
  fireEvent.click(screen.getByRole('button', { name: 'Select current results' }))
  toggleTagFilter('Alpha')
  expect(
    screen.getAllByRole('checkbox').every((input) => (input as HTMLInputElement).checked)
  ).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Append excerpts (2)' }))
  expect(confirm).toHaveBeenCalledWith('', [first, second])
})
it('keeps menu tag searches separate from the active excerpt filters', () => {
  const first = candidate('paper-1', 'first')
  const second = candidate('paper-2', 'second')
  render(
    <SynthesisCandidates
      append
      itemIds={['paper-1', 'paper-2']}
      candidates={[first, second]}
      titles={{}}
      busy={false}
      onCancel={vi.fn()}
      onConfirm={vi.fn()}
    />
  )
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Filter by Tag' }), {
    button: 0,
    ctrlKey: false,
    pointerType: 'mouse'
  })
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search Tags' }), {
    target: { value: 'paper-2' }
  })
  expect(screen.queryByRole('menuitemcheckbox', { name: 'Tag paper-1' })).toBeNull()
  expect(screen.getByRole('menuitemcheckbox', { name: 'Tag paper-2' })).not.toBeNull()
  expect(screen.queryByText('Clear filters')).toBeNull()
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
  expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull()
  expect(screen.getByText('Quote first')).not.toBeNull()
  expect(screen.getByText('Quote second')).not.toBeNull()

  fireEvent.change(screen.getByRole('searchbox', { name: 'Search excerpts and notes' }), {
    target: { value: 'second' }
  })
  expect(screen.getByRole('button', { name: 'Clear filters' })).not.toBeNull()
  expect(screen.queryByText('Quote first')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
  expect(screen.getByText('Quote first')).not.toBeNull()
  expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull()
})
it('filters tag options inside the menu while retaining a selected tag hidden by the search', () => {
  const alpha = { id: 'alpha', name: 'Alpha' },
    beta = { id: 'beta', name: 'Beta' },
    gamma = { id: 'gamma', name: 'Gamma' }
  const first = { ...candidate('paper-1', 'alpha-excerpt'), tags: [alpha] },
    second = { ...candidate('paper-1', 'beta-excerpt'), tags: [beta] },
    third = { ...candidate('paper-1', 'gamma-excerpt'), tags: [gamma] }
  render(
    <SynthesisCandidates
      append
      itemIds={['paper-1']}
      candidates={[first, second, third]}
      titles={{}}
      busy={false}
      onCancel={vi.fn()}
      onConfirm={vi.fn()}
    />
  )

  fireEvent.pointerDown(screen.getByRole('button', { name: 'Filter by Tag' }), {
    button: 0,
    ctrlKey: false,
    pointerType: 'mouse'
  })
  const tagSearch = screen.getByRole('searchbox', { name: 'Search Tags' })
  expect(screen.getByRole('menuitemcheckbox', { name: 'Alpha' })).not.toBeNull()
  expect(screen.getByRole('menuitemcheckbox', { name: 'Beta' })).not.toBeNull()
  expect(screen.getByRole('menuitemcheckbox', { name: 'Gamma' })).not.toBeNull()

  fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Alpha' }))
  expect(screen.getByRole('menuitemcheckbox', { name: 'Alpha' }).getAttribute('aria-checked')).toBe(
    'true'
  )
  fireEvent.change(tagSearch, { target: { value: 'beta' } })
  // Selected tags stay in the menu even when the search term matches another tag.
  expect(screen.getByRole('menuitemcheckbox', { name: 'Alpha' })).not.toBeNull()
  expect(screen.getByRole('menuitemcheckbox', { name: 'Alpha' }).getAttribute('aria-checked')).toBe(
    'true'
  )
  expect(screen.getByRole('menuitemcheckbox', { name: 'Beta' })).not.toBeNull()
  expect(screen.queryByRole('menuitemcheckbox', { name: 'Gamma' })).toBeNull()

  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
  expect(screen.getByRole('button', { name: 'Filter by Tag' }).textContent).toMatch(
    /^1 tags? selected/
  )
  expect(screen.getByText('Quote alpha-excerpt')).not.toBeNull()
  expect(screen.queryByText('Quote beta-excerpt')).toBeNull()
  expect(screen.queryByText('Quote gamma-excerpt')).toBeNull()
})
it('reads every candidate page and rejects a nonadvancing cursor instead of reporting partial success', async () => {
  const cursor = { createdAt: '2025-01-01T00:00:00.000Z', id: 'annotation-1' }
  const transport = vi
    .fn()
    .mockResolvedValueOnce({ action: 'candidates', candidates: [candidate()], nextCursor: cursor })
    .mockResolvedValueOnce({
      action: 'candidates',
      candidates: [candidate('paper-2', 'annotation-2')]
    })
  expect(await readSynthesisCandidates(transport, ['paper-1', 'paper-2'])).toHaveLength(2)
  expect(transport).toHaveBeenLastCalledWith({
    action: 'candidates',
    itemIds: ['paper-1', 'paper-2'],
    cursor,
    limit: 100
  })
  transport.mockResolvedValue({
    action: 'candidates',
    candidates: [candidate()],
    nextCursor: cursor
  })
  await expect(readSynthesisCandidates(transport, ['paper-1'])).rejects.toThrow('did not advance')
  expect(editableBlocks(baseNote().blocks)).toEqual([
    { type: 'text', id: 'prose', text: 'My reasoning' },
    { type: 'excerpt', id: 'excerpt' }
  ])
})
it.each([
  { createdAt: '2025-01-01T00:00:00.000Z', id: 'annotation-0' },
  { createdAt: '2024-12-31T23:59:59.999Z', id: 'annotation-2' }
])('rejects a candidate cursor that moves backwards: %j', async (nextCursor) => {
  const transport = vi
    .fn()
    .mockResolvedValueOnce({
      action: 'candidates',
      candidates: [],
      nextCursor: { createdAt: '2025-01-01T00:00:00.000Z', id: 'annotation-1' }
    })
    .mockResolvedValueOnce({ action: 'candidates', candidates: [], nextCursor })
  await expect(readSynthesisCandidates(transport, ['paper-1'])).rejects.toThrow('did not advance')
})

it('continues empty candidate pages in SQLite binary order for Unicode cursor IDs', async () => {
  const transport = vi
    .fn()
    .mockResolvedValueOnce({
      action: 'candidates',
      candidates: [],
      nextCursor: { createdAt: '2025-01-01T00:00:00.000Z', id: '\uE000' }
    })
    .mockResolvedValueOnce({
      action: 'candidates',
      candidates: [candidate()],
      nextCursor: { createdAt: '2025-01-01T00:00:00.000Z', id: '\u{10000}' }
    })
    .mockResolvedValueOnce({ action: 'candidates', candidates: [] })
  expect(await readSynthesisCandidates(transport, ['paper-1'])).toHaveLength(1)
  expect(transport).toHaveBeenCalledTimes(3)
})
it('creates a note from checked snapshots and exports saved Markdown through the shared file saver', async () => {
  synthesis.mockImplementation(async (request) => {
    if (request.action === 'list') return { action: 'list', notes: [] }
    if (request.action === 'candidates') return { action: 'candidates', candidates: [candidate()] }
    if (request.action === 'create')
      return { action: 'create', note: { ...baseNote(), title: request.title } }
    if (request.action === 'export')
      return {
        action: 'export',
        filename: 'synthesis.md',
        markdown: '# Synthesis\n\nSaved excerpt'
      }
    throw new Error('Unexpected test request')
  })
  render(
    <LiteratureSynthesisWorkspace
      createFromSelection
      resolveSelectedItemIds={async () => ['paper-1']}
      onClose={vi.fn()}
    />
  )
  await screen.findByText(
    'Choose annotations to keep as snapshots. Source annotations and tags stay unchanged.'
  )
  fireEvent.change(screen.getByRole('textbox', { name: 'Note title' }), {
    target: { value: 'Cross-paper synthesis' }
  })
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'Create synthesis note (1)' }))
  await screen.findByRole('textbox', { name: /^(Overall|Excerpt) analysis$/ })
  expect(synthesis).toHaveBeenCalledWith({
    action: 'create',
    requestId: expect.any(String),
    title: 'Cross-paper synthesis',
    itemIds: ['paper-1'],
    excerpts: [
      {
        itemId: 'paper-1',
        versionId: 'pdf-1',
        annotationId: 'annotation-1',
        expectedUpdatedAt: '2026-01-01T00:00:00Z'
      }
    ]
  })
  chooseMoreAction('Export Markdown')
  await vi.waitFor(() =>
    expect(saveBlobFile).toHaveBeenCalledWith(
      expect.objectContaining({ suggestedName: 'synthesis.md', mimeType: 'text/markdown' })
    )
  )
  expect(new TextDecoder().decode(saveBlobFile.mock.calls[0]?.[0]?.data)).toBe(
    '# Synthesis\n\nSaved excerpt'
  )
  expect(synthesis).toHaveBeenLastCalledWith({
    action: 'export',
    noteId: 'note-1',
    expectedRevision: 1
  })
})
it('opens a clean direct analysis input for an excerpt-only note and drops empty draft input', async () => {
  synthesis.mockImplementation(async (request) => {
    if (request.action === 'list') return { action: 'list', notes: [] }
    if (request.action === 'candidates') return { action: 'candidates', candidates: [candidate()] }
    if (request.action === 'create') {
      return {
        action: 'create',
        note: { ...baseNote(), title: request.title, blocks: [baseNote().blocks[1]] }
      }
    }
    if (request.action === 'update') return { action: 'update', note: baseNote() }
    throw new Error('Unexpected test request')
  })
  render(
    <LiteratureSynthesisWorkspace
      createFromSelection
      resolveSelectedItemIds={async () => ['paper-1']}
      onClose={vi.fn()}
    />
  )
  await screen.findByText('Choose excerpts.')
  const quote = await screen.findByText('Quote annotation-1')
  const titleInput = screen.getByRole('textbox', { name: 'Note title' })
  const searchToggle = screen.getByText('Add reference')
  expect(
    Boolean(quote.compareDocumentPosition(titleInput) & Node.DOCUMENT_POSITION_FOLLOWING)
  ).toBe(true)
  expect(
    Boolean(titleInput.compareDocumentPosition(searchToggle) & Node.DOCUMENT_POSITION_FOLLOWING)
  ).toBe(true)
  fireEvent.change(titleInput, {
    target: { value: 'Direct analysis' }
  })
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'Create synthesis note (1)' }))
  const analysis = await screen.findByRole('textbox', { name: /^(Overall|Excerpt) analysis$/ })
  expect((analysis as HTMLTextAreaElement).value).toBe('')
  await vi.waitFor(() => expect(document.activeElement).toBe(analysis))
  expect(screen.getAllByRole('textbox', { name: 'Note title' })).toHaveLength(1)
  expect(screen.queryByText('Direct analysis')).toBeNull()
  expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.change(analysis, { target: { value: 'A useful analysis.' } })
  expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false)
  fireEvent.change(analysis, { target: { value: '' } })
  expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
  expect(synthesis.mock.calls.some(([request]) => request.action === 'update')).toBe(false)
})
it('reopens an excerpt-only saved note ready to write without making an empty paragraph dirty', async () => {
  synthesis.mockImplementation(async (request) => {
    if (request.action === 'list')
      return { action: 'list', notes: [synthesisNoteSummary(baseNote())] }
    if (request.action === 'read')
      return {
        action: 'read',
        note: { ...baseNote(), blocks: [baseNote().blocks[1]] }
      }
    if (request.action === 'export')
      return { action: 'export', filename: 'note.md', markdown: '# Saved note' }
    throw new Error('Unexpected test request')
  })
  render(<LiteratureSynthesisWorkspace resolveSelectedItemIds={async () => []} onClose={vi.fn()} />)
  await openEditor()
  const analysis = screen.getByRole('textbox', { name: /^(Overall|Excerpt) analysis$/ })
  await vi.waitFor(() => expect(document.activeElement).toBe(analysis))
  expect((analysis as HTMLTextAreaElement).value).toBe('')
  expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByRole('dialog', { name: 'Synthesis notes' })).not.toBeNull()
  expect(screen.queryByText('Saved excerpt')).toBeNull()
  chooseMoreAction('Export Markdown')
  await vi.waitFor(() => expect(saveBlobFile).toHaveBeenCalledOnce())
  expect(synthesis.mock.calls.some(([request]) => request.action === 'update')).toBe(false)
})
it('restores a clean focused overall input after saving only excerpt analysis and reopening', async () => {
  let stored: SynthesisNote = { ...baseNote(), blocks: [baseNote().blocks[1]] }
  synthesis.mockImplementation(async (request) => {
    if (request.action === 'list') return { action: 'list', notes: [synthesisNoteSummary(stored)] }
    if (request.action === 'read') return { action: 'read', note: stored }
    if (request.action === 'update') {
      stored = {
        ...stored,
        title: request.title,
        revision: stored.revision + 1,
        blocks: request.blocks.map((block) =>
          block.type === 'excerpt' ? baseNote().blocks[1] : block
        )
      }
      return { action: 'update', note: stored }
    }
    throw new Error('Unexpected test request')
  })
  render(<LiteratureSynthesisWorkspace resolveSelectedItemIds={async () => []} onClose={vi.fn()} />)
  await openEditor()
  fireEvent.click(screen.getByRole('button', { name: 'Write analysis below' }))
  fireEvent.change(await screen.findByRole('textbox', { name: 'Excerpt analysis' }), {
    target: { value: 'Interpret this excerpt only.' }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await vi.waitFor(() => expect(stored.revision).toBe(2))
  await vi.waitFor(() =>
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
  )
  expect(screen.getByRole('textbox', { name: 'Overall analysis' })).not.toBeNull()
  expect(stored.blocks).toHaveLength(2)
  expect(stored.blocks[1]).toMatchObject({ type: 'text', text: 'Interpret this excerpt only.' })

  await vi.waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Back to synthesis notes' }) as HTMLButtonElement)
        .disabled
    ).toBe(false)
  )
  fireEvent.click(screen.getByRole('button', { name: 'Back to synthesis notes' }))
  await openEditor()
  const overall = screen.getByRole('textbox', { name: 'Overall analysis' }) as HTMLTextAreaElement
  expect(overall.value).toBe('')
  expect(
    (screen.getByRole('textbox', { name: 'Excerpt analysis' }) as HTMLTextAreaElement).value
  ).toBe('Interpret this excerpt only.')
  await vi.waitFor(() => expect(document.activeElement).toBe(overall))
  expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.change(overall, { target: { value: 'Whole-note reasoning.' } })
  expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false)
  fireEvent.change(overall, { target: { value: '' } })
  expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
})
it('focuses existing overall analysis rather than an earlier excerpt analysis without adding a block', async () => {
  const stored: SynthesisNote = {
    ...baseNote(),
    blocks: [
      baseNote().blocks[1],
      { type: 'text', id: 'excerpt-analysis', text: 'Excerpt reasoning' },
      { type: 'heading', id: 'overall-heading', level: 2, text: 'Conclusions' },
      { type: 'text', id: 'overall-analysis', text: 'Whole-note reasoning' }
    ]
  }
  synthesis.mockImplementation(async (request) => {
    if (request.action === 'list') return { action: 'list', notes: [synthesisNoteSummary(stored)] }
    if (request.action === 'read') return { action: 'read', note: stored }
    throw new Error('Unexpected test request')
  })
  render(<LiteratureSynthesisWorkspace resolveSelectedItemIds={async () => []} onClose={vi.fn()} />)
  await openEditor()
  const overall = screen.getByRole('textbox', { name: 'Overall analysis' }) as HTMLTextAreaElement
  expect(overall.value).toBe('Whole-note reasoning')
  expect(screen.getAllByRole('textbox', { name: /^(Overall|Excerpt) analysis$/ })).toHaveLength(2)
  await vi.waitFor(() => expect(document.activeElement).toBe(overall))
  expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
})
it('appends the selected paper even when the note already cites 50 other papers', async () => {
  const note: SynthesisNote = {
    ...baseNote(),
    revision: 4,
    blocks: Array.from({ length: 50 }, (_, i) => ({
      type: 'excerpt',
      id: 'block-' + i,
      sourceStatus: 'current',
      snapshot: candidate('previous-' + i, 'annotation-' + i)
    }))
  }
  synthesis.mockImplementation(async (request) => {
    if (request.action === 'list')
      return { action: 'list', notes: [synthesisNoteSummary(baseNote())] }
    if (request.action === 'revision') return { action: 'revision', noteId: note.id, revision: 6 }
    if (request.action === 'read') return { action: 'read', note }
    if (request.action === 'candidates')
      return {
        action: 'candidates',
        candidates: [candidate('paper-2', 'new-annotation')]
      }
    if (request.action === 'append')
      return { action: 'append', note: { ...baseNote(), revision: 7 } }
    throw new Error('Unexpected test request')
  })
  render(
    <LiteratureSynthesisWorkspace
      resolveSelectedItemIds={async () => ['paper-2']}
      onClose={vi.fn()}
    />
  )
  await openEditor()
  fireEvent.click(screen.getByRole('button', { name: 'Append excerpts' }))
  await screen.findByText(
    'Choose annotations to keep as snapshots. Source annotations and tags stay unchanged.'
  )
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'Append excerpts (1)' }))
  await screen.findByRole('textbox', { name: /^(Overall|Excerpt) analysis$/ })
  expect(synthesis.mock.calls.filter(([request]) => request.action === 'read')).toHaveLength(1)
  expect(synthesis.mock.calls.filter(([request]) => request.action === 'revision')).toHaveLength(1)
  expect(synthesis).toHaveBeenCalledWith({
    action: 'append',
    requestId: expect.any(String),
    noteId: 'note-1',
    expectedRevision: 6,
    itemIds: ['paper-2'],
    excerpts: [
      {
        itemId: 'paper-2',
        versionId: 'pdf-1',
        annotationId: 'new-annotation',
        expectedUpdatedAt: '2026-01-01T00:00:00Z'
      }
    ]
  })
})
it.each(['changed', 'unverified'] as const)(
  'checks only one %s source while preserving draft prose, title and focus',
  async (sourceStatus) => {
    bookmark.mockReturnValue({
      id: 'preview',
      type: 'file',
      sessionId: 'literature',
      title: 'paper.pdf',
      format: 'pdf',
      path: candidate().annotation.target.source.path,
      name: 'paper.pdf'
    })
    preview.mockImplementation(({ onClose }: { onClose(): void }) => (
      <button onClick={onClose}>Close source preview</button>
    ))
    render(
      <LiteratureSynthesisWorkspace resolveSelectedItemIds={async () => []} onClose={vi.fn()} />
    )
    await openEditor()
    fireEvent.change(screen.getByRole('textbox', { name: /^(Overall|Excerpt) analysis$/ }), {
      target: { value: 'Still drafting' }
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'Note title' }), {
      target: { value: 'Unfinished title' }
    })
    synthesis.mockResolvedValueOnce({ action: 'source', block: { ...baseExcerpt(), sourceStatus } })
    const sourceButton = screen.getByRole('button', { name: /Title paper-1.*Page 1/ })
    fireEvent.click(sourceButton)
    await screen.findByRole('button', { name: 'Close source preview' })
    expect(bookmark).toHaveBeenCalledWith({
      id: 'annotation-1',
      kind: 'pdf',
      ...candidate().annotation.target
    })
    expect(preview.mock.calls.at(-1)?.[0].annotation).toEqual(candidate().annotation)
    expect(synthesis).toHaveBeenLastCalledWith({
      action: 'source',
      noteId: 'note-1',
      blockId: 'excerpt'
    })
    expect(synthesis.mock.calls.filter(([request]) => request.action === 'read')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Close source preview' }))
    await vi.waitFor(() => expect(document.activeElement).toBe(sourceButton))
    expect(
      (screen.getByRole('textbox', { name: /^(Overall|Excerpt) analysis$/ }) as HTMLTextAreaElement)
        .value
    ).toBe('Still drafting')
    expect((screen.getByRole('textbox', { name: 'Note title' }) as HTMLInputElement).value).toBe(
      'Unfinished title'
    )
    expect(screen.getByText(sourceStatus === 'changed' ? 'Changed' : 'Unverified')).not.toBeNull()
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.change(screen.getByRole('textbox', { name: /^(Overall|Excerpt) analysis$/ }), {
      target: { value: 'My reasoning' }
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'Note title' }), {
      target: { value: 'Synthesis draft' }
    })
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
  }
)
it('moves a block with keyboard-operable buttons and focuses the moved block at a boundary', async () => {
  render(<LiteratureSynthesisWorkspace resolveSelectedItemIds={async () => []} onClose={vi.fn()} />)
  await openEditor()
  fireEvent.pointerDown(screen.getAllByRole('button', { name: 'Block actions' })[0], {
    button: 0,
    ctrlKey: false,
    pointerType: 'mouse'
  })
  expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
    'Move up',
    'Move down',
    'Remove'
  ])
  expect(screen.getByRole('menuitem', { name: 'Move up' }).getAttribute('aria-disabled')).toBe(
    'true'
  )
  fireEvent.click(screen.getByRole('menuitem', { name: 'Move down' }))
  await vi.waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole('listitem', { name: 'Block 2 of 2' }))
  )
  expect(screen.getAllByRole('listitem')[0].textContent).toContain('Quote annotation-1')
  expect(
    (screen.getByRole('textbox', { name: /^(Overall|Excerpt) analysis$/ }) as HTMLTextAreaElement)
      .value
  ).toBe('My reasoning')
})
it('undoes a middle analysis removal in place without losing edits made before or after removal', async () => {
  const draft: SynthesisNote = {
    ...baseNote(),
    blocks: [
      baseNote().blocks[0],
      baseNote().blocks[1],
      { type: 'text', id: 'middle-analysis', text: 'Original middle analysis' },
      {
        type: 'excerpt',
        id: 'second-excerpt',
        snapshot: candidate('paper-2', 'annotation-2'),
        sourceStatus: 'current'
      },
      { type: 'text', id: 'final-analysis', text: 'Original final analysis' }
    ]
  }
  synthesis.mockImplementation(async (request) => {
    if (request.action === 'list') return { action: 'list', notes: [synthesisNoteSummary(draft)] }
    if (request.action === 'read') return { action: 'read', note: draft }
    throw new Error('Unexpected test request')
  })
  render(<LiteratureSynthesisWorkspace resolveSelectedItemIds={async () => []} onClose={vi.fn()} />)
  await openEditor()
  const textInputs = screen.getAllByRole('textbox', { name: /^(Overall|Excerpt) analysis$/ })
  fireEvent.change(textInputs[0], { target: { value: 'First analysis edited before removal' } })
  fireEvent.change(textInputs[1], { target: { value: 'Middle analysis edited before removal' } })
  fireEvent.pointerDown(
    within(screen.getByRole('listitem', { name: 'Block 3 of 5' })).getByRole('button', {
      name: 'Block actions'
    }),
    { button: 0, ctrlKey: false, pointerType: 'mouse' }
  )
  fireEvent.click(screen.getByRole('menuitem', { name: 'Remove' }))
  expect(screen.getAllByRole('textbox', { name: /^(Overall|Excerpt) analysis$/ })).toHaveLength(2)
  fireEvent.change(screen.getAllByRole('textbox', { name: /^(Overall|Excerpt) analysis$/ })[1], {
    target: { value: 'Final analysis edited after removal' }
  })

  fireEvent.click(screen.getByRole('button', { name: 'Undo' }))

  expect(screen.getAllByRole('listitem').map((block) => block.dataset.synthesisBlock)).toEqual([
    'prose',
    'excerpt',
    'middle-analysis',
    'second-excerpt',
    'final-analysis'
  ])
  expect(
    screen
      .getAllByRole('textbox', { name: /^(Overall|Excerpt) analysis$/ })
      .map((input) => (input as HTMLTextAreaElement).value)
  ).toEqual([
    'First analysis edited before removal',
    'Middle analysis edited before removal',
    'Final analysis edited after removal'
  ])
  expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
  expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false)
  expect(synthesis.mock.calls.map(([request]) => request.action)).toEqual(['list', 'read'])
})
it('clears the latest removal undo after saving and keeps the removed analysis out of the save', async () => {
  const draft: SynthesisNote = {
    ...baseNote(),
    blocks: [
      baseNote().blocks[0],
      { type: 'text', id: 'middle-analysis', text: 'Analysis to remove' },
      baseNote().blocks[1]
    ]
  }
  synthesis.mockImplementation(async (request) => {
    if (request.action === 'list') return { action: 'list', notes: [synthesisNoteSummary(draft)] }
    if (request.action === 'read') return { action: 'read', note: draft }
    if (request.action === 'update') {
      return {
        action: 'update',
        note: {
          ...draft,
          revision: 2,
          blocks: request.blocks.map((block) =>
            block.type === 'excerpt' ? draft.blocks.find((entry) => entry.id === block.id)! : block
          )
        }
      }
    }
    throw new Error('Unexpected test request')
  })
  render(<LiteratureSynthesisWorkspace resolveSelectedItemIds={async () => []} onClose={vi.fn()} />)
  await openEditor()
  fireEvent.pointerDown(
    within(screen.getByRole('listitem', { name: 'Block 2 of 3' })).getByRole('button', {
      name: 'Block actions'
    }),
    { button: 0, ctrlKey: false, pointerType: 'mouse' }
  )
  fireEvent.click(screen.getByRole('menuitem', { name: 'Remove' }))
  expect(screen.getByRole('button', { name: 'Undo' })).not.toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await screen.findByText('Saved', { exact: true })

  expect(synthesis).toHaveBeenLastCalledWith(
    expect.objectContaining({
      action: 'update',
      expectedRevision: 1,
      blocks: [
        { type: 'text', id: 'prose', text: 'My reasoning' },
        { type: 'excerpt', id: 'excerpt' }
      ]
    })
  )
  expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
  expect(screen.queryByDisplayValue('Analysis to remove')).toBeNull()
  expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.change(screen.getByRole('textbox', { name: /^(Overall|Excerpt) analysis$/ }), {
    target: { value: 'A new edit after saving' }
  })
  expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
})
const dragTransfer = (): DataTransfer => {
  const values = new Map<string, string>()
  return {
    get types() {
      return [...values.keys()]
    },
    setData(type: string, value: string) {
      values.set(type, value)
    },
    getData: (type: string) => values.get(type) ?? '',
    setDragImage: vi.fn()
  } as unknown as DataTransfer
}
const dragAt = (element: Element, dataTransfer: DataTransfer, clientY: number): void => {
  const event = createEvent.dragOver(element, { dataTransfer })
  Object.defineProperty(event, 'clientY', { value: clientY })
  fireEvent(element, event)
}
const measureBlocks = (): HTMLElement[] => {
  const blocks = screen.getAllByRole('listitem')
  blocks.forEach((block, index) => {
    vi.spyOn(block, 'getBoundingClientRect').mockReturnValue({
      top: index * 112,
      left: 0,
      height: 100,
      width: 600,
      bottom: index * 112 + 100,
      right: 600,
      x: 0,
      y: index * 112,
      toJSON: () => ({})
    })
  })
  return blocks
}
it('reorders from a handle across a block gap only on drop and saves the new draft order', async () => {
  const draft: SynthesisNote = {
    ...baseNote(),
    blocks: [...baseNote().blocks, { type: 'text', id: 'analysis', text: 'A second analysis' }]
  }
  synthesis.mockImplementation(async (request) => {
    if (request.action === 'list') return { action: 'list', notes: [synthesisNoteSummary(draft)] }
    if (request.action === 'read') return { action: 'read', note: draft }
    if (request.action === 'update')
      return {
        action: 'update',
        note: {
          ...draft,
          revision: 2,
          blocks: request.blocks.map((block) =>
            draft.blocks.find((entry) => entry.id === block.id)!
          )
        }
      }
    throw new Error('Unexpected request')
  })
  render(<LiteratureSynthesisWorkspace resolveSelectedItemIds={async () => []} onClose={vi.fn()} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Synthesis draft' }))
  await screen.findAllByRole('textbox', { name: /^(Overall|Excerpt) analysis$/ })
  const blocks = measureBlocks()
  const list = blocks[0].parentElement!
  expect(blocks.every((block) => !block.draggable)).toBe(true)
  const dataTransfer = dragTransfer()
  fireEvent.dragStart(screen.getAllByRole('button', { name: 'Drag to reorder' })[2], {
    dataTransfer
  })
  dragAt(list, dataTransfer, 106)
  expect(list.querySelector('[data-synthesis-drop-indicator]')).not.toBeNull()
  expect(screen.getAllByRole('listitem').map((block) => block.dataset.synthesisBlock)).toEqual([
    'prose',
    'excerpt',
    'analysis'
  ])
  expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.drop(list, { dataTransfer })
  expect(screen.getAllByRole('listitem').map((block) => block.dataset.synthesisBlock)).toEqual([
    'prose',
    'analysis',
    'excerpt'
  ])
  expect(list.querySelector('[data-synthesis-drop-indicator]')).toBeNull()
  expect(synthesis.mock.calls.some(([request]) => request.action === 'update')).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await screen.findByText('Saved', { exact: true })
  expect(synthesis).toHaveBeenCalledWith(
    expect.objectContaining({
      action: 'update',
      blocks: [draft.blocks[0], draft.blocks[2], { type: 'excerpt', id: 'excerpt' }]
    })
  )
})
it('ignores external drops and clears canceled, invalid, and no-op block drags without dirtying', async () => {
  const onClose = vi.fn()
  render(<LiteratureSynthesisWorkspace resolveSelectedItemIds={async () => []} onClose={onClose} />)
  await openEditor()
  const blocks = measureBlocks()
  const list = blocks[0].parentElement!
  const handle = screen.getAllByRole('button', { name: 'Drag to reorder' })[0]
  const dataTransfer = dragTransfer()
  dragAt(list, dataTransfer, 180)
  fireEvent.drop(list, { dataTransfer })
  expect(list.querySelector('[data-synthesis-drop-indicator]')).toBeNull()
  fireEvent.dragStart(handle, { dataTransfer })
  dragAt(list, dataTransfer, 180)
  fireEvent.dragLeave(list, { relatedTarget: document.body })
  expect(list.querySelector('[data-synthesis-drop-indicator]')).toBeNull()
  fireEvent.dragEnd(handle, { dataTransfer })
  fireEvent.dragStart(handle, { dataTransfer })
  dragAt(list, dataTransfer, 180)
  fireEvent.drop(list, { dataTransfer: dragTransfer() })
  expect(list.querySelector('[data-synthesis-drop-indicator]')).toBeNull()
  fireEvent.dragStart(handle, { dataTransfer })
  dragAt(list, dataTransfer, 180)
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(list.querySelector('[data-synthesis-drop-indicator]')).toBeNull()
  expect(onClose).not.toHaveBeenCalled()
  fireEvent.dragStart(handle, { dataTransfer })
  dragAt(list, dataTransfer, 10)
  fireEvent.drop(list, { dataTransfer })
  expect(screen.getAllByRole('listitem').map((block) => block.dataset.synthesisBlock)).toEqual([
    'prose',
    'excerpt'
  ])
  expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
  expect(onClose).not.toHaveBeenCalled()
})
it('adds and focuses a trailing paragraph even with an empty overall analysis', async () => {
  const note = { ...baseNote(), blocks: [baseExcerpt(), { ...baseExcerpt(), id: 'second' }] }
  synthesis.mockImplementation(async (request) => {
    if (request.action === 'list') return { action: 'list', notes: [synthesisNoteSummary(note)] }
    if (request.action === 'read') return { action: 'read', note }
    throw new Error('Unexpected request')
  })
  render(<LiteratureSynthesisWorkspace resolveSelectedItemIds={async () => []} onClose={vi.fn()} />)
  await openEditor()
  chooseMoreAction('Add paragraph')
  const last = screen.getByRole('listitem', { name: 'Block 4 of 4' })
  const input = within(last).getByRole('textbox', { name: 'Excerpt analysis' })
  await vi.waitFor(() => expect(document.activeElement).toBe(input))
  chooseMoreAction('Add paragraph')
  await vi.waitFor(() => expect(document.activeElement).toBe(input))
  expect(screen.getAllByRole('listitem')).toHaveLength(4)
})

it('focuses a new heading chosen from more actions and keeps the note clean until typing', async () => {
  render(<LiteratureSynthesisWorkspace resolveSelectedItemIds={async () => []} onClose={vi.fn()} />)
  await openEditor()
  chooseMoreAction('Add heading')
  const headingInput = screen.getByRole('textbox', { name: 'Heading' })
  await vi.waitFor(() => expect(document.activeElement).toBe(headingInput))
  expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.change(headingInput, { target: { value: 'A comparison' } })
  expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false)
})
const excerptOnlyNoteAt199Blocks = (): SynthesisNote => ({
  ...baseNote(),
  blocks: Array.from({ length: 199 }, (_, index) => ({
    type: 'excerpt' as const,
    id: `excerpt-${index}`,
    snapshot: candidate('paper-1', `annotation-${index}`),
    sourceStatus: 'current' as const
  }))
})
const synthesisBlock = (id: string): HTMLElement =>
  document.querySelector<HTMLElement>(`[data-synthesis-block="${id}"]`)!
const removeSynthesisBlock = (element: HTMLElement): void => {
  fireEvent.pointerDown(within(element).getByRole('button', { name: 'Block actions' }), {
    button: 0,
    ctrlKey: false,
    pointerType: 'mouse'
  })
  fireEvent.click(screen.getByRole('menuitem', { name: 'Remove' }))
}
it('uses the last actual block for analysis under the second excerpt and prevents filling other temporary inputs past 200', async () => {
  const stored = excerptOnlyNoteAt199Blocks()
  synthesis.mockImplementation(async (request) => {
    if (request.action === 'list') return { action: 'list', notes: [synthesisNoteSummary(stored)] }
    if (request.action === 'read') return { action: 'read', note: stored }
    if (request.action === 'update')
      return {
        action: 'update',
        note: {
          ...stored,
          revision: 2,
          blocks: request.blocks.map((block) =>
            block.type === 'excerpt' ? stored.blocks.find((entry) => entry.id === block.id)! : block
          )
        }
      }
    throw new Error('Unexpected test request')
  })
  render(<LiteratureSynthesisWorkspace resolveSelectedItemIds={async () => []} onClose={vi.fn()} />)
  await openEditor()
  const overall = screen.getByRole('textbox', { name: 'Overall analysis' }) as HTMLTextAreaElement
  expect(screen.queryByText('This note has reached the 200-block limit.')).toBeNull()
  const firstExcerpt = synthesisBlock('excerpt-0')
  const secondExcerpt = synthesisBlock('excerpt-1')
  fireEvent.click(within(firstExcerpt).getByRole('button', { name: 'Write analysis below' }))
  const firstAnalysis = within(firstExcerpt.nextElementSibling as HTMLElement).getByRole(
    'textbox'
  ) as HTMLTextAreaElement
  fireEvent.click(within(secondExcerpt).getByRole('button', { name: 'Write analysis below' }))
  const secondAnalysis = within(secondExcerpt.nextElementSibling as HTMLElement).getByRole(
    'textbox'
  ) as HTMLTextAreaElement
  fireEvent.click(within(firstExcerpt).getByRole('button', { name: 'Write analysis below' }))
  expect(screen.getAllByRole('textbox', { name: /^(Overall|Excerpt) analysis$/ })).toHaveLength(3)
  fireEvent.change(secondAnalysis, { target: { value: 'Analysis of the second excerpt' } })
  expect(screen.getByText('This note has reached the 200-block limit.')).not.toBeNull()
  expect(overall.disabled).toBe(true)
  expect(firstAnalysis.disabled).toBe(true)
  expect(secondAnalysis.disabled).toBe(false)
  fireEvent.change(firstAnalysis, { target: { value: 'An invalid 201st actual block' } })
  expect(firstAnalysis.value).toBe('')
  fireEvent.change(secondAnalysis, { target: { value: '' } })
  expect(overall.disabled).toBe(false)
  expect(firstAnalysis.disabled).toBe(false)
  fireEvent.change(secondAnalysis, { target: { value: 'Analysis of the second excerpt' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await vi.waitFor(() =>
    expect(synthesis.mock.calls.some(([r]) => r.action === 'update')).toBe(true)
  )
  const request = synthesis.mock.calls.find(([r]) => r.action === 'update')![0]
  if (request.action !== 'update') throw new Error('Expected update')
  expect(request.blocks).toHaveLength(200)
  expect(request.blocks.slice(0, 3)).toEqual([
    { type: 'excerpt', id: 'excerpt-0' },
    { type: 'excerpt', id: 'excerpt-1' },
    expect.objectContaining({ type: 'text', text: 'Analysis of the second excerpt' })
  ])
  expect(request.blocks.filter((block) => block.type === 'text')).toHaveLength(1)
})
it('uses actual block capacity for undo and lets empty temporary blocks return without consuming a slot', async () => {
  const stored = excerptOnlyNoteAt199Blocks()
  synthesis.mockImplementation(async (request) => {
    if (request.action === 'list') return { action: 'list', notes: [synthesisNoteSummary(stored)] }
    if (request.action === 'read') return { action: 'read', note: stored }
    throw new Error('Unexpected test request')
  })
  render(<LiteratureSynthesisWorkspace resolveSelectedItemIds={async () => []} onClose={vi.fn()} />)
  await openEditor()
  removeSynthesisBlock(synthesisBlock('excerpt-0'))
  const source = synthesisBlock('excerpt-1')
  fireEvent.click(within(source).getByRole('button', { name: 'Write analysis below' }))
  const analysis = within(source.nextElementSibling as HTMLElement).getByRole('textbox')
  fireEvent.change(analysis, { target: { value: 'Actual analysis' } })
  expect((screen.getByRole('button', { name: 'Undo' }) as HTMLButtonElement).disabled).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
  expect(synthesisBlock('excerpt-0')).not.toBeNull()
  expect(screen.getByText('This note has reached the 200-block limit.')).not.toBeNull()

  let overall = screen.getByRole('textbox', { name: 'Overall analysis' }) as HTMLTextAreaElement
  removeSynthesisBlock(overall.closest('li')!)
  expect((screen.getByRole('button', { name: 'Undo' }) as HTMLButtonElement).disabled).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
  overall = screen.getByRole('textbox', { name: 'Overall analysis' }) as HTMLTextAreaElement
  expect(overall.value).toBe('')
  expect(overall.disabled).toBe(true)

  removeSynthesisBlock(synthesisBlock('excerpt-0'))
  fireEvent.change(overall, { target: { value: 'Use the freed actual slot' } })
  expect((screen.getByRole('button', { name: 'Undo' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
  expect(
    screen
      .getAllByRole('listitem')
      .some((element) => element.dataset.synthesisBlock === 'excerpt-0')
  ).toBe(false)
})
it('explains the durable block-limit rejection after appending and retains checked candidates', async () => {
  const fullNote: SynthesisNote = {
    ...baseNote(),
    blocks: [
      { type: 'text', id: 'prose', text: 'My reasoning' },
      ...Array.from({ length: 199 }, (_, i) => ({
        type: 'heading' as const,
        id: `heading-${i}`,
        level: 2 as const,
        text: 'Section'
      }))
    ]
  }
  synthesis.mockImplementation(async (request) => {
    if (request.action === 'list')
      return { action: 'list', notes: [synthesisNoteSummary(fullNote)] }
    if (request.action === 'revision')
      return { action: 'revision', noteId: fullNote.id, revision: fullNote.revision }
    if (request.action === 'read') return { action: 'read', note: fullNote }
    if (request.action === 'candidates')
      return { action: 'candidates', candidates: [candidate('paper-2', 'annotation-2')] }
    if (request.action === 'append')
      return { action: 'append-rejected', reason: 'block-limit', maxBlocks: 200 }
    throw new Error('Unexpected test request')
  })
  render(
    <LiteratureSynthesisWorkspace
      resolveSelectedItemIds={async () => ['paper-2']}
      onClose={vi.fn()}
    />
  )
  await openEditor()
  fireEvent.click(screen.getByRole('button', { name: 'Append excerpts' }))
  await screen.findByText(
    'Choose annotations to keep as snapshots. Source annotations and tags stay unchanged.'
  )
  expect(screen.getByText('Choose excerpts.')).not.toBeNull()
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'Append excerpts (1)' }))
  await screen.findByText('This note has reached the 200-block limit.')
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true)
  expect(synthesis.mock.calls.some(([request]) => request.action === 'append')).toBe(true)
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Append excerpts (1)' })).not.toBeNull()
})
it('submits an alias and new excerpt at 199 blocks so the durable canonical count decides capacity', async () => {
  const note: SynthesisNote = {
    ...baseNote(),
    blocks: [
      ...baseNote().blocks,
      ...Array.from({ length: 197 }, (_, index) => ({
        type: 'heading' as const,
        id: `heading-${index}`,
        level: 2 as const,
        text: 'Section'
      }))
    ]
  }
  const alias = candidate('paper-1', 'retained-annotation')
  const added = candidate('paper-2', 'new-annotation')
  synthesis.mockImplementation(async (request) => {
    if (request.action === 'list') return { action: 'list', notes: [synthesisNoteSummary(note)] }
    if (request.action === 'read') return { action: 'read', note }
    if (request.action === 'revision')
      return { action: 'revision', noteId: note.id, revision: note.revision }
    if (request.action === 'candidates') return { action: 'candidates', candidates: [alias, added] }
    if (request.action === 'append')
      return {
        action: 'append',
        note: {
          ...note,
          revision: 2,
          blocks: [
            ...note.blocks,
            { type: 'excerpt', id: 'added', snapshot: added, sourceStatus: 'current' }
          ]
        }
      }
    throw new Error('Unexpected test request')
  })
  render(
    <LiteratureSynthesisWorkspace
      resolveSelectedItemIds={async () => ['paper-1', 'paper-2']}
      onClose={vi.fn()}
    />
  )
  await openEditor()
  fireEvent.click(screen.getByRole('button', { name: 'Append excerpts' }))
  await screen.findByText(
    'Choose annotations to keep as snapshots. Source annotations and tags stay unchanged.'
  )
  for (const checkbox of screen.getAllByRole('checkbox')) fireEvent.click(checkbox)
  fireEvent.click(screen.getByRole('button', { name: 'Append excerpts (2)' }))
  await vi.waitFor(() =>
    expect(synthesis).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'append',
        expectedRevision: 1,
        excerpts: [alias, added].map(({ itemId, versionId, annotationId, annotation }) => ({
          itemId,
          versionId,
          annotationId,
          expectedUpdatedAt: annotation.updatedAt
        }))
      })
    )
  )
  await screen.findByRole('textbox', { name: 'Overall analysis' })
  expect(screen.getByRole('button', { name: 'Save' })).not.toBeNull()
})
it('deduplicates shared annotations when adding another reference before selecting visible excerpts', async () => {
  const shared = { ...candidate('paper-2'), versionId: 'another-version' }
  search.mockResolvedValue({
    entries: [{ id: 'paper-2', item: { title: 'Shared attachment owner' } }]
  })
  synthesis.mockImplementation(async (request) => {
    if (request.action === 'list') return { action: 'list', notes: [] }
    if (request.action === 'candidates')
      return {
        action: 'candidates',
        candidates: request.itemIds[0] === 'paper-2' ? [shared] : [candidate()]
      }
    if (request.action === 'create') return { action: 'create', note: baseNote() }
    throw new Error('Unexpected test request')
  })
  render(
    <LiteratureSynthesisWorkspace
      createFromSelection
      resolveSelectedItemIds={async () => ['paper-1']}
      onClose={vi.fn()}
    />
  )
  const searchToggle = await screen.findByText('Add reference')
  const searchSection = searchToggle.closest('details') as HTMLDetailsElement
  expect(searchSection.open).toBe(false)
  fireEvent.click(searchToggle)
  expect(searchSection.open).toBe(true)
  await screen.findByRole('button', { name: 'Find references' })
  expect(
    screen.getByText('Search your library for references to add to this synthesis note.')
  ).not.toBeNull()
  expect(
    screen.getByRole('textbox', { name: 'Find references to add' }).getAttribute('aria-describedby')
  ).toBe('synthesis-reference-search-help')
  fireEvent.click(screen.getByRole('button', { name: 'Find references' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Shared attachment owner' }))
  await screen.findByText(
    'No unique annotations found for this reference. Shared PDF annotations appear once.'
  )
  expect(screen.getAllByRole('checkbox')).toHaveLength(1)
  fireEvent.change(screen.getByRole('textbox', { name: 'Note title' }), {
    target: { value: 'Shared source' }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Select current results' }))
  fireEvent.click(screen.getByRole('button', { name: 'Create synthesis note (1)' }))
  await screen.findByRole('textbox', { name: /^(Overall|Excerpt) analysis$/ })
  const createRequest = synthesis.mock.calls
    .map(([request]) => request)
    .find((request) => request.action === 'create')
  expect(createRequest?.action === 'create' && createRequest.excerpts).toHaveLength(1)
})
it('shows region-selected source text as an immutable excerpt', () => {
  const region = candidate()
  region.annotation = {
    ...region.annotation,
    kind: 'area',
    target: {
      ...region.annotation.target,
      selector: {
        kind: 'region',
        pageNumber: 2,
        rect: { x: 0.1, y: 0.1, width: 0.5, height: 0.2 },
        pageRotation: 0,
        coordinateVersion: 1,
        text: 'Region passage preserved'
      }
    }
  }
  render(
    <SynthesisCandidates
      append
      itemIds={['paper-1']}
      candidates={[region]}
      titles={{}}
      busy={false}
      onCancel={vi.fn()}
      onConfirm={vi.fn()}
    />
  )
  expect(screen.getByText('Region passage preserved').tagName).toBe('BLOCKQUOTE')
})
it('recognizes a committed save whose response was lost without writing a second revision', async () => {
  let durable = baseNote()
  let writes = 0
  synthesis.mockImplementation(async (request) => {
    if (request.action === 'list') return { action: 'list', notes: [synthesisNoteSummary(durable)] }
    if (request.action === 'read') return { action: 'read', note: structuredClone(durable) }
    if (request.action === 'update') {
      expect(request.expectedRevision).toBe(durable.revision)
      writes++
      durable = {
        ...durable,
        revision: durable.revision + 1,
        lastMutation: { id: request.requestId!, fingerprint: 'fixture' },
        blocks: request.blocks.map((block) =>
          block.type === 'excerpt' ? durable.blocks.find((saved) => saved.id === block.id)! : block
        )
      }
      throw new Error('Response lost after commit')
    }
    throw new Error('Unexpected request')
  })
  render(<LiteratureSynthesisWorkspace resolveSelectedItemIds={async () => []} onClose={vi.fn()} />)
  await openEditor()
  fireEvent.change(screen.getByRole('textbox', { name: /^(Overall|Excerpt) analysis$/ }), {
    target: { value: 'Durably saved' }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await screen.findByText('Saved')
  expect(writes).toBe(1)
  expect(durable.revision).toBe(2)
  expect(screen.queryByText('Unsaved changes. Save before appending or exporting.')).toBeNull()
})
it('recovers an earlier committed save before submitting newly edited prose on its durable revision', async () => {
  let durable = baseNote()
  let loseRecoveryRead = false
  const updates: Array<Extract<LiteratureSynthesisRequest, { action: 'update' }>> = []
  synthesis.mockImplementation(async (request) => {
    if (request.action === 'list') return { action: 'list', notes: [synthesisNoteSummary(durable)] }
    if (request.action === 'read') {
      if (loseRecoveryRead) {
        loseRecoveryRead = false
        throw new Error('Read transport unavailable')
      }
      return { action: 'read', note: structuredClone(durable) }
    }
    if (request.action === 'update') {
      if (request.expectedRevision !== durable.revision) throw new Error('Revision conflict')
      updates.push(request)
      durable = {
        ...durable,
        revision: durable.revision + 1,
        lastMutation: { id: request.requestId!, fingerprint: 'fixture' },
        blocks: request.blocks.map((block) =>
          block.type === 'excerpt' ? durable.blocks.find((saved) => saved.id === block.id)! : block
        )
      }
      if (updates.length === 1) {
        loseRecoveryRead = true
        throw new Error('Committed response lost')
      }
      return { action: 'update', note: structuredClone(durable) }
    }
    throw new Error('Unexpected request')
  })
  render(<LiteratureSynthesisWorkspace resolveSelectedItemIds={async () => []} onClose={vi.fn()} />)
  await openEditor()
  fireEvent.change(screen.getByRole('textbox', { name: /^(Overall|Excerpt) analysis$/ }), {
    target: { value: 'First committed draft' }
  })
  fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))
  await screen.findByText(
    'The note could not be saved. Your changes are kept. Retry, or copy your text before closing.'
  )
  fireEvent.change(screen.getByRole('textbox', { name: /^(Overall|Excerpt) analysis$/ }), {
    target: { value: 'Newer edited draft' }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await screen.findByText('Saved')
  expect(updates.map((request) => request.expectedRevision)).toEqual([1, 2])
  expect(updates[0].requestId).not.toBe(updates[1].requestId)
  expect(durable.revision).toBe(3)
  expect((durable.blocks[0] as { text: string }).text).toBe('Newer edited draft')
  expect(
    (screen.getByRole('textbox', { name: /^(Overall|Excerpt) analysis$/ }) as HTMLTextAreaElement)
      .value
  ).toBe('Newer edited draft')
})
it('reuses an unchanged failed save request ID and never rebases over an unknown writer receipt', async () => {
  let durable = baseNote()
  const updates: Array<Extract<LiteratureSynthesisRequest, { action: 'update' }>> = []
  synthesis.mockImplementation(async (request) => {
    if (request.action === 'list') return { action: 'list', notes: [synthesisNoteSummary(durable)] }
    if (request.action === 'read') return { action: 'read', note: structuredClone(durable) }
    if (request.action === 'update') {
      expect(request.expectedRevision).toBe(durable.revision)
      updates.push(request)
      if (updates.length === 1) throw new Error('Write never reached server')
      durable = {
        ...durable,
        revision: 2,
        lastMutation: { id: 'another-editor', fingerprint: 'fixture' }
      }
      throw new Error('Another editor won the write')
    }
    throw new Error('Unexpected request')
  })
  render(<LiteratureSynthesisWorkspace resolveSelectedItemIds={async () => []} onClose={vi.fn()} />)
  await openEditor()
  fireEvent.change(screen.getByRole('textbox', { name: /^(Overall|Excerpt) analysis$/ }), {
    target: { value: 'Retained draft' }
  })
  fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))
  await screen.findByText(
    'The note could not be saved. Your changes are kept. Retry, or copy your text before closing.'
  )
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await vi.waitFor(() => expect(updates).toHaveLength(2))
  await screen.findByText(
    'The note could not be saved. Your changes are kept. Retry, or copy your text before closing.'
  )
  expect(updates[0].requestId).toBe(updates[1].requestId)
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await screen.findByText(
    'The note could not be saved. Your changes are kept. Retry, or copy your text before closing.'
  )
  expect(updates).toHaveLength(2)
  expect(
    (screen.getByRole('textbox', { name: /^(Overall|Excerpt) analysis$/ }) as HTMLTextAreaElement)
      .value
  ).toBe('Retained draft')
})
it('replays the exact pending append after response loss even if its source has disappeared', async () => {
  let durable = baseNote()
  let sourceAvailable = true
  let loseRecoveryRead = false
  const appends: Array<Extract<LiteratureSynthesisRequest, { action: 'append' }>> = []
  synthesis.mockImplementation(async (request) => {
    if (request.action === 'list') return { action: 'list', notes: [synthesisNoteSummary(durable)] }
    if (request.action === 'revision')
      return { action: 'revision', noteId: durable.id, revision: durable.revision }
    if (request.action === 'read') {
      if (loseRecoveryRead) {
        loseRecoveryRead = false
        throw new Error('Recovery read transport unavailable')
      }
      return { action: 'read', note: structuredClone(durable) }
    }
    if (request.action === 'candidates')
      return {
        action: 'candidates',
        candidates: [candidate('paper-2', 'annotation-2')]
      }
    if (request.action === 'append') {
      appends.push(request)
      if (durable.lastMutation?.id === request.requestId)
        return { action: 'append', note: structuredClone(durable) }
      if (!sourceAvailable || request.expectedRevision !== durable.revision)
        throw new Error('Missing source or revision conflict')
      durable = {
        ...durable,
        revision: 2,
        lastMutation: { id: request.requestId!, fingerprint: 'fixture' },
        blocks: [
          ...durable.blocks,
          {
            type: 'excerpt',
            id: 'second',
            snapshot: candidate('paper-2', 'annotation-2'),
            sourceStatus: 'current'
          }
        ]
      }
      sourceAvailable = false
      loseRecoveryRead = true
      throw new Error('Committed append response lost')
    }
    throw new Error('Unexpected request')
  })
  render(
    <LiteratureSynthesisWorkspace
      resolveSelectedItemIds={async () => ['paper-2']}
      onClose={vi.fn()}
    />
  )
  await openEditor()
  fireEvent.click(screen.getByRole('button', { name: 'Append excerpts' }))
  await screen.findByRole('button', { name: 'Append excerpts (0)' })
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'Append excerpts (1)' }))
  await screen.findByText('The excerpts could not be saved. Your selection is kept.')
  fireEvent.click(screen.getByRole('button', { name: 'Append excerpts (1)' }))
  await screen.findByRole('textbox', { name: /^(Overall|Excerpt) analysis$/ })
  expect(appends).toHaveLength(2)
  expect(appends[0]).toEqual(appends[1])
  expect(appends[0].expectedRevision).toBe(1)
  expect(durable.revision).toBe(2)
  expect(screen.getByText('Quote annotation-2')).not.toBeNull()
})
it('creates two distinct notes after two confirmed submissions with identical inputs', async () => {
  const committed = new Map<string, SynthesisNote>()
  const creates: Array<Extract<LiteratureSynthesisRequest, { action: 'create' }>> = []
  synthesis.mockImplementation(async (request) => {
    if (request.action === 'list')
      return { action: 'list', notes: Array.from(committed.values(), synthesisNoteSummary) }
    if (request.action === 'candidates') return { action: 'candidates', candidates: [candidate()] }
    if (request.action === 'create') {
      creates.push(request)
      if (!committed.has(request.requestId!))
        committed.set(request.requestId!, {
          ...baseNote(),
          id: `created-${committed.size}`,
          title: request.title
        })
      return { action: 'create', note: committed.get(request.requestId!)! }
    }
    throw new Error('Unexpected request')
  })
  render(
    <LiteratureSynthesisWorkspace
      createFromSelection
      resolveSelectedItemIds={async () => ['paper-1']}
      onClose={vi.fn()}
    />
  )
  for (let index = 0; index < 2; index++) {
    await screen.findByRole('button', { name: 'Create synthesis note (0)' })
    fireEvent.change(screen.getByRole('textbox', { name: 'Note title' }), {
      target: { value: 'Identical requested title' }
    })
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Create synthesis note (1)' }))
    await screen.findByRole('textbox', { name: /^(Overall|Excerpt) analysis$/ })
    fireEvent.click(screen.getByRole('button', { name: 'Back to synthesis notes' }))
    if (index === 0)
      fireEvent.click(screen.getByRole('button', { name: 'Create from selected references' }))
  }
  expect(creates).toHaveLength(2)
  expect(creates[0].requestId).not.toBe(creates[1].requestId)
  expect(committed.size).toBe(2)
})
it('uses the current dirty guard when the native Escape listener retains its initial busy callback', async () => {
  const close = vi.fn()
  render(<LiteratureSynthesisWorkspace resolveSelectedItemIds={async () => []} onClose={close} />)
  await openEditor()
  fireEvent.change(screen.getByRole('textbox', { name: /^(Overall|Excerpt) analysis$/ }), {
    target: { value: 'Escape-protected draft' }
  })
  screen.getByRole('textbox', { name: /^(Overall|Excerpt) analysis$/ }).focus()
  fireEvent.keyDown(document, { key: 'Escape' })
  await screen.findByRole('alertdialog', { name: 'Discard unsaved changes?' })
  expect(close).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }))
  expect(
    (screen.getByRole('textbox', { name: /^(Overall|Excerpt) analysis$/ }) as HTMLTextAreaElement)
      .value
  ).toBe('Escape-protected draft')
})

it('disables the candidate title while its create request is pending', async () => {
  let completeCreate: ((result: LiteratureSynthesisResult) => void) | undefined
  synthesis.mockImplementation(async (request) => {
    if (request.action === 'list') return { action: 'list', notes: [] }
    if (request.action === 'candidates') return { action: 'candidates', candidates: [candidate()] }
    if (request.action === 'create')
      return new Promise((resolve) => {
        completeCreate = resolve
      })
    throw new Error('Unexpected request')
  })
  render(
    <LiteratureSynthesisWorkspace
      createFromSelection
      resolveSelectedItemIds={async () => ['paper-1']}
      onClose={vi.fn()}
    />
  )
  const title = await screen.findByRole('textbox', { name: 'Note title' })
  fireEvent.change(title, { target: { value: 'Submitted title' } })
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'Create synthesis note (1)' }))
  await vi.waitFor(() => expect(completeCreate).toBeDefined())
  expect((title as HTMLInputElement).disabled).toBe(true)
  completeCreate!({ action: 'create', note: { ...baseNote(), title: 'Submitted title' } })
  await screen.findByRole('textbox', { name: /^(Overall|Excerpt) analysis$/ })
  expect((screen.getByRole('textbox', { name: 'Note title' }) as HTMLInputElement).value).toBe(
    'Submitted title'
  )
})

it('keeps a conflicted append selection and retries on the latest revision only after another confirmation', async () => {
  let durable = baseNote()
  const appends: Array<Extract<LiteratureSynthesisRequest, { action: 'append' }>> = []
  synthesis.mockImplementation(async (request) => {
    if (request.action === 'list') return { action: 'list', notes: [synthesisNoteSummary(durable)] }
    if (request.action === 'revision')
      return { action: 'revision', noteId: durable.id, revision: durable.revision }
    if (request.action === 'read') return { action: 'read', note: structuredClone(durable) }
    if (request.action === 'candidates')
      return {
        action: 'candidates',
        candidates: [candidate('paper-2', 'annotation-2')]
      }
    if (request.action === 'append') {
      appends.push(request)
      if (appends.length === 1)
        durable = {
          ...durable,
          revision: 2,
          lastMutation: { id: 'another-editor', fingerprint: 'fixture' },
          blocks: [
            { type: 'text', id: 'prose', text: 'Another author’s newer reasoning' },
            durable.blocks[1]
          ]
        }
      if (request.expectedRevision !== durable.revision) throw new Error('Revision conflict')
      durable = {
        ...durable,
        revision: 3,
        blocks: [
          ...durable.blocks,
          {
            type: 'excerpt',
            id: 'second',
            snapshot: candidate('paper-2', 'annotation-2'),
            sourceStatus: 'current'
          }
        ]
      }
      return { action: 'append', note: structuredClone(durable) }
    }
    throw new Error('Unexpected request')
  })
  render(
    <LiteratureSynthesisWorkspace
      resolveSelectedItemIds={async () => ['paper-2']}
      onClose={vi.fn()}
    />
  )
  await openEditor()
  fireEvent.click(screen.getByRole('button', { name: 'Append excerpts' }))
  fireEvent.click(await screen.findByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'Append excerpts (1)' }))
  await screen.findByText('The excerpts could not be saved. Your selection is kept.')
  expect(appends).toHaveLength(1)
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Append excerpts (1)' }))
  await vi.waitFor(() => expect(appends).toHaveLength(2))
  expect(appends.map((request) => request.expectedRevision)).toEqual([1, 2])
  expect(appends[0].requestId).not.toBe(appends[1].requestId)
  expect(
    (
      (await screen.findByRole('textbox', {
        name: /^(Overall|Excerpt) analysis$/
      })) as HTMLTextAreaElement
    ).value
  ).toBe('Another author’s newer reasoning')
  expect(screen.getByText('Quote annotation-2')).not.toBeNull()
})

it('updates the list title and deletion revision after recovering a committed save', async () => {
  let durable = baseNote()
  synthesis.mockImplementation(async (request) => {
    if (request.action === 'list') return { action: 'list', notes: [synthesisNoteSummary(durable)] }
    if (request.action === 'read') return { action: 'read', note: structuredClone(durable) }
    if (request.action === 'update') {
      durable = {
        ...durable,
        title: request.title,
        revision: 2,
        lastMutation: { id: request.requestId!, fingerprint: 'fixture' }
      }
      throw new Error('Committed response lost')
    }
    if (request.action === 'delete') {
      if (request.expectedRevision !== durable.revision) throw new Error('Revision conflict')
      return { action: 'delete', deleted: true }
    }
    throw new Error('Unexpected request')
  })
  render(<LiteratureSynthesisWorkspace resolveSelectedItemIds={async () => []} onClose={vi.fn()} />)
  await openEditor()
  fireEvent.change(screen.getByRole('textbox', { name: 'Note title' }), {
    target: { value: 'Recovered title' }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await screen.findByText('Saved')
  fireEvent.click(screen.getByRole('button', { name: 'Back to synthesis notes' }))
  expect(screen.queryByRole('button', { name: 'Synthesis draft' })).toBeNull()
  fireEvent.click(await screen.findByRole('button', { name: 'Delete note: Recovered title' }))
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
  await vi.waitFor(() =>
    expect(synthesis).toHaveBeenLastCalledWith({
      action: 'delete',
      noteId: durable.id,
      expectedRevision: 2,
      requestId: expect.any(String)
    })
  )
  await vi.waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Recovered title' })).toBeNull()
  )
})

it('keeps saved excerpts readable when the source status could not be checked', async () => {
  const unverified = baseNote()
  unverified.blocks = unverified.blocks.map((block) =>
    block.type === 'excerpt' ? { ...block, sourceStatus: 'unverified' } : block
  )
  synthesis.mockImplementation(async (request) => {
    if (request.action === 'list')
      return { action: 'list', notes: [synthesisNoteSummary(unverified)] }
    if (request.action === 'read') return { action: 'read', note: unverified }
    throw new Error('Unexpected request')
  })
  render(<LiteratureSynthesisWorkspace resolveSelectedItemIds={async () => []} onClose={vi.fn()} />)
  await openEditor()
  expect(screen.getByText('Quote annotation-1')).not.toBeNull()
  expect(screen.getByText('Source status could not be checked.')).not.toBeNull()
  expect(
    screen.queryByText('Source unavailable. This excerpt remains a saved snapshot.')
  ).toBeNull()
})

it.each(['added', 'duplicate'] as const)(
  'recovers a lost %s append response without resubmitting',
  async (kind) => {
    let durable = baseNote()
    const excerpt = kind === 'added' ? candidate('paper-2', 'annotation-2') : candidate()
    const appends: Array<Extract<LiteratureSynthesisRequest, { action: 'append' }>> = []
    synthesis.mockImplementation(async (request) => {
      if (request.action === 'list')
        return { action: 'list', notes: [synthesisNoteSummary(durable)] }
      if (request.action === 'revision')
        return { action: 'revision', noteId: durable.id, revision: durable.revision }
      if (request.action === 'read') return { action: 'read', note: structuredClone(durable) }
      if (request.action === 'candidates')
        return {
          action: 'candidates',
          candidates: [excerpt]
        }
      if (request.action === 'append') {
        appends.push(request)
        durable =
          kind === 'duplicate'
            ? { ...durable, lastNoopAppend: { id: request.requestId!, fingerprint: 'fixture' } }
            : {
                ...durable,
                revision: 2,
                lastMutation: { id: request.requestId!, fingerprint: 'fixture' },
                blocks: [
                  ...durable.blocks,
                  {
                    type: 'excerpt',
                    id: 'second',
                    snapshot: excerpt,
                    sourceStatus: 'current'
                  }
                ]
              }
        throw new Error('Committed append response lost')
      }
      throw new Error('Unexpected request')
    })
    render(
      <LiteratureSynthesisWorkspace
        resolveSelectedItemIds={async () => [excerpt.itemId]}
        onClose={vi.fn()}
      />
    )
    await openEditor()
    fireEvent.click(screen.getByRole('button', { name: 'Append excerpts' }))
    fireEvent.click(await screen.findByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Append excerpts (1)' }))
    await screen.findByRole('textbox', { name: /^(Overall|Excerpt) analysis$/ })
    expect(appends).toHaveLength(1)
    expect(screen.getByText('Quote ' + excerpt.annotationId)).not.toBeNull()
    expect(
      screen.queryByText('The excerpts could not be saved. Your selection is kept.')
    ).toBeNull()
  }
)

it('rejects an older append retry after the user edits the current draft', async () => {
  let rejectCandidates: ((reason: Error) => void) | undefined
  let candidateReads = 0
  synthesis.mockImplementation(async (request) => {
    if (request.action === 'list')
      return { action: 'list', notes: [synthesisNoteSummary(baseNote())] }
    if (request.action === 'revision')
      return { action: 'revision', noteId: baseNote().id, revision: baseNote().revision }
    if (request.action === 'read') return { action: 'read', note: baseNote() }
    if (request.action === 'candidates') {
      candidateReads++
      if (candidateReads === 1)
        return new Promise((_, reject) => {
          rejectCandidates = reject
        })
      return { action: 'candidates', candidates: [candidate()] }
    }
    throw new Error('Unexpected request')
  })
  render(<LiteratureSynthesisWorkspace resolveSelectedItemIds={async () => []} onClose={vi.fn()} />)
  await openEditor()
  fireEvent.click(screen.getByRole('button', { name: 'Append excerpts' }))
  await vi.waitFor(() => expect(rejectCandidates).toBeDefined())
  rejectCandidates!(new Error('Candidate transport unavailable'))
  await screen.findByText('Annotations could not be loaded. Your reference selection is kept.')
  fireEvent.change(screen.getByRole('textbox', { name: /^(Overall|Excerpt) analysis$/ }), {
    target: { value: 'New unsaved reasoning after the failed append' }
  })
  expect(
    (screen.getByRole('button', { name: 'Append excerpts' }) as HTMLButtonElement).disabled
  ).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await screen.findByText('Unsaved changes', { exact: true })
  expect(candidateReads).toBe(1)
  expect(
    (screen.getByRole('textbox', { name: /^(Overall|Excerpt) analysis$/ }) as HTMLTextAreaElement)
      .value
  ).toBe('New unsaved reasoning after the failed append')
  expect(screen.queryByRole('button', { name: 'Append excerpts (0)' })).toBeNull()
})

it('waits for the initial list before creating so a late empty list cannot remove the new summary', async () => {
  let completeList: ((result: LiteratureSynthesisResult) => void) | undefined
  let candidateReads = 0
  synthesis.mockImplementation(async (request) => {
    if (request.action === 'list')
      return new Promise((resolve) => {
        completeList = resolve
      })
    if (request.action === 'candidates') {
      candidateReads++
      return { action: 'candidates', candidates: [candidate()] }
    }
    if (request.action === 'create')
      return { action: 'create', note: { ...baseNote(), title: request.title } }
    throw new Error('Unexpected request')
  })
  render(
    <LiteratureSynthesisWorkspace
      createFromSelection
      resolveSelectedItemIds={async () => ['paper-1']}
      onClose={vi.fn()}
    />
  )
  await act(async () => {
    await Promise.resolve()
  })
  expect(completeList).toBeDefined()
  expect(candidateReads).toBe(0)
  expect(screen.queryByRole('button', { name: 'Create synthesis note (0)' })).toBeNull()
  completeList!({ action: 'list', notes: [] })
  const title = await screen.findByRole('textbox', { name: 'Note title' })
  fireEvent.change(title, { target: { value: 'Newly created synthesis' } })
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'Create synthesis note (1)' }))
  await screen.findByRole('textbox', { name: /^(Overall|Excerpt) analysis$/ })
  fireEvent.click(screen.getByRole('button', { name: 'Back to synthesis notes' }))
  expect(screen.getByRole('button', { name: 'Newly created synthesis' })).not.toBeNull()
})

it('keeps initial list failures in the notes view with a working refresh retry', async () => {
  let listReads = 0
  let candidateReads = 0
  synthesis.mockImplementation(async (request) => {
    if (request.action === 'list') {
      if (++listReads === 1) throw new Error('List transport unavailable')
      return { action: 'list', notes: [synthesisNoteSummary(baseNote())] }
    }
    if (request.action === 'candidates') {
      candidateReads++
      return { action: 'candidates', candidates: [candidate()] }
    }
    throw new Error('Unexpected request')
  })
  render(
    <LiteratureSynthesisWorkspace
      createFromSelection
      resolveSelectedItemIds={async () => ['paper-1']}
      onClose={vi.fn()}
    />
  )
  await screen.findByText('Synthesis notes could not be loaded.')
  expect(candidateReads).toBe(0)
  expect(screen.queryByRole('button', { name: 'Create synthesis note (0)' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await screen.findByRole('button', { name: 'Synthesis draft' })
  expect(listReads).toBe(2)
})

it('discards an earlier reference search after canceling and reopening the candidate picker', async () => {
  let completeSearch:
    ((result: { entries: Array<{ id: string; item: { title: string } }> }) => void) | undefined
  search.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        completeSearch = resolve
      })
  )
  render(
    <LiteratureSynthesisWorkspace
      createFromSelection
      resolveSelectedItemIds={async () => ['paper-1']}
      onClose={vi.fn()}
    />
  )
  await screen.findByText('Add reference')
  fireEvent.click(screen.getByText('Add reference'))
  fireEvent.change(await screen.findByRole('textbox', { name: 'Find references to add' }), {
    target: { value: 'Previous candidate session' }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Find references' }))
  await vi.waitFor(() => expect(completeSearch).toBeDefined())
  expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  fireEvent.click(screen.getByRole('button', { name: 'Create from selected references' }))
  const nextQuery = await screen.findByRole('textbox', { name: 'Find references to add' })
  expect((nextQuery as HTMLInputElement).value).toBe('')
  await act(async () => {
    completeSearch!({
      entries: [{ id: 'stale-result', item: { title: 'Old session search result' } }]
    })
  })
  expect(screen.queryByRole('button', { name: 'Old session search result' })).toBeNull()
  expect(
    (screen.getByRole('button', { name: 'Find references' }) as HTMLButtonElement).disabled
  ).toBe(false)
})

it('clears an earlier reference result when a new query fails and retries only the current query', async () => {
  const onAdd = vi.fn()
  search.mockResolvedValueOnce({ entries: [{ id: 'a', item: { title: 'Result A' } }] })
  search.mockRejectedValueOnce(new Error('Query B unavailable'))
  search.mockResolvedValueOnce({ entries: [{ id: 'b', item: { title: 'Result B' } }] })
  render(<SynthesisReferenceSearch itemIds={[]} disabled={false} onAdd={onAdd} />)
  const query = screen.getByRole('textbox', { name: 'Find references to add' })
  fireEvent.change(query, { target: { value: 'Query A' } })
  fireEvent.click(screen.getByRole('button', { name: 'Find references' }))
  await screen.findByRole('button', { name: 'Result A' })
  fireEvent.change(query, { target: { value: 'Query B' } })
  expect(screen.queryByRole('button', { name: 'Result A' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Find references' }))
  await screen.findByText('References could not be loaded.')
  expect(screen.queryByRole('button', { name: 'Result A' })).toBeNull()
  expect(screen.queryByText('No matching references')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Result B' }))
  expect(onAdd).toHaveBeenCalledExactlyOnceWith('b')
  expect(search.mock.calls.slice(-3).map(([request]) => request.query)).toEqual([
    'Query A',
    'Query B',
    'Query B'
  ])
})

it('shows an empty reference search result only after the current query succeeds without matches', async () => {
  search.mockResolvedValueOnce({ entries: [] })
  render(<SynthesisReferenceSearch itemIds={[]} disabled={false} onAdd={vi.fn()} />)
  expect(screen.queryByText('No matching references')).toBeNull()
  const query = screen.getByRole('textbox', { name: 'Find references to add' })
  fireEvent.change(query, { target: { value: 'No paper' } })
  fireEvent.click(screen.getByRole('button', { name: 'Find references' }))
  expect((await screen.findByRole('status')).textContent).toBe('No matching references')
  fireEvent.change(query, { target: { value: 'Another query' } })
  expect(screen.queryByText('No matching references')).toBeNull()
})

it.each(['success', 'failure'] as const)(
  'ignores a late reference search %s after the query changes',
  async (outcome) => {
    let resolveEarlier!: (page: unknown) => void
    let rejectEarlier!: (failure: Error) => void
    search.mockImplementationOnce(
      () =>
        new Promise((resolve, reject) => {
          resolveEarlier = resolve
          rejectEarlier = reject
        })
    )
    let resolveCurrent!: (page: unknown) => void
    search.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCurrent = resolve
        })
    )
    render(<SynthesisReferenceSearch itemIds={[]} disabled={false} onAdd={vi.fn()} />)
    const query = screen.getByRole('textbox', { name: 'Find references to add' })
    fireEvent.change(query, { target: { value: 'Query A' } })
    fireEvent.click(screen.getByRole('button', { name: 'Find references' }))
    fireEvent.change(query, { target: { value: 'Query B' } })
    fireEvent.click(screen.getByRole('button', { name: 'Find references' }))
    const submit = screen.getByRole('button', { name: 'Find references' }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    await act(async () => {
      if (outcome === 'success')
        resolveEarlier({ entries: [{ id: 'a', item: { title: 'Late result A' } }] })
      else rejectEarlier(new Error('Late failure A'))
    })
    expect(screen.queryByRole('button', { name: 'Late result A' })).toBeNull()
    expect(screen.queryByText('References could not be loaded.')).toBeNull()
    expect(submit.disabled).toBe(true)
    await act(async () => {
      resolveCurrent({ entries: [{ id: 'b', item: { title: 'Current result B' } }] })
    })
    expect(screen.getByRole('button', { name: 'Current result B' })).not.toBeNull()
    expect(submit.disabled).toBe(false)
  }
)
