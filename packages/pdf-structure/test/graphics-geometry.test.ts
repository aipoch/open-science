import { createRequire } from 'node:module'
import { resolve } from './paths'
import { pathToFileURL } from 'node:url'
import { createCanvas } from '@napi-rs/canvas'
import { expect, it } from 'vitest'

const {
  collectTableRules,
  collectClosedFigureFrames,
  collectGraphicsBounds,
  excludeRepeatedMarginContent,
  excludeRemovedMarginTokens
} = await import(pathToFileURL(resolve('resources/literature-pdf-graphics.mjs')).href)
const { getDocument, OPS } = await import(
  pathToFileURL(createRequire(import.meta.url).resolve('pdfjs-dist/legacy/build/pdf.mjs')).href
)
const { associateFigures } = await import(
  pathToFileURL(resolve('resources/literature-pdf-association.mjs')).href
)
const {
  captureNativeFigureRenderContext,
  matchNativeFigureRenderContext,
  recordNativeFigurePaths
} = await import(pathToFileURL(resolve('resources/literature-pdf-render-bounds.mjs')).href)

it.each(['closeFillStroke', 'closeEOFillStroke'])(
  'accepts an explicitly closed native rectangle painted with %s',
  (paint) => {
    const path = Float32Array.from([0, 10, 10, 1, 30, 10, 1, 30, 20, 1, 10, 20, 4])
    const operators = {
      fnArray: [OPS.transform, OPS.constructPath],
      argsArray: [
        [2, 0, 0, 2, 5, 7],
        [OPS[paint], [path], [10, 10, 30, 20]]
      ]
    }
    const viewport = { width: 100, height: 100, transform: [1, 0, 0, -1, 0, 100] }
    expect(collectClosedFigureFrames(operators, viewport)).toEqual([[25, 53, 65, 73]])
  }
)

it.each(['closeFillStroke', 'closeEOFillStroke'])(
  'does not let %s bypass explicit contour or paint-domain proof',
  (paint) => {
    const rectangle = [0, 10, 10, 1, 30, 10, 1, 30, 20, 1, 10, 20, 4]
    const cases = [
      { name: 'implicit closure only', path: rectangle.slice(0, -1) },
      { name: 'closed non-rectangular contour', path: [0, 10, 10, 1, 30, 10, 1, 30, 20, 4] },
      { name: 'unknown path command', path: [0, 10, 10, 9, ...rectangle.slice(4)] },
      { name: 'extra painted subpath', path: [0, 1, 1, 1, 5, 5, ...rectangle] },
      { name: 'clipped perimeter', width: 25 },
      { name: 'invisible stroke', op: OPS.setGState, args: [[['CA', 0]]] },
      { name: 'zero stroke width', op: OPS.setLineWidth, args: [0] },
      { name: 'sheared perimeter', op: OPS.transform, args: [1, 0.2, 0, 1, 0, 0] }
    ]
    for (const sample of cases) {
      const operators = {
        fnArray: [...(sample.op === undefined ? [] : [sample.op]), OPS.constructPath],
        argsArray: [
          ...(sample.args === undefined ? [] : [sample.args]),
          [OPS[paint], [Float32Array.from(sample.path ?? rectangle)], [10, 10, 30, 20]]
        ]
      }
      expect(
        collectClosedFigureFrames(operators, {
          width: sample.width ?? 100,
          height: 100,
          transform: [1, 0, 0, 1, 0, 0]
        }),
        sample.name
      ).toEqual([])
    }
  }
)

it('accepts equivalent rounded contours with or without a trailing unpainted move', () => {
  const closed = [
    0, 15, 10, 1, 85, 10, 2, 90, 10, 90, 10, 90, 15, 1, 90, 35, 2, 90, 40, 90, 40, 85, 40, 1, 15,
    40, 2, 10, 40, 10, 40, 10, 35, 1, 10, 15, 2, 10, 10, 10, 10, 15, 10, 4
  ]
  const run = (path: number[], width = 100): number[][] =>
    collectClosedFigureFrames(
      {
        fnArray: [OPS.constructPath],
        argsArray: [[OPS.closeFillStroke, [Float32Array.from(path)], [10, 10, 90, 40]]]
      },
      { width, height: 100, transform: [1, 0, 0, 1, 0, 0] }
    )
  expect(run([...closed, 0, 2, 2])).toEqual([[10, 10, 90, 40]])
  expect(run(closed)).toEqual([[10, 10, 90, 40]])
  expect(run(closed.slice(0, -1))).toEqual([])
  for (const [index, value] of [
    [41, 16],
    [16, 9],
    [7, 95],
    [14, 89]
  ]) {
    expect(run(closed.map((n, i) => (i === index ? value : n)))).toEqual([])
  }
  expect(run([...closed, 0, 2, 2, 1, 4, 4])).toEqual([])
  expect(run(closed, 85)).toEqual([])
})

const renderContextInput = (): ReturnType<typeof JSON.parse> => {
  const viewport = {
    width: 200,
    height: 300,
    scale: 1,
    rotation: 0,
    transform: [1, 0, 0, -1, 0, 300]
  }
  const content = {
    items: [
      {
        str: 'Generic panel heading',
        dir: 'ltr',
        width: 90,
        height: 10,
        transform: [10, 0, 0, 10, 20, 250],
        fontName: 'first-font',
        hasEOL: true
      }
    ],
    styles: {
      'first-font': { ascent: 0.8, descent: -0.2, vertical: false, fontFamily: 'sans-serif' }
    }
  }
  const graphics = [{ operationIndex: 2, kind: 'image', normalizedRect: [0.1, 0.2, 0.5, 0.6] }]
  const operators = {
    fnArray: [OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore],
    argsArray: [[], [80, 0, 0, 120, 20, 120], ['generic-image', 100, 100], []]
  }
  const render = {
    _internalRenderTask: {
      operatorList: operators,
      params: {
        viewport: {
          width: 300,
          height: 450,
          scale: 1.5,
          rotation: 0,
          transform: [1.5, 0, 0, -1.5, 0, 450]
        }
      }
    }
  }
  return { viewport, content, graphics, render, checksum: 'a'.repeat(64), page: 1 }
}

it('retains only same-operation decoded RGB image opacity evidence', () => {
  const f = renderContextInput()
  f.render._internalRenderTask.objs = {
    get: () => ({ width: 100, height: 100, kind: 2, data: new Uint8Array(30000) })
  }
  const snapshot = captureNativeFigureRenderContext(
    f.render,
    f.page,
    f.content,
    f.viewport,
    f.graphics,
    f.checksum
  )
  expect(snapshot?.opaqueRasterImages).toEqual([
    { operationIndex: 2, imageId: 'generic-image', width: 100, height: 100, kind: 2 }
  ])
  expect(
    matchNativeFigureRenderContext(snapshot, f.page, f.content, f.viewport, f.graphics, f.checksum)
      ?.opaqueRasterImages
  ).toEqual(snapshot.opaqueRasterImages)
})
it.each(['rgba', 'bitmap', 'missing bytes', 'wrong dimensions', 'unresolved', 'wrong operation'])(
  'does not infer opaque image evidence from %s',
  (mode) => {
    const f = renderContextInput(),
      image: ReturnType<typeof JSON.parse> = {
        width: 100,
        height: 100,
        kind: 2,
        data: new Uint8Array(30000)
      }
    if (mode === 'rgba') {
      image.kind = 3
      image.data = new Uint8Array(40000)
    }
    if (mode === 'bitmap') {
      delete image.data
      image.bitmap = {}
    }
    if (mode === 'missing bytes') image.data = new Uint8Array(29999)
    if (mode === 'wrong dimensions') image.width = 99
    if (mode === 'wrong operation')
      f.render._internalRenderTask.operatorList.fnArray[2] = OPS.paintImageXObjectRepeat
    f.render._internalRenderTask.objs = {
      get: () => {
        if (mode === 'unresolved') throw new Error('not loaded')
        return image
      }
    }
    const snapshot = captureNativeFigureRenderContext(
      f.render,
      f.page,
      f.content,
      f.viewport,
      f.graphics,
      f.checksum
    )
    expect(snapshot).toBeDefined()
    expect(snapshot.opaqueRasterImages).toBeUndefined()
  }
)
it('shares one snapshot budget between glyph bounds and decoded-image metadata', () => {
  const f = renderContextInput(),
    operators = f.render._internalRenderTask.operatorList
  f.render._internalRenderTask.params.viewport = { ...f.viewport }
  f.content = { items: [], styles: { padding: 'x'.repeat(8050000) } }
  operators.fnArray = [OPS.setFont, OPS.showText]
  operators.argsArray = [
    ['font', 10],
    [Array.from({ length: 1000 }, (_, n) => ({ fontChar: 'g' + n }))]
  ]
  for (let n = 0; n < 1000; n++) {
    operators.fnArray.push(OPS.paintImageXObject)
    operators.argsArray.push(['image' + n, 1, 1])
  }
  f.render._internalRenderTask.objs = {
    get: () => ({ kind: 2, width: 1, height: 1, data: new Uint8Array(3) })
  }
  const fonts = {
    get: () => ({
      loadedName: 'font',
      missingFile: false,
      getPathGenerator: () => ({ getBounds: () => [0, 0, 1, 1] })
    })
  }
  const plain = captureNativeFigureRenderContext(
    f.render,
    f.page,
    f.content,
    f.viewport,
    [],
    f.checksum
  )
  expect(plain?.opaqueRasterImages).toHaveLength(1000)
  const combined = captureNativeFigureRenderContext(
    f.render,
    f.page,
    f.content,
    f.viewport,
    [],
    f.checksum,
    fonts
  )
  expect(combined?.glyphBounds[0].glyphs).toHaveLength(1000)
  expect(combined?.opaqueRasterImages).toBeUndefined()
})
it('hands off an isolated same-render context with exact source identities across font cache names', () => {
  const f = renderContextInput(),
    snapshot = captureNativeFigureRenderContext(
      f.render,
      f.page,
      f.content,
      f.viewport,
      f.graphics,
      f.checksum
    )
  expect(snapshot).toBeDefined()
  const current = structuredClone(f.content)
  current.items[0].fontName = 'second-font'
  current.styles = { 'second-font': current.styles['first-font'] }
  const matched = matchNativeFigureRenderContext(
    snapshot,
    f.page,
    current,
    f.viewport,
    f.graphics,
    f.checksum
  )
  expect(matched?.graphicsBounds).toEqual(f.graphics)
  expect(matched?.viewport.convertToViewportPoint(20, 250)).toEqual([20, 50])
  expect(matched?.operators.fnArray[2]).toBe(OPS.paintImageXObject)
  expect(matched?.content.items[0].sourceItem).toEqual({
    pageNumber: 1,
    index: 0,
    text: 'Generic panel heading'
  })
  f.render._internalRenderTask.operatorList.fnArray[2] = OPS.showText
  f.content.items[0].str = 'Changed after capture'
  expect(matched?.operators.fnArray[2]).toBe(OPS.paintImageXObject)
  expect(matched?.content.items[0].str).toBe('Generic panel heading')
})
it.each([
  'document',
  'page',
  'text',
  'identity-order',
  'font',
  'transform',
  'width',
  'direction',
  'viewport',
  'graphics',
  'missing-item'
])('refuses a render-context handoff with different %s evidence', (failure) => {
  const f = renderContextInput(),
    snapshot = captureNativeFigureRenderContext(
      f.render,
      f.page,
      f.content,
      f.viewport,
      f.graphics,
      f.checksum
    )
  if (failure === 'document') f.checksum = 'b'.repeat(64)
  if (failure === 'page') f.page = 2
  if (failure === 'text') f.content.items[0].str = 'Other'
  if (failure === 'identity-order')
    f.content.items.unshift({ ...f.content.items[0], str: 'Inserted' })
  if (failure === 'font') f.content.styles['first-font'].ascent = 0.6
  if (failure === 'transform') f.content.items[0].transform[4] += 1
  if (failure === 'width') f.content.items[0].width += 1
  if (failure === 'direction') f.content.items[0].dir = 'rtl'
  if (failure === 'viewport') f.viewport.transform[5] += 1
  if (failure === 'graphics') f.graphics[0].operationIndex = 3
  if (failure === 'missing-item') f.content.items = []
  expect(
    matchNativeFigureRenderContext(snapshot, f.page, f.content, f.viewport, f.graphics, f.checksum)
  ).toBeUndefined()
})
it('refuses offset render coordinates and a context over the bounded snapshot budget', () => {
  const f = renderContextInput()
  f.render._internalRenderTask.params.viewport.transform[4] = 5
  expect(
    captureNativeFigureRenderContext(
      f.render,
      f.page,
      f.content,
      f.viewport,
      f.graphics,
      f.checksum
    )
  ).toBeUndefined()
  f.render._internalRenderTask.params.viewport.transform[4] = 0
  f.render._internalRenderTask.operatorList.argsArray[0] = [new Uint8Array(17 * 1024 * 1024)]
  expect(
    captureNativeFigureRenderContext(
      f.render,
      f.page,
      f.content,
      f.viewport,
      f.graphics,
      f.checksum
    )
  ).toBeUndefined()
})

it('preserves separate straight rules in a compound stroke without bridging their gaps', () => {
  const path = new Float32Array([0, 10, 20, 1, 80, 20, 0, 20, 40, 1, 40, 40, 0, 50, 40, 1, 80, 40])
  expect(
    collectTableRules(
      { fnArray: [OPS.constructPath], argsArray: [[OPS.stroke, [path], [10, 20, 80, 40]]] },
      { transform: [1.5, 0, 0, 1.5, 0, 0] }
    )
  ).toEqual([
    [15, 30, 120, 30],
    [30, 60, 60, 60],
    [75, 60, 120, 60]
  ])
})

it('measures the actual unit rectangle painted by a solid-color mask as a thin native rule', () => {
  const operators = {
    fnArray: [OPS.save, OPS.transform, OPS.paintSolidColorImageMask, OPS.restore],
    argsArray: [[], [200, 0, 0, -0.5, 20, 40], [], []]
  }
  const viewport = { transform: [1, 0, 0, 1, 0, 0], width: 500, height: 500 }
  const paint = new Map()
  const before = structuredClone(operators)
  expect(collectTableRules(operators, viewport, paint)).toEqual([[20, 39.75, 220, 39.75]])
  expect([...paint.values()]).toEqual([[20, 39.5, 220, 40]])
  expect(operators).toEqual(before)
  for (const variant of ['transparent', 'blend', 'clip', 'white', 'skew', 'nonfinite', 'wide']) {
    const input = structuredClone(operators)
    if (variant === 'transparent' || variant === 'blend') {
      input.fnArray.unshift(OPS.setGState)
      input.argsArray.unshift([
        [variant === 'transparent' ? ['ca', 0.5] : ['BM', 'Multiply']]
      ] as never)
    }
    if (variant === 'clip') {
      input.fnArray.unshift(OPS.clip)
      input.argsArray.unshift([])
    }
    if (variant === 'white') {
      input.fnArray.unshift(OPS.setFillRGBColor)
      input.argsArray.unshift(['#ffffff'] as never)
    }
    if (variant === 'skew') input.argsArray[1][1] = 5
    if (variant === 'nonfinite') input.argsArray[1][0] = NaN
    if (variant === 'wide') input.argsArray[1][3] = -20
    expect(collectTableRules(input, viewport), variant).toEqual([])
  }
})

it('recomputes solid-color mask eligibility from independent fill graphics state', () => {
  const operators = {
    fnArray: [OPS.save, OPS.transform, OPS.paintSolidColorImageMask, OPS.restore],
    argsArray: [[], [200, 0, 0, -0.5, 20, 40], [], []]
  }
  const viewport = { transform: [1, 0, 0, 1, 0, 0], width: 500, height: 500 }
  const expected = [[20, 39.75, 220, 39.75]]

  for (const [name, entries] of [
    ['stroke alpha', [['CA', 0.5]]],
    ['inactive false soft mask', [['SMask', false]]],
    ['inactive null soft mask', [['SMask', null]]],
    ['inactive None soft mask', [['SMask', 'None']]]
  ]) {
    const input = structuredClone(operators)
    input.fnArray.unshift(OPS.setGState)
    input.argsArray.unshift([entries] as never)
    expect(collectTableRules(input, viewport), name).toEqual(expected)
  }

  for (const [name, invalid, valid] of [
    ['alpha', ['ca', 0.5], ['ca', 1]],
    ['blend mode', ['BM', 'Multiply'], ['BM', 'Normal']],
    ['soft mask', ['SMask', {}], ['SMask', false]]
  ]) {
    const input = structuredClone(operators)
    input.fnArray.unshift(OPS.setGState, OPS.setGState)
    input.argsArray.unshift([[invalid]] as never, [[valid]] as never)
    expect(collectTableRules(input, viewport), `recovers ${name}`).toEqual(expected)
  }
})

it('excludes repeated running headers near an image but keeps labels inside its bounds', () => {
  const header = { text: 'A. Author et al.', x: 36, y: 34, width: 72, height: 8 }
  const journal = { text: 'Journal 146 (2025)', x: 420, y: 34, width: 144, height: 8 }
  const label = { text: 'Sample A', x: 120, y: 52, width: 60, height: 8 }
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [header, journal, label],
    graphicsBounds: [
      { kind: 'image', normalizedRect: [0.1, 0.06, 0.9, 0.5] },
      { kind: 'path', normalizedRect: [0, 0, 1, 1] }
    ]
  }
  const [clean] = excludeRepeatedMarginContent([page, { ...page, pageNumber: 2 }])
  expect(clean.lines).toEqual([label])
  const tokens = page.lines.map((l) => ({
    text: l.text,
    rect: [l.x, l.y, l.x + l.width, l.y + l.height].map((v) => v * 1.5)
  }))
  expect(excludeRemovedMarginTokens(tokens, page, clean, 1.5)).toEqual([tokens[2]])
  expect(excludeRemovedMarginTokens(tokens, page, page, 1.5)).toEqual(tokens)
  expect(
    associateFigures(clean, [{ page: 1, lines: ['Fig. 1. Results'], rect: [60, 410, 540, 440] }])[0]
      .rect
  ).toEqual([60, 48, 540, 400])
  expect(excludeRepeatedMarginContent([page])[0].lines).toEqual(page.lines)
})

it('bounds native geometry reads when excluding a header above a dense vector plot', () => {
  const count = 400
  let reads = 0
  const header = {
    text: 'A repeated journal header',
    x: 40,
    y: 30,
    width: 180,
    height: 9,
    fontSize: 9
  }
  const graphics = Array.from({ length: count }, (_, index) => ({
    kind: 'path',
    get normalizedRect() {
      reads++
      const x = 0.2 + (index % 20) * 0.02
      const y = 0.2 + Math.floor(index / 20) * 0.02
      return [x, y, x + 0.005, y + 0.005]
    }
  }))
  const pages = [1, 2].map((pageNumber) => ({
    pageNumber,
    width: 600,
    height: 800,
    lines: [header],
    graphicsBounds: graphics,
    invalidGraphicsBounds: 0
  }))
  const cleaned = excludeRepeatedMarginContent(pages)
  expect(cleaned.map((page: { lines: unknown[] }) => page.lines)).toEqual([[], []])
  expect(cleaned.map((page: { graphicsBounds: unknown[] }) => page.graphicsBounds.length)).toEqual([
    count,
    count
  ])
  // Count real geometry access, not wall time: a scan nested inside the graphic
  // overlap check must fail even on a fast machine without a timing threshold.
  expect(reads).toBeLessThan(count * 50)
})

it.each([
  [420, 578],
  [640, 578],
  [640, 9]
])(
  'keeps repeated vertical publication notices out of a figure ending at %s with margin x=%s',
  (bottom, marginX) => {
    const line = (
      text: string,
      x: number,
      y: number,
      height: number
    ): {
      text: string
      x: number
      y: number
      width: number
      height: number
      fontSize: number
    } => ({
      text,
      x,
      y,
      width: 9,
      height,
      fontSize: 9
    })
    const notices = [
      line('First published online. Downloaded from', marginX, 32, 345),
      line('https://journal.example/', marginX, 380, 74),
      line('Protected by copyright.', marginX, 457, 305)
    ]
    const axis = line('Cell viability', 550, 100, 85)
    const sample = {
      pageNumber: 8,
      width: 595,
      height: 794,
      invalidGraphicsBounds: 0,
      lines: [...notices, axis],
      graphicsBounds: [
        { kind: 'path', normalizedRect: [0.07, 0.024, 0.934, 0.054] },
        { kind: 'image', normalizedRect: [0.07, 0.059, 0.934, bottom / 794] }
      ]
    }
    const [filtered] = excludeRepeatedMarginContent([sample, { ...sample, pageNumber: 9 }])
    const [figure] = associateFigures(filtered, [
      { page: 8, lines: ['Figure 1. Results'], rect: [42, bottom + 4, 555, bottom + 40] }
    ])
    expect(figure.rect).toEqual([595 * 0.07, 794 * 0.059, 559, bottom])
    expect(filtered.lines).toEqual([axis])
    expect(sample.lines).toHaveLength(4)
    // Repetition, publication wording and an external page margin are all required.
    expect(excludeRepeatedMarginContent([sample])[0].lines).toEqual(sample.lines)
    expect(
      excludeRepeatedMarginContent([
        sample,
        {
          ...sample,
          pageNumber: 9,
          lines: notices.map((entry) => ({ ...entry, y: entry.y + 20 }))
        }
      ])[0].lines
    ).toEqual(sample.lines)
    for (const changes of [{ x: 200 }, { text: 'Fluorescence intensity (a.u.)' }]) {
      const adjusted = { ...sample, lines: notices.map((entry) => ({ ...entry, ...changes })) }
      expect(
        excludeRepeatedMarginContent([adjusted, { ...adjusted, pageNumber: 9 }])[0].lines
      ).toEqual(adjusted.lines)
    }
    const fullWidth = {
      ...sample,
      graphicsBounds: [{ kind: 'image', normalizedRect: [0, 0.03, 1, 0.97] }]
    }
    expect(
      excludeRepeatedMarginContent([fullWidth, { ...fullWidth, pageNumber: 9 }])[0].lines
    ).toEqual(fullWidth.lines)
  }
)

it('recognizes alternating publisher lettering while preserving real margin images and paths', () => {
  const footer = Array.from({ length: 8 }, (_, i) => ({
    kind: 'path',
    normalizedRect: [0.08 + i / 128, 0.95, 0.09 + i / 128, 0.965]
  }))
  const facing = footer.map((g) => ({
    ...g,
    normalizedRect: g.normalizedRect.map((v, i) => v + (i % 2 ? 0 : 0.7 + 1 / 512))
  }))
  facing[3].normalizedRect[2] += 1 / 512
  const body = { kind: 'image', normalizedRect: [0.1, 0.2, 0.9, 0.7] }
  const strip = { kind: 'image', normalizedRect: [0.1, 0.94, 0.9, 0.96] }
  const pages = [
    { pageNumber: 1, graphicsBounds: [...footer, body, strip] },
    { pageNumber: 2, graphicsBounds: [...facing, body, strip] }
  ]
  expect(
    excludeRepeatedMarginContent(pages).map((p: { graphicsBounds: unknown[] }) => p.graphicsBounds)
  ).toEqual([
    [body, strip],
    [body, strip]
  ])
  expect(excludeRepeatedMarginContent([pages[0]])[0].graphicsBounds).toEqual(
    pages[0].graphicsBounds
  )
  expect(pages[0].graphicsBounds).toHaveLength(10)
  const paths = pages.map((page) => ({ ...page, graphicsBounds: [{ ...strip, kind: 'path' }] }))
  expect(excludeRepeatedMarginContent(paths)).toEqual(paths)
  const different = structuredClone(pages)
  different[1].graphicsBounds[0].normalizedRect[3] = 0.956
  expect(excludeRepeatedMarginContent(different)).toEqual(different)
})
it('uses the same optimized instruction stream as the recorded image bounds', async () => {
  const content =
    Array.from({ length: 5 }, (_, i) => `q 20 0 0 20 ${20 + i * 30} 100 cm /Im Do Q`).join('\n') +
    '\nq 0 0 200 200 re W n 0 0 1 rg 30 20 80 40 re f Q\nq 20 0 0 5 20 190 cm /Im Do Q'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /XObject << /Im 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length 7 >>\nstream\n00ff00>\nendstream'
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = objects.map((object, i) => {
    const offset = pdf.length
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`
    return offset
  })
  const xref = pdf.length
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  const task = getDocument({
    data: new Uint8Array(Buffer.from(pdf)),
    verbosity: 0,
    isEvalSupported: false
  })
  const canvas = createCanvas(300, 300)
  try {
    const page = await (await task.promise).getPage(1)
    await page.getOperatorList()
    const render = page.render({
      canvas,
      canvasContext: canvas.getContext('2d'),
      viewport: page.getViewport({ scale: 1.5 }),
      recordOperations: true
    })
    recordNativeFigurePaths(render)
    await render.promise
    // PDF.js 5.4.624 CanvasGraphics.constructPath(opIdx, op, data, minMax)
    // receives a scalar paint operation first, not the older path-op array.
    // Assert the real render stream and its nonempty clip dependency box so
    // the collector cannot pass merely because the clipping path was absent.
    const operators = render._internalRenderTask.operatorList
    const nativePaths = operators.fnArray.flatMap((op: number, index: number) =>
      op === OPS.constructPath ? [{ index, args: operators.argsArray[index] }] : []
    )
    expect(nativePaths.map((p: { args: unknown[] }) => p.args[0])).toEqual([OPS.endPath, OPS.fill])
    for (const path of nativePaths) {
      expect(path.args).toHaveLength(3)
      expect(Array.isArray(path.args[1])).toBe(true)
      expect(page.recordedBBoxes.isEmpty(path.index)).toBe(false)
    }
    const result = collectGraphicsBounds(render, page.recordedBBoxes)
    const source = await page.getTextContent()
    const nativeViewport = page.getViewport({ scale: 1 })
    const snapshot = captureNativeFigureRenderContext(
      render,
      1,
      source,
      nativeViewport,
      result.graphicsBounds,
      'a'.repeat(64)
    )
    const matched = matchNativeFigureRenderContext(
      snapshot,
      1,
      source,
      nativeViewport,
      result.graphicsBounds,
      'a'.repeat(64)
    )
    expect(matched?.operators.fnArray).toEqual(operators.fnArray)
    for (const graphic of result.graphicsBounds)
      expect(matched?.operators.fnArray[graphic.operationIndex]).toBe(
        operators.fnArray[graphic.operationIndex]
      )
    expect(result.graphicsBounds.filter((g: { imageHash?: string }) => g.imageHash)).toHaveLength(3)
    const images = result.graphicsBounds.filter(
      (g: { kind: string; normalizedRect: number[] }) =>
        g.kind === 'image' && g.normalizedRect[3] > 0.07
    )
    expect(images.length).toBeGreaterThan(0)
    const rects = images.map((image: { normalizedRect: number[] }) => image.normalizedRect)
    const bounds = [
      Math.min(...rects.map((r: number[]) => r[0])),
      Math.min(...rects.map((r: number[]) => r[1])),
      Math.max(...rects.map((r: number[]) => r[2])),
      Math.max(...rects.map((r: number[]) => r[3]))
    ]
    const paths = result.graphicsBounds.filter((g: { kind: string }) => g.kind === 'path')
    // A clip-only endPath records a dependency box but paints no figure.
    expect(paths).toHaveLength(1)
    expect(
      paths.some((g: { normalizedRect: number[] }) =>
        [0.15, 0.7, 0.55, 0.9].every((value, i) => Math.abs(g.normalizedRect[i] - value) < 0.01)
      )
    ).toBe(true)
    for (const [i, value] of [0.1, 0.4, 0.8, 0.5].entries())
      expect(Math.abs(bounds[i] - value)).toBeLessThan(0.01)
  } finally {
    canvas.width = canvas.height = 1
    await task.destroy()
  }
})

it('reads single straight stroked table borders with nested PDF transforms', () => {
  const stroke = [
    OPS.stroke,
    [new Float32Array([0, 0, 0, 1, 0, 20])],
    new Float32Array([0, 0, 0, 20])
  ]
  const operators = {
    fnArray: [
      OPS.save,
      OPS.transform,
      OPS.constructPath,
      OPS.save,
      OPS.transform,
      OPS.constructPath,
      OPS.restore,
      OPS.constructPath,
      OPS.restore,
      OPS.constructPath,
      OPS.constructPath,
      OPS.constructPath
    ],
    argsArray: [
      null,
      [1, 0, 0, 1, 100, 200],
      stroke,
      null,
      [2, 0, 0, 2, 10, 0],
      stroke,
      null,
      stroke,
      null,
      stroke,
      [OPS.fill, stroke[1], stroke[2]],
      [OPS.stroke, [new Float32Array([0, 0, 0, 1, 0, 5, 0, 0, 15, 1, 0, 20])], stroke[2]]
    ]
  }
  expect(collectTableRules(operators, { transform: [1.5, 0, 0, -1.5, 0, 1200] })).toEqual([
    [150, 870, 150, 900],
    [165, 840, 165, 900],
    [150, 870, 150, 900],
    [0, 1170, 0, 1200],
    [0, 1192.5, 0, 1200],
    [0, 1170, 0, 1177.5]
  ])
})

it('uses thin rectangular fills as rules while rejecting shading, slanted edges and compound paths', () => {
  const rectangle = (height: number): number[] => [
    0,
    10,
    20,
    1,
    110,
    20,
    1,
    110,
    20 + height,
    1,
    10,
    20 + height,
    4
  ]
  const thin = rectangle(0.5)
  const operators = {
    fnArray: Array(6).fill(OPS.constructPath),
    argsArray: [
      [OPS.eoFillStroke, [thin], [10, 20, 110, 20.5]],
      [OPS.fill, [rectangle(10)], [10, 20, 110, 30]],
      [OPS.fill, [[0, 10, 20, 1, 110, 20, 1, 109, 20.5, 1, 10, 20.5, 4]], [10, 20, 110, 20.5]],
      [OPS.fill, [thin, thin], [10, 20, 110, 20.5]],
      [OPS.fill, [rectangle(0)], [10, 20, 110, 20]],
      [OPS.fill, [[0, 10, 20, 2, 110, 20, 110, 20.5, 10, 20.5]], [10, 20, 110, 20.5]]
    ]
  }
  expect(collectTableRules(operators, { transform: [1.5, 0, 0, 1.5, 0, 0] })).toEqual([
    [15, 30.375, 165, 30.375]
  ])
})

it('does not promote discontinuous filled-grid candidates to synthetic rules', () => {
  const rectangle = (x0: number, y0: number, x1: number, y1: number): number[] => [
    0,
    x0,
    y0,
    1,
    x1,
    y0,
    1,
    x1,
    y1,
    1,
    x0,
    y1,
    4
  ]
  const paths = Array.from({ length: 4 }, (_, n) => {
    const y = n * 10
    return [[rectangle(0, y, 50, y + 2)], [rectangle(50, y + 0.5, 100, y + 1.5)]]
  }).flat()
  paths.push(rectangle(30, 0, 32, 42), rectangle(70, 0, 72, 42))
  const paint = new Map(),
    rules = collectTableRules(
      {
        fnArray: paths.map(() => OPS.constructPath),
        argsArray: paths.map((path) => [OPS.fill, path, [0, 0, 100, 42]])
      },
      { transform: [1, 0, 0, 1, 0, 0] },
      paint
    )
  for (const y of [1, 11, 21, 31]) expect(rules).not.toContainEqual([0, y, 100, y])
  expect([...paint.values()]).not.toContain(undefined)
})

it.each([1, 1.5, 3])('keeps one-point filled rules at render scale %s', (scale) => {
  const path = [0, 10, 20, 1, 110, 20, 1, 110, 21.02, 1, 10, 21.02, 4]
  const rules = collectTableRules(
    { fnArray: [OPS.constructPath], argsArray: [[OPS.fill, [path], [10, 20, 110, 21.02]]] },
    { transform: [scale, 0, 0, scale, 0, 0] }
  )
  expect(rules).toHaveLength(1)
  expect(rules[0][1]).toBeCloseTo(20.51 * scale)
})

it('excludes repeated publisher rules below running headers while retaining standalone plot borders', () => {
  const rule = { kind: 'path', normalizedRect: [0.06640625, 0.12109375, 0.9375, 0.1328125] }
  const panel = { kind: 'path', normalizedRect: [0.2, 0.17, 0.8, 0.7] }
  const page = {
    width: 600,
    height: 800,
    lines: [{ text: 'Articles', x: 40, y: 30, width: 50, height: 18 }],
    graphicsBounds: [rule, panel]
  }
  const clean = excludeRepeatedMarginContent([page, { ...page }])
  expect(clean[0].graphicsBounds).toEqual([panel])
  const facing = { ...page, lines: [{ ...page.lines[0], x: 500 }] }
  expect(excludeRepeatedMarginContent([page, facing, { ...page }])[1].graphicsBounds).toEqual([
    panel
  ])
  expect(excludeRepeatedMarginContent([page])[0].graphicsBounds).toEqual([rule, panel])
  expect(
    excludeRepeatedMarginContent([
      { ...page, lines: [] },
      { ...page, lines: [] }
    ])[0].graphicsBounds
  ).toEqual([rule, panel])
})

it('excludes only repeated, pixel-identical raster logos separated from figure content', () => {
  const logo = {
    kind: 'image',
    imageHash: 'decoded-pixels',
    normalizedRect: [0.06, 0.02, 0.19, 0.06]
  }
  const figure = { kind: 'image', normalizedRect: [0.06, 0.08, 0.94, 0.6] }
  const first = { pageNumber: 1, graphicsBounds: [logo, figure] }
  const second = { pageNumber: 3, graphicsBounds: [{ ...logo }, figure] }
  expect(excludeRepeatedMarginContent([first, second])[0].graphicsBounds).toEqual([figure])
  for (const other of [
    { ...logo, imageHash: 'different-pixels' },
    { ...logo, imageHash: undefined },
    { ...logo, normalizedRect: [0.06, 0.04, 0.19, 0.08] }
  ]) {
    expect(
      excludeRepeatedMarginContent([first, { ...second, graphicsBounds: [other] }])[0]
        .graphicsBounds
    ).toContain(logo)
  }
  expect(excludeRepeatedMarginContent([first])[0].graphicsBounds).toContain(logo)
  const overlapping = { ...figure, normalizedRect: [0.06, 0.05, 0.94, 0.6] }
  expect(
    excludeRepeatedMarginContent([{ ...first, graphicsBounds: [logo, overlapping] }, second])[0]
      .graphicsBounds
  ).toContain(logo)
})

it('recovers a missed captioned numeric table region without guessing its cell structure', async () => {
  const { findCaptionedNumericTableRegions } = await import(
    pathToFileURL(resolve('resources/literature-pdf-graphics.mjs')).href
  )
  const item = (
    text: string,
    x: number,
    y: number,
    width = 30
  ): {
    text: string
    x: number
    baseline: number
    width: number
    height: number
    horizontal: boolean
  } => ({
    text,
    x,
    baseline: y + 10,
    width,
    height: 10,
    horizontal: true
  })
  const source = [
    item('Table 1. Dose reductions', 70, 10, 150),
    item('Starting dose', 10, 35, 65),
    ...[1, 2, 3].map((n, c) => item(`Level ${n}`, 110 + c * 65, 35)),
    item('175 over 3 hours', 10, 55, 80),
    ...['150', '125', '105'].map((s, c) => item(s, 110 + c * 65, 55)),
    item('80 over 1 hour', 10, 75, 80),
    ...['70', '60', '50'].map((s, c) => item(s, 110 + c * 65, 75))
  ]
  const rules = [
    [0, 0, 300, 0],
    [0, 95, 300, 95]
  ]
  expect(findCaptionedNumericTableRegions(source, rules, [])).toEqual([[0, 26, 300, 95]])
  const continued = [
    ...source,
    item('40 over 1 hour', 10, 95, 80),
    ...['30', '20', '10'].map((s, c) => item(s, 110 + c * 65, 95))
  ]
  expect(findCaptionedNumericTableRegions(continued, [...rules, [0, 115, 300, 115]], [])).toEqual([
    [0, 26, 300, 115]
  ])
  expect(findCaptionedNumericTableRegions(source, rules, [[0, 25, 300, 95]])).toEqual([])
  expect(findCaptionedNumericTableRegions(source.slice(1), rules, [])).toEqual([])
  expect(findCaptionedNumericTableRegions(source, rules.slice(0, 1), [])).toEqual([])
  expect(
    findCaptionedNumericTableRegions(
      source.filter((i) => i.text !== '60'),
      rules,
      []
    )
  ).toEqual([])
  expect(
    findCaptionedNumericTableRegions(
      source.map((i) => (i.text === '60' ? { ...i, x: 200 } : i)),
      rules,
      []
    )
  ).toEqual([])
  expect(
    findCaptionedNumericTableRegions(
      source.filter((i) => !i.text.startsWith('Level')),
      rules,
      []
    )
  ).toEqual([])
})

it.each([OPS.paintImageXObject, OPS.constructPath])(
  'ignores mask strips and duplicates of operation %s while retaining separate figures',
  (existingOperation) => {
    const rects = [
      [0.1, 0.1, 0.9, 0.5],
      [0.1, 0.1, 0.9, 0.501],
      [0.3, 0.05, 0.33, 0.95],
      [0.1, 0.6, 0.5, 0.9]
    ]
    const result = collectGraphicsBounds(
      {
        _internalRenderTask: {
          operatorList: {
            fnArray: [
              existingOperation,
              OPS.paintImageMaskXObject,
              OPS.paintImageMaskXObject,
              OPS.paintImageMaskXObject
            ],
            argsArray: [[], [], [], []]
          }
        }
      },
      {
        isEmpty: (): boolean => false,
        minX: (i: number): number => rects[i][0],
        minY: (i: number): number => rects[i][1],
        maxX: (i: number): number => rects[i][2],
        maxY: (i: number): number => rects[i][3]
      }
    )
    expect(result.graphicsBounds.map((g: { operationIndex: number }) => g.operationIndex)).toEqual([
      0, 3
    ])
  }
)

it('collects a monochrome image-mask figure from the rendered PDF stream', async () => {
  const content = 'q 100 0 0 100 20 60 cm /Im Do Q'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /XObject << /Im 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /ImageMask true /BitsPerComponent 1 /Filter /ASCIIHexDecode /Length 17 >>\nstream\nAA55AA55AA55AA55>\nendstream'
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = objects.map((object, i) => {
    const offset = pdf.length
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`
    return offset
  })
  const xref = pdf.length
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  const task = getDocument({
    data: new Uint8Array(Buffer.from(pdf)),
    verbosity: 0,
    isEvalSupported: false
  })
  const canvas = createCanvas(300, 300)
  try {
    const page = await (await task.promise).getPage(1)
    const render = page.render({
      canvas,
      canvasContext: canvas.getContext('2d'),
      viewport: page.getViewport({ scale: 1.5 }),
      recordOperations: true
    })
    await render.promise
    const images = collectGraphicsBounds(render, page.recordedBBoxes).graphicsBounds.filter(
      (g: { kind: string }) => g.kind === 'image'
    )
    expect(images).toHaveLength(1)
    for (const [i, value] of [0.1, 0.2, 0.6, 0.7].entries())
      expect(Math.abs(images[0].normalizedRect[i] - value)).toBeLessThan(0.01)
  } finally {
    canvas.width = canvas.height = 1
    await task.destroy()
  }
})

it('recognizes an author running header despite its changing printed page number', () => {
  const page = (n: number): object => ({
    pageNumber: n,
    width: 600,
    height: 800,
    lines: [{ text: `${n} Green et al.`, x: 54, y: 55, width: 90, height: 9 }],
    graphicsBounds: [{ kind: 'image', normalizedRect: [0.09, 0.094, 0.5, 0.54] }]
  })
  expect(
    excludeRepeatedMarginContent([page(18), page(20)]).map((p: { lines: unknown[] }) => p.lines)
  ).toEqual([[], []])
  expect(excludeRepeatedMarginContent([page(18)])[0].lines).toHaveLength(1)
})

it('preserves repeated continuation captions while removing ordinary running titles', () => {
  const line = (text: string, y: number): object => ({
    text,
    x: 36,
    y,
    width: 238,
    height: 8,
    fontSize: 8
  })
  const caption = line('TABLE A1. Toxicity management guidelines (continued)', 40)
  const title = line('Journal of Clinical Results', 18)
  const page = { width: 600, height: 800, graphicsBounds: [], lines: [caption, title] }
  const result = excludeRepeatedMarginContent([
    { ...page, pageNumber: 18 },
    { ...page, pageNumber: 19 }
  ])
  expect(result.map((p: { lines: unknown[] }) => p.lines)).toEqual([[caption], [caption]])
})

it.each([1, 1.5, 3])('recognizes filled rules with short mitered ends at scale %s', (scale) => {
  const path = [0, 42.52, 377.6, 1, 552.757, 377.6, 1, 553.257, 378.1, 1, 42.02, 378.1, 4]
  const input = {
    fnArray: [OPS.constructPath],
    argsArray: [[OPS.fill, [path], [42.02, 377.6, 553.257, 378.1]]]
  }
  const original = structuredClone(input)
  const [rule] = collectTableRules(input, { transform: [scale, 0, 0, -scale, 0, 800 * scale] })
  expect(rule[0]).toBeCloseTo(42.02 * scale)
  expect(rule[2]).toBeCloseTo(553.257 * scale)
  expect(rule[1]).toBeCloseTo((800 - 377.85) * scale)
  expect(rule[1]).toBe(rule[3])
  expect(input).toEqual(original)
})
type Rect = [number, number, number, number]
type Operators = { fnArray: number[]; argsArray: unknown[][] }
const stroke = (path = [0, 20, 40, 1, 120, 40]): unknown[] => [
  OPS.stroke,
  [new Float32Array(path)],
  [20, 40, 120, 40]
]
const collect = (
  args: unknown[][],
  fnArray: number[],
  transform = [1.5, 0, 0, -1.5, 0, 150]
): { rules: Rect[]; paint: Map<string, Rect>; operators: Operators } => {
  const operators = { fnArray, argsArray: args }
  const paint = new Map<string, Rect>()
  const rules = collectTableRules(operators, { transform }, paint)
  expect(rules).toEqual(collectTableRules(operators, { transform }))
  return { rules, paint, operators }
}

it('retains exact rule centers and separately proves transformed native stroke thickness', () => {
  const { rules, paint } = collect([[0.8], stroke()], [OPS.setLineWidth, OPS.constructPath])
  expect(rules).toEqual([[30, 90, 180, 90]])
  expect(paint.get(rules[0].join(','))).toEqual([30, 89.4, 180, 90.6])
})

it.each([0, 1, 2])('proves native cap %s without assuming a butt cap', (cap) => {
  const { rules, paint } = collect(
    [[2], [cap], stroke()],
    [OPS.setLineWidth, OPS.setLineCap, OPS.constructPath]
  )
  const end = cap === 0 ? 0 : 1.5
  expect(paint.get(rules[0].join(','))).toEqual([30 - end, 88.5, 180 + end, 91.5])
})

it('restores line width, cap and transform together across native save/restore', () => {
  const { rules, paint } = collect(
    [[2], [2], [], [8], [1], [1, 0, 0, 1, 10, 0], [], stroke()],
    [
      OPS.setLineWidth,
      OPS.setLineCap,
      OPS.save,
      OPS.setLineWidth,
      OPS.setLineCap,
      OPS.transform,
      OPS.restore,
      OPS.constructPath
    ]
  )
  expect(paint.get(rules[0].join(','))).toEqual([28.5, 88.5, 181.5, 91.5])
})

it('proves default width and rotated axis strokes with nonuniform scale', () => {
  const { rules, paint } = collect([stroke()], [OPS.constructPath], [0, 2, -3, 0, 200, 0])
  expect(rules).toEqual([[80, 40, 80, 240]])
  expect(paint.get(rules[0].join(','))).toEqual([78.5, 40, 81.5, 240])
})

it('retains separate painted segments in compound rules and a connected polyline', () => {
  for (const path of [
    [0, 20, 40, 1, 120, 40, 0, 20, 60, 1, 120, 60],
    [0, 20, 40, 1, 60, 40, 1, 120, 40]
  ]) {
    const { rules, paint } = collect([stroke(path)], [OPS.constructPath])
    expect(paint.size).toBe(2)
    for (const r of rules)
      expect(paint.get(r.join(','))).toEqual([r[0], r[1] - 0.75, r[2], r[3] + 0.75])
  }
})

it('preserves actual painted filled edges while retaining the same collapsed rule', () => {
  const path = [0, 20, 40, 1, 120, 40, 1, 120, 40.5, 1, 20, 40.5, 4]
  const { rules, paint } = collect(
    [[OPS.fill, [new Float32Array(path)], [20, 40, 120, 40.5]]],
    [OPS.constructPath]
  )
  expect(rules).toEqual([[30, 89.625, 180, 89.625]])
  expect(paint.get(rules[0].join(','))).toEqual([30, 89.25, 180, 90])
})

it.each([NaN, Infinity, -1, 0])(
  'declines unproved native width %s without changing rules',
  (width) => {
    const { rules, paint } = collect([[width], stroke()], [OPS.setLineWidth, OPS.constructPath])
    expect(rules).toHaveLength(1)
    expect(paint.size).toBe(0)
  }
)

it('declines shear, unknown caps and fill-stroke joins without inventing paint extents', () => {
  expect(collect([stroke()], [OPS.constructPath], [1, 0, 0.5, 1, 0, 0]).paint.size).toBe(0)
  expect(collect([[9], stroke()], [OPS.setLineCap, OPS.constructPath]).paint.size).toBe(0)
  const path = [0, 20, 40, 1, 120, 40, 1, 120, 40.5, 1, 20, 40.5, 4]
  expect(
    collect([[OPS.fillStroke, [new Float32Array(path)], [20, 40, 120, 40.5]]], [OPS.constructPath])
      .paint.size
  ).toBe(0)
})

it('unions distinct real paint widths on one center without losing either stroke', () => {
  const { rules, paint } = collect(
    [[2], stroke(), [4], stroke()],
    [OPS.setLineWidth, OPS.constructPath, OPS.setLineWidth, OPS.constructPath]
  )
  expect(rules).toHaveLength(2)
  expect(paint.size).toBe(1)
  expect(paint.get(rules[0].join(','))).toEqual([30, 87, 180, 93])
})

it('keeps unknown width or cap unknown after nested native save and restore', () => {
  for (const op of [OPS.setLineWidth, OPS.setLineCap]) {
    const { paint } = collect(
      [[undefined], [], [], [2], [], [], stroke()],
      [op, OPS.save, OPS.save, op, OPS.restore, OPS.restore, OPS.constructPath]
    )
    expect(paint.size).toBe(0)
  }
})

it('honors native extended line state and declines dashed or malformed state', () => {
  const { rules, paint } = collect(
    [
      [
        [
          ['LW', 2],
          ['LC', 2]
        ]
      ],
      stroke()
    ],
    [OPS.setGState, OPS.constructPath]
  )
  expect(paint.get(rules[0].join(','))).toEqual([28.5, 88.5, 181.5, 91.5])
  expect(
    collect([[[['D', [[2, 2], 0]]]], stroke()], [OPS.setGState, OPS.constructPath]).paint.size
  ).toBe(0)
  expect(collect([[null], stroke()], [OPS.setGState, OPS.constructPath]).paint.size).toBe(0)
  expect(collect([[[2, 2], 0], stroke()], [OPS.setDash, OPS.constructPath]).paint.size).toBe(0)
})

it('does not invent end caps at the interior point of one connected stroke', () => {
  const { rules, paint } = collect(
    [[2], [2], stroke([0, 20, 40, 1, 60, 40, 1, 120, 40])],
    [OPS.setLineWidth, OPS.setLineCap, OPS.constructPath]
  )
  expect(paint.get(rules[0].join(','))).toEqual([28.5, 88.5, 90, 91.5])
  expect(paint.get(rules[1].join(','))).toEqual([90, 88.5, 181.5, 91.5])
})

it('removes a repeated rule paint proof when another identical rule has unknown width', () => {
  const { rules, paint } = collect(
    [stroke(), [NaN], stroke()],
    [OPS.constructPath, OPS.setLineWidth, OPS.constructPath]
  )
  expect(rules).toHaveLength(2)
  expect(paint.size).toBe(0)
})

it('declines unproved actual stroke endpoints even when the legacy box is finite', () => {
  for (const path of [
    [0, NaN, 40, 1, 120, 40],
    [0, 21, 40, 1, 120, 40]
  ]) {
    const { rules, paint } = collect([stroke(path)], [OPS.constructPath])
    expect(rules).toEqual([[30, 90, 180, 90]])
    expect(paint.size).toBe(0)
  }
})

it('declines unknown clips and paint outside a known page without changing native rules', () => {
  expect(collect([[], stroke()], [OPS.clip, OPS.constructPath]).paint.size).toBe(0)
  const restored = collect(
    [[], [], [], stroke()],
    [OPS.save, OPS.clip, OPS.restore, OPS.constructPath]
  )
  expect(restored.paint.size).toBe(1)
  const paint = new Map<string, Rect>(),
    operators = { fnArray: [OPS.setLineWidth, OPS.constructPath], argsArray: [[200], stroke()] },
    viewport = { transform: [1.5, 0, 0, -1.5, 0, 150], width: 200, height: 200 }
  expect(collectTableRules(operators, viewport, paint)).toEqual(
    collectTableRules(operators, viewport)
  )
  expect(paint.size).toBe(0)
})

it('withdraws new solid-mask rule evidence after an opaque cover while preserving unrelated legacy strokes', () => {
  const operators = {
    fnArray: [
      OPS.constructPath,
      OPS.save,
      OPS.transform,
      OPS.paintSolidColorImageMask,
      OPS.restore,
      OPS.setFillRGBColor,
      OPS.constructPath
    ],
    argsArray: [
      [OPS.stroke, [[0, 310, 10, 1, 390, 10]], [310, 10, 390, 10]],
      [],
      [200, 0, 0, -0.5, 20, 40],
      [],
      [],
      ['#ffffff'],
      [OPS.fill, [[0, 0, 0, 1, 300, 0, 1, 300, 100, 1, 0, 100, 4]], [0, 0, 300, 100]]
    ]
  }
  const paint = new Map(),
    before = structuredClone(operators)
  const rules = collectTableRules(
    operators,
    { transform: [1, 0, 0, 1, 0, 0], width: 500, height: 500 },
    paint
  )
  expect(rules).toEqual([[310, 10, 390, 10]])
  expect([...paint.values()]).not.toContainEqual([20, 39.5, 220, 40])
  expect(operators).toEqual(before)
})

it('limits mask invalidation to proven raster overlap and declines unknown transformed cover', () => {
  const initial = {
    fnArray: [OPS.save, OPS.transform, OPS.paintSolidColorImageMask, OPS.restore],
    argsArray: [[], [200, 0, 0, -0.5, 20, 40], [], []] as unknown[][]
  }
  const viewport = { transform: [1, 0, 0, 1, 0, 0], width: 500, height: 500 }
  for (const [name, x] of [
    ['covering', 50],
    ['disjoint', 300]
  ] as const) {
    const input = structuredClone(initial)
    input.fnArray.push(OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore)
    input.argsArray.push([], [40, 0, 0, 20, x, 30], ['anonymous-raster'], [])
    const paint = new Map()
    expect(collectTableRules(input, viewport, paint), name).toEqual(
      name === 'disjoint' ? [[20, 39.75, 220, 39.75]] : []
    )
    expect([...paint.values()], name).toEqual(name === 'disjoint' ? [[20, 39.5, 220, 40]] : [])
  }
  const unknown = structuredClone(initial)
  unknown.fnArray.push(OPS.setFillRGBColor, OPS.transform, OPS.constructPath)
  unknown.argsArray.push(
    ['#ffffff'],
    [NaN, 0, 0, 1, 0, 0],
    [OPS.fill, [[0, 0, 0, 1, 300, 0, 1, 300, 100, 1, 0, 100, 4]], [0, 0, 300, 100]]
  )
  const paint = new Map()
  expect(collectTableRules(unknown, viewport, paint)).toEqual([])
  expect([...paint.values()]).toEqual([])
})

it('observes pre-execution path arrays and empty clips at their original chunk indices', () => {
  const f = renderContextInput(),
    ops = f.render._internalRenderTask.operatorList
  const path = new Float32Array([0, 10, 20, 1, 30, 20])
  ops.fnArray.push(OPS.constructPath, OPS.constructPath)
  ops.argsArray.push([OPS.stroke, [path], [10, 20, 30, 20]], [OPS.endPath, [null], null])
  let resumed = 0,
    previous = 0
  f.render.onContinue = (resume: () => void): void => {
    previous++
    resume()
  }
  recordNativeFigurePaths(f.render)
  f.render.onContinue(() => {
    resumed++
    ops.argsArray[4][1][0] = new (class OpaquePath {})()
  })
  const snapshot = captureNativeFigureRenderContext(
    f.render,
    f.page,
    f.content,
    f.viewport,
    f.graphics,
    f.checksum
  )
  expect(snapshot?.operators.argsArray[4][1][0]).toEqual(path)
  expect(snapshot?.operators.argsArray[5][1][0]).toBeNull()
  expect([resumed, previous]).toEqual([1, 1])
})

it('observes appended paths while a render continuation is already pending', () => {
  const f = renderContextInput(),
    internal = f.render._internalRenderTask,
    ops = internal.operatorList,
    paths = [new Float32Array([0, 10, 20, 1, 30, 20]), new Float32Array([0, 10, 40, 1, 30, 40])],
    calls: unknown[][] = [],
    result = {}
  let pending: (() => void) | undefined
  f.render.onContinue = function (resume: () => void): void {
    expect(this).toBe(f.render)
    pending = resume
  }
  internal.operatorListChanged = function (...args: unknown[]): object {
    calls.push([this, ...args])
    return result
  }
  ops.fnArray.push(OPS.constructPath)
  ops.argsArray.push([OPS.stroke, [paths[0]], [10, 20, 30, 20]])
  recordNativeFigurePaths(f.render)
  const installed = internal.operatorListChanged
  recordNativeFigurePaths(f.render)
  expect(internal.operatorListChanged).toBe(installed)
  f.render.onContinue(() => {
    for (const index of [4, 5]) ops.argsArray[index][1][0] = new (class OpaquePath {})()
  })
  // PDF.js appends before notifying the running task. Its pending execution
  // consumes the new tail without another onContinue callback.
  ops.fnArray.push(OPS.constructPath)
  ops.argsArray.push([OPS.stroke, [paths[1]], [10, 40, 30, 40]])
  expect(internal.operatorListChanged('tail', 2)).toBe(result)
  expect(calls).toEqual([[internal, 'tail', 2]])
  pending!()
  const snapshot = captureNativeFigureRenderContext(
    f.render,
    f.page,
    f.content,
    f.viewport,
    f.graphics,
    f.checksum
  )
  expect(snapshot?.operators.argsArray.slice(4).map((args) => args[1][0])).toEqual(paths)
})

it.each(['empty-clip', 'pattern'])('observes an appended %s before immediate execution', (mode) => {
  const f = renderContextInput(),
    internal = f.render._internalRenderTask,
    ops = internal.operatorList,
    path = new Float32Array([0, 0, 0, 1, 8, 8]),
    tile = { fnArray: [OPS.constructPath], argsArray: [[OPS.stroke, [path], [0, 0, 8, 8]]] }
  internal.operatorListChanged = (): void => {
    if (mode === 'pattern')
      tile.argsArray[0][1][0] = new (class OpaquePath {})() as unknown as Float32Array
  }
  recordNativeFigurePaths(f.render)
  f.render.onContinue(() => {})
  ops.fnArray.push(mode === 'pattern' ? OPS.setFillColorN : OPS.constructPath)
  const args =
    mode === 'pattern'
      ? ['TilingPattern', '#000000', tile, [1, 0, 0, 1, 0, 0], [0, 0, 8, 8], 8, 8, 2, 1]
      : [OPS.endPath, [null], null]
  const expected = structuredClone(args)
  ops.argsArray.push(args)
  internal.operatorListChanged()
  const snapshot = captureNativeFigureRenderContext(
    f.render,
    f.page,
    f.content,
    f.viewport,
    f.graphics,
    f.checksum
  )
  expect(snapshot?.operators.argsArray[4]).toEqual(expected)
})

it.each(['oversized', 'opaque'])(
  'still refuses an unsafe %s path appended during a pending render',
  (mode) => {
    const f = renderContextInput(),
      internal = f.render._internalRenderTask,
      ops = internal.operatorList
    let notified = 0
    internal.operatorListChanged = (): void => {
      notified++
    }
    recordNativeFigurePaths(f.render)
    f.render.onContinue(() => {})
    const path =
      mode === 'oversized'
        ? new Float32Array(new ArrayBuffer(17 * 1024 * 1024), 0, 6)
        : new (class OpaquePath {})()
    ops.fnArray.push(OPS.constructPath)
    ops.argsArray.push([OPS.stroke, [path], [10, 20, 30, 20]])
    internal.operatorListChanged()
    expect(notified).toBe(1)
    expect(
      captureNativeFigureRenderContext(
        f.render,
        f.page,
        f.content,
        f.viewport,
        f.graphics,
        f.checksum
      )
    ).toBeUndefined()
  }
)

it('counts a typed view entire backing store before cloning the native render snapshot', () => {
  const f = renderContextInput()
  f.render._internalRenderTask.operatorList.argsArray[0] = [
    new Uint8Array(new ArrayBuffer(17 * 1024 * 1024), 0, 1)
  ]
  expect(
    captureNativeFigureRenderContext(
      f.render,
      f.page,
      f.content,
      f.viewport,
      f.graphics,
      f.checksum
    )
  ).toBeUndefined()
})

it('preserves nested tiling-pattern commands before the renderer replaces their paths', () => {
  const f = renderContextInput(),
    ops = f.render._internalRenderTask.operatorList
  const path = new Float32Array([0, 0, 0, 1, 8, 8])
  const tile = { fnArray: [OPS.constructPath], argsArray: [[OPS.stroke, [path], [0, 0, 8, 8]]] }
  ops.fnArray.push(OPS.setFillColorN)
  ops.argsArray.push([
    'TilingPattern',
    '#000000',
    tile,
    [1, 0, 0, 1, 0, 0],
    [0, 0, 8, 8],
    8,
    8,
    2,
    1
  ])
  recordNativeFigurePaths(f.render)
  f.render.onContinue(() => {
    tile.argsArray[0][1][0] = new (class OpaquePath {})() as unknown as Float32Array
  })
  const snapshot = captureNativeFigureRenderContext(
    f.render,
    f.page,
    f.content,
    f.viewport,
    f.graphics,
    f.checksum
  )
  expect(snapshot?.operators.argsArray[4][2].argsArray[0][1][0]).toEqual(path)
  expect(
    matchNativeFigureRenderContext(snapshot, f.page, f.content, f.viewport, f.graphics, f.checksum)
  ).toBeDefined()
  expect(
    matchNativeFigureRenderContext(
      snapshot,
      f.page,
      f.content,
      f.viewport,
      f.graphics,
      'b'.repeat(64)
    )
  ).toBeUndefined()
})

it.each(['oversized', 'nonplain'])(
  'declines an unsafe %s tiling-pattern snapshot without interrupting rendering',
  (mode) => {
    const f = renderContextInput(),
      ops = f.render._internalRenderTask.operatorList
    const value =
      mode === 'oversized'
        ? new Uint8Array(new ArrayBuffer(17 * 1024 * 1024), 0, 1)
        : new (class OpaquePath {})()
    ops.fnArray.push(OPS.setStrokeColorN)
    ops.argsArray.push([
      'TilingPattern',
      '#000000',
      { fnArray: [OPS.constructPath], argsArray: [[OPS.stroke, [value], [0, 0, 8, 8]]] }
    ])
    recordNativeFigurePaths(f.render)
    let resumed = false
    expect(() =>
      f.render.onContinue(() => {
        resumed = true
      })
    ).not.toThrow()
    expect(resumed).toBe(true)
    expect(
      captureNativeFigureRenderContext(
        f.render,
        f.page,
        f.content,
        f.viewport,
        f.graphics,
        f.checksum
      )
    ).toBeUndefined()
  }
)
it('stops observing an excessive native stream but still resumes rendering', () => {
  const f = renderContextInput(),
    ops = f.render._internalRenderTask.operatorList
  ops.fnArray = new Array(100001).fill(OPS.constructPath)
  ops.argsArray = new Proxy([], {
    get: (): never => {
      throw new Error('must not scan oversized stream')
    }
  })
  recordNativeFigurePaths(f.render)
  let resumed = false
  expect(() =>
    f.render.onContinue(() => {
      resumed = true
    })
  ).not.toThrow()
  expect(resumed).toBe(true)
})

it('captures each same-render font glyph path once and retains only isolated numeric bounds', () => {
  const f = renderContextInput(),
    ops = f.render._internalRenderTask.operatorList
  const glyph = { fontChar: 'A', unicode: 'A', width: 500, isInFont: true }
  ops.fnArray.push(OPS.setFont, OPS.showText, OPS.showText)
  ops.argsArray.push(['first-font', 10], [[glyph, glyph]], [[glyph]])
  let reads = 0
  const bounds = [0, -0.2, 0.5, 0.8]
  const objects = {
    get: (name: string): unknown => ({
      loadedName: name,
      getPathGenerator: (): unknown => {
        reads++
        return { getBounds: (): number[] => bounds }
      }
    })
  }
  const snapshot = captureNativeFigureRenderContext(
    f.render,
    f.page,
    f.content,
    f.viewport,
    f.graphics,
    f.checksum,
    objects
  )
  expect(snapshot.glyphBounds).toEqual([
    { fontName: 'first-font', glyphs: [{ fontChar: 'A', bounds: [0, -0.2, 0.5, 0.8] }] }
  ])
  expect(reads).toBe(1)
  bounds[0] = 99
  expect(snapshot.glyphBounds[0].glyphs[0].bounds[0]).toBe(0)
  const matched = matchNativeFigureRenderContext(
    snapshot,
    f.page,
    f.content,
    f.viewport,
    f.graphics,
    f.checksum
  )
  expect(matched.glyphBounds).toEqual(snapshot.glyphBounds)
})
it.each(['missing-font', 'invalid-bounds', 'over-budget'])(
  'leaves the legacy snapshot intact when optional glyph proof is %s',
  (failure) => {
    const f = renderContextInput(),
      ops = f.render._internalRenderTask.operatorList
    ops.fnArray.push(OPS.setFont, OPS.showText)
    ops.argsArray.push(
      ['first-font', 10],
      [[{ fontChar: 'A', unicode: 'A', width: 500, isInFont: true }]]
    )
    if (failure === 'over-budget') ops.argsArray[0] = [new Uint8Array(16 * 1024 * 1024 - 12000)]
    const objects = {
      get: (): unknown => ({
        loadedName: failure === 'missing-font' ? 'Other' : 'first-font',
        getPathGenerator: (): unknown => ({
          getBounds: (): number[] => (failure === 'invalid-bounds' ? [0, NaN, 1, 1] : [0, 0, 1, 1])
        })
      })
    }
    if (failure === 'over-budget') ops.argsArray.at(-1)[0][0].fontChar = 'A'.repeat(3000)
    const snapshot = captureNativeFigureRenderContext(
      f.render,
      f.page,
      f.content,
      f.viewport,
      f.graphics,
      f.checksum,
      objects
    )
    expect(snapshot).toBeDefined()
    expect(snapshot.glyphBounds).toBeUndefined()
    expect(snapshot.content).toEqual(f.content)
  }
)

it.each(['type3-glyph', 'missing-font', 'invalid-glyph'])(
  'keeps whole valid fonts separate from an unavailable font proof: %s',
  (failure) => {
    const f = renderContextInput(),
      ops = f.render._internalRenderTask.operatorList,
      glyph = (fontChar: string): unknown => ({ fontChar, unicode: fontChar, width: 500 })
    ops.fnArray.push(OPS.setFont, OPS.showText, OPS.setFont, OPS.showText)
    ops.argsArray.push(['first-font', 10], [[glyph('A')]], ['other-font', 10], [[glyph('B')]])
    if (failure === 'type3-glyph') ops.argsArray.at(-1)[0][0].fontChar = ''
    const objects = {
      get: (name: string): unknown => ({
        loadedName: name,
        missingFile: failure === 'missing-font' && name === 'other-font',
        getPathGenerator: (): unknown => ({
          getBounds: (): number[] =>
            failure === 'invalid-glyph' && name === 'other-font'
              ? [0, NaN, 1, 1]
              : [0, -0.2, 0.5, 0.8]
        })
      })
    }
    const snapshot = captureNativeFigureRenderContext(
      f.render,
      f.page,
      f.content,
      f.viewport,
      f.graphics,
      f.checksum,
      objects
    )
    expect(snapshot.glyphBounds).toBeUndefined()
    expect(snapshot.partialFontGlyphBounds).toEqual([
      { fontName: 'first-font', glyphs: [{ fontChar: 'A', bounds: [0, -0.2, 0.5, 0.8] }] }
    ])
    expect(
      matchNativeFigureRenderContext(
        snapshot,
        f.page,
        f.content,
        f.viewport,
        f.graphics,
        f.checksum
      ).partialFontGlyphBounds
    ).toEqual(snapshot.partialFontGlyphBounds)
    // A malformed native state cannot bind even an otherwise usable font.
    ops.fnArray.push(OPS.restore)
    ops.argsArray.push([])
    const malformed = captureNativeFigureRenderContext(
      f.render,
      f.page,
      f.content,
      f.viewport,
      f.graphics,
      f.checksum,
      objects
    )
    expect(malformed.glyphBounds).toBeUndefined()
    expect(malformed.partialFontGlyphBounds).toBeUndefined()
  }
)
