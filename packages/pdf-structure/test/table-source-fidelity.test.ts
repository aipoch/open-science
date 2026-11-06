import { readPdfFixture } from './read-fixture'
import { resolve } from './paths'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)

function reconstruct(name: string): string[][] {
  const source = readPdfFixture(resolve(`test/fixtures/source-grids/${name}.jsonl`))
  return refineTable(source.table, source.tokens, source.captions, [], source.rules).grid
}

const { populateTableCellText } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-cell-text.mjs')).href
)
const { refineMeasuredAssignedNumericSegments } = await import(
  pathToFileURL(resolve('resources/literature-pdf-source-segments.mjs')).href
)

it.each([
  'valid',
  'valid-astral',
  'missing-gaps',
  'missing-glyphs',
  'short-rect',
  'nonfinite-rect',
  'wrong-glyph',
  'inside-ligature-gap',
  'duplicate-run',
  'duplicate-origin',
  'cross-cell-glyph',
  'overlapping-text',
  'overlapping-baseline',
  'separated-small-script',
  'separated-rotated-text',
  'nan-peer-height',
  'infinite-peer-height',
  'nan-peer-baseline',
  'infinite-peer-baseline',
  'nonboolean-peer-horizontal',
  'separate-normal-line'
])(
  'uses only complete measured body evidence and retains mixed-cell source ranges: %s',
  (variant) => {
    const token = (
      text: string,
      index: number,
      left: number,
      right: number
    ): {
      text: string
      rect: number[]
      baseline: number
      height: number
      horizontal: boolean
      sourceItem: { pageNumber: number; index: number; text: string }
    } => ({
      text,
      rect: [left, 20, right, 30],
      baseline: 30,
      height: 10,
      horizontal: true,
      sourceItem: { pageNumber: 1, index, text }
    })
    const prefix = token('3', 1, 30, 35),
      parent = token(variant === 'valid-astral' ? '𝒰  2 m' : 'Q 2 m', 2, 35, 65),
      suffix = token('u', 3, 65, 70),
      pageItems = [prefix, parent, suffix],
      measuredRuns = [
        {
          text: parent.text,
          rect: [...parent.rect],
          baseline: 30,
          height: 10,
          gaps: [
            { left: 41, right: 51, index: 1 },
            { left: 56, right: 59, index: 2 }
          ],
          glyphRuns: [2, 2, 2],
          literalGlyphs: [variant === 'valid-astral' ? '𝒰' : 'Q', '2', 'm']
        }
      ],
      cells = [0, 1].map((column) => ({
        row: 0,
        column,
        rowSpan: 1,
        colSpan: 1,
        rect: [column ? 47 : 0, 10, column ? 100 : 47, 40],
        items: [],
        text: ''
      }))
    const repairs: string[] = []
    if (variant === 'missing-gaps') Reflect.deleteProperty(measuredRuns[0], 'gaps')
    if (variant === 'missing-glyphs') Reflect.deleteProperty(measuredRuns[0], 'literalGlyphs')
    if (variant === 'short-rect') measuredRuns[0].rect.pop()
    if (variant === 'nonfinite-rect') measuredRuns[0].rect[0] = NaN
    if (variant === 'wrong-glyph') measuredRuns[0].literalGlyphs[0] = 'X'
    if (variant === 'inside-ligature-gap') measuredRuns[0].literalGlyphs = ['Q2', 'm']
    if (variant === 'duplicate-run') measuredRuns.push(structuredClone(measuredRuns[0]))
    if (variant === 'duplicate-origin') pageItems.push({ ...parent, rect: [200, 20, 230, 30] })
    if (variant === 'cross-cell-glyph') measuredRuns[0].gaps[0].left = 48
    if (variant === 'overlapping-text') pageItems.push(token('foreign', 9, 36, 40))
    if (
      [
        'overlapping-baseline',
        'separated-small-script',
        'separated-rotated-text',
        'nan-peer-height',
        'infinite-peer-height',
        'nan-peer-baseline',
        'infinite-peer-baseline',
        'nonboolean-peer-horizontal',
        'separate-normal-line'
      ].includes(variant)
    ) {
      const other = token('R', 9, 80, 85)
      other.rect = variant === 'overlapping-baseline' ? [80, 22, 85, 32] : [80, 30, 85, 40]
      other.baseline = other.rect[3]
      if (variant === 'separated-small-script') {
        other.height = 7.5
        other.rect[1] = other.baseline - other.height
      }
      if (variant === 'separated-rotated-text') other.horizontal = false
      if (variant === 'nan-peer-height') other.height = NaN
      if (variant === 'infinite-peer-height') other.height = Infinity
      if (variant === 'nan-peer-baseline') other.baseline = NaN
      if (variant === 'infinite-peer-baseline') other.baseline = Infinity
      if (variant === 'nonboolean-peer-horizontal') Reflect.set(other, 'horizontal', 1)
      pageItems.push(other)
    }
    expect(() =>
      populateTableCellText({
        cells,
        items: pageItems.slice(),
        pageItems,
        rows: [{ rect: [0, 10, 100, 40] }],
        columnRects: cells.map((c) => c.rect),
        headerRows: [],
        rules: [],
        bottom: 40,
        measuredRuns,
        issues: new Set(),
        repairs
      })
    ).not.toThrow()
    if (variant === 'separate-normal-line') {
      expect(repairs).toContain('native-measured-body-run-split')
      expect(cells[1].text).toContain('R')
      return
    }
    if (variant !== 'valid' && variant !== 'valid-astral') {
      expect(repairs).not.toContain('native-measured-body-run-split')
      return
    }
    expect(cells.map((c) => c.text)).toEqual([variant === 'valid-astral' ? '3𝒰' : '3Q', '2 mu'])
    const table = { cells, grid: [cells.map((c) => c.text)] }
    refineMeasuredAssignedNumericSegments(table, pageItems, measuredRuns)
    expect(cells).toMatchObject([
      {
        sourceSegments: [
          { ...prefix.sourceItem, start: 0, end: 1, rect: prefix.rect },
          {
            ...parent.sourceItem,
            start: 0,
            end: variant === 'valid-astral' ? 2 : 1,
            rect: [35, 20, 41, 30]
          }
        ]
      },
      {
        sourceSegments: [
          {
            ...parent.sourceItem,
            start: variant === 'valid-astral' ? 4 : 2,
            end: variant === 'valid-astral' ? 7 : 5,
            rect: [51, 20, 65, 30]
          },
          { ...suffix.sourceItem, start: 0, end: 1, rect: suffix.rect }
        ]
      }
    ])
    expect(cells.every((c) => !('sourceItems' in c))).toBe(true)
    expect(pageItems).toEqual([prefix, parent, suffix])
  }
)

it.each(['complete', 'missing', 'conflicting'])(
  'retains exact item identities only for completely mapped cells (%s)',
  (kind) => {
    const items = [10, 30, 70].map((x, n) => ({
      text: n === 1 ? '=' : '10',
      rect: [x, 10, x + 10, 20],
      baseline: 20,
      height: 10,
      horizontal: true,
      sourceItem: { pageNumber: 3, index: [21, 3, 7][n], text: n === 1 ? '¼' : '10' }
    }))
    if (kind === 'missing') Object.assign(items[1], { sourceItem: undefined })
    if (kind === 'conflicting') items[1].sourceItem.index = 21
    const cells = [0, 1].map((column) => ({
      row: 0,
      column,
      rowSpan: 1,
      colSpan: 1,
      rect: [column * 50, 0, column * 50 + 50, 30],
      items: []
    }))
    populateTableCellText({
      cells,
      items,
      pageItems: items,
      rows: [{ rect: [0, 0, 100, 30] }],
      columnRects: cells.map((c) => c.rect),
      headerRows: [],
      rules: [],
      bottom: 30,
      issues: new Set(),
      repairs: []
    })
    expect(cells[0]).toMatchObject({ text: '10 =' })
    expect(cells[1]).toMatchObject({
      text: '10',
      sourceItems: [{ pageNumber: 3, index: 7, text: '10' }]
    })
    if (kind === 'complete') {
      expect(cells[0]).toMatchObject({
        sourceItems: [
          { pageNumber: 3, index: 3, text: '¼' },
          { pageNumber: 3, index: 21, text: '10' }
        ]
      })
      items[1].sourceItem.text = 'changed after construction'
      expect(cells[0]).toMatchObject({
        sourceItems: [
          { pageNumber: 3, index: 3, text: '¼' },
          { pageNumber: 3, index: 21, text: '10' }
        ]
      })
    } else expect(cells[0]).not.toHaveProperty('sourceItems')
  }
)

it('preserves a source percentage without inventing its missing count', () => {
  const grid = reconstruct('wrapped-threshold-label')
  const section = grid.findIndex((row) => row[0] === 'M staging')
  expect(section).toBeGreaterThan(0)
  expect(grid[section + 3]).toEqual(['Unknown', '2 (3.7)', '(0.0)', '0.208'])
})

it('preserves printed totals and percentages even when they are inconsistent', () => {
  const grid = reconstruct('empty-overlapping-row')
  expect(grid.find((row) => row[0] === 'Other Asian')).toEqual([
    'Other Asian',
    '10/78 (12.8)',
    '20/78 (25.6)',
    '56/156 (35.9)'
  ])
  expect(grid.find((row) => row[0] === 'Europe/United Kingdom')).toEqual([
    'Europe/United Kingdom',
    '6/78 (7.8)',
    '8/78 (10.2)',
    '14/78 (17.9)'
  ])
})

it('keeps values at their printed positions rather than inferring demographic labels', () => {
  const grid = reconstruct('source-displaced-values')
  expect(grid.slice(1, 6)).toEqual([
    ['Demographics', '57.0 ± 9.1', '57.9 ± 8.7', '55.9 ± 9.5'],
    ['Age (yr, mean ± SD)', '162.0 ± 6.4', '162.2 ± 6.3', '162.0 ± 6.6'],
    ['Height (cm, mean ± SD)', '73.3 ± 14.1', '74.4 ± 13.2', '72.0 ± 14.6'],
    ['Weight (kg, mean ± SD)', '27.8 ± 4.8', '28.2 ± 4.8', '27.3 ± 4.7'],
    ['BMI (kg/m2, mean ± SD)', '', '', '']
  ])
})
