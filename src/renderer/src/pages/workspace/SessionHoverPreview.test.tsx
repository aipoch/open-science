// @vitest-environment jsdom
import { Profiler } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { SessionHoverPreview, SessionHoverPreviewProvider } from './SessionHoverPreview'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it('commits only the old and new hover previews when active session changes', async () => {
  vi.useFakeTimers()
  const committed: string[] = []
  const previewRequested = [vi.fn(), vi.fn(), vi.fn()]
  render(
    <SessionHoverPreviewProvider>
      {['first', 'second', 'third'].map((id, index) => (
        <Profiler key={id} id={id} onRender={(name) => committed.push(name)}>
          <SessionHoverPreview
            session={{ id, title: `${id} session` }}
            onPreviewRequest={previewRequested[index]}
          >
            <button>{id} row</button>
          </SessionHoverPreview>
        </Profiler>
      ))}
    </SessionHoverPreviewProvider>
  )
  committed.length = 0

  fireEvent.pointerEnter(screen.getByRole('button', { name: 'first row' }), {
    pointerType: 'mouse'
  })
  await act(() => vi.advanceTimersByTimeAsync(300))
  expect(committed).toContain('first')
  expect(committed).not.toContain('second')
  expect(committed).not.toContain('third')
  expect(previewRequested[0]).toHaveBeenCalledOnce()
  committed.length = 0

  fireEvent.pointerEnter(screen.getByRole('button', { name: 'second row' }), {
    pointerType: 'mouse'
  })
  await act(async () => {})
  expect(committed).toContain('first')
  expect(committed).toContain('second')
  expect(committed).not.toContain('third')
  expect(previewRequested[1]).toHaveBeenCalledOnce()
  expect(previewRequested[2]).not.toHaveBeenCalled()
  expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe('second session')
})

it('shows the session number separately from the editable title', async () => {
  vi.useFakeTimers()
  render(
    <SessionHoverPreviewProvider>
      <SessionHoverPreview
        session={{ id: 'a', title: 'Session', number: 123, description: 'Summary' }}
        canRename
      >
        <button>Row</button>
      </SessionHoverPreview>
    </SessionHoverPreviewProvider>
  )
  fireEvent.pointerEnter(screen.getByText('Row'), { pointerType: 'mouse' })
  await act(() => vi.advanceTimersByTimeAsync(300))
  const number = screen.getByText('#123')
  expect(number.previousElementSibling?.textContent).toBe('Session')
  expect(number.nextElementSibling?.textContent).toBe('Summary')
  fireEvent.click(screen.getByRole('button', { name: 'Rename session title' }))
  expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Session title' }).value).toBe(
    'Session'
  )
  expect(screen.getByText('#123')).toBe(number)
})

it.each([undefined, 0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
  'omits an unavailable or invalid session number (%s)',
  async (number) => {
    vi.useFakeTimers()
    render(
      <SessionHoverPreviewProvider>
        <SessionHoverPreview session={{ id: 'a', title: 'Session', number }}>
          <button>Row</button>
        </SessionHoverPreview>
      </SessionHoverPreviewProvider>
    )
    fireEvent.pointerEnter(screen.getByText('Row'), { pointerType: 'mouse' })
    await act(() => vi.advanceTimersByTimeAsync(300))
    expect(screen.getByRole('dialog').textContent).toBe('Session')
  }
)

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
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Rename session title' })
    )
  }
)

it('preserves natural Tab navigation and allows explicit keyboard entry while the row stays focused', async () => {
  vi.useFakeTimers()
  render(
    <SessionHoverPreviewProvider>
      <SessionHoverPreview session={{ id: 'a', title: 'Session' }} canRename>
        <div>
          <button>Row</button>
          <button>Actions</button>
        </div>
      </SessionHoverPreview>
    </SessionHoverPreviewProvider>
  )
  const row = screen.getByText('Row')
  vi.spyOn(row, 'matches').mockImplementation((selector) => selector === ':focus-visible')
  act(() => row.focus())
  expect(screen.queryByRole('dialog')).not.toBeNull()
  fireEvent.pointerEnter(row, { pointerType: 'mouse' })
  fireEvent.pointerLeave(row, { pointerType: 'mouse' })
  await act(() => vi.advanceTimersByTimeAsync(400))
  expect(screen.queryByRole('dialog')).not.toBeNull()
  // Tab is left to the browser; jsdom does not implement its native focus traversal.
  expect(fireEvent.keyDown(row, { key: 'Tab', cancelable: true })).toBe(true)
  fireEvent.keyDown(row, { key: 'ArrowRight' })
  const rename = screen.getByRole('button', { name: 'Rename session title' })
  expect(document.activeElement).toBe(rename)
  fireEvent.keyDown(rename, { key: 'Escape' })
  await act(() => vi.advanceTimersByTimeAsync(0))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(row)
  expect(fireEvent.keyDown(row, { key: 'Tab', cancelable: true })).toBe(true)
})

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
