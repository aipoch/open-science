import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type {
  PDFPageProxy,
  StructTreeNode,
  TextContent,
  TextItem
} from 'pdfjs-dist/types/src/display/api'
import { readPdfPageText } from './pdf-reading-order'
import { joinPdfTextItems } from '../../shared/pdf-text'
import scaledInlineNative from './fixtures/scaled-inline-native.json'
import scaledGapJoinedToken from './fixtures/scaled-gap-joined-token.json'
import scaledGapRunningHead from './fixtures/scaled-gap-running-head.json'
import nativeInlineReferenceTitle from './fixtures/native-inline-reference-title.json'
import nativeInlineReferenceLink from './fixtures/native-inline-reference-link.json'

// Small anonymous native PDFs retain real PDF.js whitespace and font/EOL
// boundaries; the original external articles are not regression fixtures.
const inlineFlowPdf = (
  prefix: boolean | string = false,
  horizontalScale = 100,
  codeComments = false,
  runInParagraph = false
): Uint8Array => {
  const text = (s: string, x: number, y: number, font = 'F'): string =>
    `BT /${font} 10 Tf ${horizontalScale === 100 ? '' : `${horizontalScale} Tz `}${x} ${800 - y} Td (${s}) Tj ET`
  const stream = (
    codeComments
      ? [
          'const int first = source.read(index);',
          'const int next = combine(first, offset);',
          'const int result = combine(next, limit);'
        ].flatMap((statement, n) => [
          text(statement.replaceAll('(', '\\(').replaceAll(')', '\\)'), 40, 100 + n * 14),
          text('// A generic note belongs to this statement.', 330, 100 + n * 14)
        ])
      : runInParagraph
        ? [
            text('Summary.', 40, 100, 'B'),
            text('An opening sentence introduces the generic example.', 104, 100, 'T'),
            text(
              'The next line continues the same original paragraph without a new column.',
              40,
              114,
              'T'
            ),
            text('The final line closes that paragraph before unrelated material.', 40, 128, 'T'),
            ...Array.from({ length: 3 }, (_, n) =>
              text('Generic left prose preserves an independent sequence.', 40, 210 + n * 14, 'T')
            ),
            ...Array.from({ length: 3 }, (_, n) =>
              text('Generic right prose preserves an independent sequence.', 330, 210 + n * 14, 'T')
            )
          ]
        : [
            ...Array.from({ length: typeof prefix === 'string' ? 3 : 4 }, (_, n) =>
              text('A generic left paragraph carries prose.', 40, 100 + n * 14)
            ),
            ...(prefix
              ? [
                  text(
                    typeof prefix === 'string' ? prefix : '[7]',
                    330,
                    100,
                    typeof prefix === 'string' ? 'B' : 'F'
                  ),
                  text(
                    typeof prefix === 'string'
                      ? 'First words.'
                      : 'A generic paragraph carries prose.',
                    typeof prefix === 'string' ? 400 : 354,
                    100,
                    typeof prefix === 'string' ? 'T' : 'I'
                  )
                ]
              : [text('A generic paragraph carries prose.', 330, 100), text('To', 546, 100)]),
            ...Array.from({ length: typeof prefix === 'string' ? 2 : 3 }, (_, n) =>
              text(
                'A generic paragraph carries prose.',
                330,
                114 + n * 14,
                typeof prefix === 'string' ? 'T' : 'I'
              )
            )
          ]
  ).join('\n')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Contents 4 0 R /Resources << /Font << /F 5 0 R /I 6 0 R /B 7 0 R /T 8 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Oblique >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Bold >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >>'
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = objects.map((object, n) => {
    const offset = pdf.length
    pdf += `${n + 1} 0 obj\n${object}\nendobj\n`
    return offset
  })
  const xref = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new Uint8Array(Buffer.from(pdf))
}

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
  pageOverrides: Partial<PDFPageProxy> = {},
  styles: TextContent['styles'] = {
    Body: { ascent: 0.8, descent: -0.2, vertical: false, fontFamily: 'serif' }
  }
): Promise<string> =>
  readPdfPageText(
    {
      pageNumber: 1,
      rotate: rotation,
      view: [0, 0, 600, 800],
      getTextContent: vi.fn(async () => ({
        items,
        styles,
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

const nativeGridParagraphs = (): TextItem[] => {
  const columns = [40, 76, 124, 184, 232],
    widths = [30, 42, 54, 42, 48],
    words = ['Every', 'generic', 'paragraph', 'retains', 'meaning.']
  return Array.from({ length: 3 }, (_, row) => [
    ...words.flatMap((word, n) => [
      { ...item(word, columns[n], 112 + row * 14, widths[n]), hasEOL: n === 4 },
      ...(n === 4
        ? []
        : [
            {
              ...item(
                ' ',
                columns[n] + widths[n],
                112 + row * 14,
                columns[n + 1] - columns[n] - widths[n]
              ),
              height: 0,
              hasEOL: false
            }
          ])
    ]),
    item(`Right paragraph keeps independent prose words ${row}.`, 330, 118 + row * 14, 228)
  ]).flat()
}

describe('automatic PDF reading order', () => {
  it.each([
    ['title', nativeInlineReferenceTitle],
    ['venue', nativeInlineReferenceLink]
  ])('keeps inline reference %s text ahead of the next source line', async (_, fixture) => {
    const items = fixture.items as TextItem[],
      before = JSON.stringify(fixture),
      warning = vi.fn(),
      text = await read(items, null, warning, 0, false, fixture.page, fixture.styles),
      normalized = text.replace(/\s+/gu, ' ')

    expect(normalized).toContain(fixture.expectedBefore)
    expect(normalized).toContain(fixture.expectedAfter)
    expect(normalized.indexOf(fixture.expectedBefore)).toBeLessThan(
      normalized.indexOf(fixture.expectedAfter)
    )
    expect(warning).toHaveBeenCalledWith(1)
    expect(JSON.stringify(fixture)).toBe(before)
  })

  it.each([
    ['joined text', scaledGapJoinedToken],
    ['running header', scaledGapRunningHead]
  ])('keeps the original native fallback for a scaled gap beside %s', async (_, fixture) => {
    const items = fixture.items as TextItem[],
      warning = vi.fn(),
      text = await read(items, null, warning, 0, false, fixture.page, fixture.styles)
    expect(text).toBe(fixture.expectedText)
    expect(text).toBe(joinPdfTextItems(items))
    expect(warning).toHaveBeenCalledExactlyOnceWith(1)
  })

  it('keeps a scaled run-in first line ahead of its own continuation', async () => {
    // This anonymous TextItem contract is deletion-minimal. The independent
    // later fragments matter: the four paragraph items alone do not reproduce it.
    const items = scaledInlineNative.items as TextItem[],
      warning = vi.fn(),
      text = await read(
        items,
        null,
        warning,
        0,
        false,
        { view: scaledInlineNative.view },
        scaledInlineNative.styles
      )
    expect(text).toBe(joinPdfTextItems(items))
    expect(text.indexOf(items[4].str)).toBeLessThan(text.indexOf(items[5].str))
    expect(warning).toHaveBeenCalledExactlyOnceWith(1)
  })

  it.each([
    ['scaled native inline prose', () => inlineFlowPdf(false, 102, false, true), false],
    ['native code-row comment', () => inlineFlowPdf(false, 100, true), true]
  ] as const)('retains a %s with its original line', async (_name, bytes, uncertain) => {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const assets = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))
    const document = await getDocument({
      data: bytes(),
      useSystemFonts: false,
      isEvalSupported: false,
      verbosity: 0,
      standardFontDataUrl: join(assets, 'standard_fonts') + '/'
    }).promise
    try {
      const page = await document.getPage(1),
        content = await page.getTextContent({ includeMarkedContent: true }),
        warning = vi.fn(),
        native = joinPdfTextItems(content.items.filter((i): i is TextItem => 'str' in i))
      expect(await page.getStructTree()).toBeNull()
      expect(await readPdfPageText(page, warning)).toBe(native)
      if (uncertain) expect(warning).toHaveBeenCalledExactlyOnceWith(1)
      else expect(warning).not.toHaveBeenCalled()
    } finally {
      await document.destroy()
    }
  })

  it('retains a native inline first line ahead of its lower paragraph continuation', async () => {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const assets = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))
    const document = await getDocument({
      data: inlineFlowPdf('Generic label.'),
      useSystemFonts: false,
      isEvalSupported: false,
      verbosity: 0,
      standardFontDataUrl: join(assets, 'standard_fonts') + '/'
    }).promise
    try {
      const page = await document.getPage(1),
        content = await page.getTextContent({ includeMarkedContent: true }),
        warning = vi.fn(),
        native = joinPdfTextItems(content.items.filter((i): i is TextItem => 'str' in i))
      expect(await readPdfPageText(page, warning)).toBe(native)
      expect(warning).toHaveBeenCalledExactlyOnceWith(1)
    } finally {
      await document.destroy()
    }
  })

  it.each(['gutter', 'source-eol', 'empty-eol', 'unpositioned'])(
    'does not infer paragraph continuation through a native %s',
    async (mode) => {
      const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs'),
        assets = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))
      const document = await getDocument({
        data: inlineFlowPdf('Generic label.'),
        useSystemFonts: false,
        isEvalSupported: false,
        verbosity: 0,
        standardFontDataUrl: join(assets, 'standard_fonts') + '/'
      }).promise
      try {
        const page = await document.getPage(1),
          content = await page.getTextContent(),
          input = content.items
            .filter((i): i is TextItem => 'str' in i)
            .map((i) => ({ ...i, transform: [...i.transform] })),
          following = input.findIndex((i) => i.str === 'First words.'),
          preceding = following - 2,
          space = input[following - 1]
        expect(space.str).toBe(' ')
        if (mode === 'gutter') {
          space.width += 30
          input[following].transform[4] += 30
        }
        if (mode === 'source-eol') input[preceding].hasEOL = true
        if (mode === 'empty-eol')
          input.splice(following, 0, {
            ...input[following],
            str: '',
            width: 0,
            height: 0,
            hasEOL: true
          })
        if (mode === 'unpositioned') input[following - 1] = { str: ' ', hasEOL: false } as TextItem
        const warning = vi.fn(),
          text = await read(input, null, warning, 0, false, {}, content.styles)
        expect(text).toContain('First words.')
        expect(warning).not.toHaveBeenCalled()
      } finally {
        await document.destroy()
      }
    }
  )

  it('preserves native inline rows with separate horizontal lanes below', async () => {
    const rows = Array.from({ length: 3 }, (_, n) => [
      {
        ...item(`Left paragraph has independent prose ${n}.`, 40, 100 + n * 14, 250),
        hasEOL: false
      },
      { ...item(' ', 290, 100 + n * 14, 10), height: 0, hasEOL: false },
      item(`Right paragraph has independent prose ${n}.`, 300, 100 + n * 14, 260)
    ])
    const warning = vi.fn()
    expect(await read(rows.flat(), null, warning)).toBe(joinPdfTextItems(rows.flat()))
    expect(warning).not.toHaveBeenCalled()
  })

  it('retains native equation rows below an inline mathematical label', async () => {
    const input = [
      { ...item('A generic equation.', 40, 100, 100), hasEOL: false },
      { ...item(' ', 140, 100, 10), height: 0, hasEOL: false },
      item('x = y', 150, 100, 40),
      item('x+y=z', 40, 114, 100),
      item('a+b=c', 40, 128, 100)
    ]
    expect(await read(input)).toBe(joinPdfTextItems(input))
  })

  it('keeps a physically leading native short run ahead of a grid prefix paragraph', async () => {
    const prefix = [
      { ...item('4', 550, 20, 7), height: 7, transform: [7, 0, 0, 7, 550, 780], hasEOL: false },
      { ...item('', 40, 100, 0), height: 0, hasEOL: true },
      item('An opening paragraph continues with a native-', 40, 100, 240)
    ]
    const input = [...prefix, ...nativeGridParagraphs()]
    const warning = vi.fn()
    expect(await read(input, null, warning)).toBe(joinPdfTextItems(input))
    expect(warning).toHaveBeenCalledExactlyOnceWith(1)
  })
  it('keeps a native trailing short run after the complete grid and following paragraph', async () => {
    const input = [
      ...nativeGridParagraphs(),
      item('A following paragraph remains independent prose.', 330, 200, 230),
      { ...item('4', 40, 280, 7), height: 7, transform: [7, 0, 0, 7, 40, 520] }
    ]
    const warning = vi.fn()
    expect(await read(input, null, warning)).toBe(joinPdfTextItems(input))
    expect(warning).toHaveBeenCalledExactlyOnceWith(1)
  })

  it.each(['heading', 'leading', 'trailing'])(
    'preserves a legitimate grid outer scope: %s',
    async (mode) => {
      const input =
        mode === 'trailing'
          ? [
              ...nativeGridParagraphs(),
              item('A following paragraph remains independent prose.', 330, 200, 230),
              { ...item('4', 550, 280, 7), height: 7, transform: [7, 0, 0, 7, 550, 520] }
            ]
          : [
              mode === 'heading'
                ? item('A complete independent heading.', 40, 20, 450)
                : { ...item('4', 40, 20, 7), height: 7, transform: [7, 0, 0, 7, 40, 780] },
              item('An opening paragraph continues with a native-', 40, 100, 240),
              ...nativeGridParagraphs()
            ]
      const warning = vi.fn(),
        text = await read(input, null, warning)
      expect(text).toBe(joinPdfTextItems(input))
      expect(warning).not.toHaveBeenCalled()
    }
  )
  it.each([false, true])(
    'retains an original native inline relationship split by layout: prefix=%s',
    async (prefix) => {
      const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
      const assets = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))
      const document = await getDocument({
        data: inlineFlowPdf(prefix),
        useSystemFonts: false,
        isEvalSupported: false,
        verbosity: 0,
        standardFontDataUrl: join(assets, 'standard_fonts') + '/'
      }).promise
      try {
        const page = await document.getPage(1),
          content = await page.getTextContent({ includeMarkedContent: true }),
          warning = vi.fn(),
          native = joinPdfTextItems(content.items.filter((i): i is TextItem => 'str' in i))
        expect(await readPdfPageText(page, warning)).toBe(native)
        expect(warning).toHaveBeenCalledExactlyOnceWith(1)
      } finally {
        await document.destroy()
      }
    }
  )

  it.each(['gutter', 'source-eol', 'empty-eol'])(
    'does not infer inline ownership across a native %s',
    async (mode) => {
      const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs'),
        assets = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))
      const document = await getDocument({
        data: inlineFlowPdf(),
        useSystemFonts: false,
        isEvalSupported: false,
        verbosity: 0,
        standardFontDataUrl: join(assets, 'standard_fonts') + '/'
      }).promise
      try {
        const page = await document.getPage(1),
          content = await page.getTextContent(),
          input = content.items
            .filter((i): i is TextItem => 'str' in i)
            .map((i) => ({ ...i, transform: [...i.transform] })),
          following = input.findIndex((i) => i.str === 'To'),
          preceding = following - 2,
          space = input[following - 1]
        expect(space.str).toBe(' ')
        if (mode === 'gutter') {
          space.width += 30
          input[following].transform[4] += 30
        }
        if (mode === 'source-eol') input[preceding].hasEOL = true
        if (mode === 'empty-eol')
          input.splice(following, 0, {
            ...input[following],
            str: '',
            width: 0,
            height: 0,
            hasEOL: true
          })
        const warning = vi.fn(),
          text = await read(input, null, warning, 0, false, {}, content.styles)
        expect(text).toContain('To')
        expect(warning).not.toHaveBeenCalled()
      } finally {
        await document.destroy()
      }
    }
  )
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

  it('keeps staggered short prose columns in geometry order rather than treating them as a grid', async () => {
    const rows = [
      ['Left first sentence.', 'Right first sentence.'],
      ['Left second sentence.', 'Right second sentence.'],
      ['Left third sentence.', 'Right third sentence.']
    ]
    const input = rows.flatMap(([left, right], row) => [
      item(left, 40, 80 + row * 14, 180),
      item(right, 330, 85 + row * 17, 180)
    ])
    const warning = vi.fn()

    expect(await read(input, null, warning)).toBe(
      [...rows.map(([left]) => left), ...rows.map(([, right]) => right)].join('\n')
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

  it('keeps four-column glossary cells together by row', async () => {
    const columns = [40, 150, 280, 410]
    const input = [
      ['Term', 'Meaning', 'Domain meaning', 'Example'],
      ...Array.from({ length: 5 }, (_, row) => [
        `Term ${row}`,
        `Literal ${row} has a long description for this glossary row`,
        `Domain ${row} has a detailed explanation for this term`,
        `Example ${row} demonstrates how the concept is used`
      ])
    ].flatMap((cells, row) =>
      cells.map((text, column) => item(text, columns[column], 100 + row * 50, 100))
    )
    const text = await read(input)
    const tokens = [
      'Term',
      'Meaning',
      'Domain meaning',
      'Example',
      ...Array.from({ length: 5 }, (_, row) => [
        `Term ${row}`,
        `Literal ${row} has a long description for this glossary row`,
        `Domain ${row} has a detailed explanation for this term`,
        `Example ${row} demonstrates how the concept is used`
      ]).flat()
    ]
    const positions = tokens.map((token) => text.indexOf(token))
    expect(positions.every((position) => position >= 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
  })

  it('keeps three-column prose in column order when the PDF draws it row by row', async () => {
    const columns = [40, 220, 400]
    const rows = Array.from({ length: 4 }, (_, row) =>
      columns.map((x, column) =>
        item(
          `Column ${column} paragraph ${row} continues with several supporting words.`,
          x,
          120 + row * 20,
          160
        )
      )
    ).flat()
    const warning = vi.fn()

    expect(await read(rows, null, warning)).toBe(
      columns
        .flatMap((x) => rows.filter((part) => part.transform[4] === x))
        .map((part) => part.str)
        .join('\n')
    )
    expect(warning).not.toHaveBeenCalled()
  })

  it('does not let a small grid reorder clear two-column prose elsewhere on the page', async () => {
    const columns = [40, 150, 280, 410]
    const tableRows = [
      ...['Term', 'Meaning', 'Domain', 'Example'].map((text, column) =>
        item(text, columns[column], 100, 100)
      ),
      ...Array.from({ length: 3 }, (_, row) => {
        const y = 140 + row * 45
        return [
          item(`Term ${row}`, columns[0], y, 100),
          item(`Literal ${row} has a long description`, columns[1], y, 100),
          item(`Domain ${row} gives a detailed explanation`, columns[2], y, 100),
          item(`Example ${row} demonstrates the concept`, columns[3], y, 100),
          item(`for this glossary row ${row}`, columns[1], y + 8, 100),
          item(`of its intended meaning ${row}`, columns[2], y + 8, 100),
          item(`in context ${row}`, columns[3], y + 8, 100)
        ]
      }).flat()
    ]
    const proseRows = Array.from({ length: 4 }, (_, row) => [
      item(
        `Left column paragraph ${row} continues with supporting detail.`,
        40,
        360 + row * 18,
        250
      ),
      item(
        `Right column paragraph ${row} continues with supporting detail.`,
        330,
        360 + row * 18,
        250
      )
    ]).flat()
    const input = [...tableRows, ...proseRows]
    const text = await read(input)
    const tableTokens = [
      'Term',
      'Meaning',
      'Domain',
      'Example',
      ...Array.from({ length: 3 }, (_, row) => [
        `Term ${row}`,
        `Literal ${row} has a long description`,
        `Domain ${row} gives a detailed explanation`,
        `Example ${row} demonstrates the concept`,
        `for this glossary row ${row}`,
        `of its intended meaning ${row}`,
        `in context ${row}`
      ]).flat()
    ]
    const tablePositions = tableTokens.map((token) => text.indexOf(token))
    const prose = [
      ...proseRows.filter((part) => part.transform[4] === 40),
      ...proseRows.filter((part) => part.transform[4] === 330)
    ].map((part) => text.indexOf(part.str))

    expect(tablePositions.every((position) => position >= 0)).toBe(true)
    expect(tablePositions).toEqual([...tablePositions].sort((a, b) => a - b))
    expect(prose.every((position) => position >= 0)).toBe(true)
    expect(prose).toEqual([...prose].sort((a, b) => a - b))
  })

  it('keeps a final wrapped grid cell before the following prose', async () => {
    const columns = [40, 150, 280, 410]
    const rows = [
      ...['Term', 'Meaning', 'Domain', 'Example'].map((text, column) =>
        item(text, columns[column], 100, 100)
      ),
      ...Array.from({ length: 3 }, (_, row) => {
        const y = 140 + row * 40
        return [
          item(`Term ${row}`, columns[0], y, 100),
          item(`Meaning ${row} describes the entry`, columns[1], y, 100),
          item(`Domain ${row} explains its usage`, columns[2], y, 100),
          item(`Example ${row} gives a sample phrase`, columns[3], y, 100),
          ...(row === 2 ? [item('continuing the final example', columns[3], y + 8, 100)] : [])
        ]
      }).flat()
    ]
    const prose = item('Following prose remains after the glossary.', 40, 340, 500)
    const input = [...rows, prose]
    const text = await read(input)
    const expected = [
      'Term',
      'Meaning',
      'Domain',
      'Example',
      ...Array.from({ length: 3 }, (_, row) => [
        `Term ${row}`,
        `Meaning ${row} describes the entry`,
        `Domain ${row} explains its usage`,
        `Example ${row} gives a sample phrase`
      ]).flat(),
      'continuing the final example',
      prose.str
    ]
    const positions = expected.map((part) => text.indexOf(part))
    const words = (value: string): string[] => value.match(/[\p{L}\p{N}]+/gu) ?? []

    expect(positions.every((position) => position >= 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
    expect(words(text).toSorted()).toEqual(
      words(input.map((part) => part.str).join(' ')).toSorted()
    )
  })

  it('warns and retains native text when a later source item is drawn above the grid', async () => {
    const columns = [40, 150, 280, 410]
    const table = [
      ['Term', 'Meaning', 'Domain', 'Example'],
      ...Array.from({ length: 3 }, (_, row) => [
        `Term ${row}`,
        `Literal ${row} has a long row description`,
        `Domain ${row} explains this entry`,
        `Example ${row} demonstrates the term`
      ])
    ].flatMap((cells, row) =>
      cells.map((text, column) => item(text, columns[column], 120 + row * 35, 100))
    )
    const input = [...table, item('Late positioned heading', columns[1], 70, 100)]
    const warning = vi.fn()

    expect(await read(input, null, warning)).toBe(input.map((part) => part.str).join('\n'))
    expect(warning).toHaveBeenCalledExactlyOnceWith(1)
  })

  it('retains row-wise two-column label/value associations from the native item stream', async () => {
    const input = [
      item('Label', 115, 230, 250),
      item('Count', 384, 230, 70),
      ...Array.from({ length: 7 }, (_, row) => [
        item(`Category ${row}`, 115, 240 + row * 9, 250),
        item(String(70 - row), 415, 240 + row * 9, 30)
      ]).flat()
    ]
    const warning = vi.fn()
    const text = await read(input, null, warning)
    const pairs = input.slice(2).reduce<[string, string][]>((rows, part, index, all) => {
      if (index % 2 === 0) rows.push([part.str, all[index + 1].str])
      return rows
    }, [])
    const positions = pairs.flatMap(([label, value]) => [text.indexOf(label), text.indexOf(value)])

    expect(positions.every((position) => position >= 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
    expect(warning).not.toHaveBeenCalled()
  })

  it('retains row-wise wrapped narrative cells when native reading order is explicit', async () => {
    const columns = [128, 204, 324, 443]
    const input = [
      ...['Stub', 'Examples', 'Impact', 'Sources'].map((text, column) =>
        item(text, columns[column], 255, 65)
      ),
      item('Term A', columns[0], 264, 65),
      item('Model type, size and', columns[1], 264, 110),
      item('Determines execution', columns[2], 264, 110),
      item('[1, 2, 3]', columns[3], 264, 65),
      item('layer layout', columns[1], 273, 110),
      item('and memory use', columns[2], 273, 110),
      item('Term B', columns[0], 300, 65),
      item('Communication', columns[1], 300, 110),
      item('Can dominate energy', columns[2], 300, 110),
      item('[4, 5, 6]', columns[3], 300, 65),
      item('method and protocol', columns[1], 309, 110),
      item('especially when frequent', columns[2], 309, 110),
      item('Term C', columns[0], 336, 65),
      item('Input size and shape', columns[1], 336, 110),
      item('Larger inputs increase', columns[2], 336, 110),
      item('[7, 8, 9]', columns[3], 336, 65),
      item('sensor characteristics', columns[1], 345, 110),
      item('processing and energy', columns[2], 345, 110)
    ]
    const warning = vi.fn()
    const text = await read(input, null, warning)
    const rowAnchors = ['Term A', 'Term B', 'Term C']
    const positions = rowAnchors.map((anchor) => text.indexOf(anchor))

    expect(positions.every((position) => position >= 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
    expect(text.indexOf('layer layout')).toBeLessThan(text.indexOf('Term B'))
    expect(text.indexOf('especially when frequent')).toBeLessThan(text.indexOf('Term C'))
    expect(warning).toHaveBeenCalledExactlyOnceWith(1)
  })

  it('keeps wrapped text in four-column narrative records attached to their row anchors', async () => {
    const x = [127.6, 204.4, 323.8, 443.2]
    const rows = [
      ...['Stub', 'Examples', 'Impact', 'Sources'].map((text, column) =>
        item(text, x[column], 220, 75)
      ),
      item('Term A', x[0], 230, 75),
      item('Model type, processor', x[1], 230, 113),
      item('Determines execution efficiency', x[2], 230, 113),
      item('[1, 2, 3]', x[3], 230, 70),
      item('and memory organization', x[1], 239, 113),
      item('and memory usage', x[2], 239, 113),
      item('Term B', x[0], 267, 75),
      item('Communication method', x[1], 267, 113),
      item('Can dominate energy use', x[2], 267, 113),
      item('[4, 5, 6]', x[3], 267, 70),
      item('with frequent transfers', x[1], 276, 113),
      item('especially on small devices', x[2], 276, 113),
      item('Term C', x[0], 304, 75),
      item('Input size and shape', x[1], 304, 113),
      item('Larger inputs increase', x[2], 304, 113),
      item('[7, 8, 9]', x[3], 304, 70),
      item('and sampling rate', x[1], 313, 113),
      item('processing and energy use', x[2], 313, 113)
    ]
    const warning = vi.fn()
    const text = await read(rows, null, warning)
    const expectedCells = [
      'Stub',
      'Examples',
      'Impact',
      'Sources',
      'Term A',
      'Model type, processor',
      'Determines execution efficiency',
      '[1, 2, 3]',
      'and memory organization',
      'and memory usage',
      'Term B',
      'Communication method',
      'Can dominate energy use',
      '[4, 5, 6]',
      'with frequent transfers',
      'especially on small devices',
      'Term C',
      'Input size and shape',
      'Larger inputs increase',
      '[7, 8, 9]',
      'and sampling rate',
      'processing and energy use'
    ]
    const positions = expectedCells.map((cell) => text.indexOf(cell))

    expect(positions.every((position) => position >= 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
    expect(warning).not.toHaveBeenCalled()
  })

  it('does not treat indented short bullet labels as a table grid', async () => {
    const input = [
      item('•', 72, 95, 5),
      item('Label A.', 85, 95, 80),
      item('A description follows this short bullet label.', 177, 95, 360),
      item('Its continuation remains with the same bullet entry.', 85, 108.5, 440),
      item('•', 72, 128, 5),
      item('Label B.', 85, 128, 80),
      item('A second description follows the next bullet label.', 185, 128, 350),
      item('This continuation also remains with its bullet entry.', 85, 141.5, 440),
      item('•', 72, 161, 5),
      item('Label C.', 85, 161, 80),
      item('A third description follows the final bullet label.', 175, 161, 360),
      item('This continuation completes the final bullet entry.', 85, 174.5, 440),
      item('Section.', 72, 659, 62),
      item('The first sentence belongs under this section.', 144.7, 659, 397),
      item('The next sentence follows it in the same paragraph.', 71.6, 672.5, 468),
      item('A final line completes that paragraph.', 72, 686, 141)
    ]
    const warning = vi.fn()

    expect(await read(input, null, warning)).toBe(input.map((part) => part.str).join('\n'))
    expect(warning).toHaveBeenCalledExactlyOnceWith(1)
  })

  it('keeps an indented code object source-contiguous across its closing brace', async () => {
    const codeItem = (
      str: string,
      x: number,
      y: number,
      width: number,
      hasEOL = true
    ): TextItem => ({
      str,
      width,
      height: 7.9701,
      dir: 'ltr',
      fontName: 'Code',
      transform: [7.9701, 0, 0, 7.9701, x, y],
      hasEOL
    })
    const input = [
      codeItem('"kind": "value"', 91.053, 699.577, 67.74983505),
      codeItem('},', 87.243, 690.112, 8.46902826),
      codeItem('"details": "neutral placeholder text"', 87.243, 680.648, 270.98738505),
      codeItem(
        'A separate example field spans across the page and ends here.',
        75.811,
        318.077,
        461.52139266
      ),
      codeItem('The next field follows on the subsequent line.', 75.811, 299.148, 427.64527962)
    ]
    const warning = vi.fn()
    const text = await read(
      input,
      null,
      warning,
      0,
      false,
      { view: [0, 0, 595, 792] },
      {
        Code: { ascent: 0.601, descent: -0.222, vertical: false, fontFamily: 'sans-serif' }
      }
    )

    const semanticLines = ['"kind": "value"', '},', '"details": "neutral placeholder text"']
    const positions = semanticLines.map((line) => text.indexOf(line))
    expect(positions.every((position) => position >= 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
    expect(warning).toHaveBeenCalledExactlyOnceWith(1)
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
