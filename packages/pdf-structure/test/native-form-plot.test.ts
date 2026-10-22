import { expect, it } from 'vitest'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { nativeFormPlotBounds, nativeFormPlotExcludedProse } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-form-plot.mjs')).href
)
const { nativeProseInkTopLimit } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-crop-geometry.mjs')).href
)
const { tableTextToken } = await import(
  pathToFileURL(resolve('resources/literature-pdf-orientation.mjs')).href
)
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function fixture() {
  const fnArray: number[] = [],
    argsArray: unknown[][] = []
  const add = (op: number, args: unknown[] = []): void => {
    fnArray.push(op)
    argsArray.push(args)
  }
  const path = (r: number[]): unknown[] => [
    OPS.fill,
    [[0, r[0], r[1], 1, r[2], r[1], 1, r[2], r[3], 1, r[0], r[3], 4]],
    r
  ]
  add(OPS.paintFormXObjectBegin, [
    [1, 0, 0, 1, 0, 0],
    [40, 80, 460, 410]
  ])
  add(OPS.setFillRGBColor, ['#ffffff'])
  add(OPS.constructPath, path([40, 80, 460, 410]))
  add(OPS.setFillRGBColor, ['#000000'])
  for (const r of [
    [100, 120, 250, 330],
    [260, 120, 430, 330]
  ]) {
    add(OPS.save)
    add(OPS.transform, [r[2] - r[0], 0, 0, r[3] - r[1], r[0], r[1]])
    add(OPS.paintImageXObject, ['image', 10, 10])
    add(OPS.restore)
  }
  for (const r of [
    [55, 180, 65, 270],
    [120, 95, 400, 105],
    [200, 350, 320, 365]
  ])
    add(OPS.constructPath, path(r))
  add(OPS.paintFormXObjectEnd)
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    graphicsBounds: [] as { operationIndex: number; normalizedRect: number[] }[]
  }
  const figure = { rect: [99, 119, 431, 331] }
  const captions = [{ page: 1, rect: [40, 400, 460, 420] }]
  const tokens: { text: string; rect: number[] }[] = []
  const context = {
    operators: { fnArray, argsArray },
    viewport: { scale: 1, rotation: 0, width: 600, height: 800, transform: [1, 0, 0, 1, 0, 0] }
  }
  return {
    run: () => nativeFormPlotBounds(page, figure, captions, [], tokens, context),
    add,
    context,
    page,
    figure,
    captions,
    tokens
  }
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function movedRasterTitle() {
  const f = fixture()
  const viewport = {
    ...f.context.viewport,
    convertToViewportPoint: (x: number, y: number) => [x, y]
  }
  const raw = {
    str: 'T',
    width: 5,
    height: 10,
    fontName: 'F',
    transform: [10, 0, 0, -10, 200, 110],
    sourceItem: { pageNumber: 1, index: 0, text: 'T' }
  }
  const token = tableTextToken(raw, viewport, 0)
  const o = f.context.operators,
    at = o.fnArray.length - 1
  o.fnArray.splice(
    at,
    0,
    OPS.beginText,
    OPS.setFont,
    OPS.setTextMatrix,
    OPS.moveText,
    OPS.showText,
    OPS.endText
  )
  o.argsArray.splice(
    at,
    0,
    [],
    ['F', 10],
    [[1, 0, 0, -1, 200, 100]],
    [0, -10],
    [[{ unicode: 'T', fontChar: 't', width: 500, isInFont: true, accent: null }]],
    []
  )
  const context = {
    ...f.context,
    viewport,
    graphicsBounds: [],
    content: { items: [raw], styles: { F: { ascent: 0.7, descent: -0.1, vertical: false } } },
    glyphBounds: [{ fontName: 'F', glyphs: [{ fontChar: 't', bounds: [0, -0.1, 0.5, 0.7] }] }]
  }
  const figure = { ...f.figure, caption: f.captions[0] }
  return {
    f,
    raw,
    token,
    context,
    figure,
    run: () => nativeFormPlotBounds(f.page, figure, f.captions, [], [token], context)
  }
}
it('retains a moved raster title only with complete native font, advance, scope and ink evidence', () => {
  const f = movedRasterTitle()
  const before = JSON.stringify(f.context)
  expect(f.run()).toEqual([55, 95, 431, 365])
  expect(JSON.stringify(f.context)).toBe(before)
  expect(nativeFormPlotBounds(f.f.page, f.figure, f.f.captions, [], [], f.context)).toBeUndefined()
})
it.each([
  'missing-glyph',
  'source-alias',
  'wrong-advance',
  'transparent',
  'unbounded-form',
  'caption-ink'
])('rejects a moved raster title with %s', (mode) => {
  const { f, raw, token, context, run } = movedRasterTitle()
  if (mode === 'missing-glyph') context.glyphBounds[0].glyphs = []
  if (mode === 'source-alias') raw.sourceItem.index = 7
  if (mode === 'wrong-advance') raw.width = 8
  if (mode === 'transparent') {
    context.operators.fnArray.unshift(OPS.setGState)
    context.operators.argsArray.unshift([[['ca', 0.5]]])
  }
  if (mode === 'unbounded-form') context.operators.argsArray[0] = [null, null]
  if (mode === 'caption-ink') {
    f.captions[0].rect = [40, 366, 460, 420]
    context.glyphBounds[0].glyphs[0].bounds = [0, -26, 0.5, 0.7]
    expect(token.text).toBe('T')
  }
  expect(run()).toBeUndefined()
})

it('retains outlined axes, heading and bottom labels from one isolated raster Form without its blank backdrop', () => {
  expect(fixture().run()).toEqual([55, 95, 431, 365])
})
it('does not absorb adjacent native prose into the Form', () => {
  const f = fixture()
  f.tokens.push({ text: 'Unrelated discussion', rect: [50, 340, 180, 355] })
  expect(f.run()).toBeUndefined()
})
it('rejects foreground that intersects a caption', () => {
  const f = fixture()
  f.captions[0].rect = [40, 360, 460, 420]
  expect(f.run()).toBeUndefined()
})
it('does not discard a colored backdrop that intersects a caption', () => {
  const f = fixture()
  f.context.operators.argsArray[1] = ['#ff0000']
  expect(f.run()).toBeUndefined()
})
it('rejects a newly absorbed graphic from outside the owning Form', () => {
  const f = fixture()
  f.page.graphicsBounds.push({
    operationIndex: -1,
    normalizedRect: [50 / 600, 345 / 800, 80 / 600, 360 / 800]
  })
  expect(f.run()).toBeUndefined()
})
it('requires every Form text run to have a native text counterpart', () => {
  const f = fixture()
  const i = f.context.operators.fnArray.length - 1
  f.context.operators.fnArray.splice(i, 0, OPS.setFont, OPS.showText)
  f.context.operators.argsArray.splice(i, 0, ['plot-font', 10], [[{ unicode: 'Axis' }]])
  expect(f.run()).toBeUndefined()
})
it('rejects a Form inheriting a nonstandard blend mode', () => {
  const f = fixture()
  f.context.operators.fnArray.unshift(OPS.setGState)
  f.context.operators.argsArray.unshift([[['BM', 'multiply']]])
  expect(f.run()).toBeUndefined()
})
it('abstains from an unbounded Form after an unknown inner clipping path', () => {
  const f = fixture()
  f.context.operators.fnArray = [
    OPS.paintFormXObjectBegin,
    OPS.constructPath,
    OPS.constructPath,
    OPS.paintFormXObjectEnd
  ]
  f.context.operators.argsArray = [
    [null, null],
    [OPS.eoClip, [[0, 50, 50, 1, 400, 50, 1, 200, 400, 4]], [50, 50, 400, 400]],
    [OPS.fill, [[0, 100, 100, 1, 200, 100, 1, 200, 200, 1, 100, 200, 4]], [100, 100, 200, 200]],
    []
  ]
  expect(f.run()).toBeUndefined()
})
it('keeps native prose descenders out of crop padding above a completely proved Form', () => {
  const rect = [50, 100, 450, 350]
  const prose = { text: 'A preceding paragraph', x: 60, y: 87.4, width: 300, height: 10 }
  const heading = { text: 'Owned plot heading', x: 80, y: 105, width: 200, height: 10 }
  const tokens = [prose, heading].map((l) => ({
    text: l.text,
    rect: [l.x, l.y, l.x + l.width, l.y + l.height],
    baseline: l.y + l.height,
    horizontal: true,
    height: l.height,
    fontDescent: -0.2
  }))
  const excludedProseLines = nativeFormPlotExcludedProse({ lines: [prose, heading] }, rect, tokens)
  expect(excludedProseLines).toEqual([prose])
  const top = nativeProseInkTopLimit({ rect, excludedProseLines }, tokens)
  expect(top).toBeCloseTo(99.9)
  expect(top).toBeLessThan(rect[1])
})

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function connectedPanels() {
  const fnArray: number[] = [],
    argsArray: unknown[][] = []
  const add = (op: number, args: unknown[] = []): number => {
    fnArray.push(op)
    argsArray.push(args)
    return fnArray.length - 1
  }
  const rectangle = (r: number[]): unknown[] => [
    OPS.fillStroke,
    [[0, r[0], r[1], 1, r[2], r[1], 1, r[2], r[3], 1, r[0], r[3], 4]],
    r
  ]
  add(OPS.paintFormXObjectBegin, [null, [40, 60, 360, 420]])
  add(OPS.setLineWidth, [1])
  const upper = add(OPS.constructPath, rectangle([60, 80, 340, 220]))
  const lower = add(OPS.constructPath, rectangle([60, 250, 340, 400]))
  add(OPS.save)
  const width = add(OPS.setLineWidth, [2.4])
  const shaft = add(OPS.constructPath, [
    OPS.stroke,
    [[0, 200, 220.5, 1, 200, 241]],
    [200, 220.5, 200, 241]
  ])
  add(OPS.save)
  const headTransform = add(OPS.transform, [0, 1, -1, 0, 200, 241])
  add(OPS.setLineWidth, [2])
  const join = add(OPS.setLineJoin, [0])
  const head = add(OPS.constructPath, [
    OPS.fillStroke,
    [[0, 4, 0, 2, 3.5, 0.125, 1.5, 0.8, 0, 1.5, 1, 0, -1.5, 2, 1.5, -0.8, 3.5, -0.125, 4, 0, 4]],
    [0, -1.5, 4, 1.5]
  ])
  add(OPS.restore)
  add(OPS.restore)
  add(OPS.beginText)
  add(OPS.setFont, ['diagram-font', 10])
  add(OPS.setTextMatrix, [1, 0, 0, 1, 90, 110])
  add(OPS.showText, [[{ unicode: 'Input stage' }]])
  add(OPS.moveText, [0, 170])
  add(OPS.showText, [[{ unicode: 'Output stage' }]])
  add(OPS.endText)
  add(OPS.paintFormXObjectEnd)
  const tokens = [
    { text: 'Input stage', rect: [90, 100, 150, 110], fontName: 'diagram-font' },
    { text: 'Output stage', rect: [90, 270, 150, 280], fontName: 'diagram-font' }
  ]
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    graphicsBounds: [] as { operationIndex: number; normalizedRect: number[] }[]
  }
  const figure = { rect: [55, 245, 345, 407], caption: { page: 1, rect: [40, 430, 360, 450] } }
  const captions = [{ page: 1, rect: [40, 430, 360, 450] }]
  const context = {
    operators: { fnArray, argsArray },
    viewport: { scale: 1, rotation: 0, width: 600, height: 800, transform: [1, 0, 0, 1, 0, 0] }
  }
  return {
    run: () => nativeFormPlotBounds(page, figure, captions, [], tokens, context),
    fnArray,
    argsArray,
    tokens,
    page,
    figure,
    captions,
    rectangle,
    indices: { upper, lower, width, shaft, headTransform, join, head },
    insert: (i: number, op: number, args: unknown[]): void => {
      fnArray.splice(i, 0, op)
      argsArray.splice(i, 0, args)
    }
  }
}

it('restores a complete upper panel through a strict native arrow in the same Form, without publishing sources', () => {
  const f = connectedPanels(),
    before = JSON.stringify([f.fnArray, f.argsArray, f.tokens])
  expect(f.run()).toEqual([55, 75, 345, 407])
  expect(JSON.stringify([f.fnArray, f.argsArray, f.tokens])).toBe(before)
})

it.each([
  [
    'malformed head',
    (f: ReturnType<typeof connectedPanels>): void => {
      ;(f.argsArray[f.indices.head][1] as number[][])[0][15] = -0.7
    }
  ],
  [
    'detached head base',
    (f: ReturnType<typeof connectedPanels>): void => {
      f.argsArray[f.indices.headTransform][4] = 201
    }
  ],
  [
    'reversed head direction',
    (f: ReturnType<typeof connectedPanels>): void => {
      f.argsArray[f.indices.headTransform] = [0, -1, 1, 0, 200, 241]
    }
  ],
  [
    'source midpoint mismatch',
    (f: ReturnType<typeof connectedPanels>): void => {
      ;(f.argsArray[f.indices.shaft][1] as number[][])[0][1] = 201
    }
  ],
  [
    'target midpoint mismatch',
    (f: ReturnType<typeof connectedPanels>): void => {
      f.argsArray[f.indices.lower] = f.rectangle([70, 250, 350, 400])
    }
  ],
  [
    'two target frames',
    (f: ReturnType<typeof connectedPanels>): void => {
      f.insert(f.indices.lower, OPS.constructPath, f.rectangle([70, 250, 330, 395]))
    }
  ],
  [
    'gap exceeds native stroke',
    (f: ReturnType<typeof connectedPanels>): void => {
      f.argsArray[f.indices.lower] = f.rectangle([60, 260, 340, 400])
    }
  ],
  [
    'arrow clipped',
    (f: ReturnType<typeof connectedPanels>): void => {
      f.insert(f.indices.shaft, OPS.constructPath, [
        OPS.clip,
        [[0, 40, 60, 1, 360, 60, 1, 360, 240, 1, 40, 240, 4]],
        [40, 60, 360, 240]
      ])
    }
  ],
  [
    'transparent shaft',
    (f: ReturnType<typeof connectedPanels>): void => {
      f.insert(f.indices.shaft, OPS.setGState, [[['CA', 0.5]]])
    }
  ],
  [
    'dashed shaft',
    (f: ReturnType<typeof connectedPanels>): void => {
      f.insert(f.indices.shaft, OPS.setDash, [[2, 2], 0])
    }
  ],
  [
    'miter limit clips tip',
    (f: ReturnType<typeof connectedPanels>): void => {
      f.insert(f.indices.head, OPS.setMiterLimit, [2])
    }
  ],
  [
    'non-miter head join',
    (f: ReturnType<typeof connectedPanels>): void => {
      f.argsArray[f.indices.join] = [1]
    }
  ],
  [
    'caption in expanded region',
    (f: ReturnType<typeof connectedPanels>): void => {
      f.captions.push({ page: 1, rect: [70, 130, 200, 145] })
    }
  ],
  [
    'unmatched native prose',
    (f: ReturnType<typeof connectedPanels>): void => {
      f.tokens.push({ text: 'Other paragraph', rect: [90, 130, 180, 140], fontName: 'body-font' })
    }
  ],
  [
    'foreign graphic',
    (f: ReturnType<typeof connectedPanels>): void => {
      f.page.graphicsBounds.push({
        operationIndex: -1,
        normalizedRect: [80 / 600, 130 / 800, 180 / 600, 140 / 800]
      })
    }
  ],
  [
    'frames in different Forms',
    (f: ReturnType<typeof connectedPanels>): void => {
      f.insert(f.indices.lower, OPS.paintFormXObjectEnd, [])
      f.insert(f.indices.lower + 1, OPS.paintFormXObjectBegin, [null, [40, 60, 360, 420]])
    }
  ],
  [
    'unknown paint',
    (f: ReturnType<typeof connectedPanels>): void => {
      f.insert(f.indices.head, OPS.shadingFill, ['unknown'])
    }
  ]
])('rejects connected panels with %s', (_label, mutate) => {
  const f = connectedPanels()
  mutate(f)
  expect(f.run()).toBeUndefined()
})

it('does not broaden the existing raster Form witness with newly supported text positioning', () => {
  const f = fixture(),
    end = f.context.operators.fnArray.length - 1
  f.context.operators.fnArray.splice(end, 0, OPS.setFont, OPS.moveText, OPS.showText)
  f.context.operators.argsArray.splice(
    end,
    0,
    ['label-font', 10],
    [0, 10],
    [[{ unicode: 'Label' }]]
  )
  f.tokens.push(
    Object.assign({ text: 'Label', rect: [200, 350, 240, 360] }, { fontName: 'label-font' })
  )
  expect(f.run()).toBeUndefined()
})

it('rejects a competing arrow target even when it lies outside the previous crop', () => {
  const f = connectedPanels()
  f.insert(f.indices.lower, OPS.constructPath, f.rectangle([54, 250, 346, 390]))
  expect(f.run()).toBeUndefined()
})

it('requires the connected panels to belong to the existing figure caption on this page', () => {
  const f = connectedPanels()
  f.figure.caption.page = 2
  expect(f.run()).toBeUndefined()
})
