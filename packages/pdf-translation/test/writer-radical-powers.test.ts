import { pathToFileURL } from 'node:url'
import { PDFDict, PDFDocument, PDFName, StandardFonts, rgb } from 'pdf-lib'
import { expect, it } from 'vitest'
import { PdfTranslationWriter } from '../src/writer.js'
import { resolve } from './paths.js'
import { TestCallerRegistry } from './support/callers.js'

const { engine } = await import(pathToFileURL(resolve('resources/pdfium.mjs')).href)
type NativeObject = { type: number; text?: string; bounds: number[] }
const formula = ['√', 'path', 'x', '2', '−', 'y', '2']

async function readInk(data: Uint8Array): Promise<{
  labels: (string | undefined)[]
  group: number[][]
}> {
  const native = await engine(),
    document = native.open(data),
    page = native.p.FPDF_LoadPage(document.doc, 0)
  try {
    const objects: NativeObject[] = native.objects(page),
      labels = objects.map(({ type, text }) => (type === 2 ? 'path' : text?.trim())),
      start = labels.findIndex((label) => label === '√')
    expect(labels.slice(start, start + formula.length)).toEqual(formula)
    return {
      labels,
      group: objects.slice(start, start + formula.length).map(({ bounds }) => bounds)
    }
  } finally {
    native.p.FPDF_ClosePage(page)
    document.close()
  }
}

it.each(['retained', 'changed'])(
  'moves a complete native radical only when both powers survive translation (%s)',
  async (target) => {
    const pdf = await PDFDocument.create(),
      prose = await pdf.embedFont(StandardFonts.TimesRoman),
      letters = await pdf.embedFont(StandardFonts.TimesRomanItalic),
      powers = await pdf.embedFont(StandardFonts.TimesRoman),
      root = await pdf.embedFont(StandardFonts.Symbol),
      minus = await pdf.embedFont(StandardFonts.Symbol),
      page = pdf.addPage([320, 160])
    page.drawText('The value ', { font: prose, size: 10, x: 40, y: 100 })
    page.drawText('√', { font: root, size: 10, x: 94, y: 100 })
    page.drawLine({
      start: { x: 100, y: 108.8 },
      end: { x: 130, y: 108.8 },
      thickness: 0.4,
      color: rgb(0, 0, 0)
    })
    page.drawText('x', { font: letters, size: 10, x: 100, y: 100 })
    page.drawText('2', { font: powers, size: 7, x: 106, y: 103 })
    page.drawText('−', { font: minus, size: 10, x: 111, y: 100 })
    page.drawText('y', { font: letters, size: 10, x: 120, y: 100 })
    page.drawText('2', { font: powers, size: 7, x: 126, y: 103 })
    page.drawText(' is finite.', { font: prose, size: 10, x: 132, y: 100 })
    page.drawText('The sample is stable.', { font: prose, size: 10, x: 40, y: 60 })
    await pdf.flush()
    for (const [font, name] of [
      [letters, 'CMMI10'],
      [powers, 'CMR7'],
      [minus, 'CMSY10']
    ] as const)
      pdf.context.lookup(font.ref, PDFDict).set(PDFName.of('BaseFont'), PDFName.of(name))
    pdf.context
      .lookup(minus.ref, PDFDict)
      .set(
        PDFName.of('ToUnicode'),
        pdf.context.register(
          pdf.context.stream(
            '/CIDInit /ProcSet findresource begin 12 dict begin begincmap ' +
              '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def ' +
              '/CMapName /Signs def /CMapType 2 def 1 begincodespacerange <00> <FF> endcodespacerange ' +
              '1 beginbfchar <2D> <2212> endbfchar endcmap CMapName currentdict /CMap defineresource pop end end'
          )
        )
      )
    const data = await pdf.save(),
      original = await readInk(data),
      callers = new TestCallerRegistry(),
      caller = callers.acquire({ leaseId: 'radical-powers' }),
      writer = new PdfTranslationWriter(() => resolve('resources/worker.mjs'))
    try {
      const unchangedFormula = target === 'retained',
        output = await writer.generateDetailed(
          {
            id: 'radical-powers',
            data,
            preserveUnsupported: true,
            pages: [{ width: 320, height: 160 }],
            units: [
              {
                source: 'The value √x2 − y2 is finite.',
                translation: `对于这个模型，总体的数值 √x2 − y${unchangedFormula ? '2' : '3'} 是有限的。`,
                fragments: [
                  {
                    pageNumber: 1,
                    rect: { x: 39 / 320, y: 40 / 160, width: 245 / 320, height: 27 / 160 }
                  }
                ]
              },
              {
                source: 'The sample is stable.',
                translation: '样本是稳定的。',
                fragments: [
                  {
                    pageNumber: 1,
                    rect: { x: 39 / 320, y: 89 / 160, width: 245 / 320, height: 14 / 160 }
                  }
                ]
              }
            ]
          },
          caller.lease
        )
      expect(output!.layoutFailures).toEqual(
        unchangedFormula
          ? []
          : [
              {
                unitIndex: 0,
                code: 'unsupported-layout',
                phase: 'planning',
                pageNumbers: [1],
                fragmentCount: 1
              }
            ]
      )
      const written = await readInk(output!.data)
      expect(written.labels).toContain('样本是稳定的。')
      if (unchangedFormula) {
        const [x, y] = written.group[0].map((value, axis) => value - original.group[0][axis])
        expect(Math.hypot(x, y)).toBeGreaterThan(1)
        expect(written.labels.join('')).toContain('总体的数值')
        for (const [index, bounds] of original.group.entries()) {
          const [left, bottom, right, top] = bounds
          for (const [axis, value] of [left + x, bottom + y, right + x, top + y].entries())
            expect(written.group[index][axis]).toBeCloseTo(value, 3)
        }
      } else {
        expect(written.group).toEqual(original.group)
        expect(written.labels).toContain('The value')
      }
    } finally {
      caller.release()
      callers.dispose()
    }
  }
)
