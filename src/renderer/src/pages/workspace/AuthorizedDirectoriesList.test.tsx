// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { AuthorizedDirectoriesList } from './AuthorizedDirectoriesList'
import { i18next } from '@/i18n'

const directories = Array.from({ length: 28 }, (_, index) => ({
  name: `Research ${index + 1}`,
  path: `/Users/test/Research ${index + 1}`,
  access: index % 2 === 0 ? ('rw' as const) : ('ro' as const),
  grantedAt: '2026-10-26T01:42:00.000Z'
}))

afterEach(async () => {
  cleanup()
  await i18next.changeLanguage('en')
})

it('shows five full paths and access labels, then expands all remaining directories', () => {
  const view = render(<AuthorizedDirectoriesList directories={directories} />)
  const list = view.getByRole('list')
  expect(within(list).getAllByRole('listitem')).toHaveLength(5)
  expect(view.getByText(directories[0].path)).toBeTruthy()
  expect(view.getAllByRole('img', { name: 'Read & write' })).toHaveLength(3)
  expect(view.getAllByRole('img', { name: 'Read-only' })).toHaveLength(2)
  expect(view.queryByRole('searchbox')).toBeNull()
  expect(view.queryByText(/Granted at/)).toBeNull()

  const toggle = view.getByRole('button', { name: 'Show remaining 23 directories' })
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  fireEvent.click(toggle)
  expect(within(list).getAllByRole('listitem')).toHaveLength(28)
  expect(toggle.getAttribute('aria-expanded')).toBe('true')
  expect(list.className).toContain('max-h-80')
  expect(list.className).toContain('overflow-y-auto')
  fireEvent.click(view.getByRole('button', { name: 'Show less' }))
  expect(within(list).getAllByRole('listitem')).toHaveLength(5)
})

it.each([0, 1, 5])('does not offer expansion for %i directories', (count) => {
  const view = render(<AuthorizedDirectoriesList directories={directories.slice(0, count)} />)
  expect(view.queryByRole('button')).toBeNull()
  expect(view.queryAllByRole('listitem')).toHaveLength(count)
  if (count === 0) expect(view.getByText('No folders granted yet.')).toBeTruthy()
})

it('localizes the singular remainder and keeps directory names and paths intact', async () => {
  await i18next.changeLanguage('zh-Hans')
  const view = render(<AuthorizedDirectoriesList directories={directories.slice(0, 6)} />)
  expect(view.getByRole('button', { name: '展示剩余 1 个' })).toBeTruthy()
  expect(view.getByText(directories[0].name)).toBeTruthy()
  expect(view.getByText(directories[0].path)).toBeTruthy()
})

it('exposes the grant time on keyboard focus without adding it to the resting list', async () => {
  const view = render(<AuthorizedDirectoriesList directories={directories.slice(0, 1)} />)
  expect(view.queryByText(/Granted at/)).toBeNull()
  await act(async () => {
    view
      .getByText(directories[0].name)
      .closest('[tabindex]')!
      .dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
  })
  const tooltip = await view.findByRole('tooltip')
  expect(tooltip.textContent).toContain('Granted at')
  expect(tooltip.textContent).toContain('2026')
  fireEvent.keyDown(document, { key: 'Escape' })
})
