// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'

import type { LiteratureCitationStyleView } from '../../../../shared/literature'
import { CitationStylesView } from './CitationStylesView'

afterEach(cleanup)

it('pins a clicked example, retries in place, and ignores hover over another style', async () => {
  vi.useFakeTimers()
  const previousApi = window.api
  const citationStyles = vi
    .fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue({
      styles: [],
      preview: { styleId: 'apa', inText: '(Rivera, 2024)', reference: 'Complete reference' }
    })
  window.api = { literature: { citationStyles } } as unknown as Window['api']
  try {
    render(
      <CitationStylesView
        styles={[
          { id: 'apa', title: 'APA', source: 'built-in' },
          { id: 'mla', title: 'MLA', source: 'built-in' }
        ]}
        onBack={vi.fn()}
        onStylesChange={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Preview: APA' }))
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(within(screen.getByRole('dialog')).getByText('Preview unavailable')).not.toBeNull()
    fireEvent.pointerLeave(screen.getByRole('button', { name: 'Preview: APA' }))
    fireEvent.pointerEnter(screen.getByRole('button', { name: 'Preview: MLA' }), {
      pointerType: 'mouse'
    })
    await act(() => vi.advanceTimersByTimeAsync(400))
    expect(citationStyles).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(within(screen.getByRole('dialog')).getByText('Complete reference')).not.toBeNull()
    // An internal scroll keeps the reading surface open; scrolling the page dismisses it.
    fireEvent.scroll(screen.getByRole('dialog'))
    expect(screen.queryByRole('dialog')).not.toBeNull()
    fireEvent.scroll(document)
    expect(screen.queryByRole('dialog')).toBeNull()
  } finally {
    cleanup()
    window.api = previousApi
    vi.useRealTimers()
  }
})

it('shares the browsing delay and does not mix late preview results across styles', async () => {
  vi.useFakeTimers()
  const previousApi = window.api
  let finishFirst!: (value: unknown) => void
  const citationStyles = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirst = resolve
        })
    )
    .mockResolvedValue({
      styles: [],
      preview: { styleId: 'mla', inText: 'MLA citation', reference: 'MLA reference' }
    })
  window.api = { literature: { citationStyles } } as unknown as Window['api']
  const props = { onBack: vi.fn(), onStylesChange: vi.fn() }
  try {
    const view = render(
      <CitationStylesView
        {...props}
        styles={[
          { id: 'apa', title: 'APA', source: 'built-in' },
          { id: 'mla', title: 'MLA', source: 'built-in' }
        ]}
      />
    )
    const first = screen.getByRole('button', { name: 'Preview: APA' })
    const second = screen.getByRole('button', { name: 'Preview: MLA' })
    fireEvent.pointerEnter(first, { pointerType: 'mouse' })
    await act(() => vi.advanceTimersByTimeAsync(199))
    expect(citationStyles).not.toHaveBeenCalled()
    await act(() => vi.advanceTimersByTimeAsync(1))
    fireEvent.pointerLeave(first, { pointerType: 'mouse' })
    fireEvent.pointerEnter(second, { pointerType: 'mouse' })
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(within(screen.getByRole('dialog')).getByText('MLA reference')).not.toBeNull()
    await act(async () =>
      finishFirst({
        styles: [],
        preview: { styleId: 'apa', inText: 'APA citation', reference: 'APA reference' }
      })
    )
    expect(within(screen.getByRole('dialog')).queryByText('APA reference')).toBeNull()
    fireEvent.pointerLeave(second, { pointerType: 'mouse' })
    fireEvent.pointerEnter(first, { pointerType: 'mouse' })
    expect(within(screen.getByRole('dialog')).getByText('APA reference')).not.toBeNull()
    expect(citationStyles).toHaveBeenCalledTimes(2)
    view.rerender(<CitationStylesView {...props} styles={[]} />)
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(screen.queryByRole('dialog')).toBeNull()
  } finally {
    cleanup()
    window.api = previousApi
    vi.useRealTimers()
  }
})

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
    expect(within(screen.getByRole('dialog')).getByText('Loading preview…')).not.toBeNull()
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
    const tooltip = await screen.findByRole('dialog')
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

const styleA: LiteratureCitationStyleView = {
  id: 'custom:' + 'a'.repeat(64),
  title: 'Style A',
  source: 'custom'
}
const styleB: LiteratureCitationStyleView = {
  id: 'custom:' + 'b'.repeat(64),
  title: 'Style B',
  source: 'custom'
}
const StatefulStyleManager = ({
  initial
}: {
  initial?: LiteratureCitationStyleView[]
}): React.JSX.Element => {
  const [styles, setStyles] = useState(initial)
  return <CitationStylesView styles={styles} onStylesChange={setStyles} onBack={() => {}} />
}
const importFile = (): void => {
  const file = new File(['CSL'], 'journal.csl', { type: 'application/xml' })
  Object.defineProperty(file, 'text', { value: async () => 'CSL' })
  fireEvent.change(screen.getByLabelText('Import CSL'), { target: { files: [file] } })
}

it('CS-03 shows an imported style while the initial list is still pending and ignores its late result', async () => {
  const previousApi = window.api
  let finishList!: (value: unknown) => void
  const citationStyles = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishList = resolve
        })
    )
    .mockResolvedValue({ styles: [styleB], changedStyleId: styleB.id })
  window.api = { literature: { citationStyles } } as unknown as Window['api']
  try {
    render(<StatefulStyleManager />)
    expect(screen.getByText('Loading citation styles…')).not.toBeNull()
    await act(async () => importFile())
    expect(citationStyles).toHaveBeenCalledWith({ kind: 'import', content: 'CSL' })
    expect(screen.queryByText('Loading citation styles…')).toBeNull()
    expect(screen.getByRole('button', { name: 'Preview: Style B' })).not.toBeNull()
    await act(async () => finishList({ styles: [] }))
    expect(screen.getByRole('button', { name: 'Preview: Style B' })).not.toBeNull()
  } finally {
    window.api = previousApi
  }
})

it('CS-04 prevents an import snapshot from restoring a deleted style', async () => {
  const previousApi = window.api
  let finishImport!: (value: unknown) => void
  const citationStyles = vi.fn().mockImplementation((request) =>
    request.kind === 'import'
      ? new Promise((resolve) => {
          finishImport = resolve
        })
      : Promise.resolve({ styles: [styleB], changedStyleId: styleA.id })
  )
  window.api = { literature: { citationStyles } } as unknown as Window['api']
  try {
    render(<StatefulStyleManager initial={[styleA]} />)
    await act(async () => importFile())
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Delete Style A' })))
    const deletedDuringImport = citationStyles.mock.calls.some(
      ([request]) => request.kind === 'delete'
    )
    if (deletedDuringImport)
      expect(screen.queryByRole('button', { name: 'Preview: Style A' })).toBeNull()
    await act(async () => finishImport({ styles: [styleA, styleB], changedStyleId: styleB.id }))
    // With a serialized UI, retry the delete once import finishes.
    if (!deletedDuringImport) {
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Delete Style A' })))
    }
    expect(citationStyles).toHaveBeenCalledWith({ kind: 'delete', styleId: styleA.id })
    expect(screen.queryByRole('button', { name: 'Preview: Style A' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Preview: Style B' })).not.toBeNull()
  } finally {
    window.api = previousApi
  }
})
