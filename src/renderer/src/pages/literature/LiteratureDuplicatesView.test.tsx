// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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
