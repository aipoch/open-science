import { createCanvas } from '@napi-rs/canvas'
import {
  PDFDocument,
  PDFOperator,
  PDFOperatorNames,
  StandardFonts,
  rectangle,
  rgb,
  setFillingColor
} from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { expect, it } from 'vitest'
import { PdfTranslationWriter } from '../src/writer.js'
import { resolve } from './paths.js'
import { TestCallerRegistry } from './support/callers.js'

it('paints generated scripts with the translated rows above native row backgrounds', async () => {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const page = pdf.addPage([612, 792])
  const prose = [
    'The instruments measure the movement of the marker during the first pass.',
    'The team checks the camera before repeating the same measurement sequence.',
    'Other readings are reviewed separately to establish the baseline response.',
    'Each complete sequence produces enough points to compare both instruments.',
    'The final comparison shows stable readings throughout the observed interval.'
  ]
  const measurement = ['The measured values are 1.4m/s', '2', ' and 1.25 m/s', '2', '.']
  const translation =
    '第一轮观测中，仪器记录标记点的移动过程。团队检查相机，再按同样的顺序重复测量。为建立基准响应，其他读数会分开核对。每一轮完整的测量都得到足够多的数据点，可用于比较两台仪器的结果。最终的比较表明，在整个观测时段内，读数一直保持稳定。测得的数值分别为 1.4m/s2 和 1.25 m/s2。'
  for (const row of [...prose.map((text) => [text]), measurement].entries()) {
    const [index, parts] = row
    const y = 700 - index * 14.5
    page.pushOperators(
      setFillingColor(rgb(1, 1, 1)),
      rectangle(39, y - 4, 470, 14),
      PDFOperator.of(PDFOperatorNames.FillEvenOdd)
    )
    let x = 40
    for (const text of parts) {
      const raised = text === '2'
      const size = raised ? 7 : 11
      page.drawText(text, { font, size, x, y: y + (raised ? 4 : 0), color: rgb(0, 0, 0) })
      x += font.widthOfTextAtSize(text, size)
    }
  }
  const caller = new TestCallerRegistry().acquire({ leaseId: 'reader', surface: 'electron' })
  let task: ReturnType<typeof getDocument> | undefined
  try {
    const result = await new PdfTranslationWriter(() =>
      resolve('resources/worker.mjs')
    ).generateDetailed(
      {
        id: 'generated-script-row-backdrops',
        data: await pdf.save(),
        pages: [{ width: 612, height: 792 }],
        preserveUnsupported: true,
        units: [
          {
            source: [...prose, measurement.join('')].join(' '),
            translation,
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 39 / 612, y: 82 / 792, width: 470 / 612, height: 89 / 792 }
              }
            ]
          }
        ]
      },
      caller.lease
    )
    expect(result?.layoutFailures).toEqual([])
    task = getDocument({ data: result!.data })
    const target = await (await task.promise).getPage(1)
    const items = (await target.getTextContent()).items.filter((item) => 'str' in item)
    const rows = items.filter(({ str }) => str.length > 16)
    expect(rows.length).toBeGreaterThan(2)
    expect(items.filter(({ str, height }) => str === '2' && height < 9)).toHaveLength(2)
    const viewport = target.getViewport({ scale: 2 })
    const canvas = createCanvas(viewport.width, viewport.height)
    const context = canvas.getContext('2d')
    await target.render({ canvas: null, canvasContext: context as never, viewport }).promise
    for (const { transform } of rows) {
      const [x, baseline] = viewport.convertToViewportPoint(transform[4], transform[5])
      const rgba = context.getImageData(Math.floor(x), Math.floor(baseline) - 15, 80, 14).data
      expect(rgba.some((value, index) => index % 4 === 0 && value < 100)).toBe(true)
    }
  } finally {
    await task?.destroy()
    caller.release()
  }
})
