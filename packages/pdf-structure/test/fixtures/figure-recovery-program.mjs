import { anonymousOrderedRasterLabels } from './ordered-raster-labels.mjs'
import { nativeFigureLabelBounds } from '../../resources/literature-pdf-figure-crop-geometry.mjs'
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { anonymousIsolatedForm } from './isolated-form-figure.mjs'
import { tableTextToken } from '../../resources/literature-pdf-orientation.mjs'
export function anonymousNestedRecovery() {
  const f = anonymousIsolatedForm(),
    [page, , , , , c] = f.args
  c.pageNumber = page.pageNumber
  c.sourceSha256 = 'a'.repeat(64)
  const o = c.operators,
    begin = o.fnArray.indexOf(OPS.paintFormXObjectBegin) + 1,
    end = o.fnArray.indexOf(OPS.paintFormXObjectEnd),
    group = structuredClone(o.argsArray[o.fnArray.indexOf(OPS.beginGroup)][0])
  o.fnArray.splice(end, 0, OPS.endGroup)
  o.argsArray.splice(end, 0, [group])
  o.fnArray.splice(begin, 0, OPS.beginGroup)
  o.argsArray.splice(begin, 0, [group])
  for (const bound of c.graphicsBounds) if (bound.operationIndex >= begin) bound.operationIndex++
  return f
}
export function anonymousInertLeadingRecovery() {
  const f = anonymousIsolatedForm(),
    [page, , , , , c] = f.args
  c.pageNumber = page.pageNumber
  c.sourceSha256 = 'a'.repeat(64)
  const insert = (i, op, args) => {
    c.operators.fnArray.splice(i, 0, op)
    c.operators.argsArray.splice(i, 0, args)
    for (const bound of c.graphicsBounds) if (bound.operationIndex >= i) bound.operationIndex++
  }
  for (let i = c.operators.fnArray.length - 1; i >= 0; i--) {
    if (c.operators.fnArray[i] === OPS.endText) insert(i, OPS.nextLine, null)
    if (c.operators.fnArray[i] === OPS.showText) insert(i, OPS.setLeading, [12])
  }
  return f
}
export function anonymousForeignAccentRecovery() {
  const f = anonymousIsolatedForm(),
    [page, , , , tokens, c] = f.args
  c.pageNumber = page.pageNumber
  c.sourceSha256 = 'a'.repeat(64)
  const firstShow = c.operators.fnArray.indexOf(OPS.showText),
    glyph = c.operators.argsArray[firstShow][0][0],
    item = c.content.items[0]
  Object.assign(glyph, {
    unicode: 'ä',
    fontChar: 'a',
    width: 500,
    accent: { fontChar: 'accent', offset: { x: 0.1, y: 0.1 } }
  })
  Object.assign(item, { str: 'ä', width: 5, sourceItem: { pageNumber: 1, index: 0, text: 'ä' } })
  tokens[0] = tableTextToken(item, c.viewport, 0)
  c.glyphBounds[0].glyphs.push({ fontChar: 'a', bounds: [0, -0.1, 0.5, 0.7] })
  c.foreignCompoundGlyphs = [
    {
      fontName: 'F',
      missingFile: false,
      disableFontFace: true,
      remeasure: false,
      isType3Font: false,
      fontMatrix: [0.001, 0, 0, 0.001, 0, 0],
      glyphs: [{ fontChar: 'accent', bounds: [0, 0.6, 0.4, 0.8] }]
    }
  ]
  return f
}
export function anonymousSubscriptRecovery() {
  const f = anonymousIsolatedForm(),
    [page, , , , tokens, c] = f.args
  c.pageNumber = page.pageNumber
  c.sourceSha256 = 'a'.repeat(64)
  const at = c.operators.fnArray.findIndex(
    (op, i) => op === OPS.showText && c.operators.argsArray[i][0][0].unicode === 'Axis'
  )
  c.operators.argsArray[at][0] = [{ unicode: 'n', fontChar: 'n', width: 500, isInFont: true }]
  c.operators.fnArray.splice(at + 1, 0, OPS.setFont, OPS.setTextMatrix, OPS.showText, OPS.setFont)
  c.operators.argsArray.splice(
    at + 1,
    0,
    ['F', 6],
    [[1, 0, 0, 1, 85, 308]],
    [[{ unicode: 'q', fontChar: 'q', width: 500, isInFont: true }]],
    ['F', 10]
  )
  for (const bound of c.graphicsBounds) if (bound.operationIndex > at) bound.operationIndex += 4
  const item = c.content.items[1]
  Object.assign(item, { str: 'nq', width: 8, sourceItem: { pageNumber: 1, index: 1, text: 'nq' } })
  tokens[1] = tableTextToken(item, c.viewport, 0)
  c.glyphBounds[0].glyphs.push(
    { fontChar: 'n', bounds: [0, -0.1, 0.5, 0.7] },
    { fontChar: 'q', bounds: [0, -0.1, 0.5, 0.7] }
  )
  return f
}

export function anonymousCertifiedPicture(
  panelLabels = [],
  background,
  strokeFirst = false,
  foreignPanel = false,
  headerParts = ['Running header']
) {
  const page = {
      pageNumber: 1,
      width: 400,
      height: 400,
      rotation: 0,
      renderRotation: 0,
      invalidGraphicsBounds: 0,
      lines: [],
      graphicsBounds: []
    },
    style = { ascent: 0.7, descent: -0.1, vertical: false },
    viewport = {
      width: 400,
      height: 400,
      scale: 1,
      rotation: 0,
      transform: [1, 0, 0, -1, 0, 400],
      convertToViewportPoint: (x, y) => [x, 400 - y]
    },
    context = {
      pageNumber: 1,
      sourceSha256: 'a'.repeat(64),
      viewport,
      operators: { fnArray: [], argsArray: [] },
      content: { items: [], styles: { F: style } },
      glyphBounds: [{ fontName: 'F', glyphs: [] }],
      graphicsBounds: page.graphicsBounds
    },
    tokens = [],
    add = (op, args) => {
      context.operators.fnArray.push(op)
      context.operators.argsArray.push(args)
    },
    text = (str, x, y, zero = false) => {
      add(OPS.beginText, null)
      add(OPS.setFont, ['F', 10])
      add(OPS.setTextMatrix, [[1, 0, 0, 1, x, 400 - y]])
      add(OPS.showText, [
        [{ unicode: str, fontChar: str, width: zero ? 0 : 500 * str.length, isInFont: true }]
      ])
      add(OPS.endText, null)
      const raw = {
        str,
        dir: 'ltr',
        width: zero ? 0 : 5 * str.length,
        height: 10,
        transform: [10, 0, 0, 10, x, 400 - y],
        fontName: 'F',
        hasEOL: true,
        sourceItem: { pageNumber: 1, index: context.content.items.length, text: str }
      }
      context.content.items.push(raw)
      tokens.push({
        ...tableTextToken(raw, viewport, 0),
        fontAscent: style.ascent,
        fontDescent: style.descent,
        nativeLabelRect: nativeFigureLabelBounds(raw, style, viewport)
      })
      context.glyphBounds[0].glyphs.push({
        fontChar: str,
        bounds: [0, -0.1, zero ? 0.4 : 0.5 * str.length, 0.7]
      })
    },
    shape = (x, y, w, h, paint = OPS.fill) => {
      const b = 400 - y - h,
        i = context.operators.fnArray.length
      add(OPS.constructPath, [
        paint,
        [[0, x, b, 1, x + w, b, 1, x + w, b + h, 1, x, b + h, 4]],
        [x, b, x + w, b + h]
      ])
      page.graphicsBounds.push({
        kind: 'path',
        operationIndex: i,
        normalizedRect: [x / 400, y / 400, (x + w) / 400, (y + h) / 400]
      })
    }
  add(OPS.setFillRGBColor, ['#000000'])
  for (const [index, part] of headerParts.entries()) text(part, 40 + index * 70, 30)
  if (foreignPanel) shape(45, 90, 10, 10)
  add(OPS.paintFormXObjectBegin, [null, [40, 120, 350, 340]])
  if (background) {
    add(OPS.setFillRGBColor, [background])
    shape(50, 65, 290, 210)
    add(OPS.setFillRGBColor, ['#000000'])
  }
  if (strokeFirst) {
    add(OPS.setStrokeRGBColor, ['#000000'])
    add(OPS.setLineWidth, [2])
  }
  shape(70, 80, 20, 10, strokeFirst ? OPS.stroke : OPS.fill)
  shape(100, 140, 40, 10)
  shape(140, 220, 50, 10)
  text('Axis', 80, 110)
  text('Value', 100, 250)
  for (const [i, label] of panelLabels.entries()) text(label, 55 + i * 155, 270)
  add(OPS.paintFormXObjectEnd, null)
  const captionText = panelLabels.length ? 'Figure 1. (a) and (b).' : 'Figure 1. Drawing.'
  text(captionText, 60, 310)
  const caption = { page: 1, rect: [60, 300, 250, 312], lines: [captionText] },
    figure = { caption, rect: [80, 140, 220, 240] },
    captions = [caption],
    tables = [],
    peers = [figure],
    crop = [38, 58, 352, 282]
  return { page, figure, captions, tables, tokens, context, peers, crop, add, text, shape, OPS }
}

export function anonymousContinuedRaster() {
  const first = anonymousOrderedRasterLabels(),
    second = anonymousOrderedRasterLabels()
  for (const [f, page] of [
    [first, 1],
    [second, 2]
  ]) {
    const [p, , , , , tokens, c] = f.args
    p.rotation = p.renderRotation = 0
    p.pageNumber = page
    c.pageNumber = page
    c.sourceSha256 = 'a'.repeat(64)
    f.figure.caption.page = page
    p.graphicsBounds.forEach((g, i) => (g.imageHash = String(i + 1).repeat(64)))
    for (let i = c.operators.fnArray.length - 1; i >= 0; i--) {
      if (
        c.operators.fnArray[i] === OPS.showText &&
        ['Near', 'Far', 'View'].includes(c.operators.argsArray[i][0][0].unicode)
      ) {
        c.operators.fnArray.splice(i - 3, 5)
        c.operators.argsArray.splice(i - 3, 5)
      }
    }
    c.content.items = c.content.items.filter((r) => !['Near', 'Far', 'View'].includes(r.str))
    c.glyphBounds[0].glyphs = c.glyphBounds[0].glyphs.filter(
      (g) => !['Near', 'Far', 'View'].includes(g.fontChar)
    )
    const replacements =
      page === 1
        ? {
            '(a)': '(a)Panel',
            '(b)': '(b)Panel',
            'Figure 1.': 'Figure continued on the following page.',
            'Two views.': ' '
          }
        : { '(a)': '(c)Panel', '(b)': '(d)Panel', 'Two views.': 'Paired views (a,b) (c,d).' }
    for (const r of c.content.items) {
      const before = r.str,
        s = replacements[before] ?? before
      if (s !== before) {
        const i = c.operators.argsArray.findIndex(
            (a, i) => c.operators.fnArray[i] === OPS.showText && a[0][0].unicode === before
          ),
          g = c.operators.argsArray[i][0][0]
        g.unicode = g.fontChar = s
        g.width = 500 * s.length
        const metric = c.glyphBounds[0].glyphs.find((g) => g.fontChar === before)
        metric.fontChar = s
        metric.bounds = [0, -0.1, 0.5 * s.length, 0.7]
        r.str = s
        r.width = 4 * s.length
      }
      r.sourceItem = { pageNumber: page, index: c.content.items.indexOf(r), text: s }
    }
    if (page === 1) {
      c.content.items.pop()
      c.operators.fnArray.splice(-5)
      c.operators.argsArray.splice(-5)
      c.glyphBounds[0].glyphs = c.glyphBounds[0].glyphs.filter((g) => g.fontChar !== ' ')
    }
    const imageOps = c.operators.fnArray.flatMap((op, i) =>
      op === OPS.paintImageXObject ? [i] : []
    )
    p.graphicsBounds.forEach((g, i) => (g.operationIndex = imageOps[i]))
    tokens.splice(
      0,
      tokens.length,
      ...c.content.items.map((r) => ({
        ...tableTextToken(r, c.viewport, 0),
        nativeLabelRect: nativeFigureLabelBounds(r, c.content.styles.F, c.viewport)
      }))
    )
    if (page === 2) f.figure.caption.lines = ['Figure 1.', 'Paired views (a,b) (c,d).']
  }
  const [page, , , , , tokens, context] = first.args,
    [nextPage, , , , , nextTokens, nextContext] = second.args,
    nextCaption = second.figure.caption
  return {
    page,
    tokens,
    context,
    nextPage,
    nextTokens,
    nextContext,
    nextCaption,
    captions: [nextCaption],
    tables: []
  }
}

// A tiny original PDF with a clipped Type3 program and a genuine zero advance.
export function anonymousClippedType3Pdf(zeroMode = 'inside') {
  const zeroBody = zeroMode === 'outside' ? '' : ' /Zero 10 Tf 1 0 0 1 180 180 Tm (0) Tj ',
    zeroOutside = zeroMode === 'outside' ? 'BT /Zero 10 Tf 1 0 0 1 90 380 Tm (0) Tj ET ' : ''
  const objects = [],
    add = (s) => objects.push(s),
    stream = (s, d = '') =>
      add(`<< ${d} /Length ${Buffer.byteLength(s)} >>\nstream\n${s}\nendstream`),
    catalog = add(''),
    pages = add(''),
    face = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
    zero = add(
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /FirstChar 48 /LastChar 48 /Widths [0] >>'
    ),
    gs = add('<< /FL 1 /LC 0 /LJ 0 /LW 0 /ML 10 >>'),
    char = stream(
      '1155 0 -1164 -628 4190 2129 d1 /Stroke gs 37 640 m 1115 640 l 1115 722 l 37 722 l 37 640 l f'
    ),
    unicode = stream(
      '/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Anonymous) /Ordering (Test) /Supplement 0 >> def /CMapName /Test def /CMapType 2 def 1 begincodespacerange <00> <FF> endcodespacerange 1 beginbfchar <01> <0003> endbfchar endcmap CMapName currentdict /CMap defineresource pop end end'
    ),
    type3 = add(
      `<< /Type /Font /Subtype /Type3 /FontBBox [-1164 -628 4190 2129] /FontMatrix [.000488 0 0 .000488 0 0] /FirstChar 1 /LastChar 1 /Widths [563] /Encoding << /Type /Encoding /Differences [1 /control] >> /ToUnicode ${unicode} 0 R /CharProcs << /control ${char} 0 R >> /Resources << /ExtGState << /Stroke ${gs} 0 R >> >> >>`
    ),
    form = stream(
      '0 0 0 rg 0 0 0 RG 100 100 200 180 re f BT /Text 10 Tf 1 0 0 1 105 260 Tm (Left label) Tj 1 0 0 1 200 200 Tm (Middle label) Tj 1 0 0 1 230 130 Tm (Right label) Tj' +
        zeroBody +
        ' /Type3 10 Tf 1 0 0 1 150 150 Tm <01> Tj ET',
      `/Type /XObject /Subtype /Form /BBox [100 100 300 280] /Group << /S /Transparency /I false /K false >> /Resources << /Font << /Text ${face} 0 R /Zero ${zero} 0 R /Type3 ${type3} 0 R >> >>`
    ),
    content = stream(
      zeroOutside +
        'BT /Text 10 Tf 1 0 0 1 90 350 Tm (Running header.) Tj ET q /Picture Do Q BT /Text 10 Tf 1 0 0 1 90 80 Tm (Figure 1: Three complete measured sample panels.) Tj ET'
    ),
    pageID = add(
      `<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 400 400] /Resources << /Font << /Text ${face} 0 R /Zero ${zero} 0 R >> /XObject << /Picture ${form} 0 R >> >> /Contents ${content} 0 R >>`
    )
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pages} 0 R >>`
  objects[pages - 1] = `<< /Type /Pages /Kids [${pageID} 0 R] /Count 1 >>`
  let pdf = '%PDF-1.7\n'
  const offsets = [0]
  for (const [i, s] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${i + 1} 0 obj\n${s}\nendobj\n`
  }
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => `${String(n).padStart(10, '0')} 00000 n \n`)
    .join(
      ''
    )}trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`

  return new Uint8Array(Buffer.from(pdf))
}
