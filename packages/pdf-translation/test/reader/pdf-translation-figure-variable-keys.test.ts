import { expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import type { PdfStructureResult } from '@aipoch/pdf-structure/result'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import * as fontkit from 'fontkit'
import { PDFDocument, PDFDict, PDFName } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { extractPdfTranslationSource } from '../../src/reader/extraction.js'
import {
  retainNativeFigureVariableKeys,
  isCurrentNativeFigureVariableKeys
} from '../../src/reader/figure-variable-keys.js'
import * as auxiliaryModule from '../../src/reader/auxiliary-native-ink.js'

async function fixture(
  fault = ''
): Promise<Awaited<ReturnType<typeof extractPdfTranslationSource>>['source']['units'][number][]> {
  const pdf = await PDFDocument.create()
  pdf.registerFontkit(fontkit)
  const font = await pdf.embedFont(
    await readFile(
      join(
        dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')),
        'standard_fonts/LiberationSans-Regular.ttf'
      )
    ),
    { subset: false }
  )
  const page = pdf.addPage([400, 400])
  page.drawText('Register font', { font })
  const fontKey = page.node.Resources()!.lookup(PDFName.of('Font'), PDFDict).keys()[0].toString()
  const stream: string[] = ['0.5 w 0 G 0 g']
  const text = (value: string, x: number, y: number): void => {
    for (const word of value.split(' ')) {
      stream.push(`BT ${fontKey} 9 Tf ${x} ${y} Td ${font.encodeText(word).toString()} Tj ET`)
      x += font.widthOfTextAtSize(word, 9) + 3
    }
  }
  for (const [i, key] of ['A', 'B', 'C', 'D'].entries()) {
    const x = 140 + (i % 2) * 90,
      y = 300 - Math.floor(i / 2) * 70
    stream.push(
      `q 1 0 0 1 ${x} ${y} cm 1 g 12 0 m 12 6.627417 6.627417 12 0 12 c -6.627417 12 -12 6.627417 -12 0 c -12 -6.627417 -6.627417 -12 0 -12 c 6.627417 -12 12 -6.627417 12 0 c h B Q`
    )
    text(key, x - 3, y - 3)
  }
  stream.push('152 300 m 218 300 l S 140 288 m 140 242 l S 230 288 m 230 242 l S')
  for (const [i, key] of ['A', 'B', 'C', fault === 'unknown-key' ? 'E' : 'D'].entries())
    text(
      `${key}: ${['first input', 'second input', 'observed outcome', 'missing outcome'][i]}`,
      70 + (i % 2) * 150,
      195 - Math.floor(i / 2) * 13
    )
  if (fault === 'foreign-paint') stream.push('70 190 m 340 190 l S')
  if (fault === 'foreign-text') text('A normal explanatory sentence.', 70, 170)
  text('Figure 1: A bounded example.', 110, 150)
  page.node.set(
    PDFName.of('Contents'),
    pdf.context.register(pdf.context.flateStream(stream.join('\n')))
  )
  const bytes = await pdf.save(),
    identity = {
      sourceChecksum: createHash('sha256').update(bytes).digest('hex'),
      sourceSizeBytes: bytes.length
    }
  const task = getDocument({
    data: bytes,
    fontExtraProperties: true,
    useSystemFonts: false,
    isEvalSupported: false
  })
  const doc = await task.promise
  const extraction = await extractPdfTranslationSource({
    document: doc,
    signal: new AbortController().signal
  })
  let units = extraction.source.units
  if (fault === 'duplicate-owner') {
    const first = extraction.source.units.find((u) => u.source.includes('first input'))!
    units = [...units, { ...first, id: 'duplicate' }]
  }
  const nativePage = await doc.getPage(1),
    nativeOperators = await nativePage.getOperatorList()
  if (fault === 'unknown-glyph') {
    const run = nativeOperators.argsArray.find(
      (args) =>
        Array.isArray(args?.[0]) &&
        args[0].some((g: { fontChar?: string }) => typeof g?.fontChar === 'string')
    )
    run[0].find((g: { fontChar?: string }) => typeof g?.fontChar === 'string').isInFont = false
  }
  const mutate = (): void => {
    nativeOperators.argsArray[0] = [0.7]
  }
  const spy =
    fault === 'dispose-drift'
      ? vi.spyOn(auxiliaryModule, 'createAuxiliaryNativeInkReader').mockReturnValue({
          read: async () => undefined,
          dispose: async () => {
            await Promise.resolve()
            mutate()
          }
        })
      : undefined
  const input = {
    ...extraction,
    source: {
      ...extraction.source,
      units,
      ...(fault === 'page-size' ? { pages: [{ width: 401, height: 400 }] } : {})
    }
  }
  // The caller parses/cache-binds the DTO. This seam independently proves its candidate.
  const output = await retainNativeFigureVariableKeys({
    extraction: input,
    document: doc,
    results: [
      {
        elements: [
          {
            kind: 'figure',
            regions: [{ page: 1, x: 0.3, y: 0.2, width: 0.32, height: 0.27 }],
            caption: { regions: [{ page: 1, x: 0.27, y: 0.6, width: 0.42, height: 0.04 }] }
          }
        ]
      }
    ] as PdfStructureResult[],
    sourceIdentity: identity,
    signal: new AbortController().signal
  })
  spy?.mockRestore()
  const selected = output.source.units.filter(
    (u) => (u.figure && u.source.includes('input')) || (u.figure && u.source.includes('outcome'))
  )
  if (selected.length) {
    expect(output.source.units.map((u) => [u.id, u.source, u.fragments])).toEqual(
      input.source.units.map((u) => [u.id, u.source, u.fragments])
    )
    expect(
      output.source.originalRegions?.some((r) => r.rect.y > 0.47 && r.rect.y + r.rect.height < 0.6)
    ).toBe(true)
    expect(isCurrentNativeFigureVariableKeys(output)).toBe(true)
    mutate()
    expect(isCurrentNativeFigureVariableKeys(output)).toBe(false)
  }
  await task.destroy()
  return selected
}

it('preserves complete native variable keys independently of the original crop', async () => {
  const selected = await fixture()
  expect(selected.map((u) => u.source).join(' ')).toContain('first input')
  expect(selected.map((u) => u.source).join(' ')).toContain('missing outcome')
  expect(selected.some((u) => u.source.startsWith('Figure'))).toBe(false)
})

it.each([
  'unknown-key',
  'foreign-paint',
  'foreign-text',
  'duplicate-owner',
  'dispose-drift',
  'unknown-glyph',
  'page-size'
])('rejects an incomplete or conflicting native key: %s', async (fault) => {
  expect(await fixture(fault)).toEqual([])
})
