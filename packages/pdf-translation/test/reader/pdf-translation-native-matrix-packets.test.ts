import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import * as fontkit from 'fontkit'
import { PDFDocument, PDFDict, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { expect, it } from 'vitest'
import { extractPdfTranslationSource } from '../../src/reader/extraction.js'
import {
  sameNativeMatrixBody,
  createNativeMatrixReader,
  nativeMatrixOwners
} from '../../src/reader/native-matrix-packets.js'
import { getPdfTranslationTextContent } from '../../src/reader/text-content.js'

async function documentWithMatrix(
  fault = '',
  changed = false
): Promise<Awaited<ReturnType<typeof getDocument>['promise']>> {
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
    ),
    page = pdf.addPage([400, 500])
  page.drawText('Anonymous ordinary prose.', { x: 40, y: 440, font, size: 10 })
  const fontKey = page.node.Resources()!.lookup(PDFName.of('Font'), PDFDict).keys()[0].toString(),
    text = (str: string, x: number, y: number, size = 10): string =>
      `BT ${fontKey} ${size} Tf ${x} ${y} Td ${font.encodeText(str).toString()} Tj ET`
  page.node.set(
    PDFName.of('Contents'),
    pdf.context.register(
      pdf.context.flateStream(
        [
          text('I compare ordinary records.', 40, 440),
          text(fault === 'round' ? '(' : '[', 100, 300, 26),
          fault === 'spacing'
            ? `BT ${fontKey} 10 Tf 120 310 Td [${font.encodeText('1')} -25 ${font.encodeText('2')} 25 ${font.encodeText('3')}] TJ ET`
            : text(fault === 'digits' ? '123' : changed ? 'X' : 'I', 120, 310),
          text('B', 155, 310),
          text(fault === 'prose' ? 'Other words' : 'C', 120, 298),
          text('D', 180, 298),
          ...(fault === 'open' ? [] : [text(fault === 'round' ? ')' : ']', 210, 300, 26)]),
          text('The following ordinary paragraph remains eligible.', 40, 240)
        ].join('\n')
      )
    )
  )
  await font.embed()
  const dictionary = pdf.context.lookup(font.ref, PDFDict),
    cmap = dictionary.lookup(PDFName.of('ToUnicode'), PDFRawStream)
  if (fault !== 'literal-brackets')
    dictionary.set(
      PDFName.of('ToUnicode'),
      pdf.context.register(
        pdf.context.flateStream(
          new TextDecoder()
            .decode(decodePDFRawStream(cmap).decode())
            .replace(
              fault === 'round' ? /<0028>(?=\s*(?:\n|$))/giu : /<005b>(?=\s*(?:\n|$))/giu,
              '<0014>'
            )
            .replace(
              fault === 'round' ? /<0029>(?=\s*(?:\n|$))/giu : /<005d>(?=\s*(?:\n|$))/giu,
              '<0015>'
            )
        )
      )
    )
  return getDocument({
    data: await pdf.save(),
    fontExtraProperties: true,
    disableFontFace: true,
    isEvalSupported: false
  }).promise
}

it.each(['', 'open', 'prose', 'round'])(
  'protects complete native matrix owners without protecting exterior prose: %s',
  async (fault) => {
    const document = await documentWithMatrix(fault)
    try {
      const out = await extractPdfTranslationSource({
          document,
          resourceRequestKey: 'anonymous',
          signal: new AbortController().signal
        }),
        matrix = out.source.units.find((u) =>
          u.fragments.some((f) => f.items.some((i) => i.text === 'I'))
        )
      expect(matrix).toBeDefined()
      expect(matrix?.sourceOnly === true).toBe(fault === '')
      if (!fault) expect(matrix?.preserve).toBe('formula')
      expect(out.source.units.find((u) => u.source.startsWith('I compare'))?.sourceOnly).not.toBe(
        true
      )
      expect(
        out.source.units.find((u) => u.source.startsWith('The following'))?.sourceOnly
      ).not.toBe(true)
      expect(out.coverage.excludedItemCount).toBe(0)
    } finally {
      await document.destroy()
    }
  }
)

it('retains the original page when a saved target changes a native matrix letter', async () => {
  const source = await documentWithMatrix(),
    target = await documentWithMatrix('', true)
  try {
    const options = { nativeDocumentFactory: getDocument, signal: new AbortController().signal }
    expect(await sameNativeMatrixBody(source, source, 1, options)).toBe(true)
    expect(await sameNativeMatrixBody(source, target, 1, options)).toBe(false)
  } finally {
    await source.destroy()
    await target.destroy()
  }
})

it('does not authorize a changed, duplicated or mixed whole owner', async () => {
  const document = await documentWithMatrix()
  try {
    const extraction = await extractPdfTranslationSource({
        document,
        resourceRequestKey: 'anonymous',
        signal: new AbortController().signal
      }),
      page = await document.getPage(1),
      content = await getPdfTranslationTextContent(page),
      native = extraction.source.units.find((u) =>
        u.fragments.some((f) => f.items.some((i) => i.text === 'I'))
      )!,
      base = { ...native, sourceOnly: undefined, preserve: undefined },
      reader = createNativeMatrixReader({ document })
    try {
      expect(
        (
          await nativeMatrixOwners([base], page, content, page.getViewport({ scale: 1 }), 1, reader)
        ).has(base.id)
      ).toBe(true)
      for (const units of [
        [{ ...base, source: 'Invented source' }],
        [base, { ...base, id: 'duplicate' }],
        [
          {
            ...base,
            source: base.source + ' ordinary',
            fragments: [
              ...base.fragments,
              extraction.source.units.find((u) => u.source.startsWith('I compare'))!.fragments[0]
            ]
          }
        ]
      ])
        expect(
          (
            await nativeMatrixOwners(
              units,
              page,
              content,
              page.getViewport({ scale: 1 }),
              1,
              reader
            )
          ).has(base.id)
        ).toBe(false)
    } finally {
      await reader.dispose()
    }
  } finally {
    await document.destroy()
  }
})

it('retains a matrix when an interior glyph moves without changing the native text or total width', async () => {
  const source = await documentWithMatrix('digits'),
    target = await documentWithMatrix('spacing')
  try {
    const sourceContent = await (await source.getPage(1)).getTextContent(),
      targetContent = await (await target.getPage(1)).getTextContent(),
      original = sourceContent.items.find((item) => 'str' in item && item.str === '123'),
      moved = targetContent.items.find((item) => 'str' in item && item.str === '123')
    if (!original || !('str' in original) || !moved || !('str' in moved))
      throw new Error('Expected native matrix text')
    expect([moved.str, moved.width, moved.transform]).toEqual([
      original.str,
      original.width,
      original.transform
    ])
    const options = { nativeDocumentFactory: getDocument, signal: new AbortController().signal }
    expect(await sameNativeMatrixBody(source, source, 1, options)).toBe(true)
    expect(await sameNativeMatrixBody(source, target, 1, options)).toBe(false)
  } finally {
    await source.destroy()
    await target.destroy()
  }
})
