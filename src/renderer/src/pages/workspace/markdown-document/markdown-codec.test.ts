import { describe, expect, it } from 'vitest'

import {
  markdownSelectionAnchor,
  markdownSourceWithFormat,
  parseMarkdownDocument,
  serializeMarkdownDocument
} from './markdown-codec'

describe('markdown document codec', () => {
  it('parses and serializes supported Markdown through Plate', () => {
    const parsed = parseMarkdownDocument('# Hello\n\n**world**\n')

    expect(parsed.mode).toBe('rich')
    expect(parsed.diagnostics).toEqual([])
    expect(serializeMarkdownDocument(parsed.value)).toBe('# Hello\n\n**world**\n')
  })

  it.each([
    ['front matter', '---\ntitle: Example\n---\n\n# Body'],
    ['raw HTML', '# Body\n\n<span>unsafe</span>'],
    ['Mermaid', '```mermaid\ngraph TD\n```'],
    ['directives', '::: warning\nKeep this block\n:::']
  ])('keeps %s in source mode', (_name, source) => {
    const parsed = parseMarkdownDocument(source)

    expect(parsed.mode).toBe('source')
    expect(parsed.value).toEqual([])
    expect(parsed.diagnostics).toHaveLength(1)
  })

  it('anchors a unique selection using source context and rejects ambiguous text', () => {
    const source = 'First result.\nSecond result.\n'

    expect(markdownSelectionAnchor(source, 'result.', 'First ')).toEqual({
      start: 6,
      end: 13,
      prefix: 'First '
    })
    expect(markdownSelectionAnchor('same same', 'same')).toBeUndefined()
  })

  it('preserves source newline, trailing-newline, and BOM formatting', () => {
    expect(
      markdownSourceWithFormat('one\ntwo\n', {
        newline: 'crlf',
        hasTrailingNewline: true,
        hasUtf8Bom: true
      })
    ).toBe('﻿one\r\ntwo\r\n')
    expect(
      markdownSourceWithFormat('﻿one\r\ntwo\r\n\r\n', {
        newline: 'lf',
        hasTrailingNewline: false,
        hasUtf8Bom: false
      })
    ).toBe('one\ntwo')
  })
})
