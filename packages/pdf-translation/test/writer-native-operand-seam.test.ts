import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import * as fontkit from 'fontkit'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { TextItem } from 'pdfjs-dist/types/src/display/api.js'
import { PDFDocument } from 'pdf-lib'
import { expect, it } from 'vitest'
import { PdfTranslationWriter } from '../src/writer.js'
import { resolve } from './paths.js'

it.each([
  { label: 'original operand order', translation: '1)–保持稳定。', placed: true },
  { label: 'moved closing operand', translation: '保持 1)–稳定。', placed: false }
])('retains a closing operand at the native seam: $label', async ({ translation, placed }) => {
  const pdf = await PDFDocument.create()
  pdf.registerFontkit(fontkit)
  const page = pdf.addPage([280, 160])
  const fonts = join(
    dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')),
    'standard_fonts'
  )
  const regular = await readFile(join(fonts, 'LiberationSans-Regular.ttf'))
  const body = await pdf.embedFont(regular, { subset: false, customName: 'CMR10' })
  const symbol = await pdf.embedFont(regular, { subset: false, customName: 'CMSY10' })
  const source = '1)–stable in the interval.'
  page.drawText('(r ', { x: 35, y: 102, size: 12, font: body })
  page.drawText('−', { x: 50, y: 102, size: 12, font: symbol })
  page.drawText(source, { x: 60, y: 102, size: 12, font: body })
  const read = async (data: Uint8Array): Promise<(TextItem & { index: number })[]> => {
    const document = getDocument({ data: data.slice(), useSystemFonts: true })
    try {
      const text = await (await (await document.promise).getPage(1)).getTextContent()
      return text.items.flatMap((item, index) => ('str' in item ? [{ ...item, index }] : []))
    } finally {
      await document.destroy()
    }
  }
  const bytes = await pdf.save()
  const original = (await read(bytes)).find(({ str }) => str === source)!
  expect(original).toBeDefined()
  const result = await new PdfTranslationWriter(() =>
    resolve('resources/worker.mjs')
  ).generateDetailed(
    {
      id: 'operand-seam',
      data: bytes,
      pages: [{ width: 280, height: 160 }],
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
                x: 60 / 280,
                y: 48 / 160,
                width: (original.width + 3) / 280,
                height: 14 / 160
              },
              items: [{ index: original.index, text: source }]
            }
          ]
        }
      ]
    },
    {
      leaseId: 'operand-seam',
      generation: 1,
      signal: new AbortController().signal,
      isCurrent: () => true
    }
  )
  expect(result?.layoutFailures.map(({ code }) => code)).toEqual(
    placed ? [] : ['unsupported-layout']
  )
  const output = await read(result!.data)
  const visible = output
    .map(({ str }) => str)
    .join('')
    .replace(/\s/gu, '')
  expect(visible).toContain(placed ? translation : source.replace(/\s/gu, ''))
  if (placed) {
    const anchored = output.find(({ str }) => str === '1)')
    expect(anchored?.transform.slice(4)).toEqual(original.transform.slice(4))
  }
})
