import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import * as fontkit from 'fontkit'
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { extractPdfTranslationSource } from '../../src/reader/extraction.js'

// Anonymous four-node geometry reduced from a typeset commutative diagram.
type TextItem = Extract<
  Awaited<ReturnType<PDFPageProxy['getTextContent']>>['items'][number],
  { str: string }
>
function fixture(
  obstruction = false,
  paintedTips = true,
  extraPath = false,
  label = false,
  dangling: false | 'solid' | 'dashed' = false
): {
  items: TextItem[]
  run: () => ReturnType<typeof extractPdfTranslationSource>
} {
  const text = (
    str: string,
    x: number,
    y: number,
    size = 10,
    width = 5,
    fontName = 'labels'
  ): TextItem => ({
    str,
    transform: [size, 0, 0, size, x, y],
    width,
    height: size,
    fontName,
    dir: 'ltr',
    hasEOL: false
  })
  const items = [text('Surrounding prose stays translatable.', 40, 650, 10, 210)]
  for (const [x, y] of [
    [100, 600],
    [160, 600],
    [100, 540],
    [160, 540]
  ]) {
    items.push(text('A', x, y), text('2', x + 6, y + 4, 7, 4))
  }
  const lines = [
    [112, 603, 154, 603],
    [105, 590, 105, 552],
    [112, 543, 154, 543],
    [165, 590, 165, 552]
  ]
  if (dangling) lines.push([178, 603, 215, 603])
  for (const [, , x, y] of lines) items.push(text('\u000f', x, y, 10, 0, 'tips'))
  if (obstruction) items.push(text('A normal sentence inside the gap.', 110, 575, 10, 170))
  if (label) items.push(text('f', 130, 609, 7, 3))
  const fnArray: number[] = [OPS.setLineWidth],
    argsArray: unknown[][] = [[0.4]]
  for (const [x, y, right, bottom] of lines) {
    if (dangling === 'dashed' && x === 178) {
      fnArray.push(OPS.setDash)
      argsArray.push([[2, 2], 0])
    }
    fnArray.push(OPS.constructPath)
    argsArray.push([
      OPS.stroke,
      [new Float32Array([0, x, y, 1, right, bottom])],
      new Float32Array([
        Math.min(x, right),
        Math.min(y, bottom),
        Math.max(x, right),
        Math.max(y, bottom)
      ])
    ])
  }
  if (extraPath) {
    fnArray.push(OPS.constructPath)
    argsArray.push([
      OPS.stroke,
      [new Float32Array([0, 125, 570, 1, 145, 570])],
      new Float32Array([125, 570, 145, 570])
    ])
  }
  if (paintedTips) {
    fnArray.push(OPS.setFont, OPS.showText)
    argsArray.push(
      ['tips', 10],
      [[{ unicode: '\u000f', fontChar: 'tip', isInFont: true, width: 0 }]]
    )
  }
  const page = {
    rotate: 0,
    view: [0, 0, 600, 800],
    getViewport: () => ({ width: 600, height: 800, transform: [1, 0, 0, -1, 0, 800] }),
    getTextContent: async () => ({
      items,
      styles: { labels: { ascent: 0.8, descent: -0.2 }, tips: { ascent: 0, descent: 0 } }
    }),
    getOperatorList: async () => ({ fnArray, argsArray }),
    commonObjs: {
      has: (key: string) => ['tips', 'tips_path_tip'].includes(key),
      get: (key: string) =>
        key === 'tips'
          ? { loadedName: 'tips', missingFile: false, vertical: false, isType3Font: false }
          : { path: new Float32Array([0, -0.4, 0.15, 1, 0, 0, 1, -0.4, -0.15, 4]) }
    }
  }
  const document = {
    numPages: 1,
    fingerprints: ['anonymous-diagram'],
    getPage: async () => page
  } as unknown as PDFDocumentProxy
  return {
    items,
    run: () =>
      extractPdfTranslationSource({
        document,
        resourceRequestKey: 'test',
        signal: new AbortController().signal
      })
  }
}

type FilledArrowFault = 'none' | 'foreign-paint' | 'foreign-text' | 'unknown-glyph'

async function filledArrowDocument(
  fault: FilledArrowFault
): Promise<ReturnType<typeof getDocument>> {
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
  const page = pdf.addPage([600, 800])
  page.drawText('Register the font.', { font })
  const key = page.node.Resources()!.lookup(PDFName.of('Font'), PDFDict).keys()[0].toString()
  const text = (str: string, x: number, y: number, size = 10): string => {
    let cursor = x
    return str
      .split(' ')
      .map((word) => {
        const draw = `BT ${key} ${size} Tf ${cursor} ${y} Td ${font.encodeText(word).toString()} Tj ET`
        cursor += font.widthOfTextAtSize(word, size) + size * 0.35
        return draw
      })
      .join('\n')
  }
  const arrow = (x: number, y: number, length: number, vertical = false): string =>
    [
      `q ${vertical ? '0 -1 1 0' : '1 0 0 1'} ${x} ${y} cm`,
      `0 0 m ${length} 0 l S`,
      '0 0 m -0.3 0 l -1.1 0 -1.8 -0.8 -1.8 -1.4 c -1.8 -2.2 -1.1 -2.9 -0.3 -2.9 c S',
      `${length + 2} 0 m ${length - 1.2} 1.6 l ${length} 0 l ${length - 1.2} -1.6 l f Q`
    ].join('\n')
  page.node.set(
    PDFName.of('Contents'),
    pdf.context.register(
      pdf.context.flateStream(
        [
          text('The preceding proof remains available for translation.', 60, 665),
          text('A ×', 90, 600),
          text('C', 113, 597, 7),
          text('B', 169, 600),
          text('A', 99, 543),
          text('C', 170, 543),
          '0.4 w',
          arrow(125, 603, 34),
          arrow(115, 546, 44),
          arrow(102, 593, 38, true),
          arrow(172, 593, 38, true),
          ...(fault === 'foreign-paint' ? ['130 570 m 150 570 l S'] : []),
          ...(fault === 'foreign-text' ? [text('foreign', 120, 553, 7)] : []),
          text('The following explanation also remains eligible.', 60, 510)
        ].join('\n')
      )
    )
  )
  return getDocument({
    data: await pdf.save(),
    fontExtraProperties: true,
    disableFontFace: true,
    isEvalSupported: false
  })
}

describe('native commutative diagram preservation', () => {
  it.each(['none', 'foreign-paint', 'foreign-text', 'unknown-glyph'] as const)(
    'requires complete native evidence for a filled-arrow square (%s)',
    async (fault) => {
      const task = await filledArrowDocument(fault)
      try {
        const document = await task.promise
        const page = await document.getPage(1)
        const content = await page.getTextContent()
        if (fault === 'unknown-glyph') {
          const operators = await page.getOperatorList()
          const argsArray = structuredClone(operators.argsArray)
          const glyph = argsArray
            .flatMap((args, i) => (operators.fnArray[i] === OPS.showText ? args[0] : []))
            .find((item) => item?.unicode === '×')
          expect(glyph).toBeDefined()
          glyph.isInFont = false
          page.getOperatorList = async () => ({ ...operators, argsArray })
        }
        const result = await extractPdfTranslationSource({
          document,
          resourceRequestKey: 'test',
          signal: new AbortController().signal
        })
        const diagram = result.source.units.find((u) => u.id.startsWith('math-diagram:'))
        if (fault !== 'none') expect(diagram).toBeUndefined()
        else {
          expect(diagram?.sourceOnly).toBe(true)
          expect(diagram?.fragments[0].items.map((item) => item.text)).toEqual([
            'A ×',
            'C',
            'B',
            'A',
            'C'
          ])
          const originals = content.items.flatMap((item, index) =>
            'str' in item && item.str.trim() ? [[index, item.str]] : []
          )
          const owners = [
            ...result.source.units.flatMap((unit) =>
              unit.fragments.flatMap((fragment) =>
                fragment.items.map((item) => [item.index, item.text])
              )
            ),
            ...result.coverage.exclusions.flatMap((exclusion) =>
              exclusion.items.map((item) => [item.index, item.text])
            )
          ]
          expect(owners.map((item) => JSON.stringify(item)).sort()).toEqual(
            originals.map((item) => JSON.stringify(item)).sort()
          )
          expect(new Set(owners.map(([index]) => index)).size).toBe(owners.length)
        }
        expect(
          result.source.units.filter(
            (unit) => !unit.sourceOnly && unit.source.includes('available for translation')
          )
        ).toHaveLength(1)
        expect(
          result.source.units.filter(
            (unit) => !unit.sourceOnly && unit.source.includes('remains eligible')
          )
        ).toHaveLength(1)
      } finally {
        await task.destroy()
      }
    }
  )

  it('keeps a proved graph together, including zero-advance arrow sources, without consuming prose', async () => {
    const f = fixture(),
      result = await f.run()
    const diagram = result.source.units.find((u) => u.id.startsWith('math-diagram:'))
    expect(diagram).toBeDefined()
    expect(diagram?.sourceOnly).toBe(true)
    expect(diagram?.fragments[0].items.map((i) => i.index).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 12 }, (_, i) => i + 1)
    )
    expect(diagram?.fragments[0].rect.height).toBeGreaterThan(0.08)
    expect(
      result.source.units.find((u) => u.fragments.some((f) => f.items.some((i) => i.index === 0)))
        ?.sourceOnly
    ).toBeUndefined()
    const owners = [
      ...result.source.units.flatMap((u) =>
        u.fragments.flatMap((f) => f.items.map((i) => i.index))
      ),
      ...result.coverage.exclusions.flatMap((e) => e.items.map((i) => i.index))
    ]
    expect(owners.sort((a, b) => a - b)).toEqual(f.items.map((_, i) => i))
  })

  it.each(['prose intrusion', 'unproved arrow glyph'] as const)(
    'does not promote %s into a mathematical region',
    async (reason) => {
      const result = await fixture(
        reason === 'prose intrusion',
        reason !== 'unproved arrow glyph'
      ).run()
      expect(result.source.units.some((u) => u.id.startsWith('math-diagram:'))).toBe(false)
    }
  )

  it('owns a smaller label attached geometrically to the middle of an arrow', async () => {
    const result = await fixture(false, true, false, true).run()
    expect(
      result.source.units
        .find((u) => u.id.startsWith('math-diagram:'))
        ?.fragments[0].items.some((i) => i.text === 'f')
    ).toBe(true)
  })

  it('warns about a proved mathematical graph with an unowned path, without joining it', async () => {
    const result = await fixture(false, true, true).run()
    expect(result.source.units.some((u) => u.id.startsWith('math-diagram:'))).toBe(false)
    expect(result.coverage.warnings.some((w) => w.reasons.includes('formula-extraction'))).toBe(
      true
    )
    const prose = result.source.units.find((u) =>
      u.fragments.some((f) => f.items.some((i) => i.index === 0))
    )!
    expect(result.coverage.warnings.some((w) => w.unitId === prose.id)).toBe(false)
  })

  it.each(['solid', 'dashed'] as const)(
    'keeps a graph partial when a %s outward terminal connector starts beyond its current box',
    async (style) => {
      const f = fixture(false, true, false, false, style)
      const result = await f.run()
      expect(result.source.units.some((u) => u.id.startsWith('math-diagram:'))).toBe(false)
      expect(result.coverage.warnings.some((w) => w.reasons.includes('formula-extraction'))).toBe(
        true
      )
      const prose = result.source.units.find((u) =>
        u.fragments.some((fragment) => fragment.items.some((i) => i.index === 0))
      )!
      expect(result.coverage.warnings.some((w) => w.unitId === prose.id)).toBe(false)
      const native = [
        ...result.source.units.flatMap((u) => u.fragments.flatMap((fragment) => fragment.items)),
        ...result.coverage.exclusions.flatMap((e) => e.items)
      ]
      expect(native.map((i) => i.index).sort((a, b) => a - b)).toEqual(f.items.map((_, i) => i))
    }
  )
})
