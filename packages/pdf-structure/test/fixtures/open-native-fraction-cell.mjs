/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { tableTextToken } from '../../resources/literature-pdf-orientation.mjs'
import { collectTableRules } from '../../resources/literature-pdf-graphics.mjs'

// One stacked fraction and one exterior whole source with a coarse advance.
// Its used glyph outline remains exact and must stay in the foreign inventory.
export function anonymousNativeFractionCell() {
  const width = 200,
    height = 120,
    items = [],
    glyphs = [],
    fnArray = [],
    argsArray = []
  const add = (op, args) => {
    fnArray.push(op)
    argsArray.push(args)
  }
  const viewport = { width, height, scale: 1, rotation: 0, transform: [1, 0, 0, -1, 0, height] }
  const text = (str, x, baseline, size, sourceWidth = size / 2) => {
    add(OPS.beginText, [])
    add(OPS.setFont, ['F', size])
    add(OPS.setTextMatrix, [[1, 0, 0, 1, x, height - baseline]])
    add(OPS.showText, [[{ unicode: str, fontChar: str, width: 500, isInFont: true }]])
    add(OPS.endText, [])
    const sourceItem = { pageNumber: 1, index: items.length, text: str }
    items.push({
      str,
      dir: 'ltr',
      width: sourceWidth,
      height: size,
      transform: [size, 0, 0, size, x, height - baseline],
      fontName: 'F',
      hasEOL: false,
      sourceItem
    })
    glyphs.push({ fontChar: str, bounds: [0.05, -0.1, 0.45, 0.7] })
  }
  add(OPS.setFillRGBColor, ['#000000'])
  text('1', 20, 26, 8)
  text('n', 20, 40, 8)
  text('a', 25, 33, 14)
  text('z', 100, 80, 10, 20)
  const operationIndex = fnArray.length,
    bar = [20, 29.8, 24, 30.2]
  add(OPS.constructPath, [
    OPS.fill,
    [
      [
        0,
        20,
        height - bar[1],
        1,
        24,
        height - bar[1],
        1,
        24,
        height - bar[3],
        1,
        20,
        height - bar[3],
        4
      ]
    ],
    [20, height - bar[3], 24, height - bar[1]]
  ])
  const graphicsBounds = [
    {
      kind: 'path',
      operationIndex,
      normalizedRect: bar.map((n, i) => n / (i % 2 ? height : width))
    }
  ]
  const content = { items, styles: { F: { ascent: 0.8, descent: -0.2, vertical: false } } }
  const nativeGlyphContext = {
    pageNumber: 1,
    sourceSha256: 'a'.repeat(64),
    viewport,
    content,
    operators: { fnArray, argsArray },
    glyphBounds: [{ fontName: 'F', glyphs }],
    graphicsBounds
  }
  const sourceContent = structuredClone(content),
    operators = structuredClone(nativeGlyphContext.operators)
  const currentViewport = { ...viewport, convertToViewportPoint: (x, y) => [x, height - y] }
  const inventory = items.map((i) => {
    const t = tableTextToken(i, currentViewport, 0)
    return {
      ...t,
      fontAscent: 0.8,
      fontDescent: -0.2,
      nativeLabelRect: [
        t.rect[0],
        t.baseline - t.height * 0.8,
        t.rect[2],
        t.baseline + t.height * 0.2
      ]
    }
  })
  const cell = {
    row: 0,
    column: 0,
    rowSpan: 1,
    colSpan: 1,
    text: '1 n a',
    sourceItems: items.slice(0, 3).map((i) => i.sourceItem),
    sourceRects: inventory.slice(0, 3).map((f) => f.rect)
  }
  const table = {
    page: 1,
    cropRect: [10, 15, 60, 48],
    grid: [[cell.text]],
    cells: [cell],
    issues: [],
    reviewCandidate: true
  }
  const nativeEvidenceGraphics = [{ kind: 'path', rect: bar }]
  const context = {
    sourceSha256: nativeGlyphContext.sourceSha256,
    nativeGlyphContext,
    sourcePage: { pageNumber: 1, width, height, invalidGraphicsBounds: 0, graphicsBounds },
    sourceContent,
    content: sourceContent,
    operators,
    viewport: currentViewport,
    nativeEvidenceGraphics,
    nativePaintIdentityGraphics: [{ ...nativeEvidenceGraphics[0], operationIndex }]
  }
  return { table, inventory, rules: collectTableRules(operators, currentViewport), context }
}
