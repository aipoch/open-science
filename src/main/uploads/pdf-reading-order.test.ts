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
  tree: StructTreeNode | null | Error = null,
  onUncertain?: Parameters<typeof readPdfPageText>[1],
  rotation = 0,
  includeLayout = false,
  pageOverrides: Partial<PDFPageProxy> = {}
): Promise<string> =>
  readPdfPageText(
    {
      pageNumber: 1,
      rotate: rotation,
      view: [0, 0, 600, 800],
      getTextContent: vi.fn(async () => ({
        items,
        styles: { Body: { ascent: 0.8, descent: -0.2, vertical: false, fontFamily: 'serif' } },
        lang: null
      })),
      getStructTree: vi.fn(async () => {
        if (tree instanceof Error) throw tree
        return tree
      }),
      ...pageOverrides
    } as unknown as PDFPageProxy,
    onUncertain,
    includeLayout
  )

describe('automatic PDF reading order', () => {
  it.each([false, true])(
    'orders a proven single lane independently of source EOL=%s',
    async (hasEOL) => {
      const rows = Array.from({ length: 4 }, (_, i) => ({
        ...item(`Paragraph ${i}.`, 40, 120 + i * 30, 500),
        hasEOL
      }))
      const warning = vi.fn()
      expect(await read([...rows].reverse(), null, warning)).toBe(
        rows.map((row) => row.str).join('\n')
      )
      expect(warning).not.toHaveBeenCalled()
    }
  )

  it('orders aligned multi-line prose by column', async () => {
    const rows = Array.from({ length: 4 }, (_, i) => [
      item(`Left column paragraph sentence ${i} continues with prose.`, 40, 120 + i * 16),
      item(`Right column paragraph sentence ${i} continues with prose.`, 330, 120 + i * 16)
    ]).flat()
    const warning = vi.fn()
    expect(await read(rows, null, warning)).toBe(
      [
        ...rows.filter((row) => row.transform[4] === 40),
        ...rows.filter((row) => row.transform[4] === 330)
      ]
        .map((row) => row.str)
        .join('\n')
    )
    expect(warning).not.toHaveBeenCalled()
  })

  it('retains native order and warns for short aligned cells', async () => {
    const rows = Array.from({ length: 4 }, (_, i) => [
      item(`table left ${i}.`, 40, 120 + i * 16),
      item(`table right ${i}.`, 330, 120 + i * 16)
    ]).flat()
    const warning = vi.fn()
    expect(await read(rows, null, warning)).toBe(rows.map((row) => row.str).join('\n'))
    expect(warning).toHaveBeenCalledExactlyOnceWith(1)
  })

  it.each([
    ['before', ' ', false],
    ['after', ' ', false],
    ['before', '\u00a0', false],
    ['after', '\u00a0', false],
    ['before', ' ', true],
    ['after', ' ', true],
    ['before', '\u00a0', true],
    ['after', '\u00a0', true]
  ])(
    'preserves a positioned word separator drawn %s its text: %j, EOL=%s',
    async (pass, separator, hasEOL) => {
      const words = [item('alpha', 40, 120, 25), item('beta', 66, 120, 20)].map((part) => ({
        ...part,
        hasEOL
      }))
      const space = { ...item(separator, 65, 120, 1), height: 0, hasEOL }
      const warning = vi.fn()
      expect(
        await read(pass === 'before' ? [space, ...words] : [...words, space], null, warning)
      ).toBe(`alpha${separator}beta`)
      expect(warning).not.toHaveBeenCalled()
    }
  )

  it.each([false, true])(
    'distinguishes source-flow whitespace from a word separator: %s',
    async (narrow) => {
      const prefix = { ...item('Hel', 40, 120, 15), hasEOL: false }
      const suffix = { ...item('lo', narrow ? 56 : 55, 120, 8), hasEOL: false }
      const right = { ...item('Right', 330, 120, 43), hasEOL: false }
      const gutter = { ...item(' ', 55, 120, 275), height: 0, hasEOL: false }
      const space = { ...item(' ', 55, 120, 1), height: 0, hasEOL: false }
      const warning = vi.fn()
      expect(
        await read([...(narrow ? [space] : []), prefix, gutter, right, suffix], null, warning)
      ).toBe(narrow ? 'Hel lo\nRight' : 'Hello\nRight')
      expect(warning).not.toHaveBeenCalled()
    }
  )

  it('binds positioned separators to their own baseline and word gap', async () => {
    const words = [
      item('alpha', 40, 120, 25),
      item('beta', 66, 120, 20),
      item('omega', 87, 120, 25),
      item('gamma', 40, 140, 25),
      item('delta', 66, 140, 20)
    ]
    const spaces = [item('\u00a0', 65, 140, 1), item(' ', 86, 120, 1), item('\u00a0', 65, 120, 1)]
    const warning = vi.fn()
    expect(
      await read(
        [...spaces, ...words].map((part) => ({ ...part, hasEOL: false })),
        null,
        warning
      )
    ).toBe('alpha\u00a0beta omega\ngamma\u00a0delta')
    expect(warning).not.toHaveBeenCalled()
  })

  it('retains an unpositioned separator with unchanged source neighbors', async () => {
    const input = [
      { ...item('alpha', 40, 120, 25), hasEOL: false },
      { str: ' ', hasEOL: false } as TextItem,
      { ...item('beta', 66, 120, 20), hasEOL: false }
    ]
    const warning = vi.fn()
    expect(await read(input, null, warning)).toBe('alpha beta')
    expect(warning).not.toHaveBeenCalled()
  })

  it('retains zero-width separators with usable positions', async () => {
    const input = [
      item('alpha', 40, 120, 25),
      item('beta', 65, 120, 20),
      { ...item(' ', 65, 120, 0), height: 0, transform: [0, 0, 0, 0, 65, 680] }
    ].map((part) => ({ ...part, hasEOL: false }))
    const warning = vi.fn()
    expect(await read(input, null, warning)).toBe('alpha beta')
    expect(warning).not.toHaveBeenCalled()
  })

  it('orders explicit separators by physical position', async () => {
    const input = [
      item('alpha', 40, 120, 25),
      item('beta', 67, 120, 20),
      item(' ', 66, 120, 1),
      item('\u00a0', 65, 120, 1)
    ].map((part) => ({ ...part, hasEOL: false }))
    const warning = vi.fn()
    expect(await read(input, null, warning)).toBe('alpha\u00a0 beta')
    expect(warning).not.toHaveBeenCalled()
  })

  it('warns and retains native text when a separator overlaps glyphs', async () => {
    const input = [
      item('alpha', 40, 120, 25),
      item('beta', 66, 120, 20),
      item(' ', 65, 120, 265)
    ].map((part) => ({ ...part, hasEOL: false }))
    const warning = vi.fn()
    expect(await read(input, null, warning)).toBe('alphabeta')
    expect(warning).toHaveBeenCalledExactlyOnceWith(1)
  })

  it.each([-1, 0, 0.5, 1])(
    'preserves fragmented words with %s points of kerning or tracking',
    async (spacing) => {
      const words = ['AVATAR', 'NEXT']
      const input = words.flatMap((word, row) =>
        [...word].map((str, i) => ({
          ...item(str, 40 + i * (8 + spacing), 120 + row * 20, 8),
          hasEOL: false
        }))
      )
      const warning = vi.fn()
      expect(await read(input, null, warning)).toBe(words.join('\n'))
      expect(warning).not.toHaveBeenCalled()
    }
  )

  it('reports unsupported orientation but does not warn on an empty page', async () => {
    const warning = vi.fn()
    expect(await read([item('Native text.', 40, 120)], null, warning, 90)).toBe('Native text.')
    expect(warning).toHaveBeenCalledExactlyOnceWith(1)
    warning.mockClear()
    expect(await read([], null, warning)).toBe('')
    expect(warning).not.toHaveBeenCalled()
  })

  it.each([
    [0, 0],
    [120, -80]
  ])(
    'preserves independent source text and top-left geometry for ambiguous pages; offset %s,%s',
    async (dx, dy) => {
      const input = [
        item('Left first original.', 40, 120),
        item('Right first original.', 330, 120),
        item('Left second original.', 40, 140),
        item('Right second original.', 330, 140)
      ].map((part) => ({
        ...part,
        transform: [...part.transform.slice(0, 4), part.transform[4] + dx, part.transform[5] + dy]
      }))
      const original = JSON.stringify(input),
        warning = vi.fn()
      const text = await read(input, null, warning, 0, true, { view: [dx, dy, 600 + dx, 800 + dy] })
      expect(text).toBe(input.map((part) => part.str).join('\n'))
      expect(warning).toHaveBeenCalledExactlyOnceWith(1, {
        page: 1,
        width: 600,
        height: 800,
        coordinateSystem: 'top-left',
        blocks: [
          { id: 0, text: input[0].str, bounds: [40, 110, 250, 120] },
          { id: 1, text: input[1].str, bounds: [330, 110, 540, 120] },
          { id: 2, text: input[2].str, bounds: [40, 130, 250, 140] },
          { id: 3, text: input[3].str, bounds: [330, 130, 540, 140] }
        ]
      })
      expect(JSON.stringify(input)).toBe(original)
    }
  )

  it.each(['rtl', 'skewed', 'non-finite'])(
    'does not fabricate positioned evidence for unsupported %s text',
    async (kind) => {
      const input = [
        item('Left one.', 40, 120),
        item('Right one.', 330, 120),
        item('Left two.', 40, 140),
        item('Right two.', 330, 140)
      ]
      if (kind === 'rtl') input[0] = { ...input[0], dir: 'rtl' }
      else
        input[0] = {
          ...input[0],
          transform: kind === 'skewed' ? [10, 1, 0, 10, 40, 680] : [10, 0, 0, 10, NaN, 680]
        }
      const warning = vi.fn()
      expect(await read(input, null, warning, 0, true)).toBe(
        input.map((part) => part.str).join('\n')
      )
      expect(warning).toHaveBeenCalledExactlyOnceWith(1, undefined)
    }
  )

  it('retains explicit zero-height whitespace in positioned source evidence', async () => {
    const input = [
      { ...item(' ', 250, 120, 80), height: 0 },
      item('Left one.', 40, 120),
      item('Right one.', 330, 120),
      item('Left two.', 40, 140),
      item('Right two.', 330, 140)
    ]
    const warning = vi.fn<NonNullable<Parameters<typeof readPdfPageText>[1]>>()
    await read(input, null, warning, 0, true)
    expect(warning).toHaveBeenCalledOnce()
    const layout = warning.mock.calls[0][1]!
    expect(layout.blocks.map((block) => block.text)).toEqual(input.map((part) => part.str))
    expect(layout.blocks[0].bounds).toEqual([250, 120, 330, 120])
  })

  it.each([false, true])(
    'does not expose incomplete or unsupported geometry; oversized: %s',
    async (oversized) => {
      const input = [
        item(oversized ? 'x'.repeat(17000) : 'Left one.', 40, 120),
        item('Right one.', 330, 120),
        item('Left two.', 40, 140),
        item('Right two.', 330, 140)
      ]
      const warning = vi.fn()
      expect(await read(input, null, warning, oversized ? 0 : 90, true)).toBe(
        input.map((part) => part.str).join('\n')
      )
      expect(warning).toHaveBeenCalledExactlyOnceWith(1, undefined)
    }
  )

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

  it('keeps independently wrapped table cells attached to their row anchors', async () => {
    const input = [
      item('Condition A', 40, 120),
      item('Outcome A', 330, 120),
      item('wrapped left cell', 40, 134),
      item('wrapped right cell', 330, 137),
      item('Condition B', 40, 170),
      item('Outcome B', 330, 170),
      item('wrapped left B', 40, 184),
      item('wrapped right B', 330, 187)
    ]
    expect(await read(input)).toBe(input.map((i) => i.str).join('\n'))
  })

  it('preserves tall text-table cells whose first row anchors align despite different wrapping cadence', async () => {
    const input = Array.from({ length: 24 }, (_, row) => [
      item(`Condition description line ${row}.`, 40, 120 + row * 16),
      item(`Outcome description line ${row}.`, 330, 120 + row * 17)
    ]).flat()
    expect(await read(input)).toBe(input.map((i) => i.str).join('\n'))
  })

  it('does not detach aligned tall table cells when one column has a preceding heading', async () => {
    const input = [
      item('Condition definition', 40, 104),
      ...Array.from({ length: 24 }, (_, row) => [
        item(`Condition description line ${row}.`, 40, 120 + row * 16),
        item(`Outcome description line ${row}.`, 330, 120 + row * 17)
      ]).flat()
    ]
    expect(await read(input)).toBe(input.map((i) => i.str).join('\n'))
  })

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
