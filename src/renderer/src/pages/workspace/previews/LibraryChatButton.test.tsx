// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi, type Mock } from 'vitest'
import { LibraryReferenceActionsContext } from './library-reference-actions'
import { LibraryChatButton } from './LibraryChatButton'
import { literatureItemInputSchema } from '../../../../../shared/literature'

const sessions = Array.from({ length: 40 }, (_, index) => ({
  id: `session-${index}`,
  projectId: 'project',
  title: `Conversation ${index}`,
  number: index + 1,
  updatedAt: 40 - index,
  status: 'idle'
}))
vi.mock('@/stores/session-store', () => ({
  useSessionStore: (select: (state: unknown) => unknown) =>
    select({
      sessions: [
        ...sessions,
        { ...sessions[0], id: 'other-project', projectId: 'other' },
        { ...sessions[0], id: 'archived', archivedAt: 1 },
        { ...sessions[0], id: 'imported', packageOrigin: {} },
        { ...sessions[0], id: 'pending', isPending: true }
      ]
    })
}))
afterEach(cleanup)
const reference = {
  type: 'literature' as const,
  itemId: 'paper',
  metadataRevision: 1,
  item: literatureItemInputSchema.parse({ itemType: 'journalArticle', title: 'Paper' })
}
const setup = (): Mock => {
  const add = vi.fn()
  render(
    <LibraryReferenceActionsContext.Provider
      value={{ projectId: 'project', currentSessionId: 'session-0', canAddToCurrent: true, add }}
    >
      <LibraryChatButton references={[reference]} />
    </LibraryReferenceActionsContext.Provider>
  )
  return add
}

it('adds to the current draft directly and bounds the searchable destination list', () => {
  const add = setup()
  fireEvent.click(screen.getByRole('button', { name: 'Add to chat' }))
  expect(add).toHaveBeenLastCalledWith([reference], 'session-0')
  fireEvent.click(screen.getByRole('button', { name: 'Choose another conversation' }))
  expect(screen.getAllByRole('option')).toHaveLength(10)
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
  expect(screen.getAllByRole('option')).toHaveLength(20)
  const search = screen.getByRole('combobox')
  fireEvent.change(search, { target: { value: 'Conversation 0' } })
  expect(screen.getAllByRole('option')).toHaveLength(1)
  fireEvent.change(search, { target: { value: '#40' } })
  expect(screen.getAllByRole('option')).toHaveLength(1)
  fireEvent.keyDown(search, { key: 'Enter', isComposing: true })
  expect(add).toHaveBeenCalledTimes(1)
  fireEvent.keyDown(search, { key: 'Enter' })
  expect(add).toHaveBeenLastCalledWith([reference], 'session-39')
  expect(screen.queryByRole('combobox')).toBeNull()
})

it('shows an empty search state and offers the new-conversation draft', () => {
  const add = setup()
  fireEvent.click(screen.getByRole('button', { name: 'Choose another conversation' }))
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'absent title' } })
  expect(screen.getByText('No matching conversations')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'New conversation' }))
  expect(add).toHaveBeenLastCalledWith([reference], null)
})
