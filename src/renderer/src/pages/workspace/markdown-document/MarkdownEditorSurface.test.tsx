// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MarkdownEditorSurface } from './MarkdownEditorSurface'
import { insertMarkdownBlock } from './markdown-blocks'
import { createMarkdownEditor } from './markdown-editor'
import type * as MarkdownEditorModule from './markdown-editor'

vi.mock('./markdown-editor', async (importOriginal) => {
  const actual = await importOriginal<typeof MarkdownEditorModule>()
  return { ...actual, createMarkdownEditor: vi.fn(actual.createMarkdownEditor) }
})

describe('MarkdownEditorSurface', () => {
  afterEach(() => cleanup())

  it('opens directly in Plate rich text mode without emitting an edit', () => {
    const onChange = vi.fn()
    render(<MarkdownEditorSurface source={'# Hello\n\n**world**\n'} onChange={onChange} />)

    expect(screen.getByTestId('markdown-plate-editor')).toBeTruthy()
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Hello')
    expect(screen.queryByRole('button', { name: 'Rich text mode' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Source mode' })).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('renders registered inline marks as semantic elements', () => {
    render(
      <MarkdownEditorSurface
        source={'**bold** *italic* `code` ~~deleted~~ ***both***\n'}
        onChange={vi.fn()}
      />
    )
    expect(screen.getByText('bold').closest('strong')).not.toBeNull()
    expect(screen.getByText('italic').closest('em')).not.toBeNull()
    expect(screen.getByText('code').closest('code')).not.toBeNull()
    expect(screen.getByText('deleted').closest('del')).not.toBeNull()
    expect(screen.getByText('both').closest('strong')).not.toBeNull()
    expect(screen.getByText('both').closest('em')).not.toBeNull()
  })

  it('refuses lossy Markdown instead of exposing a source editor', () => {
    render(
      <MarkdownEditorSurface source={'<details>\nUnsupported\n</details>\n'} onChange={vi.fn()} />
    )

    expect(screen.getByRole('alert')).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('does not report a source edit when only the caret moves', async () => {
    const onChange = vi.fn()
    render(<MarkdownEditorSurface source={'# Hello\n\nworld\n'} onChange={onChange} />)
    const editor = vi.mocked(createMarkdownEditor).mock.results.at(-1)!.value
    await act(async () => {
      editor.tf.select({ path: [0, 0], offset: 2 })
    })
    await act(async () => {
      editor.tf.select({ path: [1, 0], offset: 2 })
    })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('shows an inserted block placeholder in that block and hides it after typing', async () => {
    render(<MarkdownEditorSurface source={'Before\n'} onChange={vi.fn()} />)
    const editor = vi.mocked(createMarkdownEditor).mock.results.at(-1)!.value

    await act(async () => {
      insertMarkdownBlock(editor, [0], 'h1')
      editor.tf.focus()
    })

    const heading = screen.getByRole('heading', { level: 1 })
    expect(heading.getAttribute('data-markdown-placeholder')).toBe('Heading 1')
    expect(heading.className).toContain('relative')
    expect(heading.className).toContain('before:absolute')
    expect(heading.className).toContain('before:content-[attr(data-markdown-placeholder)]')
    expect(
      screen.getAllByTestId('markdown-plate-editor')[0].querySelectorAll('[data-markdown-block]')
    ).toHaveLength(2)

    await act(async () => {
      editor.tf.select({ path: [0, 0], offset: 6 })
    })
    await waitFor(() => expect(heading.getAttribute('data-markdown-placeholder')).toBeNull())

    await act(async () => {
      editor.tf.select({ path: [1, 0], offset: 0 })
    })
    await waitFor(() => expect(heading.getAttribute('data-markdown-placeholder')).toBe('Heading 1'))

    await act(async () => {
      editor.tf.insertText('Title')
    })

    await waitFor(() => expect(heading.getAttribute('data-markdown-placeholder')).toBeNull())
  })

  it('uses the generic placeholder after an inserted heading becomes a paragraph', async () => {
    render(<MarkdownEditorSurface source={'Before\n'} onChange={vi.fn()} />)
    const editor = vi.mocked(createMarkdownEditor).mock.results.at(-1)!.value

    await act(async () => {
      insertMarkdownBlock(editor, [0], 'h1')
      editor.tf.insertText('Title')
      editor.tf.insertBreak()
    })

    const paragraphs = screen.getByTestId('markdown-plate-editor').querySelectorAll('p')
    const paragraph = paragraphs[paragraphs.length - 1]
    expect(paragraph?.getAttribute('data-markdown-placeholder')).toBe(
      'Type / for blocks, @ to mention'
    )
    expect(paragraph?.className).toContain('relative')
    expect(paragraph?.className).toContain('before:absolute')
    expect(paragraph?.className).toContain('before:content-[attr(data-markdown-placeholder)]')
  })

  it('keeps block controls visible while a menu is open without focus decoration', async () => {
    render(<MarkdownEditorSurface source={'Before\n'} onChange={vi.fn()} />)

    const insertButton = screen.getByRole('button', { name: 'Insert block' })
    const dragButton = screen.getByRole('button', { name: 'Drag block' })
    const controls = insertButton.closest('[class*="absolute"]')

    expect(controls).not.toBeNull()
    for (const button of [insertButton, dragButton]) {
      expect(button.classList.contains('focus-visible:outline-none!')).toBe(true)
      expect(button.classList.contains('focus-visible:ring-0!')).toBe(true)
      expect(button.classList.contains('focus-visible:shadow-none!')).toBe(true)

      fireEvent(button, new MouseEvent('pointerdown', { bubbles: true, button: 0, ctrlKey: false }))
      await waitFor(() => expect(button.getAttribute('aria-expanded')).toBe('true'))
      expect(controls?.classList.contains('opacity-100')).toBe(true)
      expect(controls?.classList.contains('opacity-0')).toBe(false)

      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
      await waitFor(() => expect(button.getAttribute('aria-expanded')).toBe('false'))
      expect(controls?.classList.contains('opacity-0')).toBe(true)
    }
  })

  it('renders actual per-key editor transformations and reports their Markdown', async () => {
    const onChange = vi.fn()
    render(<MarkdownEditorSurface source="" onChange={onChange} />)
    const editor = vi.mocked(createMarkdownEditor).mock.results.at(-1)!.value
    await act(async () => {
      editor.tf.select({ path: [0, 0], offset: 0 })
      for (const character of '## Heading') editor.tf.insertText(character)
      editor.tf.insertBreak()
      for (const character of '**bold**') editor.tf.insertText(character)
    })
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Heading')
    expect(screen.getByText('bold').closest('strong')).not.toBeNull()
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith('## Heading\n\n**bold**\n'))
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('sends the selected text with the instruction and retains rejected input', async () => {
    const submit = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const onChange = vi.fn()
    render(
      <MarkdownEditorSurface
        source="A selected passage.\n"
        onChange={onChange}
        onSubmitRequest={submit}
      />
    )
    const editor = vi.mocked(createMarkdownEditor).mock.results.at(-1)!.value
    await act(async () => {
      editor.tf.select({ anchor: { path: [0, 0], offset: 2 }, focus: { path: [0, 0], offset: 10 } })
    })
    fireEvent.click(screen.getByRole('button', { name: 'Ask agent' }))
    const prompt = screen.getByRole('textbox', { name: 'Tell the agent what to write or edit' })
    fireEvent.change(prompt, { target: { value: 'Explain the selection' } })
    fireEvent.submit(screen.getByTestId('markdown-agent-prompt'))
    await waitFor(() =>
      expect(submit).toHaveBeenCalledWith({
        instruction: 'Explain the selection',
        selection: { quote: 'selected' }
      })
    )
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(prompt).toHaveProperty('value', 'Explain the selection')
    fireEvent.submit(screen.getByTestId('markdown-agent-prompt'))
    await waitFor(() => expect(screen.queryByTestId('markdown-agent-prompt')).toBeNull())
    expect(onChange).not.toHaveBeenCalled()
  })
})
