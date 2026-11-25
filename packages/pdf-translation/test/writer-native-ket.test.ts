import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import * as fontkit from 'fontkit'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import {
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  StandardFonts,
  decodePDFRawStream
} from 'pdf-lib'
import { expect, it } from 'vitest'
import { extractPdfTranslationSource } from '../src/reader/extraction.js'
import { PdfTranslationWriter } from '../src/writer.js'
import { resolve } from './paths.js'

it.each([true, false])('retains native ket objects in the same order (%s)', async (ordered) => {
  const pdf = await PDFDocument.create(),
    page = pdf.addPage([360, 180]),
    body = await pdf.embedFont(StandardFonts.TimesRoman)
  pdf.registerFontkit(fontkit)
  const fonts = join(
      dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')),
      'standard_fonts'
    ),
    math = await pdf.embedFont(await readFile(join(fonts, 'LiberationSans-Regular.ttf')), {
      subset: false,
      customName: 'LibertinusMath-Regular'
    })
  const draw = (text: string, x: number, font = body): number => {
    page.drawText(text, { font, size: 12, x, y: 125 })
    return x + font.widthOfTextAtSize(text, 12)
  }
  let x = draw('The example uses ', 35)
  x = draw('|0>', x, math)
  x = draw(' and ends with ', x)
  x = draw('|1>', x, math)
  draw(' in the same basis.', x)
  await pdf.flush()
  const cmap = PDFName.of('ToUnicode'),
    fontDictionary = pdf.context.lookup(math.ref, PDFDict),
    stream = fontDictionary.lookup(cmap)
  if (!(stream instanceof PDFRawStream)) throw new Error('Expected a Unicode CMap stream')
  fontDictionary.set(
    cmap,
    pdf.context.register(
      pdf.context.flateStream(
        Buffer.from(decodePDFRawStream(stream).decode()).toString().replace('<003E>', '<27E9>')
      )
    )
  )
  const data = await pdf.save(),
    original = getDocument({ data: data.slice(), fontExtraProperties: true }),
    signal = new AbortController().signal
  let target: ReturnType<typeof getDocument> | undefined
  try {
    const { source } = await extractPdfTranslationSource({
      document: await original.promise,
      resourceRequestKey: 'native-ket',
      signal
    })
    const expected = 'The example uses |0⟩ and ends with |1⟩ in the same basis.'
    expect(source.units.map((unit) => unit.source)).toEqual([expected])
    const translation = ordered ? '将 |0⟩ 与 |1⟩ 一起列出。' : '将 |1⟩ 与 |0⟩ 一起列出。'
    const result = await new PdfTranslationWriter(() =>
      resolve('resources/worker.mjs')
    ).generateDetailed(
      {
        id: 'native-ket',
        data,
        pages: source.pages,
        preserveUnsupported: true,
        units: [{ ...source.units[0], translation }]
      },
      { leaseId: 'native-ket', generation: 1, signal, isCurrent: () => true }
    )
    expect(result?.layoutFailures).toHaveLength(ordered ? 0 : 1)
    target = getDocument({ data: result!.data.slice() })
    const [before, after] = await Promise.all(
      [original, target].map(
        async (document) =>
          (await (await (await document.promise).getPage(1)).getTextContent()).items
      )
    )
    const compact = (text: string): string => text.replace(/\s/gu, '')
    expect(compact(after.flatMap((item) => ('str' in item ? [item.str] : [])).join(''))).toBe(
      compact(ordered ? translation : expected)
    )
    for (const ket of ['|0⟩', '|1⟩']) {
      const shape = (rows: typeof before): number[][] =>
        rows.flatMap((item) =>
          'str' in item && item.str.trim() === ket ? [item.transform.slice(0, 4)] : []
        )
      expect(shape(before)).toHaveLength(1)
      expect(shape(after)).toEqual(shape(before))
    }
  } finally {
    await target?.destroy()
    await original.destroy()
  }
})
