import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'

const { splitPdfNumericRuns, nativeWhitespaceGaps } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-symbol-text.mjs')).href
)

it.each([false, true])(
  'observes literal delimiter advances with character spacing: space glyph=%s',
  (spaceGlyph) => {
    const glyph = (unicode: string, width = 300): { unicode: string; width: number } => ({
      unicode,
      width
    })
    const operators = {
      fnArray: [OPS.setFont, OPS.setCharSpacing, OPS.showText],
      argsArray: [
        ['native', 10],
        [0.5],
        [[glyph('('), ...(spaceGlyph ? [glyph(' ', 500)] : [-500]), glyph(')')]]
      ]
    }
    const items = [
      {
        str: '( )',
        fontName: 'native',
        dir: 'ltr',
        width: spaceGlyph ? 12 : 11.5,
        height: 10,
        transform: [10, 0, 0, 10, 10, 10]
      }
    ]
    const viewport = {
      rotation: 0,
      scale: 1,
      convertToViewportPoint: (x: number, y: number): number[] => [x, 20 - y]
    }
    const before = structuredClone({ items, operators })
    const runs = nativeWhitespaceGaps({ items }, operators, viewport)
    expect(runs).toHaveLength(1)
    expect(runs[0].glyphRuns).toEqual([2, 2])
    expect(runs[0].literalGlyphs).toEqual(spaceGlyph ? ['(', ' ', ')'] : ['(', ')'])
    expect(runs[0].gaps).toEqual([{ left: 13, right: spaceGlyph ? 19 : 18.5, index: 1 }])
    expect(splitPdfNumericRuns({ items }, operators).items).toEqual(items)
    expect({ items, operators }).toEqual(before)
  }
)

it.each([
  'native',
  'separate-runs',
  'unrelated-ligature',
  'missing-edge',
  'partial-edge',
  'crossed-glyph',
  'no-space',
  'duplicate-local'
])('uses closed rules and exact glyph advances to split text: %s', (variant) => {
  const str = variant === 'no-space' ? 'StubCohort' : 'Stub Cohort'
  const glyph = (unicode: string): { unicode: string; width: number; isSpace: boolean } => ({
    unicode,
    width: unicode === ' ' ? 1000 : 500,
    isSpace: unicode === ' '
  })
  const a = [...'Stub'].map(glyph),
    b = [...'Cohort'].map(glyph)
  const operators = {
    fnArray: [OPS.setFont, OPS.showText],
    argsArray: [['native', 10], [[...str].map(glyph)]]
  }
  const items = [
    {
      str,
      fontName: 'native',
      dir: 'ltr',
      width: 60,
      height: 10,
      transform: [10, 0, 0, 10, 10, 50],
      hasEOL: true
    }
  ]
  if (variant === 'separate-runs') {
    operators.fnArray.push(OPS.showText)
    operators.argsArray[1] = [a]
    operators.argsArray.push([b])
  }
  if (variant === 'unrelated-ligature' || variant === 'duplicate-local') {
    operators.fnArray.push(OPS.showText)
    operators.argsArray.push([variant === 'duplicate-local' ? [...str].map(glyph) : [glyph('x')]])
    items.push({ ...items[0], str: 'y', transform: [10, 0, 0, 10, 100, 200] })
  }
  const rules = [0, 20, 40, 60].map((y) => [0, y, 90, y])
  for (const x of [0, 35, 70, 90]) rules.push([x, 0, x, 60])
  if (variant === 'missing-edge') rules.splice(5, 1)
  if (variant === 'partial-edge') rules[5] = [35, 0, 35, 20]
  if (variant === 'crossed-glyph') rules[5] = [27, 0, 27, 60]
  const context = {
    rules,
    viewport: {
      rotation: 0,
      scale: 1,
      convertToViewportPoint: (x: number, y: number) => [x, 60 - y]
    }
  }
  const original = structuredClone({ items, operators, rules })
  const result = splitPdfNumericRuns({ items }, operators, context).items
  if (['native', 'separate-runs', 'unrelated-ligature'].includes(variant)) {
    expect(result.slice(0, 2).map((i: { str: string }) => i.str)).toEqual(['Stub', 'Cohort'])
    expect(result[0].width).toBe(20)
    expect(result[1].transform[4]).toBe(40)
    expect(result[1].width).toBe(30)
  } else expect(result).toEqual(items)
  expect({ items, operators, rules }).toEqual(original)
})

it.each([false, true])(
  'matches native local glyph offsets after an astral prefix: measured gutter=%s',
  (measuredGutter) => {
    const glyph = (unicode: string): { unicode: string; width: number } => ({
      unicode,
      width: 500
    })
    const items = [
      {
        str: '45 6',
        fontName: 'native',
        dir: 'ltr',
        width: 20.55,
        height: 10,
        transform: [10, 0, 0, 10, 10, 10]
      }
    ]
    const operators = {
      fnArray: [OPS.setFont, OPS.showText],
      argsArray: [
        ['native', 10],
        [
          measuredGutter
            ? [glyph('𐌀'), glyph('4'), glyph('5'), -555, glyph('6'), glyph('7')]
            : [glyph('𐌀'), glyph('4'), -555, glyph('5'), glyph('6'), -555, glyph('7')]
        ]
      ]
    }
    const viewport = {
      rotation: 0,
      scale: 1,
      convertToViewportPoint: (x: number, y: number): number[] => [x, 20 - y]
    }
    const original = structuredClone({ items, operators })
    const observations = nativeWhitespaceGaps({ items }, operators, viewport)
    expect(observations).toHaveLength(1)
    expect(observations[0].gaps).toEqual(
      measuredGutter ? [{ left: 20, right: 25.55, index: 2 }] : []
    )
    const result = splitPdfNumericRuns({ items }, operators, {
      viewport,
      rules: [],
      provenFrames: [
        { rect: [0, 0, 80, 20], cuts: [22], gutterBands: [[19, 28]], numericOnly: true }
      ]
    }).items
    if (measuredGutter) {
      expect(result.map((item: { str: string }) => item.str)).toEqual(['45', '6'])
      expect(result.map((item: { width: number }) => item.width)).toEqual([10, 5])
      expect(result[1].transform[4]).toBeCloseTo(25.55)
    } else expect(result).toEqual(items)
    expect({ items, operators }).toEqual(original)
  }
)

it.each([
  'native',
  'body-gap-covers-heading-band',
  'gap-outside-band',
  'ambiguous-gap',
  'normal-space'
])('splits a short numeric field only inside one proven native header gutter: %s', (variant) => {
  const ambiguous = variant === 'ambiguous-gap'
  const width = variant === 'normal-space' ? 100 : 555
  const operators = {
    fnArray: [OPS.setFont, OPS.showText],
    argsArray: [
      ['native', 10],
      [
        [
          { unicode: '4', width: 500 },
          { unicode: '5', width: 500 },
          -width,
          { unicode: '6', width: 500 },
          ...(ambiguous ? [-555, { unicode: '7', width: 500 }] : [])
        ]
      ]
    ]
  }
  const items = [
    {
      str: ambiguous ? '45 6 7' : '45 6',
      fontName: 'native',
      dir: 'ltr',
      width: 15 + width / 100 + (ambiguous ? 10.55 : 0),
      height: 10,
      transform: [10, 0, 0, 10, 10, 10]
    }
  ]
  const context = {
    viewport: {
      rotation: 0,
      scale: 1,
      convertToViewportPoint: (x: number, y: number) => [x, 20 - y]
    },
    rules: [],
    provenFrames: [
      {
        rect: [0, 0, 80, 20],
        cuts: [variant === 'gap-outside-band' ? 28 : 22],
        gutterBands: [
          variant === 'gap-outside-band'
            ? [27, 33]
            : variant === 'body-gap-covers-heading-band'
              ? [21, 24]
              : ambiguous
                ? [19, 45]
                : [19, 28]
        ]
      }
    ]
  }
  const before = structuredClone({
    items,
    operators,
    context: { ...context, viewport: undefined }
  })
  const result = splitPdfNumericRuns({ items }, operators, context).items
  if (variant === 'native' || variant === 'body-gap-covers-heading-band') {
    expect(result.map((i: { str: string }) => i.str)).toEqual(['45', '6'])
    expect(result.map((i: { width: number }) => i.width)).toEqual([10, 5])
    expect(result[1].transform[4]).toBeCloseTo(25.55)
  } else expect(result).toEqual(items)
  expect({ items, operators, context: { ...context, viewport: undefined } }).toEqual(before)
})
