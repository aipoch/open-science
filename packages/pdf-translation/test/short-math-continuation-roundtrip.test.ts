import { expect, it, onTestFinished } from 'vitest'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import * as fontkit from 'fontkit'
import { createCanvas } from '@napi-rs/canvas'
import { getDocument, type PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { resolve } from './paths.js'
import { TestCallerRegistry } from './support/callers.js'
import { PdfTranslationWriter } from '../src/writer.js'
import { createPdfTranslationSource } from '../src/reader/source.js'
import { pdfTranslationLayoutFragments } from '../src/reader/fragments.js'
import { getPdfTranslationTextContent } from '../src/reader/text-content.js'
import { nativeShortMathContinuations } from '../src/reader/native-short-math-continuation.js'

it('writes a short native continuation while preserving the adjacent sum and literal math', async () => {
  const pdf = await PDFDocument.create()
  pdf.registerFontkit(fontkit)
  const fonts = join(
      dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')),
      'standard_fonts'
    ),
    body = await pdf.embedFont(await readFile(join(fonts, 'LiberationSans-Regular.ttf')), {
      subset: false
    }),
    math = await pdf.embedFont(await readFile(join(fonts, 'LiberationSans-Italic.ttf')), {
      subset: false
    }),
    page = pdf.addPage([600, 800]),
    texts = [
      'An independent neighboring paragraph stays outside this native expression at every position.',
      '∑',
      'j=1',
      'p(x)',
      'To',
      'complete this ordinary description and preserve every nearby mathematical symbol.'
    ],
    right = 60 + body.widthOfTextAtSize(texts[0], 10),
    starterX = right - body.widthOfTextAtSize('To', 10),
    mathX = starterX - 3.33 - math.widthOfTextAtSize('p(x)', 10),
    domainX = mathX - 2.2 - math.widthOfTextAtSize('j=1', 7),
    sumX = domainX - body.widthOfTextAtSize('∑', 10)
  page.drawText(texts[0], { x: 60, y: 720, size: 10, font: body })
  page.drawText(texts[1], { x: sumX, y: 654.5, size: 10, font: body })
  page.drawText(texts[2], { x: domainX, y: 644, size: 7, font: math })
  page.drawText(texts[3], { x: mathX, y: 647, size: 10, font: math })
  page.drawText(texts[4], { x: starterX, y: 647, size: 10, font: body })
  page.drawText(texts[5], { x: 60, y: 631.5, size: 10, font: body })
  const data = new Uint8Array(await pdf.save()),
    loading = getDocument({
      data: data.slice(),
      fontExtraProperties: true,
      disableFontFace: true,
      isEvalSupported: false
    })
  onTestFinished(() => loading.destroy())
  const original = await loading.promise,
    originalPage = await original.getPage(1),
    content = await getPdfTranslationTextContent(originalPage),
    native = texts.map((text) => {
      const index = content.items.findIndex((item) => 'str' in item && item.str === text),
        item = content.items[index]
      if (!item || !('str' in item)) throw new Error('Native fixture item missing')
      return { index, item }
    }),
    fragment = (
      indices: number[]
    ): ReturnType<typeof createPdfTranslationSource>['units'][number]['fragments'][number] => {
      const entries = indices.map((index) => native[index]),
        left = Math.min(...entries.map(({ item }) => item.transform[4])),
        top = Math.max(...entries.map(({ item }) => item.transform[5] + item.height * 0.85)),
        bottom = Math.min(...entries.map(({ item }) => item.transform[5] - item.height * 0.25)),
        right = Math.max(...entries.map(({ item }) => item.transform[4] + item.width))
      return {
        pageNumber: 1,
        rect: {
          x: left / 600,
          y: (800 - top) / 800,
          width: (right - left) / 600,
          height: (top - bottom) / 800
        },
        items: entries.map(({ index, item }) => ({ index, text: item.str }))
      }
    },
    initial = createPdfTranslationSource({
      resourceRequestKey: 'math-continuation',
      fingerprint: original.fingerprints[0],
      pages: [{ width: 600, height: 800 }],
      units: [
        { id: 'neighbor', source: texts[0], fragments: [fragment([0])] },
        {
          id: 'sum',
          source: '∑',
          sourceOnly: true,
          preserve: 'formula',
          fragments: [fragment([1])]
        },
        { id: 'prefix', source: 'j=1 p(x) To', fragments: [fragment([2, 3, 4])] },
        { id: 'prose', source: texts[5], fragments: [fragment([5])] }
      ]
    }),
    units = await nativeShortMathContinuations(
      initial.units,
      originalPage,
      content,
      originalPage.getViewport({ scale: 1 }),
      1
    ),
    source = createPdfTranslationSource({ ...initial, units }),
    paragraph = source.units.find((unit) => unit.id === 'prose')!,
    translation = '为了完成这个普通说明，我们保留周围的所有数学符号。',
    registry = new TestCallerRegistry()
  onTestFinished(() => registry.dispose())
  expect(paragraph.source).toBe('To ' + texts[5])
  expect(paragraph.fragments).toHaveLength(2)
  const input = {
      id: 'math-continuation',
      data,
      pages: source.pages,
      preserveUnsupported: true,
      preserveUnmatched: true,
      units: [
        {
          source: paragraph.source,
          translation,
          fragments: pdfTranslationLayoutFragments(paragraph, source)
        }
      ]
    },
    output = await new PdfTranslationWriter(() => resolve('resources/worker.mjs')).generateDetailed(
      input,
      registry.acquire({ leaseId: 'math-continuation', surface: 'electron' }).lease
    )
  expect(output!.layoutFailures).toEqual([])
  const translated = getDocument({
    data: output!.data.slice(),
    fontExtraProperties: true,
    disableFontFace: true,
    isEvalSupported: false
  })
  onTestFinished(() => translated.destroy())
  const target = await translated.promise,
    targetPage = await target.getPage(1),
    targetItems = (await targetPage.getTextContent()).items.filter((item) => 'str' in item)
  expect(
    targetItems
      .map((item) => item.str)
      .join('')
      .replace(/\s/gu, '')
  ).toContain(translation)
  for (const at of [1, 2, 3]) {
    const before = native[at].item,
      matches = targetItems.filter((item) => item.str === before.str)
    expect(matches).toHaveLength(1)
    matches[0].transform.forEach((value, index) =>
      expect(value).toBeCloseTo(before.transform[index], 3)
    )
    expect(matches[0].width).toBeCloseTo(before.width, 5)
  }
  const pixels = async (page: PDFPageProxy): Promise<Uint8ClampedArray> => {
    const canvas = createCanvas(Math.ceil((starterX - 1 - (sumX - 2)) * 4), 100)
    await page.render({
      canvasContext: canvas.getContext('2d'),
      viewport: page.getViewport({ scale: 4 }),
      transform: [1, 0, 0, 1, -(sumX - 2) * 4, -536]
    }).promise
    return canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
  }
  expect(await pixels(targetPage)).toEqual(await pixels(originalPage))
})
