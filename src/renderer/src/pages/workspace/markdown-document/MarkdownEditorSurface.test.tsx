// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MarkdownEditorSurface } from './MarkdownEditorSurface'
import { insertMarkdownBlock, turnMarkdownBlockInto } from './markdown-blocks'
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

  it.each([
    ['bullet', 'Bulleted list'],
    ['numbered', 'Numbered list'],
    ['checklist', 'Checklist']
  ] as const)(
    'renders the %s placeholder only on the empty list text block',
    async (kind, label) => {
      render(<MarkdownEditorSurface source={'Before\n'} onChange={vi.fn()} />)
      const editor = vi.mocked(createMarkdownEditor).mock.results.at(-1)!.value
      const surface = screen.getByTestId('markdown-plate-editor')
      await act(async () => insertMarkdownBlock(editor, [0], kind))
      const placeholder = surface.querySelector('[data-markdown-placeholder]')
      expect(surface.querySelectorAll('[data-markdown-placeholder]')).toHaveLength(1)
      expect(placeholder?.classList.contains('slate-lic')).toBe(true)
      expect(placeholder?.getAttribute('data-markdown-placeholder')).toBe(label)
      expect(
        surface.querySelector(
          'ul[data-markdown-placeholder], ol[data-markdown-placeholder], li[data-markdown-placeholder]'
        )
      ).toBeNull()
      await act(async () => editor.tf.insertText('Item'))
      expect(surface.querySelector('[data-markdown-placeholder]')).toBeNull()
      await act(async () => editor.tf.insertBreak())
      expect(
        surface
          .querySelector('[data-markdown-placeholder]')
          ?.getAttribute('data-markdown-placeholder')
      ).toBe(label)
      await act(async () => editor.tf.select({ path: [0, 0], offset: 0 }))
      expect(surface.querySelector('[data-markdown-placeholder]')).toBeNull()
    }
  )

  it('shows the target placeholder after converting an empty block', async () => {
    render(<MarkdownEditorSurface source="" onChange={vi.fn()} />)
    const editor = vi.mocked(createMarkdownEditor).mock.results.at(-1)!.value
    await act(async () => {
      editor.tf.select({ path: [0, 0], offset: 0 })
      turnMarkdownBlockInto(editor, [0], 'h2')
    })
    expect(
      screen.getByRole('heading', { level: 2 }).getAttribute('data-markdown-placeholder')
    ).toBe('Heading 2')
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
      if (button === dragButton) fireEvent.click(button)
      await waitFor(() => expect(button.getAttribute('aria-expanded')).toBe('true'))
      expect(controls?.classList.contains('opacity-100')).toBe(true)
      expect(controls?.classList.contains('opacity-0')).toBe(false)

      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
      await waitFor(() => expect(button.getAttribute('aria-expanded')).toBe('false'))
      expect(controls?.classList.contains('opacity-0')).toBe(true)
    }
  })

  it('waits for a click rather than opening the block menu on pointer down', async () => {
    render(<MarkdownEditorSurface source={'First\n\nSecond\n'} onChange={vi.fn()} />)
    const handle = screen.getAllByRole('button', { name: 'Drag block' })[0]

    fireEvent(handle, new MouseEvent('pointerdown', { bubbles: true, button: 0, ctrlKey: false }))
    expect(handle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('menu')).toBeNull()

    fireEvent.pointerUp(handle)
    fireEvent.click(handle)
    expect(await screen.findByRole('menu')).toBeTruthy()
  })

  it.each([
    { from: 0, to: 2, y: 25, expected: 'Second\n\nFirst\n\nThird\n' },
    { from: 0, to: 2, y: 75, expected: 'Second\n\nThird\n\nFirst\n' },
    { from: 2, to: 0, y: 25, expected: 'Third\n\nFirst\n\nSecond\n' },
    { from: 2, to: 0, y: 75, expected: 'First\n\nThird\n\nSecond\n' }
  ])('drops block $from at block $to with pointer y=$y', async ({ from, to, y, expected }) => {
    const onChange = vi.fn()
    render(<MarkdownEditorSurface source={'First\n\nSecond\n\nThird\n'} onChange={onChange} />)
    const blocks = screen
      .getByTestId('markdown-plate-editor')
      .querySelectorAll<HTMLElement>('[data-markdown-block]')
    const handle = within(blocks[from]).getByRole('button', { name: 'Drag block' })
    const bounds = vi
      .spyOn(blocks[to], 'getBoundingClientRect')
      .mockReturnValue(new DOMRect(0, 0, 100, 100))
    const dataTransfer = {
      types: ['application/x-openscience-markdown-block'],
      setData: vi.fn(),
      setDragImage: vi.fn(),
      effectAllowed: '',
      dropEffect: ''
    }
    const dispatchDrag = (target: Element, type: string, clientY = 0): void => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientY })
      Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
      fireEvent(target, event)
    }

    dispatchDrag(handle, 'dragstart')
    dispatchDrag(blocks[to], 'dragover', y)
    expect(blocks[to].getAttribute('data-drop-position')).toBe(y < 50 ? 'before' : 'after')
    expect(dataTransfer.dropEffect).toBe('move')
    dispatchDrag(blocks[to], 'drop', y)
    dispatchDrag(handle, 'dragend')
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(expected))
    expect(
      screen.getByTestId('markdown-plate-editor').querySelector('[data-drop-position]')
    ).toBeNull()
    fireEvent.click(handle, { detail: 1 })
    expect(screen.queryByRole('menu')).toBeNull()
    bounds.mockRestore()
  })

  it('renders controls on every list item, with valid list markup and per-item moves', async () => {
    const onChange = vi.fn()
    render(<MarkdownEditorSurface source={'- First\n- Second\n- Third\n'} onChange={onChange} />)
    const surface = screen.getByTestId('markdown-plate-editor')
    const items = within(surface).getAllByRole('listitem')
    expect(surface.querySelectorAll('[data-markdown-block]')).toHaveLength(3)
    for (const item of items) {
      expect(item.parentElement?.tagName).toBe('UL')
      expect(within(item).getByRole('button', { name: 'Insert block' })).toBeTruthy()
      expect(within(item).getByRole('button', { name: 'Drag block' })).toBeTruthy()
    }
    fireEvent.click(within(items[1]).getByRole('button', { name: 'Drag block' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move Up' }))
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith('- Second\n- First\n- Third\n'))
  })

  it('handles Tab and Shift+Tab in list prose, but not in readonly editors', async () => {
    const onChange = vi.fn()
    const view = render(
      <MarkdownEditorSurface source={'- First\n- Second\n'} onChange={onChange} />
    )
    const editor = vi.mocked(createMarkdownEditor).mock.results.at(-1)!.value
    const surface = screen.getByTestId('markdown-plate-editor')
    await act(async () => editor.tf.select({ path: [0, 1, 0, 0], offset: 3 }))
    expect(fireEvent.keyDown(surface, { key: 'Tab' })).toBe(false)
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith('- First\n  - Second\n'))
    expect(surface.querySelectorAll('ul ul li')).toHaveLength(1)
    expect(fireEvent.keyDown(surface, { key: 'Tab', shiftKey: true })).toBe(false)
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith('- First\n- Second\n'))
    view.rerender(
      <MarkdownEditorSurface source={'- First\n- Second\n'} disabled onChange={onChange} />
    )
    const before = editor.children
    fireEvent.keyDown(surface, { key: 'Tab' })
    expect(editor.children).toBe(before)
    expect(within(surface).queryByRole('button')).toBeNull()
  })

  it('groups insert options with decorative icons and preserves block insertion', async () => {
    render(<MarkdownEditorSurface source={'Before\n'} onChange={vi.fn()} />)

    fireEvent(
      screen.getByRole('button', { name: 'Insert block' }),
      new MouseEvent('pointerdown', { bubbles: true, button: 0, ctrlKey: false })
    )
    const menu = await screen.findByRole('menu')
    const groups = within(menu).getAllByRole('group')
    expect(
      groups.map((group) =>
        within(group)
          .getAllByRole('menuitem')
          .map((item) => item.textContent)
      )
    ).toEqual([
      ['Heading 1', 'Heading 2', 'Heading 3'],
      ['Bulleted list', 'Numbered list', 'Checklist'],
      ['Table', 'Image', 'Code block', 'Block quote', 'Divider'],
      ['Date', 'Dropdown']
    ])
    expect(within(menu).getAllByRole('separator')).toHaveLength(3)
    for (const item of within(menu).getAllByRole('menuitem')) {
      expect(item.querySelectorAll('svg')).toHaveLength(1)
      expect(item.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
    }

    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Heading 2' }))
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(
      screen.getByRole('heading', { level: 2 }).getAttribute('data-markdown-placeholder')
    ).toBe('Heading 2')
    const editor = vi.mocked(createMarkdownEditor).mock.results.at(-1)!.value
    expect(editor.selection).toEqual({
      anchor: { path: [1, 0], offset: 0 },
      focus: { path: [1, 0], offset: 0 }
    })
  })

  it('opens the date picker from the final insert group before inserting a date', async () => {
    const onChange = vi.fn()
    render(<MarkdownEditorSurface source={'Before\n'} onChange={onChange} />)

    fireEvent(
      screen.getByRole('button', { name: 'Insert block' }),
      new MouseEvent('pointerdown', { bubbles: true, button: 0, ctrlKey: false })
    )
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Date' }))

    const dateInput = await screen.findByLabelText('Date')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.change(dateInput, { target: { value: '2026-11-19' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith('Before\n\n2026-11-19\n'))
    expect(screen.queryByLabelText('Date')).toBeNull()
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

  it.each(['accept', 'reject', 'stale document', 'wrong token', 'unsupported'] as const)(
    'reviews a replacement without touching the draft: %s',
    async (action) => {
      const source = 'Left **same** and **same** right.\n'
      const onChange = vi.fn()
      const onDirtyChange = vi.fn()
      const onSubmitRequest = vi.fn().mockResolvedValue(true)
      const onDismiss = vi.fn()
      const props = { source, onChange, onDirtyChange, onSubmitRequest }
      const view = render(<MarkdownEditorSurface {...props} />)
      const editor = vi.mocked(createMarkdownEditor).mock.results.at(-1)!.value
      await act(async () =>
        editor.tf.select({
          anchor: { path: [0, 3], offset: 4 },
          focus: { path: [0, 3], offset: 0 }
        })
      )
      fireEvent.click(screen.getByRole('button', { name: 'Ask agent' }))
      await act(async () => editor.tf.select({ path: [0, 1], offset: 0 }))
      fireEvent.change(
        screen.getByRole('textbox', { name: 'Tell the agent what to write or edit' }),
        { target: { value: 'Replace' } }
      )
      fireEvent.submit(screen.getByTestId('markdown-agent-prompt'))
      await waitFor(() => expect(screen.queryByTestId('markdown-agent-prompt')).toBeNull())
      const request = onSubmitRequest.mock.calls[0][0]
      expect(request.selectionMarkdown).toBe('**same**\n')
      const markdown = action === 'unsupported' ? '<details>no</details>' : '*new*\n\nnext'
      const replacement = {
        markdown,
        onDismiss,
        token: action === 'wrong token' ? 'earlier-request' : request.selectionToken
      }
      view.rerender(<MarkdownEditorSurface {...props} replacement={replacement} />)
      const accept = screen.getByRole('button', { name: 'Accept' })
      expect(onDirtyChange).not.toHaveBeenCalled()
      expect(onChange).not.toHaveBeenCalled()
      if (action === 'stale document') {
        await act(async () => editor.tf.insertText('x'))
        await waitFor(() => expect(accept).toHaveProperty('disabled', true))
      } else if (action === 'wrong token' || action === 'unsupported') {
        expect(screen.getByRole('alert')).toBeTruthy()
        expect(accept).toHaveProperty('disabled', true)
      } else if (action === 'reject') {
        fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
        expect(onDismiss).toHaveBeenCalledOnce()
        expect(onDirtyChange).not.toHaveBeenCalled()
        expect(onChange).not.toHaveBeenCalled()
      } else {
        expect(view.container.querySelector('ins')).not.toBeNull()
        fireEvent.click(accept)
        expect(onDismiss).toHaveBeenCalledOnce()
        await waitFor(() =>
          expect(onChange).toHaveBeenLastCalledWith('Left **same** and _new_\n\nnext right.\n')
        )
        await act(async () => editor.tf.undo())
        await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(source))
      }
    }
  )

  it('keeps the selection from pointerdown when Ask agent is clicked', async () => {
    render(<MarkdownEditorSurface source="Current" onChange={vi.fn()} />)
    const editor = vi.mocked(createMarkdownEditor).mock.results.at(-1)!.value
    await act(async () => editor.tf.select(editor.api.range([])))
    const ask = screen.getByRole('button', { name: 'Ask agent' })
    fireEvent.pointerDown(ask, { button: 0 })
    await act(async () => editor.tf.collapse({ edge: 'end' }))
    fireEvent.click(ask, { detail: 1 })
    expect(
      screen.getByTestId('markdown-agent-prompt').querySelector('blockquote')?.textContent
    ).toBe('Current')
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
        selection: { quote: 'selected' },
        selectionMarkdown: 'selected\n',
        selectionToken: expect.any(String)
      })
    )
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(prompt).toHaveProperty('value', 'Explain the selection')
    fireEvent.submit(screen.getByTestId('markdown-agent-prompt'))
    await waitFor(() => expect(screen.queryByTestId('markdown-agent-prompt')).toBeNull())
    expect(onChange).not.toHaveBeenCalled()
  })
})
