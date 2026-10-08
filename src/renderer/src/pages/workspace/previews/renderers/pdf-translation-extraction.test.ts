import { getPdfTranslationTextContent } from './pdf-translation-text-content'
import { readPdfTranslationCases } from '../../../../../../../test/fixtures/pdf-translation/read-cases'
/* eslint-disable @typescript-eslint/explicit-function-return-type -- retain inferred mock fixture types */
import { describe, expect, it, vi } from 'vitest'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import { extractPdfTranslationSource } from './pdf-translation-extraction'
import { bindPdfTranslation } from './pdf-translation'
import { groupPdfTranslationPages } from './pdf-translation-layout'

const text = (str: string, x = 40, y = 100) => ({
  str,
  transform: [10, 0, 0, 10, x, 800 - y],
  width: 150,
  height: 10,
  dir: 'ltr',
  fontName: 'body',
  hasEOL: true
})
const setup = (items = [text('An intact source paragraph.')]) => {
  const page = {
    rotate: 0,
    getViewport: vi.fn(() => ({ width: 600, height: 800, transform: [1, 0, 0, -1, 0, 800] })),
    getTextContent: vi.fn().mockResolvedValue({ items }),
    cleanup: vi.fn()
  }
  const document = {
    numPages: 1,
    fingerprints: ['source'],
    getPage: vi.fn().mockResolvedValue(page),
    destroy: vi.fn()
  }
  const controller = new AbortController()
  const context = {
    document: document as unknown as PDFDocumentProxy,
    resourceRequestKey: 'current',
    signal: controller.signal
  }
  return { page, document, controller, context }
}

describe('extractPdfTranslationSource', () => {
  it('uses existing line regions when a merged caption box would enclose a neighboring column', async () => {
    const items = [
      { ...text('Table 1. Characteristics of trial participants', 40, 100), width: 480 },
      { ...text('Category', 40, 112), width: 80 },
      { ...text('Control', 300, 112), width: 80 }
    ]
    const fixture = setup(items)
    const previous = groupPdfTranslationPages({
      pages: [{ page: 1, width: 600, height: 800, rotation: 0, items }]
    })
    const { source, coverage } = await extractPdfTranslationSource(fixture.context)
    expect(source.units.map((u) => ({ id: u.id, source: u.source }))).toEqual(
      previous.units.map((u) => ({ id: u.id, source: u.source }))
    )
    const merged = source.units.find((u) => u.source.includes('Characteristics'))!
    expect(merged.fragments).toHaveLength(2)
    expect(merged.fragments.map((f) => f.items.map((i) => i.index))).toEqual([[0], [1]])
    expect(merged.fragments[1].rect.x + merged.fragments[1].rect.width).toBeLessThan(300 / 600)
    expect(coverage.includedItemCount).toBe(3)
    expect(coverage.excludedItemCount).toBe(0)
  })

  it.each([
    [0, 10, -10, 0],
    [0, -10, 10, 0],
    [-10, 0, 0, -10]
  ])('retains orthogonal rotated source independently (%s,%s,%s,%s)', async (a, b, c, d) => {
    const fixture = setup([
      text('Original prose.'),
      { ...text('−56⋅6'), width: 40, transform: [a, b, c, d, 300, 400] }
    ])
    const { source, coverage } = await extractPdfTranslationSource(fixture.context)
    expect(coverage).toMatchObject({ includedItemCount: 2, excludedItemCount: 0 })
    expect(source.units[0].sourceOnly).toBeUndefined()
    expect(source.units[1]).toMatchObject({ id: 'rot-p1-i1', source: '−56⋅6', sourceOnly: true })
    expect(source.units[1].fragments[0].items).toEqual([{ index: 1, text: '−56⋅6' }])
    const r = source.units[1].fragments[0].rect
    expect(r.width * 600 * r.height * 800).toBeCloseTo(400)
    expect(Object.isFrozen(source.units[1])).toBe(true)
    const record = (u: (typeof source.units)[number]) => ({
      id: u.id,
      translationSource: u.source,
      translation: 'Diagnostic'
    })
    expect(
      (
        await bindPdfTranslation(
          source,
          { source, units: [record(source.units[0])] },
          fixture.context.document,
          'current',
          fixture.context.signal
        )
      )?.units
    ).toHaveLength(1)
    expect(
      await bindPdfTranslation(
        source,
        { source, units: source.units.map(record) },
        fixture.context.document,
        'current',
        fixture.context.signal
      )
    ).toBeNull()
  })
  it('keeps individual table symbols with zero font metrics and does not merge rows', async () => {
    const fixture = setup(
      ['56', '⋅', '6', '−'].map((str, index) => ({
        ...text(str),
        width: 5,
        transform: [0, 10, -10, 0, 200, 300 + index * 5]
      }))
    )
    fixture.page.getTextContent.mockResolvedValue({
      items: ['56', '⋅', '6', '−'].map((str, index) => ({
        ...text(str),
        width: 5,
        transform: [0, 10, -10, 0, 200, 300 + index * 5]
      })),
      styles: { body: { ascent: 0, descent: 0 } }
    })
    const { source, coverage } = await extractPdfTranslationSource(fixture.context)
    expect(source.units.map((u) => u.source)).toEqual(['56', '⋅', '6', '−'])
    expect(source.units.every((u) => u.sourceOnly && u.fragments[0].rect.width > 0)).toBe(true)
    expect(coverage.excludedItemCount).toBe(0)
  })
  it('maps rotated text through CropBox and UserUnit before retaining its source anchor', async () => {
    const fixture = setup([{ ...text('Rotated'), transform: [0, 10, -10, 0, 500, 300] }])
    fixture.page.getViewport.mockReturnValue({
      width: 1200,
      height: 1600,
      transform: [2, 0, 0, -2, -20, 1600]
    })
    const { source } = await extractPdfTranslationSource(fixture.context)
    expect(source.units[0].fragments[0].rect).toEqual({
      x: 964 / 1200,
      y: 700 / 1600,
      width: 20 / 1200,
      height: 300 / 1600
    })
  })
  it('retains upside-down text in a rotated default viewport as source-only', async () => {
    const fixture = setup([{ ...text('Page-rotated'), transform: [0, -10, 10, 0, 200, 200] }])
    fixture.page.rotate = 90
    fixture.page.getViewport.mockReturnValue({
      width: 800,
      height: 600,
      transform: [0, 1, 1, 0, 0, 0]
    })
    const { source, coverage } = await extractPdfTranslationSource(fixture.context)
    expect(source.units[0]).toMatchObject({ source: 'Page-rotated', sourceOnly: true })
    expect(coverage.excludedItemCount).toBe(0)
  })
  it('groups upright prose after the default viewport rotation has already been applied', async () => {
    const fixture = setup([{ ...text('Readable prose.'), transform: [0, 10, -10, 0, 200, 200] }])
    fixture.page.rotate = 90
    fixture.page.getViewport.mockReturnValue({
      width: 800,
      height: 600,
      transform: [0, 1, 1, 0, 0, 0]
    })
    const { source, coverage } = await extractPdfTranslationSource(fixture.context)
    expect(source.units).toHaveLength(1)
    expect(source.units[0].source).toBe('Readable prose.')
    expect(source.units[0].sourceOnly).toBeUndefined()
    expect(coverage.excludedItemCount).toBe(0)
  })
  it.each(['skew', 'mirror', 'rtl', 'vertical', 'outside', 'invalid-style'] as const)(
    'does not recover %s text',
    async (kind) => {
      const item = { ...text('Unsupported'), transform: [0, 10, -10, 0, 500, 300] }
      if (kind === 'skew') item.transform = [2, 10, -10, 0, 500, 300]
      if (kind === 'mirror') item.transform = [0, 10, 10, 0, 500, 300]
      if (kind === 'rtl') item.dir = 'rtl'
      if (kind === 'outside') item.transform = [0, 10, -10, 0, -100, 300]
      const fixture = setup([item])
      fixture.page.getTextContent.mockResolvedValue({
        items: [item],
        styles: {
          body:
            kind === 'vertical'
              ? { vertical: true }
              : kind === 'invalid-style'
                ? { ascent: Infinity }
                : {}
        }
      })
      const result = await extractPdfTranslationSource(fixture.context)
      expect(result.source.units).toEqual([])
      expect(result.coverage.excludedItemCount).toBe(1)
    }
  )

  it('reports completed page reads in order and stops progress after cancellation', async () => {
    const fixture = setup()
    fixture.document.numPages = 3
    const onProgress = vi.fn((pages: number) => {
      if (pages === 2) fixture.controller.abort()
    })
    await expect(
      extractPdfTranslationSource({ ...fixture.context, onProgress })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(onProgress.mock.calls).toEqual([[1], [2]])
    expect(fixture.document.getPage.mock.calls).toEqual([[1], [2]])
  })
  it('uses the viewport CropBox offset and UserUnit scale for source rectangles', async () => {
    const fixture = setup()
    fixture.page.getViewport.mockReturnValue({
      width: 1200,
      height: 1600,
      transform: [2, 0, 0, -2, -20, 1600]
    })
    const { source } = await extractPdfTranslationSource(fixture.context)
    expect(source.units[0].fragments[0].rect).toEqual({
      x: 60 / 1200,
      y: 183 / 1600,
      width: 300 / 1200,
      height: 22 / 1600
    })
  })

  it('preserves native end-of-line markers carried by empty items', async () => {
    const fixture = setup([
      { ...text('Ethical'), width: 30, hasEOL: false },
      text(''),
      { ...text('clearance', 90), width: 40, hasEOL: false },
      { ...text('number', 165), width: 30 }
    ])
    const { source, coverage } = await extractPdfTranslationSource(fixture.context)
    expect(source.units.map((unit) => unit.source)).toEqual(['Ethical', 'clearance number'])
    expect(coverage.textItemCount).toBe(3)
    expect(source.units[1].fragments[0].items.map((item) => item.index)).toEqual([2, 3])
  })

  it('creates a bindable immutable snapshot with original item indexes and no cleanup', async () => {
    const fixture = setup([text(''), text('An intact source paragraph.')])
    const result = await extractPdfTranslationSource(fixture.context)
    expect(result.coverage).toMatchObject({
      pageCount: 1,
      textItemCount: 1,
      includedItemCount: 1,
      excludedItemCount: 0,
      pagesWithoutText: [],
      exclusions: []
    })
    const unit = result.source.units[0]
    expect(unit.fragments[0].items).toEqual([{ index: 1, text: 'An intact source paragraph.' }])
    const bound = await bindPdfTranslation(
      result.source,
      {
        source: result.source,
        units: [{ id: unit.id, translationSource: unit.source, translation: '完整的原文段落。' }]
      },
      fixture.context.document,
      'current',
      fixture.context.signal
    )
    expect(bound?.units[0].translation).toBe('完整的原文段落。')
    expect(Object.isFrozen(result.coverage)).toBe(true)
    expect(Object.isFrozen(result.source.units)).toBe(true)
    expect(fixture.page.cleanup).not.toHaveBeenCalled()
    expect(fixture.document.destroy).not.toHaveBeenCalled()
  })

  it('accounts for invalid geometry, unsupported orientation and out-of-page text without clamping', async () => {
    const fixture = setup([
      text('Valid original text.'),
      { ...text('Non-finite transform'), transform: [10, 0, 0, 10, NaN, 400] },
      { ...text('Vertical source'), dir: 'ttb', transform: [0, 10, -10, 0, 500, 300] },
      text('Outside the crop box', -100, 500)
    ])
    const { source, coverage } = await extractPdfTranslationSource(fixture.context)
    expect(source.units).toHaveLength(1)
    expect(coverage.textItemCount).toBe(4)
    expect(coverage.includedItemCount).toBe(1)
    expect(coverage.excludedItemCount).toBe(3)
    expect(coverage.exclusions.map((e) => e.reason).sort()).toEqual([
      'invalid-geometry',
      'outside-page',
      'unsupported-orientation'
    ])
    expect(
      coverage.exclusions
        .flatMap((e) => e.items)
        .map((i) => i.index)
        .sort()
    ).toEqual([1, 2, 3])
    expect(Object.isFrozen(coverage.exclusions[0].items[0])).toBe(true)
  })

  it('reports empty extracted text without guessing that the page is scanned', async () => {
    const fixture = setup([text('   ')])
    const { source, coverage } = await extractPdfTranslationSource(fixture.context)
    expect(source.units).toEqual([])
    expect(coverage.pagesWithoutText).toEqual([1])
    expect(coverage.textItemCount).toBe(0)
    expect(coverage.exclusions).toEqual([])
  })

  it('retains ambiguous scientific hyphens with an advisory warning', async () => {
    const fixture = setup([
      text('The participant-', 40, 100),
      text('completed questionnaire.', 40, 112)
    ])
    const { source, coverage } = await extractPdfTranslationSource(fixture.context)
    expect(source.units[0].source).toBe('The participant-completed questionnaire.')
    expect(coverage.warnings[0].reasons).toContain('ambiguous-line-hyphen')
  })

  it.each(['before', 'page', 'text'] as const)(
    'rejects cancellation at %s without reading later pages',
    async (stage) => {
      const fixture = setup()
      fixture.document.numPages = 2
      let resume!: (value: unknown) => void
      if (stage === 'page')
        fixture.document.getPage.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resume = resolve
            })
        )
      if (stage === 'text')
        fixture.page.getTextContent.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resume = resolve
            })
        )
      if (stage === 'before') fixture.controller.abort()
      const pending = extractPdfTranslationSource(fixture.context)
      const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      if (stage !== 'before') {
        await vi.waitFor(() => expect(resume).toBeTypeOf('function'))
        fixture.controller.abort()
        resume(stage === 'page' ? fixture.page : { items: [text('A delayed result.')] })
      }
      await rejected
      expect(fixture.document.getPage).toHaveBeenCalledTimes(stage === 'before' ? 0 : 1)
      expect(fixture.page.cleanup).not.toHaveBeenCalled()
      expect(fixture.document.destroy).not.toHaveBeenCalled()
    }
  )

  it('rejects a failed page instead of reporting partial extraction as complete', async () => {
    const fixture = setup()
    fixture.document.numPages = 2
    fixture.document.getPage
      .mockResolvedValueOnce(fixture.page)
      .mockRejectedValueOnce(new Error('Damaged page'))
    await expect(extractPdfTranslationSource(fixture.context)).rejects.toThrow('Damaged page')
    expect(fixture.page.cleanup).not.toHaveBeenCalled()
  })

  it('rejects invalid source identity and page geometry before publication', async () => {
    const fixture = setup()
    fixture.document.fingerprints = []
    await expect(extractPdfTranslationSource(fixture.context)).rejects.toThrow(
      'Invalid PDF source identity'
    )
    expect(fixture.document.getPage).not.toHaveBeenCalled()
    fixture.document.fingerprints = ['source']
    fixture.page.getViewport.mockReturnValue({
      width: Infinity,
      height: 800,
      transform: [1, 0, 0, -1, 0, 800]
    })
    await expect(extractPdfTranslationSource(fixture.context)).rejects.toThrow(
      'Invalid PDF page geometry'
    )
    expect(fixture.page.getTextContent).not.toHaveBeenCalled()
  })
})

it.each(
  readPdfTranslationCases<{ name: string; font: string; source: string; expected: string }>(
    'legacy-dingbats-text-encoding.jsonl'
  )
)('$name', async ({ font, source, expected }) => {
  const items = [{ ...text(source), fontName: 'symbol' }, text('3'), text('7')]
  const content = { items }
  let loaded = false
  const page = {
    getTextContent: vi.fn().mockResolvedValue(content),
    commonObjs: {
      has: (name: string) => name === 'body' || loaded,
      get: (name: string) => ({ name: name === 'symbol' ? font : 'Times-Roman' })
    },
    getOperatorList: vi.fn(async () => {
      loaded = true
    })
  }
  const result = await getPdfTranslationTextContent(page as unknown as PDFPageProxy)
  expect(result.items.map((item) => ('str' in item ? item.str : ''))).toEqual([expected, '3', '7'])
  expect(content.items[0].str).toBe(source)
})

it.each([
  ['subset txsys multiplication', 'XQRHLV+txsys', 0.636, '\u0002', '×'],
  ['unsubset txsys multiplication', 'txsys', 0.636, '\u0002', '×'],
  ['different math font', 'AdvMacMthSyN', 0.636, '\u0002', '\u0002'],
  ['similar font name', 'other-txsys', 0.636, '\u0002', '\u0002'],
  ['different advance', 'txsys', 0.5, '\u0002', '\u0002'],
  ['different control slot', 'txsys', 0.636, '\u0003', '\u0003'],
  ['mixed run', 'txsys', 0.636, '2\u0002', '2\u0002'],
  ['ordinary digit', 'txsys', 0.636, '2', '2']
])('decodes only a proven legacy symbol: %s', async (_name, font, advance, str, expected) => {
  const item = { ...text(String(str)), fontName: 'symbol', width: Number(advance) * 10 }
  const content = { items: [item, text('Ordinary prose.')] }
  let loaded = false
  const page = {
    getTextContent: vi.fn().mockResolvedValue(content),
    commonObjs: {
      has: () => loaded,
      get: () => ({ name: font })
    },
    getOperatorList: vi.fn(async () => {
      loaded = true
    })
  }
  const result = await getPdfTranslationTextContent(page as unknown as PDFPageProxy)
  expect(result.items[0]).toEqual({ ...item, str: expected })
  expect(result.items[1]).toBe(content.items[1])
  expect(content.items[0].str).toBe(str)
})

it('keeps the synthetic abstract intact after legacy multiplication decoding', async () => {
  const [fixture] = readPdfTranslationCases<{ page: { items: ReturnType<typeof text>[] } }>(
    'txsys-multiplication-native-abstract.jsonl'
  )
  const { page, context } = setup(fixture.page.items)
  Object.assign(page, {
    commonObjs: {
      has: () => true,
      get: (font: string) => ({ name: font === 'g_d0_f4' ? 'XQRHLV+txsys' : 'Times-Roman' })
    }
  })
  const { source, coverage } = await extractPdfTranslationSource(context)
  expect(source.units).toHaveLength(1)
  expect(source.units[0].source).toContain('3× signals on JOB-2')
  expect(source.units[0].source).toContain('2.4× signals on case-group curve')
  expect(source.units[0].source).toContain('Item-256 (tag. length 64K, 63.1% accuracy).')
  expect(source.units[0].sourceOnly).toBeUndefined()
  expect(coverage.excludedItemCount).toBe(0)
})

it('extracts the native clinical dose paragraph as one checked body region', async () => {
  const { source: expected, page: native } = readPdfTranslationCases<{
    source: string
    page: import('./pdf-translation-layout').PdfLayoutPage
  }>('wrapped-dose-native-body.jsonl')[0]
  const fixture = setup()
  fixture.page.getViewport.mockReturnValue({
    width: native.width,
    height: native.height,
    transform: [1, 0, 0, -1, 0, native.height]
  })
  fixture.page.getTextContent.mockResolvedValue({
    items: native.items,
    styles: Object.fromEntries(
      native.items.map((item) => [
        item.fontName,
        {
          ascent: item.fontAscent,
          descent: item.fontDescent
        }
      ])
    )
  })
  const { source, coverage } = await extractPdfTranslationSource(fixture.context)
  expect(source.units.map((unit) => unit.source)).toEqual(['Structured', expected])
  expect(source.units[1].sourceOnly).toBeUndefined()
  expect(source.units[1].fragments).toHaveLength(1)
  expect(source.units[1].fragments[0].items.map((item) => item.index)).toEqual(
    native.items.flatMap((item, index) => (index > 1 && item.str.trim() ? [index] : []))
  )
  expect(coverage.excludedItemCount).toBe(0)
})

it.each(
  readPdfTranslationCases<{
    name: string
    page: import('./pdf-translation-layout').PdfLayoutPage
  }>('observed-time-and-numeric-tail.jsonl')
)('$name extracts one region without changing native ownership', async ({ page: native }) => {
  const fixture = setup()
  fixture.page.getViewport.mockReturnValue({
    width: native.width,
    height: native.height,
    transform: [1, 0, 0, -1, 0, native.height]
  })
  fixture.page.getTextContent.mockResolvedValue({
    items: native.items,
    styles: Object.fromEntries(
      native.items.map((item) => [
        item.fontName,
        { ascent: item.fontAscent, descent: item.fontDescent }
      ])
    )
  })
  const { source, coverage } = await extractPdfTranslationSource(fixture.context)
  expect(source.units).toHaveLength(1)
  expect(source.units[0].sourceOnly).toBeUndefined()
  expect(source.units[0].fragments).toHaveLength(1)
  expect(source.units[0].fragments[0].items.map((item) => item.index)).toEqual(
    native.items.flatMap((item, index) => (item.str.trim() ? [index] : []))
  )
  expect(coverage.excludedItemCount).toBe(0)
})

it('keeps the verified reference/model-script paragraph in one region, apart from its footnote', async () => {
  const { source: expected, page: native } = readPdfTranslationCases<{
    source: string
    page: import('./pdf-translation-layout').PdfLayoutPage
  }>('reference-script-native-seam.jsonl')[0]
  const fixture = setup()
  fixture.page.getViewport.mockReturnValue({
    width: native.width,
    height: native.height,
    transform: [1, 0, 0, -1, 0, native.height]
  })
  fixture.page.getTextContent.mockResolvedValue({
    items: native.items,
    styles: Object.fromEntries(
      native.items.map((item) => [
        item.fontName,
        { ascent: item.fontAscent, descent: item.fontDescent }
      ])
    )
  })
  const { source, coverage } = await extractPdfTranslationSource(fixture.context)
  const body = source.units.find((unit) => unit.source === expected)!
  expect(body.sourceOnly).toBeUndefined()
  expect(body.fragments).toHaveLength(1)
  expect(body.fragments[0].items.map((item) => item.index)).toEqual([
    0, 1, 3, 4, 5, 6, 8, 9, 11, 12, 13
  ])
  expect(
    source.units.find((unit) => unit.source.startsWith('5https://'))?.fragments[0].items[0].index
  ).toBe(33)
  expect(coverage.excludedItemCount).toBe(0)
})

it('keeps short wrapped prose in separate physical rows outside its protected formula', async () => {
  const { page: native } = readPdfTranslationCases<{
    page: import('./pdf-translation-layout').PdfLayoutPage
  }>('short-formula-prose-native.jsonl')[0]
  const fixture = setup()
  fixture.page.getViewport.mockReturnValue({
    width: native.width,
    height: native.height,
    transform: [1, 0, 0, -1, 0, native.height]
  })
  fixture.page.getTextContent.mockResolvedValue({
    items: native.items,
    styles: Object.fromEntries(
      native.items.map((item) => [
        item.fontName,
        { ascent: item.fontAscent, descent: item.fontDescent }
      ])
    )
  })
  const { source, coverage } = await extractPdfTranslationSource(fixture.context)
  expect(source.units).toHaveLength(2)
  const formula = source.units.find((unit) => unit.sourceOnly)!
  const prose = source.units.find((unit) => !unit.sourceOnly)!
  expect(formula.source).toBe('β2 = 0.98')
  expect(formula.fragments.flatMap((f) => f.items.map((item) => item.index))).toEqual([
    0, 1, 3, 4, 5
  ])
  expect(prose.source).toBe('to minimum measureme when training with large local masks.')
  expect(prose.fragments.map((f) => f.items.map((item) => item.index))).toEqual([[7], [8]])
  expect(prose.fragments[0].rect.x).toBeGreaterThan(
    formula.fragments[0].rect.x + formula.fragments[0].rect.width
  )
  expect(prose.fragments[1].rect.y).toBeGreaterThan(
    formula.fragments[0].rect.y + formula.fragments[0].rect.height
  )
  expect(coverage.excludedItemCount).toBe(0)
  expect(coverage.includedItemCount).toBe(7)
})
