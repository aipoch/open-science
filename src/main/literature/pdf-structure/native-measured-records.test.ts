import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

type Token = {
  text: string
  rect: number[]
  baseline: number
  height: number
  fontName: string
  horizontal: boolean
}
type Input = {
  table: {
    id: string
    cropRect: number[]
    structure: { objects: { label: string; rect: number[] }[] }
  }
  tokens: Token[]
  captions: { lines: string[]; rect: number[] }[]
  notes: never[]
  rules: number[][]
}
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const {
  recoverNativeMeasuredRecordGrid,
  recoverNativeGroupedParameterGrid,
  recoverNativeRuledFormulaGrid
} = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-native-measured-record-grid.mjs'))
    .href
)
const {
  recoverNativeSegmentedScientificGrid,
  recoverNativeWrappedCountNarrativeGrid,
  recoverNativeSymbolDefinitionGrid,
  recoverNativeConfigurationGrid,
  recoverNativeCitedMeasurementGrid
} = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-native-lined-record-grid.mjs')).href
)
function fixture(name = 'ruled-groups-with-independent-scalar-records'): Input {
  return readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids', name + '.jsonl')
  )
}
function sevenLaneFixture(): Input {
  const f = fixture()
  f.table.cropRect[2] = 480
  f.table.structure.objects = f.table.structure.objects.filter((o) => o.label !== 'table column')
  for (const [a, b] of [
    [0, 120],
    [120, 180],
    [180, 240],
    [240, 300],
    [300, 360],
    [360, 420],
    [420, 480]
  ])
    f.table.structure.objects.push({ label: 'table column', rect: [a, 0, b, 100] })
  for (const r of f.rules) r[2] = 480
  for (const i of f.tokens)
    if (i.rect[0] >= 120) {
      i.rect[0] += 60
      i.rect[2] += 60
    }
  const add = (text: string, x: number, y: number): void => {
    f.tokens.push({
      text,
      rect: [x, y - 10, x + 35, y],
      baseline: y,
      height: 10,
      fontName: 'anonymous-serif',
      horizontal: true
    })
  }
  add('Method', 125, 34)
  add('Ratio', 365, 34)
  add('Value', 425, 34)
  for (const y of [54, 70, 94, 110]) {
    add('Mode', 125, y)
    add('3.2', 365, y)
    add('4.3', 425, y)
  }
  return f
}
it('retains complete method records and all five scalar leaves in bounded groups', () => {
  const f = sevenLaneFixture(),
    r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(r.grid).toHaveLength(5)
  expect(r.grid[0]).toHaveLength(7)
  expect(
    r.grid
      .slice(1)
      .every((row: string[]) => row[1] === 'Mode' && row[5] === '3.2' && row[6] === '4.3')
  ).toBe(true)
  expect(
    r.cells
      .flatMap((c: { sourceRects: number[][] }) => c.sourceRects)
      .map((rect: number[]) => JSON.stringify(rect))
      .sort()
  ).toEqual(f.tokens.map((i) => JSON.stringify(i.rect)).sort())
})
it('does not recover a method group with an incomplete independent method record', () => {
  const f = sevenLaneFixture()
  f.tokens.splice(
    f.tokens.findIndex((i) => i.text === 'Mode'),
    1
  )
  expect(recoverNativeMeasuredRecordGrid(f.table, f.tokens, f.captions, f.rules)).toBeUndefined()
})
it('recovers a native header and every independent configuration record without nearby prose', () => {
  const f = fixture('native-configuration-with-three-complete-records'),
    original = structuredClone(f)
  const r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(r.grid).toHaveLength(4)
  expect(r.grid[0]).toEqual(['Configuration', 'Local pooling', 'Global pooling'])
  expect(r.grid.slice(1).map((row: string[]) => row[0])).toEqual(['Mode A', 'Mode B', 'Mode C'])
  expect(r.cropRect[3]).toBe(100)
  expect(
    r.cells
      .flatMap((c: { sourceRects: number[][] }) => c.sourceRects)
      .map((rect: number[]) => JSON.stringify(rect))
      .sort()
  ).toEqual(
    f.tokens
      .filter((i) => i.baseline < 100)
      .map((i) => JSON.stringify(i.rect))
      .sort()
  )
  expect(f).toEqual(original)
})
it.each(['divider', 'segment', 'field', 'header', 'baseline', 'foreign', 'extra-rule'])(
  'declines incomplete native configuration proof: %s',
  (change: string) => {
    const f = fixture('native-configuration-with-three-complete-records')
    if (change === 'divider') f.rules.shift()
    if (change === 'segment') f.rules.pop()
    if (change === 'field')
      f.tokens.splice(
        f.tokens.findIndex((i) => i.text === 'changing'),
        1
      )
    if (change === 'header')
      f.tokens.find((i) => i.text === 'Global pooling')!.text = 'Other grouping'
    if (change === 'baseline') {
      const i = f.tokens.find((i) => i.text === 'Mode B')!
      i.baseline += 5
      i.rect[1] += 5
      i.rect[3] += 5
    }
    if (change === 'foreign')
      f.tokens.push({ ...f.tokens[0], text: 'outside', rect: [285, 45, 298, 55], baseline: 55 })
    if (change === 'extra-rule') f.rules.push([0, 60, 300, 60])
    expect(recoverNativeConfigurationGrid(f.table, f.tokens, f.captions, f.rules)).toBeUndefined()
  }
)
it('keeps all cited measurement records, wrapped components and independent reference fields', () => {
  const f = fixture('ruled-cited-records-with-wrapped-component-lane'),
    original = structuredClone(f)
  const r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(r.grid).toHaveLength(7)
  expect(r.grid.every((row: string[]) => row.length === 8)).toBe(true)
  expect(r.grid.slice(1).map((row: string[]) => row[7])).toEqual([
    '[1]',
    '[2]',
    '[3]',
    '[4]',
    '[5]',
    '[6]'
  ])
  expect(r.grid[1][3]).toBe('')
  expect(r.grid[1][6]).toBe('aaa, abb, acc, bcc')
  expect(
    r.cells
      .flatMap((c: { sourceRects: number[][] }) => c.sourceRects)
      .map((rect: number[]) => JSON.stringify(rect))
      .sort()
  ).toEqual(f.tokens.map((i) => JSON.stringify(i.rect)).sort())
  expect(f).toEqual(original)
})
it.each(['caption', 'closing', 'reference', 'field', 'baseline', 'overlap', 'foreign', 'vertical'])(
  'declines incomplete cited record proof: %s',
  (change: string) => {
    const f = fixture('ruled-cited-records-with-wrapped-component-lane')
    if (change === 'caption') f.captions = []
    if (change === 'closing') f.rules.pop()
    if (change === 'reference') f.tokens.find((i) => i.text === '[3]')!.text = 'Other'
    if (change === 'field')
      f.tokens.splice(
        f.tokens.findIndex((i) => i.text === '2.2'),
        1
      )
    if (change === 'baseline') {
      const i = f.tokens.find((i) => i.text === '[3]')!
      i.baseline += 6
      i.rect[1] += 6
      i.rect[3] += 6
    }
    if (change === 'overlap') f.tokens.find((i) => i.text === 'acc, bcc')!.rect[3] += 12
    if (change === 'foreign')
      f.tokens.push({ ...f.tokens[0], text: 'foreign', rect: [725, 48, 755, 58], baseline: 58 })
    if (change === 'vertical') f.rules.push([400, 20, 400, 220])
    expect(
      recoverNativeCitedMeasurementGrid(f.table, f.tokens, f.captions, f.rules)
    ).toBeUndefined()
  }
)
it('keeps independently measured baselines separate inside native ruled groups', () => {
  const f = fixture(),
    original = structuredClone(f)
  const result = refineTable(f.table, f.tokens, f.captions, f.notes, f.rules)
  expect(result.grid).toHaveLength(5)
  expect(result.grid.slice(1).map((r: string[]) => r[1])).toEqual([
    '1.00×',
    '1.20×',
    '1.00×',
    '1.20×'
  ])
  expect(
    result.cells
      .flatMap((c: { sourceRects: number[][] }) => c.sourceRects)
      .map((r: number[]) => JSON.stringify(r))
      .sort()
  ).toEqual(f.tokens.map((i) => JSON.stringify(i.rect)).sort())
  expect(result.unassigned).toEqual([])
  expect(f).toEqual(original)
})
it.each(['caption', 'closing', 'field', 'baseline', 'group', 'foreign', 'vertical'])(
  'requires complete native proof: %s',
  (change: string) => {
    const f = fixture()
    if (change === 'caption') f.captions = []
    if (change === 'closing') f.rules.pop()
    if (change === 'field')
      f.tokens.splice(
        f.tokens.findIndex((i) => i.text === '0.042'),
        1
      )
    if (change === 'baseline') {
      const i = f.tokens.find((i) => i.text === '0.042')!
      i.baseline += 4
      i.rect[1] += 4
      i.rect[3] += 4
    }
    if (change === 'group') f.rules.splice(2, 1)
    if (change === 'foreign')
      f.tokens.push({ ...f.tokens[5], text: 'foreign', rect: [170, 45, 200, 55], baseline: 55 })
    if (change === 'vertical') f.rules.push([165, 20, 165, 120])
    expect(recoverNativeMeasuredRecordGrid(f.table, f.tokens, f.captions, f.rules)).toBeUndefined()
  }
)
it('keeps both count lanes independent from wrapped narrative', () => {
  const f = fixture('ruled-count-anchors-with-wrapped-narrative'),
    r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(r.grid[0]).toHaveLength(4)
  expect(r.grid.slice(1).map((row: string[]) => [row[1], row[3]])).toEqual([
    ['12', '2'],
    ['14', '3'],
    ['16', '4']
  ])
  expect(r.grid[1][2]).toBe('An independent prose record. continuation on its own baseline.')
  expect(
    r.cells
      .flatMap((c: { sourceRects: number[][] }) => c.sourceRects)
      .map((rect: number[]) => JSON.stringify(rect))
      .sort()
  ).toEqual(f.tokens.map((i) => JSON.stringify(i.rect)).sort())
})
it.each(['caption', 'closing', 'count', 'baseline', 'overlap', 'foreign', 'vertical'])(
  'declines incomplete count/narrative evidence: %s',
  (change: string) => {
    const f = fixture('ruled-count-anchors-with-wrapped-narrative')
    if (change === 'caption') f.captions = []
    if (change === 'closing') f.rules.pop()
    if (change === 'count')
      f.tokens.splice(
        f.tokens.findIndex((i) => i.text === '14'),
        1
      )
    if (change === 'baseline') {
      const i = f.tokens.find((i) => i.text === '3')!
      i.baseline += 3
      i.rect[1] += 3
      i.rect[3] += 3
    }
    if (change === 'overlap')
      f.tokens.find((i) => i.text === 'continuation on its own baseline.')!.rect[2] = 335
    if (change === 'foreign')
      f.tokens.push({ ...f.tokens[4], text: 'foreign', rect: [140, 51, 165, 61], baseline: 61 })
    if (change === 'vertical') f.rules.push([323, 20, 323, 130])
    expect(
      recoverNativeWrappedCountNarrativeGrid(f.table, f.tokens, f.captions, f.rules)
    ).toBeUndefined()
  }
)
it('separates every symbolic record and orders a native kerned script chain', () => {
  const f = fixture('ruled-symbol-records-with-kerned-script-chain'),
    r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(r.grid).toHaveLength(9)
  expect(r.grid[1][1]).toBe('eab/N in a literal record.')
  expect(r.grid[8]).toEqual(['H', 'Literal definition H.'])
  expect(
    r.cells
      .flatMap((c: { sourceRects: number[][] }) => c.sourceRects)
      .map((rect: number[]) => JSON.stringify(rect))
      .sort()
  ).toEqual(f.tokens.map((i) => JSON.stringify(i.rect)).sort())
  expect(r.unassigned).toEqual([])
})
it('preserves an undecodable zero-width literal in diagnostics', () => {
  const f = fixture('ruled-symbol-records-with-kerned-script-chain')
  f.tokens.push({ ...f.tokens.at(-1)!, text: '7', rect: [290, 128, 290, 138], baseline: 138 })
  const r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(r.grid).toHaveLength(9)
  expect(r.unassigned).toContain('7')
  expect(r.issues).toContain('unassigned-source-text')
})
it.each(['caption', 'closing', 'stub', 'leading', 'script-height', 'foreign', 'vertical'])(
  'declines incomplete symbolic record evidence: %s',
  (change: string) => {
    const f = fixture('ruled-symbol-records-with-kerned-script-chain')
    if (change === 'caption') f.captions = []
    if (change === 'closing') f.rules.pop()
    if (change === 'stub')
      f.tokens.splice(
        f.tokens.findIndex((i) => i.text === 'H'),
        1
      )
    if (change === 'leading') {
      const i = f.tokens.find((i) => i.text === 'H')!
      i.baseline += 10
      i.rect[1] += 10
      i.rect[3] += 10
    }
    if (change === 'script-height') f.tokens.find((i) => i.text === 'N')!.height = 4
    if (change === 'foreign')
      f.tokens.push({ ...f.tokens[4], text: 'foreign', rect: [80, 45, 170, 55], baseline: 55 })
    if (change === 'vertical') f.rules.push([100, 20, 100, 146])
    expect(
      recoverNativeSymbolDefinitionGrid(f.table, f.tokens, f.captions, f.rules)
    ).toBeUndefined()
  }
)
it('preserves every five-lane scientific record and exponent beside a fixed field', () => {
  const f = fixture('segmented-native-five-lane-scientific-records'),
    original = structuredClone(f)
  const r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(r.grid).toHaveLength(4)
  expect(r.grid[0]).toEqual(['Band', 'a', 'b', 'c', 'd'])
  expect(r.grid.slice(1).map((row: string[]) => row[0])).toEqual(['10 Unit', '20 Unit', '30 Unit'])
  expect(
    r.grid
      .slice(1)
      .every((row: string[]) => row[1] === '1.23×10−5' && row[2] === '−' && row[4] === '3.45×10−6')
  ).toBe(true)
  expect(
    r.cells
      .flatMap((c: { sourceRects: number[][] }) => c.sourceRects)
      .map((rect: number[]) => JSON.stringify(rect))
      .sort()
  ).toEqual(f.tokens.map((i) => JSON.stringify(i.rect)).sort())
  expect(f).toEqual(original)
})
it.each(['caption', 'closing', 'segment', 'field', 'script-baseline', 'foreign', 'competing-rule'])(
  'declines incomplete segmented scientific evidence: %s',
  (change: string) => {
    const f = fixture('segmented-native-five-lane-scientific-records')
    if (change === 'caption') f.captions = []
    if (change === 'closing') f.rules.splice(2, 1)
    if (change === 'segment') f.rules.pop()
    if (change === 'field')
      f.tokens.splice(
        f.tokens.findIndex((i) => i.text === '2.34'),
        1
      )
    if (change === 'script-baseline') {
      const i = f.tokens.find((i) => i.text === '−5')!
      i.baseline += 8
      i.rect[1] += 8
      i.rect[3] += 8
    }
    if (change === 'foreign')
      f.tokens.push({ ...f.tokens[5], text: 'foreign', rect: [174, 43, 186, 53], baseline: 53 })
    if (change === 'competing-rule') f.rules.push([0, 55, 400, 55])
    expect(
      recoverNativeSegmentedScientificGrid(f.table, f.tokens, f.captions, f.rules)
    ).toBeUndefined()
  }
)
it('recovers every parameter/value record in native bounded groups', () => {
  const f = fixture('ruled-groups-with-centered-parameter-stubs'),
    original = structuredClone(f)
  const r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(r.grid).toHaveLength(7)
  expect(r.grid.slice(1).map((row: string[]) => row[2])).toEqual(['1', '2', '3', '4', '5', '6'])
  expect(
    r.cells
      .filter((s: { column: number; rowSpan: number }) => s.column === 0 && s.rowSpan > 1)
      .map((s: { row: number; rowSpan: number }) => [s.row, s.rowSpan])
  ).toEqual([
    [1, 2],
    [3, 2],
    [5, 2]
  ])
  expect(
    r.cells
      .flatMap((c: { sourceRects: number[][] }) => c.sourceRects)
      .map((rect: number[]) => JSON.stringify(rect))
      .sort()
  ).toEqual(f.tokens.map((i) => JSON.stringify(i.rect)).sort())
  expect(f).toEqual(original)
})
it.each(['caption', 'closing', 'value', 'parameter', 'overlap', 'group', 'foreign'])(
  'declines incomplete grouped parameter evidence: %s',
  (change: string) => {
    const f = fixture('ruled-groups-with-centered-parameter-stubs')
    if (change === 'caption') f.captions = []
    if (change === 'closing') f.rules.pop()
    if (change === 'value')
      f.tokens.splice(
        f.tokens.findIndex((i) => i.text === '4'),
        1
      )
    if (change === 'parameter')
      f.tokens.splice(
        f.tokens.findIndex((i) => i.text === 'Parameter D'),
        1
      )
    if (change === 'overlap') {
      const i = f.tokens.find((i) => i.text === '3')!
      i.rect[1] -= 10
    }
    if (change === 'group') f.rules.splice(2, 1)
    if (change === 'foreign')
      f.tokens.push({ ...f.tokens[3], text: 'foreign', rect: [85, 90, 108, 100], baseline: 100 })
    expect(
      recoverNativeGroupedParameterGrid(f.table, f.tokens, f.captions, f.rules)
    ).toBeUndefined()
  }
)
it('keeps a raised formula tail on its own native record face', () => {
  const f = fixture('ruled-formula-records-with-raised-source-tail'),
    original = structuredClone(f)
  const r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  const owners = r.cells.filter((c: { sourceTokens: Token[] }) =>
    c.sourceTokens.some((i) => i.text === 'P' || (i.text === 'd' && i.height === 7))
  )
  expect(owners).toHaveLength(1)
  expect(owners[0].row).toBe(4)
  expect(r.grid[3][2]).not.toContain('P')
  expect(r.grid[4][2]).toContain('P')
  expect(
    r.cells
      .flatMap((c: { sourceRects: number[][] }) => c.sourceRects)
      .map((rect: number[]) => JSON.stringify(rect))
      .sort()
  ).toEqual(f.tokens.map((i) => JSON.stringify(i.rect)).sort())
  expect(f).toEqual(original)
})
it.each(['caption', 'closing', 'fraction', 'name', 'column', 'foreign'])(
  'declines incomplete formula face evidence: %s',
  (change: string) => {
    const f = fixture('ruled-formula-records-with-raised-source-tail')
    if (change === 'caption') f.captions = []
    if (change === 'closing') f.rules.splice(5, 1)
    if (change === 'fraction') f.rules.pop()
    if (change === 'name')
      f.tokens.splice(
        f.tokens.findIndex((i) => i.text === 'Metric C'),
        1
      )
    if (change === 'column') f.tokens.find((i) => i.text === 'P')!.rect[0] = 140
    if (change === 'foreign')
      f.tokens.push({ ...f.tokens[3], text: 'foreign', rect: [290, 130, 310, 140], baseline: 140 })
    expect(recoverNativeRuledFormulaGrid(f.table, f.tokens, f.captions, f.rules)).toBeUndefined()
  }
)
