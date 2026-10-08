import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { PDFDocument, PDFDict, PDFName, StandardFonts } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { PdfTranslationWriter } from './writer'
import { ApplicationCallerLeaseRegistry } from '../../caller-lifecycle'

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
      registry = new ApplicationCallerLeaseRegistry(),
      caller = registry.acquire({ leaseId: 'legacy-math', surface: 'electron' }),
      writer = new PdfTranslationWriter(() => resolve('resources/pdf-translation/worker.mjs')),
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
      registry = new ApplicationCallerLeaseRegistry(),
      caller = registry.acquire({ leaseId: 'calligraphic-math', surface: 'electron' }),
      writer = new PdfTranslationWriter(() => resolve('resources/pdf-translation/worker.mjs'))
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
      registry = new ApplicationCallerLeaseRegistry(),
      caller = registry.acquire({ leaseId: 'encoded-relation', surface: 'electron' }),
      writer = new PdfTranslationWriter(() => resolve('resources/pdf-translation/worker.mjs'))
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
