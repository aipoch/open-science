// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { SessionHoverPreview, SessionHoverPreviewProvider } from './SessionHoverPreview'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it.each(['resolve', 'reject'] as const)(
  'protects a draft across other-row hover before and during a %s save',
  async (outcome) => {
    vi.useFakeTimers()
    let resolve!: () => void
    let reject!: (cause: Error) => void
    const rename = vi.fn(
      () =>
        new Promise<void>((done, fail) => {
          resolve = done
          reject = fail
        })
    )
    const preview = vi.fn()
    render(
      <SessionHoverPreviewProvider>
        <SessionHoverPreview
          session={{ id: 'a', title: 'Original' }}
          canRename
          onRenameTitle={rename}
        >
          <button>First row</button>
        </SessionHoverPreview>
        <SessionHoverPreview session={{ id: 'b', title: 'Other' }} onPreviewRequest={preview}>
          <button>Second row</button>
        </SessionHoverPreview>
      </SessionHoverPreviewProvider>
    )
    fireEvent.pointerEnter(screen.getByText('First row'), { pointerType: 'mouse' })
    await act(() => vi.advanceTimersByTimeAsync(300))
    const renameButton = screen.getByRole('button', { name: 'Rename session title' })
    expect(renameButton.tabIndex).toBe(0)
    fireEvent.click(renameButton)
    const input = screen.getByRole('textbox', { name: 'Session title' })
    fireEvent.change(input, { target: { value: 'Unsaved draft' } })
    fireEvent.pointerEnter(screen.getByText('Second row'), { pointerType: 'mouse' })
    await act(() => vi.advanceTimersByTimeAsync(400))
    expect(screen.getByRole('textbox')).toBe(input)
    expect(rename).not.toHaveBeenCalled()
    expect(preview).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(rename).toHaveBeenCalledExactlyOnceWith('Unsaved draft', 'Original')
    fireEvent.pointerLeave(screen.getByText('Second row'), { pointerType: 'mouse' })
    fireEvent.pointerEnter(screen.getByText('Second row'), { pointerType: 'mouse' })
    await act(() => vi.advanceTimersByTimeAsync(400))
    expect(screen.getByRole('textbox')).toBe(input)
    expect(preview).not.toHaveBeenCalled()
    await act(async () => {
      if (outcome === 'resolve') resolve()
      else reject(new Error('Save failed'))
    })
    if (outcome === 'reject') {
      expect(screen.getByRole('textbox')).toBe(input)
      expect(screen.getByRole('alert').textContent).toBe('Could not save session details.')
      fireEvent.pointerEnter(screen.getByText('Second row'), { pointerType: 'mouse' })
      expect(preview).not.toHaveBeenCalled()
      fireEvent.keyDown(input, { key: 'Escape' })
    }
    expect(screen.queryByRole('textbox')).toBeNull()
  }
)

it('cancels brief hover reads and resets the delay after leaving the group', async () => {
  vi.useFakeTimers()
  const preview = vi.fn()
  render(
    <SessionHoverPreviewProvider>
      <SessionHoverPreview session={{ id: 'a', title: 'Session' }} onPreviewRequest={preview}>
        <button>Row</button>
      </SessionHoverPreview>
    </SessionHoverPreviewProvider>
  )
  const row = screen.getByRole('button')
  fireEvent.pointerEnter(row, { pointerType: 'mouse' })
  await act(() => vi.advanceTimersByTimeAsync(100))
  fireEvent.pointerLeave(row, { pointerType: 'mouse' })
  await act(() => vi.advanceTimersByTimeAsync(600))
  expect(preview).not.toHaveBeenCalled()
  fireEvent.pointerEnter(row, { pointerType: 'mouse' })
  await act(() => vi.advanceTimersByTimeAsync(300))
  expect(preview).toHaveBeenCalledTimes(1)
  fireEvent.pointerLeave(row, { pointerType: 'mouse' })
  await act(() => vi.advanceTimersByTimeAsync(601))
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.pointerEnter(row, { pointerType: 'mouse' })
  await act(() => vi.advanceTimersByTimeAsync(299))
  expect(preview).toHaveBeenCalledTimes(1)
  await act(() => vi.advanceTimersByTimeAsync(1))
  expect(preview).toHaveBeenCalledTimes(2)
})
