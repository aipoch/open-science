import { PDFDict, PDFDocument, PDFName, StandardFonts } from 'pdf-lib'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import * as fontkit from 'fontkit'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { expect, it } from 'vitest'
import { PdfTranslationWriter } from '../src/writer.js'
import { resolve } from './paths.js'

it.each([
  ['same formula', 'idx/d\uf077，适用于两个分量：', 'ABCDEF+SymbolMT', false, true],
  ['changed marker', 'idx/d\uf078，适用于两个分量：', 'ABCDEF+SymbolMT', false, false],
  ['changed script', 'alt/d\uf077，适用于两个分量：', 'ABCDEF+SymbolMT', false, false],
  ['wrong native font', 'idx/d\uf077，适用于两个分量：', 'Helvetica', false, false],
  ['unverified suffix', 'idx/d\uf077，适用于两个分量：', 'ABCDEF+SymbolMT', true, false]
] as const)(
  'preserves an unchanged derivative prefix before translated prose (%s)',
  async (_, translation, symbolFont, fakeSuffix, place) => {
    const pdf = await PDFDocument.create(),
      page = pdf.addPage([300, 200]),
      prose = await pdf.embedFont(StandardFonts.TimesRoman),
      italic = await pdf.embedFont(StandardFonts.TimesRomanItalic)
    pdf.registerFontkit(fontkit)
    const font = join(
      dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')),
      'standard_fonts',
      'LiberationSans-Regular.ttf'
    )
    const symbols = await pdf.embedFont(await readFile(font), {
      subset: false,
      customName: symbolFont
    })
    const baseCode = symbols.encodeText('M').toString()
    const terminalCode = symbols.encodeText('W').toString()
    page.drawText('M', { font: symbols, size: 12, x: 24, y: 150 })
    page.drawText('idx', { font: italic, size: 8, x: 32.5, y: 148 })
    page.drawText('/', { font: prose, size: 11, x: 42, y: 150 })
    page.drawText('d', { font: italic, size: 11, x: 47, y: 150 })
    page.drawText('W', { font: symbols, size: 11, x: 54, y: 150 })
    page.drawText(', for two components:', {
      font: prose,
      size: 11,
      x: 63.7,
      y: 150
    })
    await pdf.flush()
    const dictionary = pdf.context.lookup(symbols.ref, PDFDict)
    dictionary.set(
      PDFName.of('ToUnicode'),
      pdf.context.register(
        pdf.context.stream(
          '/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n' +
            '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n' +
            '/CMapName /PrivateSymbols def /CMapType 2 def\n' +
            '1 begincodespacerange <0000> <FFFF> endcodespacerange\n' +
            `2 beginbfchar ${baseCode} <F06A> ${terminalCode} <F077> endbfchar\n` +
            'endcmap CMapName currentdict /CMap defineresource pop end end'
        )
      )
    )
    const data = await pdf.save(),
      source = 'idx/d\uf077, for two components:'
    const writer = new PdfTranslationWriter(() => resolve('resources/worker.mjs'))
    const caller = {
      leaseId: 'pinned-symbol',
      generation: 1,
      signal: new AbortController().signal,
      isCurrent: () => true
    }
    const output = await writer.generateDetailed(
      {
        id: 'pinned-symbol',
        data,
        pages: [{ width: 300, height: 200 }],
        preserveUnsupported: true,
        preserveUnmatched: true,
        units: [
          {
            source: fakeSuffix ? source.replace('two', 'all') : source,
            translation,
            fragments: [
              {
                pageNumber: 1,
                rect: {
                  x: 32.5 / 300,
                  y: 38 / 200,
                  width: 150 / 300,
                  height: 17 / 200
                },
                items: ['idx', '/', 'd', '\uf077', ', for two components:'].map((text, index) => ({
                  index,
                  text
                }))
              }
            ]
          }
        ]
      },
      caller
    )
    const loading = getDocument({
      data: output!.data.slice(),
      useSystemFonts: true
    })
    try {
      const items = (await (await (await loading.promise).getPage(1)).getTextContent()).items
      const content = items
        .flatMap((item) => ('str' in item ? [item.str] : []))
        .join('')
        .replace(/\s/gu, '')
      expect(content).toBe('\uf06a' + (place ? translation : source).replace(/\s/gu, ''))
      expect(output?.layoutFailures.length).toBe(place ? 0 : 1)
    } finally {
      await loading.destroy()
    }
  }
)
