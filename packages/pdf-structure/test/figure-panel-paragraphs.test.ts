import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'

const { completeNativePanelParagraphs, completeNativePairedPanelTails } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-panel-paragraphs.mjs')).href
)

const pairedTails = (fault = ''): ReturnType<typeof JSON.parse> => {
  const fnArray: number[] = [],
    argsArray: unknown[] = [],
    items: ReturnType<typeof JSON.parse>[] = []
  const lines: ReturnType<typeof JSON.parse>[] = [],
    tokens: ReturnType<typeof JSON.parse>[] = []
  const graphicsBounds: ReturnType<typeof JSON.parse>[] = []
  const emit = (op: number, args: unknown = null): number => {
    fnArray.push(op)
    argsArray.push(args)
    return fnArray.length - 1
  }
  const text = (str: string, x: number, y: number): void => {
    const width = str.length * 4,
      sourceItem = { pageNumber: 1, index: items.length, text: str }
    items.push({
      str,
      width,
      height: 10,
      fontName: 'Body',
      dir: 'ltr',
      hasEOL: true,
      transform: [10, 0, 0, 10, x, 800 - y - 10],
      sourceItem
    })
    lines.push({ text: str, x, y, width, height: 10, fontSize: 10 })
    tokens.push({
      text: str,
      rect: [x, y, x + width, y + 10],
      nativeLabelRect: [x, y + 2, x + width, y + 12],
      sourceItem,
      height: 10,
      horizontal: true,
      baseline: y + 10
    })
    emit(OPS.beginText)
    emit(OPS.setFont, ['Body', 10])
    emit(OPS.setTextMatrix, [[1, 0, 0, 1, x, 800 - y - 10]])
    emit(OPS.showText, [
      Array.from(str, (unicode) => ({
        unicode,
        fontChar: unicode,
        width: 400,
        isSpace: unicode === ' ',
        isInFont: true
      }))
    ])
    emit(OPS.endText)
  }
  for (const x of [90, 330]) {
    emit(OPS.save)
    emit(OPS.transform, [140, 0, 0, 100, x, 620])
    const operationIndex = emit(OPS.paintImageXObject, ['sample', 140, 100])
    emit(OPS.restore)
    graphicsBounds.push({
      kind: 'image',
      operationIndex,
      normalizedRect: [x / 600, 80 / 800, (x + 140) / 600, 180 / 800],
      paintedNormalizedRect: [x / 600, 80 / 800, (x + 140) / 600, 180 / 800]
    })
  }
  text(
    fault === 'terminal parent'
      ? '(a) First measurement is complete.'
      : '(a) First measurement across simu-',
    90,
    184
  )
  text('lations.', 90, 196)
  if (fault === 'third line') text('another continuation', 90, 208)
  text('(b) Second measurement across simu-', 330, 184)
  text('lations.', 330, 196)
  if (fault === 'foreign ink') text('Note', 270, 196)
  const caption = { page: 1, lines: ['Figure 1. Two measurements.'], rect: [90, 230, 510, 242] }
  const glyphs = [...new Set(items.flatMap((i) => [...i.str]))].map((fontChar) => ({
    fontChar,
    bounds: fontChar === ' ' ? [0, 0, 0, 0] : [0, -0.2, 0.35, 0.7]
  }))
  if (fault === 'missing glyph') glyphs.pop()
  if (fault === 'unknown effect') emit(OPS.shadingFill, ['unsupported'])
  return {
    page: {
      pageNumber: 1,
      width: 600,
      height: 800,
      lines,
      graphicsBounds,
      invalidGraphicsBounds: 0
    },
    figure: {
      caption,
      rect: [90, 80, 510, fault === 'already complete' ? 210 : 194],
      issue: 'native-raster-side-by-side'
    },
    captions: [caption],
    tables: fault === 'table' ? [[90, 196, 150, 207]] : [],
    tokens,
    context: {
      pageNumber: 1,
      graphicsBounds,
      content: { items, styles: { Body: { ascent: 0.7, descent: -0.2, vertical: false } } },
      operators: { fnArray, argsArray },
      glyphBounds: [{ fontName: 'Body', glyphs }],
      viewport: {
        width: 600,
        height: 800,
        scale: 1,
        rotation: 0,
        transform: [1, 0, 0, -1, 0, 800],
        convertToViewportPoint: (x: number, y: number): number[] => [x, 800 - y]
      }
    }
  }
}

it('completes two source-closed wrapped raster labels without changing their ownership', () => {
  const f = pairedTails(),
    before = structuredClone(f.figure)
  expect(
    completeNativePairedPanelTails(f.page, f.figure, f.captions, f.tables, f.tokens, f.context)
  ).toEqual([90, 80, 510, 208])
  expect(f.figure).toEqual(before)
})

it.each([
  'terminal parent',
  'third line',
  'foreign ink',
  'missing glyph',
  'unknown effect',
  'table',
  'already complete'
])('rejects an incomplete paired-label proof: %s', (fault) => {
  const f = pairedTails(fault)
  expect(
    completeNativePairedPanelTails(f.page, f.figure, f.captions, f.tables, f.tokens, f.context)
  ).toBeUndefined()
})

type Line = { text: string; x: number; y: number; width: number; height: number; fontSize: number }
type Caption = { page: number; rect: number[]; lines: string[] }
type Fixture = {
  page: {
    pageNumber: number
    width: number
    height: number
    lines: Line[]
    graphicsBounds: { kind: string; normalizedRect: number[] }[]
    invalidGraphicsBounds: number
  }
  figure: { caption: Caption; rect: number[] }
  captions: Caption[]
  tables: number[][]
  tokens: {
    text: string
    rect: number[]
    baseline: number
    height: number
    horizontal: boolean
    fontDescent: number
  }[]
}

const fixture = (): Fixture => {
  const line = (text: string, y: number, width = 420, fontSize = 10): Line => ({
    text,
    x: 90,
    y,
    width,
    height: fontSize,
    fontSize
  })
  const lines = [
    line('(a) First regime. Measurements are shown over the complete interval', 208),
    line('with independent repetitions and reported confidence bounds.', 220),
    line('The first regime ends here.', 232, 190),
    line('(b) Second regime. Measurements continue over the full interval', 370),
    line('with the same procedure and independent source observations.', 382),
    line('The second regime ends here.', 394, 200),
    line('Figure 1: Two experimental regimes.', 418, 420, 11),
    line('The following body paragraph must stay outside the figure.', 448)
  ]
  const caption = { page: 1, rect: [90, 418, 510, 429], lines: [lines[6].text] }
  const graphicsBounds = [90, 264].flatMap((y) => [
    { kind: 'path', normalizedRect: [86 / 600, y / 800, 516 / 600, (y + 104) / 800] },
    ...[112, 250, 388].map((x) => ({
      kind: 'path',
      normalizedRect: [x / 600, (y + 10) / 800, (x + 120) / 600, (y + 84) / 800]
    }))
  ])
  const tokens = lines.map((l) => ({
    text: l.text,
    rect: [l.x, l.y, l.x + l.width, l.y + l.height],
    baseline: l.y + l.height,
    height: l.height,
    horizontal: true,
    fontDescent: -0.2
  }))
  return {
    page: {
      pageNumber: 1,
      width: 600,
      height: 800,
      lines,
      graphicsBounds,
      invalidGraphicsBounds: 0
    },
    figure: { caption, rect: [84, 86, 520, 374] },
    captions: [caption],
    tables: [] as number[][],
    tokens
  }
}

const complete = (f: Fixture): number[] | undefined =>
  completeNativePanelParagraphs(f.page, f.figure, f.captions, f.tables, f.tokens)

it('completes the source-owned final panel paragraph without absorbing its main caption', () => {
  expect(complete(fixture())).toEqual([84, 86, 520, 406])
})

it('uses matching plot columns without requiring a fixed panel count', () => {
  const f = fixture()
  f.page.graphicsBounds = f.page.graphicsBounds.filter((g) => g.normalizedRect[0] !== 250 / 600)
  expect(complete(f)).toEqual([84, 86, 520, 406])
})

it('includes the full descent of a separately owned inline subscript', () => {
  const f = fixture()
  f.page.lines[5].text = 'The second regime ends with R2.'
  f.page.lines[5].height = 12
  f.tokens[5].text = 'The second regime ends with R'
  f.tokens[5].rect[2] = 280
  f.tokens.push({
    text: '2.',
    rect: [280, 400, 290, 406],
    baseline: 406,
    height: 6,
    horizontal: true,
    fontDescent: -0.2
  })
  expect(complete(f)?.[3]).toBeCloseTo(407.2)
})

it('rejects an extra source item omitted from the grouped paragraph', () => {
  const f = fixture()
  f.tokens.push({ ...f.tokens[5], text: 'Foreign note', rect: [300, 402, 350, 412] })
  expect(complete(f)).toBeUndefined()
})

it.each(['source', 'panel', 'body', 'caption', 'table', 'line-gap', 'font'])(
  'retains the crop when %s evidence conflicts',
  (kind) => {
    const f = fixture()
    if (kind === 'source') f.tokens.splice(4, 1)
    if (kind === 'panel')
      f.page.lines[0].text = f.tokens[0].text = 'Ordinary paragraph before the second plot.'
    if (kind === 'body') {
      f.page.lines[4].width = 180
      f.tokens[4].rect[2] = 270
    }
    if (kind === 'caption') {
      f.page.lines[4].text = f.tokens[4].text = 'Figure 2: A separate caption.'
    }
    if (kind === 'table') f.tables.push([90, 382, 510, 404])
    if (kind === 'line-gap') {
      f.page.lines[4].y += 4
      f.tokens[4].rect[1] += 4
      f.tokens[4].rect[3] += 4
      f.tokens[4].baseline += 4
    }
    if (kind === 'font') f.tokens[4].fontDescent = NaN
    expect(complete(f)).toBeUndefined()
  }
)

const { nativeCaptionedSideKeyRasterPair } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-panel-labels.mjs')).href
)

const leftKeyPair = (fault = ''): ReturnType<typeof JSON.parse> => {
  const f = pairedTails(),
    o = f.context.operators
  o.fnArray = []
  o.argsArray = []
  f.context.content.items = []
  f.tokens = []
  f.page.lines = []
  f.page.graphicsBounds.length = 0
  const emit = (op: number, args: unknown = null): number => {
    o.fnArray.push(op)
    o.argsArray.push(args)
    return o.fnArray.length - 1
  }
  for (const [x, y, width] of [
    [150, 80, 200],
    [180, 210, 140]
  ]) {
    emit(OPS.save)
    emit(OPS.transform, [width, 0, 0, 100, x, 800 - y - 100])
    const operationIndex = emit(OPS.paintImageXObject, ['sample', width, 100])
    emit(OPS.restore)
    f.page.graphicsBounds.push({
      kind: 'image',
      operationIndex,
      normalizedRect: [x / 600, y / 800, (x + width) / 600, (y + 100) / 800]
    })
  }
  const text = (str: string, x: number, y: number): void => {
    const index = f.context.content.items.length,
      width = str.length * 4
    const sourceItem = { pageNumber: 1, index, text: str }
    f.context.content.items.push({
      str,
      width,
      height: 10,
      fontName: 'Body',
      dir: 'ltr',
      transform: [10, 0, 0, 10, x, 800 - y - 10],
      sourceItem
    })
    f.tokens.push({
      text: str,
      rect: [x, y, x + width, y + 10],
      horizontal: true,
      height: 10,
      baseline: y + 10,
      sourceItem
    })
    f.page.lines.push({ text: str, x, y, width, height: 10, fontSize: 10 })
    emit(OPS.beginText)
    emit(OPS.setFont, ['Body', 10])
    emit(OPS.setTextMatrix, [[1, 0, 0, 1, x, 800 - y - 10]])
    emit(OPS.showText, [
      Array.from(str, (unicode) => ({
        unicode,
        fontChar: unicode,
        width: 400,
        isSpace: unicode === ' ',
        isInFont: true
      }))
    ])
    emit(OPS.endText)
  }
  text('(a)', 90, 125)
  text(fault === 'repeated key' ? '(a)' : '(b)', 90.2, 250)
  if (fault === 'foreign native text') text('Note', 250, 185)
  text('Figure 1: (a) First; (b) Second.', 150, 330)
  f.context.glyphBounds[0].glyphs = [
    ...new Set<string>(f.context.content.items.flatMap((i: { str: string }) => [...i.str]))
  ].map((fontChar) => ({
    fontChar,
    bounds: fontChar === ' ' ? [0, 0, 0, 0] : [0, -0.2, 0.35, 0.7]
  }))
  const caption = {
    page: 1,
    rect: [150, 330, 400, 342],
    lines: ['Figure 1: (a) First; (b) Second.']
  }
  f.figure = { caption, rect: [180, 210, 320, 310], graphicsCount: 1 }
  f.captions = [caption]
  if (fault === 'table in envelope') f.tables.push([200, 185, 250, 195])
  if (fault === 'unsupported paint') emit(OPS.shadingFill, ['unknown'])
  return f
}

it('recovers two unequal complete raster panels through their native left keys', () => {
  const f = leftKeyPair(),
    before = structuredClone(f.figure)
  const result = nativeCaptionedSideKeyRasterPair(
    f.page,
    f.figure,
    f.captions,
    f.tables,
    f.tokens,
    f.context
  )
  expect(result.rect).toEqual([90, 80, 350, 310])
  expect(result.graphicsCount).toBe(2)
  expect(result.sourceItems).toBeUndefined()
  expect(f.figure).toEqual(before)
})

it.each(['repeated key', 'foreign native text', 'table in envelope', 'unsupported paint'])(
  'retains the existing crop without complete left-key ownership: %s',
  (fault) => {
    const f = leftKeyPair(fault)
    expect(
      nativeCaptionedSideKeyRasterPair(f.page, f.figure, f.captions, f.tables, f.tokens, f.context)
    ).toBeUndefined()
  }
)
