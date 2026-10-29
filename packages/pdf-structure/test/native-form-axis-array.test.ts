import { expect, it } from 'vitest'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
const { anonymousScriptedArray } = await import(
  pathToFileURL(resolve('test/fixtures/open-axis-scripted-array.mjs')).href
)
const { nativeFormPlotBounds, nativeFormPlotEvidence } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-form-plot.mjs')).href
)
const { nativeAxisTitlePacket, nativePlotPacketInventory, nativePageTextPacketInventory } =
  await import(
    pathToFileURL(resolve('resources/literature-pdf-figure-native-plot-labels.mjs')).href
  )
const { tableTextToken } = await import(
  pathToFileURL(resolve('resources/literature-pdf-orientation.mjs')).href
)

const nativeSpacingFixture = (
  mode: string
): {
  page: ReturnType<typeof anonymousScriptedArray>['args'][0]
  tokens: ReturnType<typeof anonymousScriptedArray>['args'][5]
  context: ReturnType<typeof anonymousScriptedArray>['args'][6]
} => {
  const fnArray: number[] = [],
    argsArray: unknown[] = [],
    items: Array<{
      str: string
      width: number
      height: number
      transform: number[]
      fontName: string
      sourceItem: { pageNumber: number; index: number; text: string }
    }> = [],
    viewport = {
      width: 200,
      height: 100,
      scale: 1,
      rotation: 0,
      transform: [1, 0, 0, -1, 0, 100],
      convertToViewportPoint: (x: number, y: number): number[] => [x, 100 - y]
    },
    add = (op: number, args: unknown = null): void => {
      fnArray.push(op)
      argsArray.push(args)
    },
    glyph = (text: string, width = 500, isSpace = false): object => ({
      unicode: text,
      fontChar: text,
      width,
      isSpace,
      isInFont: true,
      accent: null
    }),
    source = (text: string, width: number, x = 20, y = 70): void => {
      items.push({
        str: text,
        width,
        height: 10,
        transform: [10, 0, 0, 10, x, y],
        fontName: 'F',
        sourceItem: { pageNumber: 1, index: items.length, text }
      })
    },
    matrix = (x = 20, y = 70): void => add(OPS.setTextMatrix, [[1, 0, 0, 1, x, y]])
  add(OPS.setFont, ['F', 10])
  add(OPS.setCharSpacing, [mode === 'negative-Tc' ? -0.25 : 0.25])
  add(OPS.setWordSpacing, [3])
  add(OPS.beginText)
  matrix()
  if (mode === 'TJ') {
    add(OPS.showText, [[glyph('A'), 120, glyph('B')]])
    source('AB', 9.05)
  } else if (mode === 'ligature') {
    add(OPS.showText, [[glyph('fi', 600), glyph('B')]])
    source('fiB', 11.25)
  } else if (mode === 'space' || mode === 'unencoded-space') {
    add(OPS.showText, [[glyph('A'), glyph(' ', 250, mode === 'space'), glyph('B')]])
    source('A B', mode === 'space' ? 16 : 13)
  } else if (mode === 'save-restore') {
    add(OPS.save)
    add(OPS.setCharSpacing, [2])
    add(OPS.setWordSpacing, [7])
    matrix(50)
    add(OPS.showText, [[glyph('A'), glyph(' ', 250, true), glyph('B')]])
    source('A B', 23.5, 50)
    add(OPS.restore)
    add(OPS.showText, [[glyph('A'), glyph(' ', 250, true), glyph('B')]])
    source('A B', 16)
  } else if (mode === 'BT-Tm') {
    add(OPS.showText, [[glyph('A'), glyph('B')]])
    source('AB', 10.25)
    matrix(50)
    add(OPS.showText, [[glyph('A'), glyph('B')]])
    source('AB', 10.25, 50)
    add(OPS.endText)
    add(OPS.beginText)
    matrix(80)
    add(OPS.showText, [[glyph('A'), glyph(' ', 250, true), glyph('B')]])
    source('A B', 16, 80)
  } else {
    add(OPS.showText, [[glyph('A'), glyph('B')]])
    source('AB', mode === 'negative-Tc' ? 9.75 : 10.25)
  }
  add(OPS.endText)
  const graphicsBounds: unknown[] = [],
    context = {
      operators: { fnArray, argsArray },
      viewport,
      content: { items, styles: { F: { ascent: 0.7, descent: -0.1, vertical: false } } },
      graphicsBounds,
      glyphBounds: [
        {
          fontName: 'F',
          glyphs: [
            { fontChar: 'A', bounds: [0, -0.1, 0.5, 0.7] },
            { fontChar: 'B', bounds: [0, -0.1, 0.5, 0.7] },
            { fontChar: 'fi', bounds: [0, -0.1, 0.6, 0.7] },
            { fontChar: ' ', bounds: [0, 0, 0, 0] }
          ]
        }
      ]
    }
  return {
    page: { pageNumber: 1, width: 200, height: 100, invalidGraphicsBounds: 0, graphicsBounds },
    tokens: items.map((r) => tableTextToken(r, viewport, 0)),
    context
  }
}
it.each([
  'ordinary',
  'negative-Tc',
  'TJ',
  'ligature',
  'space',
  'unencoded-space',
  'save-restore',
  'BT-Tm'
])('binds complete native character/word spacing and source advances for %s', (mode) => {
  const { page, tokens, context } = nativeSpacingFixture(mode),
    before = JSON.stringify({ page, tokens, context }),
    p = nativePageTextPacketInventory(page, tokens, context)
  expect(p).toBeDefined()
  expect(p.records.map((r) => r.r.str)).toEqual(context.content.items.map((r) => r.str))
  expect(JSON.stringify({ page, tokens, context })).toBe(before)
})
it.each(['TJ', 'ligature', 'save-restore'])(
  'does not accept a stale source advance after %s spacing',
  (mode) => {
    const { page, tokens, context } = nativeSpacingFixture(mode)
    context.content.items.at(-1).width += 0.1
    expect(nativePageTextPacketInventory(page, tokens, context)).toBeUndefined()
  }
)
it.each([
  ['Perceptual', false],
  ['RelativeColorimetric', true],
  ['AbsoluteColorimetric', false],
  ['Saturation', true]
])('retains the fixed renderer no-op rendering intent %s', (name, inText) => {
  const { page, tokens, context } = nativeSpacingFixture('ordinary'),
    o = context.operators,
    at = o.fnArray.indexOf(inText ? OPS.showText : OPS.beginText)
  o.fnArray.splice(at, 0, OPS.setRenderingIntent)
  o.argsArray.splice(at, 0, [{ name }])
  const before = JSON.stringify(context)
  expect(nativePageTextPacketInventory(page, tokens, context)).toBeDefined()
  expect(JSON.stringify(context)).toBe(before)
})
it.each([
  'missing',
  'extra-argument',
  'invalid-type',
  'unknown',
  'extra-key',
  'getter',
  'inherited'
])('rejects an unproved rendering intent shape: %s', (mode) => {
  const { page, tokens, context } = nativeSpacingFixture('ordinary'),
    o = context.operators,
    at = o.fnArray.indexOf(OPS.beginText)
  let reads = 0
  const name =
    mode === 'getter'
      ? Object.defineProperty({}, 'name', {
          get: () => {
            reads++
            return 'Perceptual'
          }
        })
      : mode === 'inherited'
        ? Object.create({ name: 'Perceptual' })
        : mode === 'invalid-type'
          ? { name: 1 }
          : mode === 'unknown'
            ? { name: 'Unknown' }
            : mode === 'extra-key'
              ? { name: 'Perceptual', extra: true }
              : { name: 'Perceptual' }
  o.fnArray.splice(at, 0, OPS.setRenderingIntent)
  o.argsArray.splice(
    at,
    0,
    mode === 'missing' ? [] : mode === 'extra-argument' ? [name, 1] : [name]
  )
  expect(nativePageTextPacketInventory(page, tokens, context)).toBeUndefined()
  expect(reads).toBe(0)
})
it.each(['stale-width', 'missing-space-flag', 'wrong-space-flag', 'nonfinite-Tc', 'nonfinite-Tw'])(
  'rejects an incomplete native spacing claim: %s',
  (mode) => {
    const { page, tokens, context } = nativeSpacingFixture('space'),
      o = context.operators,
      show = o.argsArray[o.fnArray.indexOf(OPS.showText)] as [{ isSpace?: boolean }[]]
    if (mode === 'stale-width') context.content.items[0].width -= 0.1
    if (mode === 'missing-space-flag') delete show[0][1].isSpace
    if (mode === 'wrong-space-flag') show[0][1].isSpace = false
    if (mode === 'nonfinite-Tc') o.argsArray[o.fnArray.indexOf(OPS.setCharSpacing)] = [Infinity]
    if (mode === 'nonfinite-Tw') o.argsArray[o.fnArray.indexOf(OPS.setWordSpacing)] = [NaN]
    expect(nativePageTextPacketInventory(page, tokens, context)).toBeUndefined()
  }
)
it('exposes the same strict page inventory without fabricating a figure or caption', () => {
  const { args: a, figure } = anonymousScriptedArray()
  const before = JSON.stringify(a)
  expect(nativePageTextPacketInventory(a[0], a[5], a[6])).toBeUndefined()
  const page = nativePageTextPacketInventory(a[0], a[5], a[6], true)
  const wrapped = nativePlotPacketInventory(a[0], figure, a[1], a[2], a[3], a[5], a[6], true)
  expect(page.records).toEqual(wrapped.records)
  expect(page.packets).toEqual(wrapped.packets)
  expect(page.glyphs).toEqual(wrapped.glyphs)
  expect(page.caption).toBeUndefined()
  expect(page.cap).toBeUndefined()
  expect(
    nativePlotPacketInventory(a[0], { ...figure, caption: {} }, a[1], a[2], a[3], a[5], a[6], true)
  ).toBeUndefined()
  expect(JSON.stringify(a)).toBe(before)
})
it.each([
  ['width', NaN],
  ['height', NaN],
  ['width', Infinity],
  ['height', Infinity]
])('refuses a non-finite original native %s', (field, value) => {
  const { args: a } = anonymousScriptedArray()
  expect(nativePageTextPacketInventory(a[0], a[5], a[6], true)).toBeDefined()
  a[6].content.items[0][field] = value
  expect(nativePageTextPacketInventory(a[0], a[5], a[6], true)).toBeUndefined()
})
it.each(['complete', 'missing-proof', 'changed-space-flag', 'unknown-space-flag', 'painted'])(
  'binds an unencoded renderer-skipped blank to its captured boolean flag: %s',
  (mode) => {
    const { args: a } = skippedOutlineArray(),
      o = a[6].operators
    for (const proof of a[6].skippedSpaceGlyphs) {
      const glyph = o.argsArray[proof.operationIndex][0][proof.glyphIndex]
      glyph.isSpace = false
      proof.isSpace = false
    }
    const first = a[6].skippedSpaceGlyphs[0],
      glyph = o.argsArray[first.operationIndex][0][first.glyphIndex]
    if (mode === 'missing-proof') delete a[6].skippedSpaceGlyphs
    if (mode === 'changed-space-flag') glyph.isSpace = true
    if (mode === 'unknown-space-flag') delete glyph.isSpace
    if (mode === 'painted') glyph.isInFont = true
    const before = JSON.stringify(a),
      packet = nativePageTextPacketInventory(a[0], a[5], a[6], true)
    if (mode === 'complete') {
      expect(packet).toBeDefined()
      expect(
        packet.glyphs.filter((g: { rendererSkipped?: boolean }) => g.rendererSkipped)
      ).toHaveLength(a[6].skippedSpaceGlyphs.length)
    } else expect(packet).toBeUndefined()
    expect(nativePageTextPacketInventory(a[0], a[5], a[6])).toBeUndefined()
    expect(JSON.stringify(a)).toBe(before)
  }
)
const skippedOutlineArray = (): ReturnType<typeof anonymousScriptedArray> => {
  const f = anonymousScriptedArray(),
    o = f.args[6].operators
  f.args[6].glyphBounds[0].glyphs.find((g: { fontChar: string }) => g.fontChar === ' ').bounds = [
    0, 0, 0.5, 0.5
  ]
  f.args[6].skippedSpaceGlyphs = o.fnArray.flatMap((op: number, i: number) =>
    op === OPS.showText
      ? o.argsArray[i][0].flatMap(
          (
            g: { isInFont: boolean; unicode: string; fontChar: string; width: number },
            n: number
          ) =>
            g.isInFont === false && g.unicode === ' '
              ? [
                  {
                    operationIndex: i,
                    glyphIndex: n,
                    fontName: 'F',
                    fontChar: g.fontChar,
                    width: g.width
                  }
                ]
              : []
        )
      : []
  )
  return f
}
it('keeps each proved skipped space advance while another identical font character still paints', () => {
  const { args: a } = skippedOutlineArray(),
    o = a[6].operators
  o.fnArray.push(OPS.beginText, OPS.setFont, OPS.setTextMatrix, OPS.showText, OPS.endText)
  o.argsArray.push(
    null,
    ['F', 5],
    [[1, 0, 0, 1, 100, 200]],
    [[{ unicode: ' ', fontChar: ' ', width: 500, isInFont: true }]],
    null
  )
  const before = JSON.stringify(a)
  const inventory = nativePageTextPacketInventory(a[0], a[5], a[6], true)
  expect(inventory).toBeDefined()
  const spaces = inventory.glyphs.filter((g: { text: string }) => g.text === ' ')
  expect(spaces.filter((g: { rendererSkipped?: boolean }) => g.rendererSkipped)).toHaveLength(
    a[6].skippedSpaceGlyphs.length
  )
  expect(spaces.at(-1).ink).toEqual([100, 97.5, 102.5, 100])
  expect(spaces.at(-1).rendererSkipped).not.toBe(true)
  expect(JSON.stringify(a)).toBe(before)
  expect(nativePageTextPacketInventory(a[0], a[5], a[6])).toBeUndefined()
})
it.each([
  'missing-proof',
  'wrong-operation',
  'wrong-slot',
  'wrong-font',
  'wrong-width',
  'non-space',
  'duplicate-proof'
])('refuses a renderer-skipped space without exact occurrence evidence: %s', (mode) => {
  const { args: a } = skippedOutlineArray(),
    p = a[6].skippedSpaceGlyphs[0]
  if (mode === 'missing-proof') delete a[6].skippedSpaceGlyphs
  if (mode === 'wrong-operation') p.operationIndex++
  if (mode === 'wrong-slot') p.glyphIndex++
  if (mode === 'wrong-font') p.fontName = 'Other'
  if (mode === 'wrong-width') p.width++
  if (mode === 'non-space')
    a[6].operators.argsArray[p.operationIndex][0][p.glyphIndex].unicode = '?'
  if (mode === 'duplicate-proof') a[6].skippedSpaceGlyphs.push({ ...p })
  expect(nativePageTextPacketInventory(a[0], a[5], a[6], true)).toBeUndefined()
})
it('completes a whole scripted title on a proven native panel array without changing claims', () => {
  const { args: a, figure } = anonymousScriptedArray()
  const before = JSON.stringify(a)
  expect(nativeFormPlotBounds(a[0], figure, a[1], a[2], a[5], a[6])).toEqual([40, 75, 360, 201.56])
  expect(JSON.stringify(a)).toBe(before)
  expect(figure.sourceItems).toBeUndefined()
  expect(nativePlotPacketInventory(a[0], figure, a[1], a[2], a[3], a[5], a[6])).toBeUndefined()
  expect(nativePlotPacketInventory(a[0], figure, a[1], a[2], a[3], a[5], a[6], true)).toBeDefined()
  expect(nativeAxisTitlePacket(a[0], figure, a[1], a[2], a[3], a[5], a[6])).toBeUndefined()
})
it.each(['missing-outline', 'painted-space', 'source-alias', 'independent-caption'])(
  'abstains for %s in a complete native array',
  (mode) => {
    const { args: a, figure } = anonymousScriptedArray()
    if (mode === 'missing-outline')
      a[6].glyphBounds[0].glyphs = a[6].glyphBounds[0].glyphs.filter(
        (g: { fontChar: string }) => g.fontChar !== ' '
      )
    if (mode === 'painted-space')
      a[6].glyphBounds[0].glyphs.find((g: { fontChar: string }) => g.fontChar === ' ').bounds = [
        0, 0, 0.2, 0.2
      ]
    if (mode === 'source-alias') a[5].push({ ...a[5][0] })
    if (mode === 'independent-caption') a[1].push({ page: 1, rect: [300, 199, 350, 208] })
    expect(nativeFormPlotBounds(a[0], figure, a[1], a[2], a[5], a[6])).toBeUndefined()
  }
)
it('completes repeated native marker keys, rotated tick labels and centered group labels', () => {
  const { args: a, figure } = anonymousScriptedArray({ markerGroups: true })
  const before = JSON.stringify(a)
  expect(nativeFormPlotBounds(a[0], figure, a[1], a[2], a[5], a[6])).toEqual([40, 64, 360, 201.6])
  expect(JSON.stringify(a)).toBe(before)
})
it.each([
  'missing-key',
  'different-panel-symbol',
  'transparent-key',
  'unknown-blend',
  'foreign-image',
  'unowned-paint',
  'painted-whitespace',
  'word-spacing',
  'malformed-transform',
  'mismatched-scope'
])('keeps marker ownership conservative for %s', (mode) => {
  const { args: a, figure } = anonymousScriptedArray({ markerGroups: true })
  const o = a[6].operators
  if (mode === 'missing-key')
    a[6].content.items.find((r: { str: string }) => r.str === 'Alpha').sourceItem.index = 100
  if (mode === 'different-panel-symbol') {
    let seen = 0
    for (let i = 0; i < o.fnArray.length; i++)
      if (o.fnArray[i] === OPS.setFillRGBColor && o.argsArray[i][0] === '#cc0000') {
        if (seen++) o.argsArray[i] = ['#000000']
      }
  }
  const firstKey = o.fnArray.findIndex(
    (op: number, i: number) => op === OPS.setFillRGBColor && o.argsArray[i][0] === '#cc0000'
  )
  const insert = (at: number, op: number, args: unknown): void => {
    o.fnArray.splice(at, 0, op)
    o.argsArray.splice(at, 0, args)
  }
  if (mode === 'transparent-key') insert(firstKey, OPS.setGState, [[['ca', 0.5]]])
  if (mode === 'unknown-blend') insert(firstKey, OPS.setGState, [[['BM', 'Multiply']]])
  if (mode === 'foreign-image') {
    o.fnArray.push(OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore)
    o.argsArray.push(null, [5, 0, 0, 5, 100, 230], ['image', 5, 5], null)
  }
  if (mode === 'unowned-paint') {
    o.fnArray.push(OPS.constructPath)
    o.argsArray.push([
      OPS.fill,
      [[0, 100, 230, 1, 105, 230, 1, 105, 235, 1, 100, 235, 4]],
      [100, 230, 105, 235]
    ])
  }
  if (mode === 'painted-whitespace') {
    o.fnArray.push(OPS.beginText, OPS.setFont, OPS.setTextMatrix, OPS.showText, OPS.endText)
    o.argsArray.push(
      null,
      ['F', 5],
      [[1, 0, 0, 1, 100, 230]],
      [[{ unicode: ' ', fontChar: ' ', width: 500, isInFont: true }]],
      null
    )
    a[6].glyphBounds[0].glyphs.push({ fontChar: ' ', bounds: [0, 0, 0.5, 0.5] })
  }
  if (mode === 'word-spacing') insert(o.fnArray.indexOf(OPS.beginText) + 1, OPS.setWordSpacing, [2])
  if (mode === 'malformed-transform') o.argsArray[0][0] = [1, 0, 0, 1, 0]
  if (mode === 'mismatched-scope')
    o.fnArray[o.fnArray.indexOf(OPS.paintFormXObjectEnd)] = OPS.restore
  expect(nativeFormPlotBounds(a[0], figure, a[1], a[2], a[5], a[6])).toBeUndefined()
})
it.each(['missing-one-face', 'outside-form-symbols', 'transparent-tick', 'dashed-tick'])(
  'requires native panel coverage and painted in-Form connectors: %s',
  (mode) => {
    const { args: a, figure } = anonymousScriptedArray({ markerGroups: true })
    const o = a[6].operators
    const marks = o.fnArray.flatMap((op: number, i: number) =>
      op === OPS.constructPath &&
      o.argsArray[i][0] === OPS.fillStroke &&
      o.argsArray[i][2][1] === 162
        ? [i]
        : []
    )
    if (mode === 'missing-one-face') {
      o.argsArray[marks[6]] = structuredClone(o.argsArray[marks[0]])
      a[6].graphicsBounds.find(
        (g: { operationIndex: number }) => g.operationIndex === marks[6]
      ).normalizedRect = [
        ...a[6].graphicsBounds.find(
          (g: { operationIndex: number }) => g.operationIndex === marks[0]
        ).normalizedRect
      ]
    }
    if (mode === 'outside-form-symbols')
      for (const i of marks) {
        const args = structuredClone(o.argsArray[i]),
          g = a[6].graphicsBounds.find((g: { operationIndex: number }) => g.operationIndex === i)
        o.argsArray[i][0] = OPS.endPath
        // Restore the exact original paint color outside the Form; geometry alone is insufficient.
        const palette = ['#cc0000', '#00aa00', '#0000cc'],
          n = marks.indexOf(i) % 3
        o.fnArray.push(OPS.setFillRGBColor, OPS.constructPath)
        o.argsArray.push([palette[n]], args)
        a[6].graphicsBounds.push({ ...g, operationIndex: o.fnArray.length - 1 })
      }
    if (mode === 'transparent-tick' || mode === 'dashed-tick') {
      const at = o.fnArray.findIndex(
        (op: number, i: number) =>
          op === OPS.constructPath &&
          o.argsArray[i][0] === OPS.stroke &&
          o.argsArray[i][2][1] === 118
      )
      const addOps =
        mode === 'transparent-tick' ? [OPS.save, OPS.setGState] : [OPS.save, OPS.setDash]
      const addArgs = mode === 'transparent-tick' ? [null, [[['CA', 0]]]] : [null, [[1, 1], 0]]
      o.fnArray.splice(at, 0, ...addOps)
      o.argsArray.splice(at, 0, ...addArgs)
      for (const g of a[6].graphicsBounds) if (g.operationIndex >= at) g.operationIndex += 2
      o.fnArray.splice(at + 3, 0, OPS.restore)
      o.argsArray.splice(at + 3, 0, null)
      for (const g of a[6].graphicsBounds) if (g.operationIndex >= at + 3) g.operationIndex++
    }
    expect(
      nativePlotPacketInventory(a[0], figure, a[1], a[2], a[3], a[5], a[6], true)
    ).toBeDefined()
    expect(nativeFormPlotBounds(a[0], figure, a[1], a[2], a[5], a[6])).toBeUndefined()
  }
)
it('does not use an invisible native title to prove a crop extension', () => {
  const { args: a, figure } = anonymousScriptedArray()
  const o = a[6].operators,
    at =
      o.fnArray.findIndex(
        (op: number, i: number) => op === OPS.setTextMatrix && o.argsArray[i][0][4] === 304
      ) - 2
  o.fnArray.splice(at, 0, OPS.setGState)
  o.argsArray.splice(at, 0, [[['ca', 0]]])
  for (const g of a[6].graphicsBounds) if (g.operationIndex >= at) g.operationIndex++
  expect(nativePlotPacketInventory(a[0], figure, a[1], a[2], a[3], a[5], a[6], true)).toBeDefined()
  expect(nativeFormPlotBounds(a[0], figure, a[1], a[2], a[5], a[6])).toBeUndefined()
})
it.each([false, true])(
  'emits only complete native cardinal owners from proved plot evidence (marker groups: %s)',
  (markerGroups) => {
    const { args: a, figure } = anonymousScriptedArray({ markerGroups })
    const before = JSON.stringify(a)
    const proof = nativeFormPlotEvidence?.(a[0], figure, a[1], a[2], a[5], a[6])
    expect(proof).toBeDefined()
    expect(proof.rect).toEqual(nativeFormPlotBounds(a[0], figure, a[1], a[2], a[5], a[6]))
    const indices = markerGroups
      ? [...Array.from({ length: 12 }, (_, i) => i), 15, 19, 23]
      : Array.from({ length: 13 }, (_, i) => i)
    expect(proof.sourceItems).toEqual(indices.map((index) => a[6].content.items[index].sourceItem))
    expect(JSON.stringify(a)).toBe(before)
  }
)
it.each(['unknown-font', 'source-alias'])('withholds native ownership evidence for %s', (mode) => {
  const { args: a, figure } = anonymousScriptedArray()
  if (mode === 'unknown-font') a[6].content.items[9].fontName = 'unverified'
  if (mode === 'source-alias') a[5].push({ ...a[5][9] })
  expect(nativeFormPlotEvidence?.(a[0], figure, a[1], a[2], a[5], a[6])).toBeUndefined()
})
it.each([
  'half-key',
  'hidden-key',
  'stroke-clipped-key',
  'clipped-panel-symbol',
  'clipped-tick',
  'clipped-axis',
  'invisible-axis',
  'dashed-key'
])('requires fully visible opaque solid native ownership paints: %s', (mode) => {
  const { args: a, figure } = anonymousScriptedArray({ markerGroups: true })
  const o = a[6].operators
  const firstKey =
    o.fnArray.findIndex(
      (op: number, i: number) => op === OPS.setFillRGBColor && o.argsArray[i][0] === '#cc0000'
    ) + 1
  const at = mode.includes('axis')
    ? o.fnArray.findIndex(
        (op: number, i: number) => op === OPS.constructPath && o.argsArray[i][0] === OPS.stroke
      )
    : mode === 'clipped-tick'
      ? o.fnArray.findIndex(
          (op: number, i: number) =>
            op === OPS.constructPath &&
            o.argsArray[i][0] === OPS.stroke &&
            o.argsArray[i][2][1] === 118
        )
      : mode === 'clipped-panel-symbol'
        ? o.fnArray.findIndex(
            (op: number, i: number) =>
              op === OPS.constructPath &&
              o.argsArray[i][0] === OPS.fillStroke &&
              o.argsArray[i][2][1] === 162
          )
        : firstKey
  const raw = o.argsArray[at][2]
  const stateOnly = mode === 'invisible-axis' || mode === 'dashed-key'
  const [l, b, r, t] =
    mode === 'stroke-clipped-key'
      ? raw
      : [
          mode === 'hidden-key' ? raw[2] + 1 : (raw[0] + raw[2]) / 2,
          raw[1] - 2,
          raw[2] + 3,
          raw[3] + 2
        ]
  const ops = stateOnly
    ? [OPS.save, mode === 'invisible-axis' ? OPS.setGState : OPS.setDash]
    : [OPS.save, OPS.clip, OPS.constructPath]
  const args = stateOnly
    ? [null, mode === 'invisible-axis' ? [[['CA', 0]]] : [[1, 1], 0]]
    : [null, null, [OPS.endPath, [[0, l, b, 1, r, b, 1, r, t, 1, l, t, 4]], [l, b, r, t]]]
  o.fnArray.splice(at, 0, ...ops)
  o.argsArray.splice(at, 0, ...args)
  for (const g of a[6].graphicsBounds) if (g.operationIndex >= at) g.operationIndex += ops.length
  o.fnArray.splice(at + ops.length + 1, 0, OPS.restore)
  o.argsArray.splice(at + ops.length + 1, 0, null)
  for (const g of a[6].graphicsBounds)
    if (g.operationIndex >= at + ops.length + 1) g.operationIndex++
  expect(nativePlotPacketInventory(a[0], figure, a[1], a[2], a[3], a[5], a[6], true)).toBeDefined()
  expect(nativeFormPlotEvidence(a[0], figure, a[1], a[2], a[5], a[6])).toBeUndefined()
})
it.each([0.4, 0.3])(
  'uses a convex diamond miter footprint within a native clip of %s',
  (margin) => {
    const { args: a, figure } = anonymousScriptedArray({ markerGroups: true })
    const o = a[6].operators
    o.argsArray[o.fnArray.indexOf(OPS.setMiterLimit)] = [10]
    let color,
      firstKey = -1
    for (let i = 0; i < o.fnArray.length; i++) {
      if (o.fnArray[i] === OPS.setFillRGBColor) color = o.argsArray[i][0]
      if (
        color !== '#cc0000' ||
        o.fnArray[i] !== OPS.constructPath ||
        o.argsArray[i][0] !== OPS.fillStroke
      )
        continue
      if (firstKey < 0) firstKey = i
      const [l, b, r, t] = o.argsArray[i][2],
        x = (l + r) / 2,
        y = (b + t) / 2
      o.argsArray[i][1] = [[0, x, b, 1, r, y, 1, x, t, 1, l, y, 4]]
    }
    const [l, b, r, t] = o.argsArray[firstKey][2].map(
      (n: number, k: number) => n + (k < 2 ? -margin : margin)
    )
    o.fnArray.splice(firstKey, 0, OPS.save, OPS.clip, OPS.constructPath)
    o.argsArray.splice(firstKey, 0, null, null, [
      OPS.endPath,
      [[0, l, b, 1, r, b, 1, r, t, 1, l, t, 4]],
      [l, b, r, t]
    ])
    for (const g of a[6].graphicsBounds) if (g.operationIndex >= firstKey) g.operationIndex += 3
    o.fnArray.splice(firstKey + 4, 0, OPS.restore)
    o.argsArray.splice(firstKey + 4, 0, null)
    for (const g of a[6].graphicsBounds) if (g.operationIndex >= firstKey + 4) g.operationIndex++
    expect(
      nativePlotPacketInventory(a[0], figure, a[1], a[2], a[3], a[5], a[6], true)
    ).toBeDefined()
    const proof = nativeFormPlotEvidence(a[0], figure, a[1], a[2], a[5], a[6])
    expect(Boolean(proof)).toBe(margin > Math.SQRT2 * 0.25)
  }
)

it.each([
  ['Ω', 'Ω'],
  ['é', 'e\u0301'],
  ['e\u0301', 'é']
])(
  'binds canonically equivalent native text %s without rewriting source or glyph text',
  (native, painted) => {
    const { args: a, figure } = anonymousScriptedArray()
    const raw = a[6].content.items.at(-1),
      token = a[5].at(-1)
    raw.str = raw.sourceItem.text = token.text = token.sourceItem.text = native
    a[6].operators.argsArray.at(-2)[0][0].unicode = painted
    const before = JSON.stringify(a)
    const inventory = nativePlotPacketInventory(a[0], figure, a[1], a[2], a[3], a[5], a[6], true)
    expect(inventory).toBeDefined()
    expect(inventory.records.at(-1).r.str).toBe(native)
    expect(inventory.packets.at(-1).text).toBe(painted)
    expect(JSON.stringify(a)).toBe(before)
  }
)
it.each(['compatibility', 'unmapped', 'different-font', 'different-source', 'different-advance'])(
  'rejects a canonical comparison with %s evidence',
  (mode) => {
    const { args: a, figure } = anonymousScriptedArray()
    const raw = a[6].content.items.at(-1),
      token = a[5].at(-1)
    raw.str = raw.sourceItem.text = token.text = token.sourceItem.text = 'Ω'
    const glyph = a[6].operators.argsArray.at(-2)[0][0]
    glyph.unicode = 'Ω'
    if (mode === 'compatibility') {
      raw.str = raw.sourceItem.text = token.text = token.sourceItem.text = 'A'
      glyph.unicode = 'Ａ'
    }
    if (mode === 'unmapped') glyph.isInFont = false
    if (mode === 'different-font') raw.fontName = 'other'
    if (mode === 'different-source') raw.sourceItem.index = 500
    if (mode === 'different-advance') raw.width += 1
    expect(
      nativePlotPacketInventory(a[0], figure, a[1], a[2], a[3], a[5], a[6], true)
    ).toBeUndefined()
  }
)
it('still binds the full raw glyph stream when an external token has already been excluded', () => {
  const { args: a, figure } = anonymousScriptedArray()
  a[5].pop()
  const before = JSON.stringify(a)
  const result = nativePlotPacketInventory(a[0], figure, a[1], a[2], a[3], a[5], a[6], true)
  expect(result.records).toHaveLength(a[6].content.items.length)
  expect(result.records.at(-1).r.str).toBe('C')
  expect(JSON.stringify(a)).toBe(before)
})
