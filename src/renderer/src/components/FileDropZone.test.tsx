// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createPortal } from 'react-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileDropZone } from './FileDropZone'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
afterEach(cleanup)
const picker = {
  label: 'Select files',
  description: 'Drop files here',
  accept: '.pdf',
  multiple: true
}
const files = [new File(['pdf'], 'one.pdf'), new File(['pdf'], 'two.pdf')]
const transfer = (): { types: string[]; files: File[]; dropEffect: string } => ({
  types: ['Files'],
  files,
  dropEffect: 'none'
})

describe('FileDropZone', () => {
  it('delivers the same complete selection for picker and drop, including repeated selections', () => {
    const onFiles = vi.fn()
    const { container } = render(
      <FileDropZone dropLabel="Drop now" picker={picker} onFiles={onFiles} />
    )
    const input = screen.getByLabelText('Select files') as HTMLInputElement
    const click = vi.spyOn(input, 'click')
    fireEvent.click(screen.getByRole('button', { name: 'Select files' }))
    expect(click).toHaveBeenCalledOnce()
    fireEvent.change(input, { target: { files } })
    fireEvent.change(input, { target: { files } })
    fireEvent.drop(container.firstChild!, { dataTransfer: transfer() })
    expect(onFiles.mock.calls).toEqual([[files], [files], [files]])
    expect(input.multiple).toBe(true)
    expect(input.value).toBe('')
  })

  it.each([{ disabled: true }, { busy: true }])(
    'blocks file intake and browser navigation when %s',
    (props) => {
      const onFiles = vi.fn()
      const { container } = render(
        <FileDropZone {...props} picker={picker} dropLabel="Drop now" onFiles={onFiles} />
      )
      expect(screen.getByRole('button')).toHaveProperty('disabled', true)
      expect(fireEvent.drop(container.firstChild!, { dataTransfer: transfer() })).toBe(false)
      fireEvent.change(screen.getByLabelText('Select files'), { target: { files } })
      expect(onFiles).not.toHaveBeenCalled()
      expect(screen.queryByText('Drop now')).toBeNull()
    }
  )

  it('ignores non-file drags and clears the highlight on blur and disable', () => {
    const onFiles = vi.fn()
    const { container, rerender } = render(
      <FileDropZone picker={picker} dropLabel="Drop now" onFiles={onFiles} />
    )
    fireEvent.dragEnter(container.firstChild!, { dataTransfer: { types: ['text/plain'] } })
    expect(screen.queryByText('Drop now')).toBeNull()
    fireEvent.dragEnter(container.firstChild!, { dataTransfer: transfer() })
    expect(screen.getByText('Drop now')).not.toBeNull()
    fireEvent.blur(window)
    expect(screen.queryByText('Drop now')).toBeNull()
    fireEvent.dragEnter(container.firstChild!, { dataTransfer: transfer() })
    rerender(<FileDropZone disabled picker={picker} dropLabel="Drop now" onFiles={onFiles} />)
    expect(screen.queryByText('Drop now')).toBeNull()
  })

  it('rejects directories without losing files silently and recovers on the next valid drop', () => {
    const onFiles = vi.fn()
    const { container } = render(
      <FileDropZone picker={picker} dropLabel="Drop now" onFiles={onFiles} />
    )
    fireEvent.drop(container.firstChild!, {
      dataTransfer: { ...transfer(), items: [{ webkitGetAsEntry: () => ({ isDirectory: true }) }] }
    })
    expect(screen.getByRole('alert').textContent).toContain('Folders cannot be added.')
    expect(onFiles).not.toHaveBeenCalled()
    fireEvent.drop(container.firstChild!, { dataTransfer: transfer() })
    expect(onFiles).toHaveBeenCalledOnce()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('lets only the inner physical target claim files and ignores portaled children', () => {
    const outer = vi.fn(),
      inner = vi.fn()
    render(
      <FileDropZone dropLabel="Outer" onFiles={outer}>
        <FileDropZone dropLabel="Inner" onFiles={inner} picker={picker} />
        {createPortal(<div data-testid="portal" />, document.body)}
      </FileDropZone>
    )
    fireEvent.drop(screen.getByText('Drop files here'), { dataTransfer: transfer() })
    expect(inner).toHaveBeenCalledOnce()
    expect(outer).not.toHaveBeenCalled()
    fireEvent.drop(screen.getByTestId('portal'), { dataTransfer: transfer() })
    expect(outer).not.toHaveBeenCalled()
  })

  it('does not accept files on an inert or modal-covered surface', () => {
    const onFiles = vi.fn()
    render(
      <div aria-hidden="true">
        <FileDropZone dropLabel="Drop now" onFiles={onFiles} picker={picker} />
      </div>
    )
    fireEvent.drop(screen.getByText('Drop files here'), { dataTransfer: transfer() })
    expect(onFiles).not.toHaveBeenCalled()
  })
})
