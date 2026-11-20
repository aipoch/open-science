import { describe, expect, it } from 'vitest'
import type { PlateEditor } from 'platejs/react'

import { parseMarkdownDocument, serializeMarkdownDocument } from './markdown-codec'
import { insertMarkdownBlock } from './markdown-blocks'
import { createMarkdownEditor } from './markdown-editor'

const createEditor = (source = ''): PlateEditor => {
  const editor = createMarkdownEditor(parseMarkdownDocument(source).value)
  editor.tf.select(editor.api.end([])!)
  return editor
}

// Exercise Plate's per-key transform rather than replacing the DOM's text content.
const type = (editor: PlateEditor, text: string): void => {
  for (const character of text) {
    if (character === '\n') editor.tf.insertBreak()
    else editor.tf.insertText(character)
  }
}

const expectMarkdown = (editor: PlateEditor, source: string): void => {
  expect(serializeMarkdownDocument(editor.children)).toBe(
    serializeMarkdownDocument(parseMarkdownDocument(source).value)
  )
}

describe('Markdown live keyboard input', () => {
  it('does not carry an inserted heading placeholder into the paragraph after Enter', () => {
    const editor = createEditor('Before')
    const insertedPath = insertMarkdownBlock(editor, [0], 'h1')
    editor.tf.insertText('Title')
    editor.tf.insertBreak()

    expect(editor.children[insertedPath[0] + 1]).toMatchObject({ type: 'p' })
    expect(editor.children[insertedPath[0] + 1]).not.toHaveProperty('placeholderKind')
  })

  it.each([1, 2, 3, 4, 5, 6])(
    'converts heading level %i at the space and resets on Enter',
    (level) => {
      const editor = createEditor()
      type(editor, `${'#'.repeat(level)} Heading`)
      expect(editor.children[0]).toMatchObject({
        type: `h${level}`,
        children: [{ text: 'Heading' }]
      })
      type(editor, '\nParagraph')
      expect(editor.children[1]).toMatchObject({ type: 'p', children: [{ text: 'Paragraph' }] })
      expectMarkdown(editor, `${'#'.repeat(level)} Heading\n\nParagraph`)
    }
  )

  it.each([
    ['**bold**', { bold: true }],
    ['__bold__', { bold: true }],
    ['*italic*', { italic: true }],
    ['_italic_', { italic: true }],
    ['***both***', { bold: true, italic: true }],
    ['`code`', { code: true }],
    ['~~deleted~~', { strikethrough: true }]
  ])('renders %s on its closing delimiter without carrying its marks forward', (source, marks) => {
    const editor = createEditor()
    type(editor, source)
    expect(editor.children[0].children[0]).toMatchObject(marks)
    expectMarkdown(editor, source)
    type(editor, ' plain')
    expect(editor.children[0].children.at(-1)).toEqual({ text: ' plain' })
  })

  it.each(['**bold**', '*italic*', '`code`', '# '])(
    'keeps neighboring blocks, caret and undo/redo intact for %s',
    (source) => {
      const editor = createMarkdownEditor([
        { type: 'p', children: [{ text: 'Before' }] },
        { type: 'p', children: [{ text: '' }] },
        { type: 'p', children: [{ text: 'After' }] }
      ])
      const before = editor.children[0]
      const after = editor.children[2]
      editor.tf.select({ path: [1, 0], offset: 0 })
      type(editor, source.slice(0, -1))
      const previous = editor.children
      type(editor, source.slice(-1))
      const formatted = editor.children
      expect(editor.children[0]).toBe(before)
      expect(editor.children[2]).toBe(after)
      expect(editor.selection?.anchor.path[0]).toBe(1)
      editor.tf.undo()
      expect(editor.children).toEqual(previous)
      editor.tf.redo()
      expect(editor.children).toEqual(formatted)
      type(editor, 'x')
      expect(editor.api.string([1])).toContain('x')
      expect(editor.children[0]).toBe(before)
      expect(editor.children[2]).toBe(after)
    }
  )

  it.each(['not_a_word_', '\\*literal*', 'prefix # heading', '******* heading'])(
    'leaves non-shorthand text literal: %s',
    (source) => {
      const editor = createEditor()
      type(editor, source)
      expect(editor.children[0]).toMatchObject({ type: 'p', children: [{ text: source }] })
    }
  )

  it.each(['- item', '+ item', '* item', '1. item', '1) item'])(
    'builds codec-compatible lists from %s and continues/exits them on Enter',
    (source) => {
      const editor = createEditor()
      type(editor, source)
      const ordered = source.startsWith('1')
      expect(editor.children[0]).toMatchObject({
        type: ordered ? 'ol' : 'ul',
        children: [{ type: 'li', children: [{ type: 'lic', children: [{ text: 'item' }] }] }]
      })
      type(editor, '\nnext\n\nParagraph')
      expectMarkdown(
        editor,
        ordered ? '1. item\n2. next\n\nParagraph' : '- item\n- next\n\nParagraph'
      )
    }
  )

  it.each(['- [ ]', '- [x]', '- [X]', '+ [ ]', '* [x]', '1. [ ]'])(
    'creates a task by typing %s, continues unchecked and exits on an empty Enter',
    (marker) => {
      const editor = createEditor()
      type(editor, `${marker} Task`)
      const checked = /\[[xX]\]/u.test(marker)
      const ordered = marker.startsWith('1')
      expect(editor.children[0]).toMatchObject({
        type: ordered ? 'ol' : 'ul',
        children: [
          { type: 'li', checked, children: [{ type: 'lic', children: [{ text: 'Task' }] }] }
        ]
      })
      type(editor, '\nNext\n\nParagraph')
      expectMarkdown(
        editor,
        ordered
          ? '1. [ ] Task\n2. [ ] Next\n\nParagraph\n'
          : `- [${checked ? 'x' : ' '}] Task\n- [ ] Next\n\nParagraph\n`
      )
    }
  )

  it.each(['[ ]', '[x]', '[X]'])(
    'leaves %s literal until the Markdown separator is typed',
    (marker) => {
      const editor = createEditor()
      type(editor, `- ${marker}`)
      expect(editor.children[0].children[0]).not.toHaveProperty('checked')
      expect(editor.api.string([0, 0, 0])).toBe(marker)
    }
  )

  it.each(['[ ]　', '[　] ', '[　]　'])(
    'accepts full-width spaces in the task marker or separator: %s',
    (marker) => {
      const editor = createEditor()
      type(editor, `- ${marker}Task`)
      expect(serializeMarkdownDocument(editor.children)).toBe('- [ ] Task\n')
    }
  )

  it('converts only the current list item with one undo step, keeping its subtree and caret', () => {
    const editor = createEditor('- Before\n- Target\n  - Child\n- After\n')
    editor.tf.select({ path: [0, 1, 0, 0], offset: 0 })
    type(editor, '[x]')
    const before = editor.children
    const selectionBefore = editor.selection
    type(editor, ' ')
    expectMarkdown(editor, '- Before\n- [x] Target\n  - Child\n- After\n')
    expect(editor.selection?.anchor).toEqual({ path: [0, 1, 0, 0], offset: 0 })
    const converted = editor.children
    editor.tf.undo()
    expect(editor.children).toEqual(before)
    expect(editor.selection).toEqual(selectionBefore)
    editor.tf.redo()
    expect(editor.children).toEqual(converted)
    type(editor, 'New ')
    expectMarkdown(editor, '- Before\n- [x] New Target\n  - Child\n- After\n')
  })

  it('recognizes task markers in nested list items', () => {
    const editor = createEditor('- Parent\n  - Child\n')
    editor.tf.select({ path: [0, 0, 1, 0, 0, 0], offset: 0 })
    type(editor, '[ ] ')
    expectMarkdown(editor, '- Parent\n  - [ ] Child\n')
  })

  it.each(['[] Task', '[y] Task', 'prefix [ ] Task', '\\[ ] Task'])(
    'keeps non-task markers literal within a list: %s',
    (content) => {
      const editor = createEditor()
      type(editor, `- ${content}`)
      expect(editor.api.node([0, 0])?.[0]).not.toHaveProperty('checked')
      expect(editor.api.string([0, 0, 0])).toBe(content)
    }
  )

  it('keeps markers literal in prose, code and a second list-item paragraph', () => {
    const prose = createEditor()
    type(prose, '[ ] Task')
    expect(prose.children[0]).toMatchObject({ type: 'p', children: [{ text: '[ ] Task' }] })
    const code = createEditor('```\n\n```\n')
    type(code, '- [x] Task')
    expect(code.api.string([0, 0])).toBe('- [x] Task')
    const item = createEditor('- First\n\n  Second\n')
    item.tf.select({ path: [0, 0, 1, 0], offset: 0 })
    type(item, '[x] ')
    expect(item.api.node([0, 0])?.[0]).not.toHaveProperty('checked')
    expect(item.api.string([0, 0, 1])).toBe('[x] Second')
  })

  it.each(['1.', '2.', '7)', '123.'])(
    'joins an adjacent ordered list when typing %s and keeps numbering, caret and undo',
    (marker) => {
      const editor = createEditor('3. First\n4. Second\n\nNext\n\nAfter\n')
      editor.tf.select({ path: [1, 0], offset: 0 })
      type(editor, marker)
      const before = editor.children
      const selectionBefore = editor.selection
      type(editor, ' ')
      expect(editor.children).toHaveLength(2)
      expect(editor.children[0]).toMatchObject({ type: 'ol', start: 3 })
      expect(editor.children[0].children).toHaveLength(3)
      expectMarkdown(editor, '3. First\n4. Second\n5. Next\n\nAfter\n')
      expect(editor.selection?.anchor).toEqual({ path: [0, 2, 0, 0], offset: 0 })
      const joined = editor.children
      editor.tf.undo()
      expect(editor.children).toEqual(before)
      expect(editor.selection).toEqual(selectionBefore)
      editor.tf.redo()
      expect(editor.children).toEqual(joined)
      type(editor, 'Typed ')
      expectMarkdown(editor, '3. First\n4. Second\n5. Typed Next\n\nAfter\n')
    }
  )

  it('rejoins the preceding list after exiting it with two Enter presses', () => {
    const editor = createEditor('1. First\n')
    type(editor, '\n\n2. Second')
    expect(editor.children).toHaveLength(1)
    expectMarkdown(editor, '1. First\n2. Second\n')
  })

  it.each(['0.', '3.', '42)'])(
    'preserves the starting number of a standalone %s list',
    (marker) => {
      const editor = createEditor()
      type(editor, `${marker} Item`)
      const start = Number.parseInt(marker, 10)
      expect(editor.children[0]).toMatchObject({ type: 'ol', start })
      expect(serializeMarkdownDocument(editor.children)).toBe(`${start}. Item\n`)
      expectMarkdown(editor, `${start}. Item\n`)
    }
  )

  it('does not join across intervening prose or merge an ordered item into an unordered list', () => {
    for (const source of ['1. First\n\nGap\n\nNext\n', '- First\n\nNext\n']) {
      const editor = createEditor(source)
      const path = [editor.children.length - 1, 0]
      editor.tf.select({ path, offset: 0 })
      const preceding = editor.children.slice(0, -1)
      type(editor, '2. ')
      expect(editor.children.slice(0, -1)).toEqual(preceding)
      expect(editor.children.at(-1)).toMatchObject({ type: 'ol', start: 2 })
    }
  })

  it('joins an ordered list within the same quote without changing outside blocks', () => {
    const editor = createEditor('Before\n\n> 3. First\n>\n> Next\n\nAfter\n')
    editor.tf.select({ path: [1, 1, 0], offset: 0 })
    type(editor, '4. ')
    expectMarkdown(editor, 'Before\n\n> 3. First\n> 4. Next\n\nAfter\n')
    expect(editor.children[1].children).toHaveLength(1)
  })

  it.each(['1234567890. text', '1.5 text', '-1. text', 'prefix 2. text'])(
    'does not interpret non-list syntax as an ordered list: %s',
    (source) => {
      const editor = createEditor()
      type(editor, source)
      expect(editor.children[0]).toMatchObject({ type: 'p', children: [{ text: source }] })
    }
  )

  it('wraps a quote in the same paragraph structure as the codec', () => {
    const editor = createEditor()
    type(editor, '> quoted')
    expect(editor.children[0]).toMatchObject({
      type: 'blockquote',
      children: [{ type: 'p', children: [{ text: 'quoted' }] }]
    })
    expectMarkdown(editor, '> quoted')
  })

  it.each(['```ts', '~~~ts'])('starts %s on Enter and leaves code contents literal', (fence) => {
    const editor = createEditor()
    type(editor, `${fence}\n# literal **text**\n${fence.slice(0, 3)}\nParagraph`)
    expect(editor.children[0]).toMatchObject({ type: 'code_block', lang: 'ts' })
    expectMarkdown(editor, '```ts\n# literal **text**\n```\n\nParagraph')
  })

  it.each(['---', '***', '___'])('renders a thematic break from %s on Enter', (source) => {
    const editor = createEditor()
    type(editor, `${source}\nParagraph`)
    expect(editor.children[0]).toMatchObject({ type: 'hr' })
    expect(editor.children[1]).toMatchObject({ type: 'p', children: [{ text: 'Paragraph' }] })
    expectMarkdown(editor, '---\n\nParagraph')
  })

  it('does not turn unsupported diagram fences into editable code blocks', () => {
    const editor = createEditor()
    type(editor, '```mermaid\n')
    expect(editor.children[0].type).toBe('p')
    expect(editor.api.string([0])).toBe('```mermaid')
  })
})
