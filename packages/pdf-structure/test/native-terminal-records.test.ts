import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from './paths'
import { pathToFileURL } from 'node:url'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)
const examples = readFileSync(resolve('test/fixtures/native-terminal-records.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line))
const fixture = (kind: string): ReturnType<typeof JSON.parse> =>
  structuredClone(examples.find((f) => f.kind === kind))
const run = (f: ReturnType<typeof fixture>): ReturnType<typeof refineTable> =>
  refineTable(f.table, f.items, f.captions, [], f.rules, f.runs)
const characters = (text: string): string => [...text.replace(/\s/gu, '')].sort().join('')

const sparseReferenceTail = (): ReturnType<typeof JSON.parse> => {
  const table = {
    id: 'sparse-reference-tail',
    cropRect: [0, 0, 400, 105],
    structure: {
      objects: [
        ...[0, 20, 40, 60].map((y) => ({ label: 'table row', rect: [0, y, 400, y + 20] })),
        ...Array.from({ length: 8 }, (_, c) => ({
          label: 'table column',
          rect: [c * 50, 0, c * 50 + 50, 105]
        }))
      ]
    }
  }
  const token = (text: string, c: number, y: number): ReturnType<typeof JSON.parse> => ({
    text,
    rect: [c * 50 + 5, y, c * 50 + 35, y + 10],
    baseline: y + 10,
    height: 10,
    horizontal: true
  })
  const items = [
    ...Array.from({ length: 8 }, (_, c) => token(c ? `Value${c}` : 'Method', c, 5)),
    ...Array.from({ length: 3 }, (_, r) =>
      Array.from({ length: 8 }, (_, c) => token(c ? '1.23' : `Model${r}`, c, 25 + r * 20))
    ).flat(),
    token('Ref.', 0, 87),
    token('1.40 [1]', 6, 87),
    token('4401 [1]', 7, 87)
  ].map((i, index) => ({ ...i, sourceItem: { pageNumber: 1, index, text: i.text } }))
  const rules = [
    [0, 0, 400, 0],
    [0, 20, 400, 20],
    [0, 82, 400, 82],
    [0, 102, 400, 102]
  ]
  return { table, items, rules }
}
it('recovers a separately ruled sparse reference tail with native values aligned to prior records', () => {
  const { table, items, rules } = sparseReferenceTail()
  const result = refineTable(table, items, [], [], rules)
  expect(result.grid.at(-1)).toEqual(['Ref.', '', '', '', '', '', '1.40 [1]', '4401 [1]'])
  expect(result.unassigned).toEqual([])
  expect(characters(result.cells.map((c: { text: string }) => c.text).join(''))).toBe(
    characters(items.map((i: { text: string }) => i.text).join(''))
  )
})

const numberedNativeRecords = (): ReturnType<typeof JSON.parse> => {
  const table = {
    id: 'numbered-native-records',
    cropRect: [0, 0, 1000, 110],
    structure: {
      objects: [
        ...[0, 20, 40, 56].map((y) => ({ label: 'table row', rect: [0, y, 1000, y + 20] })),
        ...Array.from({ length: 10 }, (_, c) => ({
          label: 'table column',
          rect: [c * 100, 0, c * 100 + 100, 110]
        }))
      ]
    }
  }
  const items = Array.from({ length: 4 }, (_, r) => [
    { text: String(r + 1), rect: [5, 25 + r * 16, 15, 35 + r * 16] },
    {
      text: '1.23 2.34 3.45 4.56 5.67 6.78 7.89 8.90 9.01',
      rect: [105, 25 + r * 16, 985, 35 + r * 16]
    }
  ])
    .flat()
    .map((i, index) => ({
      ...i,
      height: 10,
      baseline: i.rect[3],
      horizontal: true,
      sourceItem: { pageNumber: 1, index, text: i.text }
    }))
  return {
    table,
    items,
    rules: [
      [0, 0, 1000, 0],
      [0, 20, 1000, 20],
      [0, 94, 1000, 94]
    ]
  }
}
it('keeps a final independent numbered numeric record after three matching native records', () => {
  const { table, items, rules } = numberedNativeRecords()
  const result = refineTable(table, items, [], [], rules)
  expect(result.grid.slice(1).map((r: string[]) => r[0])).toEqual(['1', '2', '3', '4'])
  expect(result.grid.at(-1)).toEqual([
    '4',
    '1.23',
    '2.34',
    '3.45',
    '4.56',
    '5.67',
    '6.78',
    '7.89',
    '8.90',
    '9.01'
  ])
  expect(result.unassigned).toEqual([])
})

it.each([
  'closing rule',
  'separator',
  'source identity',
  'peer alignment',
  'competing face text',
  'citation',
  'peer source',
  'native geometry'
])('declines sparse-tail recovery without %s proof', (control) => {
  const f = sparseReferenceTail()
  if (control === 'closing rule') f.rules.pop()
  if (control === 'separator') f.rules.splice(2, 1)
  if (control === 'source identity') f.items.at(-1).sourceItem = f.items.at(-2).sourceItem
  if (control === 'peer alignment') f.items.at(-1).rect[2] -= 3
  if (control === 'competing face text')
    f.items.push({
      text: 'Note',
      rect: [55, 87, 85, 97],
      baseline: 97,
      height: 10,
      horizontal: true,
      sourceItem: { pageNumber: 1, index: 100, text: 'Note' }
    })
  if (control === 'citation') f.items.at(-1).text = f.items.at(-1).sourceItem.text = 'a comment'
  if (control === 'peer source') for (const item of f.items.slice(0, -3)) delete item.sourceItem
  if (control === 'native geometry') f.items.at(-1).baseline += 1
  const result = refineTable(f.table, f.items, [], [], f.rules)
  expect(result.repairs).not.toContain('native-ruled-sparse-reference-tail-recovered')
})

it.each([
  'source identity',
  'cadence',
  'numeric leaves',
  'ordinal sequence',
  'only two peers',
  'native geometry'
])('does not infer an independent terminal record without %s', (control) => {
  const f = numberedNativeRecords()
  if (control === 'source identity') f.items.at(-1).sourceItem = f.items.at(-3).sourceItem
  if (control === 'cadence') {
    f.items[0].rect[1] -= 2
    f.items[0].rect[3] -= 2
    f.items[0].baseline -= 2
  }
  if (control === 'numeric leaves')
    f.items.at(-1).text = f.items.at(-1).sourceItem.text = 'a wrapped description'
  if (control === 'ordinal sequence') f.items.at(-2).text = f.items.at(-2).sourceItem.text = '3'
  if (control === 'only two peers') f.items.splice(0, 2)
  if (control === 'native geometry') f.items.at(-1).rect[3] += 1
  const result = refineTable(f.table, f.items, [], [], f.rules)
  expect(result.repairs).not.toContain('native-terminal-ordinal-record-recovered')
})

for (const [name, make, repair] of [
  ['sparse reference', sparseReferenceTail, 'native-ruled-sparse-reference-tail-recovered'],
  ['ordinal record', numberedNativeRecords, 'native-terminal-ordinal-record-recovered']
] as const) {
  it.each(['sourceSegment', 'sourceToken', 'nested segment'])(
    `rejects an external %s alias for ${name}`,
    (carrier) => {
      const f = make(),
        origin = f.items.at(-1).sourceItem
      const alias = {
        text: origin.text,
        rect: [2000, 2000, 2100, 2010],
        height: 10,
        baseline: 2010,
        horizontal: true
      }
      const segment = { ...origin, start: 0, end: origin.text.length, rect: alias.rect }
      f.items.push({
        ...alias,
        ...(carrier === 'sourceSegment'
          ? { sourceSegment: segment }
          : carrier === 'sourceToken'
            ? { sourceToken: origin }
            : { sourceToken: { sourceSegment: segment } })
      })
      expect(refineTable(f.table, f.items, [], [], f.rules).repairs).not.toContain(repair)
    }
  )
  it(`retains ${name} recovery with an unrelated external segment`, () => {
    const f = make()
    f.items.push({
      text: 'external',
      rect: [2000, 2000, 2100, 2010],
      height: 10,
      baseline: 2010,
      horizontal: true,
      sourceSegment: {
        pageNumber: 1,
        index: 1000,
        text: 'external',
        start: 0,
        end: 8,
        rect: [2000, 2000, 2100, 2010]
      }
    })
    expect(refineTable(f.table, f.items, [], [], f.rules).repairs).toContain(repair)
  })
}

for (const kind of ['closed-field-faces', 'measured-four-leaf']) {
  it(`recovers complete ${kind} records with unique unchanged source ownership`, () => {
    const input = fixture(kind),
      before = structuredClone(input),
      result = run(input)
    expect(result.grid).toHaveLength(8)
    expect(
      result.grid.every((r: string[]) => r.length === (kind === 'closed-field-faces' ? 2 : 4))
    ).toBe(true)
    expect(result.unassigned).toEqual([])
    expect(characters(result.cells.map((c: { text: string }) => c.text).join(''))).toBe(
      characters(input.items.map((i: { text: string }) => i.text).join(''))
    )
    const selected = result.cells.flatMap((c: { sourceTokens: unknown[] }) => c.sourceTokens)
    expect(new Set(selected).size).toBe(selected.length)
    expect(input).toEqual(before)
  })

  it(`preserves ${kind} after scaling, translation and reversed source order`, () => {
    const input = fixture(kind),
      expected = run(input).grid
    const rect = (r: number[]): number[] => r.map((v, n) => v * 1.7 + (n % 2 ? 70 : 30))
    input.table.cropRect = rect(input.table.cropRect)
    input.table.structure.objects = input.table.structure.objects.map((o: { rect: number[] }) => ({
      ...o,
      rect: o.rect.map((v) => v * 1.7)
    }))
    input.items = input.items
      .map((i: { rect: number[]; height: number; baseline: number }) => ({
        ...i,
        rect: rect(i.rect),
        height: i.height * 1.7,
        baseline: i.baseline * 1.7 + 70
      }))
      .reverse()
    input.rules = input.rules.map(rect).reverse()
    input.captions = input.captions.map((c: { rect: number[] }) => ({ ...c, rect: rect(c.rect) }))
    input.runs = input.runs.map(
      (r: {
        rect: number[]
        height: number
        baseline: number
        gaps: { left: number; right: number }[]
      }) => ({
        ...r,
        rect: rect(r.rect),
        height: r.height * 1.7,
        baseline: r.baseline * 1.7 + 70,
        gaps: r.gaps.map((g) => ({ ...g, left: g.left * 1.7 + 30, right: g.right * 1.7 + 30 }))
      })
    )
    expect(run(input).grid).toEqual(expected)
  })
}

it('retains the final wrapped field inside its complete physical face', () => {
  const result = run(fixture('closed-field-faces'))
  expect(result.grid[7][0]).toBe('XXXXXXXXXX')
  expect(result.grid[7][1]).toContain('544 XX XXX 67 XX XXXX')
  expect(result.repairs).toContain('native-closed-field-faces-recovered')
})

it('refuses field recovery without every complete native row boundary', () => {
  const input = fixture('closed-field-faces')
  input.rules = input.rules.filter((r: number[]) => Math.abs(r[1] - 287.3115) > 0.05)
  expect(run(input).repairs).not.toContain('native-closed-field-faces-recovered')
})

it('refuses a paragraph crossing the proved field gutter', () => {
  const input = fixture('closed-field-faces')
  input.items.push({
    text: 'An ordinary paragraph crosses both lanes',
    height: 11.9,
    baseline: 310,
    rect: [220, 298.1, 640, 310],
    horizontal: true
  })
  expect(run(input).repairs).not.toContain('native-closed-field-faces-recovered')
})

it('keeps text outside the final native boundary out of repaired field cells', () => {
  const input = fixture('closed-field-faces')
  input.items.push({
    text: 'external note',
    height: 1,
    baseline: 330,
    rect: [220, 329, 300, 330],
    horizontal: true
  })
  const result = run(input)
  expect(result.grid.flat()).not.toContain('external note')
  expect(result.unassigned).toContain('external note')
})

it('recovers the fused labels, sample count and complete human metric record', () => {
  const result = run(fixture('measured-four-leaf'))
  expect(result.grid[5]).toEqual(['722-XXXX XXXXXXX, XXXXX', 'XXXXX (XXX)', '4,267', '4.0'])
  expect(result.grid[6].slice(1, 3)).toEqual(['', ''])
  expect(result.repairs).toContain('native-measured-four-leaf-records-recovered')
})

it('refuses measured records without a literal measured glyph run', () => {
  const input = fixture('measured-four-leaf')
  input.runs = []
  expect(run(input).repairs).not.toContain('native-measured-four-leaf-records-recovered')
})

it('refuses an uncertain complete count lane instead of inventing a value', () => {
  const input = fixture('measured-four-leaf')
  const item = input.items.find((i: { text: string }) => i.text === '3,318')
  item.text = 'uncertain'
  expect(run(input).repairs).not.toContain('native-measured-four-leaf-records-recovered')
})

it('requires native caption evidence for both record repairs', () => {
  for (const kind of ['closed-field-faces', 'measured-four-leaf']) {
    const input = fixture(kind)
    input.captions = []
    expect(run(input).repairs).not.toContain(
      kind === 'closed-field-faces'
        ? 'native-closed-field-faces-recovered'
        : 'native-measured-four-leaf-records-recovered'
    )
  }
})

it('refuses field recovery when a source glyph lacks a horizontal text contract', () => {
  const input = fixture('closed-field-faces')
  input.items.find((i: { text: string }) => i.text === 'XXXXXXXXXX').horizontal = false
  expect(run(input).repairs).not.toContain('native-closed-field-faces-recovered')
})

it('requires one unique nearby native table caption', () => {
  for (const kind of ['closed-field-faces', 'measured-four-leaf']) {
    const input = fixture(kind)
    input.captions.push(structuredClone(input.captions[0]))
    expect(run(input).repairs).not.toContain(
      kind === 'closed-field-faces'
        ? 'native-closed-field-faces-recovered'
        : 'native-measured-four-leaf-records-recovered'
    )
  }
})
