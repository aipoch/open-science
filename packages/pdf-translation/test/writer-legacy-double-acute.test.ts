import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import * as fontkit from 'fontkit'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { PDFDocument, PDFNumber, PDFOperator, PDFOperatorNames } from 'pdf-lib'
import { expect, it } from 'vitest'
import { PdfTranslationWriter } from '../src/writer.js'
import { resolve } from './paths.js'

it.each([
  { name: 'carried overprint', detached: false, word: 'Lem˝os', placed: true, mixed: false },
  { name: 'detached mark', detached: true, word: 'Lem˝os', placed: false, mixed: false },
  { name: 'changed word', detached: false, word: 'Lem˝ot', placed: false, mixed: false },
  {
    name: 'mixed Latin subsets in a tight row',
    detached: false,
    word: 'Lem˝os',
    placed: true,
    mixed: true
  }
])(
  'checks native ink before composing a double acute in $name',
  async ({ detached, word, placed, mixed }) => {
    const pdf = await PDFDocument.create()
    const page = pdf.addPage([300, 200])
    pdf.registerFontkit(fontkit)
    const fontFile = join(
      dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')),
      'standard_fonts',
      'LiberationSans-Regular.ttf'
    )
    const fontBytes = await readFile(fontFile)
    const face = fontkit.create(fontBytes)
    const font = await pdf.embedFont(fontBytes, { subset: false, customName: 'URWPalladioL-Roma' })
    const key = page.node.newFontDictionary('URWPalladioL-Roma', font.ref)
    const source = 'Field Lem˝os relations'
    const translation = mixed ? `静态 ${word} 观测值 ć` : `静态 ${word} 结果 ő`
    const mark = face.glyphForCodePoint(0x2dd).bbox
    const vowel = face.glyphForCodePoint(0x6f).bbox
    const offset = ((mark.minX + mark.maxX - vowel.minX - vowel.maxX) * 500) / face.unitsPerEm
    const interposedAdvance = font.widthOfTextAtSize('˝', 1000) - offset
    page.pushOperators(
      PDFOperator.of(PDFOperatorNames.BeginText),
      PDFOperator.of(PDFOperatorNames.SetFontAndSize, [key, PDFNumber.of(12)]),
      PDFOperator.of(PDFOperatorNames.SetTextMatrix, [1, 0, 0, 1, 25, 150].map(PDFNumber.of)),
      PDFOperator.of(PDFOperatorNames.ShowTextAdjusted, [
        pdf.context.obj([
          font.encodeText('Field Lem˝'),
          detached ? 0 : interposedAdvance,
          font.encodeText('os relations')
        ])
      ]),
      PDFOperator.of(PDFOperatorNames.EndText)
    )

    const data = await pdf.save()
    const readText = async (
      bytes: Uint8Array
    ): Promise<{ index: number; text: string; point: number }[]> => {
      const task = getDocument({ data: bytes.slice(), useSystemFonts: true })
      try {
        const { items } = await (await (await task.promise).getPage(1)).getTextContent()
        return items.flatMap((item, index) =>
          'str' in item && item.str.trim()
            ? [{ index, text: item.str, point: item.transform[3] }]
            : []
        )
      } finally {
        await task.destroy()
      }
    }
    const compact = (text: string): string => text.replace(/\s/gu, '')
    const items = (await readText(data)).map(({ index, text }) => ({ index, text }))
    expect(compact(items.map(({ text }) => text).join(''))).toBe(compact(source))
    const writer = new PdfTranslationWriter(() => resolve('resources/worker.mjs'))
    const output = await writer.generateDetailed(
      {
        id: 'legacy-double-acute',
        data,
        pages: [{ width: 300, height: 200 }],
        preserveUnsupported: true,
        preserveUnmatched: true,
        units: [
          {
            source,
            translation,
            fragments: [
              {
                pageNumber: 1,
                rect: {
                  x: 24 / 300,
                  y: 39 / 200,
                  width: (mixed ? 115.5 : 151) / 300,
                  height: 18 / 200
                },
                items
              }
            ]
          }
        ]
      },
      {
        leaseId: 'legacy-double-acute',
        generation: 1,
        signal: new AbortController().signal,
        isCurrent: () => true
      }
    )
    expect(output?.layoutFailures.map(({ code }) => code)).toEqual(placed ? [] : ['font'])
    const written = await readText(output!.data)
    expect(compact(written.map(({ text }) => text).join(''))).toBe(
      compact(placed ? translation : source)
    )
    if (mixed) expect(written.find(({ text }) => text.includes('静态'))?.point).toBeCloseTo(12, 2)
  }
)
