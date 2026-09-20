// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { LiteratureDuplicatesView } from './LiteratureDuplicatesView'

afterEach(cleanup)
it('shows a partially selected page and limits Select groups on this page to visible groups', async () => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      literature: {
        search: vi.fn(async () => ({
          totalCount: 3,
          nextOffset: 2,
          entries: [
            { id: 'a', title: 'First group', itemIds: ['1', '2'], match: 'identifier' },
            { id: 'b', title: 'Second group', itemIds: ['3', '4'], match: 'identifier' }
          ]
        }))
      }
    }
  })
  render(
    <LiteratureDuplicatesView
      active
      revision={0}
      onCount={vi.fn()}
      onReview={vi.fn()}
      onMerged={vi.fn()}
    />
  )
  const selectPage = await screen.findByRole<HTMLInputElement>('checkbox', {
    name: 'Select groups on this page'
  })
  const groupCheckboxes = screen.getAllByRole<HTMLInputElement>('checkbox', {
    name: /Select duplicate group/
  })
  fireEvent.click(groupCheckboxes[0])
  expect(selectPage.checked).toBe(false)
  expect(selectPage.indeterminate).toBe(true)
  fireEvent.click(selectPage)
  expect(groupCheckboxes.every((checkbox) => checkbox.checked)).toBe(true)
  expect(selectPage.indeterminate).toBe(false)
  fireEvent.click(selectPage)
  expect(groupCheckboxes.every((checkbox) => !checkbox.checked)).toBe(true)
})

const duplicateGroup = (
  itemIds = ['1', '2']
): import('../../../../shared/literature').LiteratureDuplicateGroup => ({
  id: 'group',
  title: 'Shared paper',
  itemIds,
  match: 'identifier' as const
})
const previewReceipt = {
  kind: 'item',
  id: '1',
  batch: {
    eligible: 1,
    reduced: 1,
    review: 0,
    succeeded: 0,
    skipped: 0,
    failed: 0,
    groups: [
      {
        survivorId: '1',
        survivorTitle: 'Reviewed survivor',
        conflicts: false,
        items: ['1', '2'].map((id) => ({ id, metadataRevision: 1, updatedAt: 1 }))
      }
    ]
  }
}
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- Preserve each mock's inferred callable signature.
function setupDuplicates(itemIds = ['1', '2']) {
  const search = vi.fn(async () => ({ totalCount: 1, entries: [duplicateGroup(itemIds)] }))
  const transact = vi.fn(async () => previewReceipt)
  const get = vi.fn(async (id: string) => ({
    id,
    item: { title: `Reference ${id}` },
    deletedAt: null
  }))
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { literature: { search, transact, get } }
  })
  const props = {
    active: true,
    revision: 0,
    onCount: vi.fn(),
    onReview: vi.fn(),
    onMerged: vi.fn()
  }
  return { search, transact, get, props }
}
async function selectAndPreview(): Promise<void> {
  fireEvent.click(await screen.findByRole('checkbox', { name: /Select duplicate group:/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Preview batch merge' }))
  await screen.findByText('Keep reference: Reviewed survivor')
}

it('invalidates the reviewed batch when refreshed group membership changes', async () => {
  const { search, transact, props } = setupDuplicates()
  const view = render(<LiteratureDuplicatesView {...props} />)
  await selectAndPreview()
  search.mockResolvedValue({ totalCount: 1, entries: [duplicateGroup(['1', '2', '3'])] })
  view.rerender(<LiteratureDuplicatesView {...props} revision={1} />)
  await screen.findByText(/3 references/)
  const commit = screen.queryByRole<HTMLButtonElement>('button', {
    name: 'Merge conflict-free groups'
  })
  if (commit && !commit.disabled) fireEvent.click(commit)
  expect(transact.mock.calls).toHaveLength(1)
  expect(screen.queryByText('Keep reference: Reviewed survivor')).toBeNull()
})

it('prevents submitting an old preview while the refreshed list is unresolved', async () => {
  const { search, transact, props } = setupDuplicates()
  const view = render(<LiteratureDuplicatesView {...props} />)
  await selectAndPreview()
  search.mockImplementationOnce(() => new Promise(() => {}))
  view.rerender(<LiteratureDuplicatesView {...props} revision={1} />)
  await waitFor(() => expect(search).toHaveBeenCalledTimes(2))
  const commit = screen.queryByRole<HTMLButtonElement>('button', {
    name: 'Merge conflict-free groups'
  })
  if (commit && !commit.disabled) fireEvent.click(commit)
  expect(transact.mock.calls).toHaveLength(1)
})

it('allows previewing again after the failure notice refresh completes', async () => {
  const { search, transact, props } = setupDuplicates()
  transact.mockRejectedValueOnce(new Error('Temporary failure'))
  function Parent(): React.JSX.Element {
    const [revision, setRevision] = useState(0)
    return (
      <LiteratureDuplicatesView
        {...props}
        revision={revision}
        onMerged={() => setRevision((value) => value + 1)}
      />
    )
  }
  render(<Parent />)
  fireEvent.click(await screen.findByRole('checkbox', { name: /Select duplicate group:/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Preview batch merge' }))
  const notice = await screen.findByText(
    'Duplicate processing failed. Refresh the list before trying again.'
  )
  const refreshButtons = screen.getAllByRole('button', { name: 'Refresh' })
  expect(refreshButtons).toHaveLength(2)
  expect(notice).toBeTruthy()
  fireEvent.click(refreshButtons[1])
  await waitFor(() => expect(search).toHaveBeenCalledTimes(2))
  const checkbox = await screen.findByRole<HTMLInputElement>('checkbox', {
    name: /Select duplicate group:/
  })
  if (!checkbox.checked) fireEvent.click(checkbox)
  const preview = screen.getByRole<HTMLButtonElement>('button', { name: 'Preview batch merge' })
  expect(preview.disabled).toBe(false)
  fireEvent.click(preview)
  await screen.findByText('Keep reference: Reviewed survivor')
})

it('offers the entire oversized group for selection before handing a subset to merge review', async () => {
  const { get, transact, props } = setupDuplicates(
    Array.from({ length: 21 }, (_, i) => String(i + 1))
  )
  render(<LiteratureDuplicatesView {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Review duplicates' }))
  await waitFor(() => expect(get).toHaveBeenCalled())
  // Opening the group must not silently choose its first 20 members for the user.
  expect(props.onReview).not.toHaveBeenCalled()
  expect(transact).not.toHaveBeenCalled()
  await screen.findByText('Reference 21')
})

it('compares an explicitly selected subset across member pages without merging', async () => {
  const { get, transact, props } = setupDuplicates(
    Array.from({ length: 51 }, (_, i) => String(i + 1))
  )
  render(<LiteratureDuplicatesView {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Review duplicates' }))
  const members = within(
    await screen.findByRole('region', { name: 'Select 2–20 references to compare.' })
  )
  fireEvent.click(await members.findByRole('checkbox', { name: 'Reference 1' }))
  expect(get).toHaveBeenCalledTimes(50)
  fireEvent.click(members.getByRole('button', { name: 'Next page' }))
  fireEvent.click(await members.findByRole('checkbox', { name: 'Reference 51' }))
  expect(get).toHaveBeenCalledTimes(51)
  fireEvent.click(members.getByRole('button', { name: 'Compare selected references' }))
  await waitFor(() =>
    expect(props.onReview).toHaveBeenCalledWith([
      expect.objectContaining({ id: '1' }),
      expect.objectContaining({ id: '51' })
    ])
  )
  expect(get.mock.calls.slice(-2)).toEqual([['1'], ['51']])
  expect(transact).not.toHaveBeenCalled()
})

it('limits member selection to 20 and lets the user replace an unwanted member', async () => {
  const { props } = setupDuplicates(Array.from({ length: 21 }, (_, i) => String(i + 1)))
  render(<LiteratureDuplicatesView {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Review duplicates' }))
  const members = within(
    await screen.findByRole('region', { name: 'Select 2–20 references to compare.' })
  )
  const first = await members.findByRole<HTMLInputElement>('checkbox', { name: 'Reference 1' })
  const compare = members.getByRole<HTMLButtonElement>('button', {
    name: 'Compare selected references'
  })
  expect(compare.disabled).toBe(true)
  for (let i = 1; i <= 20; i++)
    fireEvent.click(members.getByRole('checkbox', { name: `Reference ${i}` }))
  const last = members.getByRole<HTMLInputElement>('checkbox', { name: 'Reference 21' })
  expect(last.disabled).toBe(true)
  fireEvent.click(first)
  expect(last.disabled).toBe(false)
  fireEvent.click(last)
  fireEvent.click(compare)
  await waitFor(() => expect(props.onReview).toHaveBeenCalledTimes(1))
  expect(props.onReview.mock.calls[0][0].map(({ id }: { id: string }) => id)).toEqual(
    Array.from({ length: 20 }, (_, i) => String(i + 2))
  )
})

it('retries a failed member page without discarding selections on other pages', async () => {
  const { get, props } = setupDuplicates(Array.from({ length: 51 }, (_, i) => String(i + 1)))
  render(<LiteratureDuplicatesView {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Review duplicates' }))
  const members = within(
    await screen.findByRole('region', { name: 'Select 2–20 references to compare.' })
  )
  fireEvent.click(await members.findByRole('checkbox', { name: 'Reference 1' }))
  get.mockRejectedValueOnce(new Error('Temporary read failure'))
  fireEvent.click(members.getByRole('button', { name: 'Next page' }))
  fireEvent.click(await members.findByRole('button', { name: 'Retry' }))
  fireEvent.click(await members.findByRole('checkbox', { name: 'Reference 51' }))
  fireEvent.click(members.getByRole('button', { name: 'Compare selected references' }))
  await waitFor(() => expect(props.onReview).toHaveBeenCalledTimes(1))
  expect(props.onReview.mock.calls[0][0].map(({ id }: { id: string }) => id)).toEqual(['1', '51'])
})

it('ignores a discarded preview response without clearing a newer preview busy state', async () => {
  const { search, transact, props } = setupDuplicates()
  let oldPreview!: (receipt: typeof previewReceipt) => void
  let newPreview!: (receipt: typeof previewReceipt) => void
  transact.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        oldPreview = resolve
      })
  )
  const view = render(<LiteratureDuplicatesView {...props} />)
  fireEvent.click(await screen.findByRole('checkbox', { name: /Select duplicate group:/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Preview batch merge' }))
  view.rerender(<LiteratureDuplicatesView {...props} revision={1} />)
  await waitFor(() => expect(search).toHaveBeenCalledTimes(2))
  const preview = await screen.findByRole<HTMLButtonElement>('button', {
    name: 'Preview batch merge'
  })
  expect(preview.disabled).toBe(false)
  transact.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        newPreview = resolve
      })
  )
  fireEvent.click(preview)
  oldPreview(previewReceipt)
  await waitFor(() =>
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Refresh' }).disabled).toBe(true)
  )
  expect(screen.queryByText('Keep reference: Reviewed survivor')).toBeNull()
  newPreview(previewReceipt)
  await screen.findByText('Keep reference: Reviewed survivor')
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Refresh' }).disabled).toBe(false)
})
