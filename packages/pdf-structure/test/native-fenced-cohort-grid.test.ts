import { describe, expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { resolve } from './paths'
const { anonymousFencedCohort } = await import(
  pathToFileURL(resolve('test/fixtures/native-fenced-cohort-grid.mjs')).href
)
const { recoverNativeFencedCohortGrid, reconcileNativeClosedFencedStubOwners } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-fenced-cohort-grid.mjs')).href
)
const prove = (f: ReturnType<typeof JSON.parse>): ReturnType<typeof JSON.parse> =>
  recoverNativeFencedCohortGrid(f.table, f.tokens, f.captions, f.rules, f.context)
const { refineTable } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)

describe('native fenced nonquantitative cohorts', () => {
  const splitStub = (): ReturnType<typeof JSON.parse> => {
    const f = anonymousFencedCohort({ headerLevels: 0, recordCount: 3 }),
      good = refineTable(
        f.table,
        f.tokens,
        f.captions,
        [],
        f.rules,
        [],
        undefined,
        f.paint,
        f.context
      ),
      owner = good.cells.find((c) => c.column === 0 && c.row === 1),
      donors = Array.from({ length: owner.rowSpan }, (_, n) => ({
        ...owner,
        row: owner.row + n,
        rowSpan: 1,
        text: owner.sourceItems[n]?.text ?? '',
        rect: [
          owner.rect[0],
          good.rows[owner.row + n].rect[1],
          owner.rect[2],
          good.rows[owner.row + n].rect[3]
        ],
        sourceItems: owner.sourceItems.slice(n, n + 1),
        sourceRects: owner.sourceRects.slice(n, n + 1),
        sourceTokens: owner.sourceTokens.slice(n, n + 1)
      })),
      grid = good.grid.map((row) => [...row])
    donors.forEach((c) => (grid[c.row][0] = c.text))
    return {
      ...f,
      good,
      donors,
      result: { ...good, grid, cells: good.cells.flatMap((c) => (c === owner ? donors : [c])) }
    }
  }

  it('reuses the complete closed plan to merge only already-owned multiline stub fragments', () => {
    const f = splitStub(),
      before = JSON.stringify(f.result),
      shared = { value: 'same metadata' }
    f.donors.forEach((c) => (c.privateEvidence = shared))
    const r = reconcileNativeClosedFencedStubOwners(
      f.result,
      f.tokens,
      f.captions,
      f.rules,
      f.context
    )
    expect(r).toBeDefined()
    expect(r.grid).toEqual(f.good.grid)
    expect(r.cells).toHaveLength(f.good.cells.length)
    const merged = r.cells.find((c) => c.column === 0 && c.row === 1)
    expect(merged.rowSpan).toBe(3)
    expect(merged.text).toBe('Able Group')
    expect(merged.privateEvidence).toBe(shared)
    for (const cell of f.result.cells.filter((c) => !f.donors.includes(c)))
      expect(r.cells.includes(cell)).toBe(true)
    for (const name of ['cropRect', 'rows', 'issues', 'notes', 'unassigned', 'repairs'])
      expect(r[name]).toBe(f.result[name])
    expect(
      reconcileNativeClosedFencedStubOwners(r, f.tokens, f.captions, f.rules, f.context)
    ).toBeUndefined()
    expect(
      JSON.stringify({
        ...f.result,
        cells: f.result.cells.map((cell) => {
          const value = { ...cell }
          delete value.privateEvidence
          return value
        })
      })
    ).toBe(before)
  })

  it.each([0, 1])(
    'preserves an unchanged canonical printed-header witness with %i wrapper layers',
    (layers) => {
      const f = splitStub(),
        header = f.result.cells.find((c) => c.row === 0 && c.column === 1),
        font = f.tokens.find((t) => t.sourceItem.index === header.sourceItems[0].index),
        witness = layers ? { ...font, sourceToken: font } : font
      header.sourceTokens = [witness]
      const r = reconcileNativeClosedFencedStubOwners(
        f.result,
        f.tokens,
        f.captions,
        f.rules,
        f.context
      )
      expect(r).toBeDefined()
      expect(r.cells.includes(header)).toBe(true)
      expect(header.sourceTokens[0]).toBe(witness)
    }
  )

  it.each(['foreign', 'extra-carrier'])(
    'rejects a %s carrier hidden in a printed-header wrapper',
    (mode) => {
      const f = splitStub(),
        header = f.result.cells.find((c) => c.row === 0 && c.column === 1),
        font = f.tokens.find((t) => t.sourceItem.index === header.sourceItems[0].index),
        inner = { ...font },
        outer = { ...font, sourceToken: inner }
      if (mode === 'foreign') inner.sourceItem = f.donors[0].sourceItems[0]
      else outer.privateEvidence = { sourceItem: font.sourceItem }
      header.sourceTokens = [outer]
      expect(
        reconcileNativeClosedFencedStubOwners(f.result, f.tokens, f.captions, f.rules, f.context)
      ).toBeUndefined()
    }
  )

  it.each([
    'different-metadata',
    'nested-source',
    'shared-source-array',
    'peer-owner',
    'segment',
    'math',
    'wrong-rect',
    'dirty-padding',
    'cycle',
    'accessor'
  ])('keeps the old grid when %s prevents an exact late stub-only merge', (mode) => {
    const f = splitStub(),
      origin = f.donors[0].sourceItems[0]
    let getterCalled = false
    if (mode === 'different-metadata') f.donors[0].privateEvidence = { value: 'different' }
    if (mode === 'nested-source') f.donors[0].privateEvidence = { child: { sourceItem: origin } }
    if (mode === 'shared-source-array')
      f.donors[0].privateEvidence = { owners: f.donors[0].sourceItems }
    if (mode === 'peer-owner')
      f.result.cells.find((c) => c.column === 1).privateEvidence = { owner: origin }
    if (mode === 'segment') f.donors[0].sourceSegments = []
    if (mode === 'math') f.donors[0].textRuns = [{ text: f.donors[0].text, position: 'normal' }]
    if (mode === 'wrong-rect')
      f.donors[0].sourceRects = [f.donors[0].sourceRects[0].map((x, n) => x + (n === 0 ? 0.01 : 0))]
    if (mode === 'dirty-padding')
      f.result.cropRect = [f.result.cropRect[0], 30.5, ...f.result.cropRect.slice(2)]
    if (mode === 'cycle') {
      const cycle = {}
      cycle.self = cycle
      f.donors[0].privateEvidence = cycle
    }
    if (mode === 'accessor')
      Object.defineProperty(f.donors[0], 'privateEvidence', {
        enumerable: true,
        get() {
          getterCalled = true
          return origin
        }
      })
    expect(
      reconcileNativeClosedFencedStubOwners(f.result, f.tokens, f.captions, f.rules, f.context)
    ).toBeUndefined()
    expect(getterCalled).toBe(false)
  })
  it('owns complete mixed literal fields without interpreting quantities or assuming equal cohort lengths', () => {
    const f = anonymousFencedCohort({
        headerLevels: 0,
        metricPairs: 2,
        literalMetrics: true,
        recordCounts: [3, 2]
      }),
      plan = prove(f)
    expect(plan).toBeDefined()
    expect(plan.rows).toHaveLength(6)
    expect(plan.columns).toHaveLength(6)
    expect(plan.spans.filter((s) => s.column === 0 && s.row > 0).map((s) => s.rowSpan)).toEqual([
      3, 2
    ])
    expect(plan.ownedTokens.size).toBe(f.tokens.length - 1)
  })

  it.each(['missing', 'interior-word'])(
    'declines mixed literals when %s prevents complete numeric lanes and a distinct category lane',
    (literalFault) => {
      const f = anonymousFencedCohort({
        headerLevels: 0,
        metricPairs: 2,
        literalMetrics: true,
        recordCounts: [3, 2],
        literalFault
      })
      expect(prove(f)).toBeUndefined()
    }
  )
  it('preserves the closed cohort plan through actual table refinement', () => {
    const f = anonymousFencedCohort({ headerLevels: 2 }),
      r = refineTable(f.table, f.tokens, f.captions, [], f.rules, [], undefined, f.paint, f.context)
    expect(r.grid).toHaveLength(7)
    expect(r.grid[0]).toHaveLength(4)
    expect(r.unassigned).toEqual([])
    expect(
      r.cells.filter((c) => c.column === 0 && c.row >= 3).map((c) => [c.row, c.rowSpan, c.text])
    ).toEqual([
      [3, 2, 'Able Group'],
      [5, 2, 'Beta Group']
    ])
  })
  it('does not let a later generic tiered-header grid replace independently fenced cohorts', () => {
    const f = anonymousFencedCohort({ headerLevels: 1, recordCount: 3, metricPairs: 2 }),
      r = refineTable(f.table, f.tokens, f.captions, [], f.rules, [], undefined, f.paint, f.context)
    expect(r.grid).toHaveLength(8)
    expect(r.grid[0]).toHaveLength(6)
    expect(r.cells.filter((c) => c.column === 0 && c.row >= 2 && c.rowSpan === 3)).toHaveLength(2)
  })
  for (const headerLevels of [0, 1, 2])
    it(`owns multiline stubs in ${headerLevels + 1} native header levels`, () => {
      const f = anonymousFencedCohort({ headerLevels })
      const plan = prove(f)
      expect(plan).toBeDefined()
      expect(plan.columns).toHaveLength(4)
      expect(plan.rows).toHaveLength(4 + headerLevels + 1)
      expect(
        plan.spans.filter((s) => s.column === 0 && s.row >= headerLevels + 1 && s.rowSpan === 2)
      ).toHaveLength(2)
      expect(plan.ownedTokens.size).toBe(f.tokens.length - 1)
    })

  it('accepts opaque cell backgrounds only after the independent frame and records close', () => {
    expect(prove(anonymousFencedCohort({ background: true }))).toBeDefined()
  })

  it('uses physical fences rather than the multiline stub midpoint for three-record cohorts', () => {
    const f = anonymousFencedCohort({ headerLevels: 2, recordCount: 3 }),
      plan = prove(f)
    expect(plan?.rows).toHaveLength(9)
    expect(plan.spans.filter((s) => s.column === 0 && s.row >= 3 && s.rowSpan === 3)).toHaveLength(
      2
    )
  })

  it.each([
    ['128', '256'],
    ['Set1', 'Set2']
  ])('does not assign quantitative stubs even with authentic native sources: %s %s', (a, b) => {
    expect(prove(anonymousFencedCohort({ stubLabels: [a, b] }))).toBeUndefined()
  })

  it('keeps the bounded record limit', () => {
    expect(prove(anonymousFencedCohort({ recordCount: 128 }))).toBeUndefined()
  })

  it.each(['group', 'transparent', 'white', 'foreign-glyph'])(
    'declines unsupported or foreign native paint: %s',
    (mutation) => {
      const f = anonymousFencedCohort(),
        o = f.context.operators
      if (mutation === 'group') {
        o.fnArray.push(OPS.beginGroup, OPS.endGroup)
        o.argsArray.push(
          [{ matrix: null, bbox: [0, 0, 10, 10], smask: null, isolated: false, knockout: false }],
          null
        )
      }
      if (mutation === 'transparent') {
        o.fnArray.unshift(OPS.setGState)
        o.argsArray.unshift([[['ca', 0.5]]])
      }
      if (mutation === 'white') o.argsArray[o.fnArray.indexOf(OPS.setFillRGBColor)] = ['#ffffff']
      if (mutation === 'foreign-glyph') {
        f.draw('A', 130, 95)
        f.context.sourceContent.items.pop()
      }
      expect(prove(f)).toBeUndefined()
    }
  )

  it.each(['missing', 'declared', 'native', 'crossing', 'header-gap'])(
    'requires original exhaustive fences: %s',
    (mutation) => {
      const f = anonymousFencedCohort(),
        ops = f.context.operators
      if (mutation === 'missing') f.rules.splice(2, 1)
      if (mutation === 'declared') f.rules.push([40, 100, 400, 100])
      if (mutation === 'native') {
        const at = ops.fnArray.lastIndexOf(OPS.constructPath)
        ops.argsArray[at][1][0][4] -= 20
      }
      if (mutation === 'header-gap') f.rules[1][2] -= 30
      if (mutation === 'crossing') f.rules.push([50, 10, 50, 300])
      expect(prove(f)).toBeUndefined()
    }
  )

  it.each(['number', 'number-in-name', 'missing', 'duplicate', 'literal', 'rect', 'extra'])(
    'requires every original nonquantitative whole stub: %s',
    (mutation) => {
      const f = anonymousFencedCohort(),
        token = f.tokens.find((i) => i.text === 'Able')
      if (mutation === 'number') token.text = '128'
      if (mutation === 'number-in-name') token.text = 'Group1'
      if (mutation === 'missing') f.tokens.splice(f.tokens.indexOf(token), 1)
      if (mutation === 'duplicate') f.tokens.push({ ...token })
      if (mutation === 'literal') token.sourceItem = { ...token.sourceItem, text: 'Other' }
      if (mutation === 'rect')
        token.rect = [...token.rect.slice(0, 2), token.rect[2] + 1, token.rect[3]]
      if (mutation === 'extra') {
        f.draw('A', 40, 95)
        f.tokens.push({
          ...token,
          text: 'A',
          rect: [60, 127.5, 67.5, 142.5],
          sourceItem: f.context.sourceContent.items.at(-1).sourceItem
        })
      }
      expect(prove(f)).toBeUndefined()
    }
  )

  it.each(['width', 'transform', 'style', 'literal'])(
    'binds the current source carrier: %s',
    (mutation) => {
      const f = anonymousFencedCohort(),
        source = structuredClone(f.context.sourceContent)
      f.context.sourceContent = source
      f.context.content = source
      if (mutation === 'width') source.items[1].width += 1
      if (mutation === 'transform') source.items[1].transform[4] += 1
      if (mutation === 'style') source.styles.F.ascent = 0.8
      if (mutation === 'literal') source.items[1].str = 'Other'
      expect(prove(f)).toBeUndefined()
    }
  )

  it.each(['missing', 'ambiguous', 'literal'])(
    'requires a complete original adjacent caption: %s',
    (mutation) => {
      const f = anonymousFencedCohort()
      if (mutation === 'missing') f.captions = []
      if (mutation === 'ambiguous') f.captions.push({ ...f.captions[0] })
      if (mutation === 'literal') f.captions[0].lines = ['Table 1: Other']
      expect(prove(f)).toBeUndefined()
    }
  )

  it.each(['partial', 'color', 'transparent', 'curve', 'postpaint', 'clip'])(
    'declines an unproved cell background: %s',
    (mutation) => {
      const f = anonymousFencedCohort({ background: true }),
        o = f.context.operators,
        at = o.argsArray.findIndex(
          (a, n) => o.fnArray[n] === OPS.constructPath && a[0] === OPS.fill
        )
      if (mutation === 'partial') {
        o.argsArray[at][1][0][4] = 80
        o.argsArray[at][1][0][7] = 80
        o.argsArray[at][2][2] = 80
      }
      if (mutation === 'color') o.argsArray[at - 1] = ['#000000']
      if (mutation === 'transparent') {
        o.fnArray.unshift(OPS.setGState)
        o.argsArray.unshift([[['ca', 0.5]]])
      }
      if (mutation === 'curve') o.argsArray[at][1][0][3] = 2
      if (mutation === 'postpaint') {
        const op = o.fnArray.splice(at, 1)[0],
          args = o.argsArray.splice(at, 1)[0]
        o.fnArray.push(op)
        o.argsArray.push(args)
      }
      if (mutation === 'clip') {
        o.fnArray.unshift(OPS.clip)
        o.argsArray.unshift(null)
      }
      expect(prove(f)).toBeUndefined()
    }
  )

  it('preserves input data and declines a missing or unsupported Source context', () => {
    const f = anonymousFencedCohort(),
      before = JSON.stringify(f)
    expect(prove(f)).toBeDefined()
    expect(JSON.stringify(f)).toBe(before)
    f.context.nativeGlyphContext = undefined
    expect(prove(f)).toBeUndefined()
  })
})
