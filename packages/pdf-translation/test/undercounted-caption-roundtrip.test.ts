import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { PdfTranslationWriter } from '../src/writer.js'
import { resolve } from './paths.js'
import { TestCallerRegistry } from './support/callers.js'
import { expect, it, onTestFinished } from 'vitest'

it.each(['two exact native caption rows', 'foreign paint', 'mismatched source row'])(
  'only claims a clipped caption with two proven complete rows (%s)',
  async (mode) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.TimesRomanBold),
      page = pdf.addPage([600, 800]),
      translation = '图 7. 两次独立测量的结果表明，在组别之间重复观测的差异符合预期。',
      rows = [
        ['Fig. 7. Repeated drops for group P: ', 'group P had nearly identical drops,'],
        ['b – repeated drops for group P: ', 'group P had nearly identical drops.']
      ],
      size = 10,
      x = 120,
      right = 405,
      y = 680
    for (const [index, [prefix, tail]] of rows.entries()) {
      page.drawText(prefix, { font, size, x: x + index * 2, y: y - index * 12 })
      page.drawText(tail, {
        font,
        size,
        x: x + index * 2 + font.widthOfTextAtSize(prefix, size),
        y: y - index * 12
      })
    }
    if (mode === 'foreign paint') {
      page.drawRectangle({ x: right + 2, y: y + 4, width: 1, height: 1, color: rgb(1, 0, 0) })
    }
    const legend = 'Legend: open circle indicates a separate measurement.'
    page.drawText(legend, { font, size, x: 145, y: y - 27 })
    const registry = new TestCallerRegistry()
    onTestFinished(() => registry.dispose())
    const { lease } = registry.acquire({ leaseId: 'caption-roundtrip' })
    const data = await pdf.save()
    const adjustedRows =
      mode === 'mismatched source row'
        ? [rows[0].join(''), rows[1].join('').replace('identical', 'similar')]
        : rows.map((row) => row.join(''))
    const writer = new PdfTranslationWriter(() => resolve('resources/worker.mjs'))
    const output = await writer.generateDetailed(
      {
        id: 'undercounted-caption',
        data,
        pages: [{ width: 600, height: 800 }],
        preserveUnsupported: true,
        preserveUnmatched: true,
        units: [
          {
            source: adjustedRows.join(' '),
            translation,
            fragments: [
              {
                pageNumber: 1,
                rect: {
                  x: x / 600,
                  y: (800 - (y + 9)) / 800,
                  width: (right - x) / 600,
                  height: 24 / 800
                },
                items: adjustedRows.map((text, index) => ({ index, text }))
              }
            ]
          }
        ]
      },
      lease
    )
    if (mode !== 'two exact native caption rows') {
      expect(output!.layoutFailures).toHaveLength(1)
      expect(output!.data).toEqual(data)
      return
    }
    expect(output!.layoutFailures).toEqual([])
    const translated = getDocument({ data: output!.data.slice(), useSystemFonts: true })
    onTestFinished(() => translated.destroy())
    const awaited = await translated.promise
    const target = await awaited.getPage(1)
    const text = (await target.getTextContent()).items
      .map((item) => ('str' in item ? item.str : ''))
      .join('')
    expect(text.replace(/\s/gu, '')).toContain(translation.replace(/\s/gu, ''))
    expect(text).toContain(legend)
    expect(text).not.toContain('Repeated drops for group P')
  }
)
