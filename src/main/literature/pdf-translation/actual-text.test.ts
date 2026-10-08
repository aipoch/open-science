import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import {
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFString,
  PDFOperator,
  PDFOperatorNames,
  StandardFonts,
  clip,
  endPath,
  rectangle
} from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { PdfTranslationWriter } from './writer'
import { ApplicationCallerLeaseRegistry } from '../../caller-lifecycle'

it.each([
  'case',
  'kerned',
  'ascii-mark',
  'semantic-change',
  'missing-mark',
  'wrong-case',
  'clip',
  'extra-owned',
  'changed-glyph',
  'extra-param',
  'missing-items'
])('uses explicit ActualText case metadata only with unchanged native ink: %s', async (kind) => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica),
    page = pdf.addPage([300, 200]),
    registry = new ApplicationCallerLeaseRegistry(),
    caller = registry.acquire({ leaseId: 'actual-text', surface: 'electron' }),
    semantic = kind === 'semantic-change' ? 'method' : 'arch'
  page.drawText('', { font, x: 40, y: 150, size: 10 })
  if (kind === 'clip') page.pushOperators(rectangle(44, 140, 80, 22), clip(), endPath())
  if (kind !== 'missing-mark')
    page.pushOperators(
      PDFOperator.of(PDFOperatorNames.BeginMarkedContentSequence, [
        PDFName.of('Span'),
        // @ts-expect-error BDC accepts an inline property dictionary; pdf-lib types omit it.
        pdf.context.obj({
          ActualText:
            kind === 'ascii-mark' ? PDFString.of(semantic) : PDFHexString.fromText(semantic),
          ...(kind === 'extra-param' ? { Other: PDFName.of('Value') } : {})
        })
      ])
    )
  if (kind === 'kerned') {
    const key = page.node.newFontDictionary(font.name, font.ref)
    page.pushOperators(
      PDFOperator.of(PDFOperatorNames.BeginText),
      PDFOperator.of(PDFOperatorNames.SetFontAndSize, [key, PDFNumber.of(10)]),
      PDFOperator.of(PDFOperatorNames.SetTextMatrix, [1, 0, 0, 1, 40, 150].map(PDFNumber.of)),
      PDFOperator.of(PDFOperatorNames.ShowTextAdjusted, [
        pdf.context.obj([font.encodeText('AR'), 18, font.encodeText('CH')])
      ]),
      PDFOperator.of(PDFOperatorNames.EndText)
    )
  } else
    page.drawText(kind === 'changed-glyph' ? 'ARCK' : 'ARCH', { font, x: 40, y: 150, size: 10 })
  if (kind !== 'missing-mark') page.pushOperators(PDFOperator.of(PDFOperatorNames.EndMarkedContent))
  if (kind === 'extra-owned') page.drawText('OTHER', { font, x: 90, y: 150, size: 10 })
  page.drawText('Neighbor', { font, x: 40, y: 112, size: 10 })
  const data = await pdf.save(),
    original = data.slice(),
    source = kind === 'wrong-case' || kind === 'missing-mark' ? 'Arch' : 'ARCH',
    writer = new PdfTranslationWriter(() => resolve('resources/pdf-translation/worker.mjs'))
  let task: ReturnType<typeof getDocument> | undefined
  try {
    const output = writer.generate(
      {
        id: 'actual-text',
        data,
        pages: [{ width: 300, height: 200 }],
        units: [
          {
            source,
            translation: '研究',
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 39 / 300, y: 38 / 200, width: 100 / 300, height: 15 / 200 },
                ...(kind === 'missing-items' ? {} : { items: [{ index: 0, text: source }] })
              }
            ]
          }
        ]
      },
      caller.lease
    )
    if (!['case', 'kerned', 'ascii-mark'].includes(kind)) {
      await expect(output).rejects.toMatchObject({ failure: { code: expect.any(String) } })
    } else {
      task = getDocument({ data: (await output)!, useSystemFonts: true })
      const items = (await (await task.promise).getPage(1)).getTextContent()
      const text = (await items).items.filter((item) => 'str' in item)
      expect(text.map((item) => item.str).join('')).toBe('研究Neighbor')
      expect(text.find((item) => item.str === 'Neighbor')?.transform.slice(4)).toEqual([40, 112])
    }
    expect(data).toEqual(original)
  } finally {
    await task?.destroy()
    caller.release()
    registry.dispose()
  }
})
