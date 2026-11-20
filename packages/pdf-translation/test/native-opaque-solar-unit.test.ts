import { expect, it } from 'vitest'
import { PDFDict, PDFDocument, PDFName, StandardFonts } from 'pdf-lib'
import { pathToFileURL } from 'node:url'
import { PdfTranslationWriter } from '../src/writer.js'
import { TestCallerRegistry } from './support/callers.js'
import { resolve } from './paths.js'

const { engine } = await import(pathToFileURL(resolve('resources/pdfium.mjs')).href)
type NativeObject = { text: string; bounds: number[] }

async function nativeInk(data: Uint8Array): Promise<NativeObject[]> {
  const native = await engine(),
    document = native.open(data),
    page = native.p.FPDF_LoadPage(document.doc, 0)
  try {
    return native.objects(page).map(({ text, bounds }: NativeObject) => ({ text, bounds }))
  } finally {
    native.p.FPDF_ClosePage(page)
    document.close()
  }
}

it.each(['adjacent', 'detached'])(
  'keeps a painted solar mark with its native mass symbol when extraction omits the mark: %s',
  async (kind) => {
    const pdf = await PDFDocument.create(),
      prose = await pdf.embedFont(StandardFonts.TimesRoman),
      base = await pdf.embedFont(StandardFonts.Helvetica),
      mark = await pdf.embedFont(StandardFonts.Helvetica),
      page = pdf.addPage([320, 200])
    page.drawText('The measured value was 42 ', { font: prose, x: 40, y: 150, size: 10 })
    page.drawText('M', { font: base, x: 155, y: 150, size: 10 })
    // Simulate a visible circle with the form-feed text mapping of a legacy math font.
    page.drawText('O ', { font: mark, x: kind === 'adjacent' ? 163.3 : 184, y: 148.5, size: 7 })
    page.drawText('Independent neighbor.', { font: prose, x: 40, y: 100, size: 10 })
    await pdf.flush()
    pdf.context.lookup(base.ref, PDFDict).set(PDFName.of('BaseFont'), PDFName.of('CMMI10'))
    const markFont = pdf.context.lookup(mark.ref, PDFDict)
    markFont.set(PDFName.of('BaseFont'), PDFName.of('CMSY7'))
    markFont.set(
      PDFName.of('ToUnicode'),
      pdf.context.register(
        pdf.context.stream(
          '/CIDInit /ProcSet findresource begin 12 dict begin begincmap ' +
            '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def ' +
            '/CMapName /Mark def /CMapType 2 def ' +
            '1 begincodespacerange <00> <FF> endcodespacerange ' +
            '1 beginbfchar <4F> <000C> endbfchar ' +
            'endcmap CMapName currentdict /CMap defineresource pop end end'
        )
      )
    )
    const data = await pdf.save(),
      original = await nativeInk(data),
      registry = new TestCallerRegistry(),
      caller = registry.acquire({ leaseId: 'opaque-solar' }),
      translation = '测量值为 42 M'
    try {
      const result = await new PdfTranslationWriter(() =>
        resolve('resources/worker.mjs')
      ).generateDetailed(
        {
          id: 'opaque-solar',
          data,
          pages: [{ width: 320, height: 200 }],
          preserveUnsupported: true,
          preserveUnmatched: true,
          units: [
            {
              source: 'The measured value was 42 M',
              translation,
              fragments: [
                {
                  pageNumber: 1,
                  rect: { x: 39 / 320, y: 37 / 200, width: 124 / 320, height: 14 / 200 }
                }
              ]
            }
          ]
        },
        caller.lease
      )
      expect(result).toBeDefined()
      const written = await nativeInk(result!.data)
      expect(original[2].text).toMatch(/^\f *$/u)
      expect(written.find((object) => /^\f *$/u.test(object.text))).toEqual(original[2])
      if (kind === 'adjacent') {
        expect(result!.layoutFailures).toEqual([
          {
            unitIndex: 0,
            code: 'unsupported-layout',
            phase: 'planning',
            pageNumbers: [1],
            fragmentCount: 1
          }
        ])
        expect(written).toEqual(original)
      } else {
        expect(result!.layoutFailures).toEqual([])
        expect(written.map(({ text }) => text.trim())).toContain(translation)
      }
    } finally {
      caller.release()
      registry.dispose()
    }
  }
)

it.each(['punctuation', 'compact prose', 'no glyph'])(
  'retains an unencoded solar mark inside a prose region when native ink exists: %s',
  async (kind) => {
    const compact = kind === 'compact prose',
      scale = compact ? 0.8 : 1,
      paintMark = kind !== 'no glyph'
    const pdf = await PDFDocument.create(),
      prose = await pdf.embedFont(StandardFonts.TimesRoman),
      mark = await pdf.embedFont(StandardFonts.Helvetica),
      page = pdf.addPage([320, 200]),
      mass = 'The measured value was 42 M',
      continuation = compact ? 'stars.' : '; the sample was stable.',
      markX = 40 + 149.5 * scale,
      tailX = 40 + (compact ? 159.2 : 156) * scale
    page.drawText(mass, { font: prose, x: 40, y: 150, size: 10 * scale })
    if (paintMark)
      page.drawText(compact ? 'O ' : 'O', {
        font: mark,
        x: markX,
        y: 150 - 1.5 * scale,
        size: 7 * scale
      })
    page.drawText(continuation, { font: prose, x: tailX, y: 150, size: 10 * scale })
    await pdf.flush()
    pdf.context
      .lookup(prose.ref, PDFDict)
      .set(PDFName.of('BaseFont'), PDFName.of(compact ? 'CMR8' : 'CMR10'))
    const markFont = pdf.context.lookup(mark.ref, PDFDict)
    markFont.set(PDFName.of('BaseFont'), PDFName.of(compact ? 'CMSY6' : 'CMSY7'))
    markFont.set(
      PDFName.of('ToUnicode'),
      pdf.context.register(
        pdf.context.stream(
          '/CIDInit /ProcSet findresource begin 12 dict begin begincmap ' +
            '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def ' +
            '/CMapName /Mark def /CMapType 2 def ' +
            '1 begincodespacerange <00> <FF> endcodespacerange ' +
            '1 beginbfchar <4F> <000C> endbfchar ' +
            'endcmap CMapName currentdict /CMap defineresource pop end end'
        )
      )
    )
    const data = await pdf.save(),
      original = await nativeInk(data),
      registry = new TestCallerRegistry(),
      caller = registry.acquire({ leaseId: 'opaque-solar-inline' }),
      translation = '测量值为 42 M；样品稳定。'
    try {
      const result = await new PdfTranslationWriter(() =>
        resolve('resources/worker.mjs')
      ).generateDetailed(
        {
          id: 'opaque-solar-inline',
          data,
          pages: [{ width: 320, height: 200 }],
          preserveUnsupported: true,
          preserveUnmatched: true,
          units: [
            {
              source: mass + ' ' + continuation,
              translation,
              fragments: [
                {
                  pageNumber: 1,
                  rect: { x: 39 / 320, y: 37 / 200, width: 280 / 320, height: 14 / 200 }
                }
              ]
            }
          ]
        },
        caller.lease
      )
      const written = await nativeInk(result!.data)
      if (paintMark) {
        expect(original.some((object) => /^\f *$/u.test(object.text))).toBe(true)
        expect(result!.layoutFailures).toEqual([
          {
            unitIndex: 0,
            code: 'unsupported-layout',
            phase: 'planning',
            pageNumbers: [1],
            fragmentCount: 1
          }
        ])
        expect(written).toEqual(original)
      } else {
        expect(result!.layoutFailures).toEqual([])
        expect(written.map(({ text }) => text.trim()).join('')).toContain(translation)
      }
    } finally {
      caller.release()
      registry.dispose()
    }
  }
)
