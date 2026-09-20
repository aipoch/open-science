// @vitest-environment jsdom
import { createRef } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { CollectionEditorDialog, type CollectionEditorDialogHandle } from './CollectionEditorDialog'
import { LITERATURE_COLLECTION_REVISION_CONFLICT } from '../../../../shared/literature'

afterEach(cleanup)
it('retains a conflicting draft and only submits the loaded latest version after explicit confirmation', async () => {
  const original = {
    id: 'collection',
    name: 'Original',
    description: 'Original description',
    revision: 1,
    itemCount: 0,
    createdAt: 1,
    updatedAt: 1
  }
  const latest = {
    ...original,
    name: 'Renamed by another client',
    description: 'Latest description',
    revision: 2
  }
  const transact = vi
    .fn()
    .mockRejectedValueOnce(new Error(LITERATURE_COLLECTION_REVISION_CONFLICT))
    .mockResolvedValue({ kind: 'collection', id: original.id })
  const search = vi.fn().mockResolvedValue({ entries: [latest] })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { literature: { transact, search } }
  })
  const ref = createRef<CollectionEditorDialogHandle>()
  const saved = vi.fn()
  render(<CollectionEditorDialog ref={ref} onSaved={saved} />)
  act(() => ref.current!.openEdit(original))
  fireEvent.change(screen.getByLabelText('Description'), {
    target: { value: 'My unsaved description' }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
  await screen.findByText('Renamed by another client')
  expect((screen.getByLabelText('Description') as HTMLTextAreaElement).value).toBe(
    'My unsaved description'
  )
  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Original')
  expect(saved).not.toHaveBeenCalled()
  expect(transact).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'Load latest version' }))
  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe(latest.name)
  expect((screen.getByLabelText('Description') as HTMLTextAreaElement).value).toBe(
    latest.description
  )
  expect(transact).toHaveBeenCalledTimes(1)
  fireEvent.change(screen.getByLabelText('Description'), {
    target: { value: 'Reconciled description' }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
  await waitFor(() => expect(saved).toHaveBeenCalledTimes(1))
  expect(transact).toHaveBeenLastCalledWith({
    kind: 'update-collection',
    collectionId: original.id,
    expectedRevision: 2,
    name: latest.name,
    description: 'Reconciled description'
  })
})
