// @vitest-environment jsdom
import { cleanup, render, fireEvent } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { WorkspaceLiteratureToolCard } from './WorkspaceLiteratureToolCard'
import { buildLiteratureLibraryToolSummary } from './literature-tool-presentation'
import { useNavigationStore } from '../../stores/navigation-store'
it('does not describe an existing library receipt as an Inbox save', () => {
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
    fireEvent.click(rendered.getByRole('button', { name: 'Open existing reference 1' }))
    expect(navigate).toHaveBeenCalledWith('existing', 'user')
  } finally {
    cleanup()
    navigate.mockRestore()
  }
})

it('shows mixed outcomes and opens the corresponding destinations', () => {
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
    expect(rendered.getByText('Pending review: 1')).toBeDefined()
    expect(rendered.getByText('Already in library: 1')).toBeDefined()
    expect(rendered.getByText('Repeated inputs: 1')).toBeDefined()
    expect(rendered.getByText('Not attempted: 1')).toBeDefined()
    expect(
      rendered.getByText('Could not save reference 4. Earlier results are kept.')
    ).toBeDefined()
    fireEvent.click(rendered.getByRole('button', { name: 'Open Inbox' }))
    expect(inbox).toHaveBeenCalledWith('user')
    fireEvent.click(rendered.getByRole('button', { name: 'Open existing reference 1' }))
    expect(existing).toHaveBeenCalledWith('existing', 'user')
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
