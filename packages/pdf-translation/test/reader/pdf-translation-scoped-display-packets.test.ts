import { expect, it } from 'vitest'
import type { PDFPageProxy, PDFDocumentProxy } from 'pdfjs-dist'
import { OPS, getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import * as fontkit from 'fontkit'
import { PDFDocument, PDFDict, PDFName } from 'pdf-lib'
import { extractPdfTranslationSource } from '../../src/reader/extraction.js'
import {
  nativeAlgorithmInkRegions,
  nativeTextFreeClipInkRegions
} from '../../src/reader/native-source-geometry.js'
import { nativeInkPageIdentity } from '../../src/reader/auxiliary-native-ink.js'
import { nativeScopedDisplayOwners } from '../../src/reader/native-display-packets.js'
import { getPdfTranslationTextContent } from '../../src/reader/text-content.js'

type Request = Parameters<typeof nativeAlgorithmInkRegions>

function nativeClip(fault = ''): Request {
  const text = [OPS.beginText, OPS.setFont, OPS.moveText, OPS.showText, OPS.endText],
    textArgs = [
      [],
      ['F', 10],
      [40, 70],
      [[{ unicode: 'x', fontChar: 'x', width: 500, isInFont: true, isSpace: false }]],
      []
    ],
    fnArray = [OPS.save, OPS.clip, OPS.constructPath, OPS.restore, ...text],
    argsArray: unknown[][] = [
      [],
      [],
      [OPS.endPath, [new Float32Array([0, 10, 10, 1, 20, 10, 1, 20, 20, 4])], null],
      [],
      ...textArgs
    ]
  if (fault === 'text-in-clip') {
    fnArray.splice(3, 1)
    argsArray.splice(3, 1)
    fnArray.push(OPS.restore)
    argsArray.push([])
  }
  if (fault === 'unclosed-state') {
    fnArray.splice(3, 1)
    argsArray.splice(3, 1)
  }
  if (fault === 'missing-clip-path') {
    fnArray.splice(2, 1)
    argsArray.splice(2, 1)
  }
  const font = {
      loadedName: 'F',
      data: new Uint8Array([0, 1, 2, 3]),
      missingFile: false,
      isInvalidPDFjsFont: false,
      vertical: false,
      isType3Font: false,
      fontMatrix: [0.001, 0, 0, 0.001, 0, 0]
    },
    content = {
      items: [
        {
          str: 'x',
          fontName: 'F',
          dir: 'ltr',
          width: 5,
          height: 10,
          transform: [10, 0, 0, 10, 40, 70]
        }
      ],
      styles: { F: { vertical: false } }
    },
    page = {
      getOperatorList: async (): Promise<unknown> => ({ fnArray, argsArray }),
      commonObjs: {
        has: (name: string): boolean =>
          name === 'F' || (name === 'F_path_x' && fault !== 'missing-glyph'),
        get: (name: string): unknown =>
          name === 'F' ? font : { path: [0, 0, 0, 1, 0.5, 0, 1, 0.5, 0.7, 1, 0, 0.7, 4] }
      }
    }
  return [
    page as unknown as PDFPageProxy,
    content as unknown as Request[1],
    {
      width: 100,
      height: 100,
      scale: 1,
      rotation: 0,
      transform: [1, 0, 0, -1, 0, 100]
    } as Request[2],
    1,
    new Set([0])
  ]
}

it('keeps the default core strict while separately proving a text-free clipped scope', async () => {
  expect(await nativeAlgorithmInkRegions(...nativeClip())).toBeUndefined()
  expect((await nativeTextFreeClipInkRegions(...nativeClip()))?.size).toBe(1)
})

it.each(['text-in-clip', 'unclosed-state', 'missing-clip-path', 'missing-glyph'])(
  'does not bypass native glyph or complete clipping proof: %s',
  async (fault) => {
    expect(await nativeTextFreeClipInkRegions(...nativeClip(fault))).toBeUndefined()
  }
)

it('binds the glyph pass to the exact operator snapshot through A/B/A drift', async () => {
  const request = nativeClip(),
    original = await request[0].getOperatorList(),
    changed = structuredClone(original)
  changed.argsArray[1] = ['changed-program']
  let calls = 0
  request[0].getOperatorList = async (): Promise<typeof original> =>
    ++calls === 2 ? changed : original
  const snapshot = await request[0].getOperatorList()
  expect(await nativeTextFreeClipInkRegions(...request, snapshot)).toBeUndefined()
  expect(await request[0].getOperatorList()).toEqual(original)
})

it('rejects inherited or accessor viewport fields instead of invoking them as stable data', async () => {
  const request = nativeClip()
  expect(await nativeInkPageIdentity(request[0], request[1], request[2])).toBeDefined()
  const inherited = Object.create({ width: 100 }) as Request[2]
  Object.assign(inherited, request[2])
  delete (inherited as unknown as Record<string, unknown>).width
  expect(await nativeInkPageIdentity(request[0], request[1], inherited)).toBeUndefined()
  Object.defineProperty(request[2], 'width', { configurable: true, get: (): number => 100 })
  expect(await nativeInkPageIdentity(request[0], request[1], request[2])).toBeUndefined()
})

async function embeddedDisplay(fault: string): Promise<PDFDocumentProxy> {
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
    page = pdf.addPage([600, 800])
  page.drawText('Initial font registration.', { x: 50, y: 700, size: 10, font })
  const key = page.node.Resources()!.lookup(PDFName.of('Font'), PDFDict).keys()[0].toString(),
    text = (value: string, x: number, y: number, size = 10): string => {
      let cursor = x
      return value
        .split(' ')
        .map((word): string => {
          const result = `BT ${key} ${size} Tf ${cursor} ${y} Td ${font.encodeText(word).toString()} Tj ET`
          cursor += font.widthOfTextAtSize(word, size) + size * 0.35
          return result
        })
        .join('\n')
    },
    equation = (y: number, number: number): string =>
      [
        text('u', 180, y),
        text('=', 190, y),
        text('0', 205, y),
        text('in', 220, y),
        text('R', 240, y),
        text('2', 248, y + 4, 7),
        text(`(${number})`, 500, y)
      ].join('\n'),
    commands = [
      'q 1 J 0 0 m 20 0 l 20 20 l h W n 2 2 m 15 15 l S',
      ...(fault === 'text-in-clip' ? [text('Clipped exterior.', 2, 2)] : []),
      'Q',
      text('The preceding ordinary paragraph remains available for translation.', 50, 700),
      equation(600, 1),
      equation(570, fault === 'no-sequence' ? 7 : 2),
      text('The following ordinary explanation remains available for translation.', 50, 530),
      ...(fault === 'foreign-paint' ? ['180 590 100 20 re f'] : [])
    ].join('\n')
  page.node.set(PDFName.of('Contents'), pdf.context.register(pdf.context.flateStream(commands)))
  return getDocument({
    data: await pdf.save(),
    fontExtraProperties: true,
    disableFontFace: true,
    isEvalSupported: false
  }).promise
}

it.each(['', 'text-in-clip', 'foreign-paint', 'no-sequence'])(
  'uses the public source seam with actual embedded font, glyphs and whole owners: %s',
  async (fault) => {
    const document = await embeddedDisplay(fault)
    try {
      const extraction = await extractPdfTranslationSource({
          document,
          resourceRequestKey: 'anonymous',
          signal: new AbortController().signal
        }),
        formula = extraction.source.units.find((u) =>
          u.fragments.some((f) => f.items.some((i) => i.text === 'in'))
        )!
      expect(formula).toBeDefined()
      expect(formula.sourceOnly === true).toBe(fault === '')
      if (!fault) expect(formula.preserve).toBe('formula')
      expect(
        extraction.source.units.find((u) => u.source.startsWith('The following'))?.sourceOnly
      ).not.toBe(true)
      expect(extraction.coverage.excludedItemCount).toBe(0)
    } finally {
      await document.destroy()
    }
  }
)

it('proves complete native owner partitions instead of relying on IDs or merging exterior prose', async () => {
  const document = await embeddedDisplay('')
  try {
    const extraction = await extractPdfTranslationSource({
        document,
        resourceRequestKey: 'anonymous',
        signal: new AbortController().signal
      }),
      page = await document.getPage(1),
      content = await getPdfTranslationTextContent(page),
      viewport = page.getViewport({ scale: 1 }),
      auxiliary = {
        read: async (): Promise<undefined> => undefined,
        dispose: async (): Promise<void> => undefined
      },
      units = extraction.source.units.map((u) => {
        const copy = { ...u }
        if (u.fragments.some((f) => f.items.some((i) => i.text === 'in'))) {
          delete copy.sourceOnly
          delete copy.preserve
        }
        return copy
      }),
      target = units.find((u) => u.fragments.some((f) => f.items.some((i) => i.text === 'in')))!,
      fragment = target.fragments[0],
      leftItems = fragment.items.slice(0, 2),
      rightItems = fragment.items.slice(2),
      left = {
        ...target,
        id: 'anonymous-left',
        source: leftItems.map((i) => i.text).join(' '),
        fragments: [{ ...fragment, items: leftItems }]
      },
      right = {
        ...target,
        id: 'anonymous-domain',
        source: rightItems.map((i) => i.text).join(' '),
        fragments: [{ ...fragment, items: rightItems }]
      },
      split = [...units.filter((u) => u !== target), left, right]
    expect(
      (await nativeScopedDisplayOwners(units, page, content, viewport, 1, auxiliary)).has(target.id)
    ).toBe(true)
    const divided = await nativeScopedDisplayOwners(split, page, content, viewport, 1, auxiliary)
    expect(divided.has(left.id)).toBe(true)
    expect(divided.has(right.id)).toBe(true)
    const readonlyLeft = { ...left, sourceOnly: true as const, preserve: 'formula' as const },
      retained = await nativeScopedDisplayOwners(
        split.map((u) => (u === left ? readonlyLeft : u)),
        page,
        content,
        viewport,
        1,
        auxiliary
      )
    expect(retained.has(left.id)).toBe(false)
    expect(retained.has(right.id)).toBe(true)
    const exterior = units.find((u) => u.source.startsWith('The preceding'))!,
      mixed = {
        ...right,
        source: right.source + ' ' + exterior.source,
        fragments: [...right.fragments, ...exterior.fragments]
      },
      rejected = await nativeScopedDisplayOwners(
        split.filter((u) => u !== exterior && u !== right).concat(mixed),
        page,
        content,
        viewport,
        1,
        auxiliary
      )
    expect(rejected.has(mixed.id)).toBe(false)
    expect(rejected.has(left.id)).toBe(false)
  } finally {
    await document.destroy()
  }
})
