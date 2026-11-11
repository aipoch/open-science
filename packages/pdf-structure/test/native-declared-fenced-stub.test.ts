import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
const { anonymousDeclaredStubOwners } = await import(
  pathToFileURL(resolve('test/fixtures/native-declared-fenced-stub.mjs')).href
)
const { reconcileNativeClosedFencedStubOwners } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-fenced-cohort-grid.mjs')).href
)
const prove = (f: ReturnType<typeof JSON.parse>): ReturnType<typeof JSON.parse> =>
  reconcileNativeClosedFencedStubOwners(f.table, f.tokens, f.captions, f.rules, f.context)

it.each(['grid', 'row', 'cell', 'metadata'])(
  'rejects accessor shapes before either recovery path reads them: %s',
  async (mode) => {
    const f = await anonymousDeclaredStubOwners()
    try {
      let getterCalled = false
      const get = (): never => {
        getterCalled = true
        throw Error('must not execute')
      }
      if (mode === 'grid') Object.defineProperty(f.table.grid, '0', { get })
      if (mode === 'row') Object.defineProperty(f.table.grid[0], '0', { get })
      if (mode === 'cell') Object.defineProperty(f.table.cells[0], 'text', { get })
      if (mode === 'metadata') Object.defineProperty(f.table, 'future', { get, enumerable: true })
      expect(prove(f)).toBeUndefined()
      expect(getterCalled).toBe(false)
    } finally {
      await f.cleanup()
    }
  }
)

it.each(['', 'double-fence'])(
  'repairs only existing textual stub ownership through whole native records: %s',
  async (mode) => {
    const f = await anonymousDeclaredStubOwners(mode)
    try {
      const before = JSON.stringify(f.table),
        r = prove(f)
      expect(r).toBeDefined()
      expect(r.cells.filter((c) => c.column === 0).map((c) => [c.text, c.row, c.rowSpan])).toEqual([
        ['Group', 0, 1],
        ['Able', 1, 2],
        ['Beta', 3, 2]
      ])
      expect(r.cells).toHaveLength(18)
      for (const cell of f.table.cells.filter((c) => c.column !== 0 || c.row === 0))
        expect(r.cells.includes(cell)).toBe(true)
      for (const owner of f.table.cells.filter((c) => c.column === 0 && c.row > 0 && c.text)) {
        const fixed = r.cells.find((c) => c.text === owner.text)
        for (const name of ['rect', 'sourceItems', 'sourceRects', 'sourceTokens'])
          expect(fixed[name]).toBe(owner[name])
      }
      for (const name of [
        'cropRect',
        'rows',
        'issues',
        'notes',
        'repairs',
        'unassigned',
        'clipped'
      ])
        expect(r[name]).toBe(f.table[name])
      expect(r.cells.flatMap((c) => c.sourceItems ?? [])).toHaveLength(18)
      expect(JSON.stringify(f.table)).toBe(before)
      expect(prove({ ...f, table: r })).toBeUndefined()
    } finally {
      await f.cleanup()
    }
  }
)

it.each(['quantity', 'missing-fence', 'foreign-glyph', 'foreign-path'])(
  'keeps complete native Source and painted frame gates: %s',
  async (mode) => {
    const f = await anonymousDeclaredStubOwners(mode)
    try {
      expect(prove(f)).toBeUndefined()
    } finally {
      await f.cleanup()
    }
  }
)

it.each([
  'nonstub-span',
  'leaf-row',
  'source-alias',
  'unknown-carrier',
  'source-like',
  'metadata-alias',
  'cycle',
  'accessor',
  'blank-metadata',
  'wrong-text-runs',
  'foreign-header-carrier',
  'font-rect',
  'duplicate-stub',
  'cross-fence',
  'covered-grid'
])('declines incomplete topology or unretained evidence: %s', async (mode) => {
  const f = await anonymousDeclaredStubOwners()
  try {
    const owner = f.table.cells.find((c) => c.text === 'Able'),
      blank = f.table.cells.find((c) => c.column === 0 && c.row === 1),
      leaf = f.table.cells.find((c) => c.row === 1 && c.column === 1),
      header = f.table.cells[0]
    if (mode === 'nonstub-span') leaf.rowSpan = 2
    if (mode === 'leaf-row') {
      const other = f.table.cells.find((c) => c.row === 2 && c.column === 1)
      leaf.row = 2
      other.row = 1
      f.table.grid[1][1] = other.text
      f.table.grid[2][1] = leaf.text
    }
    if (mode === 'source-alias') leaf.sourceItems = owner.sourceItems
    if (mode === 'unknown-carrier') leaf.future = { sourceToken: owner.sourceTokens[0] }
    if (mode === 'source-like') leaf.future = structuredClone(owner.sourceTokens[0])
    if (mode === 'metadata-alias') leaf.future = owner.sourceRects[0]
    if (mode === 'cycle') {
      leaf.future = {}
      leaf.future.self = leaf.future
    }
    if (mode === 'accessor')
      Object.defineProperty(leaf, 'future', {
        enumerable: true,
        get: () => {
          throw Error('must not execute')
        }
      })
    if (mode === 'blank-metadata') blank.future = 'cannot silently discard'
    if (mode === 'wrong-text-runs') header.textRuns[0].text = 'Other'
    if (mode === 'foreign-header-carrier') header.future = { sourceItems: owner.sourceItems }
    if (mode === 'font-rect') leaf.sourceRects = [leaf.sourceRects[0].map((n) => n + 1)]
    if (mode === 'duplicate-stub') {
      const other = f.table.cells.find((c) => c.text === 'Beta')
      other.text = owner.text
      f.table.grid[other.row][0] = owner.text
    }
    if (mode === 'cross-fence') owner.sourceTokens[0].baseline += 50
    if (mode === 'covered-grid') {
      blank.rowSpan = 2
      f.table.cells = f.table.cells.filter((c) => c !== owner)
    }
    expect(prove(f)).toBeUndefined()
  } finally {
    await f.cleanup()
  }
})

it('retains identical source-free metadata and fixed unchanged header witnesses', async () => {
  const f = await anonymousDeclaredStubOwners()
  try {
    const evidence = { same: ['native scope'] }
    f.table.cells.filter((c) => c.column === 0 && c.row > 0).forEach((c) => (c.future = evidence))
    const header = f.table.cells[0],
      font = f.tokens.find((t) => t.text === header.text)
    header.sourceTokens = [{ ...font, sourceToken: font }]
    f.table.future = { meaning: 'retained' }
    const r = prove(f)
    expect(r).toBeDefined()
    expect(r.future).toBe(f.table.future)
    expect(r.cells.includes(header)).toBe(true)
    expect(r.cells.find((c) => c.text === 'Able').future).toBe(evidence)
  } finally {
    await f.cleanup()
  }
})

it.each([
  '',
  'extra',
  'split-source',
  'accessor',
  'font',
  'alias',
  'missing',
  'undefined-metadata'
])('binds the actual non-enumerable empty-unassigned carrier: %s', async (mode) => {
  const f = await anonymousDeclaredStubOwners()
  try {
    const ids = new Set(f.table.cells.flatMap((c) => (c.sourceItems ?? []).map((o) => o.index))),
      original = f.tokens.filter((t) => ids.has(t.sourceItem.index)),
      reconciled = [...original]
    f.table.captionIssue = undefined
    Object.defineProperty(f.table.unassigned, 'reconciliationItems', {
      value: reconciled,
      enumerable: false
    })
    if (mode === 'extra') Object.defineProperty(f.table.unassigned, 'unknown', { value: [] })
    if (mode === 'split-source')
      Object.defineProperty(f.table.unassigned, 'sourceItems', { value: original })
    if (mode === 'accessor') {
      f.table.unassigned = []
      Object.defineProperty(f.table.unassigned, 'reconciliationItems', {
        get: () => {
          throw Error('must not execute')
        }
      })
    }
    if (mode === 'font') reconciled[0] = { ...reconciled[0], baseline: reconciled[0].baseline + 1 }
    if (mode === 'alias') f.table.future = reconciled[0]
    if (mode === 'missing') reconciled.pop()
    if (mode === 'undefined-metadata') f.table.future = undefined
    const r = prove(f)
    if (mode) expect(r).toBeUndefined()
    else {
      expect(r).toBeDefined()
      expect(r.unassigned).toBe(f.table.unassigned)
      expect(r.unassigned.reconciliationItems).toBe(reconciled)
      expect(Object.hasOwn(r, 'captionIssue')).toBe(true)
      expect(r.captionIssue).toBeUndefined()
    }
  } finally {
    await f.cleanup()
  }
})
