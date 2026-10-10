// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReferencePanel } from './ReferencePanel'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
const clipboard = (writeText: (text: string) => Promise<void>): void => {
  vi.stubGlobal('navigator', { clipboard: { writeText } })
}

describe('compact saved Replay reference', () => {
  it('keeps the copy action visible and the JSON in collapsed details', async () => {
    const write = vi.fn().mockResolvedValue(undefined)
    clipboard(write)
    render(
      <ReferencePanel
        compact
        kind="moment"
        reference='{"selectionId":"exact-moment"}'
        observedAt={1000}
      />
    )
    const details = screen.getByText('Saved reference details').closest('details')!
    expect(details.open).toBe(false)
    expect(screen.queryByRole('textbox')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Copy moment reference' }))
    expect(write).toHaveBeenCalledExactlyOnceWith('{"selectionId":"exact-moment"}')
    await screen.findByRole('button', { name: 'Copied' })
    expect(details.open).toBe(false)
    fireEvent.click(screen.getByText('Saved reference details'))
    await waitFor(() => expect(details.open).toBe(true))
    expect(screen.getByRole('textbox', { name: 'Recorded moment reference' })).toHaveProperty(
      'value',
      '{"selectionId":"exact-moment"}'
    )
    expect(screen.getByText(/Paste this reference into your conversation/)).toBeTruthy()
  })
  it('opens and selects a manual copy fallback when clipboard access is denied', async () => {
    clipboard(vi.fn().mockRejectedValue(new Error('denied')))
    render(<ReferencePanel compact kind="file" reference='{"versionId":"fixed-v1"}' />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy file reference' }))
    await screen.findByText('Select and copy the reference below.')
    await waitFor(() =>
      expect(screen.getByText('Saved reference details').closest('details')!.open).toBe(true)
    )
    const text = screen.getByRole('textbox', {
      name: 'Recorded file version'
    }) as HTMLTextAreaElement
    expect(document.activeElement).toBe(text)
    expect(text.selectionStart).toBe(0)
    expect(text.selectionEnd).toBe(text.value.length)
  })
  it('does not mark a newer selection copied when an earlier clipboard operation finishes', async () => {
    let finish!: () => void
    clipboard(
      vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve
          })
      )
    )
    const view = render(<ReferencePanel compact reference='{"selectionId":"old"}' />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy step reference' }))
    view.rerender(<ReferencePanel compact reference='{"selectionId":"new"}' />)
    await act(async () => finish())
    expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Copy step reference' })).toBeTruthy()
    expect(screen.getByText('Saved reference details').closest('details')!.open).toBe(false)
  })
  it('preserves the standalone presentation with its directly visible reference text', () => {
    render(<ReferencePanel reference='{"selectionId":"standalone"}' presentation="browser" />)
    expect(screen.getByRole('textbox', { name: 'Recorded step reference' })).toHaveProperty(
      'value',
      '{"selectionId":"standalone"}'
    )
    expect(screen.queryByText('Saved reference details')).toBeNull()
    expect(screen.getByText(/Paste this reference into your conversation/)).toBeTruthy()
  })
  it('labels a saved state independently from the later watching position', () => {
    render(
      <ReferencePanel
        kind="observation"
        reference='{"selectionId":"state"}'
        observedAt={1185}
        referencePositionMs={1185}
        watchingPositionMs={40000}
      />
    )
    expect(screen.getByRole('button', { name: 'Copy state reference' })).toBeTruthy()
    expect(screen.getByRole('textbox', { name: 'Recorded state reference' })).toBeTruthy()
    expect(screen.getByText('00:01.2')).toBeTruthy()
    expect(screen.getByText('00:40.0')).toBeTruthy()
  })
})
