import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { associateFigures, associateUncaptionedRasterFigure, associateTableCaptions } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-association.mjs')).href
)
const { captionKind, findCaptionCandidates } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-caption-group.mjs')).href
)
const { collectClosedFigureFrames, collectTableRules, excludeRepeatedMarginContent } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-graphics.mjs')).href
)
const { closedCaptionFigureFrame } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-figure-connectivity.mjs')).href
)
const fixture = (name: string): ReturnType<typeof readPdfFixture> =>
  readPdfFixture(resolve(`src/main/literature/pdf-structure/fixtures/${name}.jsonl`))
const repeatedNativeHeaders = (kind: string): ReturnType<typeof JSON.parse>[] =>
  [2, 4, 6].map((pageNumber) => {
    const line = (
      text: string,
      x: number,
      y: number,
      width: number
    ): ReturnType<typeof JSON.parse> => ({
      text,
      x,
      y,
      width,
      height: 8,
      fontSize: 8
    })
    const lines =
      kind === 'ordinal-author'
        ? [line(`${pageNumber} A. B. Author and C. Writer`, 50, 30, 190)]
        : kind === 'wrapped-author'
          ? [
              line('AUTHOR et al.: AN ANONYMOUS REPEATED TITLE-', 75, 30, 390),
              line(`AND ITS CONTINUATION ${pageNumber}`, 75, 39, 470)
            ]
          : [line('An anonymous repeated publication title', 190, 55, 220)]
    const graphicsBounds = [{ kind: 'path', normalizedRect: [0.1, 0.1, 0.9, 0.4] }]
    if (kind !== 'ordinal-author')
      graphicsBounds.push({
        kind: 'path',
        normalizedRect:
          kind === 'wrapped-author' ? [0.12, 0.06, 0.93, 0.07] : [0.1, 0.076, 0.9, 0.087]
      })
    if (kind === 'wrapped-author')
      graphicsBounds.push({ kind: 'path', normalizedRect: [0.075, 0.03125, 0.115, 0.0625] })
    return { pageNumber, width: 600, height: 800, lines, graphicsBounds }
  })
it.each(['ordinal-author', 'wrapped-author', 'ruled-title'])(
  'removes only repeated native running rows with exact ordinal or separator ownership: %s',
  (kind) => {
    const pages = repeatedNativeHeaders(kind),
      clean = excludeRepeatedMarginContent(pages)
    expect(clean.every((p: ReturnType<typeof JSON.parse>) => p.lines.length === 0)).toBe(true)
    if (kind !== 'ordinal-author')
      expect(clean.every((p: ReturnType<typeof JSON.parse>) => p.graphicsBounds.length === 1)).toBe(
        true
      )
  }
)
it('preserves a deep repeated title when two separate native separator candidates compete', () => {
  const pages = repeatedNativeHeaders('ruled-title')
  pages.forEach((p) =>
    p.graphicsBounds.push({ kind: 'path', normalizedRect: [0.1, 0.088, 0.9, 0.09] })
  )
  expect(
    excludeRepeatedMarginContent(pages).every(
      (p: ReturnType<typeof JSON.parse>) => p.lines.length === 1
    )
  ).toBe(true)
})
it.each(['one-off', 'wrong-page-ordinal', 'body-overlap', 'figure-title', 'changed-continuation'])(
  'preserves text without every repeated native running-row witness: %s',
  (reason) => {
    let pages = repeatedNativeHeaders(
      reason === 'changed-continuation' ? 'wrapped-author' : 'ordinal-author'
    )
    if (reason === 'one-off') pages = pages.slice(0, 1)
    if (reason === 'wrong-page-ordinal')
      pages.forEach((p) => {
        p.pageNumber += 1
      })
    if (reason === 'body-overlap')
      pages.forEach((p) =>
        p.graphicsBounds.push({ kind: 'image', normalizedRect: [0.05, 0.02, 0.95, 0.4] })
      )
    if (reason === 'figure-title')
      pages.forEach((p) => {
        p.lines[0].text = `Figure ${p.pageNumber}. Independent results.`
      })
    if (reason === 'changed-continuation')
      pages.forEach((p) => {
        p.lines[1].text = `Separate annotation ${p.pageNumber}`
      })
    const clean = excludeRepeatedMarginContent(pages)
    expect(clean.every((p: ReturnType<typeof JSON.parse>) => p.lines.length > 0)).toBe(true)
  }
)
const clippedSides = async (): Promise<ReturnType<typeof JSON.parse>> => {
  const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const clip = [0, 40, 50, 1, 140, 50, 1, 140, 150, 1, 40, 150, 4]
  const sides = [
    [0, 0, 50, 1, 200, 50],
    [0, 0, 150, 1, 200, 150],
    [0, 40, 0, 1, 40, 200],
    [0, 140, 0, 1, 140, 200]
  ]
  return {
    view: { transform: [1, 0, 0, 1, 0, 0], width: 300, height: 300 },
    ops: {
      fnArray: [
        OPS.save,
        OPS.clip,
        OPS.constructPath,
        ...sides.map(() => OPS.constructPath),
        OPS.restore
      ],
      argsArray: [
        [],
        [],
        [OPS.endPath, [clip], [40, 50, 140, 150]],
        ...sides.map((side) => [OPS.stroke, [side], [0, 0, 200, 200]]),
        []
      ]
    }
  }
}
it('proves four independently painted sides only after the actual rectangular clip', async () => {
  const f = await clippedSides()
  expect(collectClosedFigureFrames(f.ops, f.view)).toEqual([[40, 50, 140, 150]])
})
it.each([
  'missing-side',
  'endpoint-gap',
  'nonrectangle-clip',
  'empty-clip',
  'dash',
  'zero-width',
  'clip-only'
])('does not manufacture a closed scientific frame from %s', async (reason) => {
  const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const f = await clippedSides()
  if (reason === 'missing-side') {
    f.ops.fnArray.splice(6, 1)
    f.ops.argsArray.splice(6, 1)
  }
  if (reason === 'endpoint-gap') f.ops.argsArray[3][1][0][1] = 41
  if (reason === 'nonrectangle-clip') f.ops.argsArray[2][1][0][4] = 139
  if (reason === 'empty-clip') f.ops.argsArray[2][1][0] = [0, 40, 50, 1, 40, 50, 4]
  if (reason === 'dash' || reason === 'zero-width') {
    f.ops.fnArray.splice(3, 0, reason === 'dash' ? OPS.setDash : OPS.setLineWidth)
    f.ops.argsArray.splice(3, 0, reason === 'dash' ? [[3, 2], 0] : [0])
  }
  if (reason === 'clip-only') {
    f.ops.fnArray.splice(3, 4)
    f.ops.argsArray.splice(3, 4)
  }
  expect(collectClosedFigureFrames(f.ops, f.view)).toEqual([])
})
it('retains a genuinely painted closed rectangular stroke that also establishes its own clip', async () => {
  const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const f = await clippedSides()
  f.ops.fnArray = [OPS.clip, OPS.constructPath]
  f.ops.argsArray = [
    [],
    [OPS.stroke, [[0, 40, 50, 1, 140, 50, 1, 140, 150, 1, 40, 150, 4]], [40, 50, 140, 150]]
  ]
  expect(collectClosedFigureFrames(f.ops, f.view)).toEqual([[40, 50, 140, 150]])
})
it('restores exact clipping and transform state across a form object', async () => {
  const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const f = await clippedSides()
  f.ops.fnArray[0] = OPS.paintFormXObjectBegin
  f.ops.argsArray[0] = [
    [1, 0, 0, 1, 10, 20],
    [0, 0, 200, 200]
  ]
  f.ops.fnArray[f.ops.fnArray.length - 1] = OPS.paintFormXObjectEnd
  f.ops.fnArray.push(OPS.constructPath)
  f.ops.argsArray.push([
    OPS.stroke,
    [[0, 200, 200, 1, 260, 200, 1, 260, 260, 1, 200, 260, 4]],
    [200, 200, 260, 260]
  ])
  expect(collectClosedFigureFrames(f.ops, f.view)).toEqual([
    [200, 200, 260, 260],
    [50, 70, 150, 170]
  ])
})
it('keeps the neighbouring independently captioned plot out of the left plot', () => {
  const x = fixture('separate-captioned-vector-plots-in-parallel-columns')
  expect(associateFigures(x.page, x.captions)[0].rect[2]).toBeLessThan(310)
})
it('excludes the author above its native closing rule while retaining the complete raster', () => {
  const x = fixture('captioned-raster-below-native-author-rule')
  expect(associateFigures(x.page, x.captions)[0].rect[1]).toBeGreaterThan(45)
})
it('keeps the native running-header proof after repeated margin graphics are excluded', () => {
  const x = fixture('captioned-raster-below-native-author-rule'),
    [page] = excludeRepeatedMarginContent([x.page, { ...structuredClone(x.page), pageNumber: 2 }])
  expect(page.graphicsBounds).toHaveLength(x.page.graphicsBounds.length - 1)
  const [figure] = associateFigures(page, x.captions, [], [[48, 37.5, 545.943, 37.5]])
  expect(figure.rect[1]).toBeGreaterThan(45)
  expect(figure.rect[3]).toBeGreaterThan(500)
})
it.each(['missing rule', 'competing rule', 'short rule', 'distant rule', 'overlapping image'])(
  'does not exclude a label without strict native header proof (%s)',
  (reason) => {
    const x = fixture('captioned-raster-below-native-author-rule'),
      [page] = excludeRepeatedMarginContent([x.page, { ...structuredClone(x.page), pageNumber: 2 }])
    const rules = [[48, 37.5, 545.943, 37.5]]
    if (reason === 'missing rule') rules.pop()
    if (reason === 'competing rule') rules.push([48, 38, 545.943, 38])
    if (reason === 'short rule') rules[0][2] = 400
    if (reason === 'distant rule') rules[0][1] = rules[0][3] = 40
    if (reason === 'overlapping image')
      page.graphicsBounds.find((g: { kind: string }) => g.kind === 'image').normalizedRect[1] = 0.03
    expect(associateFigures(page, x.captions, [], rules)[0].rect[1]).toBeLessThanOrEqual(45)
  }
)
it('preserves the native upper branch connectors beside a side caption', () => {
  const x = fixture('side-captioned-diagram-with-upper-branch-connectors')
  expect(associateFigures(x.page, x.captions)[0].rect[1]).toBeLessThan(60)
})
it('does not assign publisher decoration to a separate figure legend list', () => {
  const x = fixture('separate-legend-list-below-publisher-decoration')
  expect(
    associateFigures(x.page, x.captions).filter((f: { rect?: number[] }) => f.rect)
  ).toHaveLength(0)
})
it('retains the complete native closed frame beside its lower side caption', () => {
  const x = readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/side-captioned-closed-diagram-frame.jsonl')
  )
  const [figure] = associateFigures(x.page, x.captions, [], [], x.frames)
  expect(figure.rect[2]).toBeGreaterThan(550)
  expect(figure.rect[3]).toBeGreaterThan(289)
})
it('requires explicit four axis-aligned closed stroke edges', async () => {
  const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const polygon = [0, 10, 20, 1, 110, 20, 1, 110, 120, 1, 10, 120, 4]
  const view = { transform: [1, 0, 0, 1, 0, 0] }
  const ops = (
    path: number[],
    paint = OPS.stroke
  ): { fnArray: number[]; argsArray: unknown[][] } => ({
    fnArray: [OPS.constructPath],
    argsArray: [[paint, [path], [10, 20, 110, 120]]]
  })
  expect(collectClosedFigureFrames(ops(polygon), view)).toEqual([[10, 20, 110, 120]])
  expect(collectClosedFigureFrames(ops(polygon.slice(0, -1)), view)).toEqual([])
  expect(collectClosedFigureFrames(ops(polygon, OPS.fill), view)).toEqual([])
  const diagonal = [...polygon]
  diagonal[4] = 100
  expect(collectClosedFigureFrames(ops(diagonal), view)).toEqual([])
})
it.each(['fillStroke', 'eoFillStroke'] as const)(
  'retains explicit four closed sides that are genuinely painted with %s',
  async (paint) => {
    const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const path = [0, 10, 20, 1, 110, 20, 1, 110, 120, 1, 10, 120, 4]
    const ops = {
      fnArray: [OPS.constructPath],
      argsArray: [[OPS[paint], [path], [10, 20, 110, 120]]]
    }
    expect(
      collectClosedFigureFrames(ops, { width: 200, height: 200, transform: [1, 0, 0, 1, 0, 0] })
    ).toEqual([[10, 20, 110, 120]])
  }
)
it.each([
  'open',
  'skewed',
  'solid-fill',
  'clip-only',
  'clipped-side',
  'unknown-clip',
  'invisible-stroke'
])('does not turn an unproved filled boundary into a frame: %s', async (reason) => {
  const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const path = [0, 10, 20, 1, 110, 20, 1, 110, 120, 1, 10, 120, 4]
  if (reason === 'open') path.pop()
  if (reason === 'skewed') path[4] = 100
  const ops: ReturnType<typeof JSON.parse> = {
    fnArray: [OPS.constructPath],
    argsArray: [[reason === 'solid-fill' ? OPS.fill : OPS.fillStroke, [path], [10, 20, 110, 120]]]
  }
  if (['clip-only', 'clipped-side', 'unknown-clip'].includes(reason)) {
    const clip = [0, 20, 20, 1, 100, 20, 1, 100, 120, 1, 20, 120, 4]
    if (reason === 'unknown-clip') clip[4] = 95
    ops.fnArray.unshift(OPS.clip, OPS.constructPath)
    ops.argsArray.unshift([], [OPS.endPath, [clip], [20, 20, 100, 120]])
    if (reason === 'clip-only') {
      ops.fnArray.pop()
      ops.argsArray.pop()
    }
  }
  if (reason === 'invisible-stroke') {
    ops.fnArray.unshift(OPS.setGState)
    ops.argsArray.unshift([[['CA', 0]]])
  }
  expect(
    collectClosedFigureFrames(ops, { width: 200, height: 200, transform: [1, 0, 0, 1, 0, 0] })
  ).toEqual([])
})
it('inherits the exact clip in a form that supplies no new bounding box', async () => {
  const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const polygon = [0, 10, 20, 1, 110, 20, 1, 110, 120, 1, 10, 120, 4]
  const ops: {
    fnArray: number[]
    argsArray: ([] | [number, number[][], number[]] | [number[] | null, number[] | null])[]
  } = {
    fnArray: [OPS.paintFormXObjectBegin, OPS.constructPath, OPS.paintFormXObjectEnd],
    argsArray: [[null, null], [OPS.fillStroke, [polygon], [10, 20, 110, 120]], []]
  }
  expect(
    collectClosedFigureFrames(ops, { width: 200, height: 200, transform: [1, 0, 0, 1, 0, 0] })
  ).toEqual([[10, 20, 110, 120]])
  ops.argsArray[0] = [null, [0, 0, NaN, 200]]
  expect(
    collectClosedFigureFrames(ops, { width: 200, height: 200, transform: [1, 0, 0, 1, 0, 0] })
  ).toEqual([])
})
it('does not reset a prior unknown clip or permit a translated form to cross the caller clip', async () => {
  const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const polygon = [0, 10, 20, 1, 110, 20, 1, 110, 120, 1, 10, 120, 4]
  const view = { width: 200, height: 200, transform: [1, 0, 0, 1, 0, 0] }
  const ops: ReturnType<typeof JSON.parse> = {
    fnArray: [OPS.paintFormXObjectBegin, OPS.constructPath, OPS.paintFormXObjectEnd],
    argsArray: [[[1, 0, 0, 1, 130, 0], null], [OPS.fillStroke, [polygon], [10, 20, 110, 120]], []]
  }
  expect(collectClosedFigureFrames(ops, view)).toEqual([])
  ops.argsArray[0] = [null, null]
  const unknown = [0, 0, 0, 1, 190, 0, 1, 200, 200, 1, 0, 200, 4]
  ops.fnArray.unshift(OPS.clip, OPS.constructPath)
  ops.argsArray.unshift([], [OPS.endPath, [unknown], [0, 0, 200, 200]])
  expect(collectClosedFigureFrames(ops, view)).toEqual([])
})
it.each([0, NaN, Infinity])(
  'rejects an unpainted closed outline with stroke alpha %s',
  async (alpha) => {
    const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const polygon = [0, 10, 20, 1, 110, 20, 1, 110, 120, 1, 10, 120, 4]
    const ops = {
      fnArray: [OPS.setGState, OPS.constructPath],
      argsArray: [[[['CA', alpha]]], [OPS.stroke, [polygon], [10, 20, 110, 120]]]
    }
    expect(
      collectClosedFigureFrames(ops, { width: 200, height: 200, transform: [1, 0, 0, 1, 0, 0] })
    ).toEqual([])
  }
)
it('restores source stroke alpha after nested native save and form scopes', async () => {
  const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const polygon = [0, 10, 20, 1, 110, 20, 1, 110, 120, 1, 10, 120, 4]
  const ops = {
    fnArray: [
      OPS.save,
      OPS.setGState,
      OPS.paintFormXObjectBegin,
      OPS.constructPath,
      OPS.paintFormXObjectEnd,
      OPS.restore,
      OPS.constructPath
    ],
    argsArray: [
      [],
      [[['CA', 0]]],
      [null, null],
      [OPS.stroke, [polygon], [10, 20, 110, 120]],
      [],
      [],
      [OPS.stroke, [polygon], [10, 20, 110, 120]]
    ]
  }
  expect(
    collectClosedFigureFrames(ops, { width: 200, height: 200, transform: [1, 0, 0, 1, 0, 0] })
  ).toEqual([[10, 20, 110, 120]])
  ops.fnArray.pop()
  ops.argsArray.pop()
  expect(
    collectClosedFigureFrames(ops, { width: 200, height: 200, transform: [1, 0, 0, 1, 0, 0] })
  ).toEqual([])
})
it('ignores absent or non-array native paths while retaining typed-array closed frames', async () => {
  const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const view = { transform: [1, 0, 0, 1, 0, 0] }
  const ops = (path: unknown): { fnArray: number[]; argsArray: unknown[][] } => ({
    fnArray: [OPS.constructPath],
    argsArray: [[OPS.stroke, [path], [10, 20, 110, 120]]]
  })
  for (const path of [null, undefined, {}, '', { length: 13 }, new DataView(new ArrayBuffer(16))])
    expect(collectClosedFigureFrames(ops(path), view)).toEqual([])
  expect(
    collectClosedFigureFrames(
      ops(new Float32Array([0, 10, 20, 1, 110, 20, 1, 110, 120, 1, 10, 120, 4])),
      view
    )
  ).toEqual([[10, 20, 110, 120]])
})

it('collects an explicitly closed dashed rounded stroke without accepting an open or skewed outline', async () => {
  const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const rounded = [
    0, 10, 30, 2, 10, 24, 14, 20, 20, 20, 1, 100, 20, 2, 106, 20, 110, 24, 110, 30, 1, 110, 110, 2,
    110, 116, 106, 120, 100, 120, 1, 20, 120, 2, 14, 120, 10, 116, 10, 110, 4
  ]
  const ops = (path: number[]): ReturnType<typeof JSON.parse> => ({
    fnArray: [OPS.setDash, OPS.constructPath],
    argsArray: [
      [[3, 2], 0],
      [OPS.stroke, [path], [10, 20, 110, 120]]
    ]
  })
  const view = { transform: [1, 0, 0, 1, 0, 0] }
  expect(collectClosedFigureFrames(ops(rounded), view)).toEqual([[10, 20, 110, 120]])
  expect(collectClosedFigureFrames(ops(rounded.slice(0, -1)), view)).toEqual([])
  const skewed = [...rounded]
  skewed[11] = 98
  skewed[12] = 23
  expect(collectClosedFigureFrames(ops(skewed), view)).toEqual([])
  const adjacent = ops(rounded)
  adjacent.fnArray.push(OPS.constructPath)
  adjacent.argsArray.push([
    OPS.stroke,
    [[0, 112, 20, 1, 212, 20, 1, 212, 120, 1, 112, 120, 4]],
    [112, 20, 212, 120]
  ])
  expect(collectClosedFigureFrames(adjacent, view)).toEqual([
    [10, 20, 110, 120],
    [112, 20, 212, 120]
  ])
})
const straightFirstRounded = (): number[] => [
  0, 100, 20, 1, 20, 20, 2, 14, 20, 10, 24, 10, 30, 1, 10, 110, 2, 10, 116, 14, 120, 20, 120, 1,
  100, 120, 2, 106, 120, 110, 116, 110, 110, 1, 110, 30, 2, 110, 24, 106, 20, 100, 20, 4, 0, 10, 120
]
it.each(['stroke', 'fillStroke', 'eoFillStroke'] as const)(
  'retains a straight-first closed rounded %s with an unpainted trailing move',
  async (paint) => {
    const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const path = straightFirstRounded()
    const ops = {
      fnArray: [OPS.constructPath],
      argsArray: [[OPS[paint], [path], [10, 20, 110, 120]]]
    }
    expect(
      collectClosedFigureFrames(ops, { width: 200, height: 200, transform: [1, 0, 0, 1, 0, 0] })
    ).toEqual([[10, 20, 110, 120]])
  }
)
it.each([
  'solid-fill',
  'open',
  'foreign-suffix',
  'different-endpoint',
  'skewed-corner',
  'transparent',
  'clipped'
])(
  'refuses straight-first rounded geometry without all its painted closure evidence: %s',
  async (reason) => {
    const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const path = straightFirstRounded()
    if (reason === 'open') path.splice(43, 1)
    if (reason === 'foreign-suffix') path.push(1, 30, 130)
    if (reason === 'different-endpoint') path[41] += 1
    if (reason === 'skewed-corner') path[8] += 4
    const ops: { fnArray: number[]; argsArray: unknown[][] } = {
      fnArray: [OPS.constructPath],
      argsArray: [[reason === 'solid-fill' ? OPS.fill : OPS.fillStroke, [path], [10, 20, 110, 120]]]
    }
    if (reason === 'transparent') {
      ops.fnArray.unshift(OPS.setGState)
      ops.argsArray.unshift([[['CA', 0]]])
    }
    if (reason === 'clipped') {
      ops.fnArray.unshift(OPS.clip, OPS.constructPath)
      ops.argsArray.unshift(
        [],
        [OPS.endPath, [[0, 0, 0, 1, 200, 0, 1, 200, 110, 1, 0, 110, 4]], [0, 0, 200, 110]]
      )
    }
    expect(
      collectClosedFigureFrames(ops, { width: 200, height: 200, transform: [1, 0, 0, 1, 0, 0] })
    ).toEqual([])
  }
)
it.each(['stroke', 'fillStroke', 'eoFillStroke'] as const)(
  'paints a rounded %s using the previous clip before consuming the same path as a clip',
  async (paint) => {
    const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const rounded = [
      0, 20, 40, 2, 20, 34.5, 24.5, 30, 30, 30, 1, 170, 30, 2, 175.5, 30, 180, 34.5, 180, 40, 1,
      180, 140, 2, 180, 145.5, 175.5, 150, 170, 150, 1, 30, 150, 2, 24.5, 150, 20, 145.5, 20, 140, 4
    ]
    const square = [0, 30, 40, 1, 170, 40, 1, 170, 140, 1, 30, 140, 4]
    const view = { width: 220, height: 220, transform: [1, 0, 0, 1, 0, 0] }
    const ops: ReturnType<typeof JSON.parse> = {
      fnArray: [OPS.clip, OPS.constructPath, OPS.constructPath],
      argsArray: [
        [],
        [OPS[paint], [rounded], [20, 30, 180, 150]],
        [OPS.stroke, [square], [30, 40, 170, 140]]
      ]
    }
    // The rounded outline was really stroked. Its nonrectangular clip still
    // cannot establish a rectangular paint domain for the subsequent square.
    expect(collectClosedFigureFrames(ops, view)).toEqual([[20, 30, 180, 150]])
    ops.fnArray.push(OPS.restore, OPS.constructPath)
    ops.argsArray.push([], [OPS.stroke, [square], [30, 40, 170, 140]])
    ops.fnArray.unshift(OPS.save)
    ops.argsArray.unshift([])
    expect(collectClosedFigureFrames(ops, view)).toEqual([
      [20, 30, 180, 150],
      [30, 40, 170, 140]
    ])
    ops.argsArray[2][0] = OPS.endPath
    ops.fnArray.splice(-2)
    ops.argsArray.splice(-2)
    expect(collectClosedFigureFrames(ops, view)).toEqual([])
  }
)
it('collects a thin native hollow perimeter while rejecting solid fills and open contours', async () => {
  const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const outer = [0, 10, 20, 1, 110, 20, 1, 110, 120, 1, 10, 120, 1, 10, 20]
  const inner = [0, 11, 21, 1, 11, 119, 1, 109, 119, 1, 109, 21, 1, 11, 21, 4]
  const ops = (path: number[]): ReturnType<typeof JSON.parse> => ({
    fnArray: [OPS.constructPath],
    argsArray: [[OPS.fill, [path], [10, 20, 110, 120]]]
  })
  const view = { transform: [1, 0, 0, 1, 0, 0] }
  expect(collectClosedFigureFrames(ops([...outer, ...inner]), view)).toEqual([[10, 20, 110, 120]])
  expect(collectClosedFigureFrames(ops([...outer, 4]), view)).toEqual([])
  const open = [...outer, ...inner]
  open[open.length - 3] = 15
  expect(collectClosedFigureFrames(ops(open.slice(0, -1)), view)).toEqual([])
  const wide = [...outer, ...inner.map((v, i) => (i % 3 === 1 ? v + 10 : v))]
  expect(collectClosedFigureFrames(ops(wide), view)).toEqual([])
  const adjacent = [0, 111, 20, 1, 111, 120, 1, 211, 120, 1, 211, 20, 1, 111, 20, 4]
  expect(collectClosedFigureFrames(ops([...outer, ...adjacent]), view)).toEqual([])
})
it.each([0, -1, NaN, Infinity, null, undefined, '1'])(
  'refuses a hollow perimeter without finite positive fill opacity: %s',
  async (alpha) => {
    const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const path = [
      0, 10, 20, 1, 110, 20, 1, 110, 120, 1, 10, 120, 1, 10, 20, 0, 11, 21, 1, 11, 119, 1, 109, 119,
      1, 109, 21, 1, 11, 21, 4
    ]
    const operators = {
      fnArray: [OPS.setGState, OPS.constructPath],
      argsArray: [[[['ca', alpha]]], [OPS.fill, [path], [10, 20, 110, 120]]]
    }
    expect(
      collectClosedFigureFrames(operators, {
        width: 200,
        height: 200,
        transform: [1, 0, 0, 1, 0, 0]
      })
    ).toEqual([])
  }
)
it.each(['save', 'form'])(
  'restores fill opacity after %s without confusing it with stroke opacity',
  async (scope) => {
    const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const path = [
      0, 10, 20, 1, 110, 20, 1, 110, 120, 1, 10, 120, 1, 10, 20, 0, 11, 21, 1, 11, 119, 1, 109, 119,
      1, 109, 21, 1, 11, 21, 4
    ]
    const paint = [OPS.fill, [path], [10, 20, 110, 120]]
    const operators: { fnArray: number[]; argsArray: unknown[][] } = {
      fnArray: [
        OPS.setGState,
        scope === 'save' ? OPS.save : OPS.paintFormXObjectBegin,
        OPS.setGState,
        OPS.constructPath,
        scope === 'save' ? OPS.restore : OPS.paintFormXObjectEnd,
        OPS.constructPath
      ],
      argsArray: [
        [
          [
            ['ca', 0.5],
            ['CA', 0]
          ]
        ],
        [],
        [[['ca', 0]]],
        paint,
        [],
        paint
      ]
    }
    expect(
      collectClosedFigureFrames(operators, {
        width: 200,
        height: 200,
        transform: [1, 0, 0, 1, 0, 0]
      })
    ).toEqual([[10, 20, 110, 120]])
    // An unknown parent alpha must remain unknown after restoring the scope.
    operators.argsArray[0] = [[['ca', null]]]
    expect(
      collectClosedFigureFrames(operators, {
        width: 200,
        height: 200,
        transform: [1, 0, 0, 1, 0, 0]
      })
    ).toEqual([])
  }
)
it('preserves continuous monotonic native rule segments without bridging a branch or curve', async () => {
  const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const ops = (path: number[]): { fnArray: number[]; argsArray: unknown[][] } => ({
    fnArray: [OPS.constructPath],
    argsArray: [[OPS.stroke, [path], [0, 0, 423.05, 0]]]
  })
  const path = [0, 0, 0, 1, 183.896, 0, 1, 256.594, 0, 1, 329.291, 0, 1, 423.05, 0]
  const view = { transform: [1, 0, 0, 1, 0, 0] }
  expect(collectTableRules(ops(path), view)).toEqual([
    [0, 0, 183.896, 0],
    [183.896, 0, 256.594, 0],
    [256.594, 0, 329.291, 0],
    [329.291, 0, 423.05, 0]
  ])
  const branch = [...path]
  branch[7] = 100
  expect(collectTableRules(ops(branch), view)).toEqual([])
  const diagonal = [...path]
  diagonal[5] = 5
  expect(collectTableRules(ops(diagonal), view)).toEqual([])
  const duplicate = [...path]
  duplicate[7] = 183.896
  expect(collectTableRules(ops(duplicate), view)).toEqual([])
  expect(collectTableRules(ops([...path, 4]), view)).toEqual([])
  const curve = [...path]
  curve[6] = 2
  expect(collectTableRules(ops(curve), view)).toEqual([])
})
it('does not claim an independent caption or recognized table inside the closed frame', () => {
  const x = fixture('side-captioned-closed-diagram-frame'),
    c = x.captions[0]
  expect(
    closedCaptionFigureFrame(
      x.page,
      c,
      [c, { page: 1, lines: ['Table 2. Independent results.'], rect: [260, 90, 400, 110] }],
      [],
      x.frames
    )
  ).toBeUndefined()
  expect(closedCaptionFigureFrame(x.page, c, [c], [[260, 90, 400, 220]], x.frames)).toBeUndefined()
  expect(
    closedCaptionFigureFrame({ ...x.page, lines: x.page.lines.slice(0, 2) }, c, [c], [], x.frames)
  ).toBeUndefined()
})
it('recovers an isolated uncaptioned embedded plate without inventing a label', () => {
  const x = fixture('uncaptioned-isolated-raster-with-outlined-watermark')
  const [figure] = associateUncaptionedRasterFigure(x.page, [])
  expect(figure.rect).toEqual(
    x.page.graphicsBounds[0].normalizedRect.map(
      (v: number, n: number) => v * (n % 2 ? x.page.height : x.page.width)
    )
  )
  expect(figure.caption).toBeUndefined()
  expect(
    associateUncaptionedRasterFigure(x.page, [
      { page: 1, lines: ['Figure 1. Other.'], rect: [0, 0, 100, 10] }
    ])
  ).toEqual([])
  expect(associateUncaptionedRasterFigure(x.page, [], [[60, 260, 390, 600]])).toEqual([])
  expect(
    associateUncaptionedRasterFigure(
      {
        ...x.page,
        lines: [
          {
            text: 'An ordinary article paragraph beside its illustration.',
            x: 20,
            y: 200,
            width: 400,
            height: 10,
            fontSize: 10
          }
        ]
      },
      []
    )
  ).toEqual([])
  const fullPage = structuredClone(x.page)
  fullPage.graphicsBounds[0].normalizedRect = [0, 0, 1, 1]
  expect(associateUncaptionedRasterFigure(fullPage, [])).toEqual([])
})
it('includes a centered wrapped caption only when its complete native top rule proves the band', () => {
  const x = fixture('centered-two-line-table-caption-above-native-rule')
  expect(findCaptionCandidates([x.page], new Map([[1, x.rules]]))[0].lines).toHaveLength(2)
  expect(findCaptionCandidates([x.page])[0].lines).toHaveLength(1)
  const broken = x.rules.map((r: number[]) => [r[0], r[1], 400, r[3]])
  expect(findCaptionCandidates([x.page], new Map([[1, broken]]))[0].lines).toHaveLength(1)
})
it('recognizes a noun list title while rejecting its finite-verb reference', () => {
  expect(captionKind('Table 1 List of sample measures')).toBe('table')
  expect(captionKind('Table 1 lists the sample measures.')).toBeUndefined()
  expect(captionKind('Table 1 list the sample measures.')).toBeUndefined()
})
it('recognizes native Spanish and decorated German captions without changing source labels', () => {
  for (const text of ['Figura 1 Localización del marcador.', '▶abb. 1 Studienmodell.'])
    expect(captionKind(text)).toBe('figure')
  for (const text of ['Tabla 2 Resultados del estudio.', '▶tab. 1 Vergleich der Gruppen.'])
    expect(captionKind(text)).toBe('table')
})
it('rejects local-language inline figure and table references', () => {
  for (const text of [
    'Figura 1 muestra los resultados.',
    'Tabla 2 presenta los datos.',
    '▶Abb. 1 zeigt die Daten.',
    '▶Tab. 1 enthält Werte.',
    'Figura 1). El resultado',
    '▶Abb. 1). Das Ergebnis'
  ])
    expect(captionKind(text)).toBeUndefined()
})

const continuationMarkerLayout = (): {
  page: {
    pageNumber: number
    width: number
    height: number
    lines: never[]
    graphicsBounds: never[]
  }
  tables: { rect: number[] }[]
  captions: { page: number; lines: string[]; rect: number[] }[]
  rules: number[][]
} => ({
  page: { pageNumber: 1, width: 240, height: 400, lines: [], graphicsBounds: [] },
  tables: [{ rect: [10, 100, 210, 300] }],
  captions: [
    {
      page: 1,
      lines: ['Table 3: Distribution of measured characteristics'],
      rect: [12, 77, 198, 95]
    },
    { page: 1, lines: ['Table 3 (continues)'], rect: [160, 305, 208, 313] }
  ],
  rules: [[12, 101, 208, 101]]
})
it('associates the native-rule-proved full title above its same-number footer continuation marker', () => {
  const x = continuationMarkerLayout()
  expect(associateTableCaptions(x.page, x.tables, x.captions, x.rules)[0].caption).toEqual(
    x.captions[0]
  )
})
it.each([
  'missing rule',
  'competing rule',
  'short rule',
  'distant rule',
  'different number',
  'second complete description',
  'duplicate top title',
  'embedded marker'
])('keeps a caption tie without unique native same-number footer proof (%s)', (reason) => {
  const x = continuationMarkerLayout()
  if (reason === 'missing rule') x.rules = []
  if (reason === 'competing rule') x.rules.push([12, 102, 208, 102])
  if (reason === 'short rule') x.rules[0][2] = 180
  if (reason === 'distant rule') x.rules[0][1] = x.rules[0][3] = 110
  if (reason === 'different number') x.captions[1].lines = ['Table 4 (continues)']
  if (reason === 'second complete description')
    x.captions[1].lines = ['Table 3: Distribution of other measured characteristics']
  if (reason === 'duplicate top title') x.captions.push(structuredClone(x.captions[0]))
  if (reason === 'embedded marker') x.captions[1].rect = [160, 294, 208, 302]
  const result = associateTableCaptions(x.page, x.tables, x.captions, x.rules)[0]
  if (reason === 'embedded marker') expect(result.caption).toEqual(x.captions[0])
  else expect(result.reason).toBe('ambiguous-table-caption')
})
