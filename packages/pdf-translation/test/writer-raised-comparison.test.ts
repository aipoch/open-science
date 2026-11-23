import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import * as fontkit from 'fontkit'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { TextItem } from 'pdfjs-dist/types/src/display/api.js'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { expect, it } from 'vitest'
import { PdfTranslationWriter } from '../src/writer.js'
import { resolve } from './paths.js'

it.each([
  { name: 'unchanged comparison', operand: 'n', arrow: false, fitted: true },
  { name: 'changed operand', operand: 'm', arrow: false, fitted: false },
  { name: 'unowned limit arrow', operand: 'n', arrow: true, fitted: false }
])(
  'preserves a separately painted raised comparison with $name',
  async ({ operand, arrow, fitted }) => {
    const pdf = await PDFDocument.create()
    pdf.registerFontkit(fontkit)
    const page = pdf.addPage([300, 200]),
      fonts = join(
        dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')),
        'standard_fonts'
      ),
      italic = await readFile(join(fonts, 'LiberationSans-Italic.ttf')),
      regular = await readFile(join(fonts, 'LiberationSans-Regular.ttf')),
      body = await pdf.embedFont(StandardFonts.TimesRoman),
      base = await pdf.embedFont(italic, { subset: false, customName: 'CMMI10' }),
      relation = await pdf.embedFont(regular, { subset: false, customName: 'CMSY7' }),
      index = await pdf.embedFont(italic, { subset: false, customName: 'CMMI7' }),
      intro = arrow ? 'Compare lim ' : 'Compare ',
      source = intro + 'x≤n before sorting.',
      translation = `排序前比较 ${arrow ? 'lim ' : ''}x≤${operand}。`,
      neighbor = 'Independent neighboring row.'
    page.drawText(intro, { x: 30, y: 130, size: 10, font: body })
    let x = 30 + body.widthOfTextAtSize(intro, 10)
    if (arrow) page.drawText('←', { x: x - 10, y: 124, size: 7, font: relation })
    for (const [text, y, size, font, gap] of [
      ['x', 130, 10, base, 0.7],
      ['≤', 133.5, 7, relation, 0.7],
      ['n', 133.5, 7, index, 0],
      [' before sorting.', 130, 10, body, 0]
    ] as const) {
      page.drawText(text, { x, y, size, font })
      x += font.widthOfTextAtSize(text, size) + gap
    }
    page.drawText(neighbor, { x: 30, y: 100, size: 10, font: body })

    const readText = async (data: Uint8Array): Promise<(TextItem & { index: number })[]> => {
        const loading = getDocument({ data: data.slice(), useSystemFonts: true })
        try {
          return (await (await (await loading.promise).getPage(1)).getTextContent()).items.flatMap(
            (item, index) => ('str' in item && item.str.trim() ? [{ ...item, index }] : [])
          )
        } finally {
          await loading.destroy()
        }
      },
      compact = (text: string): string => text.replace(/\s/gu, ''),
      data = await pdf.save(),
      original = await readText(data),
      sourceItems = original
        .filter(({ transform, str }) => transform[5] > 128 && str !== '←')
        .map(({ index, str }) => ({ index, text: str }))
    expect(compact(sourceItems.map(({ text }) => text).join(''))).toBe(compact(source))

    const output = await new PdfTranslationWriter(() =>
      resolve('resources/worker.mjs')
    ).generateDetailed(
      {
        id: 'raised-relation',
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
                rect: { x: 28 / 300, y: 57 / 200, width: 170 / 300, height: 15 / 200 },
                items: sourceItems
              }
            ]
          }
        ]
      },
      {
        leaseId: 'raised-relation',
        generation: 1,
        signal: new AbortController().signal,
        isCurrent: () => true
      }
    )
    expect(output?.layoutFailures).toHaveLength(fitted ? 0 : 1)
    const items = await readText(output!.data)
    expect(
      compact(
        items
          .filter(({ str }) => str !== '←')
          .map(({ str }) => str)
          .join('')
      )
    ).toBe(compact((fitted ? translation : source) + neighbor))
    expect(items.find(({ str }) => str === neighbor)?.transform.slice(4)).toEqual([30, 100])
    const bodyGlyph = items.find(({ str }) => str === 'x')!
    const relationGlyph = items.find(({ str }) => compact(str).startsWith('≤'))!
    expect(relationGlyph.transform[5] - bodyGlyph.transform[5]).toBeCloseTo(3.5)
    expect(relationGlyph.height).toBeCloseTo(7)
    const indexGlyph = items.find(({ str }) => str === 'n')!
    expect(indexGlyph.transform[5]).toBeCloseTo(relationGlyph.transform[5])
    expect(indexGlyph.height).toBeCloseTo(7)
    if (arrow) {
      const originalArrow = original.find(({ str }) => str === '←')
      expect(originalArrow).toBeDefined()
      expect(items.find(({ str }) => str === '←')?.transform).toEqual(originalArrow!.transform)
    }
  }
)
