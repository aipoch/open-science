import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const regions = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-regions.mjs')).href
)

// The fixture's inferred shape keeps mutations in rejection cases type checked.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function example() {
  const tokens = ['Group', 'Score', 'Count', 'A', '12', '3', 'B', '24', '4'].map((text, index) => {
    const row = Math.floor(index / 3),
      column = index % 3
    return {
      text,
      horizontal: true,
      rect: [10 + column * 60, 30 + row * 20, 40 + column * 60, 40 + row * 20],
      sourceItem: { pageNumber: 1, index, text }
    }
  })
  const cells = tokens.map((token, index) => ({
    row: Math.floor(index / 3),
    column: index % 3,
    rowSpan: 1,
    colSpan: 1,
    text: token.text,
    sourceItems: [{ ...token.sourceItem }],
    sourceRects: [[...token.rect]]
  }))
  const caption = {
    page: 1,
    text: 'Table 1. Results',
    lines: ['Table 1. Results'],
    rect: [10, 10, 120, 20]
  }
  const complete = {
    id: 'complete',
    page: 1,
    cropRect: [5, 25, 170, 85],
    sourceViewport: { width: 200, height: 200 },
    grid: [
      ['Group', 'Score', 'Count'],
      ['A', '12', '3'],
      ['B', '24', '4']
    ],
    cells,
    issues: [],
    unassigned: [],
    thumbnail: 'complete.png'
  }
  const narrow = {
    ...complete,
    id: 'narrow',
    cropRect: [5, 25, 110, 85],
    caption,
    grid: complete.grid.map((row) => row.slice(0, 2)),
    cells: cells.filter((cell) => cell.column < 2).map((cell) => structuredClone(cell)),
    issues: ['text-crosses-crop-boundary'],
    thumbnail: 'narrow.png'
  }
  return { tokens, complete, narrow, caption }
}

it('keeps the complete source-owned table and its thumbnail while transferring the unique caption', () => {
  const { tokens, complete, narrow, caption } = example()
  const result = regions.deduplicateSourceOwnedTableSubsets([narrow, complete], tokens)
  expect(result).toEqual([{ ...complete, caption, repairs: ['source-owned-subset-deduplicated'] }])
  expect(result[0].caption).toBe(caption)
  expect(result[0].cells).toBe(complete.cells)
  expect(complete).not.toHaveProperty('caption')
})

it('removes only an equivalent whole-source candidate and preserves the captioned object intact', () => {
  const { tokens, complete, caption } = example()
  const captioned = { ...structuredClone(complete), id: 'captioned', caption }
  for (const candidates of [
    [complete, captioned],
    [captioned, complete]
  ]) {
    const result = regions.deduplicateSourceOwnedTableSubsets(candidates, tokens)
    expect(result).toEqual([captioned])
    expect(result[0]).toBe(captioned)
  }
})

it('removes a source-equivalent uncaptioned duplicate with an obsolete detector shape warning', () => {
  const { tokens, complete, caption } = example()
  const captioned = { ...structuredClone(complete), id: 'captioned', caption }
  const duplicate = { ...complete, issues: ['missing-row-or-column'] }
  for (const candidates of [
    [duplicate, captioned],
    [captioned, duplicate]
  ]) {
    const result = regions.deduplicateSourceOwnedTableSubsets(candidates, tokens)
    expect(result).toEqual([captioned])
    expect(result[0]).toBe(captioned)
  }
})

it('keeps source-equivalent candidates when the captioned owner still has a shape warning', () => {
  const { tokens, complete, caption } = example()
  const captioned = {
    ...structuredClone(complete),
    id: 'captioned',
    caption,
    issues: ['missing-row-or-column']
  }
  expect(regions.deduplicateSourceOwnedTableSubsets([complete, captioned], tokens)).toEqual([
    complete,
    captioned
  ])
})

it('removes measured word-rectangle duplicates only when their other caption survives on a disjoint table', () => {
  const { tokens, complete, caption } = example()
  tokens[0].text = tokens[0].sourceItem.text = 'Field name'
  complete.cells[0].text = complete.grid[0][0] = 'Field name'
  complete.cells[0].sourceItems[0].text = 'Field name'
  const retained = { ...complete, caption }
  const otherCaption = { ...caption, text: 'Table 2. Other', rect: [10, 100, 120, 110] }
  const duplicate = { ...structuredClone(complete), id: 'duplicate', caption: otherCaption }
  duplicate.cells[0].sourceRects = [
    [10, 30, 20, 40],
    [25, 30, 40, 40]
  ]
  const other = structuredClone(retained)
  other.id = 'other'
  other.caption = otherCaption
  other.cropRect = [5, 115, 170, 175]
  for (const c of other.cells) {
    c.sourceItems[0].index += 100
    c.sourceRects[0][1] += 90
    c.sourceRects[0][3] += 90
  }
  const inventory = [
    ...tokens,
    ...other.cells.map((c) => ({
      text: c.text,
      horizontal: true,
      rect: c.sourceRects[0],
      sourceItem: c.sourceItems[0]
    }))
  ]
  const measured = [
    {
      text: tokens[0].text,
      rect: tokens[0].rect,
      gaps: [{ index: 5, left: 20, right: 25 }]
    }
  ]
  const tables = [retained, duplicate, other]
  expect(regions.deduplicateSourceOwnedTableSubsets(tables, inventory, measured)).toEqual([
    retained,
    other
  ])
  expect(regions.deduplicateSourceOwnedTableSubsets(tables, inventory)).toEqual(tables)
  expect(regions.deduplicateSourceOwnedTableSubsets(tables.slice(0, 2), tokens, measured)).toEqual(
    tables.slice(0, 2)
  )
  measured[0].gaps[0].left = 19
  expect(regions.deduplicateSourceOwnedTableSubsets(tables, inventory, measured)).toEqual(tables)
})

it('does not use an already removed caption owner to justify another deletion', () => {
  const { tokens, complete, caption } = example()
  const shared = { ...caption, text: 'Table 2. Other', rect: [10, 100, 120, 110] }
  const first = { ...complete, caption }
  const removed = { ...structuredClone(complete), id: 'duplicate-first', caption: shared }
  const second = { ...structuredClone(complete), id: 'second', caption: shared }
  second.cropRect = [5, 115, 170, 175]
  for (const c of second.cells) {
    c.sourceItems[0].index += 100
    c.sourceRects[0][1] += 90
    c.sourceRects[0][3] += 90
  }
  const unresolved = {
    ...structuredClone(second),
    id: 'duplicate-second',
    caption: { ...shared, text: 'Table 3. Unresolved' }
  }
  const inventory = [
    ...tokens,
    ...second.cells.map((c) => ({
      text: c.text,
      horizontal: true,
      rect: c.sourceRects[0],
      sourceItem: c.sourceItems[0]
    }))
  ]
  expect(
    regions.deduplicateSourceOwnedTableSubsets([first, removed, second, unresolved], inventory)
  ).toEqual([first, second, unresolved])
})

it.each(['native-table-structure-ambiguous', 'text-crosses-crop-boundary'])(
  'retains an equivalent duplicate with an unresolved %s issue',
  (issue) => {
    const { tokens, complete, caption } = example()
    const captioned = { ...structuredClone(complete), id: 'captioned', caption }
    const duplicate = { ...complete, issues: ['missing-row-or-column', issue] }
    expect(regions.deduplicateSourceOwnedTableSubsets([duplicate, captioned], tokens)).toEqual([
      duplicate,
      captioned
    ])
  }
)

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function equivalentCandidates() {
  const { tokens, complete, caption } = example()
  return {
    tokens,
    tables: [
      { ...structuredClone(complete), caption },
      { ...structuredClone(complete), caption: undefined as typeof caption | undefined }
    ]
  }
}

const equivalentRejections: [string, (f: ReturnType<typeof equivalentCandidates>) => void][] = [
  [
    'missing grid slot',
    (f) => {
      f.tables[1].cells.pop()
    }
  ],
  [
    'different span',
    (f) => {
      f.tables[1].cells[0].colSpan = 2
    }
  ],
  [
    'different source owner',
    (f) => {
      f.tables[1].cells[0].sourceItems[0].index = 99
    }
  ],
  [
    'two caption owners',
    (f) => {
      f.tables[1].caption = structuredClone(f.tables[0].caption)
    }
  ],
  [
    'partially visible glyph',
    (f) => {
      f.tables[1].cropRect[0] = 20
    }
  ],
  [
    'third owner',
    (f) => {
      f.tables.push(structuredClone(f.tables[1]))
    }
  ],
  [
    'same token double carrier',
    (f) => {
      Object.assign(f.tokens[0], { sourceToken: f.tokens[0].sourceItem })
    }
  ],
  ...['sourceItem', 'sourceToken', 'sourceSegment'].map(
    (carrier): [string, (f: ReturnType<typeof equivalentCandidates>) => void] => [
      `external ${carrier} alias`,
      (f) => {
        const token = { ...structuredClone(f.tokens[0]), rect: [200, 200, 230, 210] }
        Object.assign(token, {
          sourceItem: undefined,
          [carrier]: { pageNumber: 1, index: 0, text: 'Group', start: 0, end: 5 }
        })
        f.tokens.push(token)
      }
    ]
  )
]

it('retains independent adjacent tables with identical strings', () => {
  const f = equivalentCandidates()
  for (const cell of f.tables[1].cells) {
    cell.sourceItems[0].index += 20
    cell.sourceRects[0] = cell.sourceRects[0].map((value, axis) => (axis % 2 ? value : value + 200))
  }
  f.tables[1].cropRect = f.tables[1].cropRect.map((value, axis) => (axis % 2 ? value : value + 200))
  f.tokens.push(
    ...f.tokens.map((token) => ({
      ...token,
      sourceItem: { ...token.sourceItem, index: token.sourceItem.index + 20 },
      rect: token.rect.map((value, axis) => (axis % 2 ? value : value + 200))
    }))
  )
  expect(regions.deduplicateSourceOwnedTableSubsets(f.tables, f.tokens)).toEqual(f.tables)
})

it('ignores an unrelated outside native origin during equivalent candidate proof', () => {
  const f = equivalentCandidates()
  f.tokens.push({
    text: 'X',
    horizontal: true,
    rect: [200, 200, 210, 210],
    sourceItem: { pageNumber: 1, index: 90, text: 'X' }
  })
  expect(regions.deduplicateSourceOwnedTableSubsets(f.tables, f.tokens)).toEqual([f.tables[0]])
})

it('retains both candidates when a third overlapping crop has no source metadata', () => {
  const { tokens, complete, narrow } = example()
  const unknown = { ...complete, id: 'unproved', cells: [], grid: [] }
  const candidates = [narrow, complete, unknown]
  expect(regions.deduplicateSourceOwnedTableSubsets(candidates, tokens)).toEqual(candidates)
})

it('does not move a caption whose region competes with another caption owner', () => {
  const { tokens, complete, narrow, caption } = example()
  const other = {
    ...complete,
    id: 'other',
    cropRect: [200, 25, 300, 85],
    cells: [],
    grid: [],
    caption: structuredClone(caption)
  }
  const candidates = [narrow, complete, other]
  expect(regions.deduplicateSourceOwnedTableSubsets(candidates, tokens)).toEqual(candidates)
})

it('requires the added final-column origins to occupy their claimed physical rows', () => {
  const { tokens, complete, narrow } = example()
  const changed = structuredClone(complete)
  changed.cells[5].row = 2
  changed.cells[8].row = 1
  changed.grid[1][2] = '4'
  changed.grid[2][2] = '3'
  const candidates = [narrow, changed]
  expect(regions.deduplicateSourceOwnedTableSubsets(candidates, tokens)).toEqual(candidates)
})

const unproved: [string, (fixture: ReturnType<typeof example>) => void][] = [
  [
    'equal text and geometry with a different original index',
    ({ narrow }) => {
      narrow.cells[0].sourceItems[0].index = 99
    }
  ],
  [
    'a missing original character',
    ({ narrow }) => {
      narrow.cells[0].text = 'Grou'
    }
  ],
  [
    'a clipped native region',
    ({ narrow }) => {
      narrow.cells[0].sourceRects[0][2] -= 1
    }
  ],
  [
    'duplicate native evidence for one identity',
    ({ tokens }) => {
      tokens.push(structuredClone(tokens[0]))
    }
  ],
  [
    'two cell owners for one original',
    ({ narrow }) => {
      narrow.cells[1].sourceItems = structuredClone(narrow.cells[0].sourceItems)
      narrow.cells[1].text = 'Group'
      narrow.cells[1].sourceRects = structuredClone(narrow.cells[0].sourceRects)
    }
  ],
  [
    'a row span',
    ({ complete }) => {
      complete.cells[2].rowSpan = 2
    }
  ],
  [
    'an incomplete final column',
    ({ complete }) => {
      complete.cells = complete.cells.filter((cell) => cell.row !== 2 || cell.column !== 2)
    }
  ],
  [
    'an origin whose original PDF text disagrees',
    ({ tokens }) => {
      tokens[0].sourceItem.text = 'Other'
    }
  ],
  [
    'an unsupported native orientation',
    ({ tokens }) => {
      tokens[0].horizontal = false
    }
  ],
  [
    'an extra original inside the retained crop',
    ({ tokens }) => {
      tokens.push({
        text: 'X',
        horizontal: true,
        rect: [45, 30, 50, 40],
        sourceItem: { pageNumber: 1, index: 99, text: 'X' }
      })
    }
  ]
]
it.each(unproved)('retains candidates with %s', (_label, alter) => {
  const fixture = example()
  alter(fixture)
  const candidates = [fixture.narrow, fixture.complete]
  expect(regions.deduplicateSourceOwnedTableSubsets(candidates, fixture.tokens)).toEqual(candidates)
})

it('retains conflicting captions and multiple complete candidates', () => {
  const { tokens, complete, narrow, caption } = example()
  const conflict = { ...complete, caption: { ...caption, text: 'Table 2. Other results' } }
  expect(regions.deduplicateSourceOwnedTableSubsets([narrow, conflict], tokens)).toEqual([
    narrow,
    conflict
  ])
  const third = { ...complete, id: 'second-complete' }
  expect(regions.deduplicateSourceOwnedTableSubsets([narrow, complete, third], tokens)).toEqual([
    narrow,
    complete,
    third
  ])
})

it('accounts for contiguous native regions without inventing a second source identity', () => {
  const { tokens, complete, narrow, caption } = example()
  complete.cells[0].sourceRects = [
    [10, 30, 20, 40],
    [20, 30, 40, 40]
  ]
  expect(regions.deduplicateSourceOwnedTableSubsets([complete, narrow], tokens)).toEqual([
    { ...complete, caption, repairs: ['source-owned-subset-deduplicated'] }
  ])
})

it('rejects internal source-region gaps without measured character evidence', () => {
  const { tokens, complete, narrow } = example()
  complete.cells[0].sourceRects = [
    [10, 30, 20, 40],
    [25, 30, 40, 40]
  ]
  expect(regions.deduplicateSourceOwnedTableSubsets([complete, narrow], tokens)).toEqual([
    complete,
    narrow
  ])
})

it('requires shared original identities to retain their row and column order', () => {
  const { tokens, complete, narrow } = example()
  const changed = structuredClone(narrow)
  for (const cell of changed.cells) if (cell.row) cell.row = 3 - cell.row
  ;[changed.grid[1], changed.grid[2]] = [changed.grid[2], changed.grid[1]]
  expect(regions.deduplicateSourceOwnedTableSubsets([complete, changed], tokens)).toEqual([
    complete,
    changed
  ])
})

it('does not trust grid text that disagrees with its source-owned cell', () => {
  const { tokens, complete, narrow } = example()
  complete.grid[0][0] = 'Different'
  expect(regions.deduplicateSourceOwnedTableSubsets([complete, narrow], tokens)).toEqual([
    complete,
    narrow
  ])
})

it('rejects populated grid slots without source-owned cells', () => {
  const { tokens, complete, narrow } = example()
  for (const row of complete.grid) row.splice(1, 0, 'UNOWNED')
  for (const cell of complete.cells) if (cell.column >= 1) cell.column++
  expect(regions.deduplicateSourceOwnedTableSubsets([complete, narrow], tokens)).toEqual([
    complete,
    narrow
  ])
})

it('accepts a whitespace gap only when native glyph advances prove its character boundary and endpoints', () => {
  const { tokens, complete, narrow, caption } = example()
  tokens[0].text = tokens[0].sourceItem.text = 'Group label'
  for (const table of [complete, narrow]) {
    table.cells[0].text = table.cells[0].sourceItems[0].text = table.grid[0][0] = 'Group label'
  }
  complete.cells[0].sourceRects = [
    [10, 30, 20, 40],
    [25, 30, 40, 40]
  ]
  const run = {
    text: 'Group label',
    rect: [10, 30, 40, 40],
    gaps: [{ left: 20, right: 25, index: 5 }]
  }
  expect(regions.deduplicateSourceOwnedTableSubsets([complete, narrow], tokens, [run])).toEqual([
    { ...complete, caption, repairs: ['source-owned-subset-deduplicated'] }
  ])
  for (const bad of [
    { ...run, gaps: [{ left: 20, right: 25, index: 4 }] },
    { ...run, gaps: [{ left: 21, right: 25, index: 5 }] }
  ])
    expect(regions.deduplicateSourceOwnedTableSubsets([complete, narrow], tokens, [bad])).toEqual([
      complete,
      narrow
    ])
  expect(
    regions.deduplicateSourceOwnedTableSubsets([complete, narrow], tokens, [run, run])
  ).toEqual([complete, narrow])
})

it('clears only the proven shared-caption issue and retains existing repair evidence', () => {
  const { tokens, complete, narrow, caption } = example()
  const shared = { ...complete, captionIssue: 'shared-table-caption', repairs: ['existing-repair'] }
  const result = regions.deduplicateSourceOwnedTableSubsets(
    [{ ...narrow, captionIssue: 'shared-table-caption' }, shared],
    tokens
  )
  expect(result).toEqual([
    { ...complete, caption, repairs: ['existing-repair', 'source-owned-subset-deduplicated'] }
  ])
  for (const candidates of [
    [{ ...narrow, captionIssue: 'unresolved-caption' }, complete],
    [narrow, { ...complete, captionIssue: 'unresolved-caption' }]
  ])
    expect(regions.deduplicateSourceOwnedTableSubsets(candidates, tokens)).toEqual(candidates)
})

// Model assembly and printed-header recovery can describe the same transported cell
// using different partition rectangles and temporary token wrappers.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function assembledEquivalentCandidates() {
  const f = equivalentCandidates()
  for (const [candidate, table] of f.tables.entries()) {
    for (const cell of table.cells) {
      const rect = [...cell.sourceRects[0]]
      rect[2] += candidate ? 0.5 : 1
      Object.assign(cell, {
        rect,
        origin: candidate ? 'source-printed-header' : 'model-grid',
        sourceTokens: candidate
          ? [{ text: cell.text, rect: cell.sourceRects[0], sourceItem: cell.sourceItems[0] }]
          : [{ text: cell.text, rect: cell.sourceRects[0] }]
      })
    }
  }
  return f
}

it('deduplicates equivalent transported cells from distinct assembly routes without changing the retained object', () => {
  const f = assembledEquivalentCandidates()
  const snapshot = structuredClone(f)
  const result = regions.deduplicateSourceOwnedTableSubsets(f.tables, f.tokens)
  expect(result).toHaveLength(1)
  expect(result[0]).toBe(f.tables[0])
  expect(f).toEqual(snapshot)
})

it.each(equivalentRejections)(
  'retains differently assembled candidates with %s',
  (_label, mutate) => {
    const f = assembledEquivalentCandidates()
    mutate(f)
    expect(regions.deduplicateSourceOwnedTableSubsets(f.tables, f.tokens)).toEqual(f.tables)
  }
)

it('does not discard an unknown cell field while comparing differently assembled candidates', () => {
  const f = assembledEquivalentCandidates()
  Object.assign(f.tables[1].cells[0], { futureSemanticField: 'unreviewed' })
  expect(regions.deduplicateSourceOwnedTableSubsets(f.tables, f.tokens)).toEqual(f.tables)
})

it('retains conflicting rich text despite equal literals and distinct assembly routes', () => {
  const f = assembledEquivalentCandidates()
  for (const [candidate, table] of f.tables.entries()) {
    Object.assign(table.cells[0], {
      textRuns: [{ text: table.cells[0].text, position: candidate ? 'subscript' : 'normal' }]
    })
  }
  expect(regions.deduplicateSourceOwnedTableSubsets(f.tables, f.tokens)).toEqual(f.tables)
})
