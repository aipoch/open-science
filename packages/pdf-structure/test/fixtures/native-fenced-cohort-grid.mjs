/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { collectTableRules } from '../../resources/literature-pdf-graphics.mjs'
import { tableTextToken } from '../../resources/literature-pdf-orientation.mjs'

export function anonymousFencedCohort({
  multiline = true,
  headerLevels = 1,
  background = false,
  recordCount = 2,
  metricPairs = 1,
  literalMetrics = false,
  recordCounts,
  literalFault = '',
  stubLabels = ['Able', 'Beta']
} = {}) {
  const counts = recordCounts ?? [recordCount, recordCount],
    metricCount = metricPairs * 2,
    right = 170 + (metricCount - 1) * 50 + 50
  const width = Math.max(300, right + 30),
    height = Math.max(220, counts.reduce((sum, n) => sum + n * 16, 0) + 120),
    scale = 1.5,
    items = [],
    glyphs = new Map(),
    graphicsBounds = []
  const operators = { fnArray: [], argsArray: [] },
    add = (op, args) => {
      operators.fnArray.push(op)
      operators.argsArray.push(args)
    }
  const viewport = {
    width,
    height,
    scale: 1,
    rotation: 0,
    transform: [1, 0, 0, -1, 0, height],
    convertToViewportPoint: (x, y) => [x, height - y]
  }
  const work = {
    ...viewport,
    width: width * scale,
    height: height * scale,
    scale,
    transform: [scale, 0, 0, -scale, 0, height * scale],
    convertToViewportPoint: (x, y) => [x * scale, (height - y) * scale]
  }
  add(OPS.setFillRGBColor, ['#000000'])
  add(OPS.setStrokeRGBColor, ['#000000'])
  add(OPS.setLineWidth, [0.4])
  add(OPS.dependency, ['F'])
  const draw = (str, x, baseline) => {
    const parts = [...str].map((c) => {
      glyphs.set(c, { fontChar: c, bounds: [0, -0.1, 0.5, 0.7] })
      return { unicode: c, fontChar: c, width: 500, isInFont: true }
    })
    items.push({
      str,
      width: str.length * 5,
      height: 10,
      transform: [10, 0, 0, 10, x, height - baseline],
      fontName: 'F',
      dir: 'ltr',
      sourceItem: { pageNumber: 1, index: items.length, text: str }
    })
    add(OPS.beginText, null)
    add(OPS.setFont, ['F', 10])
    add(OPS.setTextMatrix, [[1, 0, 0, 1, x, height - baseline]])
    add(OPS.showText, [parts])
    add(OPS.endText, null)
  }
  const rule = (x, y, right) => {
    add(OPS.constructPath, [
      OPS.stroke,
      [[0, x, height - y, 1, right, height - y]],
      [x, height - y, right, height - y]
    ])
    graphicsBounds.push({
      kind: 'path',
      operationIndex: operators.fnArray.length - 1,
      normalizedRect: [x / width, (y - 0.2) / height, right / width, (y + 0.2) / height]
    })
  }
  draw('Table 1: Cohorts', 20, 20)
  const top = 30,
    divider = headerLevels === 2 ? 80 : headerLevels ? 70 : 50,
    steps = counts.map((count) => count * 16 + 8),
    bottom = divider + steps.reduce((sum, n) => sum + n, 0)
  rule(20, top, right)
  if (headerLevels === 2) {
    draw('Family', 180, 42)
    rule(155, 44, 250)
    draw('Left', 163, 55)
    draw('Right', 212, 55)
    rule(155, 56, 195)
    rule(205, 56, 250)
  }
  if (headerLevels === 1) {
    for (let g = 0; g < metricPairs; g++) {
      draw(metricPairs === 1 ? 'Scores' : `Scores${String.fromCharCode(65 + g)}`, 180 + 100 * g, 44)
      rule(155 + 100 * g, 49, 250 + 100 * g)
    }
  }
  draw('Method', 70, divider - 8)
  for (let c = 0; c < metricCount; c++) draw(String.fromCharCode(65 + c), 170 + c * 50, divider - 8)
  rule(20, divider, right)
  for (let g = 0; g < 2; g++) {
    const y = divider + steps.slice(0, g).reduce((sum, n) => sum + n, 0)
    draw(stubLabels[g], 22, y + 19)
    if (multiline) draw('Group', 22, y + 29)
    for (let r = 0; r < counts[g]; r++) {
      if (background && r === 1) {
        const yy = y + 30,
          box = [68, height - yy - 2, 103, height - yy + 9]
        add(OPS.setFillRGBColor, ['#f2f2f2'])
        add(OPS.constructPath, [
          OPS.fill,
          [[0, box[0], box[1], 1, box[2], box[1], 1, box[2], box[3], 1, box[0], box[3], 4]],
          box
        ])
        add(OPS.setFillRGBColor, ['#000000'])
        graphicsBounds.push({
          kind: 'path',
          operationIndex: operators.fnArray.length - 2,
          normalizedRect: [68 / width, (yy - 9) / height, 103 / width, (yy + 2) / height]
        })
      }
      draw(
        literalMetrics ? `Run${String.fromCharCode(65 + r)}` : r ? 'Second' : 'First',
        70,
        y + 14 + r * 16
      )
      for (let c = 0; c < metricCount; c++) {
        if (literalFault === 'missing' && g === 1 && r === 1 && c === 3) continue
        const literal = [
          '1,000',
          '2.5',
          literalFault === 'interior-word' && g === 1 && r === 1 ? 'other' : '3.2K',
          r === 2 ? '4/5' : r ? 'clear' : 'linked'
        ][c]
        draw(literalMetrics ? literal : `${g + c + 1}.${r}`, 170 + c * 50, y + 14 + r * 16)
      }
    }
    rule(20, y + steps[g], right)
  }
  const content = { items, styles: { F: { ascent: 0.7, descent: -0.1, vertical: false } } },
    tokens = items.map((i) => tableTextToken(i, work, 0)),
    paint = new Map(),
    rules = collectTableRules(operators, work, paint)
  const page = {
      pageNumber: 1,
      width,
      height,
      rotation: 0,
      renderRotation: 0,
      invalidGraphicsBounds: 0,
      graphicsBounds
    },
    native = {
      content,
      operators,
      glyphBounds: [{ fontName: 'F', glyphs: [...glyphs.values()] }],
      viewport,
      graphicsBounds,
      pageNumber: 1,
      sourceSha256: 'b'.repeat(64)
    }
  const identity = graphicsBounds.map((g) => ({
    kind: g.kind,
    operationIndex: g.operationIndex,
    rect: g.normalizedRect.map((v, n) => v * (n % 2 ? height : width) * scale)
  }))
  const crop = [19, top - 1, right + 1, bottom + 1].map((v) => v * scale),
    xs = [20, 150, ...Array.from({ length: metricCount - 1 }, (_, n) => 205 + n * 50), right],
    ys = [
      top,
      divider,
      ...counts.flatMap((count, g) =>
        Array.from(
          { length: count },
          (_, n) =>
            divider +
            steps.slice(0, g).reduce((sum, size) => sum + size, 0) +
            ((n + 1) * steps[g]) / count
        )
      )
    ]
  const columns = xs.slice(1).map((x, n) => ({
      label: 'table column',
      score: 0.99,
      rect: [xs[n] * scale - crop[0], 0, x * scale - crop[0], crop[3] - crop[1]]
    })),
    rows = ys.slice(1).map((y, n) => ({
      label: 'table row',
      score: 0.99,
      rect: [0, ys[n] * scale - crop[1], crop[2] - crop[0], y * scale - crop[1]]
    }))
  const structure = {
    objects: [
      ...columns,
      ...rows,
      {
        label: 'table column header',
        score: 0.99,
        rect: [0, 0, crop[2] - crop[0], divider * scale - crop[1]]
      }
    ]
  }
  return {
    table: {
      id: 'page-1-table-1',
      page: 1,
      readingRotation: 0,
      cropRect: crop,
      structure
    },
    tokens,
    rules,
    paint,
    context: {
      sourcePage: page,
      nativeGlyphContext: native,
      sourceContent: content,
      content,
      viewport: work,
      operators,
      rulePaintBounds: paint,
      nativePaintIdentityGraphics: identity,
      nativeEvidenceGraphics: identity.map(({ kind, rect }) => ({ kind, rect }))
    },
    captions: [{ page: 1, lines: [items[0].str], rect: [30, 15, 150, 30] }],
    draw,
    rule
  }
}
