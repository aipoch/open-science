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
