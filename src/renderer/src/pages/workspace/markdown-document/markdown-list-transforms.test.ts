import { describe, expect, it } from 'vitest'
import type { PlateEditor } from 'platejs/react'
import { createMarkdownEditor } from './markdown-editor'
import { parseMarkdownDocument, serializeMarkdownDocument } from './markdown-codec'
import { getMarkdownListItemAtCaret, indentMarkdownListItem } from './markdown-list-transforms'

const createEditor = (source: string): PlateEditor =>
  createMarkdownEditor(parseMarkdownDocument(source).value)
const markdown = (source: string): string =>
  serializeMarkdownDocument(parseMarkdownDocument(source).value)

describe('Markdown list indentation', () => {
  it.each([
    '- First\n- Second\n- Third\n',
    '1. First\n2. Second\n3. Third\n',
    '- [x] First\n- [ ] Second\n- Third\n'
  ])('indents and outdents one item with a stable caret and undo: %s', (source) => {
    const editor = createEditor(source)
    editor.tf.select({ path: [0, 1, 0, 0], offset: 3 })
    const original = editor.children
    expect(getMarkdownListItemAtCaret(editor)).toEqual([0, 1])
    expect(indentMarkdownListItem(editor, [0, 1])).toBe(true)
    expect(editor.selection?.anchor).toEqual({ path: [0, 0, 1, 0, 0, 0], offset: 3 })
    expect(editor.api.string([0, 0, 1, 0])).toBe('Second')
    const indented = editor.children
    editor.tf.undo()
    expect(editor.children).toEqual(original)
    editor.tf.redo()
    expect(editor.children).toEqual(indented)
    expect(indentMarkdownListItem(editor, [0, 0, 1, 0], true)).toBe(true)
    expect(serializeMarkdownDocument(editor.children)).toBe(markdown(source))
    expect(editor.selection?.anchor).toEqual({ path: [0, 1, 0, 0], offset: 3 })
    editor.tf.insertText('!')
    expect(editor.api.string([0, 1])).toBe('Sec!ond')
  })

  it('reuses a preceding nested list and moves the entire subtree', () => {
    const editor = createEditor('- First\n  - Existing\n- Second\n  - Child\n- Third\n')
    indentMarkdownListItem(editor, [0, 1])
    expect(serializeMarkdownDocument(editor.children)).toBe(
      markdown('- First\n  - Existing\n  - Second\n    - Child\n- Third\n')
    )
  })

  it('outdents a middle nested item without reordering its following siblings', () => {
    const editor = createEditor('- Parent\n  - Before\n  - Lift\n    - Child\n  - After\n- Last\n')
    indentMarkdownListItem(editor, [0, 0, 1, 1], true)
    expect(serializeMarkdownDocument(editor.children)).toBe(
      markdown('- Parent\n  - Before\n- Lift\n  - Child\n  - After\n- Last\n')
    )
    const saved = serializeMarkdownDocument(editor.children)
    expect(serializeMarkdownDocument(parseMarkdownDocument(saved).value)).toBe(saved)
  })

  it('outdents an outer item into prose without losing adjacent items or children', () => {
    const editor = createEditor('- Before\n- Lift\n  - Child\n- After\n')
    editor.tf.select({ path: [0, 1, 0, 0], offset: 2 })
    const original = editor.children
    indentMarkdownListItem(editor, [0, 1], true)
    expect(serializeMarkdownDocument(editor.children)).toBe(
      markdown('- Before\n\nLift\n\n- Child\n\n* After\n')
    )
    editor.tf.insertText('!')
    expect(editor.api.string([1])).toBe('Li!ft')
    editor.tf.undo()
    editor.tf.undo()
    expect(editor.children).toEqual(original)
  })

  it('does not indent the first item or intercept prose, code or expanded selections', () => {
    const editor = createEditor('- First\n\nParagraph\n\n```\ncode\n```\n')
    const original = editor.children
    expect(indentMarkdownListItem(editor, [0, 0])).toBe(false)
    expect(editor.children).toBe(original)
    editor.tf.select({ path: [1, 0], offset: 0 })
    expect(getMarkdownListItemAtCaret(editor)).toBeUndefined()
    editor.tf.select({ path: [2, 0, 0], offset: 0 })
    expect(getMarkdownListItemAtCaret(editor)).toBeUndefined()
    editor.tf.select({
      anchor: { path: [0, 0, 0, 0], offset: 0 },
      focus: { path: [0, 0, 0, 0], offset: 3 }
    })
    expect(getMarkdownListItemAtCaret(editor)).toBeUndefined()
  })
})
