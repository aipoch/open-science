import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import * as fontkit from 'fontkit'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { decodePDFRawStream, PDFDict, PDFDocument, PDFName, PDFRawStream } from 'pdf-lib'
import { expect, it } from 'vitest'
import { PdfTranslationWriter } from '../src/writer.js'
import { resolve } from './paths.js'

it('places a caption around a raised native operator between indexed operands', async () => {
  const pdf = await PDFDocument.create()
  pdf.registerFontkit(fontkit)
  const page = pdf.addPage([330, 180])
  const fonts = join(
    dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')),
    'standard_fonts'
  )
  const body = await pdf.embedFont(await readFile(join(fonts, 'LiberationSans-Regular.ttf')))
  const math = await pdf.embedFont(await readFile(join(fonts, 'LiberationSans-Italic.ttf')), {
    customName: 'CambriaMath'
  })
  const draw = (text: string, x: number, y: number, size = 9, font = body): number => {
    page.drawText(text, { x, y, size, font })
    return x + font.widthOfTextAtSize(text, size)
  }
  draw('Figure 1. The offsets measured at several reference points', 35, 140)
  draw('increase slightly when the averaging window is narrowed.', 35, 129.5)
  let x = draw('The adjusted value (', 35, 119)
  x = draw('a', x, 119.95, 9, math)
  x = draw('1', x, 118.4, 6.5, math)
  x = draw('+', x + 0.4, 119.95, 9, math) + 0.4
  x = draw('b', x, 119.95, 9, math)
  x = draw('2', x, 118.4, 6.5, math)
  draw(') is shown alongside the fitted result.', x, 119)
  draw('The dotted line marks the initial point for each run.', 35, 108.5)

  // Supply mathematical Unicode aliases for the two embedded Latin glyphs.
  const toUnicode = PDFName.of('ToUnicode')
  await math.embed()
  const font = pdf.context.lookup(math.ref, PDFDict)
  const cmap = pdf.context.lookup(font.get(toUnicode))
  if (!(cmap instanceof PDFRawStream)) throw new Error('Expected a Unicode CMap stream')
  const code = Buffer.from(decodePDFRawStream(cmap).decode()).toString()
  font.set(
    toUnicode,
    pdf.context.register(
      pdf.context.flateStream(code.replace('<0061>', '<D835DC4E>').replace('<0062>', '<D835DC4F>'))
    )
  )

  const read = async (
    bytes: Uint8Array
  ): Promise<Array<{ index: number; text: string; transform: number[] }>> => {
    const document = getDocument({ data: bytes.slice(), useSystemFonts: true })
    try {
      const { items } = await (await (await document.promise).getPage(1)).getTextContent()
      return items.flatMap((item, index) =>
        'str' in item && item.str.trim()
          ? [{ index, text: item.str, transform: item.transform }]
          : []
      )
    } finally {
      await document.destroy()
    }
  }
  const data = await pdf.save()
  const original = await read(data)
  const compact = (text: string): string => text.replace(/\s/gu, '')
  const source =
    'Figure 1. The offsets measured at several reference points increase slightly when the averaging window is narrowed. The adjusted value (𝑎1 + 𝑏2) is shown alongside the fitted result. The dotted line marks the initial point for each run.'
  const translation =
    '图1。缩短平均区间，各点的偏移略有增加。调整值（𝑎1 + 𝑏2）与拟合结果并列。虚线标记起点。'
  expect(compact(original.map(({ text }) => text).join(''))).toBe(compact(source))
  const result = await new PdfTranslationWriter(() =>
    resolve('resources/worker.mjs')
  ).generateDetailed(
    {
      id: 'indexed-operator',
      data,
      pages: [{ width: 330, height: 180 }],
      preserveUnsupported: true,
      preserveUnmatched: true,
      units: [
        {
          source,
          translation,
          fragments: [
            {
              pageNumber: 1,
              rect: { x: 34 / 330, y: 30 / 180, width: 260 / 330, height: 45 / 180 },
              items: original.map(({ index, text }) => ({ index, text }))
            }
          ]
        }
      ]
    },
    {
      leaseId: 'indexed-operator',
      generation: 1,
      signal: new AbortController().signal,
      isCurrent: () => true
    }
  )
  expect(result?.layoutFailures).toEqual([])
  const output = await read(result!.data)
  expect(compact(output.map(({ text }) => text).join(''))).toBe(compact(translation))
  for (const operand of ['𝑎', '1', '𝑏', '2']) {
    expect(output.find(({ text }) => text === operand)?.transform.slice(0, 4)).toEqual(
      original.find(({ text }) => text === operand)?.transform.slice(0, 4)
    )
  }
})
