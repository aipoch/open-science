// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { PptxRichTextEditor } from './PptxRichTextEditor'
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
afterEach(cleanup)
it('applies toolbar formatting to the retained selection and submits rich paragraphs', () => {
  const onApply = vi.fn()
  render(
    <PptxRichTextEditor
      label="Shape text"
      initial={[{ runs: [{ text: 'Hello world' }] }]}
      onApply={onApply}
      onCancel={vi.fn()}
    />
  )
  const input = screen.getByLabelText('Shape text') as HTMLTextAreaElement
  input.setSelectionRange(0, 5)
  fireEvent.select(input)
  fireEvent.click(screen.getByRole('button', { name: 'Bold' }))
  fireEvent.click(screen.getByRole('button', { name: 'Italic' }))
  fireEvent.click(screen.getByRole('button', { name: 'Underline' }))
  fireEvent.change(screen.getByLabelText('Font size'), { target: { value: '24' } })
  fireEvent.change(screen.getByLabelText('Text color'), { target: { value: '#123456' } })
  fireEvent.click(screen.getByRole('button', { name: 'Link' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Link' }), {
    target: { value: 'https://example.org' }
  })
  fireEvent.click(screen.getAllByRole('button', { name: 'Apply' })[0])
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
  expect(onApply).toHaveBeenCalledWith('Hello world', [
    {
      runs: [
        {
          text: 'Hello',
          bold: true,
          italic: true,
          underline: true,
          sizePt: 24,
          color: '123456',
          hyperlink: 'https://example.org'
        },
        { text: ' world' }
      ]
    }
  ])
})

it('allows clearing and replacing the font size without reverting to the old value', () => {
  const onApply = vi.fn()
  render(
    <PptxRichTextEditor
      label="Shape text"
      initial={[{ runs: [{ text: 'New text', sizePt: 18 }] }]}
      onApply={onApply}
      onCancel={vi.fn()}
    />
  )
  const size = screen.getByRole('spinbutton', { name: 'Font size' }) as HTMLInputElement
  fireEvent.change(size, { target: { value: '' } })
  expect(size.value).toBe('')
  expect(screen.getByRole('button', { name: 'Apply' })).toHaveProperty('disabled', true)
  fireEvent.change(size, { target: { value: '72' } })
  fireEvent.blur(size)
  expect(size.value).toBe('72')
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
  expect(onApply).toHaveBeenCalledWith('New text', [{ runs: [{ text: 'New text', sizePt: 72 }] }])
})
