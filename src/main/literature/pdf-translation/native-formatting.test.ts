import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { PDFDict, PDFDocument, PDFName, StandardFonts } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { PdfTranslationWriter } from './writer'
import { ApplicationCallerLeaseRegistry } from '../../caller-lifecycle'

it.each([
  'no-marker',
  'painted',
  'nonzero-character-box',
  'merged-letter',
  'unknown-control',
  'too-many'
])('requires complete native nonpainting proof for formatting objects: %s', async (kind) => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica),
    marker = await pdf.embedFont(StandardFonts.TimesRoman),
    page = pdf.addPage([600, 800]),
    registry = new ApplicationCallerLeaseRegistry(),
    caller = registry.acquire({ leaseId: 'native-formatting', surface: 'electron' })
  page.drawText('Measured value is available.', { font, size: 12, x: 40, y: 700 })
  page.drawText('Neighbor 17', { font, size: 12, x: 40, y: 650 })
  if (kind !== 'no-marker') {
    const text = kind === 'nonzero-character-box' ? '  ' : kind === 'too-many' ? 'AAAAAAAAA' : 'AA'
    page.drawText(text, { font: marker, size: 12, x: 220, y: 700 })
    await pdf.flush()
    const dict = pdf.context.lookup(marker.ref, PDFDict)
    dict.set(
      PDFName.of('ToUnicode'),
      pdf.context.register(
        pdf.context.stream(
          '/CIDInit /ProcSet findresource begin 12 dict begin begincmap ' +
            '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def ' +
            '/CMapName /FormattingMap def /CMapType 2 def ' +
            '1 begincodespacerange <00> <FF> endcodespacerange ' +
            '1 beginbfchar <' +
            (kind === 'nonzero-character-box' ? '20' : '41') +
            '> <' +
            (kind === 'unknown-control' ? '200D' : '200C') +
            '> endbfchar endcmap CMapName currentdict /CMap defineresource pop end end'
        )
      )
    )
    if (kind === 'merged-letter') page.drawText('B', { font: marker, size: 12, x: 235, y: 700 })
  }
  try {
    const request = new PdfTranslationWriter(() =>
      resolve('resources/pdf-translation/worker.mjs')
    ).generate(
      {
        id: 'formatting-control',
        data: await pdf.save(),
        pages: [{ width: 600, height: 800 }],
        units: [
          {
            source: 'Measured value is available.',
            translation: '测量值已提供。',
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 38 / 600, y: 84 / 800, width: 320 / 600, height: 24 / 800 }
              }
            ]
          }
        ]
      },
      caller.lease
    )
    if (kind !== 'no-marker') {
      await expect(request).rejects.toMatchObject({ failure: { code: 'source-mismatch' } })
      return
    }
    const output = await request,
      task = getDocument({ data: output!.slice() })
    try {
      const document = await task.promise,
        items = (await (await document.getPage(1)).getTextContent()).items,
        text = items.flatMap((item) => ('str' in item ? [item.str] : [])).join('')
      expect(text).toContain('测量值已提供。')
      expect(text).toContain('Neighbor 17')
    } finally {
      await task.destroy()
    }
  } finally {
    caller.release()
  }
})
