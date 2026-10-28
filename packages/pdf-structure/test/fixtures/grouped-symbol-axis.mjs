/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { tableTextToken } from '../../resources/literature-pdf-orientation.mjs'
import { nativeFigureLabelBounds } from '../../resources/literature-pdf-figure-crop-geometry.mjs'
export function anonymousGroupedAxis({ foreignUnicode = false, claimedUnicode = false } = {}) {
  const width = 400,
    height = 300,
    fnArray = [],
    argsArray = [],
    items = [],
    tokens = [],
    glyphs = [],
    graphicsBounds = [],
    rules = [],
    programs = [],
    viewport = {
      width,
      height,
      scale: 1,
      rotation: 0,
      transform: [1, 0, 0, -1, 0, height],
      convertToViewportPoint: (x, y) => [x, height - y]
    },
    add = (op, args) => {
      fnArray.push(op)
      argsArray.push(args)
    }
  const line = (r, kind = OPS.stroke) => {
    const [x0, y0, x1, y1] = r,
      i = fnArray.length
    add(OPS.constructPath, [
      kind,
      [[0, x0, height - y0, 1, x1, height - y1]],
      [Math.min(x0, x1), height - Math.max(y0, y1), Math.max(x0, x1), height - Math.min(y0, y1)]
    ])
    graphicsBounds.push({
      operationIndex: i,
      kind: 'path',
      normalizedRect: [
        (Math.min(x0, x1) - 0.25) / width,
        (Math.min(y0, y1) - 0.25) / height,
        (Math.max(x0, x1) + 0.25) / width,
        (Math.max(y0, y1) + 0.25) / height
      ]
    })
  }
  const show = (text, x, y, type3 = false, painted = text, font = 'F') => {
    add(OPS.beginText, null)
    const size = type3 ? 12.5 : 10
    add(OPS.setFont, [type3 ? 'T' : font, size])
    add(OPS.setTextMatrix, [[1, 0, 0, 1, x, height - y]])
    const op = fnArray.length,
      g = {
        unicode: painted,
        fontChar: type3 ? '' : painted,
        width: 500,
        isInFont: true,
        isSpace: false,
        accent: null,
        ...(type3 ? { operatorListId: 'shape-q' } : {})
      }
    add(OPS.showText, [[g]])
    add(OPS.endText, null)
    const sourceItem = { pageNumber: 1, index: items.length, text },
      r = {
        str: text,
        dir: 'ltr',
        width: size * 0.5,
        height: size,
        transform: [size, 0, 0, size, x, height - y],
        fontName: type3 ? 'T' : font,
        hasEOL: false,
        sourceItem
      }
    items.push(r)
    tokens.push({
      ...tableTextToken(r, viewport, 0),
      fontAscent: 0.7,
      fontDescent: -0.1,
      nativeLabelRect: nativeFigureLabelBounds(r, { ascent: 0.7, descent: -0.1 }, viewport)
    })
    if (type3)
      programs.push({
        fontName: 'T',
        fontMatrix: [0.001, 0, 0, 0.001, 0, 0],
        sourceIndices: [sourceItem.index],
        glyphs: [
          {
            operatorListId: 'shape-q',
            unicode: painted,
            width: 500,
            kind: 'filled-path',
            bounds: [0, -100, 500, 700],
            clip: [0, -100, 500, 700],
            paint: OPS.fill,
            occurrences: [{ operationIndex: op, glyphIndex: 0 }]
          }
        ]
      })
    else if (!glyphs.some((g) => g.fontChar === painted))
      glyphs.push({ fontChar: painted, bounds: [0, -0.1, 0.5, 0.7] })
    return sourceItem
  }
  add(OPS.setFillRGBColor, ['#000000'])
  add(OPS.setStrokeRGBColor, ['#000000'])
  add(OPS.setLineWidth, [0.5])
  add(OPS.setMiterLimit, [1])
  const group = {
    matrix: null,
    bbox: [10, 275, 40, 290],
    isolated: true,
    knockout: false,
    smask: null
  }
  add(OPS.beginGroup, [group])
  add(OPS.paintFormXObjectBegin, [null, null])
  add(OPS.paintFormXObjectEnd, null)
  add(OPS.endGroup, [group])
  add(OPS.paintFormXObjectBegin, [null, [80, 100, 310, 275]])
  const fi = fnArray.length
  add(OPS.constructPath, [
    OPS.fill,
    [[0, 120, 230, 1, 250, 230, 1, 250, 160, 1, 120, 160, 4]],
    [120, 160, 250, 230]
  ])
  graphicsBounds.push({
    operationIndex: fi,
    kind: 'path',
    normalizedRect: [0.3, 70 / 300, 0.625, 140 / 300]
  })
  for (const r of [
    [100, 40, 100, 150],
    [280, 40, 280, 150],
    [100, 40, 280, 40],
    [100, 150, 280, 150]
  ]) {
    rules.push(r)
    line(r)
  }
  for (const [x, text] of [
    [120, '0'],
    [190, '1'],
    [260, '2']
  ]) {
    line([x, 150, x, 154], OPS.fillStroke)
    show(text, x - 2.5, 165)
  }
  const title = show(claimedUnicode ? 'μ' : 'q', 186.875, 182.5, true, claimedUnicode ? 'µ' : 'q')
  add(OPS.paintFormXObjectEnd, null)
  show('C', 60, 235, false, 'C', 'G')
  if (foreignUnicode) show('μ', 330, 270, false, 'µ', 'G')
  const caption = { page: 1, lines: ['Figure 1. Example.'], rect: [60, 220, 340, 238] },
    page = {
      pageNumber: 1,
      width,
      height,
      rotation: 0,
      renderRotation: 0,
      invalidGraphicsBounds: 0,
      lines: [],
      graphicsBounds
    },
    context = {
      operators: { fnArray, argsArray },
      viewport,
      content: {
        items,
        styles: {
          F: { ascent: 0.7, descent: -0.1, vertical: false },
          G: { ascent: 0.7, descent: -0.1, vertical: false },
          T: { ascent: 0.7, descent: -0.1 }
        }
      },
      partialFontGlyphBounds: [
        { fontName: 'F', glyphs },
        { fontName: 'G', glyphs }
      ],
      type3GlyphPrograms: programs,
      graphicsBounds
    }
  return {
    args: [page, [caption], [], rules, [], tokens, context],
    title,
    figure: { caption, rect: [99.75, 39.75, 280.25, 165], graphicsCount: 7 }
  }
}
