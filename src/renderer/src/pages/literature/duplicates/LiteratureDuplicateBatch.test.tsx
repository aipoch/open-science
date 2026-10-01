// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { LiteratureDuplicateBatch } from './LiteratureDuplicateBatch'

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
})

it('invalidates the preview when the survivor rule changes and submits only the reviewed snapshot', async () => {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn()
  })
  const items = [
    { id: 'a', metadataRevision: 1, updatedAt: 1 },
    { id: 'b', metadataRevision: 2, updatedAt: 2 }
  ]
  const transact = vi.fn(async () => ({
    kind: 'item',
    id: 'a',
    batch: {
      eligible: 1,
      reduced: 1,
      review: 0,
      succeeded: 0,
      skipped: 0,
      failed: 0,
      groups: [{ survivorId: 'b', survivorTitle: 'Preferred paper', conflicts: true, items }]
    }
  }))
  Object.defineProperty(window, 'api', { configurable: true, value: { literature: { transact } } })
  render(
    <LiteratureDuplicateBatch
      groups={[{ id: 'group', title: 'Paper', itemIds: ['a', 'b'], match: 'identifier' }]}
      onBusy={vi.fn()}
      onMerged={vi.fn()}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Preview batch merge' }))
  await screen.findByText('Keep reference: Preferred paper')
  fireEvent.keyDown(screen.getByRole('combobox', { name: 'Merge strategy' }), { key: 'ArrowDown' })
  fireEvent.click(await screen.findByRole('option', { name: 'Keep the most complete reference' }))
  expect(screen.queryByText('Keep reference: Preferred paper')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Merge references' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Preview batch merge' }))
  await screen.findByText('Conflicting values will follow the chosen reference.')
  expect(transact).toHaveBeenLastCalledWith({
    kind: 'merge-duplicates',
    mode: 'preview',
    strategy: 'most-complete',
    groups: [['a', 'b']]
  })
  fireEvent.click(screen.getByRole('button', { name: 'Merge references' }))
  await waitFor(() =>
    expect(transact).toHaveBeenLastCalledWith({
      kind: 'merge-duplicates',
      mode: 'commit',
      strategy: 'most-complete',
      groups: [['a', 'b']],
      expectedItems: items
    })
  )
})

it('shows per-group reasons instead of only skipped and failed counts', async () => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      literature: {
        transact: vi.fn(async () => ({
          kind: 'item',
          id: 'a',
          batch: {
            eligible: 0,
            reduced: 0,
            review: 1,
            succeeded: 0,
            skipped: 1,
            failed: 1,
            groups: [],
            details: [
              { groupIndex: 0, title: 'Changed reference', status: 'skipped', reason: 'changed' },
              { groupIndex: 1, title: 'Unavailable source', status: 'failed', reason: 'failed' }
            ]
          }
        }))
      }
    }
  })
  render(
    <LiteratureDuplicateBatch
      groups={[
        { id: 'first', title: 'Changed reference', itemIds: ['a', 'b'], match: 'identifier' },
        { id: 'second', title: 'Unavailable source', itemIds: ['c', 'd'], match: 'identifier' }
      ]}
      onBusy={vi.fn()}
      onMerged={vi.fn()}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Preview batch merge' }))
  fireEvent.click(await screen.findByText('View processing details'))
  expect(
    screen.getByText('References changed after preview. Review this group again.')
  ).toBeTruthy()
  expect(screen.getByText('Processing failed. Refresh and try again.')).toBeTruthy()
})
