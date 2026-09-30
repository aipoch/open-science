import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { readPdfFixture } from './read-fixture'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { associateFigures } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-association.mjs')).href
)
const { repairPdfSymbolText } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-symbol-text.mjs')).href
)
const fixture = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(resolve(`src/main/literature/pdf-structure/fixtures/source-grids/${name}.jsonl`))
const parse = (x: ReturnType<typeof JSON.parse>): ReturnType<typeof JSON.parse> =>
  refineTable(x.table, x.tokens, x.captions, x.notes, x.rules)

it.each([
  ['enclosed-opening-title-above-leaf-columns', 'Change between baseline and midterm (M-B)', 6],
  ['enclosed-section-with-short-model-span', 'Prior therapy', 5],
  ['outdented-sections-with-partial-peer-spans', 'Cancer risks', 5],
  ['outdented-sections-with-partial-peer-spans', 'Screening implications', 5]
])('completes native section ownership: %s / %s', (name, label, width) => {
  const t = parse(fixture(String(name)))
  expect(t.cells.find((c: { text: string }) => c.text === label)?.colSpan).toBe(width)
})

it.each(['no-frame', 'divider', 'another-value'])(
  'does not turn an uncertain opening row into a full-width title: %s',
  (mode) => {
    const x = fixture('enclosed-opening-title-above-leaf-columns')
    const title = x.tokens.find((i: { text: string }) => i.text.startsWith('Change between'))
    if (mode === 'no-frame') x.rules = []
    if (mode === 'divider') x.rules.push([500, 727, 500, 752])
    if (mode === 'another-value')
      x.tokens.push({ ...title, text: '12', rect: [700, title.rect[1], 720, title.rect[3]] })
    expect(parse(x).cells.find((c: { text: string }) => c.text === title.text)?.colSpan).not.toBe(6)
  }
)

it.each(['no-frame', 'no-indentation', 'insufficient-peers'])(
  'requires independent source support before extending partial section spans: %s',
  (mode) => {
    const x = fixture('outdented-sections-with-partial-peer-spans')
    if (mode === 'no-frame') x.rules = []
    if (mode === 'no-indentation')
      for (const t of x.tokens) {
        if (t.text === 'Positive result means more ongoing testing/screening') {
          t.rect[0] -= 12.67
          t.rect[2] -= 12.67
        }
      }
    if (mode === 'insufficient-peers')
      x.tokens.find((i: { text: string }) => i.text === 'Emotional issues').text = '1'
    expect(
      parse(x).cells.find((c: { text: string }) => c.text === 'Screening implications')?.colSpan
    ).not.toBe(5)
  }
)

it('joins wrapped flat column headings enclosed by the same native rules', () => {
  const t = parse(fixture('flat-wrapped-headings-inside-shared-rules'))
  expect(t.grid[0]).toEqual(['TNM classification', 'Clinical stage', 'Description'])
  expect(t.grid).toHaveLength(4)
  expect(t.unassigned).toEqual([])
})

it('uses measured peer wrapping to join a terminal stub prefix to its values', () => {
  const t = parse(fixture('terminal-stub-prefix-with-measured-tail'))
  expect(t.grid.at(-1)).toEqual([
    'As sole axillary surgery',
    '40',
    '8.5',
    '53',
    '11.2',
    '54',
    '11.3',
    '147',
    '10.3'
  ])
  expect(t.unassigned).toEqual([])
})

it.each(['separator', 'case', 'font', 'alignment'])(
  'preserves distinct header tiers without consistent continuation evidence: %s',
  (mode) => {
    const x = fixture('flat-wrapped-headings-inside-shared-rules')
    const tails = x.tokens.filter((i: { text: string }) =>
      ['classification', 'stage'].includes(i.text)
    )
    if (mode === 'separator') x.rules.push([95, 677, 449, 677])
    for (const t of tails) {
      if (mode === 'case') t.text = t.text[0].toUpperCase() + t.text.slice(1)
      if (mode === 'font') t.height *= 0.7
      if (mode === 'alignment') {
        t.rect[0] += 8
        t.rect[2] += 8
      }
    }
    expect(parse(x).grid[0][0]).toBe('TNM')
  }
)

it.each(['one-witness', 'separator', 'case', 'indent', 'values-in-prefix'])(
  'keeps a measured row separate from an uncertain preceding section: %s',
  (mode) => {
    const x = fixture('terminal-stub-prefix-with-measured-tail')
    const head = x.tokens.find((i: { text: string }) => i.text === 'As sole axillary')
    const tail = x.tokens.find(
      (i: { text: string; baseline: number }) => i.text === 'surgery' && i.baseline > 300
    )
    if (mode === 'one-witness')
      x.tokens.find((i: { text: string }) => i.text === 'baseline').text = 'Baseline'
    if (mode === 'separator') x.rules.push([451, 341, 826, 341])
    if (mode === 'case') tail.text = 'Surgery'
    if (mode === 'indent') {
      tail.rect[0] -= 10
      tail.rect[2] -= 10
    }
    if (mode === 'values-in-prefix')
      x.tokens.push({ ...head, text: '2', rect: [555, head.rect[1], 566, head.rect[3]] })
    expect(parse(x).grid.some((r: string[]) => r[0] === 'As sole axillary surgery')).toBe(false)
  }
)

it('includes repeated outlined axis labels that graze a quantized caption boundary', () => {
  const x = fixture('outlined-axis-labels-grazing-caption-band')
  const figure = associateFigures(x.page, x.captions).find((f: { rect?: number[] }) => f.rect)
  expect(figure.rect[3]).toBeGreaterThanOrEqual(586)
  expect(figure.rect[3]).toBeLessThan(x.captions[0].rect[1])
})

it.each(['isolated', 'caption-intrusion', 'table-barrier'])(
  'does not grow a figure for unowned outlined marks: %s',
  (mode) => {
    const x = fixture('outlined-axis-labels-grazing-caption-band')
    const marks = x.page.graphicsBounds.filter(
      (g: { kind: string; normalizedRect: number[] }) =>
        g.kind === 'path' &&
        g.normalizedRect[2] - g.normalizedRect[0] < 0.02 &&
        g.normalizedRect[3] > 0.74 &&
        g.normalizedRect[1] > 0.7
    )
    if (mode === 'isolated')
      x.page.graphicsBounds = x.page.graphicsBounds.filter(
        (g: unknown) => !marks.includes(g) || g === marks[0]
      )
    if (mode === 'caption-intrusion') for (const g of marks) g.normalizedRect[3] += 0.02
    const tables = mode === 'table-barrier' ? [[170, 584, 380, 593]] : []
    const figure = associateFigures(x.page, x.captions, tables).find(
      (f: { rect?: number[] }) => f.rect
    )
    expect(figure?.rect?.[3] ?? 0).toBeLessThan(586)
  }
)

it.each(['native', 'prose-font', 'width', 'code', 'unicode', 'conflict'])(
  'decodes a missing-value dash only with consistent punctuation-font evidence: %s',
  async (mode) => {
    const x = fixture('punctuation-font-missing-value-dash')
    if (mode === 'prose-font') x.font.name = 'Times-Roman'
    if (mode === 'width') x.glyph.width = 500
    if (mode === 'code') x.glyph.originalCharCode = 101
    if (mode === 'unicode') x.glyph.unicode = 'x'
    const glyphs = [x.glyph]
    if (mode === 'conflict') glyphs.push({ ...x.glyph, width: 500 })
    const content = { items: [{ str: x.glyph.unicode, fontName: 'source' }] }
    const result = await repairPdfSymbolText({ commonObjs: { get: () => x.font } }, content, {
      fnArray: [OPS.setFont, OPS.showText],
      argsArray: [['source', 10], [glyphs]]
    })
    expect(result.items[0].str).toBe(mode === 'native' ? '—' : content.items[0].str)
  }
)
