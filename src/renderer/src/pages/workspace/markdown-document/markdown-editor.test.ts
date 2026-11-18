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
