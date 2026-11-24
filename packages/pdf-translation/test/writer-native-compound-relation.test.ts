import {
  PDFDocument,
  PDFHexString,
  PDFName,
  StandardFonts,
  beginText,
  endText,
  setFontAndSize,
  setTextMatrix,
  showText
} from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { expect, it } from 'vitest'
import { extractPdfTranslationSource } from '../src/reader/extraction.js'
import { PdfTranslationWriter } from '../src/writer.js'
import { resolve } from './paths.js'
import { TestCallerRegistry } from './support/callers.js'

it('reflows a complete native compound smile relation with its translated prose', async () => {
  // Synthetic Type1C outlines for two letters and the intervening relation.
  const program = Buffer.from(
    'AQAEAQABAQEHQ01NSTEwAAEBARb4HAL4HAOfT/ir+VAFxw+L9z4SzhEAAgEBBgxzbWlsZUNNTUkxMAAAAAAxADIBhwAEAQEEHDtg+NgO+Ni9FvlQ9/IH7yeL+3D7BzsF+4r7wAYO+NjbFmj3Aov4b+D3B/fAi+8ni/yNSkDCOzuLWccFDvjYn/fKFeD7DPcHWfcCi/cMveD3DIsrMib7B1n7B4shuDH1BQ4=',
    'base64'
  )
  const pdf = await PDFDocument.create(),
    page = pdf.addPage([420, 340]),
    body = await pdf.embedFont(StandardFonts.TimesRoman),
    context = pdf.context,
    face = PDFName.of('CMMI10'),
    relation = PDFName.of('Relation')
  page.node.setFontDictionary(
    relation,
    context.register(
      context.obj({
        Type: 'Font',
        Subtype: 'Type1',
        BaseFont: face,
        FirstChar: 32,
        LastChar: 81,
        Widths: Array(50).fill(580),
        Encoding: {
          Type: 'Encoding',
          BaseEncoding: 'WinAnsiEncoding',
          Differences: [65, PDFName.of('smile')]
        },
        FontDescriptor: context.register(
          context.obj({
            Type: 'FontDescriptor',
            FontName: face,
            Flags: 4,
            FontBBox: [0, -60, 580, 700],
            ItalicAngle: 0,
            Ascent: 700,
            Descent: -60,
            CapHeight: 700,
            StemV: 45,
            FontFile3: context.register(context.flateStream(program, { Subtype: 'Type1C' }))
          })
        ),
        ToUnicode: context.register(
          context.flateStream(
            '/CIDInit /ProcSet findresource begin 12 dict begin begincmap ' +
              '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def ' +
              '/CMapName /CompoundRelation def /CMapType 2 def ' +
              '1 begincodespacerange <00> <FF> endcodespacerange ' +
              '4 beginbfchar <20> <0020> <41> <2323> <50> <0050> <51> <0051> endbfchar ' +
              'endcmap CMapName currentdict /CMap defineresource pop end end'
          )
        )
      })
    )
  )
  const prefix = 'In this example the connected graph '
  const suffix = ' retains a single component.'
  const size = 12
  const y = 285
  const x = 40 + body.widthOfTextAtSize(prefix, size)
  page.drawText(prefix, { font: body, size, x: 40, y })
  page.pushOperators(
    beginText(),
    setFontAndSize(relation, size),
    setTextMatrix(1, 0, 0, 1, x, y),
    showText(PDFHexString.of('5020412051')),
    endText()
  )
  page.drawText(suffix, { font: body, size, x: x + 5 * 0.58 * size, y })
  const data = await pdf.save(),
    original = getDocument({ data: data.slice(), fontExtraProperties: true }),
    caller = new TestCallerRegistry().acquire({ leaseId: 'reader', surface: 'electron' })
  let target: ReturnType<typeof getDocument> | undefined
  try {
    const { source } = await extractPdfTranslationSource({
      document: await original.promise,
      resourceRequestKey: 'native-compound-smile',
      signal: caller.lease.signal
    })
    expect(source.units.map((unit) => unit.source)).toEqual([prefix + 'P ⌣ Q' + suffix])
    const translation = '例中图 P ⌣ Q 只有一个连通分量。'
    const result = await new PdfTranslationWriter(() =>
      resolve('resources/worker.mjs')
    ).generateDetailed(
      {
        id: 'native-compound-smile',
        data,
        pages: source.pages,
        preserveUnsupported: true,
        units: [{ ...source.units[0], translation }]
      },
      caller.lease
    )
    expect(result.layoutFailures).toEqual([])
    target = getDocument({ data: result.data.slice(), fontExtraProperties: true })
    const page = await (await target.promise).getPage(1)
    const written = (await page.getTextContent()).items.flatMap((item) =>
      'str' in item ? [item] : []
    )
    expect(
      written
        .map(({ str }) => str)
        .join('')
        .replace(/\s/gu, '')
    ).toBe(translation.replace(/\s/gu, ''))
    const native = written.find(({ str }) => str.includes('⌣'))
    expect(native?.transform[4]).toBeLessThan(x - 30)
  } finally {
    await target?.destroy()
    await original.destroy()
    caller.release()
  }
})
