import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { resolve } from './paths'

const { associateFigures } = await import(
  pathToFileURL(resolve('resources/literature-pdf-association.mjs')).href
)
const { collectClosedFigureFrames } = await import(
  pathToFileURL(resolve('resources/literature-pdf-graphics.mjs')).href
)
const { nativeOverlayDiagramLines } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-overlay-note.mjs')).href
)

function overlayFigure(): ReturnType<typeof JSON.parse> {
  const width = 600,
    height = 800
  const operators: ReturnType<typeof JSON.parse> = { fnArray: [], argsArray: [] }
  const items: ReturnType<typeof JSON.parse>[] = [],
    tokens: ReturnType<typeof JSON.parse>[] = []
  const lines: ReturnType<typeof JSON.parse>[] = [],
    graphicsBounds: ReturnType<typeof JSON.parse>[] = []
  const op = (name: number, args: unknown[]): void => {
    operators.fnArray.push(name)
    operators.argsArray.push(args)
  }
  const paint = (r: number[], closed = true): void => {
    const [l, t, right, b] = r
    const program = closed
      ? [0, l, height - t, 1, right, height - t, 1, right, height - b, 1, l, height - b, 4]
      : [0, l, height - t, 1, right, height - b]
    const bounds = [Math.min(l, right), Math.min(t, b), Math.max(l, right), Math.max(t, b)]
    graphicsBounds.push({
      kind: 'path',
      operationIndex: operators.fnArray.length,
      normalizedRect: bounds.map((v, i) => (v + (i < 2 ? -0.5 : 0.5)) / (i % 2 ? height : width))
    })
    op(OPS.constructPath, [
      closed ? OPS.fillStroke : OPS.stroke,
      [program],
      [l, height - b, right, height - t]
    ])
  }
  const text = (str: string, x: number, y: number, w = 40): void => {
    const sourceItem = { pageNumber: 1, index: items.length, text: str }
    items.push({
      str,
      dir: 'ltr',
      transform: [10, 0, 0, 10, x, height - y - 10],
      width: w,
      height: 10,
      fontName: 'f',
      sourceItem
    })
    tokens.push({
      text: str,
      rect: [x, y, x + w, y + 10],
      horizontal: true,
      height: 10,
      baseline: y + 10,
      sourceItem
    })
    lines.push({ text: str, x, y, width: w, height: 10, fontSize: 10 })
  }
  for (const r of [
    [270, 100, 330, 130],
    [270, 180, 330, 210],
    [220, 290, 280, 320],
    [220, 370, 280, 400],
    [390, 370, 450, 400],
    [120, 470, 180, 500],
    [120, 550, 180, 580],
    [120, 630, 180, 660]
  ]) {
    paint(r)
    text('Stage', r[0] + 10, r[1] + 10)
  }
  for (const r of [
    [300, 210.5, 250, 289.5],
    [252, 289.5, 302, 210.5],
    [250, 400.5, 150, 469.5],
    [152, 469.5, 252, 400.5]
  ])
    paint(r, false)
  const overlayOperation = operators.fnArray.length
  paint([120, 270, 500, 430])
  for (const y of [280, 330, 380])
    text(
      'An explanatory observation describes the interactions between the displayed stages.',
      130,
      y,
      360
    )
  text('Upper stage', 270, 80, 60)
  const caption = {
    page: 1,
    rect: [70, 700, 530, 720],
    lines: ['Figure 1: Model stages and explanatory panel.']
  }
  const page = {
    pageNumber: 1,
    width,
    height,
    rotation: 0,
    invalidGraphicsBounds: 0,
    lines,
    graphicsBounds
  }
  const viewport = {
    width,
    height,
    rotation: 0,
    transform: [1, 0, 0, -1, 0, height],
    convertToViewportPoint: (x: number, y: number) => [x, height - y]
  }
  const context = {
    operators,
    viewport,
    content: { items, styles: { f: { ascent: 0.8, descent: -0.2 } } }
  }
  const frames = collectClosedFigureFrames(operators, viewport)
  return { page, caption, tokens, context, frames, overlayOperation }
}

it('retains the upper graph across a later opaque explanatory overlay', () => {
  const f = overlayFigure()
  const before = JSON.stringify(f)
  const figures = associateFigures(f.page, [f.caption], [], [], f.frames, f.tokens, f.context)
  expect(figures[0].rect[1]).toBeLessThanOrEqual(100)
  expect(JSON.stringify(f)).toBe(before)
})

it('returns only original enclosed paragraph lines without changing native inputs', () => {
  const f = overlayFigure(),
    before = JSON.stringify(f)
  const proof = nativeOverlayDiagramLines(f.page, [f.caption], [], f.tokens, f.context)
  expect([...proof]).toEqual(f.page.lines.filter((l: { text: string }) => l.text.length > 60))
  expect(JSON.stringify(f)).toBe(before)
})

it.each(['complete', 'missing', 'detached', 'one-sided'])(
  'requires exact independent arrowhead attachment: %s',
  (variant) => {
    const f = overlayFigure(),
      o = f.context.operators
    const heads: number[][] = []
    for (const index of [9, 10]) {
      const p = o.argsArray[index][1][0],
        start = [p[1], 800 - p[2]],
        tip = [p[4], 800 - p[5]]
      const length = Math.hypot(tip[0] - start[0], tip[1] - start[1]),
        dx = (tip[0] - start[0]) / length,
        dy = (tip[1] - start[1]) / length,
        notch = [tip[0] - dx * 3, tip[1] - dy * 3]
      p[4] = notch[0]
      p[5] = 800 - notch[1]
      const points = [
        tip,
        [notch[0] - dx - dy * 2, notch[1] - dy + dx * 2],
        notch,
        [notch[0] - dx + dy * 2, notch[1] - dy - dx * 2]
      ]
      if (variant === 'detached') points[2] = [notch[0] + 1, notch[1]]
      if (variant === 'one-sided') points[3] = points[1]
      heads.push(points.flatMap((p, i) => [i === 0 ? 0 : 1, p[0], 800 - p[1]]))
    }
    if (variant !== 'missing')
      for (const p of heads) {
        o.fnArray.splice(f.overlayOperation, 0, OPS.constructPath)
        o.argsArray.splice(f.overlayOperation, 0, [OPS.fill, [p], null])
      }
    const proof = nativeOverlayDiagramLines(f.page, [f.caption], [], f.tokens, f.context)
    expect(proof.size).toBe(variant === 'complete' ? 3 : 0)
  }
)

it.each([
  'uncovered',
  'early',
  'missing-node',
  'single-side',
  'same-direction',
  'transparent',
  'blend',
  'unknown-state',
  'annotation',
  'clipped',
  'external-prose',
  'caption',
  'source-conflict',
  'incomplete-source',
  'short-transform',
  'invalid-rect',
  'source-alias',
  'nested-source',
  'duplicate-paints',
  'dangling-connector',
  'unbalanced',
  'invalid-transform',
  'invalid-alpha',
  'invalid-path',
  'corner-only',
  'transparent-color',
  'invalid-font',
  'invalid-show-text'
])('retains prose barriers when the native overlay proof is incomplete: %s', (variant) => {
  const f = overlayFigure(),
    o = f.context.operators
  const insert = (index: number, op: number, args: unknown[]): void => {
    o.fnArray.splice(index, 0, op)
    o.argsArray.splice(index, 0, args)
  }
  if (variant === 'uncovered') o.argsArray[f.overlayOperation][0] = OPS.stroke
  if (variant === 'early') {
    const a = o.argsArray.splice(f.overlayOperation, 1)[0],
      op = o.fnArray.splice(f.overlayOperation, 1)[0]
    o.argsArray.unshift(a)
    o.fnArray.unshift(op)
  }
  if (variant === 'missing-node') o.argsArray[4][0] = OPS.fill
  if (variant === 'single-side') {
    o.argsArray[10][0] = OPS.fill
    o.argsArray[11][0] = OPS.fill
  }
  if (variant === 'same-direction') o.argsArray[9][1][0] = [0, 302, 589.5, 1, 252, 510.5]
  if (variant === 'transparent') insert(f.overlayOperation, OPS.setGState, [[['ca', 0.5]]])
  if (variant === 'blend') insert(f.overlayOperation, OPS.setGState, [[['BM', 'Multiply']]])
  if (variant === 'unknown-state') insert(f.overlayOperation, OPS.setGState, [[['Unproved', 1]]])
  if (variant === 'annotation') insert(f.overlayOperation, OPS.beginAnnotation, [])
  if (variant === 'clipped') {
    insert(0, OPS.paintFormXObjectBegin, [null, [0, 0, 600, 450]])
    o.fnArray.push(OPS.paintFormXObjectEnd)
    o.argsArray.push([])
  }
  if (variant === 'external-prose')
    f.page.lines.push({
      text: 'Ordinary external prose crosses the alleged diagram note and must remain a barrier.',
      x: 90,
      y: 350,
      width: 400,
      height: 10,
      fontSize: 10
    })
  if (variant === 'caption') f.caption.rect = [130, 330, 490, 340]
  if (variant === 'source-conflict') f.tokens.push({ ...f.tokens[8] })
  if (variant === 'incomplete-source') f.tokens.pop()
  if (variant === 'short-transform') f.context.viewport.transform.pop()
  if (variant === 'invalid-rect') f.tokens[8].rect.pop()
  if (variant === 'source-alias')
    f.tokens[8].sourceSegment = { ...f.tokens[8].sourceItem, start: 0, end: 1 }
  if (variant === 'nested-source') f.tokens[8].sourceItem.sourceItem = { ...f.tokens[8].sourceItem }
  if (variant === 'duplicate-paints') o.argsArray[9][1][0] = [0, 250, 510.5, 1, 300, 589.5]
  if (variant === 'dangling-connector') o.argsArray[9][1][0] = [0, 360, 510.5, 1, 302, 589.5]
  if (variant === 'unbalanced') insert(0, OPS.restore, [])
  if (variant === 'invalid-transform') insert(0, OPS.transform, [1, 0, 0, 1, NaN, 0])
  if (variant === 'invalid-alpha') insert(0, OPS.setGState, [[['ca', NaN]]])
  if (variant === 'invalid-path') o.argsArray[0][1][0] = [0, 30]
  if (variant === 'corner-only') o.argsArray[8][1][0] = [0, 269.5, 589.5, 1, 250, 510.5]
  if (variant === 'transparent-color')
    insert(f.overlayOperation, OPS.setFillRGBColor, ['#ffffff00'])
  if (variant === 'invalid-font') insert(0, OPS.setFont, ['f', NaN])
  if (variant === 'invalid-show-text') insert(0, OPS.showText, [[{ unicode: 'x', width: NaN }]])
  expect([...nativeOverlayDiagramLines(f.page, [f.caption], [], f.tokens, f.context)]).toEqual([])
})
