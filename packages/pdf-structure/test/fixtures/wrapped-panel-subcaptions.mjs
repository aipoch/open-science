/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { tableTextToken } from '../../resources/literature-pdf-orientation.mjs'

export function anonymousWrappedPanelSubcaptions({
  mode = 'raster',
  scale = 1,
  dx = 0,
  extraTailParagraph = false,
  hyphenContinuation = false,
  duplicateMarker = false
} = {}) {
  const width = 400 * scale + dx,
    height = 460 * scale,
    operators = { fnArray: [], argsArray: [] },
    graphicsBounds = [],
    items = [],
    glyphs = [],
    tokens = [],
    lines = [],
    point = (x, y) => [x * scale + dx, height - y * scale],
    rect = (r) => r.map((v, i) => v * scale + (i % 2 === 0 ? dx : 0)),
    viewport = {
      width,
      height,
      scale: 1,
      rotation: 0,
      transform: [1, 0, 0, -1, 0, height],
      convertToViewportPoint: (x, y) => [x, height - y]
    },
    add = (op, args) => {
      operators.fnArray.push(op)
      operators.argsArray.push(args)
    },
    text = (str, x, baseline) => {
      const [px, py] = point(x, baseline),
        em = 10 * scale
      add(OPS.beginText, null)
      add(OPS.setFont, ['F', em])
      add(OPS.setTextMatrix, [[1, 0, 0, 1, px, py]])
      add(OPS.showText, [
        [{ unicode: str, fontChar: str, width: 500 * str.length, isInFont: true }]
      ])
      add(OPS.endText, null)
      const raw = {
        str,
        dir: 'ltr',
        width: em * 0.5 * str.length,
        height: em,
        transform: [em, 0, 0, em, px, py],
        fontName: 'F',
        hasEOL: true,
        sourceItem: { pageNumber: 1, index: items.length, text: str }
      }
      items.push(raw)
      if (!glyphs.some((g) => g.fontChar === str))
        glyphs.push({ fontChar: str, bounds: [0, -0.1, str.length * 0.5, 0.7] })
      tokens.push(tableTextToken(raw, viewport, 0))
      lines.push({
        text: str,
        x: px,
        y: baseline * scale - em,
        width: raw.width,
        height: em,
        fontSize: em
      })
    }
  add(OPS.setFillRGBColor, ['#000000'])
  add(OPS.setStrokeRGBColor, ['#000000'])
  add(OPS.setLineWidth, [0.5 * scale])
  const count = mode === 'raster' ? 3 : 2
  for (let n = 0; n < count; n++) {
    const top = mode === 'raster' ? 40 + n * 120 : 40 + n * 180,
      bottom = top + (mode === 'raster' ? 64 : 80)
    if (mode === 'raster') {
      add(OPS.save, null)
      add(OPS.transform, [
        220 * scale,
        0,
        0,
        (bottom - top) * scale,
        60 * scale + dx,
        height - bottom * scale
      ])
      add(OPS.paintImageXObject, ['panel-' + n, 440, 128])
      graphicsBounds.push({
        operationIndex: operators.fnArray.length - 1,
        kind: 'image',
        normalizedRect: [
          rect([60, top, 280, bottom])[0] / width,
          (top * scale) / height,
          rect([60, top, 280, bottom])[2] / width,
          (bottom * scale) / height
        ]
      })
      add(OPS.restore, null)
    } else {
      add(OPS.paintFormXObjectBegin, [
        null,
        [60 * scale + dx, height - bottom * scale, 280 * scale + dx, height - top * scale]
      ])
      const a = point(65, bottom - 5),
        b = point(275, top + 5)
      add(OPS.constructPath, [
        OPS.stroke,
        [[0, a[0], a[1], 1, b[0], b[1]]],
        [a[0], a[1], b[0], b[1]]
      ])
      graphicsBounds.push({
        operationIndex: operators.fnArray.length - 1,
        kind: 'path',
        normalizedRect: [65 / 400, (top + 5) / 460, 275 / 400, (bottom - 5) / 460]
      })
      add(OPS.paintFormXObjectBegin, [
        null,
        [
          70 * scale + dx,
          height - (top + 35) * scale,
          110 * scale + dx,
          height - (top + 10) * scale
        ]
      ])
      text('N', 80, top + 25)
      add(OPS.paintFormXObjectEnd, [])
      add(OPS.paintFormXObjectEnd, [])
    }
    text(
      '(' + String.fromCharCode(97 + (duplicateMarker ? 0 : n)) + ') Complete panel statement',
      60,
      bottom + 12
    )
    if (mode !== 'raster')
      text(
        hyphenContinuation ? 'Continuation has a hyphen-' : 'Repeated data remain native',
        60,
        bottom + 24
      )
    text('Wrapped ending is preserved.', 60, bottom + (mode === 'raster' ? 24 : 36))
  }
  if (extraTailParagraph) text('Independent paragraph.', 60, mode === 'raster' ? 380 : 348)
  const title = 'Figure 1. Several panels.',
    captionBaseline = mode === 'raster' ? 406 : 374
  text(title, 50, captionBaseline)
  const caption = {
      page: 1,
      lines: [title],
      rect: rect([50, captionBaseline - 10, 340, captionBaseline + 4])
    },
    figure = { rect: rect(mode === 'raster' ? [60, 40, 280, 356] : [58, 38, 282, 324]), caption },
    page = { pageNumber: 1, width, height, invalidGraphicsBounds: 0, lines, graphicsBounds },
    context = {
      operators,
      viewport,
      content: { items, styles: { F: { ascent: 0.7, descent: -0.1, vertical: false } } },
      glyphBounds: [{ fontName: 'F', glyphs }],
      graphicsBounds
    }
  return {
    args: [page, [caption], [], [], [], tokens, context],
    figure,
    text,
    expectedBottom: (mode === 'raster' ? 371 : 339) * scale
  }
}
