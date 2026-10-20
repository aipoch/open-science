// @vitest-environment jsdom
import { createLiteratureTestRenderer } from '../../../../../test/renderer/literature'
import type { LiteratureItemView } from '@aipoch/literature-library/contracts'
import { literatureItemInputSchema } from '@aipoch/literature-library/item'
import { cleanup, fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WorkspaceLiteratureToolCard } from './WorkspaceLiteratureToolCard'
import { buildLiteratureLibraryToolSummary } from './literature-tool-presentation'
import { LibraryPreviewNavigationContext } from './previews/library-reference-actions'
import { LiteratureCandidateSessionContext } from './literature-candidate-session-context'
import { useNavigationStore } from '../../stores/navigation-store'

const { render: renderComponent } = createLiteratureTestRenderer({
  get api() {
    return window.api
  },
  onRecovered: () => () => {}
})

const reference = (id: string): LiteratureItemView => ({
  id,
  metadataRevision: 1,
  item: literatureItemInputSchema.parse({ itemType: 'journalArticle', title: `Reference ${id}` }),
  attachments: [],
  collectionIds: [],
  projectIds: [],
  createdAt: 1,
  updatedAt: 1
})
const previousApi = window.api
beforeEach(() => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      literature: {
        search: vi.fn(async ({ itemIds }: { itemIds: string[] }) => ({
          entries: itemIds.map(reference)
        })),
        get: vi.fn(async (id: string) => reference(id)),
        getCandidateStates: vi.fn(async ({ candidateIds }: { candidateIds: string[] }) => ({
          candidates: candidateIds.map((candidateId) => ({ candidateId, state: 'pending' }))
        })),
        onChanged: () => () => {}
      }
    }
  })
})
afterEach(() => {
  cleanup()
  Object.defineProperty(window, 'api', { configurable: true, value: previousApi })
})
const render = (node: React.ReactNode): ReturnType<typeof renderComponent> =>
  renderComponent(
    <LiteratureCandidateSessionContext.Provider value={{ sessionId: 'session' }}>
      {node}
    </LiteratureCandidateSessionContext.Provider>
  )

it('does not describe an existing library receipt as an Inbox save', async () => {
  const summary = buildLiteratureLibraryToolSummary(
    'save',
    { refs: ['doi:10.1234/existing'] },
    {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            openScienceLiteraturePresentation: {
              libraryAction: 'save',
              candidateCount: 1,
              savedCount: 1,
              itemTitles: ['Existing item']
            }
          })
        },
        {
          type: 'text',
          text: JSON.stringify({ results: [{ kind: 'item', id: 'existing', state: 'present' }] })
        }
      ]
    }
  )
  const navigate = vi
    .spyOn(useNavigationStore.getState(), 'openLiteratureItem')
    .mockImplementation(() => {})
  try {
    const rendered = render(<WorkspaceLiteratureToolCard summary={summary} />)
    const card = rendered.getByTestId('literature-tool-card')
    expect(card.textContent).not.toContain('Inbox')
    expect(card.textContent).toContain('Already in library: 1')
    fireEvent.click(await rendered.findByRole('button', { name: 'Reference existing' }))
    expect(await rendered.findByRole('dialog', { name: 'Reference existing' })).toBeDefined()
    expect(navigate).not.toHaveBeenCalled()
  } finally {
    cleanup()
    navigate.mockRestore()
  }
})

it('shows mixed outcomes and opens the corresponding destinations', async () => {
  const summary = buildLiteratureLibraryToolSummary(
    'save',
    { candidates: [{}, {}, {}, {}, {}] },
    {
      results: [
        { kind: 'candidate', id: 'pending', state: 'pending' },
        { kind: 'candidate', id: 'pending', state: 'pending' },
        { kind: 'item', id: 'existing', state: 'present' }
      ],
      failure: { inputIndex: 3, code: 'INBOX_SAVE_FAILED', message: 'Failed' }
    }
  )
  const inbox = vi.spyOn(useNavigationStore.getState(), 'openLibrary').mockImplementation(() => {})
  const existing = vi
    .spyOn(useNavigationStore.getState(), 'openLiteratureItem')
    .mockImplementation(() => {})
  try {
    const rendered = render(<WorkspaceLiteratureToolCard summary={summary} />)
    expect(await rendered.findByText('Pending review: 1')).toBeDefined()
    expect(rendered.getByText('Already in library: 1')).toBeDefined()
    expect(rendered.getByText('Repeated inputs: 1')).toBeDefined()
    expect(rendered.getByText('Not attempted: 1')).toBeDefined()
    expect(
      rendered.getByText('Could not save reference 4. Earlier results are kept.')
    ).toBeDefined()
    fireEvent.click(rendered.getByRole('button', { name: 'Open Inbox' }))
    expect(inbox).toHaveBeenCalledWith('user')
    fireEvent.click(await rendered.findByRole('button', { name: 'Reference existing' }))
    expect(await rendered.findByRole('dialog', { name: 'Reference existing' })).toBeDefined()
    expect(existing).not.toHaveBeenCalled()
  } finally {
    cleanup()
    inbox.mockRestore()
    existing.mockRestore()
  }
})

it('does not infer destinations or pending counts from historical summary-only output', () => {
  const summary = buildLiteratureLibraryToolSummary(
    'save',
    { refs: ['doi:10.1234/paper'] },
    {
      openScienceLiteraturePresentation: { libraryAction: 'save', candidateCount: 1, savedCount: 1 }
    }
  )
  try {
    const rendered = render(<WorkspaceLiteratureToolCard summary={summary} />)
    expect(summary.savedCount).toBeUndefined()
    expect(rendered.queryAllByRole('button')).toHaveLength(0)
    expect(rendered.getByTestId('literature-tool-card').textContent).not.toContain('Pending review')
  } finally {
    cleanup()
  }
})

it('does not label dismissed receipts as pending review', () => {
  const summary = buildLiteratureLibraryToolSummary(
    'save',
    {},
    { results: [{ kind: 'candidate', id: 'dismissed', state: 'dismissed' }] }
  )
  expect(summary).toMatchObject({ savedCount: 0, otherCount: 1, existingItemIds: [] })
})

it('opens Inbox from a downloaded PDF receipt delivered through MCP text content', async () => {
  const summary = buildLiteratureLibraryToolSummary(
    'save',
    {},
    {
      content: [
        { type: 'text', text: JSON.stringify({ status: 'pending-review', candidateId: 'pdf-1' }) }
      ]
    }
  )
  const inbox = vi.spyOn(useNavigationStore.getState(), 'openLibrary').mockImplementation(() => {})
  try {
    const rendered = render(<WorkspaceLiteratureToolCard summary={summary} />)
    expect(rendered.getByText('PDF downloaded to Inbox')).toBeDefined()
    expect(await rendered.findByText('Pending review: 1')).toBeDefined()
    fireEvent.click(rendered.getByRole('button', { name: 'Open Inbox' }))
    expect(inbox).toHaveBeenCalledWith('user')
  } finally {
    cleanup()
    inbox.mockRestore()
  }
})

it('opens the contextual Preview Inbox without navigating away or inferring a new destination', async () => {
  const openPreview = vi.fn()
  const navigate = vi
    .spyOn(useNavigationStore.getState(), 'openLibrary')
    .mockImplementation(() => {})
  const summary = buildLiteratureLibraryToolSummary(
    'save',
    {},
    { results: [{ kind: 'candidate', id: 'pending', state: 'pending' }] }
  )
  try {
    const view = render(
      <LibraryPreviewNavigationContext.Provider value={openPreview}>
        <WorkspaceLiteratureToolCard summary={summary} />
      </LibraryPreviewNavigationContext.Provider>
    )
    fireEvent.click(await view.findByRole('button', { name: 'Open Inbox' }))
    fireEvent.click(await view.findByRole('button', { name: 'Open Inbox' }))
    expect(openPreview.mock.calls).toEqual([[{ section: 'inbox' }], [{ section: 'inbox' }]])
    expect(navigate).not.toHaveBeenCalled()
  } finally {
    cleanup()
    navigate.mockRestore()
  }
})
