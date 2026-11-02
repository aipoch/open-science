// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { literatureItemInputSchema } from '@aipoch/literature-library/item'
import { LiteratureLinkImportDialog } from './LiteratureLinkImportDialog'

const { lookupMetadata } = vi.hoisted(() => ({ lookupMetadata: vi.fn() }))
vi.mock('../renderer-host', () => ({
  useLiteratureHost: () => ({ api: { literature: { lookupMetadata } } })
}))
afterEach(cleanup)
beforeEach(() => {
  lookupMetadata.mockReset()
})
const item = literatureItemInputSchema.parse({
  itemType: 'preprint',
  title: 'A discovered paper',
  identifiers: [{ scheme: 'arxiv', value: '2401.12345', isPrimary: true }]
})
const enter = (value: string): void => {
  fireEvent.change(screen.getByLabelText('DOI or arXiv link'), { target: { value } })
}

it('focuses the input and only describes arXiv version handling for arXiv input', async () => {
  render(<LiteratureLinkImportDialog onClose={vi.fn()} onResolved={vi.fn()} />)
  const input = screen.getByLabelText('DOI or arXiv link')
  await waitFor(() => expect(document.activeElement).toBe(input))
  const hint = 'Versioned arXiv links use the latest metadata.'
  expect(screen.queryByText(hint)).toBeNull()
  enter('https://arxiv.org/abs/2401.12345v2')
  const notice = screen.getByText(hint)
  expect(input.getAttribute('aria-describedby')?.split(' ')).toContain(notice.id)
  enter('10.1234/paper')
  expect(screen.queryByText(hint)).toBeNull()
  expect(input.getAttribute('aria-describedby')).not.toContain('-version')
})

it('rejects unsupported URLs locally and permits correction', async () => {
  const onResolved = vi.fn()
  render(<LiteratureLinkImportDialog onClose={vi.fn()} onResolved={onResolved} />)
  enter('https://example.com/paper')
  fireEvent.click(screen.getByRole('button', { name: 'Find reference' }))
  expect(await screen.findByRole('alert')).not.toBeNull()
  expect(lookupMetadata).not.toHaveBeenCalled()
  lookupMetadata.mockResolvedValue(item)
  enter('https://arxiv.org/pdf/2401.12345v2.pdf')
  fireEvent.keyDown(screen.getByLabelText('DOI or arXiv link'), { key: 'Enter' })
  await waitFor(() => expect(onResolved).toHaveBeenCalledWith(item, 'arXiv'))
  expect(lookupMetadata).toHaveBeenCalledExactlyOnceWith('arxiv:2401.12345')
})

it('keeps input after a lookup failure and allows retry', async () => {
  lookupMetadata.mockRejectedValueOnce(new Error('Offline')).mockResolvedValue(item)
  const onResolved = vi.fn()
  render(<LiteratureLinkImportDialog onClose={vi.fn()} onResolved={onResolved} />)
  enter('10.1234/paper')
  fireEvent.click(screen.getByRole('button', { name: 'Find reference' }))
  expect((await screen.findByRole('alert')).textContent).toContain('could not be retrieved')
  expect((screen.getByLabelText('DOI or arXiv link') as HTMLInputElement).value).toBe(
    '10.1234/paper'
  )
  fireEvent.click(screen.getByRole('button', { name: 'Find reference' }))
  await waitFor(() => expect(onResolved).toHaveBeenCalledWith(item, 'DOI'))
})

it('deduplicates submissions and ignores late results after cancellation', async () => {
  let finish!: (value: typeof item) => void
  lookupMetadata.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const onClose = vi.fn()
  const onResolved = vi.fn()
  render(<LiteratureLinkImportDialog onClose={onClose} onResolved={onResolved} />)
  enter('10.1234/paper')
  fireEvent.click(screen.getByRole('button', { name: 'Find reference' }))
  fireEvent.keyDown(screen.getByLabelText('DOI or arXiv link'), { key: 'Enter' })
  expect(lookupMetadata).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('button', { name: 'Searching…' }).getAttribute('aria-busy')).toBe('true')
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(onClose).toHaveBeenCalledOnce()
  await act(async () => finish(item))
  expect(onResolved).not.toHaveBeenCalled()
})

it('ignores a lookup result after unmount', async () => {
  let finish!: (value: typeof item) => void
  lookupMetadata.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const onResolved = vi.fn()
  const { unmount } = render(
    <LiteratureLinkImportDialog onClose={vi.fn()} onResolved={onResolved} />
  )
  enter('10.1234/paper')
  fireEvent.click(screen.getByRole('button', { name: 'Find reference' }))
  unmount()
  await act(async () => finish(item))
  expect(onResolved).not.toHaveBeenCalled()
})

it('does not dispatch another lookup after close even if the parent has not unmounted it', () => {
  lookupMetadata.mockResolvedValue(item)
  const onClose = vi.fn()
  render(<LiteratureLinkImportDialog onClose={onClose} onResolved={vi.fn()} />)
  enter('10.1234/paper')
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(onClose).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: 'Find reference' }))
  expect(lookupMetadata).not.toHaveBeenCalled()
})
