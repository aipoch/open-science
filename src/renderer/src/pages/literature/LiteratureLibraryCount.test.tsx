// @vitest-environment jsdom
import { StrictMode } from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { LiteratureLibraryCount } from './LiteratureLibraryCount'
import type { LiteratureCatalogSearchPage } from '../../../../shared/literature'

afterEach(cleanup)

it('deduplicates mount requests and retains the total across rerenders and collapsed navigation', async () => {
  const search = vi.fn().mockResolvedValue({ entries: [], totalCount: 42 })
  Object.defineProperty(window, 'api', { configurable: true, value: { literature: { search } } })
  const { rerender } = render(
    <StrictMode>
      <LiteratureLibraryCount revision={0} hidden={false} />
    </StrictMode>
  )
  expect(await screen.findByText('42')).toBeTruthy()
  rerender(
    <StrictMode>
      <LiteratureLibraryCount revision={0} hidden />
    </StrictMode>
  )
  rerender(
    <StrictMode>
      <LiteratureLibraryCount revision={0} hidden={false} />
    </StrictMode>
  )
  expect(screen.getByText('42')).toBeTruthy()
  expect(search).toHaveBeenCalledExactlyOnceWith({
    scope: 'library',
    lifecycle: 'active',
    limit: 1
  })
})

it('ignores stale counts and keeps the previous value while refreshing or on failure', async () => {
  let stale!: (page: LiteratureCatalogSearchPage) => void
  const search = vi
    .fn()
    .mockResolvedValueOnce({ entries: [], totalCount: 42 })
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          stale = resolve
        })
    )
    .mockResolvedValueOnce({ entries: [], totalCount: 0 })
    .mockRejectedValueOnce(new Error('offline'))
  Object.defineProperty(window, 'api', { configurable: true, value: { literature: { search } } })
  const { rerender } = render(<LiteratureLibraryCount revision={0} hidden={false} />)
  await screen.findByText('42')
  rerender(<LiteratureLibraryCount revision={1} hidden={false} />)
  expect(screen.getByText('42')).toBeTruthy()
  rerender(<LiteratureLibraryCount revision={2} hidden={false} />)
  await screen.findByText('0')
  await act(async () => stale({ entries: [], totalCount: 99 }))
  expect(screen.queryByText('99')).toBeNull()
  rerender(<LiteratureLibraryCount revision={3} hidden={false} />)
  await act(async () => {})
  expect(screen.getByText('0')).toBeTruthy()
})
