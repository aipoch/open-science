// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PdfFigureCollectionDialog } from './PdfFigureCollectionDialog'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('../../../settings/ResourceTagControls', () => ({
  TagSelection: ({
    onChange,
    disabled
  }: {
    onChange: (ids: string[]) => void
    disabled: boolean
  }) => (
    <button disabled={disabled} onClick={() => onChange(['tag-1'])}>
      Select test tag
    </button>
  )
}))

let root: Root
let container: HTMLDivElement
const image = { mimeType: 'image/png' as const, data: 'AQID', byteLength: 3 }

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

it('retains metadata and screenshot on failed save, then retries the same draft', async () => {
  const capture = vi.fn(() => image)
  const onClose = vi.fn()
  const onSave = vi.fn().mockRejectedValueOnce(new Error('unavailable')).mockResolvedValueOnce({})
  await act(async () =>
    root.render(<PdfFigureCollectionDialog capture={capture} onSave={onSave} onClose={onClose} />)
  )
  expect(screen.getByRole('img', { name: 'Selected PDF area' }).getAttribute('src')).toBe(
    'data:image/png;base64,AQID'
  )
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Figure number'), { target: { value: ' Fig. 2 ' } })
    fireEvent.change(screen.getByLabelText('Caption'), { target: { value: ' Response ' } })
    fireEvent.change(screen.getByLabelText('Note (optional)'), { target: { value: ' Review ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Select test tag' }))
  })
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })))
  expect(screen.getByRole('alert').textContent).toContain('Figure could not be saved. Try again.')
  expect((screen.getByLabelText('Caption') as HTMLTextAreaElement).value).toBe(' Response ')
  expect(onClose).not.toHaveBeenCalled()
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })))
  expect(onSave).toHaveBeenCalledTimes(2)
  expect(onSave).toHaveBeenLastCalledWith({
    figureNumber: 'Fig. 2',
    caption: 'Response',
    note: 'Review',
    tagIds: ['tag-1'],
    image
  })
  expect(capture).toHaveBeenCalledTimes(1)
  expect(onClose).toHaveBeenCalledOnce()
})

it('disables save without a screenshot and lets capture retry preserve metadata', async () => {
  const capture = vi
    .fn()
    .mockImplementationOnce(() => {
      throw new Error('canvas unavailable')
    })
    .mockReturnValueOnce(image)
  const onSave = vi.fn()
  await act(async () =>
    root.render(<PdfFigureCollectionDialog capture={capture} onSave={onSave} onClose={vi.fn()} />)
  )
  expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Figure number'), { target: { value: 'Table 1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  })
  expect(screen.getByRole('img', { name: 'Selected PDF area' })).not.toBeNull()
  expect((screen.getByLabelText('Figure number') as HTMLInputElement).value).toBe('Table 1')
  expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false)
  expect(onSave).not.toHaveBeenCalled()
})

it('keeps the dialog open and prevents duplicate writes while saving', async () => {
  let resolve!: () => void
  const onSave = vi.fn(
    () =>
      new Promise<void>((yes) => {
        resolve = yes
      })
  )
  const onClose = vi.fn()
  await act(async () =>
    root.render(
      <PdfFigureCollectionDialog capture={() => image} onSave={onSave} onClose={onClose} />
    )
  )
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })))
  const save = screen.getByRole('button', { name: 'Saving…' }) as HTMLButtonElement
  expect(save.disabled).toBe(true)
  await act(async () => {
    fireEvent.click(save)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
  })
  expect(onSave).toHaveBeenCalledOnce()
  expect(onClose).not.toHaveBeenCalled()
  expect((screen.getByLabelText('Figure number') as HTMLInputElement).disabled).toBe(true)
  await act(async () => resolve())
  expect(onClose).toHaveBeenCalledOnce()
})
