/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { tableTextToken } from '../../resources/literature-pdf-orientation.mjs'
export function anonymousRasterSubcaptions(mode = 'normal') {
  const width = 400,
    height = 300,
    operators = { fnArray: [], argsArray: [] },
    items = [],
    tokens = [],
    glyphs = [],
    graphicsBounds = [],
    opaqueRasterImages = [],
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
    image = (name, x) => {
      add(OPS.save, null)
      add(OPS.transform, [120, 0, 0, 120, x, height - 170])
      add(OPS.paintImageXObject, [name, 500, 500])
      const operationIndex = operators.fnArray.length - 1
      graphicsBounds.push({
        operationIndex,
        kind: 'image',
        normalizedRect: [x / width, 50 / height, (x + 120) / width, 170 / height]
      })
      opaqueRasterImages.push({ operationIndex, imageId: name, width: 500, height: 500, kind: 2 })
      add(OPS.restore, null)
    }
  add(OPS.setFillRGBColor, ['#000000'])
  image('first', 40)
  text('(a)', 40, 185)
  text(mode === 'shared-glyph' ? 'AA' : mode.includes('underline') ? 'b' : 'One sample.', 60, 185)
  if (mode.includes('underline')) {
    add(OPS.setStrokeRGBColor, [mode === 'white-underline' ? '#ffffff' : '#000000'])
    add(OPS.setLineWidth, [0.4])
    const line = [0, 60, 114, 1, 65, 114],
      bounds = [60, 114, 65, 114]
    if (mode === 'shifted-underline-payload') {
      line[1] += 20
      line[4] += 20
    }
    if (mode === 'bad-underline-bound') bounds[2] += 20
    add(OPS.constructPath, [OPS.stroke, [line], bounds])
    graphicsBounds.push({
      operationIndex: operators.fnArray.length - 1,
      kind: 'path',
      normalizedRect: [0.15, 0.62, 0.1625, 0.62]
    })
  }
  image('second', 220)
  text('(b)', 220, 185)
  text('Two samples.', 240, 185)
  text('Figure 1. A pair.', 40, 235)
  if (mode === 'foreign') text('Other body text.', 70, 185)
  const caption = { page: 1, lines: ['Figure 1. A pair.'], rect: [40, 225, 150, 236] },
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
      graphicsBounds,
      opaqueRasterImages
    },
    f = {
      caption,
      rect: [40, 50, 340, 170],
      graphicsCount: 2,
      reason: 'native-raster-side-by-side'
    },
    captions = [caption],
    tables = []
  if (mode === 'duplicate-marker') {
    items[1].str = items[1].sourceItem.text = '(b)'
    operators.argsArray[
      operators.fnArray.indexOf(OPS.showText, operators.fnArray.indexOf(OPS.showText) + 1)
    ][0][0].unicode = '(b)'
  }
  if (mode === 'metrics') delete ctx.content.styles.F.ascent
  if (mode === 'literal-mismatch') items[1].sourceItem.text = 'Different'
  if (mode === 'opaque-binding') opaqueRasterImages[0].imageId = 'other'
  if (mode === 'table') tables.push([60, 180, 150, 190])
  if (mode === 'caption')
    captions.push({ page: 1, lines: ['Figure 2. Other.'], rect: [60, 180, 150, 190] })
  if (mode === 'alpha') {
    operators.fnArray.unshift(OPS.setGState)
    operators.argsArray.unshift([[['ca', 0.9]]])
  }
  if (mode === 'incomplete-caption') caption.lines[0] = 'Figure 1. A pair missing.'
  if (mode === 'painted-space') {
    operators.argsArray[operators.fnArray.indexOf(OPS.showText)][0].push({
      unicode: ' ',
      fontChar: 'Painted',
      width: 500,
      isInFont: true,
      isSpace: true
    })
    glyphs.push({ fontChar: 'Painted', bounds: [0, -0.1, 0.5, 0.7] })
  }
  if (mode === 'extra-image') image('third', 100)
  if (mode === 'shared-glyph') {
    const r = items[1]
    r.str = r.sourceItem.text = 'A'
    items.splice(2, 0, structuredClone(r))
  }
  if (mode === 'alpha') {
    for (const g of graphicsBounds) g.operationIndex++
    for (const im of opaqueRasterImages) im.operationIndex++
  }
  tokens.length = 0
  for (const [index, r] of items.entries()) {
    r.sourceItem.index = index
    tokens.push(tableTextToken(r, v, 0))
  }
  return { args: [page, f, captions, tables, tokens, ctx] }
}

// API snapshots stay separate from the caller so mutations cannot change both.
export function anonymousDualApiRaster(mode = 'normal') {
  const fixture = anonymousRasterSubcaptions(mode === 'split-pair-glyph' ? 'normal' : mode),
    [, , , , tokens, ctx] = fixture.args,
    o = ctx.operators,
    index = ctx.content.items.length,
    str = 'μ',
    fontChar = 'micro',
    width = mode === 'split-pair-glyph' ? 1178.2 : 589.1
  o.fnArray.push(OPS.beginText, OPS.setFont, OPS.setTextMatrix, OPS.showText, OPS.endText)
  o.argsArray.push(
    null,
    ['F', 10],
    [[1, 0, 0, 1, 360, 30]],
    [
      [
        {
          unicode: mode === 'split-pair-glyph' ? 'µµ' : 'µ',
          fontChar,
          width,
          isInFont: true,
          originalCharCode: 22
        }
      ]
    ],
    null
  )
  ctx.glyphBounds[0].glyphs.push({ fontChar, bounds: [0, -0.1, width / 1000, 0.7] })
  const r = {
    str,
    dir: 'ltr',
    width: width / 100,
    height: 10,
    transform: [10, 0, 0, 10, 360, 30],
    fontName: 'F',
    sourceItem: { pageNumber: 1, index, text: str }
  }
  ctx.content.items.push(r)
  tokens.push(tableTextToken(r, ctx.viewport, 0))
  if (mode === 'split-pair-glyph') {
    const other = structuredClone(r)
    other.sourceItem.index++
    ctx.content.items.push(other)
    tokens.push(tableTextToken(other, ctx.viewport, 0))
  }
  ctx.pageNumber = 1
  ctx.sourceSha256 = '1'.repeat(64)
  const viewport = { ...ctx.viewport }
  delete viewport.convertToViewportPoint
  const bareSnapshot = structuredClone({
      ...ctx,
      viewport,
      content: {
        items: ctx.content.items.map((item) => {
          const value = { ...item }
          delete value.sourceItem
          return value
        }),
        styles: ctx.content.styles
      }
    }),
    defaultContent = {
      items: structuredClone(bareSnapshot.content.items),
      styles: Object.assign(Object.create(null), structuredClone(ctx.content.styles)),
      lang: 'en'
    },
    rawContent = structuredClone(defaultContent)
  rawContent.styles = Object.assign(Object.create(null), rawContent.styles)
  for (let i = index; i < rawContent.items.length; i++) rawContent.items[i].str = 'µ'
  return { fixture, bareSnapshot, defaultContent, rawContent }
}
