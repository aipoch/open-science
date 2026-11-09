import { expect, it } from 'vitest'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import * as fontkit from 'fontkit'
import { PDFDocument, PDFDict, PDFName } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { readNativeOccludedText } from '../../src/reader/native-occluded-text.js'
import { getPdfTranslationTextContent } from '../../src/reader/text-content.js'
import { pdfTranslationLayoutSnapshotSchema } from '../../src/snapshot.js'
import {
  rememberPdfTranslationExtraction,
  getPdfTranslationLayoutSnapshot,
  restorePdfTranslationExtraction
} from '../../src/reader/snapshot.js'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { extractPdfTranslationSource } from '../../src/reader/extraction.js'

async function coveredPage(fault = ''): Promise<PDFDocumentProxy> {
  const pdf = await PDFDocument.create()
  pdf.registerFontkit(fontkit)
  const font = await pdf.embedFont(
    await readFile(
      join(
        dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')),
        fault === 'italic-overhang'
          ? 'standard_fonts/LiberationSans-Italic.ttf'
          : 'standard_fonts/LiberationSans-Regular.ttf'
      )
    ),
    { subset: false }
  )
  const page = pdf.addPage([300, 200])
  page.drawText('Registration', { x: 20, y: 150, size: 20, font })
  const key = page.node.Resources()!.lookup(PDFName.of('Font'), PDFDict).keys()[0].toString()
  const text = `BT ${key} 20 Tf 20 150 Td ${font.encodeText(fault === 'italic-overhang' ? 'j' : fault === 'descender' ? 'g' : 'Original title').toString()} Tj ET`
  const cover =
    fault === 'italic-overhang'
      ? '20 0 280 200 re f'
      : fault === 'descender'
        ? '0 150 300 50 re f'
        : fault === 'partial-cover'
          ? '20 150 30 15 re f'
          : fault === 'concave-cover'
            ? '0 0 m 300 0 l 300 160 l 30 160 l 30 200 l 0 200 l h f'
            : fault === 'hole-cover'
              ? '0 0 300 200 re 10 140 200 40 re f*'
              : '0 0 300 200 re f'
  const clip =
    fault === 'narrow-clip'
      ? '0 0 30 200 re W n'
      : fault === 'hole-clip'
        ? '0 0 300 200 re 10 140 200 40 re W* n'
        : fault === 'full-clip'
          ? '-10 -10 320 220 re W n'
          : ''
  const initial =
    fault === 'stroke-text'
      ? text.replace('BT ', 'BT 1 Tr ')
      : fault === 'invisible-text'
        ? text.replace('BT ', 'BT 3 Tr ')
        : text
  const paint = `q ${clip} 0 1 0 rg ${cover} Q`
  const replacement = text.replace(
    '20 150 Td',
    fault === 'italic-overhang' || fault === 'descender' ? '100 50 Td' : '22 150 Td'
  )
  const commands =
    fault === 'cover-before-text'
      ? `${paint}\n${text}\n${text}`
      : fault === 'ordinary-reprint'
        ? `${text}\n${text}`
        : `${initial}\n${paint}\n${replacement}`
  page.node.set(PDFName.of('Contents'), pdf.context.register(pdf.context.flateStream(commands)))
  return getDocument({
    data: await pdf.save(),
    fontExtraProperties: true,
    disableFontFace: true,
    isEvalSupported: false
  }).promise
}
it('tracks the earlier fully covered occurrence while retaining the later title', async () => {
  const document = await coveredPage()
  try {
    const result = await extractPdfTranslationSource({
      document,
      resourceRequestKey: 'anonymous',
      signal: new AbortController().signal
    })
    expect(result.coverage.exclusions).toEqual([
      {
        reason: 'occluded-native-text',
        items: [{ pageNumber: 1, index: 0, text: 'Original title' }]
      }
    ])
    expect(result.coverage.includedItemCount).toBe(1)
    rememberPdfTranslationExtraction(result)
    const snapshot = pdfTranslationLayoutSnapshotSchema.parse(
      getPdfTranslationLayoutSnapshot(result.source)
    )
    const restored = restorePdfTranslationExtraction(
      JSON.parse(JSON.stringify(snapshot)),
      'restored'
    )
    expect(restored.coverage).toEqual(result.coverage)
    expect(restored.source.units).toEqual(result.source.units)
    const duplicate = structuredClone(snapshot)
    duplicate.coverage.exclusions[0].items[0].index = 1
    expect(pdfTranslationLayoutSnapshotSchema.safeParse(duplicate).success).toBe(false)
    expect(
      result.source.units.flatMap((u) => u.fragments.flatMap((f) => f.items.map((i) => i.index)))
    ).toEqual([1])
  } finally {
    await document.destroy()
  }
})

it.each([
  'cover-before-text',
  'ordinary-reprint',
  'partial-cover',
  'concave-cover',
  'hole-cover',
  'narrow-clip',
  'hole-clip',
  'stroke-text',
  'invisible-text',
  'italic-overhang',
  'descender'
])('retains every occurrence without a complete ordinary opaque interior: %s', async (fault) => {
  const document = await coveredPage(fault)
  try {
    const result = await extractPdfTranslationSource({
      document,
      resourceRequestKey: 'anonymous',
      signal: new AbortController().signal
    })
    expect(result.coverage.excludedItemCount).toBe(0)
    expect(result.coverage.includedItemCount).toBe(2)
  } finally {
    await document.destroy()
  }
})
it('intersects a complete rectangular clip with the exact fill interior', async () => {
  const document = await coveredPage('full-clip')
  try {
    const result = await extractPdfTranslationSource({
      document,
      resourceRequestKey: 'anonymous',
      signal: new AbortController().signal
    })
    expect(result.coverage.excludedItemCount).toBe(1)
  } finally {
    await document.destroy()
  }
})
it.each([
  'alpha',
  'blend',
  'soft-mask',
  'group',
  'form',
  'fill-stroke',
  'missing-outline',
  'accent',
  'glyph-missing',
  'source-text',
  'source-font',
  'source-advance',
  'source-position',
  'source-combined',
  'source-order',
  'transparent-css',
  'alpha-hex',
  'remeasure',
  'unknown-vertical'
])('abstains on uncertain native evidence: %s', async (fault) => {
  const document = await coveredPage()
  try {
    const page = await document.getPage(1),
      content = await getPdfTranslationTextContent(page),
      viewport = page.getViewport({ scale: 1 }),
      operators = await page.getOperatorList()
    const textIndex = operators.fnArray.indexOf(OPS.showText),
      fillIndex = operators.fnArray.findIndex(
        (op, i) => op === OPS.constructPath && operators.argsArray[i][0] === OPS.fill
      )
    if (['alpha', 'blend', 'soft-mask', 'group', 'form'].includes(fault)) {
      const op =
        fault === 'group'
          ? OPS.beginGroup
          : fault === 'form'
            ? OPS.paintFormXObjectBegin
            : OPS.setGState
      const args =
        fault === 'alpha'
          ? [[['ca', 0.5]]]
          : fault === 'blend'
            ? [[['BM', 'multiply']]]
            : fault === 'soft-mask'
              ? [[['SMask', true]]]
              : []
      operators.fnArray.splice(0, 0, op)
      operators.argsArray.splice(0, 0, args)
    } else if (fault === 'transparent-css' || fault === 'alpha-hex') {
      const fillColor = operators.fnArray.indexOf(OPS.setFillRGBColor)
      operators.argsArray[fillColor] = [fault === 'transparent-css' ? 'rgba(0,0,0,0)' : '#00000000']
    } else if (fault === 'remeasure' || fault === 'unknown-vertical') {
      const item = content.items[0]
      if (!('str' in item)) throw Error('Missing source')
      const font = page.commonObjs.get(item.fontName)
      Object.defineProperty(font, fault === 'remeasure' ? 'remeasure' : 'vertical', {
        value: fault === 'remeasure' ? true : undefined,
        configurable: true
      })
    } else if (fault === 'fill-stroke') operators.argsArray[fillIndex][0] = OPS.fillStroke
    else if (fault === 'accent')
      operators.argsArray[textIndex][0][0].accent = { fontChar: 'x', offset: { x: 0, y: 0 } }
    else if (fault === 'glyph-missing') operators.argsArray[textIndex][0][0].isInFont = false
    else if (fault === 'missing-outline') {
      const has = page.commonObjs.has.bind(page.commonObjs)
      page.commonObjs.has = (key: string): boolean => !key.includes('_path_') && has(key)
    } else {
      const item = content.items[0]
      if (!('str' in item)) throw Error('Missing source')
      if (fault === 'source-text') item.str = 'Unrelated title'
      if (fault === 'source-font') item.fontName = 'Other'
      if (fault === 'source-advance') item.width += 1
      if (fault === 'source-position') item.transform[4] += 1
      if (fault === 'source-combined') item.str += 'Original title'
      if (fault === 'source-order') content.items.reverse()
    }
    expect(await readNativeOccludedText(page, content, viewport)).toBeUndefined()
  } finally {
    await document.destroy()
  }
})
it.each(['outline', 'font', 'source', 'operators'])(
  'binds an accepted exclusion through later native drift: %s',
  async (fault) => {
    const document = await coveredPage()
    try {
      const page = await document.getPage(1),
        content = await getPdfTranslationTextContent(page),
        operators = await page.getOperatorList()
      const proof = await readNativeOccludedText(page, content, page.getViewport({ scale: 1 }))
      expect([...proof!.indexes]).toEqual([0])
      const item = content.items[0]
      if (!('str' in item)) throw Error('Missing source')
      const font = page.commonObjs.get(item.fontName)
      if (fault === 'font') font.data[0] ^= 1
      if (fault === 'source') item.str += '!'
      if (fault === 'operators') operators.argsArray[operators.fnArray.indexOf(OPS.setFont)][1] += 1
      if (fault === 'outline') {
        const glyph = operators.argsArray[operators.fnArray.indexOf(OPS.showText)][0][0]
        page.commonObjs.get(`${font.loadedName}_path_${glyph.fontChar}`).path[1] += 1
      }
      expect(proof!.current()).toBe(false)
    } finally {
      await document.destroy()
    }
  }
)
it('rejects outline mutation between measuring the glyph and binding the source', async () => {
  const document = await coveredPage()
  try {
    const page = await document.getPage(1),
      content = await getPdfTranslationTextContent(page),
      operators = await page.getOperatorList(),
      item = content.items[0]
    if (!('str' in item)) throw Error('Missing source')
    const get = page.commonObjs.get.bind(page.commonObjs),
      font = get(item.fontName),
      glyph = operators.argsArray[operators.fnArray.indexOf(OPS.showText)][0][0],
      path = get(`${font.loadedName}_path_${glyph.fontChar}`).path
    let reads = 0
    page.commonObjs.get = ((key: string): unknown => {
      if (key === item.fontName && ++reads === 2) path[1] = -100
      return get(key)
    }) as typeof page.commonObjs.get
    expect(
      await readNativeOccludedText(page, content, page.getViewport({ scale: 1 }))
    ).toBeUndefined()
  } finally {
    await document.destroy()
  }
})

it('abstains when glyph evidence changes while the asynchronous page identity is checked', async () => {
  const document = await coveredPage()
  try {
    const page = await document.getPage(1),
      content = await getPdfTranslationTextContent(page),
      operators = await page.getOperatorList(),
      item = content.items[0]
    if (!('str' in item)) throw Error('Missing source')
    const font = page.commonObjs.get(item.fontName),
      glyph = operators.argsArray[operators.fnArray.indexOf(OPS.showText)][0][0],
      path = page.commonObjs.get(`${font.loadedName}_path_${glyph.fontChar}`).path
    const getOperators = page.getOperatorList.bind(page)
    let calls = 0
    page.getOperatorList = async (...args): Promise<typeof operators> => {
      const result = await getOperators(...args)
      if (++calls === 2) path[1] = -100
      return result
    }
    expect(
      await readNativeOccludedText(page, content, page.getViewport({ scale: 1 }))
    ).toBeUndefined()
  } finally {
    await document.destroy()
  }
})

it('refuses to publish covered-source exclusions after document identity changes', async () => {
  const document = await coveredPage()
  try {
    await expect(
      extractPdfTranslationSource({
        document,
        resourceRequestKey: 'anonymous',
        signal: new AbortController().signal,
        onProgress: () => {
          document.fingerprints[0] = 'changed'
        }
      })
    ).rejects.toThrow('PDF source changed during occluded text verification')
  } finally {
    await document.destroy()
  }
})
