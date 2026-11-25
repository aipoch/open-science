import { readFile } from 'node:fs/promises'
import * as fontkit from 'fontkit'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { TextContent } from 'pdfjs-dist/types/src/display/api.js'
import { expect, it } from 'vitest'
import { PdfTranslationWriter } from '../src/writer.js'
import { resolve } from './paths.js'

it.each([
  ['double acute', 'K˝ur', 'Kűr', true],
  ['dotless i', 'Dır', 'Dır', true],
  ['caron on c', 'Čečan', 'Čečan', true],
  ['acute on c', 'Ćać', 'Ćać', true],
  ['stroke and ogonek', 'Łę-Ęł', 'Łę-Ęł', true],
  ['another unavailable mark', 'K˝ur', 'Křr', false]
] as const)(
  'writes only the supported missing Latin glyph with %s',
  async (_, sourceWord, word, placed) => {
    const source = `Notes from the ${sourceWord} archives.`,
      translated = `来自 ${word} 档案馆的记录。`,
      neighbor = 'Independent line',
      pdf = await PDFDocument.create(),
      page = pdf.addPage([300, 200])
    pdf.registerFontkit(fontkit)
    const latin = await pdf.embedFont(
      await readFile(
        new URL(import.meta.resolve('pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf'))
      )
    )
    page.drawText(source, { font: latin, x: 25, y: 150, size: 12 })
    page.drawText(neighbor, {
      font: await pdf.embedFont(StandardFonts.TimesRoman),
      x: 25,
      y: 125,
      size: 12
    })
    const data = await pdf.save()
    const result = await new PdfTranslationWriter(() =>
      resolve('resources/worker.mjs')
    ).generateDetailed(
      {
        id: 'mixed-latin',
        data,
        pages: [{ width: 300, height: 200 }],
        preserveUnsupported: true,
        preserveUnmatched: true,
        units: [
          {
            source,
            translation: translated,
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 24 / 300, y: 38 / 200, width: 220 / 300, height: 20 / 200 }
              }
            ]
          }
        ]
      },
      {
        leaseId: 'mixed-latin',
        generation: 1,
        signal: new AbortController().signal,
        isCurrent: () => true
      }
    )
    expect(result?.layoutFailures.map(({ code }) => code)).toEqual(placed ? [] : ['font'])
    const loading = getDocument({ data: result!.data.slice(), useSystemFonts: true })
    try {
      const items: TextContent['items'] = (
        await (await (await loading.promise).getPage(1)).getTextContent()
      ).items
      const text = items.flatMap((item) => ('str' in item ? [item.str] : [])).join('')
      const compact = (value: string): string => value.replace(/\s/gu, '')
      expect(compact(text)).toBe(compact((placed ? translated : source) + neighbor))
      expect(items.find((item) => 'str' in item && item.str === neighbor)).toMatchObject({
        transform: [12, 0, 0, 12, 25, 125]
      })
    } finally {
      await loading.destroy()
    }
  }
)
