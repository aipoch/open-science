import { expect, it } from 'vitest'
import type { PDFPageProxy, PDFDocumentProxy } from 'pdfjs-dist'
import type { TextItem } from 'pdfjs-dist/types/src/display/api.js'
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
import {
  nativeScopedDisplayOwners,
  nativeClosedMathGrammar
} from '../../src/reader/native-display-packets.js'
import { getPdfTranslationTextContent } from '../../src/reader/text-content.js'
import {
  nativeLiteralMathCandidates,
  nativeLiteralMathOwners
} from '../../src/reader/native-literal-math.js'

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
      expect(formula.sourceOnly === true).toBe(fault !== 'no-sequence')
      expect(formula.preserve).toBe(
        !fault ? 'formula' : fault === 'no-sequence' ? undefined : 'literal'
      )
      const page = await document.getPage(1),
        content = await getPdfTranslationTextContent(page),
        viewport = page.getViewport({ scale: 1 }),
        units = extraction.source.units.map((owner) => {
          if (owner.id !== formula.id) return owner
          const copy = { ...owner }
          delete copy.sourceOnly
          delete copy.preserve
          return copy
        }),
        before = structuredClone(units),
        positive = await nativeScopedDisplayOwners(units, page, content, viewport, 1, {
          read: async (): Promise<undefined> => undefined,
          dispose: async (): Promise<void> => undefined
        }),
        negative = await nativeLiteralMathOwners(units, page, content, viewport, 1)
      // A literal fallback never upgrades a failed native paint certificate.
      expect(positive.has(formula.id)).toBe(fault === '')
      expect(units).toEqual(before)
      if (fault === 'text-in-clip' || fault === 'foreign-paint') {
        expect(negative.has(formula.id)).toBe(true)
        expect({
          ...units.find((owner) => owner.id === formula.id),
          sourceOnly: true,
          preserve: 'literal'
        }).toEqual(formula)
      }
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

it.each([
  'attached',
  'body-word',
  'raised-word',
  'far-index',
  'unknown-function',
  'prose-in',
  'foreign-script',
  'greek-prose'
])('closes mathematical operators and native lowered word indices only: %s', (fault) => {
  const atom = (
      str: string,
      x: number,
      y: number,
      height = 10,
      width = 6
    ): Parameters<typeof nativeClosedMathGrammar>[0][number] => ({
      str,
      width,
      height,
      transform: [height, 0, 0, height, x, y]
    }),
    packet = [
      atom('L', 100, 300),
      atom(
        'phase',
        fault === 'far-index' ? 140 : 106,
        fault === 'raised-word' ? 302 : 298.5,
        fault === 'body-word' ? 10 : 7,
        15
      ),
      atom('=', 130, 300),
      atom(fault === 'unknown-function' ? 'merge' : 'log', 142, 300, 10, 16),
      atom('x', 162, 300)
    ]
  if (fault === 'prose-in') packet[3] = atom('in', 142, 300, 10, 10)
  if (fault === 'foreign-script') packet[3] = atom('测量', 142, 300, 10, 10)
  if (fault === 'greek-prose') packet[3] = atom('λόγος', 142, 300, 10, 10)
  expect(nativeClosedMathGrammar(packet, 10)).toBe(fault === 'attached')
})

it.each(['stacked fraction', 'different source text', 'mixed owner'])(
  'retains native operands next to a serialized protected formula: %s',
  (scenario) => {
    const item = (str: string, x: number, y: number, height = 10, hasEOL = false): TextItem => ({
        str,
        dir: 'ltr',
        fontName: 'F',
        width: 5,
        height,
        hasEOL,
        transform: [height, 0, 0, height, x, y]
      }),
      items = [
        item('We estimate the following quantity:', 40, 360, 10, true),
        item('z', 130, 320),
        item('=', 143, 320),
        item('3', 157, 327, 7),
        item('2', 157, 316, 7),
        item('+', 172, 320),
        item('w', 184, 320),
        item('(4)', 400, 320, 10, true),
        item('The comparison comes from the same measurements.', 40, 290, 10, true),
        item('(5)', 400, 260, 10, true)
      ],
      owner = (
        id: string,
        indices: number[],
        source?: string,
        preserve?: 'formula'
      ): Parameters<typeof nativeLiteralMathCandidates>[0][number] => ({
        id,
        source: source ?? indices.map((index) => items[index].str).join(' '),
        fragments: [
          {
            pageNumber: 1,
            rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
            items: indices.map((index) => ({ index, text: items[index].str }))
          }
        ],
        ...(preserve ? { sourceOnly: true as const, preserve } : {})
      }),
      protectedFraction = owner(
        'fraction',
        [3, 4],
        scenario === 'different source text' ? '3/8' : '3/2',
        'formula'
      ),
      units = [
        owner('lead', [0]),
        owner('left', [1, 2], undefined, 'formula'),
        protectedFraction,
        owner('plus', [5], undefined, 'formula'),
        owner('variable', scenario === 'mixed owner' ? [6, 8] : [6]),
        owner('label', [7], undefined, 'formula'),
        ...(scenario === 'mixed owner' ? [] : [owner('following', [8])]),
        owner('other label', [9], undefined, 'formula')
      ],
      before = structuredClone(units),
      candidates = nativeLiteralMathCandidates(units, { items, styles: {}, lang: null }, 1)
    expect([...candidates]).toEqual(scenario === 'stacked fraction' ? ['variable'] : [])
    expect(units).toEqual(before)
  }
)

it.each([342, 329])('keeps an inset display separate from the inline condition at %s', (leadY) => {
  const rows: [string, number, number][] = [
    ['We therefore have', 40, leadY],
    ['v', 350, leadY],
    ['≥', 363, leadY],
    ['0,', 375, leadY],
    ['z', 145, 320],
    ['=', 158, 320],
    ['1', 171, 320],
    ['(4)', 400, 320],
    ['The next statement uses the same quantity.', 40, 290],
    ['(5)', 400, 260]
  ]
  const items = rows.map(([str, x, y]) => ({
    str,
    dir: 'ltr',
    fontName: 'F',
    width: 7,
    height: 10,
    hasEOL: str.startsWith('('),
    transform: [10, 0, 0, 10, x, y]
  }))
  const units = [[0, 1, 2, 3], [4, 5, 6], [7], [8], [9]].map((indices, group) => ({
    id: `owner-${group}`,
    source: indices.map((index) => items[index].str).join(' '),
    fragments: [
      {
        pageNumber: 1,
        rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
        items: indices.map((index) => ({ index, text: items[index].str }))
      }
    ],
    ...(group === 2 || group === 4
      ? { sourceOnly: true as const, preserve: 'formula' as const }
      : {})
  }))
  const candidates = nativeLiteralMathCandidates(units, { items, styles: {}, lang: null }, 1)
  expect([...candidates]).toEqual(leadY === 342 ? ['owner-1'] : [])
})
