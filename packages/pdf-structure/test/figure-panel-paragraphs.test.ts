import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { completeNativePanelParagraphs } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-panel-paragraphs.mjs')).href
)

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
