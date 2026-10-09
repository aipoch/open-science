import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const { trimTableCaptionCrop: trim } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-geometry.mjs')).href
)
type Item = {
  text: string
  rect: number[]
  baseline: number
  height: number
  horizontal: boolean
  sourceToken?: Item
}
const source = (text: string, x: number, y: number): Item => ({
  text,
  rect: [x, y - 10, x + 20, y],
  baseline: y,
  height: 10,
  horizontal: true
})
const setup = (
  below = false
): {
  table: {
    cropRect: number[]
    grid: string[][]
    columns: number[][]
    cells: {
      row: number
      column: number
      rowSpan: number
      colSpan: number
      text?: string
      rect?: number[]
      sourceRects: number[][]
      sourceTokens?: Item[]
    }[]
    unassigned: unknown[]
  }
  cropRect: number[]
  caption: { page: number; lines: string[]; rect: number[] }
  contentRect: number[]
  rules: number[][]
  pageItems: Item[]
  pageFontItems?: (Item & { fontDescent: number })[]
  noteOwnerRects?: number[][]
  pageNumber: number
  scale: number
  rulePaintBounds?: Map<string, number[]>
} => {
  const pageItems: Item[] = [],
    cells: ReturnType<typeof setup>['table']['cells'] = []
  const grid = [
    ['Category', 'Leaf A', 'Leaf B', 'Leaf C'],
    ['Row A', '11', '22', '33'],
    ['Row B', '14', '25', '36']
  ]
  for (const [r, row] of grid.entries())
    for (const [c, text] of row.entries()) {
      const i = source(text, 5 + c * 60, [32, 60, 82][r])
      pageItems.push(i)
      cells.push({ row: r, column: c, rowSpan: 1, colSpan: 1, sourceRects: [i.rect] })
    }
  const captionItem = source('Table 1. Measured leaves.', 5, below ? 108 : 10)
  captionItem.rect[2] = 220
  pageItems.push(captionItem)
  const cropRect = [0, 20.4, 240, 110]
  return {
    table: {
      cropRect: [...cropRect],
      grid,
      columns: [0, 60, 120, 180].map((x) => [x, 20, x + 60, 100]),
      cells,
      unassigned: []
    },
    cropRect,
    caption: { page: 1, lines: [captionItem.text], rect: [...captionItem.rect] },
    contentRect: [5, 22, 205, 80],
    rules: [20, 40, 100].map((y) => [0, y, 240, y]),
    pageItems,
    pageNumber: 1,
    scale: 1
  }
}
it('preserves the complete native opening above a slightly undersized detector crop', () => {
  const f = setup()
  trim(f)
  expect(f.cropRect[1]).toBe(19.5)
})
it('retains the unique native closing beneath an exactly owned caption font-box overhang', () => {
  const f = setup(true)
  trim(f)
  expect(f.cropRect[3]).toBe(100.5)
})
const partitioned = (): ReturnType<typeof setup> => {
  const f = setup(true),
    cell = f.table.cells[1],
    original = f.pageItems[1]
  const a = { ...original, text: 'Leaf', rect: [65, 22, 77, 32] },
    b = { ...original, text: 'A', rect: [80, 22, 85, 32] }
  cell.sourceTokens = [a, b]
  cell.sourceRects = [a.rect, b.rect]
  return f
}
it('retains the footer when final word fragments uniquely partition a complete original native literal', () => {
  const f = partitioned()
  trim(f)
  expect(f.cropRect[3]).toBe(100.5)
})
it.each([
  'missing fragment',
  'foreign literal',
  'overlapping fragments',
  'ambiguous native parent',
  'missing original edge'
])('declines incomplete native word partitions: %s', (variant) => {
  const f = partitioned(),
    cell = f.table.cells[1]
  if (variant === 'missing fragment') {
    cell.sourceTokens!.pop()
    cell.sourceRects.pop()
  }
  if (variant === 'foreign literal') cell.sourceTokens![1].text = 'B'
  if (variant === 'overlapping fragments') cell.sourceTokens![1].rect[0] = 76
  if (variant === 'ambiguous native parent') f.pageItems.push({ ...f.pageItems[1] })
  if (variant === 'missing original edge') cell.sourceTokens![1].rect[2] = 84
  trim(f)
  expect(f.cropRect[3]).toBe(97)
})

const paintedTextFrame = (): ReturnType<typeof setup> => {
  const f = textFrame(3, true)
  f.rulePaintBounds = new Map([
    [f.rules[0].join(','), [0, 9.40225, 180, 10.59775]],
    [f.rules[2].join(','), [0, 84.40225, 180, 85.59775]]
  ])
  return f
}

const doubleOpeningFrame = (): ReturnType<typeof setup> => {
  const f = setup()
  f.rules.splice(1, 0, [0, 22, 240, 22])
  for (const i of f.pageItems.filter((i) => i.baseline === 32)) {
    i.baseline += 2
    i.rect[1] += 2
    i.rect[3] += 2
  }
  f.cropRect[1] = f.table.cropRect[1] = 22.8
  f.rulePaintBounds = new Map([
    [f.rules[0].join(','), [0, 19.6, 240, 20.4]],
    [f.rules[1].join(','), [0, 21.6, 240, 22.4]],
    [f.rules.at(-1)!.join(','), [0, 99.6, 240, 100.4]]
  ])
  return f
}
it('preserves both painted opening rules of one wholly owned captioned native table', () => {
  const f = doubleOpeningFrame(),
    before = structuredClone(f.table)
  trim(f)
  expect(f.cropRect[1]).toBe(19.5)
  expect(f.table).toEqual(before)
})
it.each([
  'missing-first-paint',
  'missing-second-paint',
  'different-endpoints',
  'third-opening',
  'separated-rules',
  'far-crop',
  'foreign-strip'
])(
  'does not widen opening recovery without the exact same owned painted double frame: %s',
  (variant) => {
    const f = doubleOpeningFrame()
    if (variant === 'missing-first-paint') f.rulePaintBounds!.delete(f.rules[0].join(','))
    if (variant === 'missing-second-paint') f.rulePaintBounds!.delete(f.rules[1].join(','))
    if (variant === 'different-endpoints') f.rules[1][0] = 1
    if (variant === 'third-opening') f.rules.splice(1, 0, [0, 21, 240, 21])
    if (variant === 'separated-rules') f.rules[0][1] = f.rules[0][3] = 16
    if (variant === 'far-crop') f.cropRect[1] = f.table.cropRect[1] = 26
    if (variant === 'foreign-strip') f.pageItems.push(source('foreign', 100, 21.8))
    trim(f)
    expect(f.cropRect[1]).toBeGreaterThan(20)
  }
)

it.each(['left', 'right', 'both'])(
  'retains both measured frame endpoints at a near %s crop edge',
  (edge) => {
    const f = paintedTextFrame(),
      before = structuredClone(f.table)
    if (edge !== 'right') f.cropRect[0] = 0.4
    if (edge !== 'left') f.cropRect[2] = 179.6
    trim(f)
    expect([f.cropRect[0], f.cropRect[2]]).toEqual([0, 180])
    expect(f.table).toEqual(before)
  }
)

it.each([
  'missing opening paint',
  'missing closing paint',
  'different native endpoints',
  'far left',
  'far right',
  'left foreign',
  'right foreign',
  'foreign above opening'
])('declines lateral recovery without complete native ownership: %s', (variant) => {
  const f = paintedTextFrame()
  f.cropRect[0] = 0.4
  f.cropRect[2] = 179.6
  if (variant === 'missing opening paint') f.rulePaintBounds!.delete(f.rules[0].join(','))
  if (variant === 'missing closing paint') f.rulePaintBounds!.delete(f.rules[2].join(','))
  if (variant === 'different native endpoints') {
    const old = f.rules[2].join(',')
    f.rules[2][2] = 179.9
    f.rulePaintBounds!.delete(old)
    f.rulePaintBounds!.set(f.rules[2].join(','), [0, 84.40225, 179.9, 85.59775])
  }
  if (variant === 'far left') f.cropRect[0] = 2.5
  if (variant === 'far right') f.cropRect[2] = 177.5
  if (variant.includes('foreign')) {
    if (variant === 'foreign above opening') f.cropRect[1] = 7
    const rect =
      variant === 'right foreign'
        ? [179.7, 50, 179.9, 51]
        : variant === 'foreign above opening'
          ? [0.1, 8, 0.3, 9]
          : [0.1, 50, 0.3, 51]
    f.pageItems.push({
      text: 'Foreign',
      rect,
      baseline: rect[3],
      height: rect[3] - rect[1],
      horizontal: true
    })
  }
  const before = [f.cropRect[0], f.cropRect[2]]
  trim(f)
  // Foreign ink within the frame invalidates both sides; outside-frame crop
  // padding and proximity are checked independently for each added strip.
  const expected =
    variant === 'far left' || variant === 'foreign above opening'
      ? [before[0], 180]
      : variant === 'far right'
        ? [0, before[1]]
        : before
  expect([f.cropRect[0], f.cropRect[2]]).toEqual(expected)
})

it('retains measured projecting-cap sides without changing any cell bounds', () => {
  const f = paintedTextFrame(),
    before = structuredClone(f.table)
  for (const rect of f.rulePaintBounds!.values()) {
    rect[0] = -0.59775
    rect[2] = 180.59775
  }
  trim(f)
  expect([f.cropRect[0], f.cropRect[2]]).toEqual([-0.59775, 180.59775])
  expect(f.table).toEqual(before)
})

it('declines an unowned caption-side fragment across a measured projecting cap', () => {
  const f = paintedTextFrame()
  for (const rect of f.rulePaintBounds!.values()) {
    rect[0] = -0.59775
    rect[2] = 180.59775
  }
  f.pageItems.push({
    text: 'Foreign',
    rect: [180.1, 50, 180.4, 51],
    baseline: 51,
    height: 1,
    horizontal: true
  })
  trim(f)
  expect([f.cropRect[0], f.cropRect[2]]).toEqual([-0.59775, 180])
})

it('retains the measured stroke envelope in a complete native two-tier frame', () => {
  const f = paintedTextFrame(),
    before = structuredClone(f.table),
    caption = structuredClone(f.caption)
  trim(f)
  expect(f.cropRect).toEqual([0, 9.40225, 180, 85.59775])
  expect(f.table).toEqual(before)
  expect(f.caption).toEqual(caption)
})

it('retains the measured stroke envelope without losing the legacy scalar proof', () => {
  const f = setup(true)
  f.rulePaintBounds = new Map([
    [f.rules[0].join(','), [0, 19.40225, 240, 20.59775]],
    [f.rules[2].join(','), [0, 99.40225, 240, 100.59775]]
  ])
  trim(f)
  expect(f.cropRect).toEqual([0, 19.40225, 240, 100.59775])
})

it('uses the filled-rule paint bounds while retaining existing half-pixel protection', () => {
  const f = paintedTextFrame()
  f.rulePaintBounds!.set(f.rules[0].join(','), [0, 9.6, 180, 10.4])
  f.rulePaintBounds!.set(f.rules[2].join(','), [0, 84.2, 180, 85.8])
  trim(f)
  expect(f.cropRect).toEqual([0, 9.5, 180, 85.8])
})

it('preserves the measured stroke beyond an existing half-pixel opening margin', () => {
  const f = paintedTextFrame()
  f.cropRect[1] = f.table.cropRect[1] = 9.5
  trim(f)
  expect(f.cropRect[1]).toBe(9.40225)
})

it.each(['absent', 'wrong key', 'nonfinite', 'wrong center', 'wrong endpoints', 'inverted'])(
  'does not expand a frame from %s paint metadata',
  (variant) => {
    const f = paintedTextFrame()
    if (variant === 'absent') f.rulePaintBounds = undefined
    if (variant === 'wrong key')
      f.rulePaintBounds = new Map([['unrelated', [0, 9.40225, 180, 85.59775]]])
    if (variant === 'nonfinite') for (const rect of f.rulePaintBounds!.values()) rect[1] = NaN
    if (variant === 'wrong center')
      for (const rect of f.rulePaintBounds!.values()) {
        rect[1] += 2
        rect[3] += 2
      }
    if (variant === 'wrong endpoints') for (const rect of f.rulePaintBounds!.values()) rect[0] += 4
    if (variant === 'inverted')
      for (const rect of f.rulePaintBounds!.values()) [rect[1], rect[3]] = [rect[3], rect[1]]
    trim(f)
    expect(f.cropRect).toEqual([0, 10, 180, 85.5])
  }
)

it.each(['opening strip', 'closing strip'])(
  'does not absorb unowned native ink in the newly painted %s',
  (variant) => {
    const f = paintedTextFrame(),
      rect = variant === 'opening strip' ? [60, 9.41, 70, 9.44] : [176, 85.55, 179, 85.58]
    f.pageItems.push({
      text: 'Foreign',
      rect,
      baseline: rect[3],
      height: rect[3] - rect[1],
      horizontal: true
    })
    trim(f)
    expect(f.cropRect).toEqual(
      variant === 'opening strip' ? [0, 10, 180, 85.59775] : [0, 9.40225, 180, 85.5]
    )
  }
)

it('does not extend an opening beyond the existing proximity gate', () => {
  const f = paintedTextFrame()
  f.cropRect[1] = f.table.cropRect[1] = 12.5
  trim(f)
  expect(f.cropRect[1]).toBe(12.5)
  expect(f.cropRect[3]).toBe(85.59775)
})

it('keeps foreign ink in the crop-side opening strip outside table ownership', () => {
  const f = paintedTextFrame()
  f.cropRect[0] = f.table.cropRect[0] = -4
  f.pageItems.push({
    text: 'Foreign',
    rect: [-3, 9.41, -1, 9.44],
    baseline: 9.44,
    height: 0.03,
    horizontal: true
  })
  trim(f)
  expect(f.cropRect).toEqual([-4, 10, 180, 85.59775])
})

// A footer is a native ownership boundary even when the measured records are
// text, or the independently printed caption has a larger font than the table.
const textFrame = (
  columns = 3,
  twoTier = false,
  smallFont = false,
  wrapped = false
): ReturnType<typeof setup> => {
  const h = smallFont ? 7.5 : 10,
    width = columns * 60,
    pageItems: Item[] = [],
    cells: ReturnType<typeof setup>['table']['cells'] = [],
    grid: string[][] = [],
    rowBases = twoTier ? [22, 35, 55, 75] : [25, 45, 75]
  const add = (text: string, x: number, y: number, height = h, span = 20): Item => {
    const item = { text, rect: [x, y - height, x + span, y], baseline: y, height, horizontal: true }
    pageItems.push(item)
    return item
  }
  for (const [r, y] of rowBases.entries()) {
    if (twoTier && r === 0) {
      const item = add('Shared', 70, y)
      grid.push(['', 'Shared', ''])
      cells.push(
        {
          row: 0,
          column: 0,
          rowSpan: 1,
          colSpan: 1,
          text: '',
          rect: [0, 10, 60, 24],
          sourceRects: []
        },
        {
          row: 0,
          column: 1,
          rowSpan: 1,
          colSpan: 2,
          text: 'Shared',
          rect: [60, 10, 180, 24],
          sourceRects: [item.rect],
          sourceTokens: [item]
        }
      )
      continue
    }
    const row: string[] = []
    for (let c = 0; c < columns; c++) {
      const text =
          r === (twoTier ? 1 : 0)
            ? `Leaf ${String.fromCharCode(65 + c)}`
            : `Text ${String.fromCharCode(65 + c)}${r}`,
        item = add(text, 5 + c * 60, y),
        cell = {
          row: r,
          column: c,
          rowSpan: 1,
          colSpan: 1,
          text,
          rect: [
            c * 60,
            r === 0
              ? 10
              : twoTier && r === 1
                ? 24
                : r === (twoTier ? 2 : 1)
                  ? twoTier
                    ? 40
                    : 30
                  : 60,
            (c + 1) * 60,
            r <= (twoTier ? 1 : 0) ? (twoTier ? 40 : 30) : r === (twoTier ? 2 : 1) ? 60 : 85
          ],
          sourceRects: [item.rect],
          sourceTokens: [item]
        }
      if (wrapped && r === 1 && c === 2) {
        item.text = 'Wrap-'
        const tail = add('ped', item.rect[0], y + 10)
        cell.sourceTokens.push(tail)
        cell.sourceRects.push(tail.rect)
        cell.text = 'Wrapped'
      }
      row.push(cell.text)
      cells.push(cell)
    }
    grid.push(row)
  }
  if (wrapped) add('Wrapped', 5, 125, 10, 45)
  const captionItem = add('Table 1. Native records.', 5, smallFont ? 94.5 : 96, 12, width - 10),
    cropRect = [0, 10, width, smallFont ? 98 : 100]
  return {
    table: {
      cropRect: [...cropRect],
      grid,
      cells,
      columns: Array.from({ length: columns }, (_, n) => [n * 60, 10, (n + 1) * 60, 85]),
      unassigned: []
    },
    cropRect,
    caption: { page: 1, lines: [captionItem.text], rect: [...captionItem.rect] },
    contentRect: [5, 15, width - 5, 75],
    rules: [10, twoTier ? 40 : 30, 85].map((y) => [0, y, width, y]),
    pageItems,
    pageNumber: 1,
    scale: 1
  }
}

it('recovers a double painted opening above complete descriptive native records with an above-frame caption', () => {
  const f = textFrame()
  const item = f.pageItems.at(-1)!
  item.baseline = 4
  item.rect[1] = -8
  item.rect[3] = 4
  f.caption.rect = [...item.rect]
  f.rules.splice(1, 0, [0, 12, 180, 12])
  f.cropRect[1] = f.table.cropRect[1] = 12.8
  f.rulePaintBounds = new Map([
    [f.rules[0].join(','), [0, 9.6, 180, 10.4]],
    [f.rules[1].join(','), [0, 11.6, 180, 12.4]],
    [f.rules.at(-1)!.join(','), [0, 84.6, 180, 85.4]]
  ])
  trim(f)
  expect(f.cropRect[1]).toBe(9.5)
  expect(f.table.grid.slice(1).every((r) => r.every((s) => s.startsWith('Text')))).toBe(true)
})

it.each([
  { name: 'three text columns', columns: 3, twoTier: false, smallFont: false, wrapped: false },
  { name: 'two text columns', columns: 2, twoTier: false, smallFont: false, wrapped: false },
  { name: 'two native header tiers', columns: 3, twoTier: true, smallFont: false, wrapped: false },
  {
    name: 'larger native caption font',
    columns: 3,
    twoTier: false,
    smallFont: true,
    wrapped: false
  },
  {
    name: 'independently witnessed line wrap',
    columns: 3,
    twoTier: false,
    smallFont: false,
    wrapped: true
  }
])(
  'preserves the complete source-owned footer for $name',
  ({ columns, twoTier, smallFont, wrapped }) => {
    const f = textFrame(columns, twoTier, smallFont, wrapped),
      tableBefore = structuredClone(f.table),
      captionBefore = structuredClone(f.caption)
    trim(f)
    expect(f.cropRect).toEqual([0, 10, columns * 60, 85.5])
    expect(f.table).toEqual(tableBefore)
    expect(f.caption).toEqual(captionBefore)
  }
)

it.each([
  'missing footer',
  'competing footer',
  'cross-opening foreign ink',
  'cross-closing foreign ink',
  'caption mismatch',
  'duplicate leaf column',
  'leaf column span',
  'leaf row span',
  'leaf columns reversed',
  'first record reversed',
  'grid mismatch',
  'native literal mismatch',
  'missing native source'
])('declines a text-frame footer without complete native evidence: %s', (variant) => {
  const f = textFrame(),
    leaf = f.table.cells.filter((c) => c.row === 0),
    first = f.table.cells.filter((c) => c.row === 1)
  if (variant === 'missing footer') f.rules.pop()
  if (variant === 'competing footer') f.rules.push([0, 85.1, 180, 85.1])
  if (variant === 'cross-opening foreign ink')
    f.pageItems.push({
      text: 'Foreign',
      rect: [70, 9, 90, 20],
      baseline: 9,
      height: 11,
      horizontal: true
    })
  if (variant === 'cross-closing foreign ink')
    f.pageItems.push({
      text: 'Foreign',
      rect: [70, 84, 90, 96],
      baseline: 96,
      height: 12,
      horizontal: true
    })
  if (variant === 'caption mismatch') f.caption.lines = ['Table 2. Unrelated']
  if (variant === 'duplicate leaf column')
    leaf.forEach((c) => {
      c.column = 0
    })
  if (variant === 'leaf column span') leaf[0].colSpan = 2
  if (variant === 'leaf row span') leaf[0].rowSpan = 2
  if (variant === 'leaf columns reversed' || variant === 'first record reversed') {
    const cells = variant === 'leaf columns reversed' ? leaf : first,
      row = variant === 'leaf columns reversed' ? 0 : 1
    ;[cells[0].column, cells[1].column] = [1, 0]
    ;[f.table.grid[row][0], f.table.grid[row][1]] = [f.table.grid[row][1], f.table.grid[row][0]]
  }
  if (variant === 'grid mismatch') f.table.grid[0][0] = 'Different'
  if (variant === 'native literal mismatch') {
    f.table.grid[0][0] = 'Different'
    leaf[0].text = 'Different'
  }
  if (variant === 'missing native source') leaf[0].sourceRects = []
  trim(f)
  expect(f.cropRect[3]).toBe(83)
})

it.each(['missing witness', 'competing compound', 'distant baseline', 'native separator'])(
  'retains an unwitnessed source wrap: %s',
  (variant) => {
    const f = textFrame(3, false, false, true)
    if (variant === 'missing witness') f.pageItems = f.pageItems.filter((i) => i.baseline !== 125)
    if (variant === 'competing compound') f.pageItems.push(source('wrap-ped', 5, 155))
    if (variant === 'distant baseline') {
      const tail = f.table.cells.find((c) => c.row === 1 && c.column === 2)!.sourceTokens![1]
      tail.baseline += 10
      tail.rect[1] += 10
      tail.rect[3] += 10
    }
    if (variant === 'native separator') f.rules.push([120, 50, 180, 50])
    trim(f)
    expect(f.cropRect[3]).toBe(83)
  }
)
it.each([
  'no native items',
  'missing opening',
  'missing divider',
  'missing closing',
  'competing closing',
  'foreign source',
  'caption literal mismatch',
  'caption baseline above closing',
  'unassigned source',
  'incomplete record'
])('keeps the legacy crop without complete frame ownership: %s', (variant) => {
  const f = setup(true)
  if (variant === 'no native items') f.pageItems = []
  if (variant === 'missing opening') f.rules.shift()
  if (variant === 'missing divider') f.rules.splice(1, 1)
  if (variant === 'missing closing') f.rules.pop()
  if (variant === 'competing closing') f.rules.push([0, 100.1, 240, 100.1])
  if (variant === 'foreign source') f.pageItems.push(source('Foreign', 70, 96))
  if (variant === 'caption literal mismatch') f.caption.lines[0] += ' extra'
  if (variant === 'caption baseline above closing') f.pageItems.at(-1)!.baseline = 99
  if (variant === 'unassigned source') f.table.unassigned.push({})
  if (variant === 'incomplete record') f.table.grid[2][3] = ''
  trim(f)
  expect(f.cropRect[3]).toBe(97)
})

// The source footer is visually adjacent, but its public note ownership is
// intentionally unchanged. Native font descent supplies the final ink edge.
const unresolvedVisualFooter = (references = false): ReturnType<typeof setup> => {
  const left = references ? 126.885 : 73.446,
    right = references ? 766.0275018310547 : 450.03450860595706,
    h = 13.4496,
    baselines = references ? [171.666, 223.3065, 294.237] : [174.6, 209.76, 263.9265],
    edges = references ? [155.3805, 179.5455, 302.115] : [158.6025, 182.7735, 272.0565],
    pageItems: Item[] = [],
    cells: ReturnType<typeof setup>['table']['cells'] = [],
    grid = [
      ['Treatment', 'Leaf A', 'Leaf B'],
      ['Record A', 'Value A', 'Value B'],
      ['Record B', 'Value C', 'Value D']
    ]
  for (const [row, texts] of grid.entries())
    for (const [column, text] of texts.entries()) {
      const x = column === 2 ? right - 40 : left + (column * (right - left)) / 3,
        item = {
          text,
          rect: [x, baselines[row] - h, x + 40, baselines[row]],
          baseline: baselines[row],
          height: h,
          horizontal: true
        }
      pageItems.push(item)
      cells.push({
        row,
        column,
        rowSpan: 1,
        colSpan: 1,
        text,
        rect: [...item.rect],
        sourceRects: [item.rect],
        sourceTokens: [item]
      })
    }
  const footer = references
      ? [
          {
            text: 'References: Native comparison: 0.748',
            rect: [left, 304.7259, 303.007512, 318.1755],
            baseline: 318.1755,
            height: h,
            horizontal: true
          },
          {
            text: 'Direct comparison: 0.828',
            rect: [319.819512, 304.7259, 483.2456016, 318.1755],
            baseline: 318.1755,
            height: h,
            horizontal: true
          }
        ]
      : [
          {
            text: 'All treatments use the same observed records',
            rect: [77.2125, 272.3163, 446.265996, 282.777],
            baseline: 282.777,
            height: 10.4607,
            horizontal: true
          },
          {
            text: 'and produce identical estimates and intervals.',
            rect: [77.2125, 284.2713, 272.7648258, 294.732],
            baseline: 294.732,
            height: 10.4607,
            horizontal: true
          }
        ],
    captionItem = {
      text: 'Table 1. Source-owned descriptive records.',
      rect: references ? [91.4295, 138.74535, 803.208098664, 150.7005] : [73.446, 128, 430, 140],
      baseline: references ? 150.7005 : 140,
      height: references ? 11.95515 : 12,
      horizontal: true
    },
    cropRect = references ? [116, 152.2005, 752, 316] : [63, 152, 458, 278],
    rules = edges.map((y) => [left, y, right, y]),
    contentRect = [left, baselines[0] - h, right - 1, baselines.at(-1)!]
  if (references) rules.push([left, 326.2785, right, 326.2785])
  pageItems.push(...footer, captionItem, {
    text: 'A separate following paragraph.',
    rect: [left, references ? 356.7636 : 325.8951, right, references ? 371.7075 : 340.839],
    baseline: references ? 371.7075 : 340.839,
    height: 14.9439,
    horizontal: true
  })
  return {
    table: {
      cropRect: [...cropRect],
      grid,
      columns: [],
      cells,
      unassigned: references ? footer.map((i) => i.text) : [footer[0].text]
    },
    cropRect,
    caption: { page: 1, lines: [captionItem.text], rect: [...captionItem.rect] },
    contentRect,
    rules,
    rulePaintBounds: new Map(
      rules.map((rule, n) => [
        rule.join(','),
        [
          left,
          rule[1] - (n === 1 || (n === 2 && references) ? 0.3735 : 0.59775),
          right,
          rule[1] + (n === 1 || (n === 2 && references) ? 0.3735 : 0.59775)
        ]
      ])
    ),
    pageItems,
    pageFontItems: pageItems.map((i) => ({
      ...structuredClone(i),
      fontDescent: i === captionItem ? (references ? -0.218 : -0.216) : -0.216
    })),
    noteOwnerRects: [contentRect],
    pageNumber: 1,
    scale: 1
  }
}

it('retains the complete two-line visual footer and native descenders without assigning a note', () => {
  const f = unresolvedVisualFooter(),
    before = structuredClone(f)
  trim(f)
  expect(f.cropRect).toEqual([63, 152, 458, 297.49151120000005])
  expect({ ...f, cropRect: before.cropRect }).toEqual(before)
})

it('excludes the separate References band and caption descent while retaining all native body rule endpoints', () => {
  const f = unresolvedVisualFooter(true),
    before = structuredClone(f)
  trim(f)
  expect(f.cropRect).toEqual([116, 154.04473635, 766.0275018310547, 302.615])
  expect({ ...f, cropRect: before.cropRect }).toEqual(before)
})

it.each([false, true])(
  'requires unique complete native source before changing an unresolved visual footer (References=%s)',
  (references) => {
    const variants = [
      'missing opening',
      'missing divider',
      'missing closing',
      'missing paint',
      'competing divider',
      'missing font items',
      'missing recipient',
      'competing recipient',
      'foreign recipient',
      'missing body font',
      'duplicate body font',
      'missing footer font',
      'duplicate footer font',
      'wrong footer font baseline',
      'invalid footer descent',
      'missing caption font',
      'wrong body font baseline',
      'wrong body font height',
      'competing body font baseline',
      'competing footer font height',
      'missing source owner',
      'duplicate source owner',
      'incomplete cell',
      'cell literal mismatch',
      'spanning leaf',
      'duplicate cell slot',
      'foreign body',
      'foreign footer corridor',
      'missing terminal line',
      'duplicate footer',
      'foreign unassigned literal',
      'cross-page caption'
    ]
    for (const variant of variants) {
      const f = unresolvedVisualFooter(references),
        footer = f.pageItems.filter(
          (i) => i.baseline === 282.777 || i.baseline === 294.732 || i.baseline === 318.1755
        ),
        removeFont = (item: Item): void => {
          f.pageFontItems = f.pageFontItems!.filter((i) => i.text !== item.text)
        }
      if (variant === 'missing opening') f.rules.shift()
      if (variant === 'missing divider') f.rules.splice(1, 1)
      if (variant === 'missing closing') f.rules.splice(2, 1)
      if (variant === 'missing paint') f.rulePaintBounds!.delete(f.rules[2].join(','))
      if (variant === 'competing divider')
        f.rules.push([f.rules[1][0], f.rules[1][1] + 1, f.rules[1][2], f.rules[1][3] + 1])
      if (variant === 'missing font items') f.pageFontItems = []
      if (variant === 'missing recipient') f.noteOwnerRects = []
      if (variant === 'competing recipient') f.noteOwnerRects!.push([...f.contentRect])
      if (variant === 'foreign recipient')
        f.noteOwnerRects![0] = f.contentRect.map((v, n) => (n === 1 ? v + 1 : v))
      if (variant === 'missing body font') removeFont(f.pageItems[0])
      if (variant === 'duplicate body font')
        f.pageFontItems!.push(structuredClone(f.pageFontItems![0]))
      if (variant === 'missing footer font') removeFont(footer[1])
      if (variant === 'duplicate footer font')
        f.pageFontItems!.push(
          structuredClone(f.pageFontItems!.find((i) => i.text === footer[0].text)!)
        )
      if (variant === 'wrong footer font baseline')
        f.pageFontItems!.find((i) => i.text === footer[0].text)!.baseline += 1
      if (variant === 'invalid footer descent')
        f.pageFontItems!.find((i) => i.text === footer[0].text)!.fontDescent = NaN
      if (variant === 'missing caption font')
        removeFont(f.pageItems.find((i) => i.text === f.caption.lines[0])!)
      if (variant === 'wrong body font baseline') f.pageFontItems![0].baseline += 1
      if (variant === 'wrong body font height') f.pageFontItems![0].height += 1
      if (variant === 'competing body font baseline')
        f.pageFontItems!.push({
          ...structuredClone(f.pageFontItems![0]),
          baseline: f.pageFontItems![0].baseline + 1
        })
      if (variant === 'competing footer font height') {
        const item = f.pageFontItems!.find((i) => i.text === footer[0].text)!
        f.pageFontItems!.push({ ...structuredClone(item), height: item.height + 1 })
      }
      if (variant === 'missing source owner') f.pageItems.shift()
      if (variant === 'duplicate source owner') f.pageItems.push(structuredClone(f.pageItems[0]))
      if (variant === 'incomplete cell') f.table.cells.shift()
      if (variant === 'cell literal mismatch') f.table.cells[0].text = 'Foreign'
      if (variant === 'spanning leaf') f.table.cells[0].colSpan = 2
      if (variant === 'duplicate cell slot') f.table.cells[0].column = 1
      if (variant === 'foreign body')
        f.pageItems.push({ ...source('Foreign', f.rules[0][0] + 1, 220), horizontal: false })
      if (variant === 'foreign footer corridor')
        f.pageItems.push({
          ...source('Foreign', f.rules[0][0] + 1, f.rules[2][1] + 5),
          horizontal: false
        })
      if (variant === 'missing terminal line')
        f.pageItems = f.pageItems.filter((i) => i !== footer[1])
      if (variant === 'duplicate footer') f.pageItems.push(structuredClone(footer[0]))
      if (variant === 'foreign unassigned literal') f.table.unassigned.push('Foreign')
      if (variant === 'cross-page caption') f.caption.page++
      const legacy = structuredClone(f),
        before = structuredClone(f)
      legacy.pageFontItems = []
      trim(legacy)
      trim(f)
      expect(f.cropRect, variant).toEqual(legacy.cropRect)
      expect({ ...f, cropRect: before.cropRect }, variant).toEqual(before)
    }
  }
)

it.each([
  'ordinary footer font',
  'missing terminal punctuation',
  'nearby prose',
  'foreign caption descent'
])(
  'retains the original two-line crop without a complete small-font visual band: %s',
  (variant) => {
    const f = unresolvedVisualFooter(),
      before = [...f.cropRect]
    if (variant === 'ordinary footer font') {
      const item = f.pageItems.find((i) => i.baseline === 294.732)!
      item.height = 13.4496
      item.rect[1] = item.baseline - item.height
    }
    if (variant === 'missing terminal punctuation')
      f.pageItems.find((i) => i.baseline === 294.732)!.text = 'Incomplete footer'
    if (variant === 'nearby prose') f.pageItems.push(source('Foreign paragraph', 74, 309))
    if (variant === 'foreign caption descent') {
      const item = source('Foreign preceding text', 75, 148)
      f.pageItems.push(item)
      f.pageFontItems!.push({ ...item, fontDescent: -0.8 })
    }
    trim(f)
    expect(f.cropRect).toEqual(before)
  }
)

it.each([
  'missing outer closing',
  'missing outer paint',
  'unlabelled band',
  'foreign side strip',
  'owned body descent crosses closing'
])(
  'retains the original References crop when complete native ink ownership fails: %s',
  (variant) => {
    const f = unresolvedVisualFooter(true),
      before = [...f.cropRect]
    if (variant === 'missing outer closing') f.rules.pop()
    if (variant === 'missing outer paint') f.rulePaintBounds!.delete(f.rules.at(-1)!.join(','))
    if (variant === 'unlabelled band') {
      const item = f.pageItems.find((i) => i.text.startsWith('References:'))!
      item.text = item.text.replace('References:', 'Discussion:')
      f.table.unassigned[0] = item.text
      f.pageFontItems!.find((i) => i.text.startsWith('References:'))!.text = item.text
    }
    if (variant === 'foreign side strip')
      f.pageItems.push(source('Foreign adjacent column', 753, 240))
    if (variant === 'owned body descent crosses closing')
      f.pageFontItems!.find((i) => i.text === 'Value D')!.fontDescent = -0.8
    trim(f)
    expect(f.cropRect).toEqual(before)
  }
)

it.each([false, true])(
  'preserves native source/recipient permutation for a proved visual footer (References=%s)',
  (references) => {
    const f = unresolvedVisualFooter(references),
      original = structuredClone(f)
    f.pageItems.reverse()
    f.pageFontItems!.reverse()
    f.table.cells.reverse()
    trim(original)
    const before = structuredClone(f)
    trim(f)
    expect(f.cropRect).toEqual(original.cropRect)
    expect({ ...f, cropRect: before.cropRect }).toEqual(before)
  }
)

it.each([false, true])(
  'preserves independently partitioned header words without changing cell owners (References=%s)',
  (references) => {
    const f = unresolvedVisualFooter(references),
      cell = f.table.cells[1],
      parent = cell.sourceTokens![0],
      first = {
        ...parent,
        text: 'Leaf',
        sourceToken: structuredClone(parent),
        rect: [parent.rect[0], parent.rect[1], parent.rect[0] + 20, parent.rect[3]]
      },
      second = {
        ...parent,
        text: 'A',
        sourceToken: structuredClone(parent),
        rect: [parent.rect[0] + 25, parent.rect[1], parent.rect[2], parent.rect[3]]
      }
    cell.sourceTokens = [first, second]
    cell.sourceRects = [first.rect, second.rect]
    const before = structuredClone(f),
      expected = structuredClone(unresolvedVisualFooter(references))
    trim(expected)
    trim(f)
    expect(f.cropRect).toEqual(expected.cropRect)
    expect({ ...f, cropRect: before.cropRect }).toEqual(before)
  }
)

it.each([false, true])(
  'retains a valid smaller native descent and complete measured top/side envelopes (References=%s)',
  (references) => {
    const f = unresolvedVisualFooter(references),
      expected = structuredClone(f)
    for (const item of f.pageFontItems!.filter((i) =>
      f.table.cells.some((c) => c.sourceTokens!.some((t) => t.text === i.text))
    ))
      item.fontDescent = -0.1
    const before = structuredClone(f)
    trim(expected)
    trim(f)
    expect(f.cropRect).toEqual(expected.cropRect)
    expect({ ...f, cropRect: before.cropRect }).toEqual(before)
  }
)
