/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { tableTextToken } from '../../resources/literature-pdf-orientation.mjs'
export function anonymousClosedSaveFigure(mode = 'normal') {
  const width = 400,
    height = 300,
    operators = { fnArray: [], argsArray: [] },
    items = [],
    tokens = [],
    glyphs = [],
    graphicsBounds = [],
    v = {
      width,
      height,
      scale: 1,
      rotation: 0,
      transform: [1, 0, 0, -1, 0, height],
      convertToViewportPoint: (x, y) => [x, height - y]
    },
    add = (o, a) => {
      operators.fnArray.push(o)
      operators.argsArray.push(a)
    },
    text = (str, x, baseline) => {
      add(OPS.beginText, null)
      add(OPS.setFont, ['F', 10])
      add(OPS.setTextMatrix, [[1, 0, 0, 1, x, height - baseline]])
      add(OPS.showText, [
        [{ unicode: str, fontChar: str, width: 500 * str.length, isInFont: true }]
      ])
      add(OPS.endText, null)
      const r = {
        str,
        dir: 'ltr',
        width: str.length * 5,
        height: 10,
        transform: [10, 0, 0, 10, x, height - baseline],
        fontName: 'F',
        sourceItem: { pageNumber: 1, index: items.length, text: str }
      }
      items.push(r)
      tokens.push(tableTextToken(r, v, 0))
      if (!glyphs.some((g) => g.fontChar === str))
        glyphs.push({ fontChar: str, bounds: [0, -0.1, 0.5 * str.length, 0.7] })
    },
    paint = (x, y, w, h) => {
      add(OPS.constructPath, [
        OPS.fill,
        [
          [
            0,
            x,
            height - y - h,
            1,
            x + w,
            height - y - h,
            1,
            x + w,
            height - y,
            1,
            x,
            height - y,
            4
          ]
        ],
        [x, height - y - h, x + w, height - y]
      ])
      graphicsBounds.push({
        operationIndex: operators.fnArray.length - 1,
        kind: 'path',
        normalizedRect: [x / width, y / height, (x + w) / width, (y + h) / height]
      })
    }
  add(OPS.setFillRGBColor, ['#000000'])
  if (mode === 'foreign-paint') paint(65, 170, 20, 20)
  if (mode === 'neutral-BM')
    add(OPS.setGState, [
      [
        ['BM', 'source-over'],
        ['ca', 1]
      ]
    ])
  if (mode === 'isolated-group')
    add(OPS.beginGroup, [
      { matrix: null, bbox: [0, 0, 400, 300], smask: null, isolated: true, knockout: false }
    ])
  add(OPS.save, null)
  if (mode === 'owned-alpha') add(OPS.setGState, [[['ca', 0.9]]])
  paint(50, 70, 100, 40)
  paint(170, 120, 110, 40)
  paint(150, 90, 20, 50)
  add(OPS.constructPath, [OPS.fillStroke, [null], null])
  if (mode === 'owned-alpha') add(OPS.setGState, [[['ca', 1]]])
  text('First block', 60, 90)
  text('Next block', 180, 140)
  text('Lower annotation', 60, 185)
  add(OPS.restore, null)
  if (mode === 'isolated-group')
    add(OPS.endGroup, [
      { matrix: null, bbox: [0, 0, 400, 300], smask: null, isolated: true, knockout: false }
    ])
  if (mode === 'foreign-text') text('Foreign sentence.', 60, 185)
  if (mode === 'micro-sign') {
    text('µ', 330, 270)
    const r = items.at(-1)
    r.str = r.sourceItem.text = 'μ'
    tokens[tokens.length - 1] = tableTextToken(r, v, 0)
  }
  text('Figure 1. Several blocks.', 40, 225)
  const caption = {
      page: 1,
      lines: [mode === 'narrative' ? 'Figure 1 tests the result.' : 'Figure 1. Several blocks.'],
      rect: [40, 210, 350, 235]
    },
    page = {
      pageNumber: 1,
      width,
      height,
      rotation: 0,
      invalidGraphicsBounds: 0,
      lines: [],
      graphicsBounds
    },
    ctx = {
      operators,
      viewport: v,
      content: { items, styles: { F: { ascent: 0.7, descent: -0.1, vertical: false } } },
      glyphBounds: [{ fontName: 'F', glyphs }],
      graphicsBounds
    },
    f = { rect: [50, 60, 280, 160], caption },
    captions = [caption],
    tables = []
  if (mode === 'metrics') delete ctx.content.styles.F.ascent
  if (mode === 'outlines') ctx.glyphBounds = []
  if (mode === 'duplicate-origin') tokens.push(structuredClone(tokens[0]))
  if (mode === 'literal-mismatch') items[0].str = 'Changed'
  if (mode === 'table') tables.push([60, 175, 140, 190])
  if (mode === 'caption')
    captions.push({ page: 1, lines: ['Figure 2. Other.'], rect: [60, 175, 140, 190] })
  if (mode === 'open-save')
    operators.fnArray[operators.fnArray.indexOf(OPS.restore)] = OPS.dependency
  return { args: [page, f, captions, tables, tokens, ctx] }
}

export function addAnonymousUnclaimedFigureGlyph(
  fixture,
  { text = ' ', x = 70, insideScope = false, emptyOutline = false, missingMetrics = false } = {}
) {
  const [page, , , , , ctx] = fixture.args,
    o = ctx.operators,
    fontName = 'Unclaimed',
    fontChar = 'unclaimed-glyph',
    operations = [
      [OPS.beginText, null],
      [OPS.setFont, [fontName, 10]],
      [OPS.setTextMatrix, [[1, 0, 0, 1, x, page.height - 180]]],
      [
        OPS.showText,
        [[{ unicode: text, fontChar, width: 500, isInFont: true, isSpace: true, accent: null }]]
      ],
      [OPS.endText, null]
    ],
    at = insideScope ? o.fnArray.indexOf(OPS.restore) : o.fnArray.length
  o.fnArray.splice(at, 0, ...operations.map(([op]) => op))
  o.argsArray.splice(at, 0, ...operations.map(([, args]) => args))
  ctx.content.styles[fontName] = missingMetrics
    ? {}
    : { ascent: 0.7, descent: -0.1, vertical: false }
  ctx.glyphBounds.push({
    fontName,
    glyphs: [{ fontChar, bounds: emptyOutline ? [0, 0, 0, 0] : [0, -0.1, 0.5, 0.7] }]
  })
  ctx.content.items.push({
    str: text,
    dir: 'ltr',
    width: 5,
    height: 10,
    transform: [10, 0, 0, 10, x, page.height - 180],
    fontName,
    sourceItem: { pageNumber: 1, index: ctx.content.items.length, text }
  })
  return fixture
}
