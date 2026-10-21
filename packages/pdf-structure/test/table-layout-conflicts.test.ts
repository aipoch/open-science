import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
const { reviewFinalNativeTableSources } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-source-integrity.mjs')).href
)
const { nativeTableLayoutConflicts: conflicts } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-layout-conflicts.mjs')).href
)
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function fixture() {
  type Source = { pageNumber: number; index: number; text: string }
  type Font = {
    text: string
    horizontal: boolean
    height: number
    baseline: number
    rect: number[]
    sourceItem: Source
  }
  type Cell = {
    row: number
    column: number
    rowSpan: number
    colSpan: number
    text: string
    sourceItems: Source[]
    sourceRects: number[][]
    sourceSegments?: (Source & { start: number; end: number; rect: number[] })[]
  }
  const tokens: Font[] = [],
    cells: Cell[] = []
  const add = (
    row: number,
    column: number,
    runs: [string, number, number, number?, number?][],
    colSpan = 1
  ): Cell => {
    const fonts = runs.map(([text, x, y, width = 20, height = 10]) => {
      const f = {
        text,
        horizontal: true,
        height,
        baseline: y,
        rect: [x, y - height, x + width, y],
        sourceItem: { pageNumber: 1, index: tokens.length, text }
      }
      tokens.push(f)
      return f
    })
    const cell = {
      row,
      column,
      rowSpan: 1,
      colSpan,
      text: fonts.map((f) => f.text).join(' '),
      sourceItems: fonts.map((f) => f.sourceItem),
      sourceRects: fonts.map((f) => f.rect)
    }
    cells.push(cell)
    return cell
  }
  return {
    tokens,
    cells,
    add,
    table: () => ({
      cropRect: [0, 0, 400, 400],
      grid: Array.from({ length: 8 }, () => Array(8).fill('')),
      cells
    })
  }
}

it('rejects a missing native heading between a parent and ruled leaf headers', () => {
  const f = fixture()
  f.add(0, 2, [
    ['Outcome:', 100, 25, 55],
    ['(2)', 120, 55, 15]
  ])
  f.add(0, 1, [['(1)', 60, 55, 15]])
  f.add(0, 3, [['(3)', 180, 55, 15]])
  const missing = f.add(0, 4, [['Measured response', 60, 40, 135]])
  f.cells.pop()
  for (let row = 1; row <= 3; row++)
    for (let col = 1; col <= 3; col++) f.add(row, col, [['1', col * 60, 65 + row * 15]])
  const table = { ...f.table(), unassigned: [missing.text] }
  const rules = [
    [40, 10, 220, 10],
    [40, 60, 220, 60]
  ]
  expect(conflicts(table, f.tokens, rules)).toContain('unassigned-parent-header-band')
  expect(conflicts({ ...table, unassigned: [] }, f.tokens, rules)).not.toContain(
    'unassigned-parent-header-band'
  )
  expect(conflicts(table, f.tokens, [])).not.toContain('unassigned-parent-header-band')
})

it('rejects separately headed numeric lanes collapsed into one leaf column', () => {
  const f = fixture()
  f.add(0, 0, [['Label', 10, 25]])
  f.add(0, 1, [
    ['Mean', 100, 25, 25],
    ['Rate', 165, 25, 25]
  ])
  for (let row = 1; row <= 4; row++) {
    f.add(row, 0, [['Group', 10, 40 + row * 15]])
    f.add(row, 1, [
      ['1.2', 100, 40 + row * 15, 25],
      ['8.4', 165, 40 + row * 15, 25]
    ])
  }
  const rules = [
    [0, 10, 210, 10],
    [0, 35, 210, 35],
    [0, 115, 210, 115]
  ]
  expect(conflicts(f.table(), f.tokens, rules)).toContain('independent-numeric-lanes-in-leaf')
  expect(conflicts(f.table(), f.tokens, [])).not.toContain('independent-numeric-lanes-in-leaf')
  f.cells[1].text = 'Mean and rate'
  expect(conflicts(f.table(), f.tokens, rules)).not.toContain('independent-numeric-lanes-in-leaf')
})

it('retains an ambiguous centered group value instead of inventing its missing row span', () => {
  const f = fixture()
  f.add(1, 0, [['Class', 10, 70, 25]]).rowSpan = 3
  for (const col of [1, 2])
    for (const row of [1, 2, 3]) f.add(row, col, row === 2 ? [['8', col * 55, 70, 15]] : [])
  for (const row of [1, 2, 3]) f.add(row, 3, [['2', 180, 40 + row * 15, 15]])
  const rules = [
    [0, 40, 220, 40],
    [0, 95, 220, 95]
  ]
  expect(conflicts(f.table(), f.tokens, rules)).toContain('centered-shared-value-missing-span')
  expect(conflicts(f.table(), f.tokens, [...rules, [0, 62, 220, 62]])).not.toContain(
    'centered-shared-value-missing-span'
  )
  f.cells.find((c) => c.row === 2 && c.column === 1)!.rowSpan = 3
  expect(conflicts(f.table(), f.tokens, rules)).not.toContain('centered-shared-value-missing-span')
})

it('does not map a captionless numbered derivation and its connective prose as table cells', () => {
  const f = fixture()
  f.add(0, 0, [['A = B', 80, 30, 50]])
  f.add(0, 2, [['(Q4)', 250, 30, 25]])
  f.add(1, 0, [['When all conditions hold we obtain', 20, 55, 180]])
  f.add(2, 0, [['B = C', 80, 80, 50]])
  f.add(2, 2, [['(Q5)', 250, 80, 25]])
  const table = {
    ...f.table(),
    grid: [
      ['A = B', '', '(Q4)'],
      ['prose', '', ''],
      ['B = C', '', '(Q5)']
    ]
  }
  expect(conflicts(table, f.tokens, [])).toContain('numbered-derivation-mapped-as-table')
  expect(conflicts({ ...table, caption: { text: 'Table 1' } }, f.tokens, [])).not.toContain(
    'numbered-derivation-mapped-as-table'
  )
  expect(conflicts(table, f.tokens, [[0, 15, 280, 15]])).not.toContain(
    'numbered-derivation-mapped-as-table'
  )
})

it('rejects an unmeasured split that creates an unheaded stub column', () => {
  const f = fixture()
  f.add(0, 0, [['Name', 10, 25, 30]])
  f.add(0, 2, [['Score', 100, 25, 30]])
  f.add(1, 0, [['First kind', 10, 50, 60]])
  f.add(2, 0, [['Other kind', 10, 70, 60]])
  const split = f.add(3, 0, [['Variant 4', 10, 90, 60]])
  const parent = split.sourceItems[0]
  split.text = 'Variant'
  split.sourceRects = [[10, 80, 45, 90]]
  f.cells.push({ ...split, column: 1, text: '4', sourceRects: [[45, 80, 70, 90]] })
  for (let row = 1; row <= 3; row++) f.add(row, 2, [['2', 100, 30 + row * 20, 20]])
  const rules = [
    [0, 10, 140, 10],
    [0, 35, 140, 35],
    [0, 105, 140, 105]
  ]
  expect(conflicts(f.table(), f.tokens, rules)).toContain('unmeasured-source-creates-stub-column')
  const changed = structuredClone(f.tokens)
  changed.find((t) => t.sourceItem.index === parent.index)!.sourceItem.text =
    'Different native value'
  expect(conflicts(f.table(), changed, rules)).not.toContain(
    'unmeasured-source-creates-stub-column'
  )
  split.sourceSegments = [{ ...parent, start: 0, end: 7, rect: [10, 80, 45, 90] }]
  expect(conflicts(f.table(), f.tokens, rules)).not.toContain(
    'unmeasured-source-creates-stub-column'
  )
})

it('retains original cells but rejects two numeric lanes collapsing independently labelled records', () => {
  const f = fixture()
  for (const row of [1, 2]) {
    const y = 4 + row * 36
    f.add(row, 0, [['Group', 10, y + 6, 25]])
    f.add(row, 1, [
      ['First', 50, y, 25],
      ['Second', 50, y + 12, 25]
    ])
    f.add(row, 2, [
      ['1', 100, y],
      ['2', 100, y + 12]
    ])
    f.add(row, 3, [
      ['3', 150, y],
      ['4', 150, y + 12]
    ])
  }
  const rules = [25, 60, 95].map((y) => [0, y, 180, y])
  const t = f.table(),
    before = structuredClone(t)
  const out = reviewFinalNativeTableSources(t, f.tokens, rules)
  expect(out.issues).toContain('native-table-structure-ambiguous')
  expect(out.cells).toEqual(before.cells)
  expect(out.grid).toEqual(before.grid)
  expect(t).toEqual(before)
  expect(conflicts(t, f.tokens, [])).not.toContain('labelled-numeric-records-collapsed')
  f.cells
    .filter((c) => c.column === 1)
    .forEach((c) => {
      c.rowSpan = 2
    })
  expect(conflicts(t, f.tokens, rules)).not.toContain('labelled-numeric-records-collapsed')
})

it('requires a top group span to contain its two independently ruled child groups', () => {
  const f = fixture()
  f.add(0, 2, [['Combined', 95, 20, 50]])
  f.add(1, 1, [['Left', 50, 40, 25]], 2)
  f.add(1, 3, [['Right', 155, 40, 25]], 2)
  for (const row of [2, 3])
    for (let col = 1; col <= 4; col++)
      f.add(row, col, [[String(col), 20 + col * 40, 40 + row * 20, 10]])
  const rules = [
    [45, 25, 200, 25],
    [45, 45, 115, 45],
    [135, 45, 200, 45]
  ]
  expect(conflicts(f.table(), f.tokens, rules)).toContain('native-parent-group-span')
  expect(conflicts(f.table(), f.tokens, rules.slice(1))).not.toContain('native-parent-group-span')
  f.cells[0].column = 1
  f.cells[0].colSpan = 4
  expect(conflicts(f.table(), f.tokens, rules)).not.toContain('native-parent-group-span')
})

it('flags an unassigned unknown native atom closing an owned formula gap without decoding it', () => {
  const f = fixture()
  f.add(1, 1, [
    ['a=', 40, 50, 20],
    ['x', 65, 50, 10]
  ])
  f.tokens[1].sourceItem.index = 2
  f.tokens.push({
    text: '\0',
    sourceItem: { pageNumber: 1, index: 1, text: '\0' },
    rect: [60, 32, 65, 42],
    height: 10,
    baseline: 42,
    horizontal: true
  })
  const t = { ...f.table(), unassigned: ['\0'] }
  expect(conflicts(t, f.tokens, [])).toContain('unassigned-native-formula-atom')
  f.tokens[2].rect = [200, 32, 205, 42]
  expect(conflicts(t, f.tokens, [])).not.toContain('unassigned-native-formula-atom')
})

it.each(['leading', 'trailing'])(
  'rejects a separately headed %s lane merged with prose',
  (side) => {
    const f = fixture(),
      leading = side === 'leading',
      col = leading ? 0 : 7
    f.add(0, col, [
      ['Code', 10, 20, 20],
      ['Description', 60, 20, 60]
    ])
    for (let row = 1; row <= 3; row++) {
      const y = 20 + row * 30
      f.add(
        row,
        col,
        leading
          ? [
              [String(row), 10, y, 10],
              ['Alpha', 60, y, 30],
              ['Beta', 60, y + 12, 30]
            ]
          : [
              ['Alpha', 10, y, 30],
              ['Beta', 10, y + 12, 30],
              ['0', 110, y, 10]
            ]
      )
      f.add(row, leading ? 1 : 6, [['Peer', 200, y, 20]])
    }
    const rules = [[0, 25, 250, 25]]
    expect(conflicts(f.table(), f.tokens, rules)).toContain('independent-headed-native-lane')
    expect(conflicts(f.table(), f.tokens, [])).not.toContain('independent-headed-native-lane')
    f.cells[0].sourceItems = []
    expect(conflicts(f.table(), f.tokens, rules)).not.toContain('independent-headed-native-lane')
  }
)

it('rejects whole adjacent values crossing a repeatedly empty, independently headed column', () => {
  const f = fixture()
  f.add(0, 0, [['Name', 10, 20, 25]])
  f.add(0, 1, [['Count', 70, 20, 25]])
  f.add(0, 2, [['Value', 120, 20, 35]])
  for (let row = 1; row <= 3; row++) {
    f.add(row, 0, [['Row', 10, 20 + row * 20, 25]])
    f.add(row, 1, [])
    f.add(row, 2, [['100 1-9', 65, 20 + row * 20, 90]])
  }
  const rules = [[0, 25, 180, 25]]
  expect(conflicts(f.table(), f.tokens, rules)).toContain('native-run-crosses-empty-leaf')
  f.cells
    .filter((c) => c.row > 0 && c.column === 2)
    .forEach((c) => {
      c.column = 1
      c.colSpan = 2
    })
  expect(conflicts(f.table(), f.tokens, rules)).not.toContain('native-run-crosses-empty-leaf')
})

it('rejects a touching mathematical group split between independently labelled header leaves', () => {
  const f = fixture()
  f.add(0, 1, [
    ['10', 80, 20, 12],
    ['A', 70, 40, 10]
  ])
  f.add(0, 2, [
    ['x', 92, 20, 10],
    ['B', 110, 40, 10]
  ])
  for (const row of [1, 2]) {
    f.add(row, 1, [['1', 70, 40 + row * 20, 10]])
    f.add(row, 2, [['2', 110, 40 + row * 20, 10]])
  }
  expect(conflicts(f.table(), f.tokens, [[0, 45, 200, 45]])).toContain('native-math-group-split')
  f.cells[0].colSpan = 2
  expect(conflicts(f.table(), f.tokens, [[0, 45, 200, 45]])).not.toContain(
    'native-math-group-split'
  )
})

it('rejects an unmeasured leaf header crossing independently printed header groups', () => {
  const f = fixture()
  f.add(1, 2, [['One Two Three', 105, 45, 180]])
  for (const row of [2, 3]) {
    f.add(row, 1, [['12', 110, 30 + row * 20]])
    f.add(row, 2, [['34', 180, 30 + row * 20]])
    f.add(row, 3, [['56', 250, 30 + row * 20]])
  }
  const rules = [
    [100, 30, 140, 30],
    [150, 30, 300, 30]
  ]
  expect(conflicts(f.table(), f.tokens, rules)).toContain('native-header-crosses-printed-groups')
  f.cells[0].colSpan = 3
  expect(conflicts(f.table(), f.tokens, rules)).not.toContain(
    'native-header-crosses-printed-groups'
  )
})

it('rejects a wide first header represented as a section over independently aligned fields', () => {
  const f = fixture()
  f.add(
    0,
    0,
    [
      ['Field', 10, 20, 30],
      ['Mode Score Count', 90, 20, 210]
    ],
    4
  )
  for (const row of [1, 2]) {
    f.add(row, 0, [['Label', 10, 20 + row * 20, 35]])
    f.add(row, 1, [['yes', 90, 20 + row * 20, 20]])
    f.add(row, 2, [['1.2', 190, 20 + row * 20, 20]])
    f.add(row, 3, [['2.3', 270, 20 + row * 20, 20]])
  }
  expect(conflicts(f.table(), f.tokens, [[0, 25, 320, 25]])).toContain(
    'native-leaf-header-collapsed-to-section'
  )
  f.cells[0].sourceItems = [f.cells[0].sourceItems[0]]
  f.cells[0].sourceRects = [f.cells[0].sourceRects[0]]
  f.cells[0].text = 'Field'
  expect(conflicts(f.table(), f.tokens, [[0, 25, 320, 25]])).not.toContain(
    'native-leaf-header-collapsed-to-section'
  )
})

it('rejects two record rows inside one closed printed face after complete peer faces', () => {
  const f = fixture()
  for (const row of [1, 2, 3])
    for (const col of [0, 1, 2, 3])
      f.add(row, col, [[col < 2 ? 'Key' : 'Long field', 10 + col * 100, 15 + row * 30, 50]])
  f.add(4, 2, [['tail', 210, 115, 25]])
  f.add(4, 3, [['tail', 310, 115, 25]])
  const rules = [30, 60, 90, 120].map((y) => [0, y, 400, y])
  for (const x of [0, 100, 200, 300, 400])
    for (const y of [30, 60, 90]) rules.push([x, y, x, y + 30])
  expect(conflicts(f.table(), f.tokens, rules)).toContain('closed-record-face-split-across-rows')
  rules.push([0, 110, 400, 110])
  expect(conflicts(f.table(), f.tokens, rules)).not.toContain(
    'closed-record-face-split-across-rows'
  )
})

it('rejects a centered native multiline stub split into staggered record rows', () => {
  const f = fixture()
  f.add(1, 0, [['Allowed', 10, 60]])
  f.add(2, 0, [['values', 10, 80]])
  for (const col of [1, 2, 3])
    for (const row of [1, 2, 3]) f.add(row, col, [['value', 80 + col * 60, 30 + row * 20]])
  const rules = [[0, 35, 320, 35]]
  expect(conflicts(f.table(), f.tokens, rules)).toContain('staggered-native-stub-records')
  for (const p of f.tokens.slice(0, 2)) {
    p.baseline -= 10
    p.rect[1] -= 10
    p.rect[3] -= 10
  }
  expect(conflicts(f.table(), f.tokens, rules)).not.toContain('staggered-native-stub-records')
})

it('rejects a clipped native header above three printed column separators without rejecting prose outside them', () => {
  const f = fixture()
  for (const row of [0, 1])
    for (const col of [0, 1, 2]) f.add(row, col, [['12', 20 + col * 100, 60 + row * 25]])
  const heads = [0, 1, 2].map((col) => f.add(7, col, [['Header', 20 + col * 100, 30, 25]]))
  f.cells.splice(6)
  const table = {
    ...f.table(),
    cropRect: [0, 25, 300, 100],
    clipped: heads.map((c) => ({ text: c.text, rect: c.sourceRects[0] }))
  }
  const rules = [0, 1, 2].map((col) => [col * 100, 46, col * 100 + 90, 46])
  expect(conflicts(table, f.tokens, rules)).toContain('clipped-native-header-band')
  expect(
    conflicts({ ...table, clipped: table.clipped.slice(0, 1) }, f.tokens, rules)
  ).not.toContain('clipped-native-header-band')
})
it('rejects a repeated leaf sequence whose peer group spans it but its own group does not', () => {
  const f = fixture()
  f.add(0, 1, [['Group A', 30, 20, 50]])
  f.add(0, 3, [['Group B', 130, 20, 50]], 3)
  for (let col = 0; col < 6; col++)
    f.add(1, col, [[['X', 'Y', 'Z'][col % 3], 10 + col * 30 + (col > 2 ? 10 : 0), 40, 15]])
  expect(conflicts(f.table(), f.tokens)).toContain('inconsistent-grouped-header-span')
  f.cells[0].column = 0
  f.cells[0].colSpan = 3
  expect(conflicts(f.table(), f.tokens)).toEqual([])
})
it('requires identical peer leaf sequence and complete native source ownership', () => {
  const f = fixture()
  f.add(0, 1, [['Group A', 30, 20, 50]])
  f.add(0, 3, [['Group B', 130, 20, 50]], 3)
  for (let col = 0; col < 6; col++)
    f.add(1, col, [
      [['X', 'Y', 'Z', 'U', 'V', 'W'][col], 10 + col * 30 + (col > 2 ? 10 : 0), 40, 15]
    ])
  expect(conflicts(f.table(), f.tokens)).toEqual([])
})
it('rejects a single leaf cell crossing a repeated printed vertical divider', () => {
  const f = fixture()
  for (let row = 0; row < 4; row++)
    f.add(row, 0, [
      [String(row + 1), 10, 30 + row * 20],
      ['value', 70, 30 + row * 20]
    ])
  const rules = [[50, 15, 50, 100]]
  expect(conflicts(f.table(), f.tokens, rules)).toContain('printed-divider-inside-leaf-column')
  for (const c of f.cells) c.colSpan = 2
  expect(conflicts(f.table(), f.tokens, rules)).toEqual([])
})
it('does not infer a missing column from spaced values alone or one short divider', () => {
  const f = fixture()
  for (let row = 0; row < 4; row++)
    f.add(row, 0, [
      ['2', 10, 30 + row * 20],
      ['4', 70, 30 + row * 20]
    ])
  expect(conflicts(f.table(), f.tokens)).toEqual([])
  expect(conflicts(f.table(), f.tokens, [[50, 15, 50, 35]])).toEqual([])
})
it('rejects a ruled fraction denominator assigned to the following record', () => {
  const f = fixture()
  f.add(1, 0, [
    ['a', 10, 40, 6, 8],
    ['value', 20, 45, 20, 12]
  ])
  f.add(2, 0, [
    ['3', 10, 50, 6, 8],
    ['next', 10, 70, 20, 12]
  ])
  f.add(2, 1, [['12', 80, 70, 20, 12]])
  f.add(2, 2, [['15', 120, 70, 20, 12]])
  expect(conflicts(f.table(), f.tokens, [[9, 43, 17, 43]])).toContain('fraction-crosses-record-row')
  expect(conflicts(f.table(), f.tokens)).toEqual([])
  expect(conflicts(f.table(), f.tokens, [[0, 43, 180, 43]])).toEqual([])
})
it('rejects a complete horizontal header separator inside first-row cells', () => {
  const f = fixture()
  for (let col = 0; col < 3; col++)
    f.add(0, col, [
      ['Header', 10 + col * 60, 20],
      ['Body', 10 + col * 60, 45]
    ])
  expect(conflicts(f.table(), f.tokens, [[5, 30, 160, 30]])).toContain(
    'printed-header-rule-inside-row'
  )
  expect(conflicts(f.table(), f.tokens, [[5, 30, 40, 30]])).toEqual([])
})
it('rejects two stub continuations preceding independently aligned next records', () => {
  const f = fixture()
  f.add(1, 0, [
    ['Record', 10, 40],
    ['long', 10, 52]
  ])
  const tail1 = f.add(2, 0, [
    ['tail', 10, 64],
    ['Next', 10, 80],
    ['long', 10, 92]
  ])
  const tail2 = f.add(3, 0, [
    ['tail', 10, 104],
    ['Last', 10, 120]
  ])
  for (const row of [1, 2, 3])
    for (const col of [1, 2]) f.add(row, col, [['12', 80 + col * 30, row * 40]])
  const nativeOrder = [0, 1, 2, 5, 6, 7, 10, 3, 4, 8, 9, 11, 12]
  f.tokens.forEach((font, index) => {
    font.sourceItem.index = nativeOrder[index]
  })
  expect(conflicts(f.table(), f.tokens)).toContain('stub-continuation-crosses-record-row')
  const peerSources = f.cells.filter((c) => c.column > 0).flatMap((c) => c.sourceItems)
  peerSources.forEach((o) => {
    o.index += 100
  })
  expect(conflicts(f.table(), f.tokens)).toEqual([])
  peerSources.forEach((o) => {
    o.index -= 100
  })
  // Without contiguous native item ordering the geometry alone is not proof.
  tail1.sourceItems[0].index = 100
  tail2.sourceItems[0].index = 101
  expect(conflicts(f.table(), f.tokens)).toEqual([])
})
it('rejects a mixed full-parent and unmeasured partial-parent claim but permits measured segments', () => {
  const f = fixture()
  const a = f.add(0, 0, [
    ['4±', 10, 40],
    ['1 /', 30, 40, 30]
  ])
  a.text = '4±1'
  a.sourceRects[1] = [30, 30, 45, 40]
  f.cells.push({
    row: 0,
    column: 1,
    rowSpan: 1,
    colSpan: 1,
    text: '/',
    sourceItems: [f.tokens[1].sourceItem],
    sourceRects: [[45, 30, 60, 40]]
  })
  expect(conflicts(f.table(), f.tokens)).toContain('unmeasured-mixed-source-partition')
  a.sourceSegments = [{ ...f.tokens[1].sourceItem, start: 0, end: 1, rect: a.sourceRects[1] }]
  expect(conflicts(f.table(), f.tokens)).toEqual([])
})

it('does not use duplicate native identities or mismatched cell text as layout proof', () => {
  const f = fixture()
  for (let row = 0; row < 4; row++)
    f.add(row, 0, [
      [String(row + 1), 10, 30 + row * 20],
      ['value', 70, 30 + row * 20]
    ])
  const rules = [[50, 15, 50, 100]]
  const duplicate = f.tokens.map((t) => ({ ...t, sourceItem: { ...t.sourceItem } }))
  expect(conflicts(f.table(), [...f.tokens, ...duplicate], rules)).toEqual([])
  for (const c of f.cells) c.text = 'unrelated'
  expect(conflicts(f.table(), f.tokens, rules)).toEqual([])
})
it('rejects an unmeasured partial parent even when a raised complete peer precedes its native order', () => {
  const f = fixture()
  const cell = f.add(0, 0, [
    ['BASE', 10, 40, 25],
    ['q', 35, 36, 5, 8],
    ['First second', 50, 40, 60]
  ])
  cell.text = 'q BASE First'
  cell.sourceRects[2] = [50, 30, 75, 40]
  f.cells.push({
    row: 0,
    column: 1,
    rowSpan: 1,
    colSpan: 1,
    text: 'second',
    sourceItems: [f.tokens[2].sourceItem],
    sourceRects: [[80, 30, 110, 40]]
  })
  expect(conflicts(f.table(), f.tokens)).toContain('unmeasured-mixed-source-partition')
  cell.text = 'q BASE First q'
  expect(conflicts(f.table(), f.tokens)).not.toContain('unmeasured-mixed-source-partition')
  cell.text = 'q BASE First'
  expect(conflicts(f.table(), [...f.tokens, f.tokens[1]])).not.toContain(
    'unmeasured-mixed-source-partition'
  )
})
it('keeps legitimate single-parent sharing without inventing a segment range', () => {
  const f = fixture(),
    a = f.add(0, 0, [['3 /', 10, 40, 30]])
  a.text = '3'
  a.sourceRects[0] = [10, 30, 20, 40]
  f.cells.push({
    row: 0,
    column: 1,
    rowSpan: 1,
    colSpan: 1,
    text: '/',
    sourceItems: [f.tokens[0].sourceItem],
    sourceRects: [[20, 30, 40, 40]]
  })
  expect(conflicts(f.table(), f.tokens)).toEqual([])
})

it('rejects a raised native script serialized before its adjacent full-size base', () => {
  const f = fixture()
  const c = f.add(0, 0, [
    ['word', 10, 40, 30, 12],
    ['x', 50, 40, 8, 12],
    ['abc', 58, 34, 15, 8]
  ])
  c.text = 'abc word x'
  Object.assign(c, {
    sourceTokens: [f.tokens[2], f.tokens[0], f.tokens[1]].map((font) => ({
      text: font.text,
      rect: font.rect,
      baseline: font.baseline,
      height: font.height
    }))
  })
  expect(conflicts(f.table(), f.tokens)).toContain('native-script-precedes-base')
  c.text = 'word x abc'
  Object.assign(c, { sourceTokens: f.tokens })
  expect(conflicts(f.table(), f.tokens)).toEqual([])
})

it('rejects omitted point estimates above three owned intervals with intact peer records', () => {
  const f = fixture(),
    missing: string[] = []
  for (const col of [1, 2, 3]) {
    f.add(1, col, [
      ['2', col * 80 + 15, 40, 10],
      ['[1, 3]', col * 80, 55, 40]
    ])
    f.add(2, col, [['[2, 4]', col * 80, 95, 40]])
    const omitted = f.add(7, col, [[String(col + 2), col * 80 + 15, 80, 10]])
    missing.push(omitted.text)
    f.cells.pop()
  }
  expect(conflicts({ ...f.table(), unassigned: missing }, f.tokens)).toContain(
    'unassigned-point-estimate-above-interval'
  )
  expect(conflicts({ ...f.table(), unassigned: missing.slice(0, 1) }, f.tokens)).not.toContain(
    'unassigned-point-estimate-above-interval'
  )
  for (const c of f.cells.filter((c) => c.row === 1)) c.sourceSegments = []
  f.cells.splice(0, f.cells.length, ...f.cells.filter((c) => c.row !== 1))
  expect(conflicts({ ...f.table(), unassigned: missing }, f.tokens)).not.toContain(
    'unassigned-point-estimate-above-interval'
  )
})

it('rejects an omitted left header within a ruled header band and a repeated native stub lane', () => {
  const f = fixture()
  for (const col of [1, 2]) f.add(0, col, [['Header', 100 * col, 30, 30]])
  for (const row of [1, 2, 3]) {
    f.add(row, 0, [['long record name', 10, 50 + row * 20, 70]])
    for (const col of [1, 2]) f.add(row, col, [['12', col * 100, 50 + row * 20, 20]])
  }
  const omitted = f.add(7, 0, [['Kind', 10, 30, 20]])
  f.cells.pop()
  f.cells.push({
    row: 0,
    column: 0,
    rowSpan: 1,
    colSpan: 1,
    text: '',
    sourceItems: [],
    sourceRects: []
  })
  const table = { ...f.table(), unassigned: [omitted.text] }
  expect(
    conflicts(table, f.tokens, [
      [0, 15, 250, 15],
      [0, 40, 250, 40]
    ])
  ).toContain('unassigned-ruled-leaf-header')
  expect(conflicts(table, f.tokens, [[0, 40, 250, 40]])).not.toContain(
    'unassigned-ruled-leaf-header'
  )
})

it('rejects three omitted angled headings independently enclosed above native body columns', () => {
  const f = fixture(),
    missing: string[] = []
  for (let col = 0; col < 3; col++) {
    for (const row of [1, 2]) f.add(row, col, [['12', 30 + col * 70, 90 + row * 20, 10]])
    const header = f.add(7, col, [['Heading', 20 + col * 70, 70, 40, 40]])
    f.tokens.at(-1)!.horizontal = false
    f.tokens.at(-1)!.height = 10
    f.cells.pop()
    missing.push(header.text)
    f.cells.push({
      row: 0,
      column: col,
      rowSpan: 1,
      colSpan: 1,
      text: '',
      sourceItems: [],
      sourceRects: []
    })
  }
  const table = { ...f.table(), unassigned: missing }
  const rules = [
    [10, 20, 220, 20],
    [10, 80, 220, 80]
  ]
  expect(conflicts(table, f.tokens, rules)).toContain('unassigned-oriented-header-band')
  expect(conflicts(table, f.tokens, rules.slice(1))).not.toContain(
    'unassigned-oriented-header-band'
  )
})

it('rejects two omitted continuation lines between the same pair of complete native records', () => {
  const f = fixture(),
    missing: string[] = []
  for (const col of [1, 2]) {
    f.add(1, col, [['begin phrase', col * 100, 50, 80]])
    const tail = f.add(7, col, [['continued', col * 100, 65, 55]])
    f.cells.pop()
    missing.push(tail.text)
    f.add(2, col, [['next phrase', col * 100, 80, 80]])
  }
  expect(conflicts({ ...f.table(), unassigned: missing }, f.tokens)).toContain(
    'unassigned-interior-record-continuations'
  )
  f.cells.pop()
  expect(conflicts({ ...f.table(), unassigned: missing }, f.tokens)).not.toContain(
    'unassigned-interior-record-continuations'
  )
})

it('rejects a full native leaf header extending into an empty independently populated column', () => {
  const f = fixture()
  f.add(0, 1, [['Kind Count', 100, 30, 150]])
  f.cells.push({
    row: 0,
    column: 2,
    rowSpan: 1,
    colSpan: 1,
    text: '',
    sourceItems: [],
    sourceRects: []
  })
  for (const row of [1, 2]) {
    f.add(row, 1, [['category', 100, 50 + row * 20, 50]])
    f.add(row, 2, [['12', 220, 50 + row * 20, 20]])
  }
  expect(conflicts(f.table(), f.tokens, [[90, 40, 260, 40]])).toContain(
    'native-leaf-header-crosses-empty-column'
  )
  f.cells[0].colSpan = 2
  expect(conflicts(f.table(), f.tokens, [[90, 40, 260, 40]])).toEqual([])
})

it('rejects a repeated assignment heading whose identifier belongs to the preceding column', () => {
  const f = fixture()
  f.add(0, 1, [
    ['z', 80, 30, 5],
    ['=2', 87, 30, 15]
  ])
  f.add(0, 2, [
    ['z', 150, 30, 5],
    ['=4', 157, 30, 15],
    ['z', 220, 30, 5]
  ])
  f.add(0, 3, [['=6', 227, 30, 15]])
  for (const row of [1, 2])
    for (const col of [1, 2, 3]) f.add(row, col, [['3', 25 + col * 70, 50 + row * 20, 8]])
  expect(conflicts(f.table(), f.tokens)).toContain('native-assignment-header-crosses-column')
  f.cells[2].sourceItems.unshift(f.cells[1].sourceItems.pop()!)
  f.cells[2].sourceRects.unshift(f.cells[1].sourceRects.pop()!)
  f.cells[1].text = 'z =4'
  f.cells[2].text = 'z =6'
  expect(conflicts(f.table(), f.tokens)).toEqual([])
})

it('rejects centered column-major group labels split across middle records in repeated ruled bands', () => {
  const f = fixture()
  for (let band = 0; band < 2; band++) {
    const row = band * 4 + 1,
      y = 40 + band * 80
    f.add(row + 1, 0, [['Grouped', 10, y + 20, 40]])
    f.add(row + 2, 0, [['records', 10, y + 40, 40]])
    for (const r of [row, row + 3])
      f.cells.push({
        row: r,
        column: 0,
        rowSpan: 1,
        colSpan: 1,
        text: '',
        sourceItems: [],
        sourceRects: []
      })
    for (let i = 0; i < 4; i++)
      for (let col = 1; col < 4; col++) f.add(row + i, col, [['12', 80 * col, y + 20 * i, 20]])
  }
  const rules = [25, 105, 185].map((y) => [0, y, 280, y])
  expect(conflicts(f.table(), f.tokens, rules)).toContain('centered-group-stub-split-across-rows')
  for (const c of f.cells.filter((c) => c.column === 0 && c.text)) c.rowSpan = 4
  expect(conflicts(f.table(), f.tokens, rules)).not.toContain(
    'centered-group-stub-split-across-rows'
  )
})
it('rejects a native record prefix assigned after the preceding row numbers', () => {
  const f = fixture()
  f.add(1, 0, [['First record', 10, 50]])
  const wrong = f.add(1, 1, [
    ['Type', 80, 50],
    ['Size', 80, 69]
  ])
  f.add(1, 2, [['12', 160, 50]])
  f.add(1, 3, [['15', 220, 50]])
  const next = f.add(2, 0, [['Next record', 10, 80]])
  f.add(2, 1, [['Type', 80, 80]])
  f.add(2, 2, [['16', 160, 80]])
  f.add(2, 3, [['18', 220, 80]])
  // Native stream introduces the next record before its misassigned prefix.
  next.sourceItems[0].index = 40
  wrong.sourceItems[1].index = 41
  for (const c of f.cells.filter((c) => c.row === 2 && c.column > 0))
    for (const o of c.sourceItems) o.index += 50
  expect(conflicts(f.table(), f.tokens)).toContain('native-record-prefix-crosses-row')
  wrong.sourceItems[1].index = 39
  expect(conflicts(f.table(), f.tokens)).toEqual([])
})
it('rejects an unassigned native header prefix contiguous with its retained suffix', () => {
  const f = fixture()
  f.add(0, 0, [['Mean (%)', 10, 30, 60]])
  f.add(0, 1, [['Maximum', 100, 30, 50]])
  f.cells.pop()
  f.add(0, 1, [['(%)', 152, 30, 20]])
  f.add(0, 2, [['Count', 220, 30, 40]])
  expect(conflicts({ ...f.table(), unassigned: ['Maximum'] }, f.tokens)).toContain(
    'unassigned-contiguous-header'
  )
  expect(conflicts({ ...f.table(), unassigned: ['Footnote'] }, f.tokens)).toEqual([])
})
it('rejects a contiguous native header atom split into an otherwise empty extra row', () => {
  const f = fixture()
  f.add(0, 0, [['A', 10, 22, 10]])
  f.add(1, 0, [['Rate', 20, 30, 30]])
  f.add(1, 1, [['Other', 80, 30]])
  f.add(1, 2, [['Count', 140, 30]])
  expect(conflicts(f.table(), f.tokens)).toContain('inline-header-split-across-rows')
  f.cells[0].sourceRects[0][2] -= 5
  expect(conflicts(f.table(), f.tokens)).toEqual([])
})
it('rejects moving an inline mathematical operator before its native left context', () => {
  const f = fixture()
  const c = f.add(1, 1, [
    ['Expected value:', 10, 50, 90],
    ['∫', 105, 42, 8],
    ['f(x)', 116, 50, 30]
  ])
  c.text = '∫ Expected value: f(x)'
  expect(conflicts(f.table(), f.tokens)).toContain('native-inline-operator-order-conflict')
  c.text = 'Expected value: ∫ f(x)'
  expect(conflicts(f.table(), f.tokens)).toEqual([])
})
it('rejects two omitted repeated native records enclosed by the table rules', () => {
  const f = fixture()
  for (const [row, label] of ['Reference alpha', 'Reference beta'].entries()) {
    f.add(row, 0, [[label, 10, 30 + row * 15, 80]])
    f.add(row, 1, [['Score: 2', 120, 30 + row * 15, 50]])
    f.add(row, 2, [['Error: 3', 210, 30 + row * 15, 50]])
  }
  const count = f.cells.length
  for (const [row, label] of ['Reference alpha', 'Reference beta'].entries()) {
    f.add(row + 2, 0, [[label, 10, 90 + row * 15, 80]])
    f.add(row + 2, 1, [['Score: 4', 120, 90 + row * 15, 50]])
    f.add(row + 2, 2, [['Error: 5', 210, 90 + row * 15, 50]])
  }
  const unassigned = f.cells.splice(count).map((c) => c.text)
  const rules = [
    [5, 75, 280, 75],
    [5, 115, 280, 115]
  ]
  expect(conflicts({ ...f.table(), unassigned }, f.tokens, rules)).toContain(
    'omitted-repeated-native-records'
  )
  expect(conflicts({ ...f.table(), unassigned }, f.tokens, rules.slice(0, 1))).toEqual([])
})

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function omittedNumericRecord() {
  const f = fixture()
  for (const row of [1, 2, 3]) {
    f.add(row, 0, [[`Group ${row}`, 10, row * 30, 40]])
    for (const col of [1, 2, 3]) f.add(row, col, [[`${row}.${col}`, col * 80, row * 30]])
  }
  const missing = f.cells.splice(4, 4)
  return { ...f, missing, table: () => ({ ...f.table(), unassigned: missing.map((c) => c.text) }) }
}

it('rejects an omitted numeric record independently aligned between two owned body records', () => {
  const f = omittedNumericRecord()
  expect(conflicts(f.table(), f.tokens)).toContain('unassigned-interior-numeric-record')
  // Different widths remain valid when the same alignment is proved at both ends.
  f.tokens[9].rect[2] += 12
  expect(conflicts(f.table(), f.tokens)).toContain('unassigned-interior-numeric-record')
  f.cells.push(...f.missing)
  expect(conflicts(f.table(), f.tokens)).toEqual([])
})

it('does not infer omitted records from external notes, partial columns or ambiguous sources', () => {
  for (const variant of [
    'external',
    'two-columns',
    'misaligned',
    'duplicate',
    'segments',
    'no-stub'
  ]) {
    const f = omittedNumericRecord()
    if (variant === 'external')
      for (const token of f.tokens.slice(4, 8)) {
        token.baseline += 100
        token.rect[1] += 100
        token.rect[3] += 100
      }
    if (variant === 'two-columns') f.missing.pop()
    if (variant === 'misaligned') {
      f.tokens[7].rect[0] += 30
      f.tokens[7].rect[2] += 30
    }
    if (variant === 'duplicate') f.tokens.push({ ...f.tokens[7] })
    if (variant === 'segments') {
      const cell = f.cells[3]
      cell.sourceSegments = [
        { ...cell.sourceItems[0], start: 0, end: 1, rect: cell.sourceRects[0] }
      ]
    }
    if (variant === 'no-stub') f.missing.shift()
    expect(conflicts(f.table(), f.tokens), variant).toEqual([])
  }
})
