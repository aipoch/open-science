import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as fontkit from 'fontkit'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { expect, it } from 'vitest'
import { PdfTranslationWriter } from '../src/writer.js'
import { resolve } from './paths.js'

const { engine } = await import(pathToFileURL(resolve('resources/pdfium.mjs')).href)
const primeText = '′′'

it.each([
  ['exact dimensions', '插图显示 5′′ × 4′′ 的拼接图。', false, true, 'dimensions'],
  ['swapped dimensions', '插图显示 4′′ × 5′′ 的拼接图。', false, false, 'dimensions'],
  ['missing suffix', '插图显示 5′′ × 4 的拼接图。', false, false, 'dimensions'],
  ['detached suffix', '插图显示 5′′ × 4′′ 的拼接图。', true, false, 'dimensions'],
  ['single angular distance', '插图显示距离小于 5′′。', false, true, 'distance'],
  ['changed angular distance', '插图显示距离小于 6′′。', false, false, 'distance'],
  ['detached angular distance mark', '插图显示距离小于 5′′。', true, false, 'distance']
] as const)(
  'places the caption beside native math with %s',
  async (_, translation, detached, placed, kind) => {
    const distance = kind === 'distance'
    const pdf = await PDFDocument.create(),
      page = pdf.addPage([400, 200]),
      prose = await pdf.embedFont(StandardFonts.TimesRoman)
    pdf.registerFontkit(fontkit)
    const primeFont = await pdf.embedFont(
        await readFile(
          join(
            dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')),
            'standard_fonts',
            'LiberationSans-Regular.ttf'
          )
        ),
        { customName: 'CMSY6' }
      ),
      x = 120,
      y = 150,
      body = 9,
      small = 6
    page.drawText('u = 2', { font: prose, x: 80, y, size: body })
    page.drawText('+1', { font: prose, x: 100, y: y + 4, size: small })
    page.drawText('-1', { font: prose, x: 100, y: y - 4, size: small })
    let cursor = x
    const draw = (text: string, raised: boolean, gap: number): void => {
      const font = raised ? primeFont : prose,
        size = raised ? small : body
      cursor += gap
      page.drawText(text, { font, x: cursor, y: y + (raised ? 4 : 0), size })
      cursor += font.widthOfTextAtSize(text, size)
    }
    draw(distance ? 'Inset shows a separation of less than 5' : 'Inset shows a 5', false, 0)
    draw(primeText, true, detached ? 5 : 0.3)
    if (!distance) {
      draw(' × 4', false, 0.3)
      draw(primeText, true, 0.3)
    }
    draw(distance ? ' on the calibrated image.' : ' mosaic from the calibrated image.', false, 0.3)
    const source = distance
        ? 'Inset shows a separation of less than 5′′ on the calibrated image.'
        : 'Inset shows a 5′′ × 4′′ mosaic from the calibrated image.',
      data = await pdf.save(),
      writer = new PdfTranslationWriter(() => resolve('resources/worker.mjs')),
      output = await writer.generateDetailed(
        {
          id: 'angular-dimension',
          data,
          pages: [{ width: 400, height: 200 }],
          preserveUnsupported: true,
          preserveUnmatched: true,
          units: [
            {
              source,
              translation,
              fragments: [
                {
                  pageNumber: 1,
                  rect: { x: 119 / 400, y: 39 / 200, width: 260 / 400, height: 20 / 200 }
                }
              ]
            }
          ]
        },
        {
          leaseId: 'angular-dimension',
          generation: 1,
          signal: new AbortController().signal,
          isCurrent: () => true
        }
      )
    expect(output?.layoutFailures).toHaveLength(placed ? 0 : 1)
    if (!placed) {
      expect(output?.data).toEqual(data)
      return
    }
    const target = getDocument({ data: output!.data.slice(), useSystemFonts: true })
    try {
      const content = await (await (await target.promise).getPage(1)).getTextContent()
      expect(
        content.items
          .flatMap((item) => ('str' in item ? [item.str] : []))
          .join('')
          .replace(/\s/gu, '')
      ).toContain(translation.replace(/\s/gu, ''))
      const native = await engine()
      const proof = (
        bytes: Uint8Array
      ): { dimensions: number[][]; stack: [string | undefined, number[]][] } => {
        const document = native.open(bytes),
          page = native.p.FPDF_LoadPage(document.doc, 0)
        try {
          const objects = native.objects(page) as { text?: string; bounds: number[] }[]
          return {
            dimensions: objects
              .filter((entry) => entry.text?.trim() === primeText)
              .map(({ bounds: [left, bottom, right, top] }) => [right - left, top - bottom]),
            stack: objects
              .filter((entry) => ['u = 2', '+1', '-1'].includes(entry.text?.trim() ?? ''))
              .map(({ text, bounds }) => [text, bounds])
          }
        } finally {
          native.p.FPDF_ClosePage(page)
          document.close()
        }
      }
      const before = proof(data),
        after = proof(output!.data)
      expect(before.stack).toHaveLength(3)
      expect(after.stack).toEqual(before.stack)
      expect(before.dimensions).toHaveLength(distance ? 1 : 2)
      expect(after.dimensions).toHaveLength(distance ? 1 : 2)
      for (const [index, [width, height]] of after.dimensions.entries()) {
        expect(width).toBeCloseTo(before.dimensions[index][0], 3)
        expect(height).toBeCloseTo(before.dimensions[index][1], 3)
      }
    } finally {
      await target.destroy()
    }
  }
)

it.each([
  ['Unicode degrees', '图中 ∠ABC = 45°，另一个角为 30°。', false, true],
  ['native degrees', '图中 ∠ABC = 45o，另一个角为 30o。', false, true],
  ['changed angle', '图中 ∠ABC = 40°，另一个角为 30°。', false, false],
  ['detached suffix', '图中 ∠ABC = 45°，另一个角为 30°。', true, false]
] as const)(
  'writes back a raised legacy degree suffix with %s',
  async (_, translation, detached, placed) => {
    const pdf = await PDFDocument.create(),
      page = pdf.addPage([400, 200])
    pdf.registerFontkit(fontkit)
    const font = await pdf.embedFont(
        await readFile(
          join(
            dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')),
            'standard_fonts',
            'LiberationSans-Regular.ttf'
          )
        )
      ),
      x = 60,
      base = 145,
      body = 12,
      size = 8,
      rise = 4.2,
      lines = ['The diagram shows ∠ABC = 45', ', and the other angle is 30']
    for (const [index, text] of lines.entries()) {
      const y = base - index * 15,
        end = x + font.widthOfTextAtSize(text, body),
        offset = detached && index === 1 ? 4 : 0.3
      page.drawText(text, { font, x, y, size: body })
      page.drawText('o', { font, x: end + offset, y: y + rise, size })
      if (index === 1)
        page.drawText('.', {
          font,
          x: end + offset + font.widthOfTextAtSize('o', size),
          y,
          size: body
        })
    }
    const data = await pdf.save(),
      result = await new PdfTranslationWriter(() =>
        resolve('resources/worker.mjs')
      ).generateDetailed(
        {
          id: 'legacy-degree-suffix',
          data,
          pages: [{ width: 400, height: 200 }],
          preserveUnsupported: true,
          units: [
            {
              source: 'The diagram shows ∠ABC = 45o, and the other angle is 30o.',
              translation,
              fragments: [
                {
                  pageNumber: 1,
                  rect: { x: 59 / 400, y: 43 / 200, width: 300 / 400, height: 35 / 200 }
                }
              ]
            }
          ]
        },
        {
          leaseId: 'legacy-degree-suffix',
          generation: 1,
          signal: new AbortController().signal,
          isCurrent: () => true
        }
      )
    expect(result?.layoutFailures).toHaveLength(placed ? 0 : 1)
    if (!placed) {
      expect(result?.data).toEqual(data)
      return
    }
    const target = getDocument({ data: result!.data.slice(), fontExtraProperties: true })
    try {
      const content = await (await (await target.promise).getPage(1)).getTextContent()
      expect(
        content.items
          .flatMap((item) => ('str' in item ? [item.str] : []))
          .join('')
          .replace(/\s/gu, '')
      ).toContain(translation.replace(/\s/gu, ''))
    } finally {
      await target.destroy()
    }
  }
)

it.each([
  ['matching magnitudes', '图 1. 视野为 4′′. 2 × 3′′. 5。', true],
  ['changed magnitude', '图 1. 视野为 4′′. 8 × 3′′. 5。', false]
] as const)('matches a raised angular decimal with %s', async (_, translation, placed) => {
  const pdf = await PDFDocument.create(),
    page = pdf.addPage([400, 200]),
    prose = await pdf.embedFont(StandardFonts.TimesRoman),
    size = 9,
    baseline = 145
  pdf.registerFontkit(fontkit)
  const mark = await pdf.embedFont(
    await readFile(
      join(
        dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')),
        'standard_fonts',
        'LiberationSans-Regular.ttf'
      )
    ),
    { customName: 'CMSY6' }
  )
  let cursor = 50
  const draw = (text: string): void => {
    page.drawText(text, { font: prose, x: cursor, y: baseline, size })
    cursor += prose.widthOfTextAtSize(text, size)
  }
  const raisedDecimal = (): void => {
    page.drawText('.', { font: prose, x: cursor - 0.1, y: baseline, size })
    page.drawText(primeText, { font: mark, x: cursor + 0.2, y: baseline + 3.8, size: 6 })
    cursor += mark.widthOfTextAtSize(primeText, 6) + 0.8
  }
  draw('Figure 1. The field covers 4')
  raisedDecimal()
  draw('2 × 3')
  raisedDecimal()
  draw('5.')
  const data = await pdf.save(),
    source = 'Figure 1. The field covers 4′′. 2 × 3′′. 5.',
    result = await new PdfTranslationWriter(() => resolve('resources/worker.mjs')).generateDetailed(
      {
        id: 'raised-angular-decimal',
        data,
        pages: [{ width: 400, height: 200 }],
        preserveUnsupported: true,
        preserveUnmatched: true,
        units: [
          {
            source,
            translation,
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 49 / 400, y: 41 / 200, width: 300 / 400, height: 28 / 200 }
              }
            ]
          }
        ]
      },
      {
        leaseId: 'raised-angular-decimal',
        generation: 1,
        signal: new AbortController().signal,
        isCurrent: () => true
      }
    )
  expect(result?.layoutFailures).toHaveLength(placed ? 0 : 1)
  if (!placed) {
    expect(result?.data).toEqual(data)
    return
  }
  const output = getDocument({ data: result!.data.slice(), useSystemFonts: true })
  try {
    const content = await (await (await output.promise).getPage(1)).getTextContent()
    expect(
      content.items
        .flatMap((item) => ('str' in item ? [item.str] : []))
        .join('')
        .replace(/\s/gu, '')
    ).toContain(translation.replace(/\s/gu, ''))
  } finally {
    await output.destroy()
  }
})
