import { describe, expect, it, vi } from 'vitest'
import type {
  PDFPageProxy,
  StructTreeNode,
  TextContent,
  TextItem
} from 'pdfjs-dist/types/src/display/api'
import { readPdfPageText } from './pdf-reading-order'

const item = (str: string, x: number, y: number, width = 210): TextItem => ({
  str,
  width,
  height: 10,
  dir: 'ltr',
  fontName: 'Body',
  transform: [10, 0, 0, 10, x, 800 - y],
  hasEOL: true
})
const read = (
  items: TextContent['items'],
  tree: StructTreeNode | null | Error = null
): Promise<string> =>
  readPdfPageText({
    rotate: 0,
    view: [0, 0, 600, 800],
    getTextContent: vi.fn(async () => ({
      items,
      styles: { Body: { ascent: 0.8, descent: -0.2, vertical: false, fontFamily: 'serif' } },
      lang: null
    })),
    getStructTree: vi.fn(async () => {
      if (tree instanceof Error) throw tree
      return tree
    })
  } as unknown as PDFPageProxy)

describe('automatic PDF reading order', () => {
  it('reads ragged columns below a full-width heading without changing source text', async () => {
    const rows = Array.from({ length: 4 }, (_, i) => [
      item(`Left ${i} body sentence.`, 40, 120 + i * 14),
      item(`Right ${i} body sentence.`, 330, 125 + i * 17)
    ])
    const input = [
      item('Heading', 40, 50, 500),
      ...rows.flat(),
      item('Closing paragraph', 40, 260, 500)
    ]
    expect(await read(input)).toBe(
      [
        'Heading',
        ...rows.map(([a]) => a.str),
        ...rows.map(([, b]) => b.str),
        'Closing paragraph'
      ].join('\n')
    )
  })
  it.each([false, true])(
    'preserves text-table row associations, including wrapped cells: %s',
    async (wrapped) => {
      const input = [
        item('Condition A', 40, 120),
        item('Outcome A is a long sentence', 330, 120),
        ...(wrapped ? [item('and continues on the next line.', 330, 134)] : []),
        item('Condition B', 40, 148),
        item('Outcome B', 330, 148)
      ]
      expect(await read(input)).toBe(input.map((i) => i.str).join('\n'))
    }
  )

  it('uses complete PDF tags, and preserves native text when tags are incomplete', async () => {
    const input: TextContent['items'] = [
      { type: 'beginMarkedContentProps', id: 'right' },
      item('Right column', 330, 120),
      { type: 'endMarkedContent', id: '' },
      { type: 'beginMarkedContentProps', id: 'left' },
      item('Left column', 40, 120),
      { type: 'endMarkedContent', id: '' }
    ]
    const tree = {
      role: 'Document',
      children: [
        { type: 'content', id: 'left' },
        { type: 'content', id: 'right' }
      ]
    }
    const outsideBreak: TextContent['items'] = [
      { type: 'beginMarkedContentProps', id: 'left' },
      { ...item('first', 40, 120), hasEOL: false },
      { type: 'endMarkedContent', id: '' },
      { ...item('', 40, 134), width: 0, height: 0, hasEOL: true },
      { type: 'beginMarkedContentProps', id: 'right' },
      { ...item('second', 40, 134), hasEOL: false },
      { type: 'endMarkedContent', id: '' }
    ]
    expect(await read(outsideBreak, tree)).toBe('first\nsecond')
    expect(await read(input, tree)).toBe('Left column\nRight column')
    expect(await read(input.slice(0, -1), tree)).toBe('Right column\nLeft column')
    expect(await read([{ type: 'endMarkedContent', id: '' }, ...input], tree)).toBe(
      'Right column\nLeft column'
    )
    expect(await read(input, { ...tree, children: tree.children.slice(0, 1) })).toBe(
      'Right column\nLeft column'
    )
    expect(await read(input, { ...tree, children: [tree.children[0], tree.children[0]] })).toBe(
      'Right column\nLeft column'
    )
  })
  it('preserves readable native text when structure is damaged or excessively nested', async () => {
    const input: TextContent['items'] = [
      { type: 'beginMarkedContentProps', id: 'right' },
      item('Right', 330, 120),
      { type: 'endMarkedContent', id: '' },
      { type: 'beginMarkedContentProps', id: 'left' },
      item('Left', 40, 120),
      { type: 'endMarkedContent', id: '' }
    ]
    let tree: StructTreeNode = {
      role: 'Document',
      children: [
        { type: 'content', id: 'left' },
        { type: 'content', id: 'right' }
      ]
    }
    for (let i = 0; i < 150; i++) tree = { role: 'Div', children: [tree] }
    expect(await read(input, new Error('Invalid structure tree'))).toBe('Right\nLeft')
    expect(await read(input, tree)).toBe('Right\nLeft')
  })
})
