import { expect, it } from 'vitest'
import { resolve } from './paths.js'
import { PDFDocument, PDFDict, PDFName, PDFString, StandardFonts } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { PdfTranslationWriter } from '../src/writer.js'
import { TestCallerRegistry } from './support/callers.js'
import { engine } from '../resources/pdfium.mjs'

it.each([
  ['MSBM10', '点属于R3与R3；尺度属于R。', true],
  ['ABCDEF+MSBM9', '点属于R3与R3；尺度属于R。', true],
  ['CMSY10', '点属于R3与R3；尺度属于R。', true],
  ['MSBM10', '点属于N3与R3；尺度属于R。', false],
  ['MSBM10', '点属于3与R3；尺度属于R。', false],
  ['MSBM10', '点属于R3与R3；尺度属于R和R。', false]
] as const)(
  'keeps repeated legacy mathematical capitals and their native powers: %s / %s',
  async (name, translation, placed) => {
    const pdf = await PDFDocument.create(),
      prose = await pdf.embedFont(StandardFonts.TimesRoman),
      alphabet = await pdf.embedFont(StandardFonts.TimesRomanItalic),
      page = pdf.addPage([330, 220]),
      source = 'Points use R3 and R3; the scale uses R.',
      registry = new TestCallerRegistry(),
      caller = registry.acquire({ leaseId: 'native-math-alphabet', surface: 'electron' }),
      writer = new PdfTranslationWriter(() => resolve('resources/worker.mjs'))
    page.drawText('Points use ', { font: prose, size: 10, x: 40, y: 150 })
    page.drawText('R', { font: alphabet, size: 10, x: 90, y: 150 })
    page.drawText('3', { font: prose, size: 7, x: 97, y: 154 })
    page.drawText(' and ', { font: prose, size: 10, x: 105, y: 150 })
    page.drawText('R', { font: alphabet, size: 10, x: 130, y: 150 })
    page.drawText('3', { font: prose, size: 7, x: 137, y: 154 })
    page.drawText('; the scale uses ', { font: prose, size: 10, x: 145, y: 150 })
    page.drawText('R', { font: alphabet, size: 10, x: 215, y: 150 })
    page.drawText('.', { font: prose, size: 10, x: 223, y: 150 })
    page.drawText('Neighbor', { font: prose, size: 10, x: 40, y: 110 })
    await pdf.flush()
    pdf.context.lookup(alphabet.ref, PDFDict).set(PDFName.of('BaseFont'), PDFName.of(name))
    const data = await pdf.save(),
      native = await engine(),
      at = native.alloc(24)
    const inspect = (
      bytes: Uint8Array
    ): Array<{
      text: string
      font: string
      size: number
      matrix: number[]
      bounds: number[]
    }> => {
      const document = native.open(bytes),
        original = native.p.FPDF_LoadPage(document.doc, 0)
      try {
        return native
          .objects(original)
          .filter((o) => o.type === 1)
          .map((o) => {
            expect(native.p.FPDFPageObj_GetMatrix(o.obj, at)).toBeTruthy()
            const matrix = [...native.m.HEAPF32.slice(at / 4, at / 4 + 6)]
            expect(native.p.FPDFTextObj_GetFontSize(o.obj, at)).toBeTruthy()
            const size = native.m.HEAPF32[at / 4],
              font = native.p.FPDFTextObj_GetFont(o.obj),
              length = native.p.FPDFFont_GetBaseFontName(font, 0, 0),
              buffer = native.alloc(length)
            try {
              native.p.FPDFFont_GetBaseFontName(font, buffer, length)
              return {
                text: o.text.trim(),
                font: Buffer.from(native.m.HEAPU8.slice(buffer, buffer + length - 1)).toString(),
                size,
                matrix,
                bounds: o.bounds
              }
            } finally {
              native.free(buffer)
            }
          })
      } finally {
        native.p.FPDF_ClosePage(original)
        document.close()
      }
    }
    let rendered: ReturnType<typeof getDocument> | undefined
    try {
      const output = await writer.generate(
        {
          id: 'native-math-alphabet',
          data,
          pages: [{ width: 330, height: 220 }],
          preserveUnsupported: true,
          units: [
            {
              source,
              translation,
              fragments: [
                {
                  pageNumber: 1,
                  rect: { x: 39 / 330, y: 61 / 220, width: 190 / 330, height: 17 / 220 }
                }
              ]
            }
          ]
        },
        caller.lease
      )
      const original = inspect(data),
        actual = inspect(output!),
        before = original.filter((o) => o.text === 'R'),
        after = actual.filter((o) => o.text === 'R' && o.font === name)
      expect(before).toHaveLength(3)
      expect(after).toHaveLength(3)
      before.forEach((o, index) => {
        expect(after[index].font).toBe(o.font)
        expect(after[index].size).toBeCloseTo(o.size, 4)
        o.matrix
          .slice(0, 4)
          .forEach((v, axis) => expect(after[index].matrix[axis]).toBeCloseTo(v, 4))
        expect(after[index].bounds[2] - after[index].bounds[0]).toBeCloseTo(
          o.bounds[2] - o.bounds[0],
          3
        )
        if (!placed) expect(after[index]).toEqual(o)
      })
      for (const power of actual.filter((o) => o.text === '3'))
        expect(
          after.some(
            (base) =>
              power.size < base.size * 0.85 &&
              power.matrix[5] - base.matrix[5] > base.size * 0.2 &&
              power.matrix[5] - base.matrix[5] < base.size * 0.7 &&
              power.bounds[0] >= base.bounds[2] - 1 &&
              power.bounds[0] <= base.bounds[2] + 5
          )
        ).toBe(true)
      expect(actual.filter((o) => o.text === '3')).toHaveLength(2)
      expect(actual.find((o) => o.text === 'Neighbor')).toEqual(
        original.find((o) => o.text === 'Neighbor')
      )
      rendered = getDocument({ data: output!.slice(), useSystemFonts: true })
      const text = (await (await (await rendered.promise).getPage(1)).getTextContent()).items
        .filter((o) => 'str' in o)
        .map((o) => o.str)
        .join('')
        .replace(/\s/gu, '')
      expect(text).toBe((placed ? translation : source).replace(/\s/gu, '') + 'Neighbor')
    } finally {
      await rendered?.destroy()
      native.free(at)
      caller.release()
      registry.dispose()
    }
  }
)

it.each([
  ['TeX-matha10', 'p q P r', true],
  ['ABCDEF+TeX-matha10', 'p q P r', true],
  ['CMSY10', 'p q P r', true],
  ['CMEX10', 'b e', true],
  ['Helvetica', 'p q P r', false],
  ['CMMI10', 'p q P r', false],
  ['CMR10', 'p q P r', false],
  ['TeX-matha10', '0 1', true]
] as const)(
  'protects unresolved slots in a named legacy symbol font: %s / %s',
  async (name, symbols, protectedFont) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica),
      prose = await pdf.embedFont(StandardFonts.TimesRoman),
      page = pdf.addPage([300, 200])
    page.drawText('Relative distance:', { font: prose, x: 40, y: 150, size: 10 })
    page.drawText(symbols, { font, x: 120, y: 150, size: 10 })
    page.drawText('Neighbor', { font: prose, x: 40, y: 110, size: 10 })
    await pdf.flush()
    pdf.context.lookup(font.ref, PDFDict).set(PDFName.of('BaseFont'), PDFName.of(name))
    const data = await pdf.save(),
      registry = new TestCallerRegistry(),
      caller = registry.acquire({ leaseId: 'legacy-math', surface: 'electron' }),
      writer = new PdfTranslationWriter(() => resolve('resources/worker.mjs')),
      source = 'Relative distance: ' + symbols
    let task: ReturnType<typeof getDocument> | undefined
    try {
      const request = {
        id: 'legacy-math',
        data,
        pages: [{ width: 300, height: 200 }],
        units: [
          {
            source,
            translation: '相对距离：' + symbols,
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 39 / 300, y: 38 / 200, width: 190 / 300, height: 15 / 200 }
              }
            ]
          }
        ]
      }
      if (protectedFont)
        await expect(writer.generate(request, caller.lease)).rejects.toMatchObject({
          failure: { code: 'unsupported-layout' }
        })
      task = getDocument({
        data: (await writer.generate({ ...request, preserveUnsupported: true }, caller.lease))!,
        useSystemFonts: true
      })
      const items = (await (await task.promise).getPage(1)).getTextContent()
      const text = (await items).items.filter((item) => 'str' in item)
      expect(
        text
          .map((item) => item.str)
          .join('')
          .replace(/\s/gu, '')
      ).toBe(
        (protectedFont ? source : request.units[0].translation).replace(/\s/gu, '') + 'Neighbor'
      )
      expect(text.find((item) => item.str === 'Neighbor')?.transform.slice(4)).toEqual([40, 110])
      await task.destroy()
      task = undefined
      if (protectedFont) {
        task = getDocument({
          data: (await writer.generate(
            { ...request, units: [{ ...request.units[0], translation: source }] },
            caller.lease
          ))!,
          useSystemFonts: true
        })
        expect(
          (await (await (await task.promise).getPage(1)).getTextContent()).items
            .filter((item) => 'str' in item)
            .map((item) => item.str)
            .join('')
            .replace(/\s/gu, '')
        ).toBe(source.replace(/\s/gu, '') + 'Neighbor')
      }
    } finally {
      await task?.destroy()
      caller.release()
      registry.dispose()
    }
  }
)

it.each([
  ['CMSY10', '函数F映射每个样本。', true],
  ['ABCDEF+CMSY9', '函数F映射每个样本。', true],
  ['CMSY10', '函数X映射每个样本。', false],
  ['CMSY10', '函数映射每个样本。', false],
  ['CMSY10', '函数F和F映射每个样本。', false],
  ['CMSY10', '函数AF映射每个样本。', false],
  ['CMSY10', '函数Falpha映射每个样本。', false],
  ['CMEX10', '函数F映射每个样本。', false],
  ['TeX-matha10', '函数F映射每个样本。', false]
] as const)(
  'keeps a native calligraphic variable while translating prose: %s / %s',
  async (name, translation, replaced) => {
    const pdf = await PDFDocument.create(),
      prose = await pdf.embedFont(StandardFonts.TimesRoman),
      symbol = await pdf.embedFont(StandardFonts.TimesRomanItalic),
      page = pdf.addPage([300, 200]),
      registry = new TestCallerRegistry(),
      caller = registry.acquire({ leaseId: 'calligraphic-math', surface: 'electron' }),
      writer = new PdfTranslationWriter(() => resolve('resources/worker.mjs'))
    page.drawText('The function ', { font: prose, size: 10, x: 40, y: 150 })
    page.drawText('F', { font: symbol, size: 10, x: 95, y: 150 })
    page.drawText(' maps each sample.', { font: prose, size: 10, x: 102, y: 150 })
    page.drawText('Neighbor', { font: prose, size: 10, x: 40, y: 110 })
    await pdf.flush()
    pdf.context.lookup(symbol.ref, PDFDict).set(PDFName.of('BaseFont'), PDFName.of(name))
    const data = await pdf.save(),
      source = 'The function F maps each sample.',
      original = getDocument({ data: data.slice(), useSystemFonts: true })
    let task: ReturnType<typeof getDocument> | undefined
    try {
      const output = await writer.generate(
        {
          id: 'calligraphic-math',
          data,
          pages: [{ width: 300, height: 200 }],
          preserveUnsupported: true,
          units: [
            {
              source,
              translation,
              fragments: [
                {
                  pageNumber: 1,
                  rect: { x: 39 / 300, y: 38 / 200, width: 185 / 300, height: 16 / 200 }
                }
              ]
            },
            {
              source: 'Neighbor',
              translation: '邻段',
              fragments: [
                {
                  pageNumber: 1,
                  rect: { x: 39 / 300, y: 78 / 200, width: 100 / 300, height: 16 / 200 }
                }
              ]
            }
          ]
        },
        caller.lease
      )
      task = getDocument({ data: output!, useSystemFonts: true })
      const originalItems = (
          await (await (await original.promise).getPage(1)).getTextContent()
        ).items.filter((item) => 'str' in item),
        targetItems = (await (await (await task.promise).getPage(1)).getTextContent()).items.filter(
          (item) => 'str' in item
        ),
        originalVariable = originalItems.find((item) => item.str === 'F')!,
        targetVariable = targetItems.find((item) => item.str === 'F')!
      expect(
        targetItems
          .map((item) => item.str)
          .join('')
          .replace(/\s/gu, '')
      ).toBe((replaced ? translation : source).replace(/\s/gu, '') + '邻段')
      expect(targetVariable).toBeDefined()
      expect(targetVariable.width).toBeCloseTo(originalVariable.width, 4)
      expect(targetVariable.height).toBeCloseTo(originalVariable.height, 4)
      targetVariable.transform
        .slice(0, 4)
        .forEach((value, index) => expect(value).toBeCloseTo(originalVariable.transform[index], 4))
      if (!replaced)
        targetVariable.transform
          .slice(4)
          .forEach((value, index) =>
            expect(value).toBeCloseTo(originalVariable.transform[index + 4], 4)
          )
    } finally {
      await original.destroy()
      await task?.destroy()
      caller.release()
      registry.dispose()
    }
  }
)

it.each([
  ['CMSY10', '参数 |A| \u001c |B| 保持不变。', undefined],
  ['ABCDEF+CMSY9', '参数 |A| \u001c |B| 保持不变。', undefined],
  ['Helvetica', '参数 |A| \u001c |B| 保持不变。', 'font'],
  ['CMR10', '参数 |A| \u001c |B| 保持不变。', 'font'],
  ['CMSY10', '参数 |A| = |B| 保持不变。', 'annotations'],
  ['CMSY10', '参数 |A| \u001c |B| 和 |A| \u001c |B|。', 'annotations'],
  ['CMSY10', '参数 |A| \u001c |B| 保持不变。🧪', 'font']
] as const)(
  'preserves exact native relation controls and isolates unrenderable targets: %s / %s',
  async (name, translation, failure) => {
    // A legacy CMSY font can expose the relation run as
    // "| U+001C |". Use a real ToUnicode mapping and complete native run;
    // the ordinary-font cases must not inherit the math-font exception.
    const pdf = await PDFDocument.create(),
      prose = await pdf.embedFont(StandardFonts.TimesRoman),
      symbol = await pdf.embedFont(StandardFonts.Helvetica),
      page = pdf.addPage([300, 200]),
      registry = new TestCallerRegistry(),
      caller = registry.acquire({ leaseId: 'encoded-relation', surface: 'electron' }),
      writer = new PdfTranslationWriter(() => resolve('resources/worker.mjs'))
    page.drawText('Parameters |A', { font: prose, size: 10, x: 40, y: 150 })
    const x = 40 + prose.widthOfTextAtSize('Parameters |A', 10)
    page.drawText('| < |', { font: symbol, size: 10, x, y: 150 })
    page.drawText('B| remain unchanged.', {
      font: prose,
      size: 10,
      x: x + symbol.widthOfTextAtSize('| < |', 10),
      y: 150
    })
    page.drawText('Neighbor', { font: prose, size: 10, x: 40, y: 110 })
    await pdf.flush()
    const dictionary = pdf.context.lookup(symbol.ref, PDFDict)
    dictionary.set(PDFName.of('BaseFont'), PDFName.of(name))
    dictionary.set(
      PDFName.of('ToUnicode'),
      pdf.context.register(
        pdf.context.stream(
          '/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n' +
            '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n' +
            '/CMapName /Relation def /CMapType 2 def\n' +
            '1 begincodespacerange <00> <FF> endcodespacerange\n' +
            '1 beginbfchar <3C> <001C> endbfchar\n' +
            'endcmap CMapName currentdict /CMap defineresource pop end end'
        )
      )
    )
    const data = await pdf.save(),
      source = 'Parameters |A| \u001c |B| remain unchanged.',
      request = {
        id: 'encoded-relation',
        data,
        pages: [{ width: 300, height: 200 }],
        units: [
          {
            source,
            translation,
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 39 / 300, y: 38 / 200, width: 240 / 300, height: 16 / 200 }
              }
            ]
          },
          {
            source: 'Neighbor',
            translation: '邻段',
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 39 / 300, y: 78 / 200, width: 100 / 300, height: 16 / 200 }
              }
            ]
          }
        ]
      },
      original = getDocument({ data: data.slice(), useSystemFonts: true })
    let target: ReturnType<typeof getDocument> | undefined
    try {
      if (failure)
        await expect(writer.generate(request, caller.lease)).rejects.toMatchObject({
          failure: { code: failure }
        })
      const output = await writer.generateDetailed(
        { ...request, preserveUnsupported: true },
        caller.lease
      )
      expect(output!.layoutFailures).toEqual(
        failure
          ? [{ unitIndex: 0, code: failure, phase: 'planning', pageNumbers: [1], fragmentCount: 1 }]
          : []
      )
      target = getDocument({ data: output!.data, useSystemFonts: true })
      const items = (await (await (await target.promise).getPage(1)).getTextContent()).items.filter(
          (item) => 'str' in item
        ),
        originalItems = (
          await (await (await original.promise).getPage(1)).getTextContent()
        ).items.filter((item) => 'str' in item),
        before = originalItems.find((item) => item.str.includes('\u001c'))!,
        after = items.find((item) => item.str.includes('\u001c'))!
      expect(
        items
          .map((item) => item.str)
          .join('')
          .replace(/\s/gu, '')
      ).toBe((failure ? source : translation).replace(/\s/gu, '') + '邻段')
      expect(after.width).toBeCloseTo(before.width, 4)
      expect(after.height).toBeCloseTo(before.height, 4)
      after.transform
        .slice(0, 4)
        .forEach((value, index) => expect(value).toBeCloseTo(before.transform[index], 4))
    } finally {
      await original.destroy()
      await target?.destroy()
      caller.release()
      registry.dispose()
    }
  }
)

it.each([
  ['CMSY10', '\u0338∼', '\u0338∼', true],
  ['ABCDEF+CMSY9', '\u0338∈', '\u0338∈', true],
  ['Helvetica', '\u0338∼', '\u0338∼', false],
  ['CMSY10', '\u0338∼', '∼', false],
  ['CMSY10', '\u0338∼', '∼\u0338', false],
  ['CMSY10', '\u0338∼', '\u0338∈', false],
  ['CMSY10', '\u0338∼', '\u0338∼\u0338∼', false]
] as const)(
  'preserves a complete owned native negated relation without guessing its target: %s / %s / %s',
  async (name, relation, translatedRelation, replaced) => {
    const pdf = await PDFDocument.create(),
      prose = await pdf.embedFont(StandardFonts.TimesRoman),
      symbol = await pdf.embedFont(StandardFonts.Helvetica),
      page = pdf.addPage([300, 200]),
      registry = new TestCallerRegistry(),
      caller = registry.acquire({ leaseId: 'native-negated-relation' }),
      prefix = 'The relation u ',
      suffix = ' v is unchanged.',
      x = 40 + prose.widthOfTextAtSize(prefix, 10)
    page.drawText(prefix, { font: prose, size: 10, x: 40, y: 150 })
    // A complete two-code glyph object supplies the original paint. Its
    // ToUnicode text describes the slash followed by the native relation.
    page.drawText('/~', { font: symbol, size: 10, x, y: 150 })
    page.drawText(suffix, {
      font: prose,
      size: 10,
      x: x + symbol.widthOfTextAtSize('/~', 10),
      y: 150
    })
    page.drawText('Independent neighbor.', { font: prose, size: 10, x: 40, y: 110 })
    await pdf.flush()
    const dictionary = pdf.context.lookup(symbol.ref, PDFDict)
    dictionary.set(PDFName.of('BaseFont'), PDFName.of(name))
    dictionary.set(
      PDFName.of('ToUnicode'),
      pdf.context.register(
        pdf.context.stream(
          '/CIDInit /ProcSet findresource begin 12 dict begin begincmap ' +
            '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def ' +
            '/CMapName /NativeRelation def /CMapType 2 def ' +
            '1 begincodespacerange <00> <FF> endcodespacerange ' +
            '2 beginbfchar <2F> <0338> <7E> <' +
            (relation.endsWith('∈') ? '2208' : '223C') +
            '> endbfchar ' +
            'endcmap CMapName currentdict /CMap defineresource pop end end'
        )
      )
    )
    const source = prefix + relation + suffix,
      translation = `关系 u ${translatedRelation} v 保持不变。`
    try {
      const output = await new PdfTranslationWriter(() =>
        resolve('resources/worker.mjs')
      ).generateDetailed(
        {
          id: 'native-negated-relation',
          data: await pdf.save(),
          pages: [{ width: 300, height: 200 }],
          preserveUnsupported: true,
          units: [
            {
              source,
              translation,
              fragments: [
                {
                  pageNumber: 1,
                  rect: { x: 39 / 300, y: 37 / 200, width: 230 / 300, height: 20 / 200 }
                }
              ]
            }
          ]
        },
        caller.lease
      )
      expect(output!.layoutFailures).toHaveLength(replaced ? 0 : 1)
      const task = getDocument({ data: output!.data.slice(), useSystemFonts: true })
      try {
        const document = await task.promise,
          text = (await (await document.getPage(1)).getTextContent()).items
            .map((item) => ('str' in item ? item.str : ''))
            .join('')
            .replace(/\s/gu, '')
        expect(text).toContain('Independentneighbor.')
        expect(text).toContain((replaced ? translation : source).replace(/\s/gu, ''))
        if (!replaced) expect(text).not.toContain('关系')
      } finally {
        await task.destroy()
      }
    } finally {
      caller.release()
      registry.dispose()
    }
  }
)

it.each([
  'dense',
  'separate-paragraph',
  'changed-symbol',
  'dense-ordinal',
  'separate-ordinal',
  'linked-ordinal'
])('keeps an inline native alphabet beside compacted prose: %s', async (kind) => {
  const pdf = await PDFDocument.create(),
    prose = await pdf.embedFont(StandardFonts.TimesRoman),
    alphabet = await pdf.embedFont(StandardFonts.TimesRomanItalic),
    page = pdf.addPage([380, 220]),
    ordinal = kind.endsWith('-ordinal'),
    gap = kind === 'separate-paragraph' || kind === 'separate-ordinal' ? 24 : 12,
    nativeX = ordinal ? 340 : 320,
    source =
      (ordinal ? '(6) ' : '') +
      'Every measured network has the same interval representation for all k in N with the same independent labelling.',
    translation = `${ordinal ? '(6) ' : ''}所有测量网络对于每个 k in ${kind === 'changed-symbol' ? 'R' : 'N'} 都具有相同的区间表示和独立标号。`,
    registry = new TestCallerRegistry(),
    caller = registry.acquire({ leaseId: 'inline-native-alphabet', surface: 'electron' })
  if (ordinal) page.drawText('(6) ', { font: prose, size: 10, x: 40, y: 150 })
  page.drawText('Every measured network has the same interval representation for all k in ', {
    font: prose,
    size: 10,
    x: ordinal ? 56 : 40,
    y: 150
  })
  page.drawText('N', { font: alphabet, size: 10, x: nativeX, y: 150 })
  page.drawText('with the same independent labelling.', {
    font: prose,
    size: 10,
    x: 40,
    y: 150 - gap
  })
  page.drawText('Neighbor 17', { font: prose, size: 10, x: 40, y: 90 })
  if (kind === 'linked-ordinal')
    page.node.set(
      PDFName.of('Annots'),
      pdf.context.obj([
        pdf.context.register(
          pdf.context.obj({
            Type: 'Annot',
            Subtype: 'Link',
            Rect: [39, 147, 55, 158],
            Border: [0, 0, 0],
            A: { S: 'URI', URI: PDFString.of('https://example.invalid/item') }
          })
        )
      ])
    )
  await pdf.flush()
  pdf.context.lookup(alphabet.ref, PDFDict).set(PDFName.of('BaseFont'), PDFName.of('MSBM10'))
  let task: ReturnType<typeof getDocument> | undefined
  try {
    const output = new PdfTranslationWriter(() => resolve('resources/worker.mjs')).generate(
      {
        id: 'inline-native-alphabet',
        data: await pdf.save(),
        pages: [{ width: 380, height: 220 }],
        units: [
          {
            source,
            translation,
            fragments: [
              {
                pageNumber: 1,
                rect: {
                  x: 39 / 380,
                  y: 60 / 220,
                  width: (ordinal ? 320 : 300) / 380,
                  height: (gap + 18) / 220
                }
              }
            ]
          }
        ]
      },
      caller.lease
    )
    if (kind === 'changed-symbol') {
      await expect(output).rejects.toMatchObject({ failure: { code: 'annotations' } })
      return
    }
    task = getDocument({ data: (await output)!, useSystemFonts: true })
    const document = await task.promise,
      items = (await (await document.getPage(1)).getTextContent()).items.filter(
        (item) => 'str' in item
      ),
      letter = items.find((item) => item.str === 'N')!
    expect(
      items
        .map((item) => item.str)
        .join('')
        .replace(/\s/gu, '')
    ).toBe((translation + 'Neighbor 17').replace(/\s/gu, ''))
    expect(letter.height).toBe(10)
    if (kind === 'dense' || kind === 'dense-ordinal') expect(letter.transform[4]).toBeLessThan(250)
    else expect(letter.transform.slice(4)).toEqual([nativeX, 150])
    if (kind === 'linked-ordinal')
      expect((await (await document.getPage(1)).getAnnotations())[0].rect).toEqual([
        39, 147, 55, 158
      ])
    expect(items.find((item) => item.str === 'Neighbor 17')?.transform.slice(4)).toEqual([40, 90])
  } finally {
    await task?.destroy()
    caller.release()
    registry.dispose()
  }
})
