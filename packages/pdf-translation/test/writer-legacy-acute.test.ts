import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import * as fontkit from 'fontkit'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { TextContent } from 'pdfjs-dist/types/src/display/api.js'
import { PDFDocument, PDFNumber, PDFOperator, PDFOperatorNames, StandardFonts } from 'pdf-lib'
import { expect, it } from 'vitest'
import { PdfTranslationWriter } from '../src/writer.js'
import { resolve } from './paths.js'

it.each([
  { name: 'aligned unchanged word', detached: false, word: 'f´ısica', placed: true },
  { name: 'detached acute', detached: true, word: 'f´ısica', placed: false },
  { name: 'changed word', detached: false, word: 'f´ısico', placed: false },
  { name: 'two aligned occurrences', repeated: true, word: 'f´ısica', placed: true },
  {
    name: 'one of two marks detached',
    repeated: true,
    detached: true,
    word: 'f´ısica',
    placed: false
  }
])('uses the native acute proof for $name', async ({ detached, repeated, word, placed }) => {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([300, 200])
  pdf.registerFontkit(fontkit)
  const font = join(
    dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')),
    'standard_fonts',
    'LiberationSans-Regular.ttf'
  )
  const embedded = await pdf.embedFont(await readFile(font), {
    subset: false,
    customName: 'CMR10'
  })
  const key = page.node.newFontDictionary('CMR10', embedded.ref)
  const source = 'Lumen f´ısica field' + (repeated ? ' beside f´ısica' : '')
  const translation = repeated ? `${word} 与 ${word}` : `静态 ${word} 领域 í`
  const accentAdvance = embedded.widthOfTextAtSize('´', 1000)
  const neighbor = 'Independent neighboring row'
  // Reproduce a spacing acute painted directly above the dotless i in one TJ.
  page.pushOperators(
    PDFOperator.of(PDFOperatorNames.BeginText),
    PDFOperator.of(PDFOperatorNames.SetFontAndSize, [key, PDFNumber.of(12)]),
    PDFOperator.of(PDFOperatorNames.SetTextMatrix, [1, 0, 0, 1, 25, 150].map(PDFNumber.of)),
    PDFOperator.of(PDFOperatorNames.ShowTextAdjusted, [
      pdf.context.obj([
        embedded.encodeText('Lumen f´'),
        detached && !repeated ? 0 : accentAdvance,
        embedded.encodeText(repeated ? 'ısica field beside f´' : 'ısica field'),
        ...(repeated ? [detached ? 0 : accentAdvance, embedded.encodeText('ısica')] : [])
      ])
    ]),
    PDFOperator.of(PDFOperatorNames.EndText)
  )
  page.drawText(neighbor, {
    font: await pdf.embedFont(StandardFonts.TimesRoman),
    size: 12,
    x: 25,
    y: 130
  })
  const readText = async (data: Uint8Array): Promise<TextContent['items']> => {
    const loading = getDocument({ data: data.slice(), useSystemFonts: true })
    try {
      return (await (await (await loading.promise).getPage(1)).getTextContent()).items
    } finally {
      await loading.destroy()
    }
  }
  const compact = (text: string): string => text.replace(/\s/gu, '')
  const data = await pdf.save()
  const sourceItems = (await readText(data)).flatMap((item, index) =>
    'str' in item && item.str.trim() && item.transform[5] > 140 ? [{ index, text: item.str }] : []
  )
  expect(compact(sourceItems.map(({ text }) => text).join(''))).toBe(compact(source))

  const writer = new PdfTranslationWriter(() => resolve('resources/worker.mjs'))
  const output = await writer.generateDetailed(
    {
      id: 'legacy-acute',
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
                width: (repeated ? 247 : 160) / 300,
                height: 18 / 200
              },
              items: sourceItems
            }
          ]
        }
      ]
    },
    {
      leaseId: 'legacy-acute',
      generation: 1,
      signal: new AbortController().signal,
      isCurrent: () => true
    }
  )
  expect(output?.layoutFailures.map(({ code }) => code)).toEqual(placed ? [] : ['font'])
  const outputItems = (await readText(output!.data)).flatMap((item) =>
    'str' in item ? [item] : []
  )
  expect(compact(outputItems.map(({ str }) => str).join(''))).toBe(
    compact((placed ? translation : source) + neighbor)
  )
  expect(outputItems.find(({ str }) => str === neighbor)?.transform.slice(4)).toEqual([25, 130])
})
