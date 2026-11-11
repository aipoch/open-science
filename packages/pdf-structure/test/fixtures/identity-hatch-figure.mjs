/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { anonymousClosedSaveFigure } from './closed-save-figure.mjs'
import { tableTextToken } from '../../resources/literature-pdf-orientation.mjs'

export function anonymousIdentityHatchFigure(pair = false) {
  const f = anonymousClosedSaveFigure(),
    a = f.args,
    c = a[5],
    o = c.operators
  c.pageNumber = 1
  c.sourceSha256 = 'b'.repeat(64)
  const tile = () => [
    'TilingPattern',
    '#a5c0ca',
    {
      fnArray: [OPS.save, OPS.setLineWidth, OPS.constructPath, OPS.restore],
      argsArray: [
        null,
        [0.4],
        [OPS.stroke, [new Float32Array([0, 0, 0, 1, 3, 3])], new Float32Array([0, 0, 3, 3])],
        null
      ],
      length: 4
    },
    [1, 0, 0, 1, 0, 0],
    [-1, -1, 4, 4],
    3,
    3,
    2,
    1
  ]
  for (let i = o.fnArray.length - 1; i >= 0; i--)
    if (o.fnArray[i] === OPS.constructPath && o.argsArray[i][0] === OPS.fill) {
      o.fnArray.splice(i, 0, OPS.setFillColorN)
      o.argsArray.splice(i, 0, tile())
      c.graphicsBounds.forEach((g) => {
        if (g.operationIndex >= i) g.operationIndex++
      })
    }
  // Each independent saved picture has neutral alpha and restores solid text.
  const at = o.fnArray.indexOf(OPS.beginText)
  o.fnArray.splice(at, 0, OPS.setFillRGBColor)
  o.argsArray.splice(at, 0, ['#000000'])
  c.graphicsBounds.forEach((g) => {
    if (g.operationIndex >= at) g.operationIndex++
  })
  o.fnArray.unshift(OPS.setGState)
  o.argsArray.unshift([
    [
      ['CA', 1],
      ['ca', 1]
    ]
  ])
  c.graphicsBounds.forEach((g) => g.operationIndex++)
  if (pair) {
    const second = structuredClone({
        operators: o,
        items: c.content.items,
        graphics: c.graphicsBounds
      }),
      offset = o.fnArray.length
    const caption = 'Figure 2. Independent blocks.'
    for (let i = 0; i < second.operators.fnArray.length; i++) {
      const op = second.operators.fnArray[i],
        q = second.operators.argsArray[i]
      if (op === OPS.setTextMatrix) q[0][4] += 400
      if (op === OPS.constructPath && q[2]) {
        for (const p of q[1])
          if (p)
            for (let k = 0; k < p.length;) {
              const code = p[k++]
              if (code === 4) continue
              const n = code === 2 ? 3 : 1
              for (let j = 0; j < n; j++) {
                p[k] += 400
                k += 2
              }
            }
        q[2][0] += 400
        q[2][2] += 400
      }
      if (op === OPS.showText && q[0][0].unicode.startsWith('Figure')) {
        q[0][0].unicode = q[0][0].fontChar = caption
        q[0][0].width = caption.length * 500
      }
    }
    for (const r of second.items) {
      r.transform[4] += 400
      r.sourceItem.index += c.content.items.length
      if (r.str.startsWith('Figure')) {
        r.str = r.sourceItem.text = caption
        r.width = caption.length * 5
      }
    }
    c.glyphBounds[0].glyphs.push({
      fontChar: caption,
      bounds: [0, -0.1, caption.length * 0.5, 0.7]
    })
    for (const g of c.graphicsBounds)
      g.normalizedRect = g.normalizedRect.map((v, n) => (n % 2 ? v : v / 2))
    for (const g of second.graphics) {
      g.operationIndex += offset
      g.normalizedRect = g.normalizedRect.map((v, n) => (n % 2 ? v : (v + 1) / 2))
    }
    o.fnArray.push(...second.operators.fnArray)
    o.argsArray.push(...second.operators.argsArray)
    c.content.items.push(...second.items)
    c.graphicsBounds.push(...second.graphics)
    a[0].width = c.viewport.width = 800
    a[2].push({ page: 1, lines: [caption], rect: [440, 210, 750, 235] })
  }
  a[4] = c.content.items.map((r) => tableTextToken(r, c.viewport, 0))
  return { ...f, peers: [a[1], ...(pair ? [{ rect: [450, 60, 680, 160], caption: a[2][1] }] : [])] }
}
