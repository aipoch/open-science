/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { tableTextToken } from '../../resources/literature-pdf-orientation.mjs'

export function smallCapsTableCaption(options = {}) {
  const width = 240,
    height = 220,
    items = [],
    glyphs = new Map(),
    graphicsBounds = [],
    operators = { fnArray: [], argsArray: [] },
    viewport = {
      width,
      height,
      scale: 1,
      rotation: 0,
      transform: [1, 0, 0, -1, 0, height],
      convertToViewportPoint: (x, y) => [x, height - y]
    }
  const add = (op, args) => {
    operators.fnArray.push(op)
    operators.argsArray.push(args)
  }
  const text = (str, x, y, size = 8, font = 'F') => {
    add(OPS.beginText, null)
    add(OPS.setFont, [font, size])
    add(OPS.setTextMatrix, [[1, 0, 0, 1, x, height - y]])
    add(OPS.showText, [
      [{ unicode: str, fontChar: str, width: str.length * 500, isInFont: true, isSpace: false }]
    ])
    add(OPS.endText, null)
    items.push({
      str,
      dir: 'ltr',
      width: (str.length * size) / 2,
      height: size,
      transform: [size, 0, 0, size, x, height - y],
      fontName: font,
      sourceItem: { pageNumber: 1, index: items.length, text: str }
    })
    glyphs.set(font + ':' + str, {
      fontName: font,
      fontChar: str,
      bounds: [0, -0.1, str.length / 2, 0.7]
    })
    return items.at(-1)
  }
  const fill = (rect) => {
    const r = [rect[0], height - rect[3], rect[2], height - rect[1]]
    add(OPS.constructPath, [
      OPS.fill,
      [[0, r[0], r[1], 1, r[2], r[1], 1, r[2], r[3], 1, r[0], r[3], 4]],
      r
    ])
    graphicsBounds.push({
      kind: 'path',
      operationIndex: operators.fnArray.length - 1,
      normalizedRect: rect.map((v, n) => v / (n % 2 ? height : width))
    })
  }
  add(OPS.setFillRGBColor, ['#000000'])
  text('TABLE IV.', 30, 90)
  const capital = text('C', 85, 90),
    body = text('OMPARISON OF REGIONAL ', 85 + capital.width, 90, 6.4),
    next = text('S', body.transform[4] + body.width, 90),
    terminal = text('IGNALS', next.transform[4] + next.width, 90, 6.4),
    right = terminal.transform[4] + terminal.width,
    tailText = options.prose ? 'Reference groups' : 'REFERENCE GROUPS',
    tailSize = options.tailSize ?? 6.4,
    tail = text(
      tailText,
      (30 + right - (tailText.length * tailSize) / 2) / 2 + (options.offset ?? 0),
      options.tailBaseline ?? 98.2,
      tailSize,
      options.tailFont ?? 'F'
    ),
    ranges = [
      [20, 60],
      [60.5, 105],
      [105.5, 150],
      [150.5, 194]
    ]
  for (const y of [104, 118, 175]) {
    if ((options.missingOpening && y === 104) || (options.missingClosing && y === 175)) continue
    for (const [n, r] of ranges.entries())
      fill([y === 175 && n ? r[0] - 0.5 : r[0], y - 0.2, r[1], y + 0.2])
  }
  for (let c = 0; c < 4; c++) text(String.fromCharCode(65 + c), 25 + c * 47, 115)
  for (let row = 0; row < 3; row++)
    for (let c = 0; c < 4; c++) text(String(row * 4 + c + 1), 25 + c * 47, 135 + row * 15)
  const caption = {
      page: 1,
      lines: ['TABLE IV. COMPARISON OF REGIONAL SIGNALS'],
      rect: [30, 82, right, 90]
    },
    page = {
      pageNumber: 1,
      width,
      height,
      rotation: 0,
      invalidGraphicsBounds: 0,
      graphicsBounds,
      lines: [
        { text: caption.lines[0], x: 30, y: 82, width: right - 30, height: 8, fontSize: 8 },
        {
          text: tailText,
          x: tail.transform[4],
          y: height - tail.transform[5] - tailSize,
          width: tail.width,
          height: tailSize,
          fontSize: tailSize
        },
        ...items.slice(6).map((i) => ({
          text: i.str,
          x: i.transform[4],
          y: height - i.transform[5] - i.height,
          width: i.width,
          height: i.height,
          fontSize: i.height
        }))
      ]
    },
    context = {
      pageNumber: 1,
      sourceSha256: 'a'.repeat(64),
      operators,
      viewport,
      content: {
        items,
        styles: {
          F: { ascent: 0.7, descent: -0.1, vertical: false },
          G: { ascent: 0.7, descent: -0.1, vertical: false }
        }
      },
      graphicsBounds
    }
  const refresh = () => {
    context.glyphBounds = ['F', 'G'].map((fontName) => ({
      fontName,
      glyphs: [...glyphs.values()].filter((g) => g.fontName === fontName)
    }))
    return items.map((i) => tableTextToken(i, viewport, 0))
  }
  return { page, caption, context, tokens: refresh(), fill, text, refresh }
}
