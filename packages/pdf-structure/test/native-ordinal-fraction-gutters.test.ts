import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { resolve } from './paths'

const gutters = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-measured-gutters.mjs')).href
)
const { splitPdfNumericRuns, nativeWhitespaceGaps } = await import(
  pathToFileURL(resolve('resources/literature-pdf-symbol-text.mjs')).href
)
const { tableTextToken } = await import(
  pathToFileURL(resolve('resources/literature-pdf-orientation.mjs')).href
)
const { refineTable } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)
const { attachMeasuredTableSourceSegments } = await import(
  pathToFileURL(resolve('resources/literature-pdf-source-segments.mjs')).href
)

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function fixture() {
  const source = [
    ['I', 12, 15],
    ['V', 26, 15],
    ...[0, 1, 2].flatMap((n) => [
      [`${n + 10} 8`, 10, 35 + n * 20],
      ['/', 31, 35 + n * 20],
      ['5', 36, 35 + n * 20]
    ])
  ] as Array<[string, number, number]>
  const content = {
    items: source.map(([str, x, baseline], index) => ({
      str,
      dir: 'ltr',
      fontName: 'native',
      height: 10,
      width: str.includes(' ') ? 21 : 5,
      transform: [10, 0, 0, 10, x, 100 - baseline],
      sourceItem: { pageNumber: 1, index, text: str }
    }))
  }
  const operators = {
    fnArray: [OPS.setFont, ...source.map(() => OPS.showText)],
    argsArray: [
      ['native', 10],
      ...source.map(([str]) => [
        [...str].map((unicode) =>
          unicode === ' ' ? -600 : { unicode, width: 500, isSpace: false }
        )
      ])
    ]
  }
  const viewport = {
    rotation: 0,
    scale: 1,
    transform: [1, 0, 0, -1, 0, 100],
    convertToViewportPoint: (x: number, y: number) => [x, 100 - y]
  }
  const items = content.items.map((i) => tableTextToken(i, viewport, 0))
  const rules = [0, 20, 85].map((y) => [0, y, 50, y])
  const runs = nativeWhitespaceGaps(content, operators, viewport)
  const table = {
    id: 'anonymous-table',
    page: 1,
    cropRect: [0, 0, 50, 85],
    structure: {
      objects: [
        { label: 'table column', rect: [0, 0, 23, 85] },
        { label: 'table column', rect: [23, 0, 50, 85] },
        { label: 'table column header', rect: [0, 0, 50, 20] },
        { label: 'table row', rect: [0, 0, 50, 20] },
        { label: 'table row', rect: [0, 20, 50, 45] },
        { label: 'table row', rect: [0, 45, 50, 85] }
      ]
    }
  }
  return { content, operators, viewport, items, rules, runs, table }
}

const prove = (x: ReturnType<typeof fixture>): Array<{ rect: number[]; cuts: number[] }> =>
  gutters.proveNativeOrdinalFractionGutters?.(x.items, x.rules, x.runs) ?? []

it('proves an ordinal gutter from complete native records and independent ruled header leaves', () => {
  const x = fixture()
  expect(prove(x)).toEqual([{ rect: [0, 0, 50, 85], cuts: [23], gutterBands: [[20, 26]] }])
})

it('transports measured whole-parent ranges through actual refinement without guessing fractions', () => {
  const x = fixture()
  const content = splitPdfNumericRuns(x.content, x.operators, {
    viewport: x.viewport,
    rules: x.rules,
    provenFrames: prove(x)
  })
  const tokens = content.items.map((i: (typeof content.items)[number]) =>
    tableTextToken(i, x.viewport, 0)
  )
  const table = refineTable(
    x.table,
    tokens,
    [{ lines: ['Table 1. Values'], rect: [0, -20, 50, -5] }],
    [],
    x.rules,
    x.runs
  )
  attachMeasuredTableSourceSegments(table, tokens)
  expect(table.grid).toEqual([
    ['I', 'V'],
    ['10', '8/5'],
    ['11', '8/5'],
    ['12', '8/5']
  ])
  const segments = table.cells.flatMap(
    (c: { sourceSegments?: unknown[] }) => c.sourceSegments ?? []
  )
  expect(segments).toHaveLength(12)
  for (const row of [1, 2, 3]) {
    const index = 2 + (row - 1) * 3
    expect(
      table.cells.find((c: { row: number; column: number }) => c.row === row && c.column === 0)
        .sourceSegments
    ).toEqual([expect.objectContaining({ index, text: `${row + 9} 8`, start: 0, end: 2 })])
  }
})

it.each([
  'no-rules',
  'missing-opening',
  'missing-divider',
  'missing-closing',
  'partial-divider',
  'crossing-rule',
  'diagonal-rule',
  'independent-value',
  'nonconsecutive-index',
  'missing-record-field',
  'narrative-body',
  'missing-header',
  'header-crosses-gutter',
  'foreign-ink',
  'rotated-ink',
  'crossing-frame',
  'outside-alias',
  'nested-alias',
  'missing-run',
  'wrong-glyphs',
  'unmeasured-gap',
  'malformed-inventory'
])('rejects an unproved ordinal gutter: %s', (variant) => {
  const x = fixture()
  if (variant === 'no-rules') x.rules = []
  if (variant === 'missing-opening') x.rules.shift()
  if (variant === 'missing-divider') x.rules.splice(1, 1)
  if (variant === 'missing-closing') x.rules.pop()
  if (variant === 'partial-divider') x.rules[1][2] = 25
  if (variant === 'crossing-rule') x.rules.push([18, 0, 18, 85])
  if (variant === 'diagonal-rule') x.rules.push([0, 20, 50, 70])
  if (variant === 'independent-value') x.items[4].rect = [44, 25, 49, 35]
  if (variant === 'nonconsecutive-index') {
    x.items[5].text = x.items[5].sourceItem.text = '4 8'
    x.runs.find((r: { text: string }) => r.text === '11 8').text = '4 8'
  }
  if (variant === 'missing-record-field') x.items.splice(4, 1)
  if (variant === 'narrative-body') x.items[3].text = x.items[3].sourceItem.text = 'and'
  if (variant === 'missing-header') x.items.shift()
  if (variant === 'header-crosses-gutter') x.items[0].rect[2] = 26
  if (variant === 'foreign-ink' || variant === 'rotated-ink') {
    x.items.push({
      ...x.items[0],
      text: 'note',
      rect: [40, 40, 49, 50],
      baseline: 50,
      horizontal: variant !== 'rotated-ink',
      sourceItem: { pageNumber: 1, index: 50, text: 'note' }
    })
  }
  if (variant === 'crossing-frame') x.items[2].rect[0] = -1
  if (variant === 'outside-alias' || variant === 'nested-alias') {
    x.items.push({
      ...x.items[2],
      rect: [100, 25, 120, 35],
      ...(variant === 'nested-alias'
        ? { sourceItem: undefined, carrier: { sourceItems: [x.items[2].sourceItem] } }
        : {})
    })
  }
  if (variant === 'missing-run') x.runs = []
  if (variant === 'wrong-glyphs')
    x.runs.find((r: { text: string }) => r.text === '10 8').literalGlyphs = ['0', '9']
  if (variant === 'unmeasured-gap')
    x.runs.find((r: { text: string }) => r.text === '10 8').gaps = []
  if (variant === 'malformed-inventory')
    x.items.push({ ...x.items[0], rect: [Number.NaN, 0, 2, 10] })
  expect(prove(x)).toEqual([])
})

it('keeps valid evidence under uniform scale and translation with unrelated outside prose', () => {
  const x = fixture(),
    scale = 2,
    dx = 11,
    dy = 7
  const rect = (r: number[]): number[] => r.map((v, n) => v * scale + (n % 2 ? dy : dx))
  for (const i of x.items) {
    i.rect = rect(i.rect)
    i.baseline = i.baseline * scale + dy
    i.height *= scale
  }
  x.rules = x.rules.map(rect)
  for (const r of x.runs) {
    r.rect = rect(r.rect)
    for (const g of r.gaps) {
      g.left = g.left * scale + dx
      g.right = g.right * scale + dx
    }
  }
  x.items.push({
    ...x.items[0],
    rect: [300, 10, 320, 20],
    sourceItem: { pageNumber: 1, index: 80, text: 'I' }
  })
  expect(prove(x)).toEqual([
    {
      rect: rect([0, 0, 50, 85]),
      cuts: [23 * scale + dx],
      gutterBands: [[20 * scale + dx, 26 * scale + dx]]
    }
  ])
})
