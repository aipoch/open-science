// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent } from '@testing-library/dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PdfAnnotationMarker } from './PdfAnnotationMarker'
import { usePdfAnnotations } from './pdf-annotations-context'

vi.mock('./pdf-annotations-context', () => ({ usePdfAnnotations: vi.fn() }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
let root: Root
let container: HTMLDivElement
const update = vi.fn().mockResolvedValue({})
const remove = vi.fn().mockResolvedValue(true)
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  update.mockClear()
  remove.mockClear()
  vi.mocked(usePdfAnnotations).mockReturnValue({
    available: true,
    update,
    remove
  } as unknown as ReturnType<typeof usePdfAnnotations>)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})
const mount = async (note: string): Promise<void> => {
  await act(async () =>
    root.render(<PdfAnnotationMarker id="a1" left="10%" top="20%" note={note} />)
  )
}
it('opens a readable comment before editing and writes only on Save', async () => {
  const note = 'A long comment\n'.repeat(80)
  await mount(note)
  await act(async () => fireEvent.click(container.querySelector('button')!))
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(note)
  expect(document.querySelector('textarea')).toBeNull()
  expect(update).not.toHaveBeenCalled()
  const edit = Array.from(document.querySelectorAll('button')).find(
    (button) => button.textContent === 'Edit annotation note'
  )!
  await act(async () => fireEvent.click(edit))
  const textarea = document.querySelector('textarea')!
  expect(textarea.value).toBe(note)
  await act(async () => fireEvent.change(textarea, { target: { value: 'Revised comment' } }))
  const save = Array.from(document.querySelectorAll('button')).find(
    (button) => button.textContent === 'Save'
  )!
  await act(async () => fireEvent.click(save))
  expect(update).toHaveBeenCalledWith('a1', { note: 'Revised comment' })
})
it('opens an empty mark directly in the editor', async () => {
  await mount('')
  await act(async () => fireEvent.click(container.querySelector('button')!))
  expect(document.querySelector('textarea')).not.toBeNull()
  expect(update).not.toHaveBeenCalled()
})
it('deletes the mark when Backspace is pressed on its trigger', async () => {
  await mount('Comment')
  const trigger = container.querySelector('button[data-pdf-annotation-marker]')!
  await act(async () => fireEvent.keyDown(trigger, { key: 'Backspace' }))
  expect(remove).toHaveBeenCalledWith('a1')
})
it('keeps Backspace available for note editing', async () => {
  await mount('Comment')
  await act(async () => fireEvent.click(container.querySelector('button')!))
  const edit = Array.from(document.querySelectorAll('button')).find(
    (button) => button.textContent === 'Edit annotation note'
  )!
  await act(async () => fireEvent.click(edit))
  const textarea = document.querySelector('textarea')!
  await act(async () => fireEvent.keyDown(textarea, { key: 'Backspace' }))
  expect(remove).not.toHaveBeenCalled()
})

it('offers deletion inside the comment popover instead of beside its trigger', async () => {
  await mount('Comment')
  expect(container.querySelectorAll('button')).toHaveLength(1)
  await act(async () => fireEvent.click(container.querySelector('button')!))
  const deleteButton = [
    ...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')
  ].find((button) => button.textContent === 'Delete annotation')!
  expect(deleteButton).toBeDefined()
  await act(async () => fireEvent.click(deleteButton))
  expect(remove).toHaveBeenCalledWith('a1')
})
