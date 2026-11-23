import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as fontkit from 'fontkit'
import {
  concatTransformationMatrix,
  drawObject,
  PDFDict,
  PDFDocument,
  PDFName,
  popGraphicsState,
  pushGraphicsState,
  StandardFonts
} from 'pdf-lib'
import { expect, it } from 'vitest'
import { PdfTranslationWriter } from '../src/writer.js'
import { resolve } from './paths.js'

const { engine } = await import(pathToFileURL(resolve('resources/pdfium.mjs')).href)

it.each(['unchanged quantity', 'changed radicand'] as const)(
  'keeps the native stencil and raised expression together with %s',
  async (scenario) => {
    const pdf = await PDFDocument.create(),
      page = pdf.addPage([440, 180]),
      prose = await pdf.embedFont(StandardFonts.TimesRoman),
      letters = await pdf.embedFont(StandardFonts.TimesRomanItalic),
      powers = await pdf.embedFont(StandardFonts.TimesRoman),
      operator = await pdf.embedFont(StandardFonts.Helvetica)
    pdf.registerFontkit(fontkit)
    const glyphs = await readFile(
      join(
        dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')),
        'standard_fonts',
        'LiberationSans-Regular.ttf'
      )
    )
    const primes = await pdf.embedFont(glyphs, { customName: 'CMSY6' })
    const root = await pdf.embedFont(glyphs, { customName: 'CMEX9' })
    const stencil = pdf.context.register(
      pdf.context.stream(new Uint8Array([0]), {
        Type: 'XObject',
        Subtype: 'Image',
        Width: 1,
        Height: 1,
        ImageMask: true,
        BitsPerComponent: 1
      })
    )
    const maskName = page.node.newXObject('Mask', stencil)
    const put = (text: string, font: typeof prose, x: number, y: number, size: number): number => {
      page.drawText(text, { font, x, y, size })
      return x + font.widthOfTextAtSize(text, size)
    }
    const first = put('The panel compares a 5', prose, 40, 124, 9),
      between = put('′', primes, first + 0.12, 127.8, 6),
      second = put(' × 4', prose, between + 0.2, 124, 9),
      end = put('′', primes, second + 0.12, 127.8, 6)
    put(' field using ', prose, end + 0.2, 124, 9)
    const left = put('√', root, 41, 113.2, 9),
      right = left + 30.7
    page.pushOperators(
      pushGraphicsState(),
      concatTransformationMatrix(30.7, 0, 0, -0.45, left, 120),
      drawObject(maskName),
      popGraphicsState()
    )
    put('A', letters, left + 0.25, 112, 9)
    put('2', powers, left + 6.5, 114.7, 6)
    put('+', operator, left + 11.7, 112, 9)
    put('B', letters, left + 19, 112, 9)
    put('2', powers, left + 27, 114.7, 6)
    const decimal = put(' and a 1.5', prose, right + 1, 100, 9),
      suffix = put('′′', primes, decimal + 0.12, 103.8, 6)
    put(' scale.', prose, suffix + 0.2, 100, 9)
    put('Independent row.', prose, 40, 80, 9)
    await pdf.flush()
    for (const [font, name] of [
      [letters, 'CMMI9'],
      [powers, 'CMR6'],
      [operator, 'CMR9']
    ] as const)
      pdf.context.lookup(font.ref, PDFDict).set(PDFName.of('BaseFont'), PDFName.of(name))
    const data = await pdf.save()
    const expected = scenario === 'unchanged quantity',
      source = 'The panel compares a 5′ × 4′ field using √A2 + B2 and a 1.5′′ scale.',
      translation = `比较图中 5′ × 4′ 区域，量采用 √A2 + B${expected ? '2' : '3'}，比例为 1.5′′。`
    const output = await new PdfTranslationWriter(() =>
      resolve('resources/worker.mjs')
    ).generateDetailed(
      {
        id: 'native-radical-stencil',
        data,
        pages: [{ width: 440, height: 180 }],
        preserveUnsupported: true,
        preserveUnmatched: true,
        units: [
          {
            source,
            translation,
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 39 / 440, y: 47 / 180, width: 350 / 440, height: 40 / 180 }
              }
            ]
          }
        ]
      },
      {
        leaseId: 'native-radical-stencil',
        generation: 1,
        signal: new AbortController().signal,
        isCurrent: () => true
      }
    )
    const native = await engine()
    const draw = (
      bytes: Uint8Array
    ): { group: number[][]; labels: string[]; primeSizes: number[][] } => {
      const doc = native.open(bytes),
        page = native.p.FPDF_LoadPage(doc.doc, 0)
      try {
        const objects: { type: number; text?: string; bounds: number[] }[] = native.objects(page)
        const maskIndex = objects.findIndex((o) => o.type === 3)
        return {
          group: objects.slice(maskIndex - 1, maskIndex + 6).map((o) => o.bounds),
          labels: objects.map((o) => o.text ?? ''),
          primeSizes: objects
            .filter((o) => /^′{1,2}$/u.test(o.text?.trim() ?? ''))
            .map(({ bounds: [left, bottom, right, top] }) => [right - left, top - bottom])
        }
      } finally {
        native.p.FPDF_ClosePage(page)
        doc.close()
      }
    }
    const before = draw(data),
      after = draw(output!.data)
    expect(output?.layoutFailures).toHaveLength(expected ? 0 : 1)
    expect(after.labels).toContain('Independent row.')
    if (!expected) {
      expect(after.group).toEqual(before.group)
      return
    }
    expect(after.labels.join('')).toContain('比较图中')
    const dx = after.group[0][0] - before.group[0][0],
      dy = after.group[0][1] - before.group[0][1]
    expect(Math.hypot(dx, dy)).toBeGreaterThan(1)
    expect(after.group).toHaveLength(7)
    expect(after.primeSizes).toHaveLength(3)
    for (const [i, [width, height]] of before.primeSizes.entries()) {
      expect(after.primeSizes[i][0]).toBeCloseTo(width, 3)
      expect(after.primeSizes[i][1]).toBeCloseTo(height, 3)
    }
    for (const [i, bounds] of before.group.entries())
      for (const [axis, delta] of [dx, dy, dx, dy].entries())
        expect(after.group[i][axis]).toBeCloseTo(bounds[axis] + delta, 3)
  }
)
