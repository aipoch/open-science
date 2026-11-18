import { describe, expect, it } from 'vitest'
import { createMarkdownEditor } from './markdown-editor'
import { parseMarkdownDocument, serializeMarkdownDocument } from './markdown-codec'
import {
  createMarkdownBlock,
  decodeDropdownDefinition,
  encodeDropdownDefinition,
  insertMarkdownBlock,
  moveMarkdownBlockTo
} from './markdown-blocks'

describe('Markdown block editing', () => {
  it('moves blocks in both directions and restores the full order on undo', () => {
    const editor = createMarkdownEditor(parseMarkdownDocument('First\n\nSecond\n\nThird\n').value)
    expect(moveMarkdownBlockTo(editor, [0], 1)).toBe(true)
    expect(serializeMarkdownDocument(editor.children)).toBe('Second\n\nFirst\n\nThird\n')
    editor.tf.undo()
    expect(serializeMarkdownDocument(editor.children)).toBe('First\n\nSecond\n\nThird\n')
    expect(moveMarkdownBlockTo(editor, [2], 0)).toBe(true)
    expect(serializeMarkdownDocument(editor.children)).toBe('Third\n\nFirst\n\nSecond\n')
    expect(moveMarkdownBlockTo(editor, [-1], 0)).toBe(false)
    expect(moveMarkdownBlockTo(editor, [0, 0], 1)).toBe(false)
  })

  it('inserts a heading after its selected block without changing surrounding text', () => {
    const editor = createMarkdownEditor(parseMarkdownDocument('Before\n\nAfter\n').value)
    insertMarkdownBlock(editor, [0], 'h2')
    editor.tf.insertText('Inserted')
    expect(serializeMarkdownDocument(editor.children)).toBe('Before\n\n## Inserted\n\nAfter\n')
  })

  it('preserves nested mixed checked, unchecked and ordinary list items', () => {
    const source = '- [x] Done\n  - [ ] Child\n- Plain\n- [ ] Next\n'
    const parsed = parseMarkdownDocument(source)
    expect(parsed.mode).toBe('rich')
    const saved = serializeMarkdownDocument(parsed.value)
    expect(saved).toContain('- [x] Done')
    expect(saved).toContain('- [ ] Child')
    expect(saved).toContain('- Plain')
    expect(parseMarkdownDocument(saved).value).toEqual(parsed.value)
  })

  it('round trips every inserted block with content and keeps dropdown labels intact', () => {
    const definition = { options: ['One', '<tag> "two" \\ path'], selected: '<tag> "two" \\ path' }
    expect(decodeDropdownDefinition(encodeDropdownDefinition(definition))).toEqual(definition)
    for (const kind of [
      'h1',
      'h2',
      'h3',
      'bullet',
      'numbered',
      'checklist',
      'table',
      'image',
      'code',
      'quote',
      'divider',
      'date',
      'dropdown'
    ] as const) {
      const node = createMarkdownBlock(kind, {
        imageUrl: 'https://example.org/image.png',
        imageAlt: 'Diagram',
        code: 'const x = 1',
        date: '2026-11-17'
      })
      const source = serializeMarkdownDocument([node])
      const parsed = parseMarkdownDocument(source)
      expect(parsed.mode, kind).toBe('rich')
      expect(serializeMarkdownDocument(parsed.value), kind).toBe(source)
    }
    expect(decodeDropdownDefinition('{"options":[],"selected":"x"}')).toBeUndefined()
  })
})
