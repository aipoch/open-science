// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import type { LiteratureCitationStyleView } from '../../../../shared/literature'
import { CitationStylesView } from './CitationStylesView'

afterEach(cleanup)

it('does not request a preview when the pointer only passes briefly over a style', async () => {
  vi.useFakeTimers()
  const previousApi = window.api
  const citationStyles = vi.fn(() => new Promise(() => {}))
  window.api = { literature: { citationStyles } } as unknown as Window['api']
  try {
    render(
      <CitationStylesView
        styles={[{ id: 'apa', title: 'APA', source: 'built-in' }]}
        onBack={vi.fn()}
        onStylesChange={vi.fn()}
      />
    )
    const trigger = screen.getByLabelText('Preview: APA')
    fireEvent.pointerEnter(trigger, { pointerType: 'mouse' })
    fireEvent.pointerMove(trigger, { pointerType: 'mouse' })
    await act(() => vi.advanceTimersByTimeAsync(100))
    fireEvent.pointerLeave(trigger, { pointerType: 'mouse' })
    await act(() => vi.advanceTimersByTimeAsync(300))
    expect(citationStyles).not.toHaveBeenCalled()
    fireEvent.pointerEnter(trigger, { pointerType: 'mouse' })
    fireEvent.pointerMove(trigger, { pointerType: 'mouse' })
    await act(() => vi.advanceTimersByTimeAsync(200))
    expect(citationStyles).toHaveBeenCalledExactlyOnceWith({ kind: 'preview', styleId: 'apa' })
    expect(within(screen.getByRole('tooltip')).getByText('Loading preview…')).not.toBeNull()
  } finally {
    cleanup()
    window.api = previousApi
    vi.useRealTimers()
  }
})

it('imports, previews, and removes a custom CSL through the style manager', async () => {
  const style: LiteratureCitationStyleView = {
    id: 'custom:journal',
    title: 'Test journal',
    source: 'custom'
  }
  const citationStyles = vi
    .fn()
    .mockResolvedValueOnce({ styles: [style], changedStyleId: style.id })
    .mockResolvedValueOnce({
      styles: [style],
      preview: { styleId: style.id, inText: '(Rivera 2024)', reference: 'Rivera. Test reference.' }
    })
    .mockResolvedValueOnce({ styles: [] })
  const previousApi = window.api
  window.api = { literature: { citationStyles } } as unknown as Window['api']
  const onStylesChange = vi.fn()
  const props = { onBack: vi.fn(), onStylesChange }

  try {
    const view = render(<CitationStylesView {...props} styles={[]} />)
    const content = '<style>test CSL</style>'
    const file = new File([content], 'journal.csl', { type: 'application/xml' })
    Object.defineProperty(file, 'text', { value: async () => content })
    fireEvent.change(screen.getByLabelText('Import CSL'), { target: { files: [file] } })
    await waitFor(() => expect(onStylesChange).toHaveBeenCalledWith([style]))
    expect(citationStyles).toHaveBeenCalledWith({ kind: 'import', content })

    view.rerender(<CitationStylesView {...props} styles={[style]} />)
    expect(screen.getByText('Test journal')).not.toBeNull()
    expect(citationStyles).toHaveBeenCalledTimes(1)
    const trigger = screen.getByLabelText('Preview: Test journal')
    fireEvent.pointerEnter(trigger, { pointerType: 'mouse' })
    fireEvent.pointerMove(trigger, { pointerType: 'mouse' })
    const tooltip = await screen.findByRole('tooltip')
    expect(await within(tooltip).findByText('Rivera. Test reference.')).not.toBeNull()
    expect(citationStyles).toHaveBeenLastCalledWith({ kind: 'preview', styleId: style.id })

    fireEvent.click(screen.getByRole('button', { name: 'Delete Test journal' }))
    await waitFor(() => expect(onStylesChange).toHaveBeenLastCalledWith([]))
    expect(citationStyles).toHaveBeenLastCalledWith({ kind: 'delete', styleId: style.id })
    view.rerender(<CitationStylesView {...props} styles={[]} />)
    expect(screen.queryByText('Test journal')).toBeNull()
    expect(screen.getByText('No imported styles')).not.toBeNull()
  } finally {
    window.api = previousApi
  }
})
