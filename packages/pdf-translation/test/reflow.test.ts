import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { expect, it } from 'vitest'
import { PdfTranslationWriter } from '../src/writer.js'
import type { PdfTranslationPdfRequest } from '../src/contracts.js'
import { TestCallerRegistry } from './support/callers.js'
import { resolve } from './paths.js'

const fragment = (
  pageNumber: number,
  y: number
): PdfTranslationPdfRequest['units'][number]['fragments'][number] => ({
  pageNumber,
  rect: { x: 0.1, y, width: 0.8, height: 0.05 }
})

it('paginates all translated text while retaining a figure inside a page Form', async () => {
  const original = await PDFDocument.create()
  const font = await original.embedFont(StandardFonts.Helvetica)
  const page = original.addPage([400, 500])
  page.drawText('Original body.', { font, size: 12, x: 40, y: 440 })
  page.drawRectangle({ x: 40, y: 260, width: 120, height: 90, color: rgb(0.1, 0.5, 0.8) })
  page.drawRectangle({ x: 180, y: 260, width: 160, height: 90, color: rgb(0.2, 0.7, 0.4) })
  page.drawText('Figure label', { font, size: 12, x: 50, y: 290 })
  page.drawText('Failed original paragraph.', { font, size: 12, x: 40, y: 160 })
  const wrapped = await PDFDocument.create()
  const embedded = await wrapped.embedPage(page)
  wrapped.addPage([400, 500]).drawPage(embedded)
  const translation =
    '完整的学术译文应当换行并在空间不足时继续分页，不能被原来的文本框截断。'.repeat(130) +
    '• · End.'
  const writer = new PdfTranslationWriter(() => resolve('resources/worker.mjs'))
  const caller = new TestCallerRegistry().acquire({ leaseId: 'reflow', surface: 'electron' })
  let task: ReturnType<typeof getDocument> | undefined
  try {
    const output = await writer.generateDetailed(
      {
        id: 'reflow',
        layout: 'reflow',
        data: await wrapped.save(),
        pages: [{ width: 400, height: 500 }],
        units: [
          { source: 'Original body.', translation, fragments: [fragment(1, 0.08)] },
          { source: 'Figure label', translation: '图中标签', fragments: [fragment(1, 0.38)] },
          {
            source: 'Failed original paragraph.',
            translation: 'Failed original paragraph.',
            fragments: [fragment(1, 0.65)]
          }
        ]
      },
      caller.lease
    )
    expect(output?.layoutFailures).toEqual([])
    expect(output!.reflow!.sourcePageNumbers.length).toBeGreaterThan(1)
    expect(new Set(output!.reflow!.sourcePageNumbers)).toEqual(new Set([1]))
    const placements = output!.reflow!.units.find((u) => u.unitIndex === 0)!
    expect(placements.fragments.length).toBeGreaterThan(1)
    expect(
      placements.fragments
        .map((f) => f.text)
        .join('')
        .replace(/\s/gu, '')
    ).toBe(translation.replace(/\s/gu, ''))
    expect(output!.reflow!.units.some((u) => u.unitIndex === 2)).toBe(true)
    task = getDocument({ data: output!.data.slice() })
    const pdf = await task.promise
    let text = '',
      figures = 0
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n)
      const content = await page.getTextContent()
      text += content.items.map((i) => ('str' in i ? i.str : '')).join('')
      const operators = await page.getOperatorList()
      figures += operators.fnArray.filter((fn) => fn === OPS.paintImageXObject).length
      page.cleanup()
    }
    expect(text.replace(/\s/gu, '')).toContain(translation.replace(/\s/gu, ''))
    expect(text).not.toContain('Original body.')
    expect(figures).toBe(2) // one complete two-part figure, one failed paragraph crop
  } finally {
    await task?.destroy()
    caller.release()
  }
})

it('retains every source fragment when an unsupported glyph spans two source pages', async () => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica)
  for (const label of ['First original.', 'Second original.'])
    pdf.addPage([400, 500]).drawText(label, { font, size: 12, x: 40, y: 440 })
  const writer = new PdfTranslationWriter(() => resolve('resources/worker.mjs'))
  const caller = new TestCallerRegistry().acquire({ leaseId: 'glyphs', surface: 'electron' })
  try {
    const output = await writer.generateDetailed(
      {
        id: 'glyphs',
        layout: 'reflow',
        data: await pdf.save(),
        pages: [
          { width: 400, height: 500 },
          { width: 400, height: 500 }
        ],
        units: [
          {
            source: 'First original. Second original.',
            translation: '译文\u{1FAE0}',
            fragments: [fragment(1, 0.08), fragment(2, 0.08)]
          }
        ]
      },
      caller.lease
    )
    expect(output!.layoutFailures).toEqual([
      expect.objectContaining({ unitIndex: 0, code: 'font' })
    ])
    expect(output!.reflow!.units[0].fragments).toHaveLength(2)
    expect(output!.reflow!.sourcePageNumbers).toEqual([1])
    expect(output!.reflow!.sourcePages).toEqual([[1, 2]])
    expect(output!.reflow!.units[0].fragments.map((fragment) => fragment.pageNumber)).toEqual([
      1, 1
    ])
  } finally {
    caller.release()
  }
})
