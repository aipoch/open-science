import { expect, it } from 'vitest'
import { PDFDocument, fill, rectangle, rgb, setFillingColor } from 'pdf-lib'
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { extractPdfTranslationSource } from '../../src/reader/extraction.js'
import { preservePdfFigureSources } from '../../src/reader/figure-source.js'

it.each([false, true])('preserves a fully ruled table with wrapped labels (%s)', async (open) => {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([240, 240])
  page.drawText('The instrument reported these measurements.', { x: 22, y: 205, size: 8 })
  for (let col = 0; col < 4; col++) {
    const x = 24 + col * 42
    page.drawText(['Sen', 'Period', 'Offset', 'Limit'][col], { x: x + 3, y: 162, size: 8 })
    if (!col) page.drawText('sor', { x: x + 3, y: 151, size: 8 })
    page.drawText(String(col + 11), { x: x + 3, y: 125, size: 8 })
  }
  page.drawText('These are independent of the earlier calibration.', { x: 22, y: 90, size: 8 })
  page.pushOperators(setFillingColor(rgb(0.1, 0.3, 0.7)))
  for (const [y, height] of [
    [112, 27.5],
    [139, 34]
  ]) {
    for (let col = 0; col < 4; col++) {
      const x = 24 + col * 42
      page.pushOperators(rectangle(x, y + height - 0.5, 42.5, 0.5), fill())
      page.pushOperators(rectangle(x, y, 42.5, 0.5), fill())
      page.pushOperators(rectangle(x, y, 0.5, height), fill())
      if (!open || col !== 3 || y !== 139)
        page.pushOperators(rectangle(x + 42, y, 0.5, height), fill())
    }
  }
  const document = await getDocument({ data: await pdf.save(), useSystemFonts: true }).promise
  try {
    const signal = new AbortController().signal
    const extraction = await extractPdfTranslationSource({
      document,
      signal,
      resourceRequestKey: 'filled-table'
    })
    const { source } = await preservePdfFigureSources({
      document,
      extraction,
      operators: OPS,
      signal,
      skipTranslation: false
    })
    const table = source.units.filter(
      (unit) => unit.fragments[0].rect.y > 0.32 && unit.fragments[0].rect.y < 0.53
    )
    expect(table.length).toBeGreaterThan(1)
    expect(table.every((unit) => unit.sourceOnly && unit.figure)).toBe(!open)
    expect(
      source.units.find((unit) => unit.source.startsWith('The instrument'))?.sourceOnly
    ).toBeUndefined()
    expect(
      source.units.find((unit) => unit.source.startsWith('These are independent'))?.sourceOnly
    ).toBeUndefined()
  } finally {
    await document.destroy()
  }
})
