import { pdfTranslationLayoutFragments } from '../../../renderer/src/pages/workspace/previews/renderers/pdf-translation-fragments'
import { createPdfTranslationSource } from '../../../renderer/src/pages/workspace/previews/renderers/pdf-translation'
import { readPdfTranslationCases } from '../../../../test/fixtures/pdf-translation/read-cases'
import { extractPdfTranslationSource } from '../../../renderer/src/pages/workspace/previews/renderers/pdf-translation-extraction'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve, join, dirname, relative, isAbsolute } from 'node:path'
import { tmpdir } from 'node:os'
import { createPackageWithOptions, statFile } from '@electron/asar'
import { load } from 'js-yaml'
import { describe, expect, it, vi } from 'vitest'
import {
  PDFDocument,
  PDFArray,
  PDFDict,
  PDFRawStream,
  type PDFFont,
  PDFName,
  PDFString,
  decodePDFRawStream,
  StandardFonts,
  clip,
  concatTransformationMatrix,
  degrees,
  endPath,
  rectangle,
  rgb,
  setGraphicsState,
  pushGraphicsState,
  popGraphicsState
} from 'pdf-lib'
import { createCanvas } from '@napi-rs/canvas'
import type { PDFPageProxy } from 'pdfjs-dist'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { PdfTranslationWriter } from './writer'
import { ApplicationCallerLeaseRegistry } from '../../caller-lifecycle'
import {
  PdfGenerationError,
  pdfGenerationFailure,
  type PdfTranslationPdfRequest
} from '../../../shared/pdf-translation'

it.each([
  'plus',
  'minus',
  'changed',
  'extra',
  'missing',
  'boundary',
  'arithmetic',
  'unchanged'
] as const)(
  'preserves or safely rejects native signed subscripts: %s',
  async (kind) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.TimesRoman),
      page = pdf.addPage([400, 300]),
      caller = lease(),
      sign = kind === 'minus' ? '−' : '+',
      source = `Use s${sign} for attention.`,
      translation =
        kind === 'unchanged'
          ? source
          : kind === 'changed'
            ? '使用s−进行注意力计算。'
            : kind === 'extra'
              ? '使用s+和s+进行注意力计算。'
              : kind === 'missing'
                ? '进行注意力计算。'
                : kind === 'boundary'
                  ? '使用s+_进行注意力计算。'
                  : kind === 'arithmetic'
                    ? '使用s+2进行注意力计算。'
                    : `使用s${sign}进行注意力计算。`
    const symbol = await pdf.embedFont(StandardFonts.Symbol)
    page.drawText('Use ', { font, size: 10, x: 30, y: 250 })
    page.drawText('s', { font, size: 10, x: 60, y: 250 })
    page.drawText(sign, { font: sign === '−' ? symbol : font, size: 7, x: 64.5, y: 248.5 })
    page.drawText(' for attention.', { font, size: 10, x: 75, y: 250 })
    page.drawText('Neighbor', { font, size: 10, x: 30, y: 180 })
    const data = await pdf.save()
    let task: ReturnType<typeof getDocument> | undefined
    try {
      const result = await new PdfTranslationWriter(entry).generateDetailed(
        {
          id: 'signed-script',
          data,
          pages: [{ width: 400, height: 300 }],
          units: [
            {
              source,
              translation,
              fragments: [
                {
                  pageNumber: 1,
                  rect: { x: 25 / 400, y: 35 / 300, width: 350 / 400, height: 35 / 300 }
                }
              ]
            }
          ],
          preserveUnsupported: true
        },
        caller.lease
      )
      if (['changed', 'extra', 'missing', 'boundary', 'arithmetic'].includes(kind)) {
        expect(result!.layoutFailures).toEqual([
          expect.objectContaining({ code: 'unsupported-layout' })
        ])
        expect(result!.data).toEqual(data)
      } else if (kind === 'unchanged') {
        expect(result!.layoutFailures).toEqual([])
        expect(result!.data).toEqual(data)
      } else {
        expect(result!.layoutFailures).toEqual([])
        task = getDocument({ data: result!.data.slice(), useSystemFonts: true })
        const items = (await (await (await task.promise).getPage(1)).getTextContent()).items.filter(
            (item) => 'str' in item
          ),
          base = items.find((item) => item.str.trim() === 's')!,
          script = items.find((item) => item.str.trim() === sign)!
        expect(base).toBeDefined()
        expect(script).toBeDefined()
        expect(base.transform[0]).toBeCloseTo(10, 4)
        expect(script.transform[0]).toBeCloseTo(7, 4)
        expect(script.transform[5] - base.transform[5]).toBeCloseTo(-1.5, 3)
        expect(script.transform[4] - base.transform[4]).toBeCloseTo(4.5, 3)
      }
    } finally {
      await task?.destroy()
      caller.release()
    }
  },
  15000
)

it.each([
  'nested',
  'comparison',
  'changed',
  'missing',
  'extra',
  'prime',
  'unchanged',
  'same-level',
  'same-point',
  'distant'
] as const)(
  'protects native cascading subscripts without flattening: %s',
  async (kind) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.TimesRoman),
      page = pdf.addPage([600, 800]),
      caller = lease(),
      suffix = kind === 'comparison' ? '<t' : 't',
      token = 'xz' + suffix,
      source = `We predict ${token} using context.`,
      translation =
        kind === 'unchanged'
          ? source
          : kind === 'changed'
            ? '我们根据上下文预测xzj。'
            : kind === 'missing'
              ? '我们根据上下文预测。'
              : kind === 'extra'
                ? `我们根据上下文预测${token}与${token}。`
                : kind === 'prime'
                  ? `我们根据上下文预测${token}′。`
                  : `我们根据上下文预测${token}。`,
      lowerPoint = kind === 'same-point' ? 10 : 7,
      innerPoint = kind === 'same-point' ? 10 : 5,
      lowerY = 698.5,
      innerY = kind === 'same-level' ? lowerY : 697.5,
      lowerX = 160 + font.widthOfTextAtSize('x', 10),
      innerX = lowerX + font.widthOfTextAtSize('z', lowerPoint) + (kind === 'distant' ? 20 : 0)
    page.drawText('We predict ', { font, size: 10, x: 40, y: 700 })
    page.drawText('x', { font, size: 10, x: 160, y: 700 })
    page.drawText('z', { font, size: lowerPoint, x: lowerX, y: lowerY })
    page.drawText(suffix, { font, size: innerPoint, x: innerX, y: innerY })
    page.drawText(' using context.', { font, size: 10, x: 220, y: 700 })
    page.drawText('Unchanged neighbor', { font, size: 10, x: 40, y: 630 })
    const data = await pdf.save()
    let loading: ReturnType<typeof getDocument> | undefined
    try {
      const output = await new PdfTranslationWriter(entry).generateDetailed(
        {
          id: 'cascading-native-subscripts',
          data,
          pages: [{ width: 600, height: 800 }],
          preserveUnsupported: true,
          units: [
            {
              source,
              translation,
              fragments: [
                {
                  pageNumber: 1,
                  rect: { x: 35 / 600, y: 88 / 800, width: 520 / 600, height: 35 / 800 }
                }
              ]
            }
          ]
        },
        caller.lease
      )
      if (['changed', 'missing', 'extra', 'prime'].includes(kind)) {
        expect(output!.layoutFailures).toEqual([
          expect.objectContaining({ code: 'unsupported-layout', unitIndex: 0 })
        ])
        expect(output!.data).toEqual(data)
      } else if (kind === 'unchanged') {
        expect(output!.layoutFailures).toEqual([])
        expect(output!.data).toEqual(data)
      } else {
        expect(output!.layoutFailures).toEqual([])
        loading = getDocument({ data: output!.data.slice(), useSystemFonts: true })
        const items = (await (await (await loading.promise).getPage(1)).getTextContent()).items
        expect(
          items
            .filter((item) => 'str' in item)
            .map((item) => item.str)
            .join('')
            .replace(/\s/gu, '')
        ).toContain(translation)
        if (kind === 'nested' || kind === 'comparison') {
          const original = getDocument({ data: data.slice(), useSystemFonts: true })
          try {
            const before = (
              await (await (await original.promise).getPage(1)).getTextContent()
            ).items.filter((item) => 'str' in item)
            const after = items.filter((item) => 'str' in item)
            const a = ['x', 'z', suffix].map((label) =>
              before.find((item) => item.str.trim() === label)!
            )
            const b = ['x', 'z', suffix].map((label) =>
              after.find((item) => item.str.trim() === label)!
            )
            for (let i = 0; i < a.length; i++) {
              expect(b[i]).toBeDefined()
              expect(b[i].transform.slice(0, 4)).toEqual(a[i].transform.slice(0, 4))
              expect(b[i].width).toBeCloseTo(a[i].width, 3)
              for (const axis of [4, 5])
                expect(b[i].transform[axis] - b[0].transform[axis]).toBeCloseTo(
                  a[i].transform[axis] - a[0].transform[axis],
                  3
                )
            }
          } finally {
            await original.destroy()
          }
        }
      }
    } finally {
      await loading?.destroy()
      caller.release()
    }
  },
  15_000
)

it.each([0, 1, 3])(
  'reserves a wrapped native URI left click padding of %s points',
  async (padding) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.TimesRoman),
      mono = await pdf.embedFont(StandardFonts.Courier),
      page = pdf.addPage([600, 800]),
      caller = lease()
    const labels = ['https://example.invalid/', 'team/demo-parser'],
      uri = labels.join(''),
      rows = [
        { x: 350, y: 700 },
        { x: 40, y: 688 }
      ],
      point = 9
    page.drawText('Our implementation is based on ', { font, x: 40, y: 700, size: point })
    for (const [i, label] of labels.entries())
      page.drawText(label, { font: mono, ...rows[i], size: point })
    page.drawText(' and matches the reported accuracy.', { font, x: 160, y: 688, size: point })
    page.drawText('Neighbor 27', { font, x: 40, y: 640, size: point })
    page.node.set(
      PDFName.of('Annots'),
      pdf.context.obj(
        labels.map((label, i) =>
          pdf.context.register(
            pdf.context.obj({
              Type: 'Annot',
              Subtype: 'Link',
              Rect: [
                rows[i].x - padding,
                rows[i].y - 2,
                rows[i].x + mono.widthOfTextAtSize(label, point) + 1,
                rows[i].y + 9
              ],
              A: { S: 'URI', URI: PDFString.of(uri) }
            })
          )
        )
      )
    )
    const bytes = await pdf.save(),
      original = getDocument({ data: bytes.slice(), useSystemFonts: true }),
      source =
        'Our implementation is based on ' +
        labels.join(' ') +
        ' and matches the reported accuracy.',
      translation = '我们的实现基于' + uri + '，并达到报告中的准确率。'
    let task: ReturnType<typeof getDocument> | undefined
    try {
      const result = await new PdfTranslationWriter(entry).generateDetailed(
        {
          id: 'native-wrapped-left-padding',
          data: bytes,
          pages: [{ width: 600, height: 800 }],
          preserveUnsupported: true,
          units: [
            {
              source,
              translation,
              fragments: [
                {
                  pageNumber: 1,
                  rect: { x: 36 / 600, y: 89 / 800, width: 518 / 600, height: 30 / 800 }
                }
              ]
            }
          ]
        },
        caller.lease
      )
      expect(result!.layoutFailures).toEqual([])
      task = getDocument({ data: result!.data, useSystemFonts: true })
      const oldPage = await (await original.promise).getPage(1),
        newPage = await (await task.promise).getPage(1),
        before = (await oldPage.getTextContent()).items.filter((i) => 'str' in i),
        after = (await newPage.getTextContent()).items.filter((i) => 'str' in i),
        beforeLinks = await oldPage.getAnnotations(),
        afterLinks = await newPage.getAnnotations()
      expect(
        after
          .filter((i) => i.transform[5] > 670)
          .map((i) => i.str)
          .join('')
          .replace(/\s/gu, '')
      ).toBe(translation)
      expect(afterLinks).toHaveLength(2)
      for (const [index, label] of labels.entries()) {
        const a = before.find((i) => i.str === label)!,
          b = after.find((i) => i.str === label)!,
          link = afterLinks[index],
          old = beforeLinks[index]
        expect(b.transform.slice(0, 4)).toEqual(a.transform.slice(0, 4))
        expect(b.width).toBeCloseTo(a.width, 3)
        expect(link.url).toBe(uri)
        for (const [lo, hi] of [
          [0, 2],
          [1, 3]
        ])
          expect(link.rect[hi] - link.rect[lo]).toBeCloseTo(old.rect[hi] - old.rect[lo], 3)
        for (const [axis, rectAxis] of [
          [4, 0],
          [5, 1]
        ])
          expect(b.transform[axis] - link.rect[rectAxis]).toBeCloseTo(
            a.transform[axis] - old.rect[rectAxis],
            3
          )
      }
      expect(after.find((i) => i.str === 'Neighbor 27')?.transform).toEqual(
        before.find((i) => i.str === 'Neighbor 27')?.transform
      )
    } finally {
      await task?.destroy()
      await original.destroy()
      caller.release()
    }
  }
)

it.each(['empty', 'painted', 'inherited', 'single-page', 'unchanged', 'retained'] as const)(
  'isolates shared graphics states before regenerating pages (%s)',
  async (kind) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica),
      states = pdf.context.obj({
        ...(kind === 'empty'
          ? {}
          : {
              Alpha: pdf.context.register(pdf.context.obj({ Type: 'ExtGState', ca: 0.25, CA: 1 })),
              Blend: pdf.context.register(pdf.context.obj({ Type: 'ExtGState', BM: 'Multiply' }))
            })
      }),
      shared = pdf.context.register(states),
      sharedFonts = pdf.context.obj({})
    for (let index = 0; index < 3; index++) {
      const page = pdf.addPage([300, 300])
      page.drawText('A short result.', { font, size: 12, x: 40, y: 240 })
      page.drawText('Unchanged neighbor', { font, size: 10, x: 40, y: 180 })
      if (kind !== 'empty') {
        page.drawRectangle({ x: 40, y: 40, width: 100, height: 80, color: rgb(0, 0, 1) })
        page.pushOperators(pushGraphicsState(), setGraphicsState('Alpha'))
        page.drawRectangle({ x: 60, y: 60, width: 80, height: 80, color: rgb(1, 0, 0) })
        page.pushOperators(popGraphicsState(), pushGraphicsState(), setGraphicsState('Blend'))
        page.drawRectangle({ x: 80, y: 50, width: 80, height: 60, color: rgb(0, 1, 0) })
        page.pushOperators(popGraphicsState())
      }
      const resources = page.node.Resources()!
      resources.set(PDFName.of('ExtGState'), shared)
      for (const [key, value] of resources.lookup(PDFName.of('Font'), PDFDict).entries())
        sharedFonts.set(key, value)
    }
    if (kind === 'inherited') {
      const resources = pdf.context.register(
        pdf.context.obj({ Font: sharedFonts, ExtGState: shared })
      )
      for (const page of pdf.getPages()) {
        pdf.context.lookup(page.node.Parent()!, PDFDict).set(PDFName.of('Resources'), resources)
        page.node.delete(PDFName.of('Resources'))
      }
    }
    const data = await pdf.save(),
      caller = lease(),
      translation =
        kind === 'unchanged'
          ? 'A short result.'
          : kind === 'retained'
            ? '结果'.repeat(500)
            : '完整的结果。',
      units = (kind === 'single-page' ? [1] : [1, 2]).map((pageNumber) => ({
        source: 'A short result.',
        translation,
        fragments: [
          { pageNumber, rect: { x: 40 / 300, y: 45 / 300, width: 170 / 300, height: 24 / 300 } }
        ]
      }))
    const tasks: ReturnType<typeof getDocument>[] = []
    try {
      const output = await new PdfTranslationWriter(entry).generate(
        {
          id: 'shared-states',
          data,
          pages: Array.from({ length: 3 }, () => ({ width: 300, height: 300 })),
          units,
          preserveUnsupported: true
        },
        caller.lease
      )
      if (kind === 'unchanged' || kind === 'retained') {
        expect(output).toEqual(data)
        return
      }
      const result = await PDFDocument.load(output!),
        originalTask = getDocument({ data: data.slice(), useSystemFonts: true }),
        outputTask = getDocument({ data: output!.slice(), useSystemFonts: true })
      tasks.push(originalTask, outputTask)
      const original = await originalTask.promise,
        after = await outputTask.promise
      for (let index = 0; index < 3; index++) {
        const page = result.getPage(index),
          contents = page.node.Contents()!,
          streams = contents instanceof PDFArray ? contents.asArray() : [contents],
          text = streams
            .map((ref) => {
              const stream = result.context.lookup(ref)
              if (!(stream instanceof PDFRawStream)) throw new Error('Expected a content stream')
              return Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1')
            })
            .join(''),
          graphics = page.node.Resources()!.lookup(PDFName.of('ExtGState'), PDFDict)
        for (const match of text.matchAll(/\/([\w]+)\s+gs/gu))
          expect(graphics.lookup(PDFName.of(match[1]))).toBeInstanceOf(PDFDict)
        const sourcePage = await original.getPage(index + 1),
          targetPage = await after.getPage(index + 1),
          items = (await targetPage.getTextContent()).items.filter((item) => 'str' in item)
        expect(items.some((item) => item.str === 'Unchanged neighbor')).toBe(true)
        if (units.some((unit) => unit.fragments[0].pageNumber === index + 1))
          expect(items.map((item) => item.str).join('')).toContain(translation)
        const pixels = async (value: PDFPageProxy): Promise<Uint8ClampedArray> => {
          const viewport = value.getViewport({ scale: 1 }),
            canvas = createCanvas(300, 300),
            context = canvas.getContext('2d')
          await value.render({ canvas: null, canvasContext: context as never, viewport }).promise
          return context.getImageData(0, index === 2 ? 0 : 110, 300, index === 2 ? 300 : 190).data
        }
        expect(await pixels(targetPage)).toEqual(await pixels(sourcePage))
      }
    } finally {
      for (const task of tasks) await task.destroy()
      caller.release()
    }
  }
)

it.each([
  'visible',
  'unchanged',
  'transparent',
  'distant',
  'long',
  'rotated',
  'reversed',
  'different-font',
  'nonadjacent'
] as const)(
  'retains unowned inline vector marks without blocking other text (%s)',
  async (kind) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.TimesRoman),
      otherFont = await pdf.embedFont(StandardFonts.Helvetica),
      page = pdf.addPage([612, 792]),
      caller = lease(),
      left = 'We use conv2 ',
      right = 'x for features.',
      markX = 40 + font.widthOfTextAtSize(left, 12),
      length = kind === 'long' ? 30 : 5,
      y = kind === 'distant' ? 682 : 700
    page.drawText(left, { font, size: 12, x: 40, y: 700 })
    if (kind === 'nonadjacent') page.drawText('Unrelated label', { font, size: 12, x: 400, y: 740 })
    if (kind === 'rotated')
      page.pushOperators(pushGraphicsState(), concatTransformationMatrix(0, 1, -1, 0, markX, y))
    page.drawLine({
      start:
        kind === 'rotated' ? { x: 0, y: 0 } : { x: markX + (kind === 'reversed' ? length : 0), y },
      end:
        kind === 'rotated'
          ? { x: 0, y: -length }
          : { x: markX + (kind === 'reversed' ? 0 : length), y },
      thickness: 0.5,
      opacity: kind === 'transparent' ? 0 : 1
    })
    if (kind === 'rotated') page.pushOperators(popGraphicsState())
    page.drawText(right, {
      font: kind === 'different-font' ? otherFont : font,
      size: 12,
      x: markX + length + 1,
      y: 700
    })
    page.drawText('Other paragraph.', { font, size: 12, x: 40, y: 650 })
    const data = await pdf.save(),
      original = getDocument({ data: data.slice(), useSystemFonts: true }),
      source = left + right,
      translation = kind === 'unchanged' ? source : '采用卷积特征。',
      retained = ['visible', 'rotated', 'reversed'].includes(kind)
    let target: ReturnType<typeof getDocument> | undefined
    try {
      const result = await new PdfTranslationWriter(entry).generateDetailed(
        {
          id: 'inline-vector-mark',
          data,
          preserveUnsupported: true,
          pages: [{ width: 612, height: 792 }],
          units: [
            {
              source,
              translation,
              fragments: [
                {
                  pageNumber: 1,
                  rect: { x: 39 / 612, y: 78 / 792, width: 270 / 612, height: 24 / 792 }
                }
              ]
            },
            {
              source: 'Other paragraph.',
              translation: '其他段落。',
              fragments: [
                {
                  pageNumber: 1,
                  rect: { x: 39 / 612, y: 128 / 792, width: 270 / 612, height: 24 / 792 }
                }
              ]
            }
          ]
        },
        caller.lease
      )
      expect(result!.layoutFailures).toEqual(
        retained
          ? [
              {
                unitIndex: 0,
                code: 'unsupported-layout',
                phase: 'planning',
                pageNumbers: [1],
                fragmentCount: 1
              }
            ]
          : []
      )
      target = getDocument({ data: result!.data, useSystemFonts: true })
      const before = await (await original.promise).getPage(1),
        after = await (await target.promise).getPage(1),
        items = (await after.getTextContent()).items.filter((item) => 'str' in item),
        text = items
          .map((item) => item.str)
          .join('')
          .replace(/\s/gu, '')
      expect(text).toContain('其他段落。')
      expect(text.includes('采用卷积特征。')).toBe(!retained && kind !== 'unchanged')
      if (retained || kind === 'unchanged') {
        expect(text).toContain(source.replace(/\s/gu, ''))
        const crop = async (page: PDFPageProxy): Promise<Uint8ClampedArray> => {
          const canvas = createCanvas(1224, 1584),
            context = canvas.getContext('2d')
          await page.render({
            canvas: null,
            canvasContext: context as unknown as CanvasRenderingContext2D,
            viewport: page.getViewport({ scale: 2 })
          }).promise
          return context.getImageData(70, 154, 560, 52).data
        }
        // Retaining the unit must preserve both original glyphs and the path.
        expect(await crop(after)).toEqual(await crop(before))
      }
    } finally {
      await target?.destroy()
      await original.destroy()
      caller.release()
    }
  }
)

it.each([
  'visible',
  'reversed',
  'rotated',
  'unchanged',
  'transparent',
  'distant',
  'curve',
  'no-radical',
  'nonadjacent',
  'move',
  'move-reversed',
  'move-rotated',
  'changed',
  'duplicate',
  'extended',
  'combining',
  'linked',
  'source-extended',
  'nested'
] as const)('retains unowned radical overbars without blocking other text (%s)', async (kind) => {
  const pathKind =
    kind === 'move-reversed' ? 'reversed' : kind === 'move-rotated' ? 'rotated' : kind
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.TimesRoman),
    symbol = await pdf.embedFont(StandardFonts.Symbol),
    page = pdf.addPage([612, 792]),
    caller = lease()
  page.drawText('Scale ', { font, size: 12, x: 40, y: 700 })
  if (kind === 'nested') page.drawText('√', { font: symbol, size: 12, x: 93, y: 700 })
  page.drawText(kind === 'no-radical' ? 'R' : '√', {
    font: kind === 'no-radical' ? font : symbol,
    size: 12,
    x: 100,
    y: 700
  })
  if (kind === 'nonadjacent') page.drawText('Unrelated', { font, size: 12, x: 400, y: 740 })
  const y = kind === 'distant' ? 720 : 710.7
  if (kind === 'curve')
    page.drawSvgPath('M 106.6 0 C 110 1 115 1 120.7 0', {
      x: 0,
      y,
      borderWidth: 0.5,
      borderColor: rgb(0, 0, 0)
    })
  else {
    if (pathKind === 'rotated')
      page.pushOperators(pushGraphicsState(), concatTransformationMatrix(0, 1, -1, 0, 106.6, y))
    page.drawLine({
      start:
        pathKind === 'rotated' ? { x: 0, y: 0 } : { x: pathKind === 'reversed' ? 120.7 : 106.6, y },
      end:
        pathKind === 'rotated'
          ? { x: 0, y: -14.1 }
          : { x: pathKind === 'reversed' ? 106.6 : 120.7, y },
      thickness: 0.5,
      opacity: kind === 'transparent' ? 0 : 1
    })
    if (pathKind === 'rotated') page.pushOperators(popGraphicsState())
  }
  page.drawText('dT', { font, size: 12, x: 107, y: 700 })
  page.drawText(kind === 'source-extended' ? '2 is bounded.' : ' is bounded.', {
    font,
    size: 12,
    x: 121,
    y: 700
  })
  page.drawText('Other paragraph.', { font, size: 12, x: 40, y: 650 })
  if (kind === 'linked')
    page.node.set(
      PDFName.of('Annots'),
      pdf.context.obj([
        pdf.context.register(
          pdf.context.obj({
            Type: 'Annot',
            Subtype: 'Link',
            Rect: [106, 699, 121, 710],
            Border: [0, 0, 0],
            A: { S: 'URI', URI: PDFString.of('https://example.org/dT') }
          })
        )
      ])
    )
  const moving = ['move', 'move-reversed', 'move-rotated'].includes(kind),
    translated =
      moving || kind === 'linked'
        ? '这个模型给出的总体尺度√dT有界。'
        : kind === 'changed'
          ? '该尺度√dX有界。'
          : kind === 'duplicate'
            ? '该尺度√dT与√dT有界。'
            : kind === 'extended'
              ? '该尺度√dTotal有界。'
              : kind === 'combining'
                ? '该尺度√dT\u0302有界。'
                : '该尺度有界。'
  const data = await pdf.save(),
    source = `Scale ${kind === 'nested' ? '√' : ''}${kind === 'no-radical' ? 'R' : '√'}dT${kind === 'source-extended' ? '2' : ''} is bounded.`,
    retained = [
      'visible',
      'reversed',
      'rotated',
      'changed',
      'duplicate',
      'extended',
      'combining',
      'linked',
      'source-extended',
      'nested'
    ].includes(kind),
    original = getDocument({ data: data.slice(), useSystemFonts: true })
  let target: ReturnType<typeof getDocument> | undefined
  try {
    const output = await new PdfTranslationWriter(entry).generateDetailed(
      {
        id: 'radical-overbar',
        data,
        preserveUnsupported: true,
        pages: [{ width: 612, height: 792 }],
        units: [
          {
            source,
            translation:
              kind === 'unchanged'
                ? source
                : kind === 'source-extended'
                  ? '该尺度√dT2有界。'
                  : kind === 'nested'
                    ? '该尺度√√dT有界。'
                    : translated,
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 39 / 612, y: 68 / 792, width: 270 / 612, height: 34 / 792 }
              }
            ]
          },
          {
            source: 'Other paragraph.',
            translation: '其他段落。',
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 39 / 612, y: 128 / 792, width: 270 / 612, height: 24 / 792 }
              }
            ]
          }
        ]
      },
      caller.lease
    )
    expect(output!.layoutFailures).toEqual(
      retained
        ? [
            {
              unitIndex: 0,
              code: 'unsupported-layout',
              phase: 'planning',
              pageNumbers: [1],
              fragmentCount: 1
            }
          ]
        : []
    )
    target = getDocument({ data: output!.data, useSystemFonts: true })
    const before = await (await original.promise).getPage(1),
      after = await (await target.promise).getPage(1),
      text = (await after.getTextContent()).items
        .flatMap((item) => ('str' in item ? [item.str] : []))
        .join('')
        .replace(/\s/gu, '')
    expect(text).toContain('其他段落。')
    expect(text.includes(translated)).toBe(!retained && kind !== 'unchanged')
    if (moving) {
      const beforeItems = (await before.getTextContent()).items.filter((item) => 'str' in item),
        afterItems = (await after.getTextContent()).items.filter((item) => 'str' in item),
        a = beforeItems.filter((item) => item.str === '√' || item.str === 'dT'),
        b = afterItems.filter((item) => item.str === '√' || item.str === 'dT')
      expect(a).toHaveLength(2)
      expect(b).toHaveLength(2)
      expect(b.map((item) => item.str)).toEqual(a.map((item) => item.str))
      for (let i = 0; i < 2; i++) {
        expect(b[i].transform.slice(0, 4)).toEqual(a[i].transform.slice(0, 4))
        expect(b[i].transform[4] - b[0].transform[4]).toBeCloseTo(
          a[i].transform[4] - a[0].transform[4],
          3
        )
        expect(b[i].transform[5] - b[0].transform[5]).toBeCloseTo(
          a[i].transform[5] - a[0].transform[5],
          3
        )
      }
      expect(b[0].transform[4]).not.toBe(a[0].transform[4])
    }
    if (retained || kind === 'unchanged') {
      expect(text).toContain(source.replace(/\s/gu, ''))
      const crop = async (page: PDFPageProxy): Promise<Uint8ClampedArray> => {
        const canvas = createCanvas(1224, 1584),
          context = canvas.getContext('2d')
        await page.render({
          canvas: null,
          canvasContext: context as unknown as CanvasRenderingContext2D,
          viewport: page.getViewport({ scale: 2 })
        }).promise
        return context.getImageData(70, 132, 560, 76).data
      }
      expect(await crop(after)).toEqual(await crop(before))
    }
  } finally {
    await target?.destroy()
    await original.destroy()
    caller.release()
  }
})

it.each([false, true])(
  'keeps native overprinted variables without blocking a neighboring translation (changed target: %s)',
  async (changedTarget) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.TimesRoman),
      variable = await pdf.embedFont(StandardFonts.TimesRomanItalic),
      page = pdf.addPage([600, 800]),
      caller = lease()
    page.drawText('Scale ratio (', { font, size: 9, x: 40, y: 700 })
    for (const [letter, x, value] of [
      ['q', 88, '=1.4,'],
      ['v', 118, '=1.2,'],
      ['s', 148, '=1.3)']
    ] as const) {
      for (const [dx, dy] of [
        [0, 0],
        [0.17, 0.21],
        [0.34, 0]
      ])
        page.drawText(letter, { font: variable, size: 9, x: x + dx, y: 700 + dy })
      page.drawText(value, { font, size: 9, x: x + 5, y: 700 })
    }
    page.drawText('The other paragraph remains available.', { font, size: 9, x: 40, y: 650 })
    const data = await pdf.save(),
      original = getDocument({ data: data.slice(), useSystemFonts: true })
    let target: ReturnType<typeof getDocument> | undefined
    try {
      const { source } = await extractPdfTranslationSource({
        document: await original.promise,
        resourceRequestKey: 'overprinted-variables',
        signal: caller.lease.signal
      })
      const ratio = source.units.find((unit) => unit.source.startsWith('Scale ratio'))!,
        other = source.units.find((unit) => unit.source.startsWith('The other paragraph'))!
      expect(ratio.source).toContain('qqq=1.4')
      const output = await new PdfTranslationWriter(entry).generate(
        {
          id: 'overprinted-variables',
          data,
          pages: source.pages,
          preserveUnsupported: true,
          units: [
            {
              ...ratio,
              translation: ratio.source
                .replace('Scale ratio', '缩放比例')
                .replace('qqq', changedTarget ? 'ppp' : 'qqq')
            },
            { ...other, translation: '另一段文字仍然可用。' }
          ]
        },
        caller.lease
      )
      target = getDocument({ data: output!, useSystemFonts: true })
      const originalItems = (await (await (await original.promise).getPage(1)).getTextContent())
          .items,
        targetItems = (await (await (await target.promise).getPage(1)).getTextContent()).items,
        variables = (items: typeof originalItems): Array<{ text: string; transform: number[] }> =>
          items.flatMap((item) =>
            'str' in item && /^[qvs]$/u.test(item.str)
              ? [{ text: item.str, transform: item.transform }]
              : []
          )
      const nativeVariables = variables(originalItems),
        writtenVariables = variables(targetItems)
      expect(nativeVariables).toHaveLength(9)
      expect(writtenVariables.map((item) => item.text)).toEqual(
        nativeVariables.map((item) => item.text)
      )
      // PDFium serializes native matrices from float32 values.
      nativeVariables.forEach((item, index) =>
        item.transform.forEach((value, component) =>
          expect(writtenVariables[index].transform[component]).toBeCloseTo(value, 4)
        )
      )
      const written = targetItems.map((item) => ('str' in item ? item.str : '')).join('')
      expect(written.replace(/\s/gu, '')).toContain(
        changedTarget ? 'Scaleratio(qqq=1.4,vvv=1.2,sss=1.3)' : '缩放比例(qqq=1.4,vvv=1.2,sss=1.3)'
      )
      expect(written).toContain('另一段文字仍然可用。')
    } finally {
      await original.destroy()
      await target?.destroy()
      caller.release()
    }
  }
)

it.each([
  'word',
  'narrow-tail',
  'cross-page',
  'same-column',
  'plain-number',
  'head-anchor',
  'mixed-word'
] as const)(
  'keeps a complete Han word before its owned cross-column citation when safe (%s)',
  async (kind) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica),
      first = pdf.addPage([612, 792]),
      second = kind === 'cross-page' ? pdf.addPage([612, 792]) : first,
      caller = lease(),
      tailX = kind === 'same-column' ? 40 : 320,
      tailWidth = kind === 'narrow-tail' ? 40 : 160,
      plain = kind === 'plain-number',
      headLink = kind === 'head-anchor',
      before = plain ? 'See ' : 'See [',
      after = plain ? '.' : '].',
      tailSource = before + '15' + after,
      headSource = headLink ? 'First [3].' : 'First.',
      translation =
        (headLink ? '我们[3]进行反向传' : '我们进行反向传') +
        (kind === 'mixed-word' ? 'A' : '播') +
        (plain ? '15。' : '[15]。')
    const link = (page: typeof first, number: string, x: number, y: number): void => {
      const width = font.widthOfTextAtSize(number, 10)
      page.drawText(number, { font, size: 10, x, y })
      page.node.set(
        PDFName.of('Annots'),
        pdf.context.obj([
          ...(page.node.Annots()?.asArray() ?? []),
          pdf.context.register(
            pdf.context.obj({
              Type: 'Annot',
              Subtype: 'Link',
              Rect: [x, y - 2, x + width, y + 8],
              Border: [0, 0, 0],
              A: { S: 'URI', URI: PDFString.of('https://example.org/cite' + number) }
            })
          )
        ])
      )
    }
    if (headLink) {
      first.drawText('First [', { font, size: 10, x: 40, y: 100 })
      const x = 40 + font.widthOfTextAtSize('First [', 10)
      link(first, '3', x, 100)
      first.drawText('].', { font, size: 10, x: x + font.widthOfTextAtSize('3', 10), y: 100 })
    } else first.drawText(headSource, { font, size: 10, x: 40, y: 100 })
    second.drawText(before, { font, size: 10, x: tailX, y: 650 })
    const x = tailX + font.widthOfTextAtSize(before, 10)
    link(second, '15', x, 650)
    second.drawText(after, { font, size: 10, x: x + font.widthOfTextAtSize('15', 10), y: 650 })
    first.drawText('Untouched neighbor', { font, size: 10, x: 40, y: 400 })
    const input: PdfTranslationPdfRequest = {
      id: 'owned-citation-word',
      data: await pdf.save(),
      pages: Array.from({ length: pdf.getPageCount() }, () => ({ width: 612, height: 792 })),
      units: [
        {
          source: headSource + ' ' + tailSource,
          translation,
          fragments: [
            {
              pageNumber: 1,
              rect: { x: 40 / 612, y: 682 / 792, width: 180 / 612, height: 14 / 792 }
            },
            {
              pageNumber: kind === 'cross-page' ? 2 : 1,
              rect: { x: tailX / 612, y: 132 / 792, width: tailWidth / 612, height: 14 / 792 }
            }
          ]
        }
      ]
    }
    const snapshots: string[][] = []
    try {
      for (let attempt = 0; attempt < (kind === 'word' ? 2 : 1); attempt++) {
        const output = await new PdfTranslationWriter(entry).generate(input, caller.lease),
          task = getDocument({ data: output!, useSystemFonts: true })
        try {
          const document = await task.promise,
            head = await document.getPage(1),
            tail = await document.getPage(kind === 'cross-page' ? 2 : 1),
            headItems = (await head.getTextContent()).items.filter((item) => 'str' in item),
            tailItems = (await tail.getTextContent()).items.filter((item) => 'str' in item),
            left = headItems.filter(
              (item) => item.str && item.transform[5] > 90 && item.transform[5] < 110
            ),
            right = tailItems.filter(
              (item) => item.str && item.transform[5] > 640 && item.transform[5] < 660
            ),
            texts = [left, right].map((items) =>
              items
                .map((item) => item.str)
                .join('')
                .replace(/\s/gu, '')
            )
          expect(texts.join('')).toBe(translation)
          expect(texts[0].endsWith(kind === 'word' ? '反向' : '反向传')).toBe(true)
          expect(
            texts[1].startsWith(kind === 'word' ? '传播[' : kind === 'mixed-word' ? 'A[' : '播')
          ).toBe(true)
          expect(headItems.some((item) => item.str === 'Untouched neighbor')).toBe(true)
          for (const [index, items] of [left, right].entries())
            for (const item of items) {
              expect(item.transform[0]).toBe(10)
              expect(item.transform[3]).toBe(10)
              expect(item.transform[5]).toBe(index ? 650 : 100)
              expect(item.transform[4]).toBeGreaterThanOrEqual(index ? tailX : 40)
              expect(item.transform[4] + item.width).toBeLessThanOrEqual(
                index ? tailX + tailWidth + 0.001 : 220.001
              )
            }
          const annotation = (await tail.getAnnotations()).find(
            (a) => 'url' in a && a.url === 'https://example.org/cite15'
          )!
          expect(annotation.rect[2] - annotation.rect[0]).toBeCloseTo(
            font.widthOfTextAtSize('15', 10),
            3
          )
          expect(annotation.rect[3] - annotation.rect[1]).toBeCloseTo(10, 3)
          const label = right.find((item) => item.str === '15')!
          expect(label.transform[4]).toBeGreaterThanOrEqual(annotation.rect[0] - 0.001)
          expect(label.transform[4] + label.width).toBeLessThanOrEqual(annotation.rect[2] + 0.001)
          snapshots.push(texts)
        } finally {
          await task.destroy()
        }
      }
      if (snapshots.length === 2) expect(snapshots[1]).toEqual(snapshots[0])
    } finally {
      caller.release()
    }
  }
)

it.each(['word', 'narrow-tail', 'separate-columns', 'distant-rows', 'mixed-token'] as const)(
  'keeps a Han word together across adjacent plain regions when safe (%s)',
  async (kind) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica),
      page = pdf.addPage([300, 300]),
      caller = lease(),
      tailX = kind === 'separate-columns' ? 150 : 40,
      tailY = kind === 'distant-rows' ? 200 : 235,
      translation = kind === 'mixed-token' ? '我们监测温A变化。' : '我们监测温度变化。'
    page.drawText('First', { font, size: 10, x: 40, y: 250 })
    page.drawText('Second', { font, size: 10, x: tailX, y: tailY })
    page.drawText('Untouched neighbor', { font, size: 10, x: 40, y: 150 })
    const input: PdfTranslationPdfRequest = {
      id: 'adjacent-plain-word',
      data: await pdf.save(),
      pages: [{ width: 300, height: 300 }],
      units: [
        {
          source: 'First Second',
          translation,
          fragments: [
            {
              pageNumber: 1,
              rect: { x: 40 / 300, y: 40 / 300, width: 53 / 300, height: 12 / 300 }
            },
            {
              pageNumber: 1,
              rect: {
                x: tailX / 300,
                y: (290 - tailY) / 300,
                width: (kind === 'narrow-tail' ? 44 : 90) / 300,
                height: 12 / 300
              }
            }
          ]
        }
      ]
    }
    const snapshots: string[][] = []
    try {
      for (let attempt = 0; attempt < (kind === 'word' ? 2 : 1); attempt++) {
        const result = await new PdfTranslationWriter(entry).generate(input, caller.lease),
          task = getDocument({ data: result!, useSystemFonts: true })
        try {
          const items = (
              await (await (await task.promise).getPage(1)).getTextContent()
            ).items.filter((item) => 'str' in item),
            translated = items.filter((item) => item.str && item.transform[5] > 190),
            texts = translated.map((item) => item.str)
          expect(texts.join('')).toBe(translation)
          expect(texts).toHaveLength(2)
          expect(texts[0]).toBe(kind === 'word' ? '我们监测' : '我们监测温')
          expect(items.some((item) => item.str === 'Untouched neighbor')).toBe(true)
          translated.forEach((item, index) => {
            expect(item.transform).toEqual([10, 0, 0, 10, index ? tailX : 40, index ? tailY : 250])
            expect(item.width).toBeLessThanOrEqual(
              index && kind === 'narrow-tail' ? 44.001 : index ? 90.001 : 53.001
            )
          })
          snapshots.push(texts)
        } finally {
          await task.destroy()
        }
      }
      if (snapshots.length === 2) expect(snapshots[1]).toEqual(snapshots[0])
    } finally {
      caller.release()
    }
  }
)

it.each([
  'clause',
  'whitespace',
  'no-boundary',
  'decimal',
  'narrow-tail',
  'native-anchor'
] as const)('keeps a short cross-page tail with its prose clause when safe (%s)', async (kind) => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica),
    first = pdf.addPage([612, 792]),
    second = pdf.addPage([612, 792]),
    caller = lease(),
    linked = kind === 'native-anchor',
    firstText = 'The measured values follow this rule.',
    secondText = 'This clause describes the result,',
    finalText = 'continued.',
    translation = linked
      ? '甲'.repeat(20) + '[1]' + '甲'.repeat(4) + '，' + '乙'.repeat(10) + '丙。'
      : '甲'.repeat(kind === 'narrow-tail' ? 23 : 24) +
        (kind === 'decimal'
          ? '0.4'
          : kind === 'no-boundary'
            ? '甲'
            : kind === 'whitespace'
              ? '， '
              : '，') +
        '乙'.repeat(10) +
        '丙。',
    linkWidth = font.widthOfTextAtSize('[1]', 12)
  first.drawText(firstText, { font, size: 12, x: 40, y: 700 })
  if (linked) {
    first.drawText('[1]', { font, size: 12, x: 40, y: 686 })
    first.node.set(
      PDFName.of('Annots'),
      pdf.context.obj([
        pdf.context.register(
          pdf.context.obj({
            Type: 'Annot',
            Subtype: 'Link',
            Rect: [40, 684, 40 + linkWidth, 696],
            Border: [0, 0, 0],
            A: { S: 'URI', URI: PDFString.of('https://example.org/result') }
          })
        )
      ])
    )
  }
  first.drawText(secondText, { font, size: 12, x: 40 + (linked ? linkWidth : 0), y: 686 })
  second.drawText(finalText, { font, size: 12, x: 40, y: 700 })
  second.drawText('Unrelated paragraph.', { font, size: 12, x: 40, y: 660 })
  const input: PdfTranslationPdfRequest = {
    id: 'cross-page-prose-clause',
    data: await pdf.save(),
    pages: [
      { width: 612, height: 792 },
      { width: 612, height: 792 }
    ],
    units: [
      {
        source: `${firstText} ${linked ? '[1]' : ''}${secondText} ${finalText}`,
        translation,
        fragments: [
          { pageNumber: 1, rect: { x: 40 / 612, y: 80 / 792, width: 205 / 612, height: 33 / 792 } },
          {
            pageNumber: 2,
            rect: {
              x: 40 / 612,
              y: 80 / 792,
              width: (kind === 'narrow-tail' ? 100 : 205) / 612,
              height: 20 / 792
            }
          }
        ]
      }
    ]
  }
  const snapshots: string[][] = []
  try {
    for (let attempt = 0; attempt < (kind === 'clause' ? 2 : 1); attempt++) {
      const output = await new PdfTranslationWriter(entry).generate(input, caller.lease),
        task = getDocument({ data: output!, useSystemFonts: true })
      try {
        const document = await task.promise,
          texts: string[] = []
        for (let pageNumber = 1; pageNumber <= 2; pageNumber++) {
          const page = await document.getPage(pageNumber),
            items = (await page.getTextContent()).items.filter((item) => 'str' in item),
            translated = items.filter((item) => item.transform[5] > 680)
          texts.push(translated.map((item) => item.str).join(''))
          for (const item of translated.filter((item) => /[甲乙丙]/u.test(item.str))) {
            expect(Math.hypot(item.transform[2], item.transform[3])).toBeCloseTo(12, 3)
            expect(item.transform[4]).toBeGreaterThanOrEqual(39.99)
            expect(item.transform[4] + item.width).toBeLessThanOrEqual(
              pageNumber === 2 && kind === 'narrow-tail' ? 140.01 : 245.01
            )
          }
          if (pageNumber === 2)
            expect(items.map((item) => item.str).join('')).toContain('Unrelated paragraph.')
          if (linked && pageNumber === 1)
            expect(await page.getAnnotations()).toMatchObject([
              { url: 'https://example.org/result' }
            ])
        }
        expect(texts.join('').replace(/\s/gu, '')).toBe(translation.replace(/\s/gu, ''))
        if (kind === 'whitespace') expect(texts[1].trimStart()).toBe('乙'.repeat(10) + '丙。')
        else if (kind === 'clause') expect(texts[1]).toBe('乙'.repeat(10) + '丙。')
        else expect(texts[1].length).toBeLessThan(8)
        snapshots.push(texts)
      } finally {
        await task.destroy()
      }
    }
    if (snapshots.length === 2) expect(snapshots[1]).toEqual(snapshots[0])
  } finally {
    caller.release()
  }
})

it('replaces a broken-word paragraph across a top-of-page floating table', async () => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.TimesRoman),
    first = pdf.addPage([600, 800]),
    second = pdf.addPage([600, 800]),
    caller = lease(),
    prefix = 'The measured response changes with the input scale of each sample and we ap-',
    tail = 'ply the same setting to all measured samples and report the final response separately.',
    translation = '测量响应随着输入尺度变化。我们对所有样本应用相同的设置，并单独报告最终响应。'
  first.drawText(prefix, { font, size: 8, x: 330, y: 100 })
  second.drawText('Table 2. Measured responses', { font, size: 7, x: 40, y: 715 })
  for (let row = 0; row < 3; row++) {
    second.drawText(row ? `Method ${row}` : 'apply', {
      font,
      size: 8,
      x: 40,
      y: 700 - row * 12
    })
    second.drawText(String(462 - row), { font, size: 8, x: 160, y: 700 - row * 12 })
    second.drawText(String(32 - row), { font, size: 8, x: 230, y: 700 - row * 12 })
  }
  second.drawText(tail, { font, size: 8, x: 40, y: 630 })
  const data = await pdf.save(),
    original = getDocument({ data: data.slice(), useSystemFonts: true })
  let target: ReturnType<typeof getDocument> | undefined
  try {
    const { source } = await extractPdfTranslationSource({
      document: await original.promise,
      resourceRequestKey: 'floating-table-continuation',
      signal: caller.lease.signal
    })
    const paragraph = source.units.find((unit) => unit.source.startsWith('The measured'))!
    expect(paragraph.source).toContain('apply the same')
    expect(paragraph.fragments.map((fragment) => fragment.pageNumber)).toEqual([1, 2])
    const output = await new PdfTranslationWriter(entry).generate(
      {
        id: 'floating-table-continuation',
        data,
        pages: source.pages,
        units: [{ ...paragraph, translation }]
      },
      caller.lease
    )
    target = getDocument({ data: output!, useSystemFonts: true })
    const document = await target.promise,
      text = [] as string[],
      paragraphText = [] as string[]
    for (let pageNumber = 1; pageNumber <= 2; pageNumber++) {
      const items = (await (await document.getPage(pageNumber)).getTextContent()).items.filter(
        (item) => 'str' in item
      )
      text.push(items.map((item) => item.str).join(''))
      paragraphText.push(
        items
          .filter((item) => pageNumber === 1 || item.transform[5] < 650)
          .map((item) => item.str)
          .join('')
      )
      if (pageNumber === 2) {
        expect(text.at(-1)).toContain('Table 2. Measured responses')
        for (const row of [0, 1, 2]) {
          const number = items.find((item) => item.str === String(462 - row))!
          expect(number.transform[4]).toBeCloseTo(160, 2)
          expect(number.transform[5]).toBeCloseTo(700 - row * 12, 2)
        }
      }
    }
    expect(paragraphText.join('').replace(/\s/gu, '')).toBe(translation)
    expect(text.join('')).not.toContain('ap-')
    expect(text.join('')).not.toContain('ply the same')
  } finally {
    await target?.destroy()
    await original.destroy()
    caller.release()
  }
})

it('translates a wrapped one-word equation lead with its paragraph', async () => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.TimesRoman),
    page = pdf.addPage([612, 792]),
    caller = lease(),
    prefix = 'Applying the same bound to all remaining terms, we',
    translation = '将相同的界应用于所有剩余项，可得'
  page.drawText(prefix, { font, x: 40, y: 700, size: 10 })
  page.drawText('get', { font, x: 40, y: 688, size: 10 })
  page.drawText('z = x + y', { font, x: 130, y: 664, size: 10 })
  const data = await pdf.save(),
    original = getDocument({ data: data.slice(), useSystemFonts: true })
  let target: ReturnType<typeof getDocument> | undefined
  try {
    const { source } = await extractPdfTranslationSource({
      document: await original.promise,
      resourceRequestKey: 'equation-lead',
      signal: caller.lease.signal
    })
    expect(source.units.filter((unit) => !unit.sourceOnly).map((unit) => unit.source)).toEqual([
      `${prefix} get`
    ])
    const output = await new PdfTranslationWriter(entry).generate(
      {
        id: 'equation-lead',
        data,
        pages: source.pages,
        units: source.units
          .filter((unit) => !unit.sourceOnly)
          .map((unit) => ({ ...unit, translation }))
      },
      caller.lease
    )
    target = getDocument({ data: output!, useSystemFonts: true })
    const items = (await (await (await target.promise).getPage(1)).getTextContent()).items.filter(
        (item) => 'str' in item
      ),
      text = items
        .map((item) => item.str)
        .join('')
        .replace(/\s/gu, ''),
      equation = items.find((item) => item.str === 'z = x + y')!
    expect(text).toContain(translation)
    expect(text).not.toContain('get')
    expect(equation.transform[4]).toBeCloseTo(130, 2)
    expect(equation.transform[5]).toBeCloseTo(664, 2)
  } finally {
    await target?.destroy()
    await original.destroy()
    caller.release()
  }
})

it.each(
  readPdfTranslationCases<{ name: string; sourceGap: number; reflow: boolean }>(
    'shortened-paragraph-anchor-spacing.jsonl'
  )
)('keeps shortened prose continuous around its link: $name', async ({ sourceGap, reflow }) => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.TimesRoman),
    page = pdf.addPage([600, 800]),
    caller = lease(),
    rows = [
      'This paragraph describes the method and its measured results',
      'across several experiments using the same evaluation setup',
      'and compares the measurements with the previous baseline',
      'before citing the detailed report '
    ],
    linkY = 700 - sourceGap * 3,
    linkX = 40 + font.widthOfTextAtSize(rows[3], 10),
    linkWidth = font.widthOfTextAtSize('[1]', 10),
    translation = '研究结果见报告[1]，结论一致。'
  rows.forEach((text, index) =>
    page.drawText(text, { font, size: 10, x: 40, y: 700 - sourceGap * index })
  )
  page.drawText('[1]', { font, size: 10, x: linkX, y: linkY })
  page.drawText(' with consistent conclusions.', { font, size: 10, x: linkX + linkWidth, y: linkY })
  page.node.set(
    PDFName.of('Annots'),
    pdf.context.obj([
      pdf.context.register(
        pdf.context.obj({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: [linkX, linkY - 2, linkX + linkWidth, linkY + 9],
          Border: [0, 0, 0],
          A: { S: 'URI', URI: PDFString.of('https://example.org/report') }
        })
      )
    ])
  )
  let document: ReturnType<typeof getDocument> | undefined
  try {
    const output = await new PdfTranslationWriter(entry).generate(
      {
        id: 'shortened-anchor-spacing',
        data: await pdf.save(),
        pages: [{ width: 600, height: 800 }],
        units: [
          {
            source: rows.join(' ') + '[1] with consistent conclusions.',
            translation,
            fragments: [
              {
                pageNumber: 1,
                rect: {
                  x: 40 / 600,
                  y: 85 / 800,
                  width: 400 / 600,
                  height: (sourceGap * 3 + 20) / 800
                }
              }
            ]
          }
        ]
      },
      caller.lease
    )
    document = getDocument({ data: output!, useSystemFonts: true })
    const resultPage = await (await document.promise).getPage(1),
      items = (await resultPage.getTextContent()).items.filter((item) => 'str' in item),
      link = (await resultPage.getAnnotations())[0],
      baselines = items.filter((item) => item.str.trim()).map((item) => item.transform[5])
    expect(
      items
        .map((item) => item.str)
        .join('')
        .replace(/\s/gu, '')
    ).toBe(translation)
    expect(link.url).toBe('https://example.org/report')
    expect(link.rect[2] - link.rect[0]).toBeCloseTo(linkWidth, 2)
    if (reflow) {
      expect(Math.max(...baselines) - Math.min(...baselines)).toBeLessThan(15)
      expect(link.rect[1]).toBeGreaterThan(linkY + 10)
    } else {
      expect(link.rect[1]).toBeCloseTo(linkY - 2, 2)
    }
  } finally {
    await document?.destroy()
    caller.release()
  }
})

async function mapUnknownGlyph(pdf: PDFDocument, font: PDFFont): Promise<void> {
  await pdf.flush()
  // A real PDF mapping to U+0002, which PDFium does NOT classify as a hyphen.
  pdf.context
    .lookup(font.ref, PDFDict)
    .set(
      PDFName.of('ToUnicode'),
      pdf.context.register(
        pdf.context.stream(
          [
            '/CIDInit /ProcSet findresource begin',
            '12 dict begin',
            'begincmap',
            '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
            '/CMapName /UnknownMap def',
            '/CMapType 2 def',
            '1 begincodespacerange',
            '<00> <FF>',
            'endcodespacerange',
            '1 beginbfchar',
            '<41> <0002>',
            'endbfchar',
            'endcmap',
            'CMapName currentdict /CMap defineresource pop',
            'end',
            'end'
          ].join('\n')
        )
      )
    )
}

async function fixture(): Promise<PdfTranslationPdfRequest> {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica)
  for (let i = 0; i < 2; i++) {
    const page = pdf.addPage([612, 792])
    page.drawText('Cell growth is measured.', { font, x: 40, y: 700, size: 12 })
    page.drawText('p = 0.05; n = 128', { font, x: 40, y: 600, size: 10 })
    page.drawRectangle({ x: 40, y: 200, width: 180, height: 180, borderWidth: 1 })
  }
  return {
    id: 'render',
    data: await pdf.save(),
    pages: [
      { width: 612, height: 792 },
      { width: 612, height: 792 }
    ],
    units: [1, 2].map((pageNumber) => ({
      source: 'Cell growth is measured.',
      translation: '测量细胞生长。',
      fragments: [
        { pageNumber, rect: { x: 40 / 612, y: 70 / 792, width: 220 / 612, height: 35 / 792 } }
      ]
    }))
  }
}

it.each([
  'clear',
  'two-inset-lines',
  'different-font',
  'combined-initial',
  'tight-leading',
  'oversized-initial',
  'rotated-initial',
  'unrelated-heading',
  'neighbor-title',
  'clipped-initial'
] as const)(
  'fits a complete linked drop-cap paragraph only with native three-line inset proof (%s)',
  async (kind) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.TimesRoman),
      alternate = await pdf.embedFont(StandardFonts.Courier),
      page = pdf.addPage([612, 792]),
      caller = lease(),
      capital = kind === 'combined-initial' ? 'St' : 'S',
      capitalSize = kind === 'oversized-initial' ? 48 : 42,
      insetX = 40 + font.widthOfTextAtSize(capital, capitalSize) + 2,
      prose = [
        kind === 'unrelated-heading'
          ? 'An unrelated paragraph begins on this row.'
          : kind === 'combined-initial'
            ? 'atement describes the first measured response.'
            : 'tatement describes the first measured response.',
        'The following row describes another measured response.',
        'The third row remains beside the complete initial.',
        'The next line gives the complete result '
      ],
      translation = '这段陈述描述测量响应并保留完整结果1。'
    if (kind === 'clipped-initial')
      page.pushOperators(pushGraphicsState(), rectangle(38, 678, 12, 35), clip(), endPath())
    page.drawText(capital, {
      font,
      size: capitalSize,
      x: 40,
      y: 680,
      rotate: degrees(kind === 'rotated-initial' ? 1 : 0)
    })
    if (kind === 'clipped-initial') page.pushOperators(popGraphicsState())
    prose.forEach((text, index) =>
      page.drawText(text, {
        font: kind === 'different-font' && index === 1 ? alternate : font,
        size: 9,
        x: index === 3 || (kind === 'two-inset-lines' && index === 2) ? 40 : insetX,
        y: index === 3 ? 672 : 704 - index * (kind === 'tight-leading' ? 5 : 10)
      })
    )
    const linkX = 40 + font.widthOfTextAtSize(prose[3], 9),
      linkWidth = font.widthOfTextAtSize('1', 5.5)
    page.drawText('1', { font, size: 5.5, x: linkX, y: 675 })
    page.node.set(
      PDFName.of('Annots'),
      pdf.context.obj([
        pdf.context.register(
          pdf.context.obj({
            Type: 'Annot',
            Subtype: 'Link',
            Rect: [linkX - 0.1, 674, linkX + linkWidth + 0.1, 680],
            Border: [0, 0, 0],
            A: { S: 'URI', URI: PDFString.of('https://example.org/dropcap-reference') }
          })
        )
      ])
    )
    if (kind === 'neighbor-title') page.drawText('Figure title', { font, size: 18, x: 40, y: 635 })
    let task: ReturnType<typeof getDocument> | undefined
    try {
      const source =
          capital + prose.join(' ') + '1' + (kind === 'neighbor-title' ? ' Figure title' : ''),
        output = await new PdfTranslationWriter(entry).generate(
          {
            id: 'native-dropcap',
            preserveUnsupported: true,
            data: await pdf.save(),
            pages: [{ width: 612, height: 792 }],
            units: [
              {
                source,
                translation,
                fragments: [
                  {
                    pageNumber: 1,
                    rect: { x: 38 / 612, y: 75 / 792, width: 330 / 612, height: 95 / 792 }
                  }
                ]
              }
            ]
          },
          caller.lease
        )
      task = getDocument({ data: output!, useSystemFonts: true })
      const page = await (await task.promise).getPage(1),
        items = (await page.getTextContent()).items.filter((item) => 'str' in item),
        written = items
          .map((item) => item.str)
          .join('')
          .replace(/\s/gu, ''),
        translated = kind === 'clear'
      expect(written).toBe((translated ? translation : source).replace(/\s/gu, ''))
      expect((await page.getAnnotations()).map((annotation) => annotation.url)).toEqual([
        'https://example.org/dropcap-reference'
      ])
      if (translated) {
        expect(items.filter((item) => /[\p{Script=Han}]/u.test(item.str)).length).toBeGreaterThan(0)
        expect(items.find((item) => item.str === '1')?.transform[3]).toBe(5.5)
      }
    } finally {
      await task?.destroy()
      caller.release()
    }
  }
)

it.each([
  'clear',
  'numeric-neighbor',
  'cell-rule',
  'thick-cell-rule',
  'transparent-cell-rule',
  'thick-plot-stroke'
] as const)(
  'uses shared short-line capacity without moving neighbors or crossing a %s boundary',
  async (kind) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica),
      page = pdf.addPage([612, 792]),
      caller = lease(),
      label = 'Result',
      // The native font margin now permits two readable lines. Use enough
      // text to require a third line in the narrow cells, which must still fail.
      translation = '主要试验的最终疗效结果',
      width = font.widthOfTextAtSize(label, 12),
      neighborX = 40 + width + (kind === 'numeric-neighbor' ? 5 : 40)
    page.drawText(label, { font, size: 12, x: 40, y: 700 })
    page.drawText('17.0', { font, size: 12, x: neighborX, y: 700 })
    if (kind.endsWith('cell-rule') || kind === 'thick-plot-stroke')
      page.drawLine({
        start: { x: 40 + (kind === 'thick-plot-stroke' ? width / 2 : width + 8), y: 696 },
        end: { x: 40 + (kind === 'thick-plot-stroke' ? width / 2 : width + 8), y: 714 },
        thickness: kind === 'thick-cell-rule' || kind === 'thick-plot-stroke' ? 1 : 0.5,
        opacity: kind === 'transparent-cell-rule' ? 0 : 1
      })
    const source = createPdfTranslationSource({
      resourceRequestKey: 'short-line-boundary',
      fingerprint: 'short-line-boundary',
      pages: [{ width: 612, height: 792 }],
      units: [
        {
          id: 'label',
          source: label,
          fragments: [
            {
              pageNumber: 1,
              rect: { x: 40 / 612, y: 78 / 792, width: width / 612, height: 18 / 792 },
              items: [{ index: 0, text: label }]
            }
          ]
        },
        {
          id: 'numeric',
          source: '17.0',
          sourceOnly: true,
          fragments: [
            {
              pageNumber: 1,
              rect: { x: neighborX / 612, y: 78 / 792, width: 26 / 612, height: 18 / 792 },
              items: [{ index: 1, text: '17.0' }]
            }
          ]
        }
      ]
    })
    let task: ReturnType<typeof getDocument> | undefined
    try {
      const unit = source.units[0],
        fragments = pdfTranslationLayoutFragments(unit, source),
        output = await new PdfTranslationWriter(entry).generate(
          {
            id: 'short-line-boundary',
            preserveUnsupported: true,
            data: await pdf.save(),
            pages: source.pages,
            units: [{ ...unit, translation, fragments }]
          },
          caller.lease
        )
      expect(fragments[0].rect.width * 612 - width).toBeCloseTo(
        kind === 'numeric-neighbor' ? 3 : 24
      )
      task = getDocument({ data: output!, useSystemFonts: true })
      const items = (await (await (await task.promise).getPage(1)).getTextContent()).items.filter(
          (item) => 'str' in item
        ),
        text = items
          .map((item) => item.str)
          .join('')
          .replace(/\s/gu, ''),
        numeric = items.find((item) => item.str === '17.0')!
      const translated =
        kind === 'clear' || kind === 'transparent-cell-rule' || kind === 'thick-plot-stroke'
      expect(text.includes(translation)).toBe(translated)
      expect(text.includes(label)).toBe(!translated)
      expect(numeric.transform[4]).toBeCloseTo(neighborX, 4)
      expect(numeric.transform[5]).toBe(700)
      expect(numeric.transform[3]).toBe(12)
    } finally {
      await task?.destroy()
      caller.release()
    }
  }
)

const entry = (): string => resolve('resources/pdf-translation/worker.mjs')
const lease = (): ReturnType<ApplicationCallerLeaseRegistry['acquire']> =>
  new ApplicationCallerLeaseRegistry().acquire({ leaseId: 'reader', surface: 'electron' })

it.each(['clear', 'next-row', 'horizontal-rule', 'too-long'] as const)(
  'fits an expanded table label on two owned lines with its acronym intact (%s)',
  async (kind) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica),
      page = pdf.addPage([612, 792]),
      caller = lease(),
      translation = kind === 'too-long' ? '手术结束后的第一个观察日（POD1）' : '术后第1天（POD1）',
      width = font.widthOfTextAtSize('POD1', 8),
      neighborX = 78.064,
      nextBaseline = kind === 'next-row' ? 688.34 : 678.34
    page.drawText('POD1', { font, size: 8, x: 40, y: 700 })
    page.drawText('17.0', { font, size: 8, x: neighborX, y: 700 })
    page.drawText('POD2', { font, size: 8, x: 40, y: nextBaseline })
    if (kind === 'horizontal-rule')
      page.drawLine({ start: { x: 39, y: 693 }, end: { x: 100, y: 693 }, thickness: 0.5 })
    const source = createPdfTranslationSource({
      resourceRequestKey: 'expanded-table-label',
      fingerprint: 'expanded-table-label',
      pages: [{ width: 612, height: 792 }],
      units: [
        {
          id: 'label',
          source: 'POD1',
          fragments: [
            {
              pageNumber: 1,
              rect: { x: 40 / 612, y: 85.2 / 792, width: width / 612, height: 8.8 / 792 },
              items: [{ index: 0, text: 'POD1' }]
            }
          ]
        },
        {
          id: 'numeric',
          source: '17.0',
          sourceOnly: true,
          fragments: [
            {
              pageNumber: 1,
              rect: { x: neighborX / 612, y: 85.2 / 792, width: 16 / 612, height: 8.8 / 792 },
              items: [{ index: 1, text: '17.0' }]
            }
          ]
        },
        {
          id: 'next-row',
          source: 'POD2',
          sourceOnly: true,
          fragments: [
            {
              pageNumber: 1,
              rect: {
                x: 40 / 612,
                y: (792 - nextBaseline - 6.8) / 792,
                width: width / 612,
                height: 8.8 / 792
              },
              items: [{ index: 2, text: 'POD2' }]
            }
          ]
        }
      ]
    })
    let task: ReturnType<typeof getDocument> | undefined
    try {
      const unit = source.units[0],
        fragments = pdfTranslationLayoutFragments(unit, source),
        output = await new PdfTranslationWriter(entry).generate(
          {
            id: 'expanded-table-label',
            preserveUnsupported: true,
            data: await pdf.save(),
            pages: source.pages,
            units: [{ ...unit, translation, fragments }]
          },
          caller.lease
        )
      task = getDocument({ data: output!, useSystemFonts: true })
      const items = (await (await (await task.promise).getPage(1)).getTextContent()).items.filter(
          (item) => 'str' in item
        ),
        written = items
          .map((item) => item.str)
          .join('')
          .replace(/\s/gu, ''),
        translated = kind === 'clear'
      expect(written.includes(translation)).toBe(translated)
      expect(items.some((item) => item.str === 'POD1')).toBe(!translated)
      for (const [text, x, y] of [
        ['17.0', neighborX, 700],
        ['POD2', 40, nextBaseline]
      ] as const) {
        const item = items.find((item) => item.str === text)!
        expect(item.transform[4]).toBeCloseTo(x, 4)
        expect(item.transform[5]).toBeCloseTo(y, 4)
        expect(item.transform[3]).toBe(8)
      }
      if (translated) {
        const first = items.find((item) => item.str.includes('术后'))!,
          acronym = items.find((item) => item.str.includes('POD1'))!
        expect(first.transform[3]).toBe(8)
        expect(first.transform[0] / first.transform[3]).toBeGreaterThanOrEqual(0.85)
        expect(first.transform[5]).toBeGreaterThan(acronym.transform[5])
        expect(acronym.str).toContain('POD1')
        expect(first.transform[5] - acronym.transform[5]).toBeGreaterThanOrEqual(8)
        expect(first.transform[5] - acronym.transform[5]).toBeLessThanOrEqual(8 * 1.35 + 0.05)
      }
    } finally {
      await task?.destroy()
      caller.release()
    }
  }
)

describe('translated PDF writer', () => {
  it.each(
    readPdfTranslationCases<{
      name: string
      scaleX: number
      scaleY: number
      shear?: number
      valid?: boolean
    }>('orthogonal-text-scaling.jsonl')
  )('$name', async ({ scaleX, scaleY, shear = 0, valid = true }) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica),
      page = pdf.addPage([612, 792]),
      caller = lease()
    page.pushOperators(concatTransformationMatrix(scaleX, 0, shear * scaleY, scaleY, 40, 700))
    page.drawText('Cell growth is measured.', { font, x: 0, y: 0, size: 12 })
    let task: ReturnType<typeof getDocument> | undefined
    try {
      const generation = new PdfTranslationWriter(entry).generate(
        {
          id: 'scaled-prose',
          data: await pdf.save(),
          pages: [{ width: 612, height: 792 }],
          units: [
            {
              source: 'Cell growth is measured.',
              translation: '测量细胞生长。',
              fragments: [
                {
                  pageNumber: 1,
                  rect: {
                    x: 40 / 612,
                    y: (792 - 700 - 13 * scaleY) / 792,
                    width: (220 * scaleX) / 612,
                    height: (20 * scaleY) / 792
                  }
                }
              ]
            }
          ]
        },
        caller.lease
      )
      if (!valid) {
        await expect(generation).rejects.toMatchObject({ failure: { code: 'unsupported-layout' } })
        return
      }
      const result = await generation
      task = getDocument({ data: result!, useSystemFonts: true })
      const text = (await (await (await task.promise).getPage(1)).getTextContent()).items
        .map((i) => ('str' in i ? i.str : ''))
        .join('')
        .replace(/\s/gu, '')
      expect(text).toBe('测量细胞生长。')
    } finally {
      await task?.destroy()
      caller.release()
    }
  })

  it.each(
    readPdfTranslationCases<{ name: string; source: string; valid: boolean; subheader?: boolean }>(
      'partial-native-table-cells.jsonl'
    )
  )('$name', async ({ source, valid, subheader = true }) => {
    const input = await fixture(),
      pdf = await PDFDocument.load(input.data),
      font = await pdf.embedFont(StandardFonts.Helvetica),
      page = pdf.getPage(0),
      caller = lease()
    page.drawText('Method Group', { font, x: 40, y: 500, size: 12 })
    const x = 40 + font.widthOfTextAtSize('Method ', 12)
    if (subheader) page.drawText('(score)', { font, x, y: 480, size: 12 })
    let task: ReturnType<typeof getDocument> | undefined
    try {
      const promise = new PdfTranslationWriter(entry).generate(
        {
          ...input,
          data: await pdf.save(),
          preserveUnsupported: true,
          units: [
            ...input.units,
            {
              source,
              translation: '组别（得分）',
              fragments: [
                {
                  pageNumber: 1,
                  rect: { x: x / 612, y: 280 / 792, width: 80 / 612, height: 36 / 792 }
                }
              ]
            }
          ]
        },
        caller.lease
      )
      if (!valid) {
        await expect(promise).rejects.toMatchObject({ failure: { code: 'source-mismatch' } })
        return
      }
      task = getDocument({ data: (await promise)!, useSystemFonts: true })
      const text = (await (await (await task.promise).getPage(1)).getTextContent()).items
        .map((i) => ('str' in i ? i.str : ''))
        .join('')
        .replace(/\s/gu, '')
      expect(text).toContain('测量细胞生长。')
      expect(text).toContain(subheader ? 'MethodGroup(score)' : 'MethodGroup')
      expect(text).not.toContain('组别')
    } finally {
      await task?.destroy()
      caller.release()
    }
  })

  it('replaces prose that starts after a leading punctuation mark in one native text object', async () => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica),
      page = pdf.addPage([612, 792]),
      prefixWidth = font.widthOfTextAtSize('. ', 12),
      source = 'Note that this correspondence',
      caller = lease()
    page.drawText(`. ${source}`, { font, x: 40, y: 700, size: 12 })
    let task: ReturnType<typeof getDocument> | undefined
    try {
      const result = await new PdfTranslationWriter(entry).generate(
        {
          id: 'leading-punctuation',
          data: await pdf.save(),
          pages: [{ width: 612, height: 792 }],
          units: [
            {
              source,
              translation: '注意这一对应关系',
              fragments: [
                {
                  pageNumber: 1,
                  rect: {
                    x: (40 + prefixWidth) / 612,
                    y: (792 - 700 - 13) / 792,
                    width: (font.widthOfTextAtSize(source, 12) + 2) / 612,
                    height: 16 / 792
                  }
                }
              ]
            }
          ]
        },
        caller.lease
      )
      task = getDocument({ data: result!, useSystemFonts: true })
      const items = (await (await (await task.promise).getPage(1)).getTextContent()).items
      for (const item of items) {
        if ('str' in item && item.str.trim())
          expect(item.transform[4]).toBeGreaterThanOrEqual(40 + prefixWidth - 1)
      }
      const text = items
        .map((i) => ('str' in i ? i.str : ''))
        .join('')
        .replace(/\s/gu, '')
      expect(text).toContain('注意这一对应关系')
      expect(text).not.toContain(source)
    } finally {
      await task?.destroy()
      caller.release()
    }
  })

  it.each(
    readPdfTranslationCases<{ name: string; preserve: boolean }>(
      'overlapping-table-region-preservation.jsonl'
    )
  )('$name', async ({ preserve }) => {
    const input = await fixture(),
      pdf = await PDFDocument.load(input.data),
      font = await pdf.embedFont(StandardFonts.Helvetica),
      page = pdf.getPage(0),
      caller = lease()
    page.drawText('First label.', { font, x: 40, y: 500, size: 12 })
    page.drawText('Second label.', { font, x: 40, y: 480, size: 12 })
    let task: ReturnType<typeof getDocument> | undefined
    try {
      const promise = new PdfTranslationWriter(entry).generate(
        {
          ...input,
          data: await pdf.save(),
          preserveUnsupported: preserve,
          units: [
            ...input.units,
            ...['First label.', 'Second label.'].map((source, index) => ({
              source,
              translation: index ? '第二项' : '第一项',
              fragments: [
                {
                  pageNumber: 1,
                  rect: {
                    x: 40 / 612,
                    y: (792 - (index ? 490 : 514)) / 792,
                    width: 150 / 612,
                    height: (index ? 20 : 24.1) / 792
                  }
                }
              ]
            }))
          ]
        },
        caller.lease
      )
      task = getDocument({ data: (await promise)!, useSystemFonts: true })
      const text = (await (await (await task.promise).getPage(1)).getTextContent()).items
        .map((i) => ('str' in i ? i.str : ''))
        .join('')
        .replace(/\s/gu, '')
      expect(text).toContain('测量细胞生长。')
      expect(text).not.toContain('Firstlabel.Secondlabel.')
      expect(text).toContain('第一项')
      expect(text).toContain('第二项')
      const items = (await (await (await task.promise).getPage(1)).getTextContent()).items.filter(
        (item): item is import('pdfjs-dist/types/src/display/api').TextItem => 'str' in item
      )
      expect(items.find((i) => i.str === '第一项')!.transform[5]).toBeGreaterThan(
        items.find((i) => i.str === '第二项')!.transform[5]
      )
    } finally {
      await task?.destroy()
      caller.release()
    }
  })

  it.each([
    { count: 1, overlap: false },
    { count: 2, overlap: false },
    { count: 2, overlap: true }
  ])('verifies $count retained table rows with overlap=$overlap', async ({ count, overlap }) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica),
      caller = lease(),
      page = pdf.addPage([612, 792]),
      source = '9.80 (7.71 to 11.89)c'
    const fragments = Array.from({ length: count }, (_, index) => {
      const y = 700 - index * 30
      page.drawText('(Above)', { font, x: 40, y: y + 10, size: 12 })
      page.drawText(source, { font, x: 40, y, size: 8 })
      return {
        pageNumber: 1,
        rect: { x: 40 / 612, y: (792 - y - 8) / 792, width: 110 / 612, height: 11 / 792 }
      }
    })
    const input: PdfTranslationPdfRequest = {
      id: 'dense-table',
      data: await pdf.save(),
      pages: [{ width: 612, height: 792 }],
      preserveUnsupported: true,
      units: [
        {
          source: Array(count).fill(source).join(' '),
          translation: '无法在狭窄的单元格中排下这段文字。'.repeat(100),
          fragments
        },
        ...fragments.map((fragment) => ({
          source: '(Above)',
          translation: '上方',
          fragments: [
            {
              ...fragment,
              rect: {
                ...fragment.rect,
                y: fragment.rect.y - 12 / 792,
                height: (overlap ? 13 : 12) / 792
              }
            }
          ]
        }))
      ]
    }
    let task: ReturnType<typeof getDocument> | undefined
    try {
      const writer = new PdfTranslationWriter(entry)
      const result = await writer.generate(input, caller.lease)
      task = getDocument({ data: result!, useSystemFonts: true })
      const doc = await task.promise
      const text = (await (await doc.getPage(1)).getTextContent()).items
        .map((item) => ('str' in item ? item.str : ''))
        .join('')
      expect(text.split(source)).toHaveLength(count + 1)
      expect(text.split(overlap ? '(Above)' : '上方')).toHaveLength(count + 1)
      await expect(
        writer.generate(
          {
            ...input,
            units: [{ ...input.units[0], source: 'Unrelated source' }, ...input.units.slice(1)]
          },
          caller.lease
        )
      ).rejects.toMatchObject({ failure: { code: 'source-mismatch' } })
    } finally {
      await task?.destroy()
      caller.release()
    }
  })

  it.each([0, 3, 8, -1])(
    'reflows ordinary mixed sizes while protecting unmatched raised glyphs: %s',
    async (raised) => {
      const pdf = await PDFDocument.create(),
        font = await pdf.embedFont(StandardFonts.Helvetica),
        page = pdf.addPage([612, 792]),
        caller = lease()
      page.drawText('Protocol', { font, x: 40, y: 700, size: raised ? 12 : 9 })
      page.drawText(raised === -1 ? ' ' : raised ? 'x' : 'Body text.', {
        font,
        x: raised ? 84 : 40,
        y: raised ? 700 + (raised === -1 ? 3 : raised) : 684,
        size: raised ? 8 : 9.25
      })
      const input: PdfTranslationPdfRequest = {
        id: 'mixed-sizes',
        data: await pdf.save(),
        pages: [{ width: 612, height: 792 }],
        preserveUnsupported: true,
        units: [
          {
            source: raised === -1 ? 'Protocol' : raised ? 'Protocolx' : 'Protocol Body text.',
            translation: raised === -1 ? '方案。' : raised ? '方案x' : '方案。正文内容。',
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 40 / 612, y: 77 / 792, width: 200 / 612, height: 50 / 792 }
              }
            ]
          }
        ]
      }
      let task: ReturnType<typeof getDocument> | undefined
      try {
        const output = await new PdfTranslationWriter(entry).generate(input, caller.lease)
        if (raised > 0) expect(output).toEqual(input.data)
        else {
          task = getDocument({ data: output!, useSystemFonts: true })
          const text = (await (await (await task.promise).getPage(1)).getTextContent()).items
            .map((i) => ('str' in i ? i.str : ''))
            .join('')
            .replace(/\s/gu, '')
          expect(text).toBe(raised === -1 ? '方案。' : '方案。正文内容。')
        }
      } finally {
        await task?.destroy()
        caller.release()
      }
    }
  )

  it('translates a colored heading grouped with ordinary body text', async () => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica),
      page = pdf.addPage([600, 800]),
      caller = lease()
    page.drawText('Analysis', { font, size: 10, x: 40, y: 700, color: rgb(0, 0.3, 0.6) })
    page.drawText('The study compared both groups.', {
      font,
      size: 10,
      x: 40,
      y: 684,
      color: rgb(0, 0, 0)
    })
    let task: ReturnType<typeof getDocument> | undefined
    try {
      const data = await new PdfTranslationWriter(entry).generate(
        {
          id: 'colored-heading',
          data: await pdf.save(),
          pages: [{ width: 600, height: 800 }],
          units: [
            {
              source: 'Analysis The study compared both groups.',
              translation: '分析。本研究比较了两组。',
              fragments: [
                {
                  pageNumber: 1,
                  rect: { x: 40 / 600, y: 80 / 800, width: 240 / 600, height: 50 / 800 }
                }
              ]
            }
          ]
        },
        caller.lease
      )
      task = getDocument({ data: data! })
      const content = await (await (await task.promise).getPage(1)).getTextContent()
      expect(
        content.items
          .map((item) => ('str' in item ? item.str : ''))
          .join('')
          .replace(/\s/gu, '')
      ).toBe('分析。本研究比较了两组。')
    } finally {
      await task?.destroy()
      caller.release()
    }
  })

  it.each(
    readPdfTranslationCases<{ name: string; nested: boolean }>('merged-table-label-context.jsonl')
  )('$name', async ({ nested }) => {
    const input = await fixture(),
      pdf = await PDFDocument.load(input.data),
      font = await pdf.embedFont(StandardFonts.Helvetica),
      caller = lease()
    const page = pdf.getPage(0)
    page.drawText('Trial result', { font, x: 40, y: 680, size: 12 })
    for (const [text, y] of [
      ['10', 700],
      ['20', 680]
    ] as const)
      page.drawText(text, { font, x: 300, y, size: 12 })
    const data = await pdf.save(),
      units = [
        {
          ...input.units[0],
          source: 'Cell growth is measured.Trial result',
          fragments: [
            {
              pageNumber: 1,
              rect: { x: 40 / 612, y: 70 / 792, width: 220 / 612, height: 60 / 792 }
            }
          ]
        },
        input.units[1],
        ...['10', '20'].map((source, i) => ({
          source,
          translation: source,
          fragments: [
            {
              pageNumber: 1,
              rect: { x: 300 / 612, y: (80 + i * 20) / 792, width: 30 / 612, height: 18 / 792 }
            }
          ]
        }))
      ]
    let actualData = data,
      actualUnits = units
    if (nested) {
      const wrapper = await PDFDocument.create(),
        embedded = await wrapper.embedPdf(data, [0, 1])
      for (const form of embedded)
        wrapper.addPage([612, 792]).drawPage(form, { x: 20, y: 300, xScale: 0.5, yScale: 0.5 })
      actualData = await wrapper.save()
      actualUnits = units.map((unit) => ({
        ...unit,
        fragments: unit.fragments.map((fragment) => ({
          ...fragment,
          rect: {
            x: 20 / 612 + fragment.rect.x / 2,
            y: 96 / 792 + fragment.rect.y / 2,
            width: fragment.rect.width / 2,
            height: fragment.rect.height / 2
          }
        }))
      }))
    }
    let task: ReturnType<typeof getDocument> | undefined
    try {
      const writer = new PdfTranslationWriter(entry)
      if (!nested)
        await expect(
          writer.generate({ ...input, data, units }, caller.lease)
        ).rejects.toMatchObject({
          failure: { code: 'unsupported-layout' }
        })
      const output = await writer.generate(
        { ...input, data: actualData, units: actualUnits, preserveUnsupported: true },
        caller.lease
      )
      task = getDocument({ data: output!, useSystemFonts: true })
      const result = await task.promise,
        first = await (await result.getPage(1)).getTextContent()
      for (const [label, y] of [
        ['Cell growth is measured.', 700],
        ['Trial result', 680],
        ['10', 700],
        ['20', 680]
      ] as const) {
        const item = first.items.find((i) => 'str' in i && i.str === label)
        expect(item && 'transform' in item && item.transform[5]).toBeCloseTo(
          nested ? 300 + y / 2 : y
        )
      }
      const second = await (await result.getPage(2)).getTextContent()
      expect(second.items.map((i) => ('str' in i ? i.str : '')).join('')).toContain(
        '测量细胞生长。'
      )
    } finally {
      await task?.destroy()
      caller.release()
    }
  })

  it.each(
    readPdfTranslationCases<{
      name: string
      proseX: number
      numericX: number
      graphic: string
      translated: boolean
    }>('numeric-column-graphic-separation.jsonl')
  )('$name', async ({ proseX, numericX, graphic, translated }) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica),
      page = pdf.addPage([612, 792]),
      caller = lease()
    page.drawText('Cells grow.', { font, x: proseX, y: 700, size: 12 })
    page.drawText('Results agree.', { font, x: proseX, y: 684, size: 12 })
    if (graphic.startsWith('form-')) {
      const figure = await PDFDocument.create(),
        figurePage = figure.addPage([80, 50]),
        figureFont = await figure.embedFont(StandardFonts.Helvetica)
      figurePage.drawText('10', { font: figureFont, x: 10, y: 26, size: 12 })
      figurePage.drawText('20', { font: figureFont, x: 10, y: 10, size: 12 })
      if (graphic === 'form-curve')
        figurePage.drawSvgPath('M 0 0 L 12 16 L 24 8 L 36 40', {
          x: 35,
          y: 45,
          borderColor: rgb(0, 0, 0),
          borderWidth: 1
        })
      else
        figurePage.drawRectangle({
          x: 0,
          y: 0,
          width: 80,
          height: 50,
          borderColor: rgb(0, 0, 0),
          borderWidth: 1
        })
      const [embedded] = await pdf.embedPdf(await figure.save())
      page.drawPage(embedded, { x: numericX - 10, y: 674, width: 80, height: 50 })
    } else {
      page.drawText('10', { font, x: numericX, y: 700, size: 12 })
      page.drawText('20', { font, x: numericX, y: 684, size: 12 })
    }
    const plotX = numericX < proseX ? numericX + 40 : proseX + 250
    if (graphic === 'curve' || graphic === 'transparent-curve')
      page.drawSvgPath('M 0 0 L 20 10 L 40 7 L 60 30', {
        x: plotX,
        y: 706,
        borderColor: rgb(0, 0, 0),
        borderWidth: 1,
        borderOpacity: graphic === 'transparent-curve' ? 0 : 1
      })
    if (graphic === 'rectangle')
      page.drawRectangle({
        x: plotX,
        y: 676,
        width: 60,
        height: 30,
        borderWidth: 1,
        borderColor: rgb(0, 0, 0)
      })
    if (graphic === 'line')
      page.drawLine({ start: { x: plotX, y: 706 }, end: { x: plotX + 60, y: 676 }, thickness: 1 })
    let task: ReturnType<typeof getDocument> | undefined
    try {
      const result = await new PdfTranslationWriter(entry).generate(
        {
          id: 'numeric-column-separation',
          preserveUnsupported: true,
          data: await pdf.save(),
          pages: [{ width: 612, height: 792 }],
          units: [
            {
              source: 'Cells grow.Results agree.',
              translation: '细胞生长。结果一致。',
              fragments: [
                {
                  pageNumber: 1,
                  rect: { x: proseX / 612, y: 78 / 792, width: 200 / 612, height: 35 / 792 }
                }
              ]
            },
            ...['10', '20'].map((source, i) => ({
              source,
              translation: source,
              fragments: [
                {
                  pageNumber: 1,
                  rect: {
                    x: numericX / 612,
                    y: (78 + i * 16) / 792,
                    width: 20 / 612,
                    height: 16 / 792
                  }
                }
              ]
            }))
          ]
        },
        caller.lease
      )
      task = getDocument({ data: result!, useSystemFonts: true })
      const text = (await (await (await task.promise).getPage(1)).getTextContent()).items
        .map((i) => ('str' in i ? i.str : ''))
        .join('')
      expect(text.includes('细胞生长。结果一致。')).toBe(translated)
      expect(text).toContain('10')
      expect(text).toContain('20')
      expect(text.includes('Cells grow.')).toBe(!translated)
    } finally {
      await task?.destroy()
      caller.release()
    }
  })

  it('retains original glyphs when native fitting would go below the readable size floor', async () => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica)
    for (let i = 0; i < 2; i++)
      pdf.addPage([612, 792]).drawText('Trial result', { font, x: 40, y: 700, size: 9 })
    const data = await pdf.save(),
      caller = lease()
    const units = [1, 2].map((pageNumber) => ({
      source: 'Trial result',
      translation: 'Testing A, Research B. 辅助放疗对',
      fragments: [
        {
          pageNumber,
          rect: {
            x: 40 / 612,
            y: (pageNumber === 1 ? 85.24 : 84.35) / 792,
            width: 256.75 / 612,
            height: (pageNumber === 1 ? 8.76 : 20) / 792
          }
        }
      ]
    }))
    let task: ReturnType<typeof getDocument> | undefined
    try {
      const writer = new PdfTranslationWriter(entry)
      await expect(
        writer.generate(
          {
            id: 'ink',
            data,
            pages: [
              { width: 612, height: 792 },
              { width: 612, height: 792 }
            ],
            units
          },
          caller.lease
        )
      ).rejects.toMatchObject({ failure: { code: 'unsupported-layout', pageNumber: 1 } })
      const result = await writer.generateDetailed(
        {
          id: 'ink',
          data,
          pages: [
            { width: 612, height: 792 },
            { width: 612, height: 792 }
          ],
          units,
          preserveUnsupported: true
        },
        caller.lease
      )
      expect(result!.layoutFailures).toEqual([
        {
          unitIndex: 0,
          code: 'unsupported-layout',
          phase: 'glyphs',
          pageNumbers: [1],
          fragmentCount: 1
        }
      ])
      task = getDocument({ data: result!.data, useSystemFonts: true })
      const doc = await task.promise
      const text = async (page: number): Promise<string> =>
        (await (await doc.getPage(page)).getTextContent()).items
          .map((i) => ('str' in i ? i.str : ''))
          .join('')
      expect(await text(1)).toBe('Trial result')
      expect(await text(2)).toBe('Testing A, Research B. 辅助放疗对')
      await task.destroy()
      task = undefined
      const joined = await writer.generate(
        {
          id: 'ink-joined',
          data,
          pages: [
            { width: 612, height: 792 },
            { width: 612, height: 792 }
          ],
          preserveUnsupported: true,
          units: [
            {
              source: 'Trial resultTrial result',
              translation: units[0].translation.repeat(3),
              fragments: units.flatMap((u) => u.fragments)
            }
          ]
        },
        caller.lease
      )
      task = getDocument({ data: joined!, useSystemFonts: true })
      const retained = await task.promise
      for (let i = 1; i <= 2; i++)
        expect(
          (await (await retained.getPage(i)).getTextContent()).items
            .map((i) => ('str' in i ? i.str : ''))
            .join('')
        ).toBe('Trial result')
    } finally {
      await task?.destroy()
      caller.release()
    }
  })
  it.each(['\n', '\r\n', '\r'])(
    'reflows model line wrapping %j without discarding translated text',
    async (newline) => {
      const input = await fixture(),
        caller = lease()
      let task: ReturnType<typeof getDocument> | undefined
      try {
        const units = input.units.map((u) => ({
          ...u,
          translation: `第一行${newline}${newline}第二行`
        }))
        const result = await new PdfTranslationWriter(entry).generate(
          { ...input, units, preserveUnsupported: true },
          caller.lease
        )
        task = getDocument({ data: result!, useSystemFonts: true })
        const doc = await task.promise
        for (let number = 1; number <= 2; number++) {
          const text = (await (await doc.getPage(number)).getTextContent()).items
            .map((i) => ('str' in i ? i.str : ''))
            .join('')
            .replace(/\s/gu, '')
          expect(text).toContain('第一行第二行')
          expect(text).not.toContain('Cellgrowth')
        }
        expect(units[0].translation).toContain(newline)
      } finally {
        await task?.destroy()
        caller.release()
      }
    }
  )

  it.each(['9.', '18.', '20.'])(
    'matches bibliography label %s independently of years',
    async (label) => {
      const pdf = await PDFDocument.create(),
        font = await pdf.embedFont(StandardFonts.Helvetica),
        page = pdf.addPage([612, 792]),
        caller = lease()
      const width = font.widthOfTextAtSize(label, 12)
      page.drawText(label, { font, x: 40, y: 700, size: 12 })
      page.drawText('Trial published in 2019. 2018. 2020.', {
        font,
        x: 46 + width,
        y: 700,
        size: 12
      })
      page.node.set(
        PDFName.of('Annots'),
        pdf.context.obj([
          pdf.context.register(
            pdf.context.obj({
              Type: 'Annot',
              Subtype: 'Link',
              Rect: [39.8, 698, 40 + width + 0.1, 711],
              Border: [0, 0, 0],
              A: { S: 'URI', URI: PDFString.of('https://example.org/reference') }
            })
          )
        ])
      )
      const input: PdfTranslationPdfRequest = {
        id: 'bibliography',
        data: await pdf.save(),
        pages: [{ width: 612, height: 792 }],
        units: [
          {
            source: `${label} Trial published in 2019. 2018. 2020.`,
            translation: `${label} 研究发表于2019年、2018年及2020年。`,
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 40 / 612, y: 75 / 792, width: 450 / 612, height: 40 / 792 }
              }
            ]
          }
        ]
      }
      let task: ReturnType<typeof getDocument> | undefined
      try {
        const writer = new PdfTranslationWriter(entry)
        const output = await writer.generate(input, caller.lease)
        task = getDocument({ data: output!, useSystemFonts: true })
        const target = await (await task.promise).getPage(1)
        expect(
          (await target.getTextContent()).items
            .map((i) => ('str' in i ? i.str : ''))
            .join('')
            .replace(/\s/gu, '')
        ).toBe(input.units[0].translation.replace(/\s/gu, ''))
        expect((await target.getAnnotations()).map((a) => a.url)).toEqual([
          'https://example.org/reference'
        ])
        await expect(
          writer.generate(
            {
              ...input,
              units: [{ ...input.units[0], translation: '8. 研究发表于2019年、2018年及2020年。' }]
            },
            caller.lease
          )
        ).rejects.toMatchObject({ failure: { code: 'annotations' } })
      } finally {
        await task?.destroy()
        caller.release()
      }
    }
  )

  it('retains every fragment of an unsupported cross-page translation', async () => {
    const input = await fixture(),
      caller = lease()
    const unit = {
      source: input.units.map((u) => u.source).join(''),
      translation: '测量细胞生长。'.repeat(1000),
      fragments: input.units.flatMap((u) => u.fragments)
    }
    try {
      const writer = new PdfTranslationWriter(entry)
      expect(
        await writer.generate({ ...input, units: [unit], preserveUnsupported: true }, caller.lease)
      ).toEqual(input.data)
      await expect(
        writer.generate(
          { ...input, units: [{ ...unit, source: 'Unrelated' }], preserveUnsupported: true },
          caller.lease
        )
      ).rejects.toMatchObject({ failure: { code: 'source-mismatch' } })
    } finally {
      caller.release()
    }
  })

  it('retains a verified unsupported region without blocking other translated pages', async () => {
    const input = await fixture(),
      pdf = await PDFDocument.load(input.data),
      caller = lease()
    pdf.getPage(0).node.set(
      PDFName.of('Annots'),
      pdf.context.obj([
        pdf.context.register(
          pdf.context.obj({
            Type: 'Annot',
            Subtype: 'Link',
            Rect: [40, 697, 65, 715],
            A: { S: 'URI', URI: PDFString.of('https://example.org') }
          })
        )
      ])
    )
    const data = await pdf.save()
    let task: ReturnType<typeof getDocument> | undefined
    try {
      const writer = new PdfTranslationWriter(entry)
      const output = await writer.generate(
        { ...input, data, preserveUnsupported: true },
        caller.lease
      )
      task = getDocument({ data: output!, useSystemFonts: true })
      const doc = await task.promise
      const first = await doc.getPage(1),
        second = await doc.getPage(2)
      const text = async (page: PDFPageProxy): Promise<string> =>
        (await page.getTextContent()).items.map((i) => ('str' in i ? i.str : '')).join('')
      expect(await text(first)).toContain('Cell growth is measured.')
      expect(await text(second)).toContain('测量细胞生长。')
      expect((await first.getAnnotations())[0].url).toBe('https://example.org/')
      await expect(
        writer.generate(
          {
            ...input,
            data,
            preserveUnsupported: true,
            units: [{ ...input.units[0], source: 'Unrelated source' }]
          },
          caller.lease
        )
      ).rejects.toMatchObject({ failure: { code: 'source-mismatch' } })
    } finally {
      await task?.destroy()
      caller.release()
    }
  })

  it.each(['translated', 'unchanged'] as const)(
    'keeps notes and markup in the original while retaining links: %s',
    async (mode) => {
      const input = await fixture(),
        pdf = await PDFDocument.load(input.data),
        caller = lease()
      const types = [
        'Text',
        'FreeText',
        'Line',
        'Square',
        'Circle',
        'Polygon',
        'PolyLine',
        'Highlight',
        'Underline',
        'Squiggly',
        'StrikeOut',
        'Stamp',
        'Caret',
        'Ink',
        'Popup'
      ]
      const annotations = types.map((Subtype) =>
        pdf.context.register(
          pdf.context.obj({
            Type: 'Annot',
            Subtype,
            Rect: [20, 20, 40, 40]
          })
        )
      )
      for (const [index, uri] of [
        [0, 'https://example.org/first'],
        [8, 'https://example.org/second']
      ] as const)
        annotations.splice(
          index,
          0,
          pdf.context.register(
            pdf.context.obj({
              Type: 'Annot',
              Subtype: 'Link',
              Rect: [400, 20, 500, 40],
              A: { S: 'URI', URI: PDFString.of(uri) }
            })
          )
        )
      pdf.getPage(0).node.set(PDFName.of('Annots'), pdf.context.obj(annotations))
      const data = await pdf.save(),
        snapshot = data.slice()
      try {
        const output = await new PdfTranslationWriter(entry).generate(
          {
            ...input,
            data,
            units: input.units.map((unit) =>
              mode === 'unchanged' ? { ...unit, translation: unit.source } : unit
            )
          },
          caller.lease
        )
        const translated = await PDFDocument.load(output!)
        const kept = translated.getPage(0).node.Annots()!
        expect(kept.size()).toBe(2)
        expect(
          [0, 1].map((i) =>
            kept
              .lookup(i, PDFDict)
              .lookup(PDFName.of('A'), PDFDict)
              .lookup(PDFName.of('URI'), PDFString)
              .decodeText()
          )
        ).toEqual(['https://example.org/first', 'https://example.org/second'])
        expect(data).toEqual(snapshot)
        expect((await PDFDocument.load(data)).getPage(0).node.Annots()!.size()).toBe(17)
      } finally {
        caller.release()
      }
    }
  )

  it.each([0, 90])(
    'preserves URI and internal links on cropped pages rotated %s',
    async (rotation) => {
      const pdf = await PDFDocument.create(),
        font = await pdf.embedFont(StandardFonts.Helvetica)
      const pages = [pdf.addPage([612, 792]), pdf.addPage([612, 792])]
      pages[0].setCropBox(20, 20, 570, 730)
      pages[0].setRotation(degrees(rotation))
      pages[0].drawText('Cell growth is measured.', {
        font,
        x: 240,
        y: 400,
        size: 12,
        rotate: degrees(rotation)
      })
      pages[0].node.set(
        PDFName.of('Annots'),
        pdf.context.obj([
          pdf.context.register(
            pdf.context.obj({
              Type: 'Annot',
              Subtype: 'Link',
              Rect: [20, 750, 590, 20],
              Border: [0, 0, 1],
              C: [0, 0, 1],
              A: { S: 'URI', URI: PDFString.of('https://example.org/paper') }
            })
          ),
          pdf.context.register(
            pdf.context.obj({
              Type: 'Annot',
              Subtype: 'Link',
              Rect: [590, 750, 20, 20],
              Border: [0, 0, 0],
              Dest: [pages[1].ref, 'XYZ', 25, 700, 1]
            })
          ),
          pdf.context.register(
            pdf.context.obj({
              Type: 'Annot',
              Subtype: 'Link',
              Rect: [40, 695, 220, 710]
            })
          )
        ])
      )
      const data = await pdf.save(),
        original = getDocument({ data: data.slice(), useSystemFonts: true }),
        caller = lease()
      let translated: ReturnType<typeof getDocument> | undefined
      try {
        const document = await original.promise,
          { source } = await extractPdfTranslationSource({
            document,
            resourceRequestKey: 'links',
            signal: caller.lease.signal
          })
        const output = await new PdfTranslationWriter(entry).generate(
          {
            id: 'links',
            data,
            pages: source.pages,
            units: source.units.map((unit) => ({ ...unit, translation: '测量细胞生长。' }))
          },
          caller.lease
        )
        translated = getDocument({ data: output!, useSystemFonts: true })
        const target = await translated.promise,
          before = await (await document.getPage(1)).getAnnotations(),
          after = await (await target.getPage(1)).getAnnotations()
        expect(after).toHaveLength(3)
        for (let i = 0; i < 3; i++) {
          for (const key of ['rect', 'color', 'borderStyle', 'url', 'quadPoints', 'hasAppearance'])
            expect(after[i][key]).toEqual(before[i][key])
        }
        expect(after[0].url).toBe('https://example.org/paper')
        expect(await target.getPageIndex(after[1].dest[0])).toBe(1)
        expect(after[1].dest.slice(1)).toEqual(before[1].dest.slice(1))
        expect(after[2].url).toBeUndefined()
        expect(after[2].dest).toBeUndefined()
        expect(
          (await (await target.getPage(1)).getTextContent()).items
            .filter((i) => 'str' in i)
            .map((i) => i.str)
            .join('')
        ).toBe('测量细胞生长。')
      } finally {
        await translated?.destroy()
        await original.destroy()
        caller.release()
      }
    }
  )

  it.each([
    'uri',
    'internal',
    'superscript',
    'prefix-only',
    'suffix-only',
    'missing',
    'duplicate',
    'source-duplicate',
    'partial',
    'partial-changed',
    'partial-gap-overflow',
    'superscript-reflow',
    'multiline',
    'quad',
    'empty-appearance',
    'empty-appearance-reflow',
    'painted-appearance',
    'state-appearance',
    'rollover-appearance',
    'rollover-state-appearance',
    'overflow'
  ] as const)(
    'preserves original inline citation glyphs through reflow and rejects unsafe alignment: %s',
    async (kind) => {
      const pdf = await PDFDocument.create(),
        font = await pdf.embedFont(StandardFonts.Helvetica),
        citation = await pdf.embedFont(StandardFonts.TimesRoman),
        sheet = pdf.addPage([612, 792]),
        caller = lease()
      const prefix =
          kind === 'suffix-only'
            ? ''
            : kind === 'source-duplicate'
              ? 'Cell [1] growth '
              : 'Cell growth is measured ',
        suffix = kind === 'prefix-only' ? '' : ' in culture.',
        x = 180,
        y = 700,
        width = citation.widthOfTextAtSize('[1]', 12)
      if (prefix) sheet.drawText(prefix, { font, x: 40, y, size: 12 })
      if (kind === 'superscript')
        sheet.drawRectangle({
          x: x - 0.5,
          y: y - 2,
          width: width + 1,
          height: 13,
          color: rgb(1, 0.95, 0.5)
        })
      sheet.drawText('[1]', {
        font: citation,
        x,
        y: kind.startsWith('superscript') ? y + 4 : y,
        size: kind.startsWith('superscript') ? 7 : 12,
        color: kind === 'superscript' ? rgb(0, 0, 1) : rgb(0, 0, 0)
      })
      if (suffix)
        sheet.drawText(suffix, {
          font,
          x: x + width + 2,
          y: kind === 'multiline' ? y - 18 : y,
          size: 12
        })
      sheet.drawRectangle({ x: 40, y: 400, width: 80, height: 80 })
      const rect = [x - 0.5, y - 2, kind.startsWith('partial') ? x + 4 : x + width + 0.5, y + 11]
      sheet.node.set(
        PDFName.of('Annots'),
        pdf.context.obj([
          pdf.context.register(
            pdf.context.obj({
              Type: 'Annot',
              Subtype: 'Link',
              Rect: rect,
              Border: [0, 0, 0],
              ...(kind.includes('appearance')
                ? {
                    AP: {
                      N:
                        kind === 'state-appearance'
                          ? {
                              On: pdf.context.register(
                                pdf.context.flateStream('0 0 10 10 re f', { BBox: [0, 0, 10, 10] })
                              )
                            }
                          : pdf.context.register(
                              pdf.context.flateStream(
                                kind === 'painted-appearance' ? '0 0 10 10 re f' : ' q Q\n',
                                {
                                  Type: 'XObject',
                                  Subtype: 'Form',
                                  BBox: [0, 0, width + 1, 13],
                                  Resources: {}
                                }
                              )
                            ),
                      ...(kind.startsWith('rollover')
                        ? {
                            R:
                              kind === 'rollover-state-appearance'
                                ? {
                                    On: pdf.context.register(
                                      pdf.context.flateStream('0 0 10 10 re f', {
                                        BBox: [0, 0, 10, 10]
                                      })
                                    )
                                  }
                                : pdf.context.register(
                                    pdf.context.flateStream('0 0 10 10 re f', {
                                      BBox: [0, 0, 10, 10]
                                    })
                                  )
                          }
                        : {})
                    }
                  }
                : {}),
              ...(kind === 'quad'
                ? {
                    QuadPoints: [
                      rect[0],
                      rect[3],
                      rect[2],
                      rect[3],
                      rect[0],
                      rect[1],
                      rect[2],
                      rect[1]
                    ]
                  }
                : {}),
              ...(kind === 'internal'
                ? { Dest: [sheet.ref, 'Fit'] }
                : { A: { S: 'URI', URI: PDFString.of('https://example.org/reference/1') } })
            })
          )
        ])
      )
      const translation =
        kind === 'superscript-reflow' || kind === 'empty-appearance-reflow'
          ? '细胞'.repeat(15) + '[1]。'
          : kind === 'partial-changed'
            ? '测量细胞生长[2]。'
            : kind === 'partial-gap-overflow'
              ? '测量细胞生长[1]' + '培养'.repeat(30)
              : kind === 'missing'
                ? '细胞生长。'
                : kind === 'duplicate'
                  ? '[1]细胞[1]。'
                  : kind === 'overflow'
                    ? '细胞生长'.repeat(40) + '[1]。'
                    : kind === 'prefix-only'
                      ? '细胞生长[1]'
                      : kind === 'suffix-only'
                        ? '[1]细胞生长。'
                        : '测量细胞生长[1]。'
      const data = await pdf.save(),
        original = getDocument({ data: data.slice(), useSystemFonts: true })
      let target: ReturnType<typeof getDocument> | undefined
      try {
        const result = new PdfTranslationWriter(entry).generate(
          {
            id: 'inline-link',
            data,
            pages: [{ width: 612, height: 792 }],
            units: [
              {
                source: prefix + '[1]' + suffix,
                translation,
                fragments: [
                  {
                    pageNumber: 1,
                    rect: { x: 40 / 612, y: 80 / 792, width: 320 / 612, height: 45 / 792 }
                  }
                ]
              }
            ]
          },
          caller.lease
        )
        if (
          ![
            'uri',
            'internal',
            'superscript',
            'superscript-reflow',
            'prefix-only',
            'suffix-only',
            'partial',
            'multiline',
            'empty-appearance',
            'empty-appearance-reflow'
          ].includes(kind)
        ) {
          await expect(result.then(() => 'unexpected success')).rejects.toMatchObject({
            failure: {
              code:
                kind === 'overflow' || kind === 'partial-gap-overflow' ? 'overflow' : 'annotations',
              pageNumber: 1
            }
          })
          return
        }
        target = getDocument({ data: (await result)!, useSystemFonts: true })
        const before = await (await original.promise).getPage(1),
          after = await (await target.promise).getPage(1)
        const oldLinks = await before.getAnnotations(),
          newLinks = await after.getAnnotations()
        if (kind === 'superscript-reflow' || kind === 'empty-appearance-reflow')
          expect(newLinks[0].rect).not.toEqual(oldLinks[0].rect)
        else expect(newLinks[0].rect).toEqual(oldLinks[0].rect)
        expect(newLinks[0].url).toEqual(oldLinks[0].url)
        expect(newLinks[0].hasAppearance).toBe(oldLinks[0].hasAppearance)
        if (kind === 'empty-appearance-reflow') {
          const label = (await after.getTextContent()).items.find(
            (item) => 'str' in item && item.str === '[1]'
          )!
          expect('str' in label && label.transform[4]).toBeGreaterThanOrEqual(newLinks[0].rect[0])
          expect('str' in label && label.transform[4] + label.width).toBeLessThanOrEqual(
            newLinks[0].rect[2]
          )
        }
        if (kind === 'internal')
          expect(await (await target.promise).getPageIndex(newLinks[0].dest[0])).toBe(0)
        const text = await after.getTextContent(),
          prior = await before.getTextContent()
        const items = text.items.filter((i) => 'str' in i),
          oldItem = prior.items.find((i) => 'str' in i && i.str === '[1]')
        expect(
          items
            .map((i) => i.str)
            .join('')
            .replace(/\s/g, '')
        ).toBe(translation)
        if (kind === 'superscript') {
          const pixels = async (page: PDFPageProxy): Promise<Uint8ClampedArray> => {
            const canvas = createCanvas(1224, 1584),
              context = canvas.getContext('2d')
            await page.render({
              canvas: null,
              canvasContext: context as unknown as CanvasRenderingContext2D,
              viewport: page.getViewport({ scale: 2 })
            }).promise
            return context.getImageData(
              Math.ceil(x * 2),
              (792 - y - 11) * 2,
              Math.floor(width * 2),
              26
            ).data
          }
          expect(await pixels(after)).toEqual(await pixels(before))
        }
        if (kind === 'partial') {
          const suffixItem = items.find((i) => i.str.includes('。'))!
          // Retaining a larger glyph object must not consume the original gap indentation.
          expect(suffixItem.transform[4]).toBeGreaterThanOrEqual(x + width + 2)
        }
        const retained = items.find((i) => i.str === '[1]')!
        if (kind === 'superscript-reflow' || kind === 'empty-appearance-reflow') {
          expect(retained.width).toBeCloseTo((oldItem as typeof retained).width, 4)
          expect(retained.transform.slice(0, 4)).toEqual(
            (oldItem as typeof retained).transform.slice(0, 4)
          )
          expect(
            items.some(
              (i) =>
                i !== retained &&
                Math.abs(
                  retained.transform[5] - i.transform[5] - (kind === 'superscript-reflow' ? 4 : 0)
                ) < 0.001
            )
          ).toBe(true)
          const dx = retained.transform[4] - (oldItem as typeof retained).transform[4],
            dy = retained.transform[5] - (oldItem as typeof retained).transform[5]
          newLinks[0].rect.forEach((v: number, i: number) =>
            expect(v - oldLinks[0].rect[i]).toBeCloseTo(i % 2 ? dy : dx, 3)
          )
        } else
          expect(retained).toMatchObject({
            transform: (oldItem as typeof retained).transform,
            width: (oldItem as typeof retained).width
          })
      } finally {
        await target?.destroy()
        await original.destroy()
        caller.release()
      }
    }
  )

  it.each(['minimum', 'ink-height', 'overflow'] as const)(
    'fits actual glyph bounds and always tests the minimum font size: %s',
    async (kind) => {
      const pdf = await PDFDocument.create(),
        font = await pdf.embedFont(StandardFonts.Helvetica),
        page = pdf.addPage([612, 792]),
        caller = lease()
      page.drawText('Hi', { font, x: 40, y: 700, size: kind === 'ink-height' ? 8 : 8.2 })
      const translation = kind === 'ink-height' ? 'aa' : '细胞',
        width = kind === 'overflow' ? 13.5 : 16.1,
        data = await pdf.save()
      let task: ReturnType<typeof getDocument> | undefined
      try {
        const pending = new PdfTranslationWriter(entry).generate(
          {
            id: 'minimum-ink',
            data,
            pages: [{ width: 612, height: 792 }],
            units: [
              {
                source: 'Hi',
                translation,
                fragments: [
                  {
                    pageNumber: 1,
                    rect: {
                      x: 40 / 612,
                      // One native line: legal Han wrapping must not provide
                      // a second line that avoids the size/overflow boundary.
                      y: 86 / 792,
                      width: width / 612,
                      height: (kind === 'ink-height' ? 6.5 : 8.5) / 792
                    }
                  }
                ]
              }
            ]
          },
          caller.lease
        )
        if (kind === 'overflow') {
          await expect(pending).rejects.toMatchObject({ failure: { code: 'overflow' } })
          return
        }
        task = getDocument({ data: (await pending)!, useSystemFonts: true })
        const items = (await (await (await task.promise).getPage(1)).getTextContent()).items.filter(
          (i) => 'str' in i
        )
        expect(items.map((i) => i.str).join('')).toBe(translation)
        expect(items[0].transform[0]).toBe(8)
      } finally {
        await task?.destroy()
        caller.release()
      }
    }
  )

  it.each(
    [0, 90, 180, 270].flatMap((rotation) =>
      (
        [
          'multiple',
          'wrap',
          'neighbor-edge',
          'compact',
          'retained',
          'overflow',
          'reordered',
          'tight'
        ] as const
      ).map((kind) => ({ rotation, kind }))
    )
  )(
    'flows around fixed links on existing lines: $kind at $rotation degrees',
    async ({ rotation, kind }) => {
      const pdf = await PDFDocument.create(),
        font = await pdf.embedFont(StandardFonts.Helvetica),
        sheet = pdf.addPage([612, 792]),
        caller = lease()
      sheet.setRotation(degrees(rotation))
      const second =
          kind === 'tight'
            ? 690
            : kind === 'compact'
              ? 690.5
              : kind === 'neighbor-edge'
                ? 686
                : 676,
        point = kind === 'compact' ? 8 : 12,
        rows: readonly (readonly [string, number, number])[] =
          kind === 'retained'
            ? [
                ['Methods: ', 40, 700],
                ['First source line ', 150, 700],
                ['[1]', 340, 700],
                ['second source line ', 40, second],
                ['n = 128', 250, second],
                ['[2]', 340, second]
              ]
            : ['wrap', 'neighbor-edge'].includes(kind)
              ? [
                  [
                    kind === 'neighbor-edge'
                      ? 'First source line touches the next link rectangle '
                      : 'First source line ',
                    40,
                    700
                  ],
                  ['second source line ', 40, second],
                  ['[1]', kind === 'neighbor-edge' ? 200 : 340, second]
                ]
              : [
                  ['First source line ', 40, 700],
                  ['[1]', 340, 700],
                  ['second source line ', 40, second],
                  ['[2]', 340, second]
                ]
      for (const [text, x, y] of rows) sheet.drawText(text, { font, x, y, size: point })
      sheet.node.set(
        PDFName.of('Annots'),
        pdf.context.obj(
          rows
            .filter(([text]) => text.startsWith('['))
            .map(([, x, y]) =>
              pdf.context.register(
                pdf.context.obj({
                  Type: 'Annot',
                  Subtype: 'Link',
                  Rect: [x - 1, y - 1, x + 18, y + (kind === 'compact' ? 6.5 : point)],
                  Border: [0, 0, 0],
                  A: { S: 'URI', URI: PDFString.of('https://example.org/reference') }
                })
              )
            )
        )
      )
      const data = await pdf.save(),
        original = getDocument({ data: data.slice(), useSystemFonts: true }),
        source = rows.map(([text]) => text).join(''),
        translation =
          kind === 'reordered'
            ? '第二行[2]第一行[1]'
            : kind === 'overflow'
              ? '很长'.repeat(300) + '[1]第二行[2]'
              : ['wrap', 'neighbor-edge'].includes(kind)
                ? '测量细胞生长并记录实验结果。'.repeat(4) + '[1]'
                : kind === 'retained'
                  ? 'Methods: 第一行译文[1]第二行译文 n = 128[2]'
                  : '第一行译文[1]第二行译文[2]'
      let target: ReturnType<typeof getDocument> | undefined
      try {
        const before = await (await original.promise).getPage(1),
          viewport = before.getViewport({ scale: 1 }),
          [x1, y1, x2, y2] = viewport.convertToViewportRectangle([40, 655, 480, 715])
        const result = new PdfTranslationWriter(entry).generate(
          {
            id: 'multiline-links',
            data,
            pages: [{ width: viewport.width, height: viewport.height }],
            preserveUnsupported: kind === 'tight' && rotation === 0,
            units: [
              {
                source,
                translation,
                fragments: [
                  {
                    pageNumber: 1,
                    rect: {
                      x: Math.min(x1, x2) / viewport.width,
                      y: Math.min(y1, y2) / viewport.height,
                      width: Math.abs(x2 - x1) / viewport.width,
                      height: Math.abs(y2 - y1) / viewport.height
                    }
                  }
                ]
              }
            ]
          },
          caller.lease
        )
        if (kind === 'tight' && rotation === 0) {
          target = getDocument({ data: (await result)!, useSystemFonts: true })
          const after = await (await target.promise).getPage(1),
            items = (await after.getTextContent()).items.filter((i) => 'str' in i)
          expect(items.map((i) => i.str).join('')).toBe(source)
          return
        }
        if (['overflow', 'tight'].includes(kind)) {
          await expect(result).rejects.toMatchObject({
            failure: { code: kind === 'overflow' ? 'overflow' : 'annotations' }
          })
          return
        }
        target = getDocument({ data: (await result)!, useSystemFonts: true })
        const after = await (await target.promise).getPage(1),
          prior = (await before.getTextContent()).items.filter((i) => 'str' in i),
          items = (await after.getTextContent()).items.filter((i) => 'str' in i)
        expect(
          items
            .map((i) => i.str)
            .join('')
            .replace(/\s/g, '')
        ).toBe(translation.replace(/\s/g, ''))
        if (kind === 'reordered') {
          const links = await after.getAnnotations()
          expect(links).toHaveLength(2)
          for (const [i, link] of links.entries()) {
            expect(link.url).toBe('https://example.org/reference')
            const label = items.find((item) => item.str === `[${i + 1}]`)!
            expect(label).toBeDefined()
            expect(label.transform[4]).toBeGreaterThanOrEqual(link.rect[0] - 1)
            expect(label.transform[4]).toBeLessThanOrEqual(link.rect[2] + 1)
            expect(label.transform[5]).toBeGreaterThanOrEqual(link.rect[1] - 1)
            expect(label.transform[5]).toBeLessThanOrEqual(link.rect[3] + 1)
          }
          return
        }
        expect(await after.getAnnotations()).toEqual(await before.getAnnotations())
        for (const label of ['wrap', 'neighbor-edge'].includes(kind)
          ? ['[1]']
          : kind === 'retained'
            ? ['Methods:', 'n = 128', '[1]', '[2]']
            : ['[1]', '[2]']) {
          const previous = prior.find((i) => i.str === label)!
          const retained = items.find((i) => i.str === label)!
          expect(retained.transform).toEqual(previous.transform)
          expect(retained.width).toBeCloseTo(previous.width, 6)
        }
        const prose = items.filter((i) => i.str.trim() && !i.str.startsWith('['))
        expect(new Set(prose.map((i) => i.transform[5]))).toEqual(new Set([700, second]))
        expect(
          prose.every((i) => i.transform[4] >= 40 && i.transform[4] + i.width <= 480.001)
        ).toBe(true)
      } finally {
        await target?.destroy()
        await original.destroy()
        caller.release()
      }
    }
  )

  it.each([
    ['normal', 0],
    ['normal', 90],
    ['normal', 180],
    ['normal', 270],
    ['overflow', 0],
    ['partial-object', 0],
    ['repeated', 0],
    ['multiline', 0],
    ['whitespace', 0]
  ] as const)(
    'retains unchanged source runs around links: %s, %s degrees',
    async (kind, rotation) => {
      const pdf = await PDFDocument.create(),
        sheet = pdf.addPage([612, 792]),
        font = await pdf.embedFont(StandardFonts.Helvetica),
        retainedFont = await pdf.embedFont(StandardFonts.TimesRomanBoldItalic),
        caller = lease()
      sheet.setRotation(degrees(rotation))
      const prefix = kind === 'partial-object' ? 'Methods: Cell' : 'Methods:',
        changed = kind === 'partial-object' ? 'growth' : 'Cell growth',
        suffix = kind === 'repeated' ? 'Methods:' : 'n = 128'
      for (const [text, x, face] of [
        [prefix, 40, retainedFont],
        [changed, 150, font],
        [suffix, 320, retainedFont],
        ['[1]', 450, font]
      ] as const) {
        sheet.drawText(text, {
          x,
          y: kind === 'multiline' && x === 40 ? 685 : 700,
          size: 12,
          font: face
        })
      }
      sheet.node.set(
        PDFName.of('Annots'),
        pdf.context.obj([
          pdf.context.register(
            pdf.context.obj({
              Type: 'Annot',
              Subtype: 'Link',
              Rect: [449, 697, 465, 712],
              Border: [0, 0, 0],
              A: { S: 'URI', URI: PDFString.of('https://example.org/reference') }
            })
          )
        ])
      )
      const source = `${prefix} ${changed} ${suffix}[1]`,
        translation =
          kind === 'whitespace'
            ? source.replace('Methods: ', 'Methods:  ')
            : `Methods: ${kind === 'overflow' ? '细胞'.repeat(100) : '细胞生长'} ${suffix}[1]`,
        data = await pdf.save(),
        original = getDocument({ data: data.slice(), useSystemFonts: true })
      let target: ReturnType<typeof getDocument> | undefined
      try {
        const before = await (await original.promise).getPage(1),
          viewport = before.getViewport({ scale: 1 }),
          [x1, y1, x2, y2] = viewport.convertToViewportRectangle([40, 667, 520, 712])
        const result = new PdfTranslationWriter(entry).generate(
          {
            id: 'retained-source-runs',
            data,
            pages: [{ width: viewport.width, height: viewport.height }],
            units: [
              {
                source,
                translation,
                fragments: [
                  {
                    pageNumber: 1,
                    rect: {
                      x: Math.min(x1, x2) / viewport.width,
                      y: Math.min(y1, y2) / viewport.height,
                      width: Math.abs(x2 - x1) / viewport.width,
                      height: Math.abs(y2 - y1) / viewport.height
                    }
                  }
                ]
              }
            ]
          },
          caller.lease
        )
        if (kind === 'overflow') {
          await expect(result).rejects.toMatchObject({
            failure: { code: 'overflow', pageNumber: 1 }
          })
          return
        }
        target = getDocument({ data: (await result)!, useSystemFonts: true })
        const after = await (await target.promise).getPage(1),
          prior = (await before.getTextContent()).items.filter((i) => 'str' in i),
          items = (await after.getTextContent()).items.filter((i) => 'str' in i)
        expect(
          items
            .map((i) => i.str)
            .join('')
            .replace(/\s/g, '')
        ).toBe(translation.replace(/\s/g, ''))
        if (kind === 'multiline') {
          const [oldLink] = await before.getAnnotations(),
            [newLink] = await after.getAnnotations()
          expect(newLink.rect).not.toEqual(oldLink.rect)
          expect(newLink.url).toBe(oldLink.url)
          expect(newLink.rect[2] - newLink.rect[0]).toBeCloseTo(
            oldLink.rect[2] - oldLink.rect[0],
            3
          )
        } else expect(await after.getAnnotations()).toEqual(await before.getAnnotations())
        const labels = kind === 'normal' || kind === 'repeated' ? [prefix, suffix, '[1]'] : ['[1]']
        for (const label of new Set(labels)) {
          const oldItems = prior.filter((i) => i.str === label),
            newItems = items.filter((i) => i.str === label)
          expect(newItems).toHaveLength(oldItems.length)
          oldItems.forEach((old, i) => {
            expect(newItems[i].width).toBeCloseTo(old.width, 4)
            expect(newItems[i].transform.slice(0, 4)).toEqual(old.transform.slice(0, 4))
            if (kind !== 'multiline') expect(newItems[i].transform).toEqual(old.transform)
          })
        }
        if (kind === 'partial-object') expect(items.some((i) => i.str === prefix)).toBe(false)
        if (kind === 'normal' && rotation === 0) {
          const crop = async (page: PDFPageProxy): Promise<Uint8ClampedArray> => {
            const canvas = createCanvas(1224, 1584),
              context = canvas.getContext('2d')
            await page.render({
              canvas: null,
              canvasContext: context as unknown as CanvasRenderingContext2D,
              viewport: page.getViewport({ scale: 2 })
            }).promise
            return context.getImageData(76, 148, 200, 48).data
          }
          expect(await crop(after)).toEqual(await crop(before))
        }
      } finally {
        await target?.destroy()
        await original.destroy()
        caller.release()
      }
    }
  )

  it.each([
    'ordered',
    'reversed-annotations',
    'missing',
    'reordered',
    'duplicate',
    'overlap',
    'shared-object',
    'gap-overflow',
    'labels-only'
  ] as const)(
    'preserves reference actions through reflow and rejects ambiguous labels: %s',
    async (kind) => {
      const pdf = await PDFDocument.create(),
        font = await pdf.embedFont(StandardFonts.Helvetica),
        sheet = pdf.addPage([612, 792]),
        caller = lease()
      const labels = ['[1]', '[2]', '[3]'],
        positions = [180, 300, 420]
      sheet.drawText('Cell growth ', { font, x: 40, y: 700, size: 12 })
      for (const [i, label] of labels.entries()) {
        sheet.drawText(label, { font, x: positions[i], y: 700, size: 12 })
        sheet.drawText(i === 2 ? ' in culture.' : ' and growth ', {
          font,
          x: positions[i] + 20,
          y: 700,
          size: 12
        })
      }
      const annotations = positions.map((x, i) =>
        pdf.context.register(
          pdf.context.obj({
            Type: 'Annot',
            Subtype: 'Link',
            Rect: [x - 0.5, 697, x + 15, 712],
            Border: [0, 0, 0],
            ...(i === 1
              ? { Dest: [sheet.ref, 'XYZ', 40, 700, null] }
              : { A: { S: 'URI', URI: PDFString.of('https://example.org/' + i) } })
          })
        )
      )
      if (kind === 'reversed-annotations') annotations.reverse()
      if (kind === 'overlap') {
        pdf.context
          .lookup(annotations[0], PDFDict)
          .set(PDFName.of('Rect'), pdf.context.obj([179.5, 697, 302, 712]))
      }
      if (kind === 'shared-object') annotations.push(annotations[0])
      sheet.node.set(PDFName.of('Annots'), pdf.context.obj(annotations))
      const translation =
        kind === 'missing'
          ? '细胞[1]生长[3]。'
          : kind === 'reordered'
            ? '细胞[2]生长[1]培养[3]。'
            : kind === 'duplicate'
              ? '细胞[1]生长[2]培养[3][2]。'
              : kind === 'gap-overflow'
                ? '细胞[1]' + '生长'.repeat(40) + '([2])培养[3]。'
                : kind === 'labels-only'
                  ? '[1][2][3]'
                  : '细胞[1]生长[2]培养[3]。'
      const data = await pdf.save(),
        original = getDocument({ data: data.slice(), useSystemFonts: true })
      let target: ReturnType<typeof getDocument> | undefined
      try {
        const result = new PdfTranslationWriter(entry).generate(
          {
            id: 'multiple-links',
            data,
            pages: [{ width: 612, height: 792 }],
            units: [
              {
                source: 'Cell growth [1] and growth [2] and growth [3] in culture.',
                translation,
                fragments: [
                  {
                    pageNumber: 1,
                    rect: { x: 40 / 612, y: 80 / 792, width: 520 / 612, height: 45 / 792 }
                  }
                ]
              }
            ]
          },
          caller.lease
        )
        if (!['ordered', 'reversed-annotations', 'gap-overflow', 'reordered'].includes(kind)) {
          await expect(result).rejects.toMatchObject({
            failure: { code: 'annotations', pageNumber: 1 }
          })
          return
        }
        target = getDocument({ data: (await result)!, useSystemFonts: true })
        const before = await (await original.promise).getPage(1),
          after = await (await target.promise).getPage(1)
        const oldLinks = await before.getAnnotations(),
          newLinks = await after.getAnnotations()
        expect(newLinks).toHaveLength(3)
        for (let i = 0; i < oldLinks.length; i++) {
          if (kind === 'gap-overflow' || kind === 'reordered') {
            expect(newLinks[i].rect).not.toEqual(oldLinks[i].rect)
            expect(newLinks[i].rect[2] - newLinks[i].rect[0]).toBeCloseTo(
              oldLinks[i].rect[2] - oldLinks[i].rect[0],
              3
            )
            expect(newLinks[i].rect[3] - newLinks[i].rect[1]).toBeCloseTo(
              oldLinks[i].rect[3] - oldLinks[i].rect[1],
              3
            )
            expect(newLinks[i].rect[0]).toBeGreaterThanOrEqual(40)
            expect(newLinks[i].rect[2]).toBeLessThanOrEqual(560)
            expect(newLinks[i].rect[1]).toBeGreaterThanOrEqual(667)
            expect(newLinks[i].rect[3]).toBeLessThanOrEqual(712)
          } else expect(newLinks[i].rect).toEqual(oldLinks[i].rect)
          expect(newLinks[i].url).toEqual(oldLinks[i].url)
          if (oldLinks[i].dest) {
            expect(newLinks[i].dest.slice(1)).toEqual(oldLinks[i].dest.slice(1))
            expect(await (await target.promise).getPageIndex(newLinks[i].dest[0])).toBe(0)
          }
        }
        const prior = (await before.getTextContent()).items.filter((i) => 'str' in i),
          items = (await after.getTextContent()).items.filter((i) => 'str' in i)
        expect(
          items
            .map((i) => i.str)
            .join('')
            .replace(/\s/g, '')
        ).toBe(translation)
        if (kind === 'gap-overflow') {
          const citation = items.find((i) => i.str === '[2]')!
          const opening = items.find((i) => i.str.trimEnd().endsWith('('))!
          const closing = items.find((i) => i.str.trimStart().startsWith(')'))!
          expect(opening.transform[5]).toBeCloseTo(citation.transform[5], 3)
          expect(closing.transform[5]).toBeCloseTo(citation.transform[5], 3)
        }
        for (const label of labels) {
          const previous = prior.find((i) => i.str === label)!
          const retained = items.find((i) => i.str === label)!
          expect(retained.width).toBeCloseTo(previous.width, 4)
          expect(retained.transform.slice(0, 4)).toEqual(previous.transform.slice(0, 4))
          if (!['gap-overflow', 'reordered'].includes(kind))
            expect(retained.transform).toEqual(previous.transform)
        }
      } finally {
        await target?.destroy()
        await original.destroy()
        caller.release()
      }
    }
  )

  it.each([0, 90, 180, 270])(
    'retains inline anchors on cropped pages rotated %s',
    async (rotation) => {
      const pdf = await PDFDocument.create(),
        font = await pdf.embedFont(StandardFonts.Helvetica),
        sheet = pdf.addPage([612, 792]),
        caller = lease()
      sheet.setCropBox(20, 30, 570, 730)
      sheet.setRotation(degrees(rotation))
      const cos = Math.round(Math.cos((rotation * Math.PI) / 180)),
        sin = Math.round(Math.sin((rotation * Math.PI) / 180)),
        world = (x: number, y: number): [number, number] => [
          240 + cos * x - sin * y,
          400 + sin * x + cos * y
        ]
      const labelX = font.widthOfTextAtSize('Cell growth ', 12) + 1,
        labelWidth = font.widthOfTextAtSize('[1]', 12)
      for (const [text, offset] of [
        ['Cell growth ', 0],
        ['[1]', labelX],
        [' in culture ', labelX + labelWidth + 1],
        ['[2]', labelX + labelWidth + font.widthOfTextAtSize(' in culture ', 12) + 2]
      ] as const) {
        const [x, y] = world(offset, 0)
        sheet.drawText(text, { font, x, y, size: 12, rotate: degrees(rotation) })
      }
      const corners = [world(labelX - 0.1, -3), world(labelX + labelWidth / 2, 12)],
        rect = [
          Math.min(...corners.map((p) => p[0])),
          Math.min(...corners.map((p) => p[1])),
          Math.max(...corners.map((p) => p[0])),
          Math.max(...corners.map((p) => p[1]))
        ]
      const secondCorners = [
        world(labelX + labelWidth + font.widthOfTextAtSize(' in culture ', 12) + 1.9, -3),
        world(labelX + 2 * labelWidth + font.widthOfTextAtSize(' in culture ', 12) + 2.1, 12)
      ]
      const secondRect = [
        Math.min(...secondCorners.map((p) => p[0])),
        Math.min(...secondCorners.map((p) => p[1])),
        Math.max(...secondCorners.map((p) => p[0])),
        Math.max(...secondCorners.map((p) => p[1]))
      ]
      sheet.node.set(
        PDFName.of('Annots'),
        pdf.context.obj([
          pdf.context.register(
            pdf.context.obj({
              Type: 'Annot',
              Subtype: 'Link',
              Rect: secondRect,
              Border: [0, 0, 0],
              Dest: [sheet.ref, 'Fit']
            })
          ),
          pdf.context.register(
            pdf.context.obj({
              Type: 'Annot',
              Subtype: 'Link',
              Rect: rect,
              Border: [0, 0, 0],
              Dest: [sheet.ref, 'Fit']
            })
          )
        ])
      )
      const data = await pdf.save(),
        original = getDocument({ data: data.slice(), useSystemFonts: true })
      let target: ReturnType<typeof getDocument> | undefined
      try {
        const { source } = await extractPdfTranslationSource({
          document: await original.promise,
          resourceRequestKey: 'rotated-inline',
          signal: caller.lease.signal
        })
        expect(source.units).toHaveLength(1)
        const translation = '细胞生长[1]培养[2]'
        const output = await new PdfTranslationWriter(entry).generate(
          {
            id: 'rotated-inline',
            data,
            pages: source.pages,
            units: source.units.map((u) => ({ ...u, translation }))
          },
          caller.lease
        )
        target = getDocument({ data: output!, useSystemFonts: true })
        const before = await (await original.promise).getPage(1),
          after = await (await target.promise).getPage(1)
        const oldLinks = await before.getAnnotations(),
          newLinks = await after.getAnnotations()
        expect(newLinks).toHaveLength(2)
        for (let i = 0; i < 2; i++)
          newLinks[i].rect.forEach((value: number, index: number) =>
            expect(value).toBeCloseTo(oldLinks[i].rect[index], 3)
          )
        expect(
          (await after.getTextContent()).items
            .filter((i) => 'str' in i)
            .map((i) => i.str)
            .join('')
            .replace(/\s/g, '')
        ).toBe(translation)
      } finally {
        await target?.destroy()
        await original.destroy()
        caller.release()
      }
    }
  )

  it('rejects sub-word links over changed text and unsupported link actions', async () => {
    for (const kind of ['sub-word', 'launch']) {
      const input = await fixture(),
        pdf = await PDFDocument.load(input.data),
        caller = lease()
      pdf.getPage(0).node.set(
        PDFName.of('Annots'),
        pdf.context.obj([
          pdf.context.register(
            pdf.context.obj({
              Type: 'Annot',
              Subtype: 'Link',
              Rect: [40, 695, 60, 710],
              A:
                kind === 'launch'
                  ? { S: 'Launch', F: PDFString.of('example.txt') }
                  : { S: 'URI', URI: PDFString.of('https://example.org/') }
            })
          )
        ])
      )
      try {
        await expect(
          new PdfTranslationWriter(entry).generate(
            { ...input, data: await pdf.save() },
            caller.lease
          )
        ).rejects.toMatchObject({ failure: { code: 'annotations', pageNumber: 1 } })
      } finally {
        caller.release()
      }
    }
  })

  it.each(
    readPdfTranslationCases<{
      name: string
      scale: number
      group: 'none' | 'matching' | 'isolated'
      eligible: boolean
    }>('page-sized-form-containers.jsonl')
  )('$name', async ({ scale, group, eligible }) => {
    const leaf = await PDFDocument.create(),
      font = await leaf.embedFont(StandardFonts.Helvetica),
      sourcePage = leaf.addPage([600, 800])
    sourcePage.drawText('The sample remains stable.', { x: 40, y: 700, size: 12, font })
    sourcePage.drawText('Measurements are reproducible.', { x: 40, y: 500, size: 12, font })
    // The Form BBox clips this graphic; flattening must not expose the hidden end.
    sourcePage.drawRectangle({ x: 570, y: 200, width: 80, height: 80, color: rgb(1, 0, 0) })
    const pdf = await PDFDocument.create(),
      embedded = await pdf.embedPage(sourcePage),
      target = pdf.addPage([600, 800])
    target.drawPage(embedded, { x: 30, y: 40, xScale: scale, yScale: scale })
    await pdf.flush()
    if (group !== 'none') {
      const pageGroup = pdf.context.obj({ S: 'Transparency', CS: 'DeviceRGB' }),
        form = pdf.context.lookup(embedded.ref) as unknown as { dict: PDFDict }
      target.node.set(PDFName.of('Group'), pageGroup)
      form.dict.set(
        PDFName.of('Group'),
        group === 'matching'
          ? pageGroup
          : pdf.context.obj({ S: 'Transparency', CS: 'DeviceRGB', I: true })
      )
    }
    const data = await pdf.save(),
      original = getDocument({ data: data.slice(), useSystemFonts: true }),
      caller = lease()
    let translated: ReturnType<typeof getDocument> | undefined
    try {
      const { source } = await extractPdfTranslationSource({
        document: await original.promise,
        resourceRequestKey: 'page-container',
        signal: caller.lease.signal
      })
      const request = {
        id: 'page-container',
        data,
        pages: source.pages,
        units: source.units
          .filter((u) => !u.sourceOnly)
          .map((u) => ({ ...u, translation: '测量结果稳定。' }))
      }
      const generation = new PdfTranslationWriter(entry).generate(request, caller.lease)
      if (!eligible) {
        await expect(generation).rejects.toMatchObject({ failure: { code: 'source-mismatch' } })
        return
      }
      const output = await generation
      translated = getDocument({ data: output!, useSystemFonts: true })
      const before = await (await original.promise).getPage(1),
        after = await (await translated.promise).getPage(1)
      const text = (await after.getTextContent()).items
        .filter((i) => 'str' in i)
        .map((i) => i.str)
        .join('')
      expect(text).toContain('测量结果稳定。')
      expect(text).not.toContain('The sample')
      expect(text).not.toContain('Measurements')
      const graphics = async (page: PDFPageProxy): Promise<Buffer> => {
        const viewport = page.getViewport({ scale: 1 }),
          canvas = createCanvas(600, 800),
          context = canvas.getContext('2d')
        await page.render({
          canvas: null,
          canvasContext: context as unknown as CanvasRenderingContext2D,
          viewport
        }).promise
        return Buffer.from(context.getImageData(0, 550, 600, 250).data)
      }
      expect(await graphics(after)).toEqual(await graphics(before))
    } finally {
      await translated?.destroy()
      await original.destroy()
      caller.release()
    }
  })

  it.each(
    readPdfTranslationCases<{ name: string; translation: string }>(
      'native-power-base-adjacency.jsonl'
    )
  )('$name', async ({ translation }) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.TimesRoman),
      page = pdf.addPage([600, 800]),
      prefix = 'The measured value a',
      x = 40 + font.widthOfTextAtSize(prefix, 12)
    page.drawText(prefix, { font, x: 40, y: 700, size: 12 })
    page.drawText('2', { font, x, y: 704, size: 8 })
    page.drawText(' remains stable.', { font, x: x + 5, y: 700, size: 12 })
    const caller = lease()
    let task: ReturnType<typeof getDocument> | undefined
    try {
      const data = await new PdfTranslationWriter(entry).generate(
        {
          id: 'power-adjacency',
          data: await pdf.save(),
          pages: [{ width: 600, height: 800 }],
          units: [
            {
              source: prefix + '2 remains stable.',
              translation,
              fragments: [
                {
                  pageNumber: 1,
                  rect: { x: 40 / 600, y: 80 / 800, width: 400 / 600, height: 30 / 800 }
                }
              ]
            }
          ]
        },
        caller.lease
      )
      task = getDocument({ data: data!, useSystemFonts: true })
      const items = (await (await (await task.promise).getPage(1)).getTextContent()).items.filter(
          (i) => 'str' in i
        ),
        base = items.find((i) => i.str.endsWith('a'))!,
        power = items.find((i) => i.str === '2')!
      expect(base).toBeDefined()
      expect(power).toBeDefined()
      expect(Math.abs(power.transform[4] - base.transform[4] - base.width)).toBeLessThan(2)
      expect(power.transform[5] - base.transform[5]).toBeCloseTo(4, 1)
    } finally {
      await task?.destroy()
      caller.release()
    }
  })

  it('retains exact unchanged scientific text bytes, including small italic superscripts', async () => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.TimesRomanItalic)
    pdf.addPage([612, 792]).drawText('10² µmol; p = 0.05', { font, x: 40, y: 700, size: 7 })
    const data = await pdf.save(),
      original = getDocument({ data: data.slice(), useSystemFonts: true }),
      caller = lease()
    try {
      const { source } = await extractPdfTranslationSource({
        document: await original.promise,
        resourceRequestKey: 'unchanged',
        signal: caller.lease.signal
      })
      const output = await new PdfTranslationWriter(entry).generate(
        {
          id: 'unchanged',
          data,
          pages: source.pages,
          units: source.units.map((u) => ({ ...u, translation: u.source }))
        },
        caller.lease
      )
      expect(output).toEqual(data)
    } finally {
      await original.destroy()
      caller.release()
    }
  })

  it.each([
    { source: 'SRAM: 19 TB/s (20 MB)', target: 'SRAM：19 TB/s（20 MB）', retained: true },
    { source: 'HBM: 1.5 TB/s (40 GB)', target: 'HBM：1.5 TB/s（40 GB）', retained: true },
    { source: '1 2', target: '12', retained: false },
    { source: 'ℝ', target: 'R', retained: false },
    { source: 'x²', target: 'x2', retained: false },
    { source: '10 MB', target: '10 GB', retained: false },
    { source: 'x + 2', target: 'x - 2', retained: false },
    { source: 'SRAM', target: 'sram', retained: false },
    { source: '10-20', target: '10:20', retained: false },
    { source: '5 µmol', target: '5 μmol', retained: false }
  ])('verifies presentation-only native retention: $source → $target', async (sample) => {
    const pdf = await PDFDocument.create(),
      caller = lease()
    const font = await pdf.embedFont(StandardFonts.TimesRoman)
    pdf.addPage([612, 792]).drawText(sample.source === 'ℝ' ? 'R' : sample.source, {
      font,
      x: 40,
      y: 700,
      size: 9
    })
    if (sample.source === 'ℝ') {
      // Use an explicit mathematical ToUnicode identity. StandardFonts cannot
      // encode this symbol, but the native text must not be folded into Latin R.
      await pdf.flush()
      const dictionary = pdf.context.lookup(font.ref, PDFDict)
      dictionary.set(
        PDFName.of('ToUnicode'),
        pdf.context.register(
          pdf.context.flateStream(
            '/CIDInit /ProcSet findresource begin 12 dict begin begincmap ' +
              '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def ' +
              '/CMapName /MathIdentity def /CMapType 2 def ' +
              '1 begincodespacerange <00> <FF> endcodespacerange ' +
              '1 beginbfchar <52> <211D> endbfchar ' +
              'endcmap CMapName currentdict /CMap defineresource pop end end'
          )
        )
      )
    }
    const data = await pdf.save(),
      unit = {
        source: sample.source,
        translation: sample.target,
        fragments: [
          { pageNumber: 1, rect: { x: 35 / 612, y: 70 / 792, width: 180 / 612, height: 30 / 792 } }
        ]
      },
      writer = new PdfTranslationWriter(entry)
    try {
      const output = await writer.generateDetailed(
        {
          id: 'presentation-retention',
          data,
          pages: [{ width: 612, height: 792 }],
          units: [unit],
          preserveUnsupported: true
        },
        caller.lease
      )
      expect(output).not.toBeNull()
      if (sample.retained) {
        expect(output!.data).toEqual(data)
        expect(output!.layoutFailures).toEqual([])
        // Presentation equivalence cannot bypass verification of actual native ink.
        await expect(
          writer.generateDetailed(
            {
              id: 'presentation-wrong-source',
              data,
              pages: [{ width: 612, height: 792 }],
              units: [
                { ...unit, source: 'HBM: 19 TB/s (20 MB)', translation: 'HBM：19 TB/s（20 MB）' }
              ]
            },
            caller.lease
          )
        ).rejects.toMatchObject({ failure: { code: 'source-mismatch' } })
      } else {
        // A real change must either repaint or report a retained-layout failure;
        // it must never silently pass as unchanged mathematical/scientific ink.
        expect(
          output!.layoutFailures.length > 0 || !Buffer.from(output!.data).equals(Buffer.from(data))
        ).toBe(true)
      }
    } finally {
      caller.release()
    }
  })

  it.each(['partial-object', 'nested-form'] as const)(
    'verifies unchanged %s text without claiming deletion ownership',
    async (kind) => {
      const input = await fixture(),
        pdf = await PDFDocument.load(input.data),
        font = await pdf.embedFont(StandardFonts.Helvetica),
        page = pdf.getPage(0),
        caller = lease()
      let x = 40
      const y = 470
      const label = kind === 'partial-object' ? 'FastTree' : '0.3'
      if (kind === 'partial-object') {
        const prefix = 'Results from '
        page.drawText(prefix + label, { x, y, size: 12, font })
        x += font.widthOfTextAtSize(prefix, 12)
      } else {
        const leaf = await PDFDocument.create(),
          leafFont = await leaf.embedFont(StandardFonts.Helvetica),
          leafPage = leaf.addPage([160, 80])
        leafPage.drawText(label, { x: 20, y: 30, size: 12, font: leafFont })
        const wrapper = await PDFDocument.create(),
          wrapperPage = wrapper.addPage([160, 80])
        wrapperPage.drawPage(await wrapper.embedPage(leafPage))
        const [form] = await pdf.embedPdf(await wrapper.save(), [0])
        // Reuse the same nested form twice; neither instance may be changed.
        page.drawPage(form, { x: 40, y: 440 })
        page.drawPage(form, { x: 280, y: 440 })
        x = 60
      }
      const data = await pdf.save(),
        unit = {
          source: label,
          translation: label,
          fragments: [
            {
              pageNumber: 1,
              rect: {
                x: x / 612,
                y: (792 - y - 12) / 792,
                width: font.widthOfTextAtSize(label, 12) / 612,
                height: 16 / 792
              }
            }
          ]
        },
        original = getDocument({ data: data.slice(), useSystemFonts: true }),
        writer = new PdfTranslationWriter(entry)
      let translated: ReturnType<typeof getDocument> | undefined
      const generate = (units: PdfTranslationPdfRequest['units']): Promise<Uint8Array | null> =>
        writer.generate({ ...input, data, units }, caller.lease)
      try {
        expect(await generate([unit])).toEqual(data)
        await expect(
          generate([{ ...unit, source: 'wrong', translation: 'wrong' }])
        ).rejects.toMatchObject({ failure: { code: 'source-mismatch' } })
        await expect(
          generate([
            { ...unit, fragments: [{ pageNumber: 1, rect: { ...unit.fragments[0].rect, y: 0.2 } }] }
          ])
        ).rejects.toMatchObject({ failure: { code: 'source-mismatch' } })
        // Read-only admission must not make a partial/nested object editable.
        await expect(generate([{ ...unit, translation: '结果' }])).rejects.toMatchObject({
          failure: { code: 'source-mismatch' }
        })
        const output = await writer.generate(
          {
            ...input,
            data,
            units: [...input.units, { ...unit, translation: '结果' }],
            preserveUnsupported: true
          },
          caller.lease
        )
        translated = getDocument({ data: output!, useSystemFonts: true })
        const before = await (await original.promise).getPage(1),
          after = await (await translated.promise).getPage(1)
        const text = (await after.getTextContent()).items
          .filter((item) => 'str' in item)
          .map((item) => item.str)
          .join('')
        expect(text).toContain('测量细胞生长。')
        expect(text).toContain(label)
        const render = async (page: PDFPageProxy): Promise<Buffer> => {
          const viewport = page.getViewport({ scale: 1 }),
            canvas = createCanvas(viewport.width, viewport.height),
            context = canvas.getContext('2d')
          await page.render({
            canvas: null,
            canvasContext: context as unknown as CanvasRenderingContext2D,
            viewport
          }).promise
          return Buffer.from(context.getImageData(0, 200, 612, 592).data)
        }
        expect((await render(after)).equals(await render(before))).toBe(true)
      } finally {
        await translated?.destroy()
        await original.destroy()
        caller.release()
      }
    }
  )

  it.each(['verified', 'numeric-mismatch', 'fragmented-mismatch'] as const)(
    'protects a retained fragment at a changed object boundary: %s',
    async (kind) => {
      const pdf = await PDFDocument.create(),
        font = await pdf.embedFont(StandardFonts.Helvetica),
        caller = lease()
      pdf.addPage([612, 792]).drawText('Results i', { x: 40, y: 470, size: 12, font })
      const boundary = 40 + font.widthOfTextAtSize('Results ', 12)
      const rect = { x: 40 / 612, y: 310 / 792, width: (boundary - 40) / 612, height: 16 / 792 }
      try {
        const input: PdfTranslationPdfRequest = {
          id: 'retained-boundary',
          data: await pdf.save(),
          pages: [{ width: 612, height: 792 }],
          units: [
            { source: 'Results i', translation: '结果', fragments: [{ pageNumber: 1, rect }] }
          ]
        }
        const writer = new PdfTranslationWriter(entry)
        // The whole object fits within the normal two-point glyph-outline tolerance.
        expect(await writer.generate(input, caller.lease)).toBeInstanceOf(Uint8Array)
        expect(
          await writer.generate(
            {
              ...input,
              preserveUnsupported: true,
              units: [
                ...input.units,
                {
                  source:
                    kind === 'verified'
                      ? 'i'
                      : kind === 'numeric-mismatch'
                        ? '1'
                        : 'Unverified fragment',
                  translation: kind === 'verified' ? 'i' : 'unverified',
                  fragments: Array.from({ length: kind === 'fragmented-mismatch' ? 3 : 1 }, () => ({
                    pageNumber: 1,
                    rect: {
                      ...rect,
                      x: boundary / 612,
                      width: font.widthOfTextAtSize('i', 12) / 612
                    }
                  }))
                }
              ]
            },
            caller.lease
          )
        ).toEqual(input.data)
      } finally {
        caller.release()
      }
    }
  )

  it('retains an unverified numeric region while translating independent regions', async () => {
    const input = await fixture(),
      caller = lease()
    let task: ReturnType<typeof getDocument> | undefined
    try {
      const output = await new PdfTranslationWriter(entry).generate(
        {
          ...input,
          preserveUnsupported: true,
          units: [
            ...input.units,
            {
              source: '999',
              translation: '不可替换',
              fragments: [
                {
                  pageNumber: 1,
                  rect: { x: 40 / 612, y: 180 / 792, width: 220 / 612, height: 35 / 792 }
                }
              ]
            }
          ]
        },
        caller.lease
      )
      task = getDocument({ data: output!, useSystemFonts: true })
      const page = await (await task.promise).getPage(1)
      const text = (await page.getTextContent()).items
        .filter((item) => 'str' in item)
        .map((item) => item.str)
        .join('')
      expect(text).toContain('测量细胞生长。')
      expect(text).toContain('p = 0.05; n = 128')
      expect(text).not.toContain('不可替换')
    } finally {
      await task?.destroy()
      caller.release()
    }
  })

  it.each(['kept', 'joined', 'letter', 'number', 'minus'] as const)(
    'matches only engine-verified line-end hyphens: %s',
    async (kind) => {
      const pdf = await PDFDocument.create(),
        font = await pdf.embedFont(StandardFonts.Helvetica),
        page = pdf.addPage([612, 792]),
        caller = lease()
      const count = ['kept', 'joined'].includes(kind) ? 6 : 1
      for (let i = 0; i < count; i++) {
        page.drawText('bio-', { font, x: 40, y: 700 - i * 36, size: 12 })
        page.drawText('medical', { font, x: 40, y: 682 - i * 36, size: 12 })
      }
      const separator = { kept: '-', joined: '', letter: 'Z', number: '2', minus: '−' }[kind]
      const input: PdfTranslationPdfRequest = {
        id: 'hyphens',
        data: await pdf.save(),
        pages: [{ width: 612, height: 792 }],
        units: [
          {
            source: ('bio' + separator + 'medical ').repeat(count).trim(),
            translation: '医学',
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 40 / 612, y: 80 / 792, width: 100 / 612, height: (36 * count) / 792 }
              }
            ]
          }
        ]
      }
      let task: ReturnType<typeof getDocument> | undefined
      try {
        const result = new PdfTranslationWriter(entry).generate(input, caller.lease)
        if (!['kept', 'joined'].includes(kind)) {
          await expect(result.then(() => 'unexpected success')).rejects.toMatchObject({
            failure: { code: 'source-mismatch' }
          })
          return
        }
        task = getDocument({ data: (await result)!, useSystemFonts: true })
        const text = (await (await (await task.promise).getPage(1)).getTextContent()).items
          .filter((item) => 'str' in item)
          .map((item) => item.str)
          .join('')
        expect(text).toBe('医学')
      } finally {
        await task?.destroy()
        caller.release()
      }
    }
  )

  it.each(['outside-edited', 'outside-retained', 'inside', 'boundary', 'second-region'] as const)(
    'scopes unknown-glyph rejection to the source region: %s',
    async (kind) => {
      const pdf = await PDFDocument.create(),
        font = await pdf.embedFont(StandardFonts.Helvetica),
        unknown = await pdf.embedFont(StandardFonts.Courier),
        page = pdf.addPage([612, 792]),
        caller = lease()
      page.drawText('bio-', { font, x: 40, y: 700, size: 12 })
      page.drawText('medical', { font, x: 40, y: 682, size: 12 })
      page.drawText('A', {
        font: unknown,
        x: kind === 'boundary' ? 141 : 40,
        y: kind.startsWith('outside') || kind === 'second-region' ? 500 : 700,
        size: 12
      })
      await mapUnknownGlyph(pdf, unknown)
      const data = await pdf.save()
      const fragments = [
        { pageNumber: 1, rect: { x: 40 / 612, y: 80 / 792, width: 100 / 612, height: 36 / 792 } }
      ]
      if (kind === 'second-region')
        fragments.push({
          pageNumber: 1,
          rect: { x: 40 / 612, y: 280 / 792, width: 20 / 612, height: 20 / 792 }
        })
      let task: ReturnType<typeof getDocument> | undefined
      try {
        const result = new PdfTranslationWriter(entry).generate(
          {
            id: 'regional-hyphens',
            data,
            pages: [{ width: 612, height: 792 }],
            units: [
              {
                source: 'biomedical',
                translation: kind === 'outside-retained' ? 'biomedical' : '医学',
                fragments
              }
            ]
          },
          caller.lease
        )
        if (!kind.startsWith('outside')) {
          await expect(result).rejects.toMatchObject({ failure: { code: 'source-mismatch' } })
          return
        }
        const output = (await result)!
        if (kind === 'outside-retained') expect(output).toEqual(data)
        else {
          task = getDocument({ data: output, useSystemFonts: true })
          const text = (await (await (await task.promise).getPage(1)).getTextContent()).items
            .filter((item) => 'str' in item)
            .map((item) => item.str)
            .join('')
          expect(text).toContain('医学')
          expect(text).not.toContain('medical')
        }
      } finally {
        await task?.destroy()
        caller.release()
      }
    }
  )

  it('rejects an unmapped glyph instead of using it as a source wildcard', async () => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica),
      caller = lease()
    pdf.addPage([612, 792]).drawText('A', { font, x: 40, y: 700, size: 12 })
    await mapUnknownGlyph(pdf, font)

    try {
      await expect(
        new PdfTranslationWriter(entry).generate(
          {
            id: 'unknown-glyph',
            data: await pdf.save(),
            pages: [{ width: 612, height: 792 }],
            units: [
              {
                source: 'Z',
                translation: 'Z',
                fragments: [
                  {
                    pageNumber: 1,
                    rect: { x: 40 / 612, y: 80 / 792, width: 20 / 612, height: 20 / 792 }
                  }
                ]
              }
            ]
          },
          caller.lease
        )
      ).rejects.toMatchObject({ failure: { code: 'source-mismatch' } })
    } finally {
      caller.release()
    }
  })

  it('does not remove a literal internal hyphen from the source', async () => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica),
      caller = lease()
    pdf.addPage([612, 792]).drawText('well-known', { font, x: 40, y: 700, size: 12 })
    try {
      await expect(
        new PdfTranslationWriter(entry).generate(
          {
            id: 'literal-hyphen',
            data: await pdf.save(),
            pages: [{ width: 612, height: 792 }],
            units: [
              {
                source: 'wellknown',
                translation: 'wellknown',
                fragments: [
                  {
                    pageNumber: 1,
                    rect: { x: 40 / 612, y: 80 / 792, width: 100 / 612, height: 20 / 792 }
                  }
                ]
              }
            ]
          },
          caller.lease
        )
      ).rejects.toMatchObject({ failure: { code: 'source-mismatch' } })
    } finally {
      caller.release()
    }
  })

  it('matches long unchanged text without a recursive call stack', async () => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica),
      caller = lease(),
      source = 'i'.repeat(16000)
    pdf.addPage([5000, 100]).drawText(source, { font, x: 10, y: 40, size: 1 })
    const data = await pdf.save()
    try {
      expect(
        await new PdfTranslationWriter(entry).generate(
          {
            id: 'long-source',
            data,
            pages: [{ width: 5000, height: 100 }],
            units: [
              {
                source,
                translation: source,
                fragments: [
                  {
                    pageNumber: 1,
                    rect: { x: 10 / 5000, y: 0.58, width: 4900 / 5000, height: 0.05 }
                  }
                ]
              }
            ]
          },
          caller.lease
        )
      ).toEqual(data)
    } finally {
      caller.release()
    }
  })

  it.each(['cross-page', 'columns', 'overflow', 'duplicate', 'reverse'])(
    'flows a complete paragraph through measured regions: %s',
    async (kind) => {
      const input = await fixture(),
        caller = lease()
      let data = input.data,
        fragments = input.units.flatMap((u) => u.fragments)
      if (kind === 'columns') {
        const pdf = await PDFDocument.create(),
          font = await pdf.embedFont(StandardFonts.Helvetica),
          page = pdf.addPage([612, 792])
        for (const x of [40, 330])
          page.drawText('Cell growth is measured.', { font, x, y: 700, size: 12 })
        data = await pdf.save()
        fragments = [40, 330].map((x) => ({
          pageNumber: 1,
          rect: { ...fragments[0].rect, x: x / 612 }
        }))
      }
      if (kind === 'duplicate') fragments = [fragments[0], fragments[0]]
      if (kind === 'reverse') fragments.reverse()
      const translation = '测量细胞生长。'.repeat(kind === 'overflow' ? 1000 : 10)
      let target: ReturnType<typeof getDocument> | undefined
      try {
        const result = new PdfTranslationWriter(entry).generate(
          {
            ...input,
            data,
            pages: kind === 'columns' ? [input.pages[0]] : input.pages,
            units: [{ source: input.units.map((u) => u.source).join(' '), translation, fragments }]
          },
          caller.lease
        )
        if (['overflow', 'duplicate', 'reverse'].includes(kind)) {
          await expect(result).rejects.toMatchObject({
            failure: { code: kind === 'overflow' ? 'overflow' : 'multi-region' }
          })
          return
        }
        target = getDocument({ data: (await result)!, useSystemFonts: true })
        const document = await target.promise,
          texts = []
        for (let i = 1; i <= document.numPages; i++) {
          const text = (await (await document.getPage(i)).getTextContent()).items
            .filter((item) => 'str' in item)
            .map((item) => item.str)
            .filter((text) => /[\u4e00-\u9fff]/.test(text))
            .join('')
          expect(text.length).toBeGreaterThan(0)
          texts.push(text)
        }
        expect(texts.join('')).toBe(translation)
        if (kind === 'cross-page')
          expect(texts.every((text) => text.length < translation.length)).toBe(true)
      } finally {
        await target?.destroy()
        caller.release()
      }
    }
  )
  it('rejects empty regions without starting a worker and classifies startup failure', async () => {
    const input = await fixture(),
      caller = lease()
    const writer = new PdfTranslationWriter(() => {
      throw new Error('must not start')
    })
    const unit = input.units[1]
    try {
      await expect(
        writer.generate({ ...input, units: [{ ...unit, fragments: [] }] }, caller.lease)
      ).rejects.toMatchObject({ failure: { code: 'invalid-input' } })
      await expect(writer.generate(input, caller.lease)).rejects.toMatchObject({
        failure: { code: 'worker-failed' }
      })
    } finally {
      caller.release()
    }
  })

  it('distinguishes capacity and timeout, reaping workers before allowing a retry', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pdf-generation-'))
    const path = join(directory, 'waiting.mjs')
    await writeFile(path, 'setInterval(() => {}, 1000)')
    const input = await fixture(),
      caller = lease(),
      writer = new PdfTranslationWriter(() => path)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const first = writer.generate(input, caller.lease).catch(pdfGenerationFailure)
      const second = writer
        .generate({ ...input, id: 'second' }, caller.lease)
        .catch(pdfGenerationFailure)
      await expect(writer.generate({ ...input, id: 'third' }, caller.lease)).rejects.toMatchObject({
        failure: { code: 'busy' }
      })
      await expect(writer.generate(input, caller.lease)).rejects.toMatchObject({
        failure: { code: 'busy' }
      })
      await vi.advanceTimersByTimeAsync(60000)
      expect(await first).toEqual({ code: 'timeout' })
      expect(await second).toEqual({ code: 'timeout' })
      const retry = writer.generate(input, caller.lease)
      writer.cancel(input.id, caller.lease)
      expect(await retry).toBeNull()
    } finally {
      caller.release()
      vi.useRealTimers()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('decodes only allowlisted application errors across Electron message wrapping', () => {
    const error = new PdfGenerationError({ code: 'annotations', pageNumber: 2 })
    expect(
      pdfGenerationFailure(new Error(`Error invoking remote method: ${error.message}`))
    ).toEqual({ code: 'annotations', pageNumber: 2 })
    for (const message of [
      'secret source text',
      '[pdf-generation:invented:1]',
      '[pdf-generation:annotations:501]'
    ])
      expect(pdfGenerationFailure(new Error(message))).toEqual({ code: 'worker-failed' })
  })

  it.each([0, 90, 180, 270])('preserves text rotation %s on every page rotation', async (angle) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica)
    for (const rotation of [0, 90, 180, 270]) {
      const page = pdf.addPage([612, 792])
      page.setMediaBox(-60, -40, 612, 792)
      page.setCropBox(-40, -10, 570, 730)
      page.setRotation(degrees(rotation))
      page.drawText('Cell growth is measured.', {
        font,
        x: 240,
        y: 400,
        size: 16,
        rotate: degrees(angle)
      })
      page.drawRectangle({ x: 20, y: 60, width: 100, height: 100 })
    }
    const bytes = await pdf.save(),
      original = getDocument({ data: bytes.slice(), useSystemFonts: true }),
      caller = lease()
    let translated: ReturnType<typeof getDocument> | undefined
    try {
      const document = await original.promise,
        { source } = await extractPdfTranslationSource({
          document,
          resourceRequestKey: 'text-rotation',
          signal: new AbortController().signal
        })
      expect(source.units).toHaveLength(4)
      expect(source.units.filter((unit) => !unit.sourceOnly)).toHaveLength(1)
      const output = await new PdfTranslationWriter(entry).generate(
        {
          id: 'text-rotation',
          data: bytes,
          pages: source.pages,
          units: source.units
            .filter((unit) => !unit.sourceOnly)
            .map((unit) => ({ ...unit, translation: '测量细胞生长。' }))
        },
        caller.lease
      )
      expect(output).toBeInstanceOf(Uint8Array)
      translated = getDocument({ data: output!, useSystemFonts: true })
      const target = await translated.promise
      for (let i = 1; i <= 4; i++) {
        const before = await document.getPage(i),
          after = await target.getPage(i)
        expect(after.rotate).toBe(before.rotate)
        expect(after.view).toEqual(before.view)
        const text = (await after.getTextContent()).items.filter((item) => 'str' in item)
        const translatedPage = before.rotate === angle
        expect(text.map((item) => item.str).join('')).toBe(
          translatedPage ? '测量细胞生长。' : 'Cell growth is measured.'
        )
        const item = text[0],
          sourceItem = (await before.getTextContent()).items.find((item) => 'str' in item)!
        if (!('str' in sourceItem)) throw new Error('missing source text')
        for (let axis = 0; axis < 4; axis++)
          expect(item.transform[axis]).toBeCloseTo(sourceItem.transform[axis], 4)
        expect(Math.hypot(item.transform[4] - 240, item.transform[5] - 400)).toBeLessThan(1)
        const fragment = source.units.find((unit) => unit.fragments[0].pageNumber === i)!
          .fragments[0]
        const render = async (page: PDFPageProxy): Promise<Buffer> => {
          const viewport = page.getViewport({ scale: 1 }),
            canvas = createCanvas(viewport.width, viewport.height),
            context = canvas.getContext('2d')
          await page.render({
            canvas: null,
            canvasContext: context as unknown as CanvasRenderingContext2D,
            viewport
          }).promise
          // Ignore only the admitted replacement rectangle and one antialiasing pixel.
          const r = fragment.rect
          if (translatedPage)
            context.clearRect(
              Math.floor(r.x * viewport.width) - 1,
              Math.floor(r.y * viewport.height) - 1,
              Math.ceil(r.width * viewport.width) + 3,
              Math.ceil(r.height * viewport.height) + 3
            )
          return Buffer.from(context.getImageData(0, 0, canvas.width, canvas.height).data)
        }
        expect((await render(after)).equals(await render(before))).toBe(true)
      }
    } finally {
      await translated?.destroy()
      await original.destroy()
      caller.release()
    }
  })

  it.each([8, 7.9999, 7.99, 7.5, 6.3])(
    'keeps the 8 pt output minimum for source size %s',
    async (size) => {
      const pdf = await PDFDocument.create(),
        font = await pdf.embedFont(StandardFonts.Helvetica),
        caller = lease()
      const page = pdf.addPage([612, 792])
      page.drawText('Cell growth is ', { font, x: 40, y: 700, size })
      page.drawText('measured.', {
        font,
        x: 40 + font.widthOfTextAtSize('Cell growth is ', size),
        y: 700,
        size
      })
      let output: ReturnType<typeof getDocument> | undefined
      try {
        const result = new PdfTranslationWriter(entry).generate(
          {
            id: 'font-minimum',
            data: await pdf.save(),
            pages: [{ width: 612, height: 792 }],
            units: [
              {
                source: 'Cell growth is measured.',
                translation: '细胞生长。',
                fragments: [
                  {
                    pageNumber: 1,
                    rect: { x: 40 / 612, y: 80 / 792, width: 200 / 612, height: 30 / 792 }
                  }
                ]
              }
            ]
          },
          caller.lease
        )
        output = getDocument({ data: (await result)!, useSystemFonts: true })
        const items = (await (await (await output.promise).getPage(1)).getTextContent()).items
          .filter((i) => 'str' in i)
          .filter((i) => i.str.trim())
        expect(items.map((i) => i.str).join('')).toBe('细胞生长。')
        for (const item of items)
          expect(Math.hypot(item.transform[0], item.transform[1])).toBeGreaterThanOrEqual(8)
      } finally {
        await output?.destroy()
        caller.release()
      }
    }
  )

  it('retains small source text when its translation cannot fit at 8 pt', async () => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica),
      caller = lease()
    pdf.addPage([612, 792]).drawText('Cell growth.', { font, x: 40, y: 700, size: 6.3 })
    try {
      await expect(
        new PdfTranslationWriter(entry).generate(
          {
            id: 'small-font-overflow',
            data: await pdf.save(),
            pages: [{ width: 612, height: 792 }],
            units: [
              {
                source: 'Cell growth.',
                translation: '测量细胞生长。'.repeat(20),
                fragments: [
                  {
                    pageNumber: 1,
                    rect: { x: 40 / 612, y: 80 / 792, width: 100 / 612, height: 30 / 792 }
                  }
                ]
              }
            ]
          },
          caller.lease
        )
      ).rejects.toMatchObject({ failure: { code: 'overflow', pageNumber: 1 } })
    } finally {
      caller.release()
    }
  })

  it('rejects non-quarter-turn text even with complete object coverage', async () => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica)
    pdf.addPage([612, 792]).drawText('Cell growth is measured.', {
      font,
      x: 40,
      y: 700,
      size: 12,
      rotate: degrees(15)
    })
    const caller = lease()
    try {
      await expect(
        new PdfTranslationWriter(entry).generate(
          {
            id: 'skew',
            data: await pdf.save(),
            pages: [{ width: 612, height: 792 }],
            units: [
              {
                source: 'Cell growth is measured.',
                translation: '测量细胞生长。',
                fragments: [
                  {
                    pageNumber: 1,
                    rect: { x: 20 / 612, y: 0, width: 500 / 612, height: 200 / 792 }
                  }
                ]
              }
            ]
          },
          caller.lease
        )
      ).rejects.toMatchObject({ failure: { code: 'unsupported-layout', pageNumber: 1 } })
    } finally {
      caller.release()
    }
  })

  it.each([0, 90, 180, 270])(
    'maps cropped geometry at page rotation %s while preserving boxes and graphics',
    async (rotation) => {
      const pdf = await PDFDocument.create(),
        font = await pdf.embedFont(StandardFonts.Helvetica)
      const boxes = [
        { media: [0, 0, 612, 792], crop: [20, 30, 570, 730] },
        { media: [-120, -80, 612, 792], crop: [-100, -50, 570, 730] },
        { media: [100, 200, 612, 792], crop: [100, 200, 612, 792] },
        // CropBox exceeds MediaBox: match their intersection, not either raw dictionary.
        { media: [40, 60, 500, 700], crop: [10, 20, 600, 800] }
      ]
      for (const { media, crop } of boxes) {
        const page = pdf.addPage([612, 792])
        page.setRotation(degrees(rotation))
        page.setMediaBox(media[0], media[1], media[2], media[3])
        page.setCropBox(crop[0], crop[1], crop[2], crop[3])
        const left = Math.max(media[0], crop[0]),
          bottom = Math.max(media[1], crop[1]),
          right = Math.min(media[0] + media[2], crop[0] + crop[2]),
          top = Math.min(media[1] + media[3], crop[1] + crop[3])
        const position = (x: number, y: number): { x: number; y: number } => {
          if (rotation === 90) return { x: left + y, y: bottom + x }
          if (rotation === 180) return { x: right - x, y: bottom + y }
          if (rotation === 270) return { x: right - y, y: top - x }
          return { x: left + x, y: top - y }
        }
        page.drawText('Cell growth is measured.', {
          font,
          ...position(40, 80),
          size: 16,
          rotate: degrees(rotation)
        })
        page.drawRectangle({ x: left + 40, y: top - 350, width: 180, height: 180 })
        // Remains in the PDF but outside its visible crop; must not be deleted or exposed.
        page.drawText('Outside crop', {
          font,
          ...position(-200, 80),
          size: 12,
          rotate: degrees(rotation)
        })
      }
      const bytes = await pdf.save(),
        original = getDocument({ data: bytes.slice(), useSystemFonts: true }),
        caller = lease()
      let translated: ReturnType<typeof getDocument> | undefined
      const render = async (page: PDFPageProxy): Promise<Uint8ClampedArray> => {
        const viewport = page.getViewport({ scale: 1 }),
          canvas = createCanvas(viewport.width, viewport.height),
          context = canvas.getContext('2d')
        await page.render({
          canvas: null,
          canvasContext: context as unknown as CanvasRenderingContext2D,
          viewport
        }).promise
        // Everything below the translation region must render identically.
        return context.getImageData(0, 150, canvas.width, canvas.height - 150).data
      }
      try {
        const sourceDocument = await original.promise,
          { source } = await extractPdfTranslationSource({
            document: sourceDocument,
            resourceRequestKey: 'cropped',
            signal: new AbortController().signal
          })
        expect(source.units).toHaveLength(boxes.length)
        const result = await new PdfTranslationWriter(entry).generate(
          {
            id: 'cropped',
            data: bytes,
            pages: source.pages,
            units: source.units.map((unit) => ({ ...unit, translation: '测量细胞生长。' }))
          },
          caller.lease
        )
        expect(result).toBeInstanceOf(Uint8Array)
        const saved = await PDFDocument.load(result!)
        saved.getPages().forEach((page, index) => {
          expect(page.getMediaBox()).toEqual(pdf.getPage(index).getMediaBox())
          expect(page.getCropBox()).toEqual(pdf.getPage(index).getCropBox())
          expect(page.getRotation()).toEqual(pdf.getPage(index).getRotation())
        })
        translated = getDocument({ data: result!, useSystemFonts: true })
        const targetDocument = await translated.promise
        for (let i = 1; i <= boxes.length; i++) {
          const before = await sourceDocument.getPage(i),
            after = await targetDocument.getPage(i),
            viewport = after.getViewport({ scale: 1 })
          expect(after.view).toEqual(before.view)
          expect(viewport.transform).toEqual(before.getViewport({ scale: 1 }).transform)
          const items = (await after.getTextContent()).items.filter((item) => 'str' in item)
          expect(items.map((item) => item.str).join('')).toContain('测量细胞生长。')
          expect(items.map((item) => item.str).join('')).not.toContain('Cell growth')
          const text = items.find((item) => item.str.includes('测量'))!
          const [x, y] = viewport.convertToViewportPoint(text.transform[4], text.transform[5])
          expect(x).toBeCloseTo(40, 0)
          expect(y).toBeGreaterThan(70)
          expect(y).toBeLessThan(90)
          expect(Buffer.from(await render(after)).equals(Buffer.from(await render(before)))).toBe(
            true
          )
        }
        // Remove the crop only for inspection; retained off-page objects remain selectable.
        for (const page of saved.getPages()) page.setCropBox(-500, -500, 2000, 2000)
        for (const page of saved.getPages()) page.setMediaBox(-500, -500, 2000, 2000)
        const expanded = getDocument({ data: await saved.save(), useSystemFonts: true })
        try {
          const doc = await expanded.promise
          for (let i = 1; i <= boxes.length; i++)
            expect(
              (await (await doc.getPage(i)).getTextContent()).items
                .map((item) => ('str' in item ? item.str : ''))
                .join('')
            ).toContain('Outside crop')
        } finally {
          await expanded.destroy()
        }
      } finally {
        await translated?.destroy()
        await original.destroy()
        caller.release()
      }
    }
  )

  it.each(['annotation', 'user-unit', 'clip', 'partial-crop'] as const)(
    'still rejects %s instead of silently changing page content',
    async (kind) => {
      const input = await fixture(),
        pdf = await PDFDocument.load(input.data),
        page = pdf.getPage(0),
        caller = lease()
      if (kind === 'annotation')
        page.node.set(
          PDFName.of('Annots'),
          pdf.context.obj([{ Type: 'Annot', Subtype: 'Widget', Rect: [20, 20, 40, 40] }])
        )
      if (kind === 'user-unit') page.node.set(PDFName.of('UserUnit'), pdf.context.obj(2))
      if (kind === 'partial-crop') page.setCropBox(80, 0, 532, 792)
      if (kind === 'clip') {
        const font = await pdf.embedFont(StandardFonts.Helvetica)
        page.node.delete(PDFName.of('Contents'))
        page.pushOperators(pushGraphicsState(), rectangle(40, 600, 60, 130), clip(), endPath())
        page.drawText('Clipped source', { font, x: 40, y: 700, size: 12 })
        page.pushOperators(popGraphicsState())
      }
      const data = await pdf.save(),
        task = getDocument({ data: data.slice(), useSystemFonts: true })
      try {
        const { source } = await extractPdfTranslationSource({
          document: await task.promise,
          resourceRequestKey: kind,
          signal: new AbortController().signal
        })
        expect(source.units.length).toBeGreaterThan(0)
        await expect(
          new PdfTranslationWriter(entry).generate(
            {
              ...input,
              data,
              pages: source.pages,
              units: source.units.map((unit) => ({ ...unit, translation: '测量细胞生长。' }))
            },
            caller.lease
          )
        ).rejects.toMatchObject({
          failure: {
            code:
              kind === 'annotation'
                ? 'annotations'
                : kind === 'partial-crop'
                  ? 'source-mismatch'
                  : 'unsupported-layout',
            pageNumber: 1
          }
        })
      } finally {
        await task.destroy()
        caller.release()
      }
    }
  )

  it('accepts actual extraction geometry without fixture-supplied margins', async () => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica)
    pdf.addPage([612, 792]).drawText('Cell growth is measured in controlled laboratory cultures.', {
      font,
      x: 40,
      y: 710,
      size: 16
    })
    const bytes = await pdf.save(),
      loading = getDocument({ data: bytes.slice(), useSystemFonts: true })
    const caller = lease()
    try {
      const source = (
        await extractPdfTranslationSource({
          document: await loading.promise,
          resourceRequestKey: 'real',
          signal: new AbortController().signal
        })
      ).source
      expect(source.units).toHaveLength(1)
      const result = await new PdfTranslationWriter(entry).generate(
        {
          id: 'extracted',
          data: bytes,
          pages: source.pages,
          units: source.units.map((u) => ({
            ...u,
            translation: '测量受控实验室培养物中的细胞生长。'
          }))
        },
        caller.lease
      )
      expect(result).toBeInstanceOf(Uint8Array)
    } finally {
      await loading.destroy()
      caller.release()
    }
  })
  it('writes actual selectable Chinese PDF pages and retains nontranslated text', async () => {
    const caller = lease(),
      writer = new PdfTranslationWriter(entry),
      input = await fixture()
    const result = await writer.generate(input, caller.lease)
    expect(result).toBeInstanceOf(Uint8Array)
    expect(result!.length).toBeLessThan(100000)
    const task = getDocument({ data: result!, useSystemFonts: true })
    try {
      const pdf = await task.promise
      expect(pdf.numPages).toBe(2)
      for (let i = 1; i <= 2; i++) {
        const page = await pdf.getPage(i),
          text = (await page.getTextContent()).items
            .map((item) => ('str' in item ? item.str : ''))
            .join('')
        expect(text).toContain('测量细胞生长。')
        expect(text).toContain('p = 0.05; n = 128')
        expect(text).not.toContain('Cell growth is measured.')
        expect(page.getViewport({ scale: 1 })).toMatchObject({
          width: 612,
          height: 792,
          rotation: 0
        })
      }
    } finally {
      await task.destroy()
      caller.release()
    }
  })

  it('expands an underreported fragment to its complete native text object', async () => {
    const caller = lease(),
      input = await fixture(),
      first = input.units[0]
    try {
      const result = await new PdfTranslationWriter(entry).generate(
        {
          ...input,
          id: 'underreported-fragment',
          preserveUnsupported: true,
          units: [
            {
              ...first,
              fragments: [
                {
                  ...first.fragments[0],
                  // The PDF text object is wider than this extracted fragment.
                  // Its complete source still proves that expanding ownership is safe.
                  rect: { ...first.fragments[0].rect, width: 100 / 612 }
                }
              ]
            }
          ]
        },
        caller.lease
      )
      expect(result).toBeInstanceOf(Uint8Array)
      const task = getDocument({ data: result!, useSystemFonts: true })
      try {
        const page = await (await task.promise).getPage(1),
          text = (await page.getTextContent()).items
            .map((item) => ('str' in item ? item.str : ''))
            .join('')
        expect(text).toContain('测量细胞生长。')
        expect(text).not.toContain('Cell growth is measured.')
      } finally {
        await task.destroy()
      }
    } finally {
      caller.release()
    }
  })

  it.each(['source', 'overflow', 'glyph', 'dimensions', 'partial-object'] as const)(
    'rejects %s without publishing a partial PDF',
    async (kind) => {
      const caller = lease(),
        input = await fixture()
      const first = input.units[0]
      const request =
        kind === 'source'
          ? { ...input, units: [{ ...first, source: 'Incorrect source' }] }
          : kind === 'overflow'
            ? { ...input, units: [{ ...first, translation: '测量细胞生长。'.repeat(100) }] }
            : kind === 'glyph'
              ? { ...input, units: [{ ...first, translation: '\u{10ffff}' }] }
              : kind === 'dimensions'
                ? { ...input, pages: [{ width: 611, height: 792 }, input.pages[1]] }
                : {
                    ...input,
                    units: [
                      {
                        ...first,
                        fragments: [
                          {
                            pageNumber: 1,
                            rect: { x: 50 / 612, y: 70 / 792, width: 200 / 612, height: 35 / 792 }
                          }
                        ]
                      }
                    ]
                  }
      await expect(
        new PdfTranslationWriter(entry).generate(request, caller.lease)
      ).rejects.toMatchObject({
        failure: {
          code:
            kind === 'source' || kind === 'partial-object'
              ? 'source-mismatch'
              : kind === 'overflow'
                ? 'overflow'
                : kind === 'glyph'
                  ? 'font'
                  : 'unsupported-layout',
          pageNumber: 1
        }
      })
      caller.release()
    }
  )

  it('cancels only the owning caller and reaps its worker before resolving', async () => {
    const owner = lease(),
      foreign = lease(),
      writer = new PdfTranslationWriter(entry),
      input = await fixture()
    const active = writer.generate(input, owner.lease)
    writer.cancel(input.id, foreign.lease)
    owner.release()
    expect(await active).toBeNull()
    // The same ID/slot is available after cancellation has resolved.
    expect(await writer.generate(input, foreign.lease)).toBeInstanceOf(Uint8Array)
    foreign.release()
  })

  it('rejects malformed IPC and already-disconnected callers without starting workers', async () => {
    const owner = lease(),
      writer = new PdfTranslationWriter(() => {
        throw new Error('must not start')
      })
    await expect(writer.generate(null as never, owner.lease)).rejects.toMatchObject({
      failure: { code: 'invalid-input' }
    })
    owner.release()
    await expect(writer.generate(await fixture(), owner.lease)).rejects.toThrow()
  })

  it('ships the existing Noto font license and explicit physical worker dependencies', async () => {
    const license = await readFile('resources/pdf-translation/OFL.txt', 'utf8')
    expect(license).toContain('SIL OPEN FONT LICENSE')
    const config = await readFile('electron-builder.yml', 'utf8')
    for (const path of [
      'resources/**',
      'node_modules/@embedpdf/pdfium/**',
      'node_modules/fontkit/**',
      'node_modules/pdf-lib/**',
      'node_modules/unicode-properties/**'
    ])
      expect(config).toContain(path)
  })

  it('generates a readable translated PDF from the configured ASAR unpack boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pdf-translation-asar-')),
      source = join(root, 'source'),
      archive = join(root, 'installed', 'app.asar'),
      copied = new Set<string>(),
      caller = lease()
    let document: ReturnType<typeof getDocument> | undefined
    try {
      const config = load(await readFile('electron-builder.yml', 'utf8')) as {
        asarUnpack: string[]
      }
      const copyPackage = async (
        name: string,
        from: ReturnType<typeof createRequire>
      ): Promise<void> => {
        let directory = dirname(from.resolve(name))
        let metadata: { name: string; dependencies?: Record<string, string> }
        for (;;) {
          metadata = await readFile(join(directory, 'package.json'), 'utf8')
            .then((text) => JSON.parse(text))
            .catch(() => ({ name: '' }))
          if (metadata.name === name) break
          const parent = dirname(directory)
          if (parent === directory) throw new Error(`Missing package root: ${name}`)
          directory = parent
        }
        // Preserve nested dependency versions at their installed relative location.
        const location = relative(resolve('node_modules'), directory)
        expect(isAbsolute(location) || location.startsWith('..')).toBe(false)
        if (copied.has(directory)) return
        copied.add(directory)
        const target = join(source, 'node_modules', location)
        await mkdir(dirname(target), { recursive: true })
        await cp(directory, target, { recursive: true })
        for (const dependency of Object.keys(metadata.dependencies ?? {}))
          await copyPackage(dependency, createRequire(join(directory, 'package.json')))
      }
      await mkdir(join(source, 'resources'), { recursive: true })
      await mkdir(dirname(archive), { recursive: true })
      // An ancestor's module type must not substitute for the manifest inside ASAR.
      await writeFile(join(root, 'package.json'), '{"type":"module"}')
      await writeFile(join(source, 'package.json'), '{"type":"commonjs"}')
      await cp('resources/pdf-translation', join(source, 'resources', 'pdf-translation'), {
        recursive: true
      })
      const require = createRequire(resolve('package.json'))
      for (const name of ['@embedpdf/pdfium', 'fontkit', 'pdf-lib'])
        await copyPackage(name, require)
      await createPackageWithOptions(source, archive, {
        unpack: `{${config.asarUnpack.map((pattern) => '**/' + pattern).join(',')}}`
      })
      for (const file of [
        'worker.mjs',
        'form-labels.mjs',
        'link-labels.mjs',
        'scientific-scripts.mjs',
        'NotoSansSC-Regular.otf',
        'OFL.txt'
      ])
        expect(statFile(archive, join('resources', 'pdf-translation', file))).toMatchObject({
          unpacked: true
        })
      expect(statFile(archive, 'package.json')).not.toHaveProperty('unpacked', true)
      const writer = new PdfTranslationWriter(() =>
        join(archive + '.unpacked', 'resources', 'pdf-translation', 'worker.mjs')
      )
      const output = await writer.generate(await fixture(), caller.lease)
      expect(output).toBeInstanceOf(Uint8Array)
      document = getDocument({ data: output!, useSystemFonts: true })
      const pdf = await document.promise
      expect(pdf.numPages).toBe(2)
      for (let number = 1; number <= 2; number++) {
        const page = await pdf.getPage(number)
        const text = (await page.getTextContent()).items
          .flatMap((item) => ('str' in item ? [item.str] : []))
          .join('')
        expect(text).toContain('测量细胞生长。')
        expect(text).toContain('p = 0.05; n = 128')
      }
    } finally {
      await document?.destroy()
      caller.release()
      await rm(root, { recursive: true, force: true })
    }
  }, 60000)
})

it('translates prose containing repeated formula baselines instead of retaining the paragraph', async () => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.TimesRoman),
    symbol = await pdf.embedFont(StandardFonts.Symbol),
    page = pdf.addPage([600, 800])
  page.drawText('The ratio ', { font, size: 12, x: 40, y: 700 })
  page.drawText('√', { font: symbol, size: 12, x: 95, y: 707 })
  page.drawText('1 - ', { font, size: 12, x: 104, y: 700 })
  page.drawText('β', { font: symbol, size: 12, x: 129, y: 700 })
  page.drawText('2', { font, size: 8, x: 145, y: 704 })
  page.drawText(' remains stable.', { font, size: 12, x: 151, y: 700 })
  const caller = lease()
  try {
    const data = await new PdfTranslationWriter(entry).generate(
      {
        id: 'formula-baseline-prose',
        preserveUnsupported: true,
        data: await pdf.save(),
        pages: [{ width: 600, height: 800 }],
        units: [
          {
            source: 'The ratio √1 - β2 remains stable.',
            translation: '比值\u2060 √1 - β₂ 保持稳定。',
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 40 / 600, y: 80 / 800, width: 300 / 600, height: 40 / 800 }
              }
            ]
          }
        ]
      },
      caller.lease
    )
    expect(data).toBeTruthy()
    const document = await getDocument({ data: data!, useSystemFonts: true }).promise,
      items = (await (await document.getPage(1)).getTextContent()).items
        .filter((item) => 'str' in item)
        .map((item) => item.str)
        .join('')
    expect(items).toContain('比值')
    expect(items).not.toContain('The ratio')
    await document.destroy()
  } finally {
    caller.release()
  }
})

it('uses source leading for dense Chinese references without reducing the minimum font size', async () => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica),
    page = pdf.addPage([600, 800]),
    caller = lease(),
    source = ['Dense reference one', 'Dense reference two', 'Dense reference end'],
    translation = '汉字'.repeat(12)
  for (const [index, text] of source.entries())
    page.drawText(text, { font, size: 8, x: 40, y: 700 - index * 10 })
  let task: ReturnType<typeof getDocument> | undefined
  try {
    const data = await new PdfTranslationWriter(entry).generate(
      {
        id: 'dense-reference',
        data: await pdf.save(),
        pages: [{ width: 600, height: 800 }],
        units: [
          {
            source: source.join(' '),
            translation,
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 40 / 600, y: 94 / 800, width: 80 / 600, height: 28.2 / 800 }
              }
            ]
          }
        ]
      },
      caller.lease
    )
    task = getDocument({ data: data! })
    const items = (await (await (await task.promise).getPage(1)).getTextContent()).items
      .filter((item) => 'str' in item)
      .filter((item) => item.str)
    expect(
      items
        .map((item) => item.str)
        .join('')
        .replace(/\s/gu, '')
    ).toBe(translation)
    expect(items.every((item) => item.transform[3] >= 8)).toBe(true)
  } finally {
    await task?.destroy()
    caller.release()
  }
})

it.each([1, 2])('preserves raised scientific digits across %s fragments', async (count) => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica),
    caller = lease()
  const page = pdf.addPage([600, 800])
  page.drawText('Value x', { font, size: 12, x: 40, y: 700 })
  page.drawText('2', { font, size: 8, x: 40 + font.widthOfTextAtSize('Value x', 12), y: 708 })
  if (count === 2) pdf.addPage([600, 800]).drawText('Tail.', { font, size: 12, x: 40, y: 700 })
  let task: ReturnType<typeof getDocument> | undefined
  try {
    const data = await new PdfTranslationWriter(entry).generate(
      {
        id: 'raised-' + count,
        data: await pdf.save(),
        pages: pdf.getPages().map(() => ({ width: 600, height: 800 })),
        units: [
          {
            source: 'Value x2' + (count === 2 ? ' Tail.' : ''),
            translation: '数值x2。' + (count === 2 ? '后续。' : ''),
            fragments: pdf.getPages().map((_, index) => ({
              pageNumber: index + 1,
              rect: { x: 40 / 600, y: 70 / 800, width: 200 / 600, height: 60 / 800 }
            }))
          }
        ]
      },
      caller.lease
    )
    task = getDocument({ data: data! })
    const items = (await (await (await task.promise).getPage(1)).getTextContent()).items.filter(
      (item) => 'str' in item
    )
    const identifier = items.find((item) => item.str.endsWith('x'))!,
      exponent = items.find((item) => item.str === '2')!
    expect(identifier).toBeDefined()
    expect(exponent).toBeDefined()
    expect(exponent.transform[5] - identifier.transform[5]).toBeCloseTo(8, 1)
  } finally {
    await task?.destroy()
    caller.release()
  }
})

it.each([
  { sourcePrefix: 'Figure', targetPrefix: '图', columns: true },
  { sourcePrefix: 'Fig.', targetPrefix: '圖', columns: false },
  { sourcePrefix: 'Table', targetPrefix: '表', columns: true },
  { sourcePrefix: 'Value', targetPrefix: '值', columns: true }
])(
  'keeps a typed reference prefix with its native panel in the owning region: $sourcePrefix',
  async ({ sourcePrefix, targetPrefix, columns }) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.TimesRoman),
      first = pdf.addPage([600, 800]),
      second = columns ? first : pdf.addPage([600, 800]),
      caller = lease(),
      x = columns ? 320 : 40,
      panelX = x + font.widthOfTextAtSize(sourcePrefix + ' ', 12),
      panelWidth = font.widthOfTextAtSize('2(a)', 12),
      translation = `测量结果说明。${targetPrefix} 2(a) 展示结果。`
    first.drawText('A measured outcome', { font, size: 12, x: 40, y: 700 })
    second.drawText(sourcePrefix + ' ', { font, size: 12, x, y: 700 })
    second.drawText('2(a)', { font, size: 12, x: panelX, y: 700 })
    second.drawText(' displays the next result.', {
      font,
      size: 12,
      x: panelX + panelWidth,
      y: 700
    })
    second.node.set(
      PDFName.of('Annots'),
      pdf.context.obj([
        pdf.context.register(
          pdf.context.obj({
            Type: 'Annot',
            Subtype: 'Link',
            Rect: [panelX - 0.1, 697, panelX + panelWidth + 0.1, 709],
            Border: [0, 0, 0],
            A: { S: 'URI', URI: PDFString.of('https://example.org/panel-2a') }
          })
        )
      ])
    )
    let task: ReturnType<typeof getDocument> | undefined
    try {
      const output = await new PdfTranslationWriter(entry).generate(
        {
          id: 'typed-reference-region',
          data: await pdf.save(),
          pages: pdf.getPages().map(() => ({ width: 600, height: 800 })),
          preserveUnsupported: true,
          units: [
            {
              source: `A measured outcome ${sourcePrefix} 2(a) displays the next result.`,
              translation,
              fragments: [
                {
                  pageNumber: 1,
                  rect: { x: 40 / 600, y: 80 / 800, width: 160 / 600, height: 40 / 800 }
                },
                {
                  pageNumber: columns ? 1 : 2,
                  rect: { x: x / 600, y: 80 / 800, width: 240 / 600, height: 40 / 800 }
                }
              ]
            }
          ]
        },
        caller.lease
      )
      task = getDocument({ data: output!, useSystemFonts: true })
      const document = await task.promise
      let written = ''
      const located = [] as Array<{ text: string; page: number; transform: number[] }>
      for (let number = 1; number <= document.numPages; number++) {
        const page = await document.getPage(number),
          items = (await page.getTextContent()).items.filter((item) => 'str' in item)
        written += items.map((item) => item.str).join('')
        located.push(
          ...items.map((item) => ({ text: item.str, page: number, transform: item.transform }))
        )
        if (number === (columns ? 1 : 2))
          expect((await page.getAnnotations()).map((annotation) => annotation.url)).toEqual([
            'https://example.org/panel-2a'
          ])
      }
      expect(written.replace(/\s/gu, '')).toBe(translation.replace(/\s/gu, ''))
      const prefix = located.find((item) => item.text.includes(targetPrefix))!,
        panel = located.find((item) => item.text === '2(a)')!
      expect(panel.page).toBe(columns ? 1 : 2)
      expect(panel.transform[4]).toBeGreaterThanOrEqual(x)
      expect(panel.transform[3]).toBe(12)
      if (sourcePrefix === 'Value') {
        // A bare measurement has no typed reference identity. Its prose prefix
        // can use the preceding region without changing the native panel owner.
        expect(prefix.transform[4]).toBeLessThan(x)
      } else {
        expect(prefix.page).toBe(panel.page)
        expect(prefix.transform[4]).toBeGreaterThanOrEqual(x)
        expect(prefix.transform[5]).toBeCloseTo(panel.transform[5], 2)
      }
    } finally {
      await task?.destroy()
      caller.release()
    }
  }
)

it.each(['columns', 'pages', 'reordered-pages'] as const)(
  'reflows a linked paragraph across %s without duplicating text or moving links to another region',
  async (layout) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.TimesRoman),
      first = pdf.addPage([600, 800]),
      second = layout === 'columns' ? first : pdf.addPage([600, 800]),
      caller = lease()
    const fragments = [
      { pageNumber: 1, rect: { x: 40 / 600, y: 80 / 800, width: 200 / 600, height: 60 / 800 } },
      {
        pageNumber: layout === 'columns' ? 1 : 2,
        rect: {
          x: (layout === 'columns' ? 320 : 40) / 600,
          y: 80 / 800,
          width: 200 / 600,
          height: 60 / 800
        }
      }
    ]
    const links = [] as ReturnType<typeof pdf.context.register>[]
    for (const [index, page] of [first, second].entries()) {
      const x = fragments[index].rect.x * 600,
        prose = index ? 'More evidence' : 'One result',
        label = String(index + 1),
        linkX = x + font.widthOfTextAtSize(prose, 12) + 2,
        width = font.widthOfTextAtSize(label, 8)
      page.drawText(prose, { font, size: 12, x, y: 700 })
      page.drawText(label, { font, size: 8, x: linkX, y: 704 })
      links.push(
        pdf.context.register(
          pdf.context.obj({
            Type: 'Annot',
            Subtype: 'Link',
            Rect: [linkX - 0.2, 703, linkX + width + 0.2, 712],
            Border: [0, 0, 0],
            A: { S: 'URI', URI: PDFString.of('https://example.org/' + label) }
          })
        )
      )
      page.node.set(
        PDFName.of('Annots'),
        pdf.context.obj(layout === 'columns' ? links : [links[index]])
      )
    }
    const input: PdfTranslationPdfRequest = {
      id: 'cross-region-' + layout,
      data: await pdf.save(),
      pages: pdf.getPages().map(() => ({ width: 600, height: 800 })),
      preserveUnsupported: true,
      units: [
        {
          source: 'One result1 More evidence2',
          translation:
            layout === 'reordered-pages' ? '更多证据2，一个结果1。' : '一个结果1，更多证据2。',
          fragments
        }
      ]
    }
    let task: ReturnType<typeof getDocument> | undefined
    try {
      const output = await new PdfTranslationWriter(entry).generate(input, caller.lease)
      if (layout === 'reordered-pages') {
        expect(output).toEqual(input.data)
        return
      }
      task = getDocument({ data: output! })
      const document = await task.promise
      let text = ''
      for (let number = 1; number <= document.numPages; number++) {
        const page = await document.getPage(number)
        text += (await page.getTextContent()).items
          .map((item) => ('str' in item ? item.str : ''))
          .join('')
        const annotations = await page.getAnnotations()
        expect(annotations.map((link) => link.url)).toEqual(
          layout === 'columns'
            ? ['https://example.org/1', 'https://example.org/2']
            : ['https://example.org/' + number]
        )
        for (const [index, link] of annotations.entries()) {
          const region = fragments[layout === 'columns' ? index : number - 1].rect
          expect(link.rect[0]).toBeGreaterThanOrEqual(region.x * 600)
          expect(link.rect[2]).toBeLessThanOrEqual((region.x + region.width) * 600)
        }
      }
      expect(text.replace(/\s/gu, '')).toBe(input.units[0].translation)
    } finally {
      await task?.destroy()
      caller.release()
    }
  }
)

it.each(
  readPdfTranslationCases<{ name: string; marker: string }>('caption-native-footnote-symbols.jsonl')
)('preserves native caption glyphs: $name', async ({ marker }) => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.TimesRoman),
    symbol = marker === '∗' ? await pdf.embedFont(StandardFonts.Symbol) : font,
    page = pdf.addPage([600, 800]),
    parts = ['Caption ', marker, 'P < .001 and ', marker, 'P < .001.']
  let x = 40
  for (const text of parts) {
    const small = text === marker,
      face = small ? symbol : font,
      size = small ? 8 : 12
    page.drawText(text, { font: face, size, x, y: small ? 704 : 700 })
    x += face.widthOfTextAtSize(text, size)
  }
  const input = {
    id: 'caption-footnote',
    data: await pdf.save(),
    pages: [{ width: 600, height: 800 }],
    units: [
      {
        source: parts.join(''),
        translation: `说明${marker}P < .001；另一组${marker}P < .001。`,
        fragments: [
          {
            pageNumber: 1,
            rect: { x: 40 / 600, y: 80 / 800, width: 400 / 600, height: 80 / 800 }
          }
        ]
      }
    ]
  }
  const caller = lease(),
    writer = new PdfTranslationWriter(entry)
  const data = await writer.generate(input, caller.lease)
  const task = getDocument({ data: data! })
  try {
    const target = await (await task.promise).getPage(1),
      items = (await target.getTextContent()).items.filter((item) => 'str' in item)
    expect(
      items
        .map((item) => item.str)
        .join('')
        .replace(/\s/gu, '')
    ).toBe(input.units[0].translation.replace(/\s/gu, ''))
    const symbols = items.filter((item) => item.str === marker)
    expect(symbols).toHaveLength(2)
    expect(symbols.every((item) => item.transform[3] === 8)).toBe(true)
    for (const item of symbols) {
      const body = items.find((other) => other.str.startsWith('P'))!
      expect(item.transform[5]).toBeGreaterThan(body.transform[5])
    }
  } finally {
    await task.destroy()
  }
  // A retained symbol must not exempt unrelated missing glyphs from validation.
  if (marker === '∗') {
    input.units[0].translation += '🧪'
    await expect(writer.generate(input, caller.lease)).rejects.toMatchObject({
      failure: { code: 'font' }
    })
  }
})

it.each(['references', 'subscripts', 'formula', 'greek'] as const)(
  'reflows repeated inline %s without changing text, identifiers or link actions',
  async (kind) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.TimesRoman),
      page = pdf.addPage([600, 800])
    const parts =
      kind === 'references'
        ? [
            { text: 'One result', small: false },
            { text: '1', small: true },
            { text: ' and another result', small: false },
            { text: '1', small: true },
            { text: '.', small: false }
          ]
        : kind === 'greek'
          ? [
              { text: 'χ', small: false },
              { text: '2', small: true },
              { text: ' tests compare 2 groups.', small: false }
            ]
          : kind === 'formula'
            ? [
                { text: 'CO', small: false },
                { text: '2', small: true },
                { text: ' was measured in 2 samples.', small: false }
              ]
            : [
                { text: 'Baseline A', small: false },
                { text: '0', small: true },
                { text: ' then A', small: false },
                { text: '1', small: true },
                { text: '.', small: false }
              ]
    const symbolFont = kind === 'greek' ? await pdf.embedFont(StandardFonts.Symbol) : font
    let x = 40
    const annotations: ReturnType<typeof pdf.context.register>[] = []
    for (const part of parts) {
      if (kind === 'references' && part.small) x += 2
      const size = part.small ? 8 : 12,
        y = part.small ? (kind === 'references' || kind === 'greek' ? 704 : 697) : 700,
        partFont = part.text === 'χ' ? symbolFont : font,
        width = partFont.widthOfTextAtSize(part.text, size)
      page.drawText(part.text, { x, y, font: partFont, size })
      if (kind === 'references' && part.small)
        annotations.push(
          pdf.context.register(
            pdf.context.obj({
              Type: 'Annot',
              Subtype: 'Link',
              Rect: [x - 0.2, y - 1, x + width + 0.2, y + 8],
              Border: [0, 0, 0],
              A: { S: 'URI', URI: PDFString.of('https://example.org/reference/1') }
            })
          )
        )
      x += width + (kind === 'references' && part.small ? 2 : 0)
    }
    if (annotations.length) page.node.set(PDFName.of('Annots'), pdf.context.obj(annotations))
    const source = parts.map((part) => part.text).join(''),
      translation =
        kind === 'references'
          ? '一个结果1与另一个结果1。'
          : kind === 'greek'
            ? '两组采用χ2检验。'
            : kind === 'formula'
              ? '2 个样本中测量 CO2。'
              : '先A1，再A0。',
      caller = lease()
    const data = await new PdfTranslationWriter(entry).generate(
      {
        id: 'inline-' + kind,
        data: await pdf.save(),
        pages: [{ width: 600, height: 800 }],
        units: [
          {
            source,
            translation,
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 40 / 600, y: 80 / 800, width: 400 / 600, height: 60 / 800 }
              }
            ]
          }
        ]
      },
      caller.lease
    )
    expect(data).toBeTruthy()
    const task = getDocument({ data: data! })
    try {
      const document = await task.promise,
        target = await document.getPage(1),
        items = (await target.getTextContent()).items.filter((item) => 'str' in item)
      expect(
        items
          .map((item) => item.str)
          .join('')
          .replace(/\s/gu, '')
      ).toBe(translation.replace(/\s/gu, ''))
      const links = await target.getAnnotations()
      expect(links).toHaveLength(annotations.length)
      expect(links.every((link) => link.url === 'https://example.org/reference/1')).toBe(true)
      if (kind === 'formula' || kind === 'greek') {
        const subscript = items.find((item) => item.str === '2' && item.transform[3] === 8)!,
          identifier = items.find((item) => item.str.endsWith(kind === 'greek' ? 'χ' : 'CO'))!
        expect(subscript).toBeDefined()
        expect(identifier).toBeDefined()
        expect(subscript.transform[4]).toBeCloseTo(identifier.transform[4] + identifier.width, 0)
        if (kind === 'greek')
          expect(subscript.transform[5]).toBeGreaterThan(identifier.transform[5])
        else expect(subscript.transform[5]).toBeLessThan(identifier.transform[5])
      }
    } finally {
      await task.destroy()
      caller.release()
    }
  }
)

it.each(
  readPdfTranslationCases<{
    name: string
    translation: string
    valid: boolean
    nativeText?: string
    repeated?: boolean
    numericRange?: boolean
  }>('native-math-symbol-font-coverage.jsonl')
)(
  'retains publisher font for a matched inline math symbol: $name',
  async ({ translation, valid, nativeText = '∼', repeated = false, numericRange = false }) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.TimesRoman),
      symbol = await pdf.embedFont(StandardFonts.Symbol),
      page = pdf.addPage([600, 800])
    page.drawText('Value x ', { font, size: 12, x: 40, y: 700 })
    const x = 40 + font.widthOfTextAtSize('Value x ', 12)
    page.drawText(nativeText, { font: symbol, size: 12, x, y: 700 })
    let right = x + symbol.widthOfTextAtSize(nativeText, 12)
    if (repeated) {
      const middle = numericRange ? '25% and 11%' : ' y and z '
      page.drawText(middle, { font, size: 12, x: right, y: 700 })
      right += font.widthOfTextAtSize(middle, 12)
      page.drawText(nativeText, { font: symbol, size: 12, x: right, y: 700 })
      right += symbol.widthOfTextAtSize(nativeText, 12)
    }
    page.drawText(numericRange ? '34% is stable.' : ' y is stable.', {
      font,
      size: 12,
      x: right,
      y: 700
    })
    const input = {
      id: 'native-math-font',
      data: await pdf.save(),
      pages: [{ width: 600, height: 800 }],
      units: [
        {
          source: `Value x ${nativeText}${repeated ? `${numericRange ? '25% and 11%' : ' y and z '}${nativeText}` : ''}${numericRange ? '34% is stable.' : ' y is stable.'}`,
          translation,
          fragments: [
            {
              pageNumber: 1,
              rect: { x: 40 / 600, y: 80 / 800, width: 400 / 600, height: 80 / 800 }
            }
          ]
        }
      ]
    }
    const caller = lease(),
      writer = new PdfTranslationWriter(entry)
    try {
      if (!valid) {
        await expect(writer.generate(input, caller.lease)).rejects.toMatchObject({
          failure: { code: 'font' }
        })
        return
      }
      const data = await writer.generate(input, caller.lease),
        task = getDocument({ data: data! })
      try {
        const items = (await (await (await task.promise).getPage(1)).getTextContent()).items.filter(
          (item) => 'str' in item
        )
        expect(
          items
            .map((item) => item.str)
            .join('')
            .replace(/\s/gu, '')
        ).toBe(translation.replace(/\s/gu, ''))
        expect(items.filter((item) => item.str === nativeText)).toHaveLength(
          numericRange ? 1 : repeated ? 2 : 1
        )
      } finally {
        await task.destroy()
      }
    } finally {
      caller.release()
    }
  }
)

it.each(
  readPdfTranslationCases<{
    name: string
    preserve: boolean
    clipped?: boolean
    borrowed?: boolean
  }>('embedded-figure-region-preflight.jsonl')
)(
  'preflights embedded figures before changing prose: $name',
  async ({ preserve, clipped, borrowed }) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica),
      page = pdf.addPage([600, 800])
    const figure = await PDFDocument.create(),
      figurePage = figure.addPage([20, 20])
    figurePage.drawRectangle({ x: 0, y: 0, width: 20, height: clipped ? 200 : 20 })
    const [embedded] = await pdf.embedPdf(await figure.save())
    page.drawPage(embedded, { x: 80, y: 695, width: 20, height: 20 })
    if (!borrowed) page.drawText('Figure label.', { font, size: 12, x: 40, y: 700 })
    const bodyY = borrowed ? 730 : clipped ? 750 : 600
    page.drawText('Body text.', { font, size: 12, x: 40, y: bodyY })
    const input = {
      id: 'embedded-figure',
      preserveUnsupported: preserve,
      data: await pdf.save(),
      pages: [{ width: 600, height: 800 }],
      units: [
        {
          source: 'Figure label.',
          translation: '图中标签。',
          fragments: [
            {
              pageNumber: 1,
              rect: { x: 40 / 600, y: 80 / 800, width: 300 / 600, height: 60 / 800 }
            }
          ]
        },
        {
          source: 'Body text.',
          translation: '正文内容。',
          fragments: [
            {
              pageNumber: 1,
              rect: {
                x: 40 / 600,
                y: (800 - bodyY - 20) / 800,
                width: 300 / 600,
                height: (borrowed ? 60 : 35) / 800
              }
            }
          ]
        }
      ].filter((_, index) => !borrowed || index === 1)
    }
    const caller = lease(),
      writer = new PdfTranslationWriter(entry)
    try {
      if (!preserve) {
        await expect(writer.generate(input, caller.lease)).rejects.toMatchObject({
          failure: { code: 'unsupported-layout' }
        })
        return
      }
      const data = await writer.generate(input, caller.lease),
        task = getDocument({ data: data! })
      try {
        const text = (await (await (await task.promise).getPage(1)).getTextContent()).items
          .map((item) => ('str' in item ? item.str : ''))
          .join('')
        if (!borrowed) expect(text).toContain('Figure label.')
        expect(text).toContain('正文内容。')
        expect(text).not.toContain('Body text.')
      } finally {
        await task.destroy()
      }
    } finally {
      caller.release()
    }
  }
)

it.each(
  readPdfTranslationCases<{ name: string; translation: string }>(
    'scientific-count-native-reflow.jsonl'
  )
)('$name', async ({ translation }) => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica),
    page = pdf.addPage([612, 792]),
    caller = lease()
  const prefix = 'We ran 4 × 10',
    x = 40 + font.widthOfTextAtSize(prefix, 12)
  page.drawText(prefix, { font, x: 40, y: 700, size: 12 })
  page.drawText('5', { font, x, y: 705, size: 8 })
  page.drawText(' trials.', { font, x: x + font.widthOfTextAtSize('5', 8), y: 700, size: 12 })
  const data = await pdf.save(),
    original = getDocument({ data: data.slice(), useSystemFonts: true })
  let target: ReturnType<typeof getDocument> | undefined
  try {
    const { source } = await extractPdfTranslationSource({
      document: await original.promise,
      resourceRequestKey: 'scientific-count',
      signal: caller.lease.signal
    })
    expect(source.units).toHaveLength(1)
    expect(source.units[0].source).toBe('We ran 4 × 10⁵ trials.')
    const output = await new PdfTranslationWriter(entry).generate(
      {
        id: 'scientific-count',
        data,
        pages: source.pages,
        units: source.units.map((unit) => ({ ...unit, translation }))
      },
      caller.lease
    )
    target = getDocument({ data: output!, useSystemFonts: true })
    const text = await (await (await target.promise).getPage(1)).getTextContent()
    expect(
      text.items
        .filter((item) => 'str' in item)
        .map((item) => item.str)
        .join('')
        .replace(/\s/gu, '')
    ).toBe(translation.replace(/\s/gu, ''))
  } finally {
    await target?.destroy()
    await original.destroy()
    caller.release()
  }
})

it.each(
  readPdfTranslationCases<{ name: string; native: string; source: string; accepted?: boolean }>(
    'native-math-source-mismatch.jsonl'
  )
)('$name', async ({ native, source, accepted }) => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica),
    sheet = pdf.addPage([612, 792]),
    caller = lease()
  sheet.drawText(native, { font, x: 40, y: 700, size: 12 })
  const data = await pdf.save()
  try {
    const request = new PdfTranslationWriter(entry).generate(
      {
        id: 'unproven-math',
        data,
        preserveUnsupported: true,
        pages: [{ width: 612, height: 792 }],
        units: [
          {
            source,
            translation: '该数值保持不变。',
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 40 / 612, y: 72 / 792, width: 480 / 612, height: 50 / 792 }
              }
            ]
          }
        ]
      },
      caller.lease
    )
    if (!accepted) {
      await expect(request).rejects.toMatchObject({
        failure: { code: 'source-mismatch', pageNumber: 1 }
      })
    } else {
      const document = await getDocument({ data: (await request)! }).promise
      try {
        const text = (await (await document.getPage(1)).getTextContent()).items
          .map((item) => ('str' in item ? item.str : ''))
          .join('')
        expect(text.replace(/\s/gu, '')).toBe('该数值保持不变。')
      } finally {
        await document.destroy()
      }
    }
  } finally {
    caller.release()
  }
})

it.each(
  readPdfTranslationCases<{
    name: string
    headingY: number
    linkTop?: number
    linkBottom?: number
    accepted: boolean
  }>('neighbor-link-hit-area-boundaries.jsonl')
)(
  'checks actual ownership of neighboring link hit areas: $name',
  async ({ headingY, linkTop, linkBottom, accepted }) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica),
      page = pdf.addPage([600, 800]),
      url = 'https://example.org/reference'
    page.drawText('Linked heading', { font, size: 12, x: 40, y: headingY })
    page.drawText('Nearby body.', { font, size: 12, x: 40, y: 700 })
    page.node.set(
      PDFName.of('Annots'),
      pdf.context.obj([
        pdf.context.register(
          pdf.context.obj({
            Type: 'Annot',
            Subtype: 'Link',
            Rect: [40, linkBottom ?? 710, 120, linkTop ?? headingY + 12],
            A: { S: 'URI', URI: PDFString.of(url) }
          })
        )
      ])
    )
    const caller = lease(),
      writer = new PdfTranslationWriter(entry)
    try {
      const request = writer.generate(
        {
          id: 'neighbor-link',
          data: await pdf.save(),
          pages: [{ width: 600, height: 800 }],
          units: [
            {
              source: 'Nearby body.',
              translation: '相邻正文。',
              fragments: [
                {
                  pageNumber: 1,
                  rect: { x: 40 / 600, y: 80 / 800, width: 200 / 600, height: 30 / 800 }
                }
              ]
            }
          ]
        },
        caller.lease
      )
      if (!accepted) {
        await expect(request).rejects.toMatchObject({ failure: { code: 'annotations' } })
        return
      }
      const task = getDocument({ data: (await request)! })
      try {
        const result = await (await task.promise).getPage(1),
          text = (await result.getTextContent()).items
            .map((item) => ('str' in item ? item.str : ''))
            .join(''),
          annotations = await result.getAnnotations()
        expect(text).toContain('相邻正文。')
        expect(text).toContain('Linked heading')
        expect(text).not.toContain('Nearby body.')
        expect(annotations).toHaveLength(1)
        expect(annotations[0].url).toBe(url)
        expect(annotations[0].rect).toEqual([40, linkBottom ?? 710, 120, linkTop ?? headingY + 12])
      } finally {
        await task.destroy()
      }
    } finally {
      caller.release()
    }
  }
)

it.each(
  readPdfTranslationCases<{
    name: string
    target: string
    rule: boolean
    ruleFirst?: boolean
    priorLink?: boolean
    numerator?: string
    denominator?: string
    denominatorShift?: number
    spacedIndex?: boolean
    accepted: boolean
  }>('native-fraction-prose-reflow.jsonl')
)(
  'retains native fraction glyphs while translating prose: $name',
  async ({
    target,
    rule,
    ruleFirst,
    priorLink,
    numerator = '32',
    denominator = '8',
    denominatorShift = 0,
    spacedIndex,
    accepted
  }) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica),
      page = pdf.addPage([600, 800]),
      caller = lease(),
      width = font.widthOfTextAtSize(numerator, 8),
      fractionX = priorLink ? 100 : 80
    const drawRule = (): void => {
      page.drawLine({
        start: { x: fractionX, y: 702 },
        end: { x: fractionX + width, y: 702 },
        thickness: 0.4
      })
    }
    if (rule && ruleFirst) drawRule()
    page.drawText('Ratio ', { font, x: 40, y: 700, size: 12 })
    if (priorLink) {
      page.drawText('1', { font, x: 74, y: 700, size: 12 })
      page.node.set(
        PDFName.of('Annots'),
        pdf.context.obj([
          pdf.context.register(
            pdf.context.obj({
              Type: 'Annot',
              Subtype: 'Link',
              Rect: [73, 699, 82, 713],
              A: { S: 'URI', URI: PDFString.of('https://example.org/reference/1') }
            })
          )
        ])
      )
    }
    page.drawText(numerator, { font, x: fractionX, y: 705, size: 8 })
    page.drawText(denominator, {
      font,
      x: fractionX + (width - font.widthOfTextAtSize(denominator, 8)) / 2 + denominatorShift,
      y: 695,
      size: 8
    })
    if (rule && !ruleFirst) drawRule()
    page.drawText(' samples.', { font, x: fractionX + width + 3, y: 700, size: 12 })
    if (spacedIndex) {
      page.drawText('d', { font, x: 40, y: 680, size: 12 })
      page.drawText('q q', { font, x: 47, y: 678, size: 8 })
    }
    try {
      const request = new PdfTranslationWriter(entry).generate(
        {
          id: 'native-fraction',
          data: await pdf.save(),
          pages: [{ width: 600, height: 800 }],
          units: [
            {
              source: `Ratio ${priorLink ? '1 ' : ''}${numerator}/${denominator} samples.${spacedIndex ? ' dq q' : ''}`,
              translation: target,
              fragments: [
                {
                  pageNumber: 1,
                  rect: { x: 35 / 600, y: 75 / 800, width: 250 / 600, height: 50 / 800 }
                }
              ]
            }
          ]
        },
        caller.lease
      )
      if (!accepted) {
        await expect(request).rejects.toMatchObject({ failure: { code: 'annotations' } })
        return
      }
      const task = getDocument({ data: (await request)! })
      try {
        const outputPage = await (await task.promise).getPage(1)
        if (priorLink) {
          const annotations = await outputPage.getAnnotations()
          expect(annotations).toHaveLength(1)
          expect(annotations[0].url).toBe('https://example.org/reference/1')
        }
        const items = (await outputPage.getTextContent()).items.filter(
          (item): item is import('pdfjs-dist/types/src/display/api').TextItem => 'str' in item
        )
        expect(items.map((item) => item.str).join('')).toContain('样本')
        expect(items.map((item) => item.str).join('')).not.toContain('Ratio')
        if (spacedIndex) {
          expect(
            items
              .map((item) => item.str)
              .join('')
              .replace(/\s/gu, '')
          ).toContain('dqq')
          const index = items.find((item) => item.str.replace(/\s/gu, '') === 'qq')!
          expect(index.height).toBeCloseTo(8, 2)
        }
        const top = items.find((item) => item.str === numerator)!,
          bottom = items.find((item) => item.str === denominator)!
        expect(top.height).toBeCloseTo(8, 2)
        expect(bottom.height).toBeCloseTo(8, 2)
        expect(top.transform[5] - bottom.transform[5]).toBeCloseTo(10, 2)
      } finally {
        await task.destroy()
      }
    } finally {
      caller.release()
    }
  }
)

it.each(
  readPdfTranslationCases<{
    name: string
    neighborY: number
    accepted: boolean
    neighborBottom?: number
    neighborText?: string
    neighborSize?: number
    tallPrefix?: boolean
  }>('partial-neighbor-text-edge-trim.jsonl')
)(
  '$name',
  async ({
    neighborY,
    accepted,
    neighborBottom,
    neighborText = 'UPPER',
    neighborSize = 12,
    tallPrefix
  }) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica),
      page = pdf.addPage([600, 800]),
      caller = lease()
    if (tallPrefix) page.drawText('(', { font, x: 40, y: 700, size: 14 })
    page.drawText('Body text.', { font, x: tallPrefix ? 55 : 40, y: 700, size: 12 })
    page.drawText(neighborText, { font, x: 90, y: neighborY, size: neighborSize })
    try {
      const request = new PdfTranslationWriter(entry).generate(
        {
          id: 'partial-neighbor',
          data: await pdf.save(),
          pages: [{ width: 600, height: 800 }],
          units: [
            {
              source: tallPrefix ? '(Body text.' : 'Body text.',
              translation: '正文。',
              fragments: [
                {
                  pageNumber: 1,
                  rect: { x: 35 / 600, y: 87 / 800, width: 110 / 600, height: 23 / 800 }
                }
              ]
            },
            ...(neighborBottom === undefined
              ? []
              : [
                  {
                    source: 'UPPER',
                    translation: 'UPPER',
                    fragments: [
                      {
                        pageNumber: 1,
                        rect: {
                          x: 85 / 600,
                          y: (800 - neighborY - 12) / 800,
                          width: 60 / 600,
                          height: (neighborY + 12 - neighborBottom) / 800
                        }
                      }
                    ]
                  }
                ])
          ]
        },
        caller.lease
      )
      if (!accepted) {
        await expect(request).rejects.toMatchObject({ failure: { code: 'unsupported-layout' } })
        return
      }
      const document = await getDocument({ data: (await request)! }).promise
      try {
        const items = (await (await document.getPage(1)).getTextContent()).items.filter(
          (item): item is import('pdfjs-dist/types/src/display/api').TextItem => 'str' in item
        )
        expect(items.map((item) => item.str).join('')).toContain('正文。')
        const neighbor = items.find((item) => item.str === neighborText)!
        expect(neighbor.transform[4]).toBeCloseTo(90, 3)
        expect(neighbor.transform[5]).toBeCloseTo(neighborY, 3)
        expect(items.map((item) => item.str).join('')).not.toContain('Body text.')
      } finally {
        await document.destroy()
      }
    } finally {
      caller.release()
    }
  }
)

it.each(
  readPdfTranslationCases<{
    name: string
    generated: boolean
    bottom: number
    rejected: boolean
    wrap?: boolean
  }>('native-link-hitbox-versus-glyph-ink.jsonl')
)(
  'fits link glyph ink independently of its unchanged hitbox: $name',
  async ({ generated, bottom, rejected, wrap }) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica),
      sheet = pdf.addPage([612, 792]),
      caller = lease(),
      source = 'Cell growth Table 1 improves.',
      prefix = 'Cell growth Table ',
      x = 40 + font.widthOfTextAtSize(prefix, 10),
      width = font.widthOfTextAtSize('1', 10),
      translation = wrap
        ? '细胞'.repeat(5) + '（表1）' + '培养'.repeat(12) + '。'
        : '细胞生长（表1）得到改善。'
    if (generated) sheet.drawText(source, { font, x: 40, y: 700, size: 10 })
    else {
      sheet.drawText(prefix, { font, x: 40, y: 700, size: 10 })
      sheet.drawText('1', { font, x, y: 700, size: 10 })
      sheet.drawText(' improves.', { font, x: x + width, y: 700, size: 10 })
    }
    sheet.node.set(
      PDFName.of('Annots'),
      pdf.context.obj([
        pdf.context.register(
          pdf.context.obj({
            Type: 'Annot',
            Subtype: 'Link',
            Rect: [x - 0.5, bottom, x + width + 0.5, 708.9],
            Border: [0, 0, 0],
            A: { S: 'URI', URI: PDFString.of('https://example.org/reference/1') }
          })
        )
      ])
    )
    const data = await pdf.save(),
      original = getDocument({ data: data.slice(), useSystemFonts: true })
    let target: ReturnType<typeof getDocument> | undefined
    try {
      const result = new PdfTranslationWriter(entry).generate(
        {
          id: 'padded-link-glyph',
          data,
          pages: [{ width: 612, height: 792 }],
          units: [
            {
              source,
              translation,
              fragments: [
                {
                  pageNumber: 1,
                  rect: {
                    x: 40 / 612,
                    y: (792 - 708.5) / 792,
                    width: (wrap ? 150 : 260) / 612,
                    height: (wrap ? 55 : 11) / 792
                  }
                }
              ]
            }
          ]
        },
        caller.lease
      )
      if (rejected) {
        await expect(result).rejects.toMatchObject({
          failure: { code: 'annotations', pageNumber: 1 }
        })
        return
      }
      target = getDocument({ data: (await result)!, useSystemFonts: true })
      const before = await (await original.promise).getPage(1),
        after = await (await target.promise).getPage(1),
        oldLink = (await before.getAnnotations())[0],
        newLink = (await after.getAnnotations())[0]
      expect(
        (await after.getTextContent()).items
          .filter((i) => 'str' in i)
          .map((i) => i.str)
          .join('')
          .replace(/\s/gu, '')
      ).toBe(translation)
      expect(newLink.url).toBe(oldLink.url)
      expect(newLink.rect[2] - newLink.rect[0]).toBeCloseTo(oldLink.rect[2] - oldLink.rect[0], 3)
      expect(newLink.rect[3] - newLink.rect[1]).toBeCloseTo(oldLink.rect[3] - oldLink.rect[1], 3)
      // Publisher hit padding may already extend below the text owner.
      // Reflow must stay inside that original envelope, without enlarging it.
      expect(newLink.rect[1]).toBeGreaterThanOrEqual(
        Math.min(oldLink.rect[1], 708.5 - (wrap ? 55 : 11) - 2) - 0.001
      )
      expect(newLink.rect[3]).toBeLessThanOrEqual(708.5 + 2)
    } finally {
      await target?.destroy()
      await original.destroy()
      caller.release()
    }
  }
)

it.each(
  readPdfTranslationCases<{ name: string; translations: string[] }>(
    'shared-glyph-distinct-unicode.jsonl'
  )
)('keeps separate Unicode identities for shared outlines: $name', async ({ translations }) => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica),
    page = pdf.addPage([612, 792])
  const units = translations.map((translation, index) => {
    const source = `Ordinary source paragraph ${index + 1}.`,
      y = 700 - index * 100
    page.drawText(source, { font, x: 40, y, size: 12 })
    return {
      source,
      translation,
      fragments: [
        {
          pageNumber: 1,
          rect: { x: 40 / 612, y: (792 - y - 20) / 792, width: 500 / 612, height: 60 / 792 }
        }
      ]
    }
  })
  const registry = new ApplicationCallerLeaseRegistry(),
    caller = registry.acquire({ leaseId: 'unicode-aliases', surface: 'electron' }),
    writer = new PdfTranslationWriter(() => resolve('resources/pdf-translation/worker.mjs'))
  let task: ReturnType<typeof getDocument> | undefined
  try {
    const output = await writer.generate(
      {
        id: 'unicode-aliases',
        data: await pdf.save(),
        pages: [{ width: 612, height: 792 }],
        units
      },
      caller.lease
    )
    task = getDocument({ data: output! })
    const content = await (await (await task.promise).getPage(1)).getTextContent(),
      text = content.items
        .flatMap((item) => ('str' in item ? [item.str] : []))
        .join('')
        .replace(/\s/gu, '')
    expect(text).toBe(translations.join('').replace(/\s/gu, ''))
    expect(text).toContain('•')
    expect(text).toContain('·')
  } finally {
    await task?.destroy()
    caller.release()
    registry.dispose()
  }
})

it.each(
  readPdfTranslationCases<{ name: string; separator: string }>(
    'native-citation-separator-wrap.jsonl'
  )
)('$name', async ({ separator }) => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica),
    page = pdf.addPage([612, 792]),
    caller = lease(),
    annotations = []
  page.drawText('References ', { font, x: 40, y: 700, size: 12 })
  for (let i = 0; i < 5; i++) {
    const x = 40 + (i % 3) * 25,
      y = 680 - Math.floor(i / 3) * 18,
      label = `[${i + 1}]`
    page.drawText(label, { font, x, y, size: 12 })
    page.drawText(i === 4 ? '.' : ';', {
      font,
      x: x + font.widthOfTextAtSize(label, 12) + 1,
      y,
      size: 12
    })
    annotations.push(
      pdf.context.register(
        pdf.context.obj({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: [x, y - 2, x + font.widthOfTextAtSize(label, 12), y + 10],
          Border: [0, 0, 0],
          A: { S: 'URI', URI: PDFString.of(`https://example.org/citation/${i + 1}`) }
        })
      )
    )
  }
  page.node.set(PDFName.of('Annots'), pdf.context.obj(annotations))
  const translation =
      '引用（' + Array.from({ length: 5 }, (_, i) => `[${i + 1}]`).join(separator) + '）。',
    data = await pdf.save()
  let target: ReturnType<typeof getDocument> | undefined
  try {
    const bytes = await new PdfTranslationWriter(entry).generate(
      {
        id: 'citation-separator-wrap',
        data,
        pages: [{ width: 612, height: 792 }],
        units: [
          {
            source: 'References [1];[2];[3];[4];[5].',
            translation,
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 40 / 612, y: 80 / 792, width: 85 / 612, height: 100 / 792 }
              }
            ]
          }
        ]
      },
      caller.lease
    )
    target = getDocument({ data: bytes!, useSystemFonts: true })
    const result = await target.promise,
      p = await result.getPage(1),
      content = await p.getTextContent(),
      links = await p.getAnnotations()
    expect(
      content.items
        .flatMap((x) => ('str' in x ? [x.str] : []))
        .join('')
        .replace(/\s/gu, '')
    ).toBe(translation)
    expect(links).toHaveLength(5)
    expect(links.map((x) => x.url)).toEqual(
      Array.from({ length: 5 }, (_, i) => `https://example.org/citation/${i + 1}`)
    )
    expect(new Set(links.map((x) => Math.round(x.rect[1]))).size).toBeGreaterThan(1)
  } finally {
    await target?.destroy()
    caller.release()
  }
})

it.each(
  readPdfTranslationCases<{ name: string; translation: string; rise: number; valid: boolean }>(
    'native-raised-footnote-spelling.jsonl'
  )
)(
  'preserves source-proven raised footnote spelling: $name',
  async ({ translation, rise, valid }) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.TimesRoman),
      page = pdf.addPage([600, 800])
    page.drawText('1', { font, size: 7, x: 40, y: 700 + rise })
    page.drawText('See the supplementary note.', { font, size: 12, x: 44, y: 700 })
    const caller = lease(),
      writer = new PdfTranslationWriter(entry)
    const request = {
      id: 'raised-footnote',
      data: await pdf.save(),
      pages: [{ width: 600, height: 800 }],
      units: [
        {
          source: '1See the supplementary note.',
          translation,
          fragments: [
            {
              pageNumber: 1,
              rect: { x: 40 / 600, y: 80 / 800, width: 350 / 600, height: 50 / 800 }
            }
          ]
        }
      ]
    }
    try {
      if (!valid) {
        await expect(writer.generate(request, caller.lease)).rejects.toMatchObject({
          failure: { code: 'annotations' }
        })
        return
      }
      const data = await writer.generate(request, caller.lease)
      const task = getDocument({ data: data! })
      try {
        const output = await (await task.promise).getPage(1)
        const items = (await output.getTextContent()).items.filter((item) => 'str' in item)
        expect(
          items
            .map((item) => item.str)
            .join('')
            .replace(/\s/gu, '')
            .normalize('NFKC')
        ).toBe(translation.normalize('NFKC'))
        const marker = items.find((item) => item.str === '1')!
        const prose = items.find((item) => item.str.includes('参见'))!
        expect(marker.transform[3]).toBe(7)
        expect(marker.transform[5]).toBeGreaterThan(prose.transform[5])
      } finally {
        await task.destroy()
      }
    } finally {
      caller.release()
    }
  }
)

it.each(
  readPdfTranslationCases<{
    name: string
    rotation: number
    figureTop: number
    figureX?: number
    translated: boolean
  }>('embedded-figure-adjacent-region.jsonl')
)('$name', async ({ rotation, figureTop, figureX = 120, translated }) => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica),
    page = pdf.addPage([600, 800]),
    figure = await PDFDocument.create()
  figure.addPage([20, 20]).drawRectangle({ x: 0, y: 0, width: 20, height: 20 })
  const [embedded] = await pdf.embedPdf(await figure.save())
  page.drawPage(embedded, { x: figureX, y: figureTop - 20, width: 20, height: 20 })
  page.drawText('Figure label.', { font, size: 12, x: 40, y: 700 })
  page.setRotation(degrees(rotation))
  const width = rotation % 180 ? 800 : 600,
    height = rotation % 180 ? 600 : 800,
    rect =
      rotation === 90
        ? { x: 695 / 800, y: 40 / 600, width: 21 / 800, height: 300 / 600 }
        : rotation === 180
          ? { x: 260 / 600, y: 695 / 800, width: 300 / 600, height: 21 / 800 }
          : rotation === 270
            ? { x: 84 / 800, y: 260 / 600, width: 21 / 800, height: 300 / 600 }
            : { x: 40 / 600, y: 84 / 800, width: 300 / 600, height: 21 / 800 },
    caller = lease()
  let task: ReturnType<typeof getDocument> | undefined
  try {
    const output = await new PdfTranslationWriter(entry).generate(
      {
        id: 'adjacent-figure',
        preserveUnsupported: true,
        data: await pdf.save(),
        pages: [{ width, height }],
        units: [
          {
            source: 'Figure label.',
            translation: '图中标签。',
            fragments: [{ pageNumber: 1, rect }]
          }
        ]
      },
      caller.lease
    )
    task = getDocument({ data: output!, useSystemFonts: true })
    const target = await (await task.promise).getPage(1),
      text = (await target.getTextContent()).items
        .map((item) => ('str' in item ? item.str : ''))
        .join('')
    expect(text).toContain(translated ? '图中标签。' : 'Figure label.')
    const viewport = target.getViewport({ scale: 1 }),
      canvas = createCanvas(viewport.width, viewport.height),
      context = canvas.getContext('2d')
    await target.render({
      canvas: null,
      canvasContext: context as unknown as CanvasRenderingContext2D,
      viewport
    }).promise
    const [x, y] = viewport.convertToViewportPoint(figureX + 10, figureTop - 10)
    expect([...context.getImageData(Math.floor(x), Math.floor(y), 1, 1).data]).toEqual([
      0, 0, 0, 255
    ])
  } finally {
    await task?.destroy()
    caller.release()
  }
})

it.each(
  readPdfTranslationCases<{
    name: string
    point: number
    leading: number
    height: number
    translation: string
  }>('native-cjk-line-ink-spacing.jsonl')
)(
  'fits actual CJK ink within separate admitted rows: $name',
  async ({ point, leading, height, translation }) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.TimesRoman),
      symbol = await pdf.embedFont(StandardFonts.Symbol),
      page = pdf.addPage([612, 792])
    const lines = Array.from(
      { length: 7 },
      (_, i) =>
        `Synthetic record ${i + 1} describes a separate test line with generic measurements.`
    )
    for (const [i, line] of lines.entries()) {
      page.drawText(line, { font, size: point, x: 108, y: 460 - i * leading })
      if (i !== 4) continue
      const x = 108 + font.widthOfTextAtSize(lines[4], point)
      page.drawText('C ', { font, size: point, x, y: 460 - 4 * leading })
      page.drawText('∼', {
        font: symbol,
        size: point,
        x: x + font.widthOfTextAtSize('C ', point),
        y: 460 - 4 * leading
      })
      page.drawText(' N(0, 1)', {
        font,
        size: point,
        x: x + font.widthOfTextAtSize('C ', point) + symbol.widthOfTextAtSize('∼', point),
        y: 460 - 4 * leading
      })
    }
    lines[4] += 'C ∼ N(0, 1)'
    const caller = lease()
    try {
      const data = await new PdfTranslationWriter(entry).generate(
        {
          id: 'cjk-native-row-spacing',
          data: await pdf.save(),
          pages: [{ width: 612, height: 792 }],
          preserveUnsupported: true,
          units: [
            {
              source: lines.join(' '),
              translation,
              fragments: [
                {
                  pageNumber: 1,
                  rect: {
                    x: 108 / 612,
                    y: (792 - 467.654) / 792,
                    width: 396 / 612,
                    height: height / 792
                  }
                }
              ]
            }
          ]
        },
        caller.lease
      )
      const task = getDocument({ data: data! })
      try {
        const text = (await (await (await task.promise).getPage(1)).getTextContent()).items
          .map((item) => ('str' in item ? item.str : ''))
          .join('')
          .replace(/\s/gu, '')
        expect(text).toBe(translation.replace(/\s/gu, ''))
        expect(text).not.toContain('Synthetic')
      } finally {
        await task.destroy()
      }
    } finally {
      caller.release()
    }
  }
)

it.each(
  readPdfTranslationCases<{ name: string; top: number; translated: boolean }>(
    'footnote-link-baseline-fit.jsonl'
  )
)('$name', async ({ top, translated }) => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.TimesRoman),
    page = pdf.addPage([600, 800]),
    prefix = 'Work at Lab. Code at ',
    url = 'example.org/code',
    baseline = 62.138,
    source = '*' + prefix + url,
    translation = '*该工作完成于实验室期间。代码可从 ' + url + ' 获取'
  page.drawText('*', { font, size: 6, x: 40, y: 65.947 })
  page.drawText(prefix + url, { font, size: 9, x: 44, y: baseline })
  const linkX = 44 + font.widthOfTextAtSize(prefix, 9),
    uri = 'https://' + url
  page.node.set(
    PDFName.of('Annots'),
    pdf.context.obj([
      pdf.context.register(
        pdf.context.obj({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: [linkX, 58.153, linkX + font.widthOfTextAtSize(url, 9) + 2, 69.76],
          Border: [0, 0, 0],
          A: { S: 'URI', URI: PDFString.of(uri) }
        })
      )
    ])
  )
  const caller = lease()
  let task: ReturnType<typeof getDocument> | undefined
  try {
    const output = await new PdfTranslationWriter(entry).generate(
      {
        id: 'footnote-baseline',
        data: await pdf.save(),
        preserveUnsupported: true,
        pages: [{ width: 600, height: 800 }],
        units: [
          {
            source,
            translation,
            fragments: [
              {
                pageNumber: 1,
                rect: {
                  x: 40 / 600,
                  y: (800 - top) / 800,
                  width: 400 / 600,
                  height: (top - 60.1) / 800
                }
              }
            ]
          }
        ]
      },
      caller.lease
    )
    task = getDocument({ data: output!, useSystemFonts: true })
    const target = await (await task.promise).getPage(1),
      items = (await target.getTextContent()).items,
      text = items
        .map((item) => ('str' in item ? item.str : ''))
        .join('')
        .replace(/\s/gu, '')
    expect(text).toBe((translated ? translation : source).replace(/\s/gu, ''))
    expect(await target.getAnnotations()).toEqual([expect.objectContaining({ url: uri })])
    if (translated) {
      const body = items.find((item) => 'str' in item && item.str.includes('该工作'))
      expect(body && 'transform' in body && body.transform[5]).toBeGreaterThan(baseline)
    }
  } finally {
    await task?.destroy()
    caller.release()
  }
})

it.each(
  readPdfTranslationCases<{ name: string; neighbor: boolean; translated: boolean }>(
    'oversized-link-hit-area.jsonl'
  )
)('$name', async ({ neighbor, translated }) => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.TimesRoman),
    page = pdf.addPage([600, 800]),
    prefix = 'The method described by ',
    label = 'Parker et al.',
    suffix = ' [2018] is used.',
    source = prefix + label + suffix,
    translation = '遵循 Parker 等人 [2018] 的方法。',
    linkX = 40 + font.widthOfTextAtSize(prefix, 10),
    originalRect = [linkX, 694, linkX + font.widthOfTextAtSize(label, 10), 714],
    uri = 'https://example.org/reference/2018'
  page.drawText(source, { font, size: 10, x: 40, y: 700 })
  if (neighbor) page.drawText('Neighbor', { font, size: 10, x: 65, y: 712 })
  page.node.set(
    PDFName.of('Annots'),
    pdf.context.obj([
      pdf.context.register(
        pdf.context.obj({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: originalRect,
          Border: [0, 0, 0],
          A: { S: 'URI', URI: PDFString.of(uri) }
        })
      )
    ])
  )
  const caller = lease()
  let task: ReturnType<typeof getDocument> | undefined
  try {
    const output = await new PdfTranslationWriter(entry).generate(
      {
        id: 'oversized-hit-area',
        data: await pdf.save(),
        preserveUnsupported: true,
        pages: [{ width: 600, height: 800 }],
        units: [
          {
            source,
            translation,
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 40 / 600, y: 90 / 800, width: 380 / 600, height: 12.5 / 800 }
              }
            ]
          }
        ]
      },
      caller.lease
    )
    task = getDocument({ data: output!, useSystemFonts: true })
    const target = await (await task.promise).getPage(1),
      text = (await target.getTextContent()).items
        .map((i) => ('str' in i ? i.str : ''))
        .join('')
        .replace(/\s/gu, ''),
      [link] = await target.getAnnotations()
    expect(text).toContain((translated ? translation : source).replace(/\s/gu, ''))
    expect(link.url).toBe(uri)
    expect(link.rect[2] - link.rect[0]).toBeCloseTo(originalRect[2] - originalRect[0], 3)
    expect(link.rect[3] - link.rect[1]).toBeCloseTo(20, 3)
    if (translated) {
      expect(link.rect[0]).not.toBeCloseTo(originalRect[0], 1)
      expect(link.rect[1]).toBeGreaterThanOrEqual(694 - 0.001)
      expect(link.rect[3]).toBeLessThanOrEqual(714 + 0.001)
    } else {
      expect(text).toContain('Neighbor')
      for (const [index, value] of originalRect.entries())
        expect(link.rect[index]).toBeCloseTo(value, 4)
    }
  } finally {
    await task?.destroy()
    caller.release()
  }
})

it.each(
  readPdfTranslationCases<{
    name: string
    change: string
    translated?: boolean
    rejected?: boolean
  }>('verified-ink-versus-region-margins.jsonl')
)('$name', async ({ change, translated, rejected }) => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.TimesRoman),
    page = pdf.addPage([600, 800]),
    rotated = change === 'rotated',
    partial = change === 'partial',
    first = 'First glyph.',
    neighbor = partial ? 'Xm' : 'Neighbor.'
  page.drawText(first, {
    font,
    size: 12,
    x: rotated ? 60 : 40,
    y: rotated ? 650 : 700,
    ...(['italic', 'excessive-shear'].includes(change)
      ? { ySkew: degrees(change === 'italic' ? 12 : 25) }
      : {}),
    ...(rotated ? { rotate: degrees(90) } : {})
  })
  page.drawText(neighbor, {
    font,
    size: 12,
    x: rotated ? 74 : 40,
    y: rotated ? 650 : change === 'ink' ? 696 : 686,
    ...(rotated ? { rotate: degrees(90) } : {})
  })
  if (change === 'multi-fragment') page.drawText('Again.', { font, size: 12, x: 40, y: 650 })
  const x = partial ? 40 + font.widthOfTextAtSize('X', 12) : 40,
    request = {
      id: 'ink-margin',
      data: await pdf.save(),
      pages: [{ width: 600, height: 800 }],
      preserveUnsupported: true,
      units: [
        {
          source: first,
          translation: '第一条说明。',
          fragments: [
            {
              pageNumber: 1,
              rect: rotated
                ? { x: 50 / 600, y: 60 / 800, width: 18 / 600, height: 100 / 800 }
                : { x: 40 / 600, y: 90 / 800, width: 150 / 600, height: 14 / 800 }
            }
          ]
        },
        {
          source: partial ? 'm' : change === 'multi-fragment' ? `${neighbor} Again.` : neighbor,
          translation: partial
            ? 'm'
            : change === 'multi-fragment'
              ? `${neighbor} Again.`
              : neighbor,
          fragments: [
            {
              pageNumber: 1,
              rect: rotated
                ? { x: 61 / 600, y: 60 / 800, width: 24 / 600, height: 100 / 800 }
                : {
                    x: x / 600,
                    y: (change === 'ink' ? 90 : change === 'multi-fragment' ? 103 : 102) / 800,
                    width: 120 / 600,
                    height: (change === 'ink' ? 24 : 16) / 800
                  }
            },
            ...(change === 'multi-fragment'
              ? [
                  {
                    pageNumber: 1,
                    rect: { x: 40 / 600, y: 140 / 800, width: 120 / 600, height: 16 / 800 }
                  }
                ]
              : [])
          ]
        }
      ]
    },
    caller = lease(),
    writer = new PdfTranslationWriter(entry)
  try {
    if (rejected) {
      await expect(writer.generate(request, caller.lease)).rejects.toBeDefined()
      return
    }
    const data = await writer.generate(request, caller.lease),
      task = getDocument({ data: data! })
    try {
      const items = (await (await (await task.promise).getPage(1)).getTextContent()).items
      const text = items
        .map((item) => ('str' in item ? item.str : ''))
        .join('')
        .replace(/\s/gu, '')
      expect(text.includes('第一条说明。')).toBe(translated)
      expect(text.includes('Firstglyph.')).toBe(!translated)
      expect(text).toContain(neighbor)
      if (partial) {
        const original = getDocument({ data: request.data })
        try {
          const before = await (await (await original.promise).getPage(1)).getTextContent()
          const geometry = (
            values: typeof items
          ): { text: string; transform: number[]; width: number; height: number }[] =>
            values
              .filter((item) => 'str' in item)
              .map((item) => ({
                text: item.str,
                transform: item.transform,
                width: item.width,
                height: item.height
              }))
          expect(geometry(items)).toEqual(geometry(before.items))
        } finally {
          await original.destroy()
        }
      }
    } finally {
      await task.destroy()
    }
  } finally {
    caller.release()
  }
})

it.each(
  readPdfTranslationCases<{ name: string; top: number; height: number; translated: boolean }>(
    'native-font-fit-floor.jsonl'
  )
)('$name', async ({ top, height, translated }) => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica),
    source = 'Trial result',
    translation = 'Testing A, Research B. 辅助放疗对',
    page = pdf.addPage([612, 792])
  page.drawText(source, { font, x: 40, y: 700, size: 9 })
  const caller = lease()
  let task: ReturnType<typeof getDocument> | undefined
  try {
    const output = await new PdfTranslationWriter(entry).generate(
      {
        id: 'native-font-fit',
        data: await pdf.save(),
        preserveUnsupported: true,
        pages: [{ width: 612, height: 792 }],
        units: [
          {
            source,
            translation,
            fragments: [
              {
                pageNumber: 1,
                rect: {
                  x: 40 / 612,
                  y: (792 - top) / 792,
                  width: 256.75 / 612,
                  height: height / 792
                }
              }
            ]
          }
        ]
      },
      caller.lease
    )
    task = getDocument({ data: output!, useSystemFonts: true })
    const target = await (await task.promise).getPage(1),
      items = (await target.getTextContent()).items.filter((i) => 'str' in i)
    expect(items.map((i) => i.str).join('')).toBe(translated ? translation : source)
    if (translated)
      for (const item of items) {
        expect(Math.hypot(item.transform[0], item.transform[1])).toBeGreaterThanOrEqual(8)
        expect(Math.hypot(item.transform[0], item.transform[1])).toBeLessThan(9)
      }
  } finally {
    await task?.destroy()
    caller.release()
  }
})

it.each(
  readPdfTranslationCases<{ name: string; pages: number[]; unchanged: number[] }>(
    'native-planning-page-reuse.jsonl'
  )
)(
  'preserves page ownership through planning snapshot lifecycle: $name',
  async ({ pages, unchanged }) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica)
    pdf.addPage([612, 792])
    pdf.addPage([612, 792])
    const units = pages.map((pageNumber, index) => {
      const source = `Sample ${index + 1}.`,
        translation = unchanged.includes(index) ? source : `样本${index + 1}。`,
        y = 700 - index * 65
      pdf.getPage(pageNumber - 1).drawText(source, { font, x: 40, y, size: 12 })
      return {
        source,
        translation,
        fragments: [
          {
            pageNumber,
            rect: { x: 40 / 612, y: (792 - y - 15) / 792, width: 220 / 612, height: 35 / 792 }
          }
        ]
      }
    })
    const registry = new ApplicationCallerLeaseRegistry(),
      caller = registry.acquire({ leaseId: 'page-reuse', surface: 'electron' })
    let task: ReturnType<typeof getDocument> | undefined
    try {
      const output = await new PdfTranslationWriter(entry).generate(
        {
          id: 'page-reuse',
          data: await pdf.save(),
          pages: [
            { width: 612, height: 792 },
            { width: 612, height: 792 }
          ],
          units
        },
        caller.lease
      )
      task = getDocument({ data: output! })
      const document = await task.promise
      for (let pageNumber = 1; pageNumber <= 2; pageNumber++) {
        const text = (await (await document.getPage(pageNumber)).getTextContent()).items
          .filter((item) => 'str' in item)
          .map((item) => item.str)
          .join('')
          .replace(/\s/gu, '')
        for (const unit of units) {
          if (unit.fragments[0].pageNumber === pageNumber)
            expect(text).toContain(unit.translation.replace(/\s/gu, ''))
          else expect(text).not.toContain(unit.translation.replace(/\s/gu, ''))
        }
      }
    } finally {
      await task?.destroy()
      caller.release()
      registry.dispose()
    }
  }
)

it.each(
  readPdfTranslationCases<{ name: string; crossPage: boolean; accepted: boolean }>(
    'generated-link-fragment-reflow.jsonl'
  )
)('$name', async ({ crossPage, accepted }) => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica),
    page = pdf.addPage([600, 800]),
    nextPage = crossPage ? pdf.addPage([600, 800]) : page,
    caller = lease()
  page.drawText('Start method.', { font, size: 12, x: 40, y: 700 })
  nextPage.drawText('See Fig. 2 next.', { font, size: 12, x: 40, y: 650 })
  const left = 40 + font.widthOfTextAtSize('See ', 12),
    right = left + font.widthOfTextAtSize('Fig. 2', 12)
  nextPage.node.set(
    PDFName.of('Annots'),
    pdf.context.obj([
      pdf.context.register(
        pdf.context.obj({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: [left, 648, right, 661],
          Border: [0, 0, 0],
          A: { S: 'URI', URI: PDFString.of('https://example.org/figure/2') }
        })
      )
    ])
  )
  const translation = '见图2，应用这个方法进行测量并且记录所有结果。'
  let task: ReturnType<typeof getDocument> | undefined
  try {
    const request = new PdfTranslationWriter(entry).generate(
      {
        id: 'generated-link-reflow',
        data: await pdf.save(),
        pages: Array.from({ length: crossPage ? 2 : 1 }, () => ({ width: 600, height: 800 })),
        units: [
          {
            source: 'Start method. See Fig. 2 next.',
            translation,
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 40 / 600, y: 87 / 800, width: 110 / 600, height: 18 / 800 }
              },
              {
                pageNumber: crossPage ? 2 : 1,
                rect: { x: 40 / 600, y: 137 / 800, width: 110 / 600, height: 18 / 800 }
              }
            ]
          }
        ]
      },
      caller.lease
    )
    if (!accepted) {
      await expect(request).rejects.toBeInstanceOf(PdfGenerationError)
      return
    }
    task = getDocument({ data: (await request)!, useSystemFonts: true })
    const output = await (await task.promise).getPage(1),
      text = (await output.getTextContent()).items
        .flatMap((item) => ('str' in item ? [item.str] : []))
        .join('')
        .replace(/\s/gu, ''),
      links = await output.getAnnotations()
    expect(text).toBe(translation)
    expect(links).toHaveLength(1)
    expect(links[0].url).toBe('https://example.org/figure/2')
    expect(links[0].rect[1]).toBeGreaterThan(680)
  } finally {
    await task?.destroy()
    caller.release()
  }
})

it.each(
  readPdfTranslationCases<{
    name: string
    baseline: number
    outsideX?: boolean
    translated: boolean
  }>('tall-footnote-hit-area-prose.jsonl')
)('$name', async ({ baseline, outsideX, translated }) => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica),
    page = pdf.addPage([600, 800]),
    caller = lease(),
    linkRect = [outsideX ? 20 : 40, 698, 120, 738]
  page.drawText('Author', { font, x: 40, y: 700, size: 12 })
  page.drawText('*', { font, x: 80, y: 706, size: 7 })
  page.drawText('Research institute', { font, x: 40, y: baseline, size: 12 })
  page.drawText('Contact details', { font, x: 40, y: 677, size: 12 })
  page.drawText('Untouched neighbor', { font, x: 250, y: 690, size: 12 })
  page.node.set(
    PDFName.of('Annots'),
    pdf.context.obj([
      pdf.context.register(
        pdf.context.obj({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: linkRect,
          Border: [0, 0, 0],
          A: { S: 'URI', URI: PDFString.of('https://example.org/author-note') }
        })
      )
    ])
  )
  let task: ReturnType<typeof getDocument> | undefined
  try {
    const data = (await new PdfTranslationWriter(entry).generate(
      {
        id: 'tall-footnote-affiliation',
        preserveUnsupported: true,
        data: await pdf.save(),
        pages: [{ width: 600, height: 800 }],
        units: [
          {
            source: 'Author* Research institute Contact details',
            translation: 'Author* 科研机构 联系方式',
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 40 / 600, y: 85 / 800, width: 140 / 600, height: 43 / 800 }
              }
            ]
          }
        ]
      },
      caller.lease
    ))!
    task = getDocument({ data, useSystemFonts: true })
    const output = await (await task.promise).getPage(1),
      items = (await output.getTextContent()).items.filter((item) => 'str' in item),
      text = items.map((item) => item.str).join(''),
      links = await output.getAnnotations()
    expect(text.includes('科研机构')).toBe(translated)
    expect(text.includes('Research institute')).toBe(!translated)
    expect(text).toContain('Untouched neighbor')
    expect(links).toHaveLength(1)
    expect(links[0].url).toBe('https://example.org/author-note')
    links[0].rect.forEach((n: number, i: number) => expect(n).toBeCloseTo(linkRect[i], 2))
    const marker = items.find((item) => item.str === '*')!
    expect(marker.transform[4]).toBeCloseTo(80, 2)
    expect(marker.transform[5]).toBeCloseTo(706, 2)
    expect(marker.height).toBeCloseTo(7, 2)
  } finally {
    await task?.destroy()
    caller.release()
  }
})

it('uses reserved space above the source baseline for wrapped prose with a raised exponent', async () => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.TimesRoman),
    page = pdf.addPage([600, 800]),
    caller = lease(),
    source = 'Estimate x2.',
    translation = '此处给出关于变量x2的完整定义以及需要满足的条件。'
  page.drawText('Estimate x', { font, x: 40, y: 700, size: 12 })
  const at = 40 + font.widthOfTextAtSize('Estimate x', 12)
  page.drawText('2', { font, x: at, y: 704, size: 8 })
  page.drawText('.', { font, x: at + font.widthOfTextAtSize('2', 8), y: 700, size: 12 })
  const data = await new PdfTranslationWriter(entry).generate(
    {
      id: 'borrowed-top',
      data: await pdf.save(),
      pages: [{ width: 600, height: 800 }],
      units: [
        {
          source,
          translation,
          fragments: [
            {
              pageNumber: 1,
              rect: { x: 40 / 600, y: 72 / 800, width: 120 / 600, height: 38 / 800 }
            }
          ]
        }
      ]
    },
    caller.lease
  )
  const task = getDocument({ data: data! })
  try {
    const content = await (await (await task.promise).getPage(1)).getTextContent()
    expect(
      content.items
        .map((item) => ('str' in item ? item.str : ''))
        .join('')
        .replace(/\s/gu, '')
    ).toBe(translation)
  } finally {
    await task.destroy()
  }
})

it.each(
  readPdfTranslationCases<{ name: string; fontSize: number; source: string; translation: string }>(
    'small-chart-label-font-floor.jsonl'
  )
)('$name', async ({ fontSize, source, translation }) => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica),
    page = pdf.addPage([600, 800]),
    caller = lease()
  page.drawText(source, { font, size: fontSize, x: 40, y: 700 })
  const width = font.widthOfTextAtSize(source, fontSize) + 1
  let task: ReturnType<typeof getDocument> | undefined
  try {
    const data = await new PdfTranslationWriter(entry).generate(
      {
        id: 'small-chart-label',
        data: await pdf.save(),
        pages: [{ width: 600, height: 800 }],
        units: [
          {
            source,
            translation,
            fragments: [
              {
                pageNumber: 1,
                rect: {
                  x: 40 / 600,
                  y: (100 - fontSize * 0.8) / 800,
                  width: width / 600,
                  height: fontSize / 800
                }
              }
            ]
          }
        ]
      },
      caller.lease
    )
    task = getDocument({ data: data! })
    const items = (await (await (await task.promise).getPage(1)).getTextContent()).items
      .filter((item) => 'str' in item)
      .filter((item) => item.str.trim())
    expect(items.map((item) => item.str).join('')).toBe(translation)
    for (const item of items) {
      expect(item.height).toBeGreaterThanOrEqual(fontSize - 0.001)
      expect(item.height).toBeLessThanOrEqual(fontSize + 0.5)
      expect(item.transform[4]).toBeGreaterThanOrEqual(39.999)
      expect(item.transform[4] + item.width).toBeLessThanOrEqual(40 + width + 0.001)
    }
  } finally {
    await task?.destroy()
    caller.release()
  }
})

it.each(
  readPdfTranslationCases<{ name: string; label: string; translation: string }>(
    'native-citation-punctuation-descenders.jsonl'
  )
)('$name', async ({ label, translation }) => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.TimesRoman),
    page = pdf.addPage([600, 800]),
    caller = lease(),
    x = 60,
    width = font.widthOfTextAtSize(label, 10),
    source = `See ${label} for details.`
  page.drawText('See ', { font, size: 10, x: 40, y: 700 })
  page.drawText(label, { font, size: 10, x, y: 700 })
  page.drawText(' for details.', { font, size: 10, x: x + width, y: 700 })
  const rect = [x + 1, 699, x + width - 1, 708]
  page.node.set(
    PDFName.of('Annots'),
    pdf.context.obj([
      pdf.context.register(
        pdf.context.obj({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: rect,
          Border: [0, 0, 0],
          A: { S: 'URI', URI: PDFString.of('https://example.org/citation') }
        })
      )
    ])
  )
  let target: ReturnType<typeof getDocument> | undefined
  try {
    const data = await new PdfTranslationWriter(entry).generate(
      {
        id: 'citation-ink',
        data: await pdf.save(),
        pages: [{ width: 600, height: 800 }],
        units: [
          {
            source,
            translation,
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 40 / 600, y: 90 / 800, width: 140 / 600, height: 50 / 800 }
              }
            ]
          }
        ]
      },
      caller.lease
    )
    target = getDocument({ data: data!, useSystemFonts: true })
    const output = await (await target.promise).getPage(1),
      annotation = (await output.getAnnotations())[0]
    expect(
      (await output.getTextContent()).items
        .map((i) => ('str' in i ? i.str : ''))
        .join('')
        .replace(/\s/gu, '')
    ).toBe(translation.replace(/\s/gu, ''))
    expect(annotation.url).toBe('https://example.org/citation')
    expect(annotation.rect[2] - annotation.rect[0]).toBeCloseTo(rect[2] - rect[0], 3)
    expect(annotation.rect[3] - annotation.rect[1]).toBeCloseTo(rect[3] - rect[1], 3)
    expect(annotation.rect).not.toEqual(rect)
  } finally {
    await target?.destroy()
    caller.release()
  }
})

it.each(
  readPdfTranslationCases<{ name: string; ruleY: number; translated: boolean }>(
    'raster-rule-grazing-header.jsonl'
  )
)('$name', async ({ ruleY, translated }) => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica),
    page = pdf.addPage([612, 792]),
    canvas = createCanvas(1, 1),
    caller = lease()
  canvas.getContext('2d').fillRect(0, 0, 1, 1)
  const image = await pdf.embedPng(canvas.toBuffer('image/png'))
  page.drawImage(image, { x: 30, y: ruleY, width: 150, height: 0.4 })
  page.drawText('Header', { font, size: 12, x: 40, y: 700 })
  let task: ReturnType<typeof getDocument> | undefined
  try {
    const data = await new PdfTranslationWriter(entry).generate(
      {
        id: 'raster-rule-header',
        data: await pdf.save(),
        preserveUnsupported: true,
        pages: [{ width: 612, height: 792 }],
        units: [
          {
            source: 'Header',
            translation: '表头',
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 40 / 612, y: 82 / 792, width: 110 / 612, height: 15 / 792 }
              }
            ]
          }
        ]
      },
      caller.lease
    )
    task = getDocument({ data: data!, useSystemFonts: true })
    const output = await (await task.promise).getPage(1),
      items = (await output.getTextContent()).items.filter((item) => 'str' in item),
      text = items.map((item) => item.str).join('')
    expect(text).toBe(translated ? '表头' : 'Header')
    if (translated) {
      const native = items[0]
      expect(native.transform[3]).toBeGreaterThanOrEqual(8)
      expect(native.transform[5]).toBeLessThan(ruleY)
    }
  } finally {
    await task?.destroy()
    caller.release()
  }
})

it.each([false, true])(
  'localizes parenthesized URL text while preserving the original action (%s)',
  async (uriIncludesParenthesis) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica),
      page = pdf.addPage([600, 800]),
      url = 'https://example.org/trial/',
      prefix = 'Registration (',
      source = `${prefix}${url}) completed.`,
      translation = `注册（${url}）完成。`,
      uri = url + (uriIncludesParenthesis ? ')' : ''),
      linkX = 40 + font.widthOfTextAtSize(prefix, 10),
      caller = lease()
    page.drawText(source, { font, size: 10, x: 40, y: 700 })
    page.node.set(
      PDFName.of('Annots'),
      pdf.context.obj([
        pdf.context.register(
          pdf.context.obj({
            Type: 'Annot',
            Subtype: 'Link',
            Rect: [linkX, 698, linkX + font.widthOfTextAtSize(url + ')', 10), 710],
            Border: [0, 0, 0],
            A: { S: 'URI', URI: PDFString.of(uri.replaceAll(')', '\\)')) }
          })
        )
      ])
    )
    let task: ReturnType<typeof getDocument> | undefined
    try {
      const data = await new PdfTranslationWriter(entry).generate(
        {
          id: 'parenthesized-url',
          data: await pdf.save(),
          pages: [{ width: 600, height: 800 }],
          units: [
            {
              source,
              translation,
              fragments: [
                {
                  pageNumber: 1,
                  rect: { x: 36 / 600, y: 88 / 800, width: 450 / 600, height: 28 / 800 }
                }
              ]
            }
          ]
        },
        caller.lease
      )
      task = getDocument({ data: data!.slice(), useSystemFonts: true })
      const target = await (await task.promise).getPage(1)
      const text = (await target.getTextContent()).items
        .map((i) => ('str' in i ? i.str : ''))
        .join('')
        .replace(/\s/gu, '')
      expect(text).toBe(translation)
      const output = await PDFDocument.load(data!)
      expect(
        output
          .getPage(0)
          .node.Annots()!
          .lookup(0, PDFDict)
          .lookup(PDFName.of('A'), PDFDict)
          .lookup(PDFName.of('URI'), PDFString)
          .decodeText()
      ).toBe(uri)
    } finally {
      await task?.destroy()
      caller.release()
    }
  }
)

it.each(['redundant', 'effective', 'blank', 'single-letter'] as const)(
  'preserves effective clipping while translating %s clipped text',
  async (kind) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica),
      page = pdf.addPage([600, 800]),
      source = kind === 'single-letter' ? 'T' : 'A complete caption.',
      translation = kind === 'single-letter' ? '总计' : '完整的图注。',
      caller = lease()
    page.pushOperators(
      pushGraphicsState(),
      rectangle(35, 695, kind === 'effective' ? 35 : 300, 25),
      clip(),
      endPath()
    )
    page.drawText(kind === 'blank' ? ' ' : source, { font, size: 10, x: 40, y: 700 })
    page.pushOperators(popGraphicsState())
    if (kind === 'blank') page.drawText(source, { font, size: 10, x: 40, y: 700 })
    let task: ReturnType<typeof getDocument> | undefined
    try {
      const data = await new PdfTranslationWriter(entry).generate(
        {
          id: 'clipped-caption',
          data: await pdf.save(),
          preserveUnsupported: true,
          pages: [{ width: 600, height: 800 }],
          units: [
            {
              source,
              translation,
              fragments: [
                {
                  pageNumber: 1,
                  rect: { x: 35 / 600, y: 85 / 800, width: 300 / 600, height: 25 / 800 }
                }
              ]
            }
          ]
        },
        caller.lease
      )
      task = getDocument({ data: data!, useSystemFonts: true })
      const target = await (await task.promise).getPage(1)
      const text = (await target.getTextContent()).items
        .map((i) => ('str' in i ? i.str : ''))
        .join('')
        .replace(/\s/gu, '')
      expect(text).toBe((kind === 'effective' ? source : translation).replace(/\s/gu, ''))
    } finally {
      await task?.destroy()
      caller.release()
    }
  }
)

it.each(
  readPdfTranslationCases<{
    name: string
    cells: string[]
    translations: Array<string | null>
    gap: number
    width?: number
    rule?: boolean
    sourceItems?: boolean
    crop?: number
    splitItems?: boolean
    scale?: number
    ligature?: boolean
  }>('shared-native-table-run-replacement.jsonl')
)(
  '$name',
  async ({
    cells,
    translations,
    gap,
    width,
    rule,
    sourceItems,
    splitItems,
    scale = 1,
    ligature = false,
    crop = 0
  }) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(ligature ? StandardFonts.TimesRoman : StandardFonts.Helvetica),
      page = pdf.addPage([612, 792]),
      caller = lease(),
      separator = ' '.repeat(gap),
      // Standard-font drawText emits one Tj without kerning adjustments;
      // widthOfTextAtSize includes kerning pairs that are not painted.
      runWidth = (value: string): number =>
        (ligature ? (value.match(/fi|./gu) ?? []) : [...value]).reduce(
          // Times /fi has a 556-unit native advance; it is one glyph,
          // distinct from the standard font's two-letter kerning pair.
          (sum, char) =>
            sum + (ligature && char === 'fi' ? 5.56 : font.widthOfTextAtSize(char, 10)),
          0
        )
    const positions = cells.map(
      (_, i) => 40 + runWidth(cells.slice(0, i).join(separator) + (i ? separator : ''))
    )
    page.pushOperators(
      pushGraphicsState(),
      concatTransformationMatrix(1, 0, 0, scale, 0, 700 * (1 - scale))
    )
    page.drawText(ligature ? cells.join(separator).replace(/fi/gu, 'A') : cells.join(separator), {
      font,
      size: 10,
      x: 40,
      y: 700
    })
    page.pushOperators(popGraphicsState())
    if (ligature) {
      await pdf.flush()
      const dict = pdf.context.lookup(font.ref, PDFDict)
      dict.set(
        PDFName.of('Encoding'),
        pdf.context.obj({
          Type: 'Encoding',
          BaseEncoding: 'WinAnsiEncoding',
          Differences: [65, 'fi']
        })
      )
      dict.set(
        PDFName.of('ToUnicode'),
        pdf.context.register(
          pdf.context.stream(
            '/CIDInit /ProcSet findresource begin\n' +
              '12 dict begin begincmap\n' +
              '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n' +
              '/CMapName /LigatureMap def /CMapType 2 def\n' +
              '1 begincodespacerange <00> <FF> endcodespacerange\n' +
              '1 beginbfchar <41> <00660069> endbfchar\n' +
              'endcmap CMapName currentdict /CMap defineresource pop end end'
          )
        )
      )
    }
    if (rule) {
      const canvas = createCanvas(1, 1),
        context = canvas.getContext('2d')
      context.fillRect(0, 0, 1, 1)
      const image = await pdf.embedPng(canvas.toBuffer('image/png'))
      page.drawImage(image, { x: 36, y: 708.3, width: width!, height: 0.4 })
    }
    let task: ReturnType<typeof getDocument> | undefined
    try {
      const generation = new PdfTranslationWriter(entry).generate(
        {
          id: 'shared-table-run',
          data: await pdf.save(),
          pages: [{ width: 612, height: 792 }],
          units: cells.flatMap((source, i) =>
            translations[i]
              ? [
                  {
                    source,
                    translation: translations[i]!,
                    fragments: [
                      {
                        pageNumber: 1,
                        ...(sourceItems
                          ? {
                              items: (splitItems ? source.split(' ') : [source]).map(
                                (text, index) => ({ index, text })
                              )
                            }
                          : {}),
                        rect: {
                          x: (positions[i] - (sourceItems ? 0.1 : 4) + crop) / 612,
                          y: (792 - 708.5) / 792,
                          width: (width ?? runWidth(source) + 8) / 612,
                          height: 11 / 792
                        }
                      }
                    ]
                  }
                ]
              : []
          )
        },
        caller.lease
      )
      if (crop) {
        await expect(generation).rejects.toMatchObject({ failure: { code: 'source-mismatch' } })
        return
      }
      const output = await generation
      task = getDocument({ data: output!, useSystemFonts: true })
      const items = (await (await (await task.promise).getPage(1)).getTextContent()).items.filter(
        (item): item is import('pdfjs-dist/types/src/display/api').TextItem => 'str' in item
      )
      const text = items
        .map((i) => i.str)
        .join('')
        .replace(/\s/gu, '')
      for (const [i, source] of cells.entries()) {
        expect(text).toContain((translations[i] ?? source).replace(/\s/gu, ''))
        if (translations[i]) {
          if (!cells.some((cell, index) => cell === source && !translations[index]))
            expect(text).not.toContain(source.replace(/\s/gu, ''))
        } else {
          const values = items.filter(
            (item) =>
              item.str.trim() &&
              item.transform[4] >= positions[i] - 0.01 &&
              item.transform[4] < positions[i] + runWidth(source) - 0.01
          )
          expect(
            values
              .map((item) => item.str)
              .join('')
              .replace(/\s/gu, '')
          ).toBe(source.replace(/\s/gu, ''))
          expect(values[0].transform[4]).toBeCloseTo(positions[i], 2)
          expect(values.every((item) => Math.abs(item.transform[5] - 700) < 0.01)).toBe(true)
        }
      }
    } finally {
      await task?.destroy()
      caller.release()
    }
  }
)

it.each(
  readPdfTranslationCases<{ name: string; join: string; valid: boolean }>(
    'cross-column-word-hyphen-linked-citation.jsonl'
  )
)('$name', async ({ join, valid }) => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica),
    page = pdf.addPage([612, 792]),
    caller = lease(),
    annotations = []
  for (const [i, x] of [40, 330].entries()) {
    const prefix = i ? 'medical results [' : 'See [',
      label = '7',
      suffix = i ? '].' : '] for bio-'
    page.drawText(prefix, { font, size: 12, x, y: 700 })
    const linkX = x + font.widthOfTextAtSize(prefix, 12),
      width = font.widthOfTextAtSize(label, 12)
    page.drawText(label, { font, size: 12, x: linkX, y: 700 })
    page.drawText(suffix, { font, size: 12, x: linkX + width, y: 700 })
    annotations.push(
      pdf.context.register(
        pdf.context.obj({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: [linkX - 0.2, 698, linkX + width + 0.2, 712],
          Border: [0, 0, 0],
          A: { S: 'URI', URI: PDFString.of('https://example.org/reference/7') }
        })
      )
    )
  }
  page.node.set(PDFName.of('Annots'), pdf.context.obj(annotations))
  let task: ReturnType<typeof getDocument> | undefined
  try {
    const pending = new PdfTranslationWriter(entry).generate(
      {
        id: 'column-hyphen',
        data: await pdf.save(),
        pages: [{ width: 612, height: 792 }],
        units: [
          {
            source: `See [7] for bio${join}medical results [7].`,
            translation: '参见[7]的生物医学结果[7]。',
            fragments: [40, 330].map((x) => ({
              pageNumber: 1,
              rect: { x: x / 612, y: 80 / 792, width: 200 / 612, height: 50 / 792 }
            }))
          }
        ]
      },
      caller.lease
    )
    if (!valid) {
      await expect(pending).rejects.toMatchObject({
        failure: { code: expect.stringMatching(/source-mismatch|annotations/) }
      })
      return
    }
    task = getDocument({ data: (await pending)! })
    const output = await (await task.promise).getPage(1),
      links = await output.getAnnotations()
    expect(
      (await output.getTextContent()).items
        .flatMap((i) => ('str' in i ? [i.str] : []))
        .join('')
        .replace(/\s/gu, '')
    ).toBe('参见[7]的生物医学结果[7]。')
    expect(links.map((l) => l.url)).toEqual([
      'https://example.org/reference/7',
      'https://example.org/reference/7'
    ])
    links.forEach((link, i) => {
      expect(link.rect[0]).toBeGreaterThanOrEqual([40, 330][i])
      expect(link.rect[2]).toBeLessThanOrEqual([240, 530][i])
    })
  } finally {
    await task?.destroy()
    caller.release()
  }
})

it.each(
  readPdfTranslationCases<{
    name: string
    source: string
    translation: string
    width: number
    fits: boolean
  }>('compact-cjk-table-header-fit.jsonl')
)('$name', async ({ source, translation, width, fits }) => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica),
    page = pdf.addPage([612, 792]),
    caller = lease()
  page.drawText(source, { font, size: 8, x: 40, y: 700 })
  page.drawText('32.6', { font, size: 10, x: 70, y: 685 })
  let task: ReturnType<typeof getDocument> | undefined
  try {
    const result = new PdfTranslationWriter(entry).generate(
      {
        id: 'compact-header',
        data: await pdf.save(),
        pages: [{ width: 612, height: 792 }],
        units: [
          {
            source,
            translation,
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 40 / 612, y: 84 / 792, width: width / 612, height: 11 / 792 }
              }
            ]
          }
        ]
      },
      caller.lease
    )
    if (!fits) {
      await expect(result).rejects.toMatchObject({ failure: { code: 'overflow' } })
      return
    }
    task = getDocument({ data: (await result)! })
    const items = (await (await (await task.promise).getPage(1)).getTextContent()).items.filter(
      (i) => 'str' in i
    )
    expect(
      items
        .map((i) => i.str)
        .join('')
        .replace(/\s/gu, '')
    ).toContain(translation)
    const number = items.find((i) => i.str === '32.6')!
    expect(number.transform).toEqual([10, 0, 0, 10, 70, 685])
    const label = items.filter((i) => i.str !== '32.6' && i.str.trim())
    for (const item of label) {
      expect(item.transform[3]).toBeGreaterThanOrEqual(8)
      expect(item.transform[0] / item.transform[3]).toBeGreaterThanOrEqual(0.85)
      expect(item.transform[4]).toBeGreaterThanOrEqual(39.99)
      expect(item.transform[4] + item.width).toBeLessThanOrEqual(40 + width + 0.1)
    }
  } finally {
    await task?.destroy()
    caller.release()
  }
})

it.each(
  readPdfTranslationCases<{
    name: string
    font: 'TimesRoman' | 'TimesRomanBold'
    prefix: string
    translation: string
  }>('native-prefix-positive-side-bearing.jsonl')
)('$name', async ({ font: fontName, prefix, translation }) => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts[fontName]),
    page = pdf.addPage([612, 792]),
    caller = lease()
  let x = 40
  for (const [text, size, y] of [
    [prefix, 12, 700],
    [' remains stable during every iteration and uses x', 12, 700],
    ['1', 8, 697],
    [' to calculate the result.', 12, 700]
  ] as const) {
    page.drawText(text, { font, x, y, size })
    x += font.widthOfTextAtSize(text, size)
  }
  const data = await pdf.save(),
    original = getDocument({ data: data.slice(), useSystemFonts: true })
  let target: ReturnType<typeof getDocument> | undefined
  try {
    const { source } = await extractPdfTranslationSource({
      document: await original.promise,
      resourceRequestKey: 'numbered-prefix',
      signal: caller.lease.signal
    })
    expect(source.units).toHaveLength(1)
    const output = await new PdfTranslationWriter(entry).generate(
      {
        id: 'numbered-prefix',
        data,
        pages: source.pages,
        units: source.units.map((unit) => ({ ...unit, translation }))
      },
      caller.lease
    )
    target = getDocument({ data: output!, useSystemFonts: true })
    const content = await (await (await target.promise).getPage(1)).getTextContent(),
      items = content.items.filter((item) => 'str' in item).filter((item) => item.str.trim()),
      retainedPrefix = items.find((item) => item.str === prefix)
    expect(retainedPrefix).toBeDefined()
    expect(retainedPrefix!.transform[4]).toBeGreaterThanOrEqual(40 - 0.001)
    expect(
      items
        .map((item) => item.str)
        .join('')
        .replace(/\s/gu, '')
        .normalize('NFKC')
    ).toBe(translation.replace(/\s/gu, '').normalize('NFKC'))
  } finally {
    await target?.destroy()
    await original.destroy()
    caller.release()
  }
})

it.each(
  readPdfTranslationCases<{ name: string; width: number; translated: boolean; author?: string }>(
    'compact-cjk-linked-label-fit.jsonl'
  )
)('$name', async ({ width, translated, author = 'Riley' }) => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.TimesRoman),
    page = pdf.addPage([612, 792]),
    caller = lease(),
    source = `w/ Linear Init (${author} et al., 2022)`,
    translation = `w/ Linear 初始化（${author} 等人，2022）`,
    labels = [`${author} et al.`, '2022'],
    rectangles = labels.map((label) => {
      const x = 40 + font.widthOfTextAtSize(source.slice(0, source.indexOf(label)), 9)
      return [x, 698, x + font.widthOfTextAtSize(label, 9), 710]
    })
  page.drawText(source, { font, size: 9, x: 40, y: 700 })
  page.drawText('32.6', { font, size: 9, x: 240, y: 700 })
  page.node.set(
    PDFName.of('Annots'),
    pdf.context.obj(
      rectangles.map((Rect, i) =>
        pdf.context.register(
          pdf.context.obj({
            Type: 'Annot',
            Subtype: 'Link',
            Rect,
            Border: [0, 0, 0],
            A: { S: 'URI', URI: PDFString.of(`https://example.org/reference/${i}`) }
          })
        )
      )
    )
  )
  let task: ReturnType<typeof getDocument> | undefined
  try {
    const output = await new PdfTranslationWriter(entry).generate(
      {
        id: 'compact-linked-label',
        data: await pdf.save(),
        preserveUnsupported: true,
        pages: [{ width: 612, height: 792 }],
        units: [
          {
            source,
            translation,
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 40 / 612, y: 82 / 792, width: width / 612, height: 13 / 792 }
              }
            ]
          }
        ]
      },
      caller.lease
    )
    task = getDocument({ data: output!, useSystemFonts: true })
    const target = await (await task.promise).getPage(1),
      items = (await target.getTextContent()).items.filter((i) => 'str' in i),
      text = items
        .map((i) => i.str)
        .join('')
        .replace(/\s/gu, ''),
      annotations = await target.getAnnotations()
    expect(text).toContain((translated ? translation : source).replace(/\s/gu, ''))
    expect(items.find((i) => i.str === '32.6')!.transform).toEqual([9, 0, 0, 9, 240, 700])
    expect(annotations).toHaveLength(2)
    annotations.forEach((link, i) => {
      expect(link.url).toBe(`https://example.org/reference/${i}`)
      expect(link.rect[2] - link.rect[0]).toBeCloseTo(rectangles[i][2] - rectangles[i][0], 3)
      expect(link.rect[3] - link.rect[1]).toBeCloseTo(12, 3)
      expect(link.rect[0]).toBeGreaterThanOrEqual(39.99)
      expect(link.rect[2]).toBeLessThanOrEqual(40 + width + 0.01)
    })
    if (translated) {
      const prose = items.find((i) => i.str.includes('初始化'))!
      expect(prose.transform[3]).toBeGreaterThanOrEqual(8)
      expect(prose.transform[0] / prose.transform[3]).toBeGreaterThanOrEqual(0.85)
      expect(prose.transform[0] / prose.transform[3]).toBeLessThan(1)
      for (const label of [author, '2022']) {
        const item = items.find((i) => i.str.includes(label))!
        expect(item.transform[0] / item.transform[3]).toBeCloseTo(1, 4)
      }
    } else {
      annotations.forEach((link, i) =>
        rectangles[i].forEach((v, j) => expect(link.rect[j]).toBeCloseTo(v, 3))
      )
    }
  } finally {
    await task?.destroy()
    caller.release()
  }
})

it('keeps a wrapped caption operator with its prose through native translation', async () => {
  const [example] = readPdfTranslationCases<{
      items: Array<{ text: string; x: number; y: number; size: number }>
      expected: string[]
      translation: string
    }>('wrapped-prose-operator-prefix.jsonl'),
    pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica),
    symbolFont = await pdf.embedFont(StandardFonts.TimesRoman),
    page = pdf.addPage([600, 800]),
    caller = lease()
  for (const item of example.items) {
    page.drawText(item.text, {
      font: item.text === '=' ? symbolFont : font,
      x: item.x,
      y: 800 - item.y,
      size: item.size
    })
  }
  const data = await pdf.save(),
    original = getDocument({ data: data.slice(), useSystemFonts: true })
  let target: ReturnType<typeof getDocument> | undefined
  try {
    const { source } = await extractPdfTranslationSource({
        document: await original.promise,
        resourceRequestKey: 'wrapped-caption-operator',
        signal: caller.lease.signal
      }),
      units = source.units.filter((unit) => !unit.sourceOnly)
    expect(units.map((unit) => unit.source)).toEqual(example.expected)
    expect(units[0].fragments).toHaveLength(1)
    const output = await new PdfTranslationWriter(entry).generate(
      {
        id: 'wrapped-caption-operator',
        data,
        pages: source.pages,
        units: units.map((unit) => ({ ...unit, translation: example.translation }))
      },
      caller.lease
    )
    target = getDocument({ data: output!, useSystemFonts: true })
    const text = (await (await (await target.promise).getPage(1)).getTextContent()).items
      .map((item) => ('str' in item ? item.str : ''))
      .join('')
      .replace(/\s/gu, '')
    expect(text).toBe(example.translation.replace(/\s/gu, ''))
  } finally {
    await target?.destroy()
    await original.destroy()
    caller.release()
  }
})

it('reflows a hanging caption without consuming notes or the preceding page', async () => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Courier),
    first = pdf.addPage([600, 800]),
    page = pdf.addPage([600, 800]),
    caller = lease(),
    before = 'The preceding page discusses a separate method that accepts',
    note = 'A note about the table.',
    body = 'The following paragraph describes a separate experiment.'
  first.drawText(before, { font, x: 40, y: 80, size: 10 })
  page.drawText(note, { font, x: 40, y: 720, size: 10 })
  page.drawText('Table 2: Results for all measured values across several input conditions', {
    font,
    x: 40,
    y: 700,
    size: 10
  })
  page.drawText('using an identical sequence and shared evaluation parameters', {
    font,
    x: 100,
    y: 688,
    size: 10
  })
  page.drawText('with the same settings.', { font, x: 100, y: 676, size: 10 })
  page.drawText(body, { font, x: 40, y: 640, size: 10 })
  const data = await pdf.save(),
    original = getDocument({ data: data.slice(), useSystemFonts: true })
  let target: ReturnType<typeof getDocument> | undefined
  try {
    const { source } = await extractPdfTranslationSource({
      document: await original.promise,
      resourceRequestKey: 'hanging-caption',
      signal: caller.lease.signal
    })
    const caption = source.units.find((unit) => unit.source.startsWith('Table 2:'))!
    expect(caption.source).toContain('conditions using an identical sequence')
    expect(caption.source).toContain('with the same settings.')
    expect(caption.fragments.map((fragment) => fragment.pageNumber)).toEqual([2])
    for (const text of [before, note, body])
      expect(source.units.some((unit) => unit.source === text)).toBe(true)
    const translation = '表 2：在相同输入序列和评估参数下，各条件的测量结果。',
      output = await new PdfTranslationWriter(entry).generate(
        {
          id: 'hanging-caption',
          data,
          pages: source.pages,
          units: [{ ...caption, translation }]
        },
        caller.lease
      )
    target = getDocument({ data: output!, useSystemFonts: true })
    const result = await target.promise,
      text = (await (await result.getPage(2)).getTextContent()).items
        .flatMap((i) => ('str' in i ? [i.str] : []))
        .join('')
    expect(text).toContain(translation)
    expect(text).toContain(note)
    expect(text).toContain(body)
    expect(
      (await (await result.getPage(1)).getTextContent()).items.some(
        (i) => 'str' in i && i.str === before
      )
    ).toBe(true)
  } finally {
    await target?.destroy()
    await original.destroy()
    caller.release()
  }
})

it('translates prose beside a word-variable fraction without moving its native tiers', async () => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.TimesRoman),
    math = await pdf.embedFont(StandardFonts.TimesRomanItalic),
    symbol = await pdf.embedFont(StandardFonts.Symbol),
    page = pdf.addPage([600, 800]),
    caller = lease()
  page.drawText('The rate follows', { font, x: 40, y: 700, size: 10 })
  page.drawText('(1', { font, x: 110, y: 700, size: 10 })
  page.drawText('−', { font: symbol, x: 121, y: 700, size: 10 })
  const left = 131,
    width = math.widthOfTextAtSize('max step', 7),
    right = left + width
  page.drawText('step', {
    font: math,
    x: left + (width - math.widthOfTextAtSize('step', 7)) / 2,
    y: 704,
    size: 7
  })
  page.drawText('max step', { font: math, x: left, y: 696.5, size: 7 })
  page.drawLine({ start: { x: left, y: 702 }, end: { x: right, y: 702 }, thickness: 0.4 })
  page.drawText(')', { font, x: right + 2, y: 700, size: 10 })
  page.drawText('rate', { font: math, x: right + 6, y: 704, size: 7 })
  page.drawText('and remains stable.', { font, x: right + 25, y: 700, size: 10 })
  const data = await pdf.save(),
    original = getDocument({ data: data.slice(), useSystemFonts: true })
  let target: ReturnType<typeof getDocument> | undefined
  try {
    const document = await original.promise,
      originalItems = (await (await document.getPage(1)).getTextContent()).items.filter(
        (i) => 'str' in i
      ),
      { source } = await extractPdfTranslationSource({
        document,
        resourceRequestKey: 'word-variable-fraction',
        signal: caller.lease.signal
      }),
      prose = source.units.filter((unit) => !unit.sourceOnly)
    expect(prose.map((unit) => unit.source)).toEqual(['The rate follows', 'and remains stable.'])
    expect(source.units.some((unit) => unit.sourceOnly && unit.source.includes('max step'))).toBe(
      true
    )
    const output = await new PdfTranslationWriter(entry).generate(
      {
        id: 'word-variable-fraction',
        data,
        pages: source.pages,
        units: prose.map((unit, index) => ({
          ...unit,
          translation: index ? '并保持稳定。' : '速率遵循'
        }))
      },
      caller.lease
    )
    target = getDocument({ data: output!, useSystemFonts: true })
    const items = (await (await (await target.promise).getPage(1)).getTextContent()).items.filter(
      (i) => 'str' in i
    )
    expect(items.map((i) => i.str).join('')).toContain('速率遵循')
    expect(items.map((i) => i.str).join('')).toContain('并保持稳定。')
    for (const text of ['step', 'max step', 'rate']) {
      const expected = originalItems.find((i) => i.str === text)!
      const actual = items.find((i) => i.str === text)!
      expect(actual).toBeDefined()
      expected.transform.forEach((value, index) =>
        expect(actual.transform[index]).toBeCloseTo(value, 3)
      )
    }
  } finally {
    await target?.destroy()
    await original.destroy()
    caller.release()
  }
})

it.each(
  ['decimal-prose-boundary.jsonl', 'parenthesized-statistics-prose.jsonl'].flatMap((file) =>
    readPdfTranslationCases<{
      name: string
      items: Array<{ text: string; italic?: boolean }>
      expected: string[]
      translation: string
    }>(file).filter((example) => example.translation)
  )
)('keeps inline values intact through native translation: $name', async (example) => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.TimesRoman),
    italic = await pdf.embedFont(StandardFonts.TimesRomanItalic),
    page = pdf.addPage([612, 792]),
    caller = lease()
  let x = 40
  for (const item of example.items) {
    const face = item.italic ? italic : font
    page.drawText(item.text, { font: face, x, y: 700, size: 10 })
    x += face.widthOfTextAtSize(item.text, 10)
  }
  const data = await pdf.save(),
    original = getDocument({ data: data.slice(), useSystemFonts: true })
  let target: ReturnType<typeof getDocument> | undefined
  try {
    const { source } = await extractPdfTranslationSource({
        document: await original.promise,
        resourceRequestKey: 'inline-value-boundary',
        signal: caller.lease.signal
      }),
      units = source.units.filter((unit) => !unit.sourceOnly)
    expect(units.map((unit) => unit.source)).toEqual(example.expected)
    const output = await new PdfTranslationWriter(entry).generate(
      {
        id: 'inline-value-boundary',
        data,
        pages: source.pages,
        units: units.map((unit) => ({ ...unit, translation: example.translation }))
      },
      caller.lease
    )
    target = getDocument({ data: output!, useSystemFonts: true })
    const text = (await (await (await target.promise).getPage(1)).getTextContent()).items
      .map((item) => ('str' in item ? item.str : ''))
      .join('')
      .replace(/\s/gu, '')
    expect(text).toBe(example.translation.replace(/\s/gu, ''))
  } finally {
    await target?.destroy()
    await original.destroy()
    caller.release()
  }
})

it.each(
  readPdfTranslationCases<{ name: string; leading: number; expectedMaximumPoint: number }>(
    'anchored-fragment-collision-font-retry.jsonl'
  )
)('$name', async ({ leading, expectedMaximumPoint }) => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.TimesRoman),
    page = pdf.addPage([600, 800]),
    caller = lease(),
    prefix = 'Value q',
    tail = ' stays stable.',
    second = 'Further measurements retain the original format.',
    translation =
      '数值q2保持稳定，随后继续处理全部测量结果并保留原始格式。采用一致的测量方法检查所有样本，确保结果可以重复验证。',
    x = 160 + font.widthOfTextAtSize(prefix, 10)
  page.drawText(prefix, { font, size: 10, x: 160, y: 700 })
  page.drawText('2', { font, size: 7, x, y: 698 })
  page.drawText(tail, { font, size: 10, x: x + 3.5, y: 700 })
  page.drawText(second, { font, size: 10, x: 40, y: 700 - leading })
  let task: ReturnType<typeof getDocument> | undefined
  try {
    const output = await new PdfTranslationWriter(entry).generate(
      {
        id: 'anchored-fragment-font-retry',
        data: await pdf.save(),
        preserveUnsupported: true,
        pages: [{ width: 600, height: 800 }],
        units: [
          {
            source: prefix + '2' + tail + ' ' + second,
            translation,
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 160 / 600, y: 92.5 / 800, width: 180 / 600, height: 10.5 / 800 }
              },
              {
                pageNumber: 1,
                rect: {
                  x: 40 / 600,
                  y: (92.5 + leading) / 800,
                  width: 400 / 600,
                  height: 10.5 / 800
                }
              }
            ]
          }
        ]
      },
      caller.lease
    )
    task = getDocument({ data: output!, useSystemFonts: true })
    const items = (await (await (await task.promise).getPage(1)).getTextContent()).items.filter(
      (i) => 'str' in i
    )
    expect(
      items
        .map((i) => i.str)
        .join('')
        .replace(/\s/gu, '')
    ).toBe(translation)
    const prose = items.filter((i) => /\p{Script=Han}/u.test(i.str))
    expect(prose.length).toBeGreaterThan(1)
    expect(prose.every((i) => i.transform[3] >= 8 && i.transform[3] <= expectedMaximumPoint)).toBe(
      true
    )
    expect(items.filter((i) => i.str === '2')).toHaveLength(1)
  } finally {
    await task?.destroy()
    caller.release()
  }
})

it.each(['flat', 'covered-shadow', 'transparent', 'stripe', 'raster-text', 'partial'] as const)(
  'preserves raster backdrop and neighbors for native label: %s',
  async (kind) => {
    const pdf = await PDFDocument.create(),
      page = pdf.addPage([400, 600]),
      font = await pdf.embedFont(StandardFonts.Helvetica),
      canvas = createCanvas(200, 60),
      context = canvas.getContext('2d')
    context.fillStyle = ['transparent', 'covered-shadow'].includes(kind)
      ? 'rgba(0, 100, 200, 0.5)'
      : '#0064c8'
    context.fillRect(0, 0, 200, 60)
    if (kind === 'stripe') {
      context.fillStyle = '#ff0000'
      context.fillRect(45, 0, 5, 60)
    }
    if (kind === 'raster-text') {
      context.fillStyle = '#ffffff'
      context.font = '12px sans-serif'
      context.fillText('Raster content', 15, 38)
    }
    const image = await pdf.embedPng(canvas.toBuffer('image/png'))
    page.drawImage(image, { x: kind === 'partial' ? 130 : 90, y: 480, width: 200, height: 60 })
    if (kind === 'covered-shadow')
      page.drawRectangle({
        x: 90,
        y: 480,
        width: 200,
        height: 60,
        color: rgb(0, 100 / 255, 200 / 255)
      })
    page.drawText('Measured response', { x: 100, y: 500, size: 12, font })
    page.drawText('12', { x: 340, y: 500, size: 12, font })
    const data = await pdf.save(),
      caller = lease(),
      original = getDocument({ data: data.slice(), useSystemFonts: true })
    let target: ReturnType<typeof getDocument> | undefined
    try {
      const { source } = await extractPdfTranslationSource({
        document: await original.promise,
        resourceRequestKey: 'raster-backdrop',
        signal: caller.lease.signal
      })
      const unit = source.units.find((unit) => unit.source === 'Measured response')!
      expect(unit).toBeDefined()
      const output = await new PdfTranslationWriter(entry).generate(
        {
          id: 'raster-backdrop',
          data,
          pages: source.pages,
          preserveUnsupported: true,
          units: [{ ...unit, translation: '测量响应' }]
        },
        caller.lease
      )
      target = getDocument({ data: output!, useSystemFonts: true })
      const before = await original.promise,
        after = await target.promise,
        text = (await (await after.getPage(1)).getTextContent()).items
          .filter((item) => 'str' in item)
          .map((item) => item.str)
          .join(''),
        translated = kind === 'flat' || kind === 'covered-shadow'
      expect(text).toContain(translated ? '测量响应' : 'Measured response')
      expect(text).toContain('12')
      const render = async (document: typeof before): Promise<Buffer> => {
        const page = await document.getPage(1),
          viewport = page.getViewport({ scale: 2 }),
          canvas = createCanvas(viewport.width, viewport.height),
          context = canvas.getContext('2d')
        await page.render({
          canvas: null,
          canvasContext: context as unknown as CanvasRenderingContext2D,
          viewport
        }).promise
        if (translated) {
          const rect = unit.fragments[0].rect
          context.clearRect(
            Math.floor(rect.x * viewport.width) - 2,
            Math.floor(rect.y * viewport.height) - 2,
            Math.ceil(rect.width * viewport.width) + 4,
            Math.ceil(rect.height * viewport.height) + 4
          )
        }
        return Buffer.from(context.getImageData(0, 0, canvas.width, canvas.height).data)
      }
      expect((await render(after)).equals(await render(before))).toBe(true)
    } finally {
      await target?.destroy()
      await original.destroy()
      caller.release()
    }
  }
)

it.each(
  readPdfTranslationCases<{ name: string; kind: string; translated: boolean }>(
    'nested-form-label-preservation.jsonl'
  )
)('$name', async ({ kind, translated }) => {
  const chart = await PDFDocument.create(),
    font = await chart.embedFont(StandardFonts.Helvetica),
    chartPage = chart.addPage([200, 200])
  chartPage.drawText('Measured response', { x: 25, y: 150, size: 12, font })
  chartPage.drawRectangle({ x: 25, y: 25, width: 35, height: 90, color: rgb(0, 0.4, 0.8) })
  chartPage.drawRectangle({ x: 180, y: 30, width: 60, height: 50, color: rgb(1, 0, 0) })
  const pdf = await PDFDocument.create(),
    first = pdf.addPage([600, 800]),
    offset = kind === 'offset',
    embedded = await pdf.embedPage(
      chartPage,
      offset
        ? { left: 10, bottom: 10, right: 200, top: 200 }
        : kind === 'font-margin' || kind === 'clipped-glyph'
          ? { left: 0, bottom: kind === 'font-margin' ? 145 : 154, right: 200, top: 200 }
          : undefined
    )
  first.drawPage(embedded, { x: 50, y: 450, xScale: 1.25, yScale: 1.25 })
  await pdf.flush()
  if (kind.startsWith('reversed-')) {
    const raw = pdf.context.lookup(embedded.ref) as PDFRawStream,
      x = kind !== 'reversed-y',
      y = kind !== 'reversed-x'
    raw.dict.set(
      PDFName.of('BBox'),
      pdf.context.obj([x ? 200 : 0, y ? 200 : 0, x ? 0 : 200, y ? 0 : 200])
    )
  }
  if (kind === 'unused-duplicate') {
    const duplicate = await pdf.embedPage(chartPage)
    await pdf.flush()
    const resources = first.node.Resources()!.lookup(PDFName.of('XObject')) as PDFDict
    resources.set(PDFName.of('UnusedChart'), duplicate.ref)
  }
  if (kind === 'independent-copies') {
    const duplicate = await pdf.embedPage(chartPage)
    pdf.addPage([600, 800]).drawPage(duplicate, { x: 50, y: 450, xScale: 1.25, yScale: 1.25 })
  }
  if (kind === 'group') {
    const raw = pdf.context.lookup(embedded.ref) as unknown as { dict: PDFDict }
    raw.dict.set(
      PDFName.of('Group'),
      pdf.context.obj({ S: 'Transparency', CS: 'DeviceRGB', I: true })
    )
  }
  if (kind === 'linked' || kind === 'unrelated-link') {
    first.node.set(
      PDFName.of('Annots'),
      pdf.context.obj([
        pdf.context.register(
          pdf.context.obj({
            Type: 'Annot',
            Subtype: 'Link',
            Rect: kind === 'linked' ? [75, 635, 240, 660] : [75, 200, 240, 225],
            Border: [0, 0, 0],
            A: { S: 'URI', URI: PDFString.of('https://example.org/chart') }
          })
        )
      ])
    )
  }
  if (kind === 'optional-content') {
    const group = pdf.context.register(
      pdf.context.obj({ Type: 'OCG', Name: PDFString.of('Chart labels') })
    )
    pdf.catalog.set(
      PDFName.of('OCProperties'),
      pdf.context.obj({ OCGs: [group], D: { ON: [group], Order: [group] } })
    )
    const raw = pdf.context.lookup(embedded.ref) as unknown as { dict: PDFDict }
    raw.dict.set(PDFName.of('OC'), group)
  }
  if (kind === 'repeated') first.drawPage(embedded, { x: 320, y: 150, xScale: 1.25, yScale: 1.25 })
  if (kind.startsWith('shared')) {
    const second = pdf.addPage([600, 800])
    second.drawPage(embedded, { x: 50, y: 450, xScale: 1.25, yScale: 1.25 })
    if (kind === 'shared-rotated') second.setRotation(degrees(90))
  }
  let data = await pdf.save()
  if (kind === 'nested' || kind === 'shared-nested') {
    const outer = await PDFDocument.create(),
      [page] = await outer.embedPdf(data, [0])
    outer.addPage([600, 800]).drawPage(page, { x: 40, y: 50, xScale: 0.7, yScale: 0.7 })
    if (kind === 'shared-nested')
      outer.addPage([600, 800]).drawPage(page, { x: 40, y: 50, xScale: 0.7, yScale: 0.7 })
    data = await outer.save()
  }
  const caller = lease(),
    original = getDocument({ data: data.slice(), useSystemFonts: true })
  let target: ReturnType<typeof getDocument> | undefined
  try {
    const { source } = await extractPdfTranslationSource({
      document: await original.promise,
      resourceRequestKey: 'nested-chart',
      signal: caller.lease.signal
    })
    let unit = source.units.find(
      (u) => u.source === 'Measured response' && u.fragments[0].pageNumber === 1
    )!
    expect(unit).toBeDefined()
    if (kind === 'font-margin' || kind === 'clipped-glyph') {
      // Renderer fitting space can cross the Form's BBox; only blank font
      // padding may be discarded, never a glyph clipped by the publisher.
      unit = {
        ...unit,
        fragments: unit.fragments.map((fragment) => ({
          ...fragment,
          rect: { ...fragment.rect, height: fragment.rect.height + 12 / 800 }
        }))
      }
    }
    const translations = [
      { ...unit, translation: '测量响应' },
      ...(kind === 'shared-variants'
        ? [
            {
              ...source.units.find(
                (u) => u.source === 'Measured response' && u.fragments[0].pageNumber === 2
              )!,
              translation: '测量结果'
            }
          ]
        : [])
    ]
    const generated = await new PdfTranslationWriter(entry).generateDetailed(
      {
        id: 'nested-chart',
        data,
        pages: source.pages,
        preserveUnsupported: true,
        units: translations
      },
      caller.lease
    )
    expect(generated).not.toBeNull()
    expect(generated!.layoutFailures.map((failure) => failure.unitIndex)).toEqual(
      translated ? [] : translations.map((_, index) => index)
    )
    target = getDocument({ data: generated!.data, useSystemFonts: true })
    const before = await original.promise,
      after = await target.promise,
      text = (await (await after.getPage(1)).getTextContent()).items
        .filter((i) => 'str' in i)
        .map((i) => i.str)
        .join('')
    expect(text).toContain(translated ? '测量响应' : 'Measured response')
    if (translated) expect(text).not.toContain('Measured response')
    const render = async (document: typeof before, number: number): Promise<Buffer> => {
      const page = await document.getPage(number),
        viewport = page.getViewport({ scale: 1 }),
        canvas = createCanvas(viewport.width, viewport.height),
        context = canvas.getContext('2d')
      await page.render({
        canvas: null,
        canvasContext: context as unknown as CanvasRenderingContext2D,
        viewport
      }).promise
      const request = translations.find((u) => u.fragments[0].pageNumber === number)
      if (request && translated) {
        // Ignore only the source label rectangle; every chart pixel and its BBox clipping must survive.
        const r = request.fragments[0].rect
        context.clearRect(
          Math.floor(r.x * viewport.width) - 2,
          Math.floor(r.y * viewport.height) - 2,
          Math.ceil(r.width * viewport.width) + 4,
          Math.ceil(r.height * viewport.height) + 4
        )
      }
      return Buffer.from(context.getImageData(0, 0, canvas.width, canvas.height).data)
    }
    for (let number = 1; number <= before.numPages; number++) {
      const request = translations.find((u) => u.fragments[0].pageNumber === number),
        pageText = (await (await after.getPage(number)).getTextContent()).items
          .filter((i) => 'str' in i)
          .map((i) => i.str)
          .join('')
      expect(pageText).toContain(request && translated ? request.translation : 'Measured response')
      expect((await render(after, number)).equals(await render(before, number))).toBe(true)
      const links = async (document: typeof before): Promise<unknown[]> =>
        (await (await document.getPage(number)).getAnnotations()).map(({ subtype, rect, url }) => ({
          subtype,
          rect,
          url
        }))
      expect(await links(after)).toEqual(await links(before))
    }
  } finally {
    await target?.destroy()
    await original.destroy()
    caller.release()
  }
})

it('reports only the failed label after a Form partially backfills its translated units', async () => {
  const chart = await PDFDocument.create(),
    font = await chart.embedFont(StandardFonts.Helvetica),
    chartPage = chart.addPage([200, 200])
  chartPage.drawText('Measured response', { x: 25, y: 150, size: 12, font })
  chartPage.drawText('Expanded label', { x: 25, y: 100, size: 12, font })
  const pdf = await PDFDocument.create(),
    page = pdf.addPage([600, 800]),
    form = await pdf.embedPage(chartPage)
  page.drawPage(form, { x: 50, y: 450, xScale: 1.25, yScale: 1.25 })
  const data = await pdf.save(),
    caller = lease(),
    original = getDocument({ data: data.slice(), useSystemFonts: true })
  let target: ReturnType<typeof getDocument> | undefined
  try {
    const { source } = await extractPdfTranslationSource({
      document: await original.promise,
      resourceRequestKey: 'partial-form-backfill',
      signal: caller.lease.signal
    })
    const generated = await new PdfTranslationWriter(entry).generateDetailed(
      {
        id: 'partial-form-backfill',
        data,
        pages: source.pages,
        preserveUnsupported: true,
        units: [
          {
            ...source.units.find((unit) => unit.source === 'Measured response')!,
            translation: '测量响应'
          },
          {
            ...source.units.find((unit) => unit.source === 'Expanded label')!,
            translation: '非常长的译文'.repeat(20)
          }
        ]
      },
      caller.lease
    )
    expect(generated).not.toBeNull()
    expect(generated!.layoutFailures).toEqual([
      expect.objectContaining({
        unitIndex: 1,
        code: 'overflow',
        phase: 'planning',
        pageNumbers: [1]
      })
    ])
    target = getDocument({ data: generated!.data, useSystemFonts: true })
    const text = (await (await (await target.promise).getPage(1)).getTextContent()).items
      .filter((item) => 'str' in item)
      .map((item) => item.str)
      .join('')
    expect(text).toContain('测量响应')
    expect(text).not.toContain('Measured response')
    expect(text).toContain('Expanded label')
    expect(text).not.toContain('非常长的译文')
  } finally {
    await target?.destroy()
    await original.destroy()
    caller.release()
  }
})

it.each(
  readPdfTranslationCases<{ name: string; opacity: number; translated: boolean }>(
    'merged-table-row-cell-boundaries.jsonl'
  )
)('$name', async ({ opacity, translated }) => {
  const leaf = await PDFDocument.create(),
    font = await leaf.embedFont(StandardFonts.Helvetica),
    table = leaf.addPage([400, 300])
  table.drawText('Average', { x: 30, y: 180, size: 12, font })
  table.drawText('128', { x: 210, y: 180, size: 12, font })
  table.drawRectangle({ x: 150, y: 140, width: 0.6, height: 90, color: rgb(0, 0, 0), opacity })
  table.drawText('Result', { x: 30, y: 70, size: 12, font })
  const pdf = await PDFDocument.create(),
    embedded = await pdf.embedPage(table)
  pdf.addPage([600, 800]).drawPage(embedded, { x: 40, y: 350 })
  const caller = lease(),
    data = await pdf.save()
  let target: ReturnType<typeof getDocument> | undefined
  try {
    const output = await new PdfTranslationWriter(entry).generate(
      {
        id: 'table-column-rule',
        data,
        pages: [{ width: 600, height: 800 }],
        preserveUnsupported: true,
        units: [
          {
            source: 'Average128',
            translation: '平均值128',
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 70 / 600, y: 250 / 800, width: 220 / 600, height: 25 / 800 }
              }
            ]
          },
          {
            source: 'Result',
            translation: '结果',
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 70 / 600, y: 360 / 800, width: 80 / 600, height: 25 / 800 }
              }
            ]
          }
        ]
      },
      caller.lease
    )
    target = getDocument({ data: output!, useSystemFonts: true })
    const items = (await (await (await target.promise).getPage(1)).getTextContent()).items.filter(
        (i) => 'str' in i
      ),
      text = items
        .map((i) => i.str)
        .join('')
        .replace(/\s/gu, '')
    expect(text).toContain('结果')
    expect(text).toContain(translated ? '平均值128' : 'Average128')
    if (!translated) {
      const number = items.find((i) => i.str === '128')!
      expect(number.transform[4]).toBeCloseTo(250, 2)
      expect(number.transform[5]).toBeCloseTo(530, 2)
    }
  } finally {
    await target?.destroy()
    caller.release()
  }
})

it.each(
  readPdfTranslationCases<{ name: string; rise: number; translation: string }>(
    'raised-degree-table-label.jsonl'
  )
)('$name', async ({ rise, translation }) => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica),
    page = pdf.addPage([612, 792]),
    caller = lease(),
    x = 40 + font.widthOfTextAtSize('Flexion (', 12)
  page.drawText('Flexion (', { font, x: 40, y: 700, size: 12 })
  page.drawText('°', { font, x, y: 700 + rise, size: 8 })
  page.drawText(')', { font, x: x + font.widthOfTextAtSize('°', 8), y: 700, size: 12 })
  let task: ReturnType<typeof getDocument> | undefined
  try {
    const request = new PdfTranslationWriter(entry).generate(
      {
        id: 'raised-degree',
        data: await pdf.save(),
        pages: [{ width: 612, height: 792 }],
        units: [
          {
            source: 'Flexion (°)',
            translation,
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 40 / 612, y: 72 / 792, width: 220 / 612, height: 30 / 792 }
              }
            ]
          }
        ]
      },
      caller.lease
    )
    task = getDocument({ data: (await request)!, useSystemFonts: true })
    const items = (await (await (await task.promise).getPage(1)).getTextContent()).items.filter(
      (item) => 'str' in item
    )
    expect(
      items
        .map((item) => item.str)
        .join('')
        .replace(/\s/gu, '')
    ).toBe(translation)
    for (const item of items.filter((item) => item.str.trim())) {
      expect(item.transform[4]).toBeGreaterThanOrEqual(39.999)
      expect(item.transform[4] + item.width).toBeLessThanOrEqual(260.001)
      expect(item.transform[5]).toBeGreaterThanOrEqual(690)
      expect(item.transform[5]).toBeLessThanOrEqual(720)
    }
  } finally {
    await task?.destroy()
    caller.release()
  }
})

it.each(
  readPdfTranslationCases<{ name: string; translation: string; width: number; height: number }>(
    'cjk-caption-baseline-clearance.jsonl'
  )
)('$name', async ({ translation, width, height }) => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.TimesRoman),
    page = pdf.addPage([612, 792]),
    caller = lease()
  page.drawText('Figure 4: Error rate for the reader', { font, size: 8.9664, x: 108, y: 605.406 })
  page.drawText('model on the evaluation set.', { font, size: 8.9664, x: 108, y: 595.443 })
  let target: ReturnType<typeof getDocument> | undefined
  try {
    const data = await new PdfTranslationWriter(entry).generate(
      {
        id: 'caption-headroom',
        data: await pdf.save(),
        pages: [{ width: 612, height: 792 }],
        units: [
          {
            source: 'Figure 4: Error rate for the reader model on the evaluation set.',
            translation,
            fragments: [
              {
                pageNumber: 1,
                rect: {
                  x: 108 / 612,
                  y: (792 - 613.0274) / 792,
                  width: width / 612,
                  height: height / 792
                }
              }
            ]
          }
        ]
      },
      caller.lease
    )
    target = getDocument({ data: data! })
    const items = (await (await (await target.promise).getPage(1)).getTextContent()).items.filter(
      (item) => 'str' in item
    )
    expect(
      items
        .map((item) => item.str)
        .join('')
        .replace(/\s/gu, '')
    ).toBe(translation.replace(/\s/gu, ''))
    expect(items.filter((item) => item.str.trim()).length).toBeGreaterThan(1)
  } finally {
    await target?.destroy()
    caller.release()
  }
})

it.each([
  { translation: '甲 博士¹†，乙 医学硕士²', valid: true },
  { translation: '甲 博士¹†，乙 医学硕士³', valid: false },
  { translation: '甲 博士¹†，乙 医学硕士', valid: false },
  { translation: '甲 博士¹†，乙 医学硕士²²', valid: false }
])(
  'preserves author footnotes after translated degrees: $translation',
  async ({ translation, valid }) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.TimesRoman),
      page = pdf.addPage([600, 800]),
      caller = lease()
    for (const [index, body] of ['Riley PhD', ', Morgan MM'].entries()) {
      page.drawText(body, { font, size: 12, x: 40, y: 700 - index * 18 })
      page.drawText(index ? '2' : '1†', {
        font,
        size: 7,
        x: 40 + font.widthOfTextAtSize(body, 12),
        y: 705 - index * 18
      })
    }
    try {
      const request = {
        id: 'author-footnotes',
        data: await pdf.save(),
        pages: [{ width: 600, height: 800 }],
        units: [
          {
            source: 'Riley PhD1†, Morgan MM2',
            translation,
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 40 / 600, y: 80 / 800, width: 350 / 600, height: 50 / 800 }
              }
            ]
          }
        ]
      }
      const writer = new PdfTranslationWriter(entry)
      if (!valid) {
        await expect(writer.generate(request, caller.lease)).rejects.toMatchObject({
          failure: { code: 'annotations' }
        })
        return
      }
      const task = getDocument({ data: (await writer.generate(request, caller.lease))! })
      try {
        const items = (
          await (await task.promise).getPage(1).then((p) => p.getTextContent())
        ).items.filter((i) => 'str' in i)
        expect(
          items
            .map((i) => i.str)
            .join('')
            .replace(/\s/gu, '')
        ).toBe(
          translation.replace(/[¹²]/gu, (digit) => digit.normalize('NFKC')).replace(/\s/gu, '')
        )
        for (const label of ['1†', '2'])
          expect(items.find((i) => i.str === label)?.transform[3]).toBe(7)
      } finally {
        await task.destroy()
      }
    } finally {
      caller.release()
    }
  }
)

it.each(['complete', 'clip', 'reflection', 'mismatched-source'] as const)(
  'uses owned native metrics for a complete translated prose link: %s',
  async (kind) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica),
      page = pdf.addPage([600, 800]),
      caller = lease(),
      source = 'Amendments to this paper are available online.',
      translation = '本文勘误现已在线提供。',
      width = font.widthOfTextAtSize(source, 10)
    if (kind === 'clip')
      page.pushOperators(pushGraphicsState(), rectangle(40, 700, 50, 10), clip(), endPath())
    if (kind === 'reflection')
      page.pushOperators(pushGraphicsState(), concatTransformationMatrix(-1, 0, 0, 1, 300, 0))
    page.drawText(source, { font, size: 10, x: 40, y: 700 })
    if (kind === 'clip' || kind === 'reflection') page.pushOperators(popGraphicsState())
    page.node.set(
      PDFName.of('Annots'),
      pdf.context.obj([
        pdf.context.register(
          pdf.context.obj({
            Type: 'Annot',
            Subtype: 'Link',
            Rect: [40, 698, 40 + width, 709],
            A: { S: 'URI', URI: PDFString.of('https://example.org/amendments') }
          })
        )
      ])
    )
    let result: ReturnType<typeof getDocument> | undefined
    try {
      const request = new PdfTranslationWriter(entry).generate(
        {
          id: 'complete-linked-prose',
          data: await pdf.save(),
          pages: [{ width: 600, height: 800 }],
          units: [
            {
              source: kind === 'mismatched-source' ? source.replace('paper', 'book') : source,
              translation,
              fragments: [
                {
                  pageNumber: 1,
                  rect: { x: 35 / 600, y: 85 / 800, width: 280 / 600, height: 30 / 800 }
                }
              ]
            }
          ]
        },
        caller.lease
      )
      if (kind !== 'complete') {
        await expect(request).rejects.toBeInstanceOf(PdfGenerationError)
        return
      }
      result = getDocument({ data: (await request)! })
      const translated = await (await result.promise).getPage(1),
        text = (await translated.getTextContent()).items
          .flatMap((item) => ('str' in item ? [item.str] : []))
          .join('')
          .replace(/\s/gu, ''),
        links = await translated.getAnnotations()
      expect(text).toBe(translation)
      expect(links).toHaveLength(1)
      expect(links[0].url).toBe('https://example.org/amendments')
    } finally {
      await result?.destroy()
      caller.release()
    }
  }
)

it.each(['dense-url', 'oversized-target', 'native-cell-rule'] as const)(
  'fits dense wrapped URL prose without moving native link identity into neighboring ink: %s',
  async (kind) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.TimesRoman),
      page = pdf.addPage([600, 800]),
      caller = lease(),
      url = 'https://example.invalid/demo',
      first = 'All SciPy source code is freely available from the',
      prefix = 'GitHub repository (',
      linkX = 40 + font.widthOfTextAtSize(prefix, 9.3),
      linkWidth = font.widthOfTextAtSize(url, 9.3),
      translation = 'SciPy 库的全部源代码可在 SciPy GitHub 仓库获取：' + url + '。'
    page.drawText(first, { font, size: 9.3, x: 40, y: 700 })
    page.drawText(prefix, { font, size: 9.3, x: 40, y: 689.5 })
    page.drawText(url, { font, size: 9.3, x: linkX, y: 689.5 })
    page.drawText(').', { font, size: 9.3, x: linkX + linkWidth, y: 689.5 })
    if (kind === 'native-cell-rule')
      page.drawRectangle({ x: 150, y: 684, width: 0.6, height: 28, color: rgb(0, 0, 0) })
    page.node.set(
      PDFName.of('Annots'),
      pdf.context.obj([
        pdf.context.register(
          pdf.context.obj({
            Type: 'Annot',
            Subtype: 'Link',
            Rect: [linkX, 686.5146, linkX + linkWidth, 699.0606],
            A: { S: 'URI', URI: PDFString.of(url) }
          })
        )
      ])
    )
    const data = await pdf.save(),
      original = getDocument({ data: data.slice() })
    let result: ReturnType<typeof getDocument> | undefined
    try {
      const request = new PdfTranslationWriter(entry).generate(
        {
          id: 'compact-native-url',
          data,
          pages: [{ width: 600, height: 800 }],
          units: [
            {
              source: first + ' ' + prefix + url + ').',
              translation:
                kind === 'oversized-target' ? translation + '额外内容。'.repeat(30) : translation,
              fragments: [
                {
                  pageNumber: 1,
                  rect: {
                    x: 40 / 600,
                    y: (800 - 707.57) / 800,
                    width: 273.118 / 600,
                    height: 20.73 / 800
                  }
                }
              ]
            }
          ]
        },
        caller.lease
      )
      if (kind !== 'dense-url') {
        await expect(request).rejects.toBeInstanceOf(PdfGenerationError)
        return
      }
      result = getDocument({ data: (await request)! })
      const translated = await (await result.promise).getPage(1),
        items = (await translated.getTextContent()).items.filter((item) => 'str' in item),
        originalItems = (
          await (await (await original.promise).getPage(1)).getTextContent()
        ).items.filter((item) => 'str' in item),
        native = originalItems.find((item) => item.str === url)!,
        kept = items.find((item) => item.str === url)!,
        link = (await translated.getAnnotations())[0]
      expect(
        items
          .map((item) => item.str)
          .join('')
          .replace(/\s/gu, '')
      ).toBe(translation.replace(/\s/gu, ''))
      kept.transform
        .slice(0, 4)
        .forEach((value, index) => expect(value).toBeCloseTo(native.transform[index], 6))
      expect(kept.width).toBeCloseTo(native.width, 3)
      expect(link.url).toBe(url)
      expect(link.rect[2] - link.rect[0]).toBeCloseTo(linkWidth, 3)
      expect(link.rect[3] - link.rect[1]).toBeCloseTo(12.546, 3)
      expect(
        items.every((item) => Math.hypot(item.transform[0], item.transform[1]) >= 8 - 0.001)
      ).toBe(true)
    } finally {
      await result?.destroy()
      await original.destroy()
      caller.release()
    }
  }
)

it.each([
  { glyph: '-', unicode: '2011', valid: true },
  { glyph: '-', unicode: '2010', valid: true },
  { glyph: 'A', unicode: '2011', valid: false },
  { glyph: '-', unicode: '2212', valid: false },
  { glyph: '-', unicode: '0002', valid: false }
])(
  'proves publisher hyphens from the exact native font glyph: $glyph / $unicode',
  async ({ glyph, unicode, valid }) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica),
      symbol = await pdf.embedFont(StandardFonts.TimesRoman),
      page = pdf.addPage([600, 800]),
      caller = lease()
    page.drawText('Opioid', { font, size: 12, x: 40, y: 700 })
    page.drawText(glyph, { font: symbol, size: 12, x: 75, y: 700 })
    page.drawText('free trial.', { font, size: 12, x: 84, y: 700 })
    await pdf.flush()
    pdf.context
      .lookup(symbol.ref, PDFDict)
      .set(
        PDFName.of('ToUnicode'),
        pdf.context.register(
          pdf.context.stream(
            '/CIDInit /ProcSet findresource begin\n12 dict begin begincmap\n' +
              '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n' +
              '/CMapName /HyphenMap def /CMapType 2 def\n' +
              '1 begincodespacerange <00> <FF> endcodespacerange\n' +
              '1 beginbfchar <' +
              glyph.charCodeAt(0).toString(16) +
              '> <' +
              unicode +
              '> endbfchar\n' +
              'endcmap CMapName currentdict /CMap defineresource pop end end'
          )
        )
      )
    let result: ReturnType<typeof getDocument> | undefined
    try {
      const request = new PdfTranslationWriter(entry).generate(
        {
          id: 'native-typographic-hyphen',
          data: await pdf.save(),
          pages: [{ width: 600, height: 800 }],
          preserveUnsupported: true,
          units: [
            {
              source: 'Opioid-free trial.',
              translation: '无阿片类药物试验。',
              fragments: [
                {
                  pageNumber: 1,
                  rect: { x: 38 / 600, y: 84 / 800, width: 180 / 600, height: 24 / 800 }
                }
              ]
            }
          ]
        },
        caller.lease
      )
      if (!valid) {
        await expect(request).rejects.toMatchObject({ failure: { code: 'source-mismatch' } })
        return
      }
      result = getDocument({ data: (await request)! })
      const items = (await (await (await result.promise).getPage(1)).getTextContent()).items
      expect(
        items
          .flatMap((item) => ('str' in item ? [item.str] : []))
          .join('')
          .replace(/\s/gu, '')
      ).toBe('无阿片类药物试验。')
    } finally {
      await result?.destroy()
      caller.release()
    }
  }
)

it.each([
  { jitter: 0.03, leading: 14, accepted: true },
  { jitter: 0.08, leading: 14, accepted: true },
  { jitter: 0.2, leading: 14, accepted: false },
  { jitter: 0, leading: 9, accepted: false }
])(
  'checks the full ink envelope of subpixel native body rows: $jitter / $leading',
  async ({ jitter, leading, accepted }) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.TimesRoman),
      page = pdf.addPage([600, 800]),
      caller = lease(),
      prefix = 'This method evaluates the response ',
      suffix = 'measured precisely.',
      second = 'The measurements are compared with the baseline.',
      third = 'The complete result is described in report [',
      linkX = 46 + font.widthOfTextAtSize(third, 10),
      linkY = 700 - 2 * leading
    page.drawText(prefix, { font, size: 10, x: 40, y: 700 })
    page.drawText(suffix, {
      font,
      size: 10,
      x: 40 + font.widthOfTextAtSize(prefix, 10),
      y: 700 + jitter
    })
    page.drawText(second, { font, size: 10, x: 40, y: 700 - leading })
    page.drawText(third, { font, size: 10, x: 40, y: linkY })
    page.drawText('1', { font, size: 10, x: linkX, y: linkY })
    page.drawText(']', { font, size: 10, x: linkX + font.widthOfTextAtSize('1', 10) + 6, y: linkY })
    page.node.set(
      PDFName.of('Annots'),
      pdf.context.obj([
        pdf.context.register(
          pdf.context.obj({
            Type: 'Annot',
            Subtype: 'Link',
            Rect: [linkX, linkY - 2, linkX + font.widthOfTextAtSize('1', 10), linkY + 9],
            A: { S: 'URI', URI: PDFString.of('https://example.org/response/1') }
          })
        )
      ])
    )
    let result: ReturnType<typeof getDocument> | undefined
    try {
      const request = new PdfTranslationWriter(entry).generate(
        {
          id: 'subpixel-body-rows',
          data: await pdf.save(),
          pages: [{ width: 600, height: 800 }],
          units: [
            {
              source: prefix + suffix + ' ' + second + ' ' + third + '1]',
              translation: '测量结果见报告[1]',
              fragments: [
                {
                  pageNumber: 1,
                  rect: { x: 38 / 600, y: 84 / 800, width: 350 / 600, height: 80 / 800 }
                }
              ]
            }
          ]
        },
        caller.lease
      )
      if (!accepted) {
        await expect(request).rejects.toMatchObject({ failure: { code: 'annotations' } })
        return
      }
      result = getDocument({ data: (await request)! })
      const translated = await (await result.promise).getPage(1)
      expect(
        (await translated.getTextContent()).items
          .flatMap((item) => ('str' in item ? [item.str] : []))
          .join('')
          .replace(/\s/gu, '')
      ).toBe('测量结果见报告[1]')
      expect((await translated.getAnnotations())[0].url).toBe('https://example.org/response/1')
    } finally {
      await result?.destroy()
      caller.release()
    }
  }
)

it.each(['nonzero-character-box', 'painted-hyphen', 'unknown-control', 'merged-letter'] as const)(
  'requires complete native zero ink for a positioning soft-hyphen object: %s',
  async (kind) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica),
      positioning = await pdf.embedFont(StandardFonts.TimesRoman),
      page = pdf.addPage([600, 800]),
      caller = lease()
    page.drawText('Measured value', { font, size: 12, x: 40, y: 700 })
    page.drawText('AB', { font: positioning, size: 12, x: 130, y: 700 })
    page.drawText('is available.', { font, size: 12, x: 150, y: 700 })
    await pdf.flush()
    const dict = pdf.context.lookup(positioning.ref, PDFDict)
    dict.set(
      PDFName.of('Encoding'),
      pdf.context.obj({
        Type: 'Encoding',
        BaseEncoding: 'WinAnsiEncoding',
        Differences: [
          65,
          kind === 'merged-letter' ? 'A' : 'space',
          66,
          kind === 'painted-hyphen' ? 'hyphen' : 'space'
        ]
      })
    )
    dict.set(
      PDFName.of('ToUnicode'),
      pdf.context.register(
        pdf.context.stream(
          '/CIDInit /ProcSet findresource begin\n12 dict begin begincmap\n' +
            '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n' +
            '/CMapName /PositioningMap def /CMapType 2 def\n' +
            '1 begincodespacerange <00> <FF> endcodespacerange\n' +
            '2 beginbfchar <41> <' +
            (kind === 'merged-letter' ? '0041' : '2009') +
            '> <42> <' +
            (kind === 'unknown-control' ? '0002' : '00ad') +
            '> endbfchar\n' +
            'endcmap CMapName currentdict /CMap defineresource pop end end'
        )
      )
    )
    try {
      const request = new PdfTranslationWriter(entry).generate(
        {
          id: 'zero-ink-positioning-space',
          data: await pdf.save(),
          pages: [{ width: 600, height: 800 }],
          preserveUnsupported: true,
          units: [
            {
              source: 'Measured value is available.',
              translation: '测量值已提供。',
              fragments: [
                {
                  pageNumber: 1,
                  rect: { x: 38 / 600, y: 84 / 800, width: 250 / 600, height: 24 / 800 }
                }
              ]
            }
          ]
        },
        caller.lease
      )
      await expect(request).rejects.toMatchObject({ failure: { code: 'source-mismatch' } })
    } finally {
      caller.release()
    }
  }
)

it.each([
  { translation: '2020年10月完成复核，结果参见［10，11］。', accepted: true },
  { translation: '2020年10月完成复核，结果参见[10, 11]。', accepted: true },
  { translation: '2020年10月完成复核，结果参见［10，12］。', accepted: false },
  { translation: '2020年10月完成复核，结果参见［11，10］。', accepted: false },
  { translation: '2020年10月完成复核，结果参见［10，11］和［10，11］。', accepted: false },
  {
    translation: '2020年10月完成复核，结果参见［10，11］和［10，11］。',
    accepted: true,
    repeat: true
  },
  { translation: '2020年10月完成复核，结果参见［10，11］。', accepted: false, repeat: true }
])(
  'preserves native links only in their complete numeric citation block: $translation',
  async ({ translation, accepted, repeat = false }) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.TimesRoman),
      page = pdf.addPage([600, 800]),
      first = 'In October 2020 the measurements were reviewed.',
      prefix = 'The findings are cited in [',
      firstX = 46 + font.widthOfTextAtSize(prefix, 10),
      secondX = firstX + font.widthOfTextAtSize('10', 10) + 6 + font.widthOfTextAtSize(',', 10) + 6,
      caller = lease()
    page.drawText(first, { font, size: 10, x: 40, y: 700 })
    page.drawText(prefix, { font, size: 10, x: 40, y: 686 })
    page.drawText('10', { font, size: 10, x: firstX, y: 686 })
    page.drawText(',', { font, size: 10, x: firstX + font.widthOfTextAtSize('10', 10) + 6, y: 686 })
    page.drawText('11', { font, size: 10, x: secondX, y: 686 })
    page.drawText('].', {
      font,
      size: 10,
      x: secondX + font.widthOfTextAtSize('11', 10) + 6,
      y: 686
    })
    if (repeat) {
      page.drawText(prefix, { font, size: 10, x: 40, y: 672 })
      page.drawText('10', { font, size: 10, x: firstX, y: 672 })
      page.drawText(',', {
        font,
        size: 10,
        x: firstX + font.widthOfTextAtSize('10', 10) + 6,
        y: 672
      })
      page.drawText('11', { font, size: 10, x: secondX, y: 672 })
      page.drawText('].', {
        font,
        size: 10,
        x: secondX + font.widthOfTextAtSize('11', 10) + 6,
        y: 672
      })
    }
    page.node.set(
      PDFName.of('Annots'),
      pdf.context.obj(
        (repeat ? [686, 672] : [686]).flatMap((y) =>
          [
            ['10', firstX],
            ['11', secondX]
          ].map(([label, x]) =>
            pdf.context.register(
              pdf.context.obj({
                Type: 'Annot',
                Subtype: 'Link',
                Rect: [x, y - 2, Number(x) + font.widthOfTextAtSize(String(label), 10), y + 9],
                A: { S: 'URI', URI: PDFString.of('https://example.org/reference/' + label) }
              })
            )
          )
        )
      )
    )
    let original: ReturnType<typeof getDocument> | undefined,
      output: ReturnType<typeof getDocument> | undefined
    try {
      const data = await pdf.save(),
        generation = new PdfTranslationWriter(entry).generate(
          {
            id: 'closed-native-citation',
            data,
            pages: [{ width: 600, height: 800 }],
            units: [
              {
                source:
                  first + ' ' + prefix + '10, 11].' + (repeat ? ' ' + prefix + '10, 11].' : ''),
                translation,
                fragments: [
                  {
                    pageNumber: 1,
                    rect: { x: 38 / 600, y: 84 / 800, width: 350 / 600, height: 55 / 800 }
                  }
                ]
              }
            ]
          },
          caller.lease
        )
      if (!accepted) {
        await expect(generation).rejects.toMatchObject({ failure: { code: 'annotations' } })
        return
      }
      original = getDocument({ data: data.slice() })
      output = getDocument({ data: (await generation)! })
      const target = await (await output.promise).getPage(1),
        items = (await target.getTextContent()).items.filter((item) => 'str' in item),
        sourceItems = (
          await (await (await original.promise).getPage(1)).getTextContent()
        ).items.filter((item) => 'str' in item)
      expect(
        items
          .map((item) => item.str)
          .join('')
          .replace(/\s/gu, '')
      ).toBe(translation.replace(/\s/gu, ''))
      const links = await target.getAnnotations()
      expect(links.map((link) => link.url)).toEqual(
        (repeat ? [1, 2] : [1]).flatMap(() => [
          'https://example.org/reference/10',
          'https://example.org/reference/11'
        ])
      )
      for (const label of ['10', '11']) {
        const native = items.find((item) => item.str === label)!,
          source = sourceItems.find((item) => item.str === label)!,
          link = links.find((link) => link.url.endsWith('/' + label))!
        expect(native.transform.slice(0, 4)).toEqual(source.transform.slice(0, 4))
        expect(native.width).toBeCloseTo(source.width, 4)
        expect(native.transform[4]).toBeGreaterThanOrEqual(link.rect[0] - 0.1)
        expect(native.transform[4] + native.width).toBeLessThanOrEqual(link.rect[2] + 0.1)
      }
    } finally {
      await output?.destroy()
      await original?.destroy()
      caller.release()
    }
  }
)

it.each([
  { jitter: 0.03, rise: 4, leading: 14, valid: true },
  { jitter: 0.08, rise: 4, leading: 14, valid: true },
  { jitter: 0.03, rise: 0.5, leading: 14, valid: false },
  { jitter: 0.2, rise: 4, leading: 14, valid: false },
  { jitter: 0.03, rise: 4, leading: 9, valid: false }
])(
  'keeps proven signed powers out of native body row clustering: $jitter / $rise / $leading',
  async ({ jitter, rise, leading, valid }) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.TimesRoman),
      page = pdf.addPage([600, 800]),
      caller = lease(),
      prefix = 'The learning rate is ',
      suffix = '10',
      x = 40 + font.widthOfTextAtSize(prefix, 10),
      exponentX = x + font.widthOfTextAtSize(suffix, 10),
      firstTail = ' during training.',
      second = 'The measured result remains stable.',
      third = 'The reference is [',
      linkX = 46 + font.widthOfTextAtSize(third, 10),
      linkY = 700 - 2 * leading,
      translation = '训练期间学习率为10^(-3)，测量结果保持稳定，参见［1］。'
    page.drawText(prefix, { font, size: 10, x: 40, y: 700 })
    page.drawText(suffix, { font, size: 10, x, y: 700 + jitter })
    page.drawText('-3', { font, size: 7, x: exponentX, y: 700 + rise })
    page.drawText(firstTail, {
      font,
      size: 10,
      x: exponentX + font.widthOfTextAtSize('-3', 7),
      y: 700
    })
    page.drawText(second, { font, size: 10, x: 40, y: 700 - leading })
    page.drawText(third, { font, size: 10, x: 40, y: linkY })
    page.drawText('1', { font, size: 10, x: linkX, y: linkY })
    page.drawText(']', { font, size: 10, x: linkX + font.widthOfTextAtSize('1', 10) + 6, y: linkY })
    page.node.set(
      PDFName.of('Annots'),
      pdf.context.obj([
        pdf.context.register(
          pdf.context.obj({
            Type: 'Annot',
            Subtype: 'Link',
            Rect: [linkX, linkY - 2, linkX + font.widthOfTextAtSize('1', 10), linkY + 9],
            A: { S: 'URI', URI: PDFString.of('https://example.org/power-proof/1') }
          })
        )
      ])
    )
    let task: ReturnType<typeof getDocument> | undefined
    try {
      const request = new PdfTranslationWriter(entry).generate(
        {
          id: 'power-body-admission',
          data: await pdf.save(),
          pages: [{ width: 600, height: 800 }],
          units: [
            {
              source: prefix + suffix + '⁻³' + firstTail + ' ' + second + ' ' + third + '1]',
              translation,
              fragments: [
                {
                  pageNumber: 1,
                  rect: { x: 38 / 600, y: 82 / 800, width: 350 / 600, height: 80 / 800 }
                }
              ]
            }
          ]
        },
        caller.lease
      )
      if (!valid) {
        await expect(request).rejects.toMatchObject({ failure: { code: 'annotations' } })
        return
      }
      task = getDocument({ data: (await request)! })
      const items = (await (await (await task.promise).getPage(1)).getTextContent()).items.filter(
        (item) => 'str' in item
      )
      expect(
        items
          .map((item) => item.str)
          .join('')
          .replace(/\s/gu, '')
      ).toBe(translation)
      expect(items.filter((item) => item.str.trim()).every((item) => item.transform[3] >= 8)).toBe(
        true
      )
    } finally {
      await task?.destroy()
      caller.release()
    }
  }
)

it.each([
  { name: 'adjacent owned rows', leading: 14, aligned: true, obstacle: false },
  { name: 'rows separated by a paragraph gap', leading: 30, aligned: true, obstacle: false },
  {
    name: 'rows with different column boundaries',
    leading: 14,
    aligned: false,
    obstacle: false
  },
  { name: 'rows separated by a native rule', leading: 14, aligned: true, obstacle: true }
])('reflows a wrapped citation only across $name', async ({ leading, aligned, obstacle }) => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.TimesRoman),
    page = pdf.addPage([600, 800]),
    caller = lease(),
    annotations = [],
    prefix = 'Previous work (',
    labels = ['Author and', 'Colleague, 2020'],
    tail = ') reports useful results.',
    continuation = 'The observations remain stable.',
    translation = '此前研究（Author and Colleague, 2020）报告了有用的结果。观察结果保持稳定。'
  page.drawText(prefix, { font, size: 12, x: 40, y: 700 })
  for (const [index, label] of labels.entries()) {
    const x = index ? 40 : 40 + font.widthOfTextAtSize(prefix, 12),
      y = 700 - index * leading,
      width = font.widthOfTextAtSize(label, 12)
    page.drawText(label, { font, size: 12, x, y })
    annotations.push(
      pdf.context.register(
        pdf.context.obj({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: [x - 0.1, y - 2.5, x + width + 0.1, y + 8.5],
          Border: [0, 0, 0],
          A: { S: 'URI', URI: PDFString.of('https://example.org/reference/2020') }
        })
      )
    )
  }
  page.drawText(tail, {
    font,
    size: 12,
    x: 40 + font.widthOfTextAtSize(labels[1], 12),
    y: 700 - leading
  })
  page.drawText(continuation, { font, size: 12, x: 330, y: 700 })
  if (obstacle)
    page.drawLine({ start: { x: 40, y: 695.5 }, end: { x: 265, y: 695.5 }, thickness: 0.2 })
  page.node.set(PDFName.of('Annots'), pdf.context.obj(annotations))
  let task: ReturnType<typeof getDocument> | undefined
  try {
    const output = await new PdfTranslationWriter(entry).generateDetailed(
      {
        id: 'wrapped-citation-owned-rows',
        data: await pdf.save(),
        preserveUnsupported: true,
        pages: [{ width: 600, height: 800 }],
        units: [
          {
            source: prefix + labels.join(' ') + tail + ' ' + continuation,
            translation,
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 40 / 600, y: 91 / 800, width: 225 / 600, height: 13 / 800 }
              },
              {
                pageNumber: 1,
                rect: {
                  x: 40 / 600,
                  y: (91 + leading) / 800,
                  width: (aligned ? 225 : 215) / 600,
                  height: 13 / 800
                }
              },
              {
                pageNumber: 1,
                rect: { x: 330 / 600, y: 91 / 800, width: 225 / 600, height: 13 / 800 }
              }
            ]
          }
        ]
      },
      caller.lease
    )
    expect(output!.layoutFailures).toHaveLength(0)
    task = getDocument({ data: output!.data, useSystemFonts: true })
    const outputPage = await (await task.promise).getPage(1),
      text = (await outputPage.getTextContent()).items
        .flatMap((item) => ('str' in item ? [item.str] : []))
        .join('')
        .replace(/\s/gu, '')
    expect(text).toBe(translation.replace(/\s/gu, ''))
    const links = await outputPage.getAnnotations()
    // Only continuous adjacent rows can compact the wrapped citation to one line.
    // A real paragraph gap or different column boundary keeps each link in its row.
    expect(links[0].rect[1] - links[1].rect[1]).toBeCloseTo(
      leading === 14 && aligned && !obstacle ? 0 : leading,
      2
    )
    expect(links.map((link) => link.url)).toEqual(
      labels.map(() => 'https://example.org/reference/2020')
    )
    // Reflow stays within the left-column ownership envelope; no link crosses the gutter.
    expect(links.every((link) => link.rect[0] >= 39.5 && link.rect[2] <= 265.5)).toBe(true)
  } finally {
    await task?.destroy()
    caller.release()
  }
})

it.each(['empty', 'text', 'rule', 'link'] as const)(
  'uses a short final row only when the additional column space is empty: %s',
  async (obstacle) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.TimesRoman),
      page = pdf.addPage([600, 800]),
      caller = lease(),
      labels = ['Author and', 'Colleague, 2020'],
      prefix = 'Previous work (',
      tail = ') reports useful results.',
      translation = '我们重新核实了此前研究（Author and Colleague, 2020）的结果。',
      annotations = []
    page.drawText(prefix, { font, size: 12, x: 40, y: 700 })
    for (const [index, label] of labels.entries()) {
      const x = index ? 40 : 40 + font.widthOfTextAtSize(prefix, 12),
        y = 700 - index * 14
      page.drawText(label, { font, size: 12, x, y })
      annotations.push(
        pdf.context.register(
          pdf.context.obj({
            Type: 'Annot',
            Subtype: 'Link',
            Rect: [x - 0.1, y - 2.5, x + font.widthOfTextAtSize(label, 12) + 0.1, y + 8.5],
            Border: [0, 0, 0],
            A: { S: 'URI', URI: PDFString.of('https://example.org/reference/2020') }
          })
        )
      )
    }
    page.drawText(tail, { font, size: 12, x: 40 + font.widthOfTextAtSize(labels[1], 12), y: 686 })
    if (obstacle === 'text') page.drawText('X', { font, size: 8, x: 258, y: 686 })
    if (obstacle === 'rule')
      page.drawLine({ start: { x: 258, y: 685 }, end: { x: 263, y: 690 }, thickness: 0.2 })
    if (obstacle === 'link')
      annotations.push(
        pdf.context.register(
          pdf.context.obj({
            Type: 'Annot',
            Subtype: 'Link',
            Rect: [258, 684, 263, 692],
            Border: [0, 0, 0]
          })
        )
      )
    page.node.set(PDFName.of('Annots'), pdf.context.obj(annotations))
    let target: ReturnType<typeof getDocument> | undefined
    try {
      const output = await new PdfTranslationWriter(entry).generateDetailed(
        {
          id: 'short-owned-tail',
          data: await pdf.save(),
          preserveUnsupported: true,
          pages: [{ width: 600, height: 800 }],
          units: [
            {
              source: prefix + labels.join(' ') + tail,
              translation,
              fragments: [
                {
                  pageNumber: 1,
                  rect: { x: 40 / 600, y: 91 / 800, width: 300 / 600, height: 13 / 800 }
                },
                {
                  pageNumber: 1,
                  rect: { x: 40 / 600, y: 105 / 800, width: 215 / 600, height: 13 / 800 }
                }
              ]
            }
          ]
        },
        caller.lease
      )
      expect(output!.layoutFailures).toHaveLength(0)
      target = getDocument({ data: output!.data, useSystemFonts: true })
      const outputPage = await (await target.promise).getPage(1),
        links = await outputPage.getAnnotations(),
        text = (await outputPage.getTextContent()).items
          .flatMap((item) => ('str' in item ? [item.str] : []))
          .join('')
          .replace(/\s/gu, '')
      expect(text).toBe(translation.replace(/\s/gu, '') + (obstacle === 'text' ? 'X' : ''))
      expect(links[0].rect[1] - links[1].rect[1]).toBeCloseTo(obstacle === 'empty' ? 0 : 14, 2)
      if (obstacle === 'link') expect(links[2].rect).toEqual([258, 684, 263, 692])
    } finally {
      await target?.destroy()
      caller.release()
    }
  }
)

it.each([
  { jitter: 0.055, changed: false, retained: false },
  { jitter: 0.25, changed: false, retained: true },
  { jitter: 1.5, changed: false, retained: true },
  { jitter: 0.055, changed: true, retained: true }
])(
  'keeps native citation row geometry across engine whitespace (jitter $jitter, changed $changed)',
  async ({ jitter, changed, retained }) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.TimesRoman),
      page = pdf.addPage([600, 800]),
      caller = lease(),
      label = 'J´ozefowicz et al.',
      source = `See ${label}${changed ? ` and ${label}` : ''} confirms.`,
      translation = `相关研究的详细方法见 ${changed ? `Kowalski et al.，以及 ${label}` : label}，结论得到确认。`,
      annotations = []
    let x = 40
    page.drawText('See ', { font, size: 12, x, y: 700 })
    x += font.widthOfTextAtSize('See ', 12)
    for (let index = 0; index < (changed ? 2 : 1); index++) {
      const left = x
      page.drawText('J', { font, size: 12, x, y: 700 })
      x += font.widthOfTextAtSize('J', 12)
      // A publisher's independently painted accent can have a positioning
      // space and a small baseline correction, while PDF.js omits that space.
      page.drawText('´ ', { font, size: 12, x: x + 1, y: 700 + jitter })
      page.drawText('ozefowicz et al.', { font, size: 12, x, y: 700 })
      x += font.widthOfTextAtSize('ozefowicz et al.', 12)
      annotations.push(
        pdf.context.register(
          pdf.context.obj({
            Type: 'Annot',
            Subtype: 'Link',
            Rect: [left, 697, x, 711],
            Border: [0, 0, 0],
            A: { S: 'URI', URI: PDFString.of(`https://example.org/reference/${index}`) }
          })
        )
      )
      const suffix = changed && index === 0 ? ' and ' : ' confirms.'
      page.drawText(suffix, { font, size: 12, x, y: 700 })
      x += font.widthOfTextAtSize(suffix, 12)
    }
    page.node.set(PDFName.of('Annots'), pdf.context.obj(annotations))
    const data = await pdf.save(),
      original = getDocument({ data: data.slice(), useSystemFonts: true })
    let target: ReturnType<typeof getDocument> | undefined
    try {
      const result = await new PdfTranslationWriter(entry).generateDetailed(
        {
          id: 'native-citation-row-whitespace',
          data,
          pages: [{ width: 600, height: 800 }],
          preserveUnsupported: true,
          units: [
            {
              source,
              translation,
              fragments: [
                {
                  pageNumber: 1,
                  rect: { x: 40 / 600, y: 80 / 800, width: 470 / 600, height: 80 / 800 }
                }
              ]
            }
          ]
        },
        caller.lease
      )
      expect(result!.layoutFailures).toHaveLength(retained ? 1 : 0)
      if (retained)
        expect(result!.layoutFailures[0].code).toBe(changed ? 'annotations' : 'overflow')
      target = getDocument({ data: result!.data.slice(), useSystemFonts: true })
      const before = await (await original.promise).getPage(1),
        after = await (await target.promise).getPage(1),
        beforeItems = (await before.getTextContent()).items.filter(
          (item): item is import('pdfjs-dist/types/src/display/api').TextItem => 'str' in item
        ),
        afterItems = (await after.getTextContent()).items.filter(
          (item): item is import('pdfjs-dist/types/src/display/api').TextItem => 'str' in item
        ),
        text = afterItems
          .map((item) => item.str)
          .join('')
          .replace(/\s/gu, ''),
        beforeLinks = await before.getAnnotations(),
        afterLinks = await after.getAnnotations()
      expect(text).toBe((retained ? source : translation).replace(/\s/gu, ''))
      expect(afterLinks.map((link) => link.url)).toEqual(beforeLinks.map((link) => link.url))
      for (const [index, link] of afterLinks.entries()) {
        expect(link.rect[2] - link.rect[0]).toBeCloseTo(
          beforeLinks[index].rect[2] - beforeLinks[index].rect[0],
          3
        )
        expect(link.rect[3] - link.rect[1]).toBeCloseTo(
          beforeLinks[index].rect[3] - beforeLinks[index].rect[1],
          3
        )
      }
      if (!retained) {
        // Preserve the native accent correction, rather than flattening its
        // baseline or redrawing a visually different author identity.
        const accents = (items: typeof beforeItems): typeof beforeItems =>
          items.filter((item) => item.str.includes('´'))
        const beforeAccents = accents(beforeItems),
          afterAccents = accents(afterItems)
        expect(afterAccents).toHaveLength(beforeAccents.length)
        afterAccents.forEach((accent, index) => {
          expect(accent.transform[3]).toBeCloseTo(beforeAccents[index].transform[3], 3)
          expect(accent.transform[5] - afterLinks[index].rect[1]).toBeCloseTo(
            beforeAccents[index].transform[5] - beforeLinks[index].rect[1],
            3
          )
        })
        for (const item of afterItems) {
          expect(item.transform[4]).toBeGreaterThanOrEqual(40 - 0.01)
          expect(item.transform[4] + item.width).toBeLessThanOrEqual(510 + 0.01)
          expect(item.transform[5]).toBeGreaterThanOrEqual(640 - 0.01)
          expect(item.transform[5]).toBeLessThanOrEqual(720 + 0.01)
        }
      }
    } finally {
      await target?.destroy()
      await original.destroy()
      caller.release()
    }
  }
)

it('preserves partial-object citation links when the native label uses NBSP', async () => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.TimesRoman),
    page = pdf.addPage([600, 800]),
    caller = lease(),
    native = 'See Table\u00a01 confirms.',
    source = 'See Table 1 confirms.',
    translation = '上述结果见表1，结论得到确认。',
    left = 40 + font.widthOfTextAtSize('See ', 12)
  page.drawText(native, { font, size: 12, x: 40, y: 700 })
  page.node.set(
    PDFName.of('Annots'),
    pdf.context.obj([
      pdf.context.register(
        pdf.context.obj({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: [left, 697, left + font.widthOfTextAtSize('Table\u00a01', 12), 711],
          Border: [0, 0, 0],
          A: { S: 'URI', URI: PDFString.of('https://example.org/table/1') }
        })
      )
    ])
  )
  let target: ReturnType<typeof getDocument> | undefined
  try {
    const result = await new PdfTranslationWriter(entry).generateDetailed(
      {
        id: 'partial-native-nbsp-link',
        data: await pdf.save(),
        pages: [{ width: 600, height: 800 }],
        preserveUnsupported: true,
        units: [
          {
            source,
            translation,
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 40 / 600, y: 80 / 800, width: 470 / 600, height: 80 / 800 }
              }
            ]
          }
        ]
      },
      caller.lease
    )
    expect(result!.layoutFailures).toEqual([])
    target = getDocument({ data: result!.data.slice(), useSystemFonts: true })
    const written = await (await target.promise).getPage(1),
      text = (await written.getTextContent()).items
        .flatMap((item) => ('str' in item ? [item.str] : []))
        .join('')
        .replace(/\s/gu, '')
    expect(text).toBe(translation)
    expect((await written.getAnnotations()).map((link) => link.url)).toEqual([
      'https://example.org/table/1'
    ])
  } finally {
    await target?.destroy()
    caller.release()
  }
})

it.each([
  'clause',
  'whitespace',
  'same-column',
  'narrow-tail',
  'no-script',
  'raised-script',
  'native-anchor'
] as const)(
  'balances a right-column short tail without moving a preceding script (%s)',
  async (kind) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica),
      page = pdf.addPage([612, 792]),
      caller = lease(),
      left = 'A statement discusses token',
      middle = 't',
      lowered = kind !== 'raised-script',
      point = kind === 'no-script' ? 12 : 8.4,
      x = 40 + font.widthOfTextAtSize(middle, 12),
      rightX = kind === 'same-column' ? 40 : 320,
      translation =
        '甲'.repeat(24) +
        'tk' +
        (kind === 'native-anchor' ? '[1]' : '') +
        (kind === 'whitespace' ? '， ' : '，') +
        '乙'.repeat(10) +
        '丙'
    page.drawText(left, { font, size: 12, x: 40, y: 100 })
    page.drawText(middle, { font, size: 12, x: 40, y: 86 })
    page.drawText('k', {
      font,
      size: point,
      x,
      y: 86 + (kind === 'no-script' ? 0 : lowered ? -1.8 : 1.8)
    })
    let restX = x + font.widthOfTextAtSize('k', point)
    if (kind === 'native-anchor') {
      const width = font.widthOfTextAtSize('[1]', 12)
      page.drawText('[1]', { font, size: 12, x: restX, y: 86 })
      page.node.set(
        PDFName.of('Annots'),
        pdf.context.obj([
          pdf.context.register(
            pdf.context.obj({
              Type: 'Annot',
              Subtype: 'Link',
              Rect: [restX - 0.1, 83, restX + width + 0.1, 97],
              Border: [0, 0, 0],
              A: { S: 'URI', URI: PDFString.of('https://example.org/anchor') }
            })
          )
        ])
      )
      restX += width
    }
    page.drawText(' and gives a final', { font, size: 12, x: restX, y: 86 })
    page.drawText('set.', { font, size: 12, x: rightX, y: 700 })
    page.drawText('Unrelated text.', { font, size: 12, x: 320, y: 650 })
    const input: PdfTranslationPdfRequest = {
      id: 'column-tail-script',
      data: await pdf.save(),
      pages: [{ width: 612, height: 792 }],
      units: [
        {
          source:
            left + ' tk' + (kind === 'native-anchor' ? '[1]' : '') + ' and gives a final set.',
          translation,
          fragments: [
            {
              pageNumber: 1,
              rect: { x: 40 / 612, y: 680 / 792, width: 205 / 612, height: 33 / 792 }
            },
            {
              pageNumber: 1,
              rect: {
                x: rightX / 612,
                y: 80 / 792,
                width: (kind === 'narrow-tail' ? 100 : 205) / 612,
                height: 20 / 792
              }
            }
          ]
        }
      ]
    }
    const snapshots: unknown[] = []
    try {
      for (let attempt = 0; attempt < (kind === 'clause' ? 2 : 1); attempt++) {
        const output = await new PdfTranslationWriter(entry).generate(input, caller.lease),
          task = getDocument({ data: output!, useSystemFonts: true })
        try {
          const doc = await task.promise,
            pg = await doc.getPage(1),
            items = (await pg.getTextContent()).items.filter((i) => 'str' in i),
            head = items.filter((i) => i.transform[5] < 120),
            tail = items.filter((i) => i.transform[5] > 680),
            headText = head.map((i) => i.str).join(''),
            tailText = tail.map((i) => i.str).join('')
          expect((headText + tailText).replace(/\s/gu, '')).toBe(translation.replace(/\s/gu, ''))
          const moved = kind === 'clause' || kind === 'whitespace'
          if (moved) expect(tailText.trim()).toBe('乙'.repeat(10) + '丙')
          else expect(tailText.length).toBeLessThan(8)
          if (kind !== 'no-script') {
            const script = head.find((i) => i.str === 'k')!,
              base = head[head.indexOf(script) - 1]
            expect(script).toBeDefined()
            expect(Math.hypot(script.transform[2], script.transform[3])).toBeCloseTo(8.4, 3)
            expect(script.transform[5] - base.transform[5]).toBeCloseTo(lowered ? -1.8 : 1.8, 3)
          }
          for (const item of tail) {
            expect(item.transform[4]).toBeGreaterThanOrEqual(rightX - 0.001)
            expect(item.transform[4] + item.width).toBeLessThanOrEqual(
              rightX + (kind === 'narrow-tail' ? 100 : 205) + 0.001
            )
          }
          expect(items.map((i) => i.str).join('')).toContain('Unrelated text.')
          if (kind === 'native-anchor')
            expect(await pg.getAnnotations()).toMatchObject([{ url: 'https://example.org/anchor' }])
          snapshots.push(items.map((i) => ({ text: i.str, transform: i.transform })))
        } finally {
          await task.destroy()
        }
      }
      if (snapshots.length === 2) expect(snapshots[1]).toEqual(snapshots[0])
    } finally {
      caller.release()
    }
  }
)
