/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { collectTableRules } from '../../resources/literature-pdf-graphics.mjs'
import { tableTextToken } from '../../resources/literature-pdf-orientation.mjs'
import { nativeWhitespaceGaps } from '../../resources/literature-pdf-symbol-text.mjs'

export function anonymousMeasuredHeadingOwners({
  studyX = 47,
  header = 'Year Study',
  headerGap = 3.7
} = {}) {
  const width = 320,
    height = 220,
    scale = 1.5,
    items = [],
    glyphs = new Map(),
    graphicsBounds = [],
    operators = { fnArray: [], argsArray: [] },
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
    },
    work = {
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
  const draw = (str, x, baseline, { gap = 5, multi = false } = {}) => {
    const sourceItem = { pageNumber: 1, index: items.length, text: str },
      parts = []
    let advance = 0
    for (const c of str) {
      if (c === ' ') {
        parts.push(-gap * 100)
        advance += gap
      } else {
        parts.push({ unicode: c, fontChar: c, width: 500, isInFont: true })
        advance += 5
        glyphs.set(c, { fontChar: c, bounds: [0, -0.1, 0.5, 0.7] })
      }
    }
    items.push({
      str,
      width: advance,
      height: 10,
      transform: [10, 0, 0, 10, x, height - baseline],
      fontName: 'F',
      dir: 'ltr',
      sourceItem
    })
    add(OPS.beginText, null)
    add(OPS.setFont, ['F', 10])
    add(OPS.setTextMatrix, [[1, 0, 0, 1, x, height - baseline]])
    if (multi) {
      add(OPS.showText, [parts.slice(0, 6)])
      add(OPS.showText, [parts.slice(6, 7)])
      add(OPS.showText, [parts.slice(7)])
    } else add(OPS.showText, [parts])
    add(OPS.endText, null)
  }
  draw('Table 1: Summary', 20, 20)
  draw(header, 20, 50, { gap: headerGap })
  draw('Focus', 110, 50)
  draw('Main', 180, 50)
  for (let r = 0; r < 3; r++) {
    draw(String(2020 + r), 20, 80 + r * 30)
    draw('Alpha [1]', studyX, 80 + r * 30, { multi: true })
    draw('Topic', 110, 80 + r * 30)
    draw('Description', 180, 80 + r * 30)
  }
  for (const y of [30, 60, 160]) {
    add(OPS.constructPath, [
      OPS.stroke,
      [[0, 20, height - y, 1, 300, height - y]],
      [20, height - y, 300, height - y]
    ])
    graphicsBounds.push({
      kind: 'path',
      operationIndex: operators.fnArray.length - 1,
      normalizedRect: [20 / width, (y - 0.2) / height, 300 / width, (y + 0.2) / height]
    })
  }
  const sourceContent = { items, styles: { F: { ascent: 0.7, descent: -0.1, vertical: false } } },
    tokens = items.map((i) => tableTextToken(i, work, 0)),
    rules = collectTableRules(operators, work),
    paint = new Map()
  collectTableRules(operators, work, paint)
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
      content: sourceContent,
      operators,
      glyphBounds: [{ fontName: 'F', glyphs: [...glyphs.values()] }],
      viewport,
      graphicsBounds,
      pageNumber: 1,
      sourceSha256: 'a'.repeat(64)
    },
    identity = graphicsBounds.map((g) => ({
      kind: g.kind,
      operationIndex: g.operationIndex,
      rect: g.normalizedRect.map((v, n) => v * (n % 2 ? height : width) * scale)
    }))
  const context = {
    sourcePage: page,
    nativeGlyphContext: native,
    sourceContent,
    content: sourceContent,
    viewport: work,
    operators,
    rulePaintBounds: paint,
    nativePaintIdentityGraphics: identity,
    nativeEvidenceGraphics: identity.map(({ kind, rect }) => ({ kind, rect }))
  }
  const crop = [19, 29, 301, 161].map((v) => v * scale),
    xs = [20, 42, 105, 175, 300],
    ys = [30, 60, 95, 125, 160],
    table = {
      id: 'page-1-table-1',
      page: 1,
      readingRotation: 0,
      cropRect: crop,
      structure: {
        objects: [
          ...xs.slice(1).map((x, c) => ({
            label: 'table column',
            score: 0.99,
            rect: [xs[c] * scale - crop[0], 0, x * scale - crop[0], crop[3] - crop[1]]
          })),
          ...ys.slice(1).map((y, r) => ({
            label: 'table row',
            score: 0.99,
            rect: [0, ys[r] * scale - crop[1], crop[2] - crop[0], y * scale - crop[1]]
          })),
          {
            label: 'table column header',
            score: 0.99,
            rect: [0, 0, crop[2] - crop[0], 60 * scale - crop[1]]
          }
        ]
      }
    }
  return {
    table,
    tokens,
    rules,
    paint,
    context,
    captions: [{ page: 1, lines: [items[0].str], rect: [30, 15, 150, 30] }],
    runs: nativeWhitespaceGaps(sourceContent, operators, work)
  }
}
