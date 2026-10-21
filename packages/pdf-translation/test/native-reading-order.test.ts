import { resolve } from './paths.js'
import { expect, it, onTestFinished } from 'vitest'
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { TestCallerRegistry } from './support/callers.js'
import { PdfTranslationWriter } from '../src/writer.js'
import { extractPdfTranslationSource } from '../src/reader/extraction.js'
import { readPdfTranslationCases } from './fixtures/read-cases.js'
import { verifyPdfPreservation } from './support/pdf-translation-preservation.js'
import { groupPdfTranslationPages, type PdfLayoutTextItem } from '../src/reader/layout.js'

function numberedReferenceColumns(fault = ''): PdfLayoutTextItem[] {
  const items = [40, 296].flatMap((x, lane) =>
    [120, 180, 600, 660].flatMap((y, row) => {
      const number = lane * 4 + row + 1
      return [
        `[${number}] A. Author, An independent research article,`,
        'Synthetic Journal 12 (2024), complete publication details.'
      ].map((str, line) => ({
        str,
        width: 220,
        height: 10,
        dir: 'ltr',
        hasEOL: true,
        transform: [10, 0, 0, 10, x + line * 12, 800 - y - line * 12],
        fontName: 'Reference',
        fontAscent: 0.78,
        fontDescent: -0.22
      }))
    })
  )
  items.push({ ...items[0], str: '1', width: 10, transform: [10, 0, 0, 10, 279, 96] })
  if (fault === 'missing-number') items[4].str = items[4].str.replace('[3]', '[9]')
  if (fault === 'duplicate-number') items[8].str = items[8].str.replace('[5]', '[4]')
  if (fault === 'missing-font') items[5].fontName = ''
  if (fault === 'foreign-block') items[4].str = 'Independent section of ordinary explanatory text.'
  if (fault === 'missing-date') items[5].str = items[5].str.replace('(2024)', '(n.d.)')
  if (fault === 'cross-gutter') items[5].width = 400
  if (fault === 'footer-font') items.at(-1)!.fontName = 'Unknown'
  if (fault === 'foreign-page') items.at(-1)!.str = '2'
  if (fault === 'footer-overlap') items.at(-1)!.transform[5] = 130
  if (fault === 'native-band-order')
    return [...items.slice(0, 4), ...items.slice(8, 12), ...items.slice(4, 8), ...items.slice(12)]
  return items
}

it('keeps complete consecutive native bibliography columns across a shared paragraph gap', () => {
  const items = numberedReferenceColumns()
  const result = groupPdfTranslationPages({
    pages: [{ page: 1, width: 600, height: 800, rotation: 0, items }]
  })
  expect(result.units.map((unit) => /^\[(\d+)\]/u.exec(unit.source)?.[1]).filter(Boolean)).toEqual([
    '1',
    '2',
    '3',
    '4',
    '5',
    '6',
    '7',
    '8'
  ])
  expect(result.units.flatMap((unit) => unit.items).toSorted()).toEqual(
    items.map((_, index) => `1:${index}`).toSorted()
  )
})

it.each([
  'missing-number',
  'duplicate-number',
  'missing-font',
  'foreign-block',
  'missing-date',
  'cross-gutter',
  'footer-font',
  'foreign-page',
  'footer-overlap',
  'native-band-order'
])('does not override section order without complete bibliography evidence: %s', (fault) => {
  const items = numberedReferenceColumns(fault)
  const result = groupPdfTranslationPages({
    pages: [{ page: 1, width: 600, height: 800, rotation: 0, items }]
  })
  const starts = result.units.map((unit) => /^\[(\d+)\]/u.exec(unit.source)?.[1]).filter(Boolean)
  expect(starts.indexOf('5') >= 0 ? starts.indexOf('5') : starts.indexOf('4')).toBeLessThan(
    starts.lastIndexOf('4')
  )
  expect(result.units.flatMap((unit) => unit.items).toSorted()).toEqual(
    items.map((_, index) => `1:${index}`).toSorted()
  )
})

const cases = readPdfTranslationCases<{
  name: string
  draws: [number, number, number, string][]
  source: string
  bounds: [number, number, number, number]
  roundtrip?: boolean
}>('native-visual-reading-order.jsonl')

it.each(cases)(
  'proves unchanged visual reading order without repainting: $name',
  async (fixture) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica),
      page = pdf.addPage([600, 800])
    for (const [x, y, size, text] of fixture.draws) page.drawText(text, { x, y, size, font })
    page.drawText('Independent neighboring paragraph.', { x: 40, y: 600, size: 10, font })
    const data = new Uint8Array(await pdf.save()),
      loading = getDocument({ data: data.slice(), useSystemFonts: true }),
      registry = new TestCallerRegistry()
    onTestFinished(() => loading.destroy())
    onTestFinished(() => registry.dispose())
    const original = await loading.promise,
      caller = registry.acquire({ leaseId: 'native-reading-order', surface: 'electron' }),
      { source } = await extractPdfTranslationSource({
        document: original,
        resourceRequestKey: 'synthetic-reading-order',
        signal: caller.lease.signal
      }),
      [left, bottom, right, top] = fixture.bounds,
      unit = {
        source: fixture.source,
        translation: fixture.source,
        fragments: [
          {
            pageNumber: 1,
            rect: {
              x: left / 600,
              y: (800 - top) / 800,
              width: (right - left) / 600,
              height: (top - bottom) / 800
            }
          }
        ]
      }
    if (fixture.roundtrip) {
      expect(source.units[0].source).toBe(fixture.source)
      unit.fragments = source.units[0].fragments.map((fragment) => ({ ...fragment }))
    }
    const writer = new PdfTranslationWriter(() => resolve('resources/worker.mjs')),
      request = {
        id: 'native-reading-order',
        data,
        pages: source.pages,
        preserveUnsupported: true,
        units: [unit]
      },
      result = await writer.generateDetailed(request, caller.lease)
    expect(result).not.toBeNull()
    expect(result!.layoutFailures).toEqual([])
    const translated = getDocument({ data: result!.data.slice(), useSystemFonts: true })
    onTestFinished(() => translated.destroy())
    // Treat the whole page as protected, including the verified unchanged unit.
    const preservation = await verifyPdfPreservation(
      original,
      await translated.promise,
      [],
      [],
      [1]
    )
    expect(preservation.pages.flatMap((entry) => entry.failures)).toEqual([])
    expect(preservation.pages[0].pixels!.changedPixels).toBe(0)

    if (fixture.roundtrip) {
      const neighbor = source.units.find((entry) => entry.source.startsWith('Independent'))!
      const changed = [
        { ...unit, translation: 'Synthetic table' },
        { ...neighbor, translation: 'Translated neighboring paragraph.' }
      ]
      const output = await writer.generateDetailed({ ...request, units: changed }, caller.lease)
      expect(output!.layoutFailures).toEqual([
        {
          unitIndex: 0,
          code: 'source-mismatch',
          phase: 'planning',
          pageNumbers: [1],
          fragmentCount: 1
        }
      ])
      const target = getDocument({ data: output!.data.slice(), useSystemFonts: true })
      onTestFinished(() => target.destroy())
      const checked = await verifyPdfPreservation(
        original,
        await target.promise,
        changed,
        output!.layoutFailures,
        [1]
      )
      expect(checked.pages.flatMap((entry) => entry.failures)).toEqual([])
      expect(checked.pages[0].pixels!.retainedChangedPixels).toBe(0)
      const content = await (await (await target.promise).getPage(1)).getTextContent()
      expect(
        content.items
          .filter((item) => 'str' in item)
          .map((item) => item.str)
          .join(' ')
      ).toContain('Translated neighboring paragraph.')
      await expect(
        writer.generateDetailed(
          { ...request, preserveUnsupported: false, units: changed },
          caller.lease
        )
      ).rejects.toMatchObject({ failure: { code: 'source-mismatch' } })
    }

    // Identical character bags, substitutions and omissions are not source proofs.
    for (const source of [
      fixture.source + 'Q',
      fixture.source.slice(1),
      fixture.source.split('').reverse().join('')
    ]) {
      await expect(
        writer.generateDetailed(
          { ...request, units: [{ ...unit, source, translation: source }] },
          caller.lease
        )
      ).rejects.toMatchObject({ failure: { code: 'source-mismatch' } })
    }
  }
)

it.each([false, true])(
  'preserves a native line-end hyphen with duplicated marker: %s',
  async (duplicate) => {
    const pdf = await PDFDocument.create(),
      page = pdf.addPage([360, 200]),
      font = await pdf.embedFont(StandardFonts.Helvetica),
      context = pdf.context,
      origin = 0
    page.setMediaBox(origin, origin, 360, 200)
    const cmap = context.register(
      context.stream(
        '/CIDInit /ProcSet findresource begin 12 dict begin begincmap ' +
          '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def ' +
          '/CMapName /Synthetic def /CMapType 2 def ' +
          '1 begincodespacerange <00> <FF> endcodespacerange ' +
          '1 beginbfchar <41> <0020> endbfchar endcmap ' +
          'CMapName currentdict /CMap defineresource pop end end'
      )
    )
    const empty = context.register(context.stream('0 0 0 0 0 0 d1')),
      marker = context.register(
        context.obj({
          Type: 'Font',
          Subtype: 'Type3',
          Name: 'Soft',
          FontBBox: [0, 0, 0, 0],
          FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
          CharProcs: { soft: empty },
          Encoding: { Type: 'Encoding', Differences: [65, 'soft'] },
          FirstChar: 65,
          LastChar: 65,
          Widths: [0],
          Resources: {},
          ToUnicode: cmap
        })
      )
    page.node.setFontDictionary(PDFName.of('Soft'), marker)
    const key = page.node.newFontDictionary(font.name, font.ref),
      x = origin + 30,
      y = origin + 150,
      bodyX = x + font.widthOfTextAtSize('A-', 12),
      hyphenX = bodyX + font.widthOfTextAtSize('test mechan', 12)
    // The marker precedes the word in paint order but its origin is slightly later.
    // PDFium keeps the logical hyphen while assigning it to that empty object;
    // object/bounded text consequently omits the real line-end hyphen.
    page.node.addContentStream(
      context.register(
        context.stream(
          `BT /${key} 12 Tf 1 0 0 1 ${x} ${y} Tm (A-) Tj ET ` +
            (duplicate
              ? ''
              : `/Span << /ActualText <FEFF00AD> >> BDC BT /Soft 12 Tf 1 0 0 1 ${bodyX + 0.125} ${y} Tm <41> Tj ET EMC `) +
            `BT /${key} 12 Tf 1 0 0 1 ${bodyX} ${y} Tm (test mechan) Tj ET ` +
            `BT /${key} 12 Tf 1 0 0 1 ${hyphenX} ${y} Tm (-) Tj ET ` +
            (duplicate
              ? `/Span << /ActualText <FEFF00AD> >> BDC BT /Soft 12 Tf 1 0 0 1 ${hyphenX + 3} ${y} Tm <41> Tj ET EMC `
              : '') +
            `BT /${key} 12 Tf 1 0 0 1 ${x} ${y - 16} Tm (ism continues.) Tj ET ` +
            `BT /${key} 12 Tf 1 0 0 1 ${x} ${y - 70} Tm (Independent neighboring paragraph.) Tj ET`
        )
      )
    )
    const data = await pdf.save(),
      loading = getDocument({ data: data.slice(), useSystemFonts: true }),
      registry = new TestCallerRegistry(),
      caller = registry.acquire({ leaseId: 'native-hyphen' })
    onTestFinished(() => loading.destroy())
    onTestFinished(() => registry.dispose())
    const original = await loading.promise,
      { source } = await extractPdfTranslationSource({
        document: original,
        resourceRequestKey: 'native-hyphen',
        signal: caller.lease.signal
      }),
      extracted = source.units.find((entry) => entry.source.includes('mechan'))!,
      unit = {
        ...extracted,
        source: duplicate ? extracted.source.replace('mechan-ism', 'mechanism') : extracted.source
      },
      neighbor = source.units.find((entry) => entry.source.startsWith('Independent'))!,
      writer = new PdfTranslationWriter(() => resolve('resources/worker.mjs')),
      request = {
        id: 'native-hyphen',
        data,
        pages: source.pages,
        preserveUnsupported: true,
        units: [{ ...unit, translation: unit.source }]
      }
    expect(unit.source.replace(/\s/gu, '')).toBe(
      duplicate ? 'A-testmechanismcontinues.' : 'A-testmechan-ismcontinues.'
    )
    const unchanged = await writer.generateDetailed(request, caller.lease)
    expect(unchanged!.data).toEqual(data)
    expect(unchanged!.layoutFailures).toEqual([])
    const changed = [
      { ...unit, translation: 'Translated first paragraph.' },
      { ...neighbor, translation: 'Translated neighboring paragraph.' }
    ]
    const output = await writer.generateDetailed({ ...request, units: changed }, caller.lease)
    expect(output!.layoutFailures).toEqual([
      expect.objectContaining({ unitIndex: 0, phase: 'planning' })
    ])
    const translated = getDocument({ data: output!.data.slice(), useSystemFonts: true })
    onTestFinished(() => translated.destroy())
    const target = await translated.promise
    const preservation = await verifyPdfPreservation(
      original,
      target,
      changed,
      output!.layoutFailures,
      [1]
    )
    expect(preservation.pages.flatMap((entry) => entry.failures)).toEqual([])
    expect(preservation.pages[0].pixels!.retainedChangedPixels).toBe(0)
    const content = await (await target.getPage(1)).getTextContent()
    expect(content.items.flatMap((item) => ('str' in item ? [item.str] : [])).join(' ')).toContain(
      'Translated neighboring paragraph.'
    )
    for (const value of [
      unit.source.replace('mechan', 'broken'),
      unit.source.replace('-', '−'),
      unit.source + 'X'
    ]) {
      await expect(
        writer.generateDetailed(
          { ...request, units: [{ ...unit, source: value, translation: value }] },
          caller.lease
        )
      ).rejects.toMatchObject({ failure: { code: 'source-mismatch' } })
    }
    await expect(
      writer.generateDetailed(
        {
          ...request,
          units: [
            {
              ...unit,
              translation: unit.source,
              fragments: unit.fragments.map((fragment) => ({
                ...fragment,
                rect: { ...fragment.rect, x: fragment.rect.x + 0.1 }
              }))
            }
          ]
        },
        caller.lease
      )
    ).rejects.toMatchObject({ failure: { code: 'source-mismatch' } })
  }
)
