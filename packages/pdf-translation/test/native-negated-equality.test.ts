import { expect, it } from 'vitest'
import { PDFDict, PDFDocument, PDFName, StandardFonts } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { PdfTranslationWriter } from '../src/writer.js'
import { TestCallerRegistry } from './support/callers.js'
import { resolve } from './paths.js'
import { pathToFileURL } from 'node:url'
const { engine } = await import(pathToFileURL(resolve('resources/pdfium.mjs')).href)

it.each([
  'complete',
  'legacy-slot',
  'latin-modern',
  'latin-modern-number',
  'changed-number',
  'mixed-fonts',
  'detached',
  'different-size',
  'foreign-ink',
  'missing-mark',
  'reordered'
])(
  'moves a separately painted negated equality only as a complete native pair: %s',
  async (kind) => {
    const pdf = await PDFDocument.create(),
      prose = await pdf.embedFont(StandardFonts.TimesRoman),
      slash = await pdf.embedFont(StandardFonts.Helvetica),
      equal = await pdf.embedFont(StandardFonts.Helvetica),
      page = pdf.addPage([320, 200]),
      x = 120,
      fusedNumber = kind === 'latin-modern-number' || kind === 'changed-number',
      equality = fusedNumber ? '= 27' : '=',
      shift = (equal.widthOfTextAtSize('=', 10) - slash.widthOfTextAtSize('/', 10)) / 2
    page.drawText('The values u ', { font: prose, x: 40, y: 150, size: 10 })
    page.drawText('/', {
      font: slash,
      x: x + shift - 1 + (kind === 'detached' ? 14 : 0),
      y: 150,
      size: kind === 'different-size' ? 8 : 10
    })
    page.drawText(equality, { font: equal, x, y: 150, size: 10 })
    page.drawText(fusedNumber ? ' differs.' : ' v differ.', {
      font: prose,
      x: fusedNumber ? 145 : 140,
      y: 150,
      size: 10
    })
    if (kind === 'foreign-ink') page.drawText('q', { font: prose, x, y: 150, size: 10 })
    page.drawText('Independent neighbor.', { font: prose, x: 40, y: 100, size: 10 })
    await pdf.flush()
    const latinModern = kind === 'latin-modern' || kind === 'mixed-fonts' || fusedNumber,
      legacy = kind === 'legacy-slot',
      complete =
        kind === 'complete' || kind === 'latin-modern' || kind === 'latin-modern-number' || legacy,
      slashFont = pdf.context.lookup(slash.ref, PDFDict)
    slashFont.set(
      PDFName.of('BaseFont'),
      PDFName.of(latinModern ? 'LMMathSymbols10-Regular' : 'CMSY10')
    )
    slashFont.set(
      PDFName.of('ToUnicode'),
      pdf.context.register(
        pdf.context.stream(
          '/CIDInit /ProcSet findresource begin 12 dict begin begincmap ' +
            '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def ' +
            '/CMapName /NativeSlash def /CMapType 2 def ' +
            '1 begincodespacerange <00> <FF> endcodespacerange ' +
            `1 beginbfchar <2F> <${legacy ? '0036' : '0338'}> endbfchar ` +
            'endcmap CMapName currentdict /CMap defineresource pop end end'
        )
      )
    )
    pdf.context
      .lookup(equal.ref, PDFDict)
      .set(
        PDFName.of('BaseFont'),
        PDFName.of(kind === 'latin-modern' || fusedNumber ? 'LMRoman10-Regular' : 'CMR10')
      )
    const data = await pdf.save(),
      registry = new TestCallerRegistry(),
      caller = registry.acquire({ leaseId: 'native-negation' }),
      relation = kind === 'missing-mark' ? '=' : kind === 'reordered' ? '=\u0338' : '\u0338=',
      source = `The values u \u0338${equality}${fusedNumber ? ' differs.' : ' v differ.'}${kind === 'foreign-ink' ? ' q' : ''}`,
      value = fusedNumber ? (kind === 'changed-number' ? ' 270' : ' 27') : ' v',
      translation = `数值 u ${relation}${value} 不同。${kind === 'foreign-ink' ? ' q' : ''}`
    const mark = legacy ? '6' : '\u0338'
    const original = getDocument({ data: data.slice(), useSystemFonts: true })
    let target: ReturnType<typeof getDocument> | undefined
    try {
      const output = await new PdfTranslationWriter(() =>
        resolve('resources/worker.mjs')
      ).generateDetailed(
        {
          id: 'native-negation',
          data,
          pages: [{ width: 320, height: 200 }],
          preserveUnsupported: true,
          preserveUnmatched: true,
          units: [
            {
              source,
              translation,
              fragments: [
                {
                  pageNumber: 1,
                  rect: { x: 39 / 320, y: 37 / 200, width: 250 / 320, height: 22 / 200 }
                }
              ]
            }
          ]
        },
        caller.lease
      )
      expect(output!.layoutFailures).toHaveLength(complete ? 0 : 1)
      target = getDocument({ data: output!.data.slice(), useSystemFonts: true })
      const before = (
          await (await (await original.promise).getPage(1)).getTextContent()
        ).items.filter((i) => 'str' in i),
        after = (await (await (await target.promise).getPage(1)).getTextContent()).items.filter(
          (i) => 'str' in i
        )
      expect(after.find((i) => i.str === 'Independent neighbor.')?.transform).toEqual(
        before.find((i) => i.str === 'Independent neighbor.')?.transform
      )
      if (complete) {
        expect(
          after
            .map((i) => i.str)
            .join('')
            .replace(/\s/gu, '')
        ).toContain(translation.replace('\u0338', mark).replace(/\s/gu, ''))
        const native = await engine(),
          input = native.open(data),
          changed = native.open(output!.data),
          oldPage = native.p.FPDF_LoadPage(input.doc, 0),
          newPage = native.p.FPDF_LoadPage(changed.doc, 0)
        try {
          type Native = { text?: string; bounds: number[] }
          const oldObjects: Native[] = native.objects(oldPage),
            newObjects: Native[] = native.objects(newPage),
            oldMark = oldObjects.find((o) => o.text?.trim() === mark)!,
            newMark = newObjects.find((o) => o.text?.trim() === mark)!,
            oldEqual = oldObjects.find((o) => o.text?.trim() === equality)!,
            newEqual = newObjects.find((o) => o.text?.trim() === equality)!
          for (const [oldGlyph, newGlyph] of [
            [oldMark, newMark],
            [oldEqual, newEqual]
          ]) {
            expect(newGlyph.bounds[2] - newGlyph.bounds[0]).toBeCloseTo(
              oldGlyph.bounds[2] - oldGlyph.bounds[0],
              3
            )
            expect(newGlyph.bounds[3] - newGlyph.bounds[1]).toBeCloseTo(
              oldGlyph.bounds[3] - oldGlyph.bounds[1],
              3
            )
          }
          for (const axis of [0, 1])
            expect(newMark.bounds[axis] - newEqual.bounds[axis]).toBeCloseTo(
              oldMark.bounds[axis] - oldEqual.bounds[axis],
              3
            )
        } finally {
          native.p.FPDF_ClosePage(oldPage)
          native.p.FPDF_ClosePage(newPage)
          input.close()
          changed.close()
        }
      } else expect(after.some((i) => i.str.includes('数值'))).toBe(false)
    } finally {
      await target?.destroy()
      await original.destroy()
      caller.release()
      registry.dispose()
    }
  }
)
