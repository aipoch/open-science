/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
export function ordinaryExample(mode = 'plain') {
  const width = 400,
    height = 160,
    rows = [
      ['Name', 'Value', 'Error', 'Range'],
      ['East', '1.2', '0.1', '[1, 2]'],
      ['West', '-0.3', '0.2', '[-1, 0]']
    ],
    xs = [20, 110, 200, 290],
    baselines = [33, 63, 85],
    tokens = []
  for (let row = 0; row < 3; row++)
    for (let col = 0; col < 4; col++) {
      if (mode === 'grouped' && col === 0 && row > 0) continue
      if (mode === 'merged-header' && row === 0 && col === 2) continue
      const text = rows[row][col],
        x = xs[col],
        baseline = baselines[row]
      tokens.push({
        text,
        rect: [x, baseline - 8, x + text.length * 4, baseline],
        baseline,
        height: 8,
        horizontal: true,
        sourceItem: { pageNumber: 1, index: tokens.length, text }
      })
    }
  if (mode === 'grouped') {
    const text = 'Pair'
    tokens.push({
      text,
      rect: [20, 66, 36, 74],
      baseline: 74,
      height: 8,
      horizontal: true,
      sourceItem: { pageNumber: 1, index: tokens.length, text }
    })
  }
  if (mode === 'foreign-ink') {
    const text = 'X'
    tokens.push({
      text,
      rect: [380, 96, 384, 104],
      baseline: 104,
      height: 8,
      horizontal: true,
      sourceItem: { pageNumber: 1, index: tokens.length, text }
    })
  }
  const viewport = {
      width,
      height,
      scale: 1,
      rotation: 0,
      transform: [1, 0, 0, -1, 0, height],
      convertToViewportPoint: (x, y) => [x, height - y]
    },
    content = {
      items: tokens.map((t) => ({
        str: t.text,
        width: t.text.length * 4,
        height: 8,
        dir: 'ltr',
        fontName: 'F',
        transform: [8, 0, 0, 8, t.rect[0], height - t.baseline],
        sourceItem: { ...t.sourceItem }
      })),
      styles: { F: { ascent: 0.8, descent: -0.2, vertical: false } }
    },
    operators = { fnArray: [], argsArray: [] }
  for (const item of content.items) {
    operators.fnArray.push(OPS.beginText, OPS.setFont, OPS.setTextMatrix, OPS.showText, OPS.endText)
    operators.argsArray.push(
      null,
      ['F', 8],
      [new Float32Array([1, 0, 0, 1, item.transform[4], item.transform[5]])],
      [Array.from(item.str, (c) => ({ unicode: c, fontChar: c, width: 500, isInFont: true }))],
      null
    )
  }
  operators.fnArray.push(OPS.setLineWidth, OPS.setLineCap)
  operators.argsArray.push([0.5], [0])
  const railYs = mode === 'missing-rule' ? [20, 100] : [20, 40, 100],
    graphicsBounds = railYs.map((y) => {
      const operationIndex = operators.fnArray.length
      operators.fnArray.push(OPS.constructPath)
      operators.argsArray.push([
        OPS.stroke,
        [new Float32Array([0, 10, height - y, 1, 390, height - y])],
        new Float32Array([10, height - y, 390, height - y])
      ])
      return {
        kind: 'path',
        operationIndex,
        normalizedRect: [10 / width, y / height, 390 / width, y / height]
      }
    })
  const context = {
      content,
      viewport,
      operators,
      graphicsBounds,
      glyphBounds: [
        {
          fontName: 'F',
          glyphs: [...new Set(content.items.flatMap((i) => Array.from(i.str)))].map((fontChar) => ({
            fontChar,
            bounds: fontChar === ' ' ? [0, 0, 0, 0] : [0, 0, 0.5, 0.7]
          }))
        }
      ]
    },
    page = { pageNumber: 1, width, height, invalidGraphicsBounds: 0, graphicsBounds }
  return { page, tokens, context, rows }
}
