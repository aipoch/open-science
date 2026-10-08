import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { PDFDict, PDFDocument, PDFName, PDFString, StandardFonts } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { PdfTranslationWriter } from './writer'
import { ApplicationCallerLeaseRegistry } from '../../caller-lifecycle'

// No paper content or font is embedded: this Type3 glyph has zero advance and
// an explicit empty outline. A nonzero MediaBox origin makes PDFium expose the
// empty fallback caret as the same native point, matching the publisher case.
const origin = 1_000_000
async function fixture(kind: string): Promise<Uint8Array> {
  const zeroWidth = kind.startsWith('zero-width-')
  if (zeroWidth) kind = kind.slice('zero-width-'.length)
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica),
    marker = await pdf.embedFont(StandardFonts.Courier),
    page = pdf.addPage([300, 200]),
    prefix = kind === 'internal' ? 'Self' : 'BREAST-',
    x = origin + 40 + font.widthOfTextAtSize(prefix, 10),
    zero = !['painted', 'unknown-control', 'advance'].includes(kind),
    unicode = kind === 'unknown-control' ? '0002' : zeroWidth ? '200B' : '00AD',
    code = zero || kind === 'painted' || kind === 'unknown-control' ? '41' : '20',
    cmap = pdf.context.register(
      pdf.context.stream(
        [
          '/CIDInit /ProcSet findresource begin',
          '12 dict begin',
          'begincmap',
          '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
          '/CMapName /DiscretionaryMap def',
          '/CMapType 2 def',
          '1 begincodespacerange',
          '<00> <FF>',
          'endcodespacerange',
          '1 beginbfchar',
          `<${code}> <${unicode}>`,
          'endbfchar',
          'endcmap',
          'CMapName currentdict /CMap defineresource pop',
          'end',
          'end'
        ].join('\n')
      )
    )
  page.setMediaBox(origin, origin, 300, 200)
  page.drawText(prefix, { font, x: origin + 40, y: origin + 150, size: 10 })
  if (zero) {
    const empty = pdf.context.register(pdf.context.stream('0 0 0 0 0 0 d1')),
      ref = pdf.context.register(
        pdf.context.obj({
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
    page.node.setFontDictionary(PDFName.of('Soft'), ref)
    page.node.addContentStream(
      pdf.context.register(
        pdf.context.stream(`BT /Soft 10 Tf 1 0 0 1 ${x} ${origin + 150} Tm <41> Tj ET`)
      )
    )
  } else {
    page.drawText(kind === 'advance' ? ' ' : 'A', { font: marker, x, y: origin + 150, size: 10 })
    await pdf.flush()
    pdf.context.lookup(marker.ref, PDFDict).set(PDFName.of('ToUnicode'), cmap)
  }
  page.drawText(kind === 'internal' ? 'efficacy: CBI-B' : 'Q (before treatment)', {
    font,
    x: kind === 'positioning-space' ? x + 6 : x,
    y: origin + 150,
    size: 10
  })
  page.drawText('Neighbor 17', { font, x: origin + 40, y: origin + 110, size: 10 })
  return pdf.save()
}

it.each([
  'duplicate',
  'internal',
  'unchanged',
  'painted',
  'advance',
  'unknown-control',
  'changed-word',
  'changed-number',
  'math-minus',
  'zero-width-duplicate',
  'zero-width-internal',
  'zero-width-positioning-space',
  'zero-width-unchanged',
  'zero-width-painted',
  'zero-width-advance',
  'zero-width-unknown-control',
  'zero-width-changed-word',
  'zero-width-changed-number',
  'zero-width-math-minus'
])('matches only the independently proven zero-ink native marker: %s', async (kind) => {
  const data = await fixture(kind)
  if (kind.startsWith('zero-width-')) kind = kind.slice('zero-width-'.length)
  const registry = new ApplicationCallerLeaseRegistry(),
    caller = registry.acquire({ leaseId: 'discretionary-hyphens', surface: 'electron' }),
    writer = new PdfTranslationWriter(() => resolve('resources/pdf-translation/worker.mjs')),
    source =
      kind === 'internal'
        ? 'Selfefficacy: CBI-B'
        : kind === 'changed-word'
          ? 'BREAST-Q (after treatment)'
          : kind === 'changed-number'
            ? 'BREAST-2 (before treatment)'
            : kind === 'math-minus'
              ? 'BREAST−Q (before treatment)'
              : 'BREAST-Q (before treatment)',
    accepted = ['duplicate', 'internal', 'unchanged', 'positioning-space'].includes(kind),
    translation = kind === 'unchanged' ? source : '术前满意度：BREAST-Q'
  let task: ReturnType<typeof getDocument> | undefined
  try {
    const output = writer.generate(
      {
        id: 'discretionary-hyphens',
        data,
        pages: [{ width: 300, height: 200 }],
        units: [
          {
            source,
            translation,
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 39 / 300, y: 40 / 200, width: 210 / 300, height: 25 / 200 }
              }
            ]
          }
        ]
      },
      caller.lease
    )
    if (!accepted) {
      await expect(output).rejects.toMatchObject({ failure: { code: 'source-mismatch' } })
      return
    }
    const bytes = (await output)!
    if (kind === 'unchanged') {
      expect(bytes).toEqual(data)
      return
    }
    task = getDocument({ data: bytes, useSystemFonts: true })
    const items = (await (await (await task.promise).getPage(1)).getTextContent()).items.filter(
      (i) => 'str' in i
    )
    expect(
      items
        .filter((i) => i.transform[5] > origin + 125)
        .map((i) => i.str)
        .join('')
        .replace(/\s/gu, '')
    ).toBe(translation)
    expect(items.find((i) => i.str === 'Neighbor 17')?.transform.slice(4)).toEqual([
      origin + 40,
      origin + 110
    ])
    expect(items.some((i) => /[\u00ad\u200b]/u.test(i.str))).toBe(false)
  } finally {
    await task?.destroy()
    caller.release()
    registry.dispose()
  }
})

it.each(
  [
    'figure',
    'table',
    'changed-target-number',
    'changed-source-word',
    'changed-source-spacing'
  ].flatMap((kind) => ['00A0', '202F'].map((space) => [kind, space]))
)(
  'requires exact native ownership when admitting nonbreaking space in a reference: %s / %s',
  async (kind, space) => {
    const word = kind === 'table' ? 'table' : 'figure',
      pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica),
      spacer = await pdf.embedFont(StandardFonts.Courier),
      page = pdf.addPage([300, 200]),
      left = 40 + font.widthOfTextAtSize('See (', 10),
      spaceX = left + font.widthOfTextAtSize(word, 10),
      digitX = spaceX + spacer.widthOfTextAtSize(' ', 10),
      right = digitX + font.widthOfTextAtSize('1', 10),
      uri = 'https://example.org/reference/1',
      registry = new ApplicationCallerLeaseRegistry(),
      caller = registry.acquire({ leaseId: 'nbsp-reference', surface: 'electron' })
    page.drawText('See (', { font, x: 40, y: 150, size: 10 })
    page.drawText(word, { font, x: left, y: 150, size: 10 })
    page.drawText(' ', { font: spacer, x: spaceX, y: 150, size: 10 })
    page.drawText('1', { font, x: digitX, y: 150, size: 10 })
    page.drawText(').', { font, x: right, y: 150, size: 10 })
    page.drawText('Neighbor 17', { font, x: 40, y: 110, size: 10 })
    await pdf.flush()
    pdf.context
      .lookup(spacer.ref, PDFDict)
      .set(
        PDFName.of('ToUnicode'),
        pdf.context.register(
          pdf.context.stream(
            [
              '/CIDInit /ProcSet findresource begin',
              '12 dict begin',
              'begincmap',
              '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
              '/CMapName /NativeSpaceMap def',
              '/CMapType 2 def',
              '1 begincodespacerange',
              '<00> <FF>',
              'endcodespacerange',
              '1 beginbfchar',
              `<20> <${space}>`,
              'endbfchar',
              'endcmap',
              'CMapName currentdict /CMap defineresource pop',
              'end',
              'end'
            ].join('\n')
          )
        )
      )
    page.node.set(
      PDFName.of('Annots'),
      pdf.context.obj([
        pdf.context.register(
          pdf.context.obj({
            Type: 'Annot',
            Subtype: 'Link',
            Rect: [left, 148, right, 158],
            Border: [0, 0, 0],
            A: { S: 'URI', URI: PDFString.of(uri) }
          })
        )
      ])
    )
    const source =
        kind === 'changed-source-word'
          ? 'See (figura 1).'
          : kind === 'changed-source-spacing'
            ? `See (${word}  1).`
            : `See (${word} 1).`,
      translation =
        kind === 'changed-target-number'
          ? '参见（图2）。'
          : `参见（${word === 'table' ? '表' : '图'}1）。`,
      accepted = ['figure', 'table'].includes(kind),
      writer = new PdfTranslationWriter(() => resolve('resources/pdf-translation/worker.mjs'))
    let task: ReturnType<typeof getDocument> | undefined
    try {
      const output = writer.generate(
        {
          id: 'nbsp-reference',
          data: await pdf.save(),
          pages: [{ width: 300, height: 200 }],
          units: [
            {
              source,
              translation,
              fragments: [
                {
                  pageNumber: 1,
                  rect: { x: 39 / 300, y: 40 / 200, width: 210 / 300, height: 25 / 200 }
                }
              ]
            }
          ]
        },
        caller.lease
      )
      if (!accepted) {
        await expect(output).rejects.toMatchObject({ failure: { code: 'annotations' } })
        return
      }
      task = getDocument({ data: (await output)!, useSystemFonts: true })
      const movedPage = await (await task.promise).getPage(1),
        items = (await movedPage.getTextContent()).items.filter((i) => 'str' in i),
        links = await movedPage.getAnnotations()
      expect(
        items
          .filter((i) => i.transform[5] > 125)
          .map((i) => i.str)
          .join('')
          .replace(/\s/gu, '')
      ).toBe(translation)
      expect(items.find((i) => i.str === 'Neighbor 17')?.transform.slice(4)).toEqual([40, 110])
      expect(links).toHaveLength(1)
      expect(links[0].unsafeUrl).toBe(uri)
      expect(links[0].rect[2] - links[0].rect[0]).toBeCloseTo(right - left, 2)
      expect(links[0].rect[3] - links[0].rect[1]).toBeCloseTo(10, 2)
    } finally {
      await task?.destroy()
      caller.release()
      registry.dispose()
    }
  }
)
