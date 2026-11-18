import { NodeApi } from 'platejs'
import { describe, expect, it } from 'vitest'
import { createMarkdownEditor } from './markdown-editor'
import { parseMarkdownDocument, serializeMarkdownDocument } from './markdown-codec'
import {
  createMarkdownBlock,
  decodeDropdownDefinition,
  deleteMarkdownBlock,
  duplicateMarkdownBlock,
  encodeDropdownDefinition,
  insertMarkdownBlock,
  moveMarkdownBlockTo,
  turnMarkdownBlockInto
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
    const insertedPath = insertMarkdownBlock(editor, [0], 'h2')
    expect(editor.children[insertedPath[0]]).toMatchObject({ placeholderKind: 'h2' })
    expect(editor.children).toHaveLength(3)
    expect(serializeMarkdownDocument(editor.children)).toBe('Before\n\n##\n\nAfter\n')
    editor.tf.insertText('Inserted')
    expect(serializeMarkdownDocument(editor.children)).toBe('Before\n\n## Inserted\n\nAfter\n')
  })

  it('supports block menu actions without losing surrounding blocks', () => {
    const editor = createMarkdownEditor(parseMarkdownDocument('First\n\nSecond\n').value)
    expect(duplicateMarkdownBlock(editor, [0])).toEqual([1])
    expect(serializeMarkdownDocument(editor.children)).toBe('First\n\nFirst\n\nSecond\n')
    expect(turnMarkdownBlockInto(editor, [1], 'h2')).toBe(true)
    expect(serializeMarkdownDocument(editor.children)).toBe('First\n\n## First\n\nSecond\n')
    expect(deleteMarkdownBlock(editor, [1])).toBe(true)
    expect(serializeMarkdownDocument(editor.children)).toBe('First\n\nSecond\n')
  })

  it('keeps text when turning a block into list and checklist forms', () => {
    const editor = createMarkdownEditor(parseMarkdownDocument('Keep this text\n').value)
    expect(turnMarkdownBlockInto(editor, [0], 'bullet')).toBe(true)
    expect(serializeMarkdownDocument(editor.children)).toBe('- Keep this text\n')
    expect(turnMarkdownBlockInto(editor, [0], 'checklist')).toBe(true)
    expect(serializeMarkdownDocument(editor.children)).toBe('- [ ] Keep this text\n')
  })

  it('keeps dropdown blocks valid when converting empty or non-empty text', () => {
    const emptyEditor = createMarkdownEditor([{ type: 'p', children: [{ text: '' }] }])
    expect(turnMarkdownBlockInto(emptyEditor, [0], 'dropdown')).toBe(true)
    expect(decodeDropdownDefinition(NodeApi.string(emptyEditor.children[0]))).toEqual({
      options: ['1', '2'],
      selected: '1'
    })

    const editor = createMarkdownEditor(parseMarkdownDocument('Choice\n').value)
    expect(turnMarkdownBlockInto(editor, [0], 'dropdown')).toBe(true)
    expect(decodeDropdownDefinition(NodeApi.string(editor.children[0]))).toEqual({
      options: ['Choice'],
      selected: 'Choice'
    })
  })

  it('removes an inserted block without leaving a placeholder block behind', () => {
    const editor = createMarkdownEditor(parseMarkdownDocument('Before\n').value)
    const insertedPath = insertMarkdownBlock(editor, [0], 'h2')
    expect(deleteMarkdownBlock(editor, insertedPath)).toBe(true)
    expect(editor.children).toHaveLength(1)
    expect(serializeMarkdownDocument(editor.children)).toBe('Before\n')
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
