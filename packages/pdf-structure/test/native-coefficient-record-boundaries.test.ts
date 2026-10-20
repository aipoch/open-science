import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)

const fixture = (): ReturnType<typeof JSON.parse> => {
  let index = 0
  const token = (text: string, x: number, y: number): ReturnType<typeof JSON.parse> => ({
    text,
    rect: [x, y, x + text.length * 5, y + 10],
    height: 10,
    baseline: y + 10,
    horizontal: true,
    sourceItem: { pageNumber: 1, index: index++, text }
  })
  return {
    table: {
      cropRect: [0, 0, 400, 150],
      structure: {
        objects: [
          ...[0, 100, 200, 300].map((x) => ({
            label: 'table column',
            rect: [x, 0, x + 100, 150]
          })),
          ...[
            [0, 20],
            [20, 60],
            [70, 100],
            [100, 140]
          ].map(([top, bottom]) => ({
            label: 'table row',
            rect: [0, top, 400, bottom]
          })),
          { label: 'table column header', rect: [0, 0, 400, 20] }
        ]
      }
    },
    items: [
      ...[0, 1, 2, 3].map((c) => token(c ? `Estimate${c}` : 'Measure', c * 100 + 10, 5)),
      ...['Alpha', 'Beta', 'Gamma'].flatMap((name, r) => [
        token(name, 10, 35 + r * 40),
        ...[1, 2, 3].flatMap((c) => [
          token(`${r + 1}.${c}**`, c * 100 + 15, r === 1 ? 64 : 25 + r * 40),
          token(`(0.${c})`, c * 100 + 15, 45 + r * 40)
        ])
      ])
    ],
    rules: [0, 20, 140].map((y) => [0, y, 400, y])
  }
}
const run = (f: ReturnType<typeof fixture>): ReturnType<typeof refineTable> =>
  refineTable(f.table, f.items, [], [], f.rules)
const characters = (text: string): string => [...text.replace(/\s/gu, '')].sort().join('')
const repair = 'native-coefficient-record-boundary-recovered'

it('owns a complete estimate line with its standard errors between two independently complete records', () => {
  const f = fixture()
  const result = run(f)
  expect(result.grid[2]).toEqual(['Beta', '2.1** (0.1)', '2.2** (0.2)', '2.3** (0.3)'])
  expect(result.unassigned).toEqual([])
  expect(result.grid[1]).toEqual(['Alpha', '1.1** (0.1)', '1.2** (0.2)', '1.3** (0.3)'])
  expect(result.grid[3]).toEqual(['Gamma', '3.1** (0.1)', '3.2** (0.2)', '3.3** (0.3)'])
  expect(
    result.cells
      .flatMap((c: { sourceItems: { index: number }[] }) => c.sourceItems.map((i) => i.index))
      .sort((a: number, b: number) => a - b)
  ).toEqual(
    f.items
      .map((i: { sourceItem: { index: number } }) => i.sourceItem.index)
      .sort((a: number, b: number) => a - b)
  )
  expect(characters(result.cells.map((c: { text: string }) => c.text).join(''))).toBe(
    characters(f.items.map((i: { text: string }) => i.text).join(''))
  )
})

it('preserves the native record proof at a non-unit scale', () => {
  const scale = 0.5
  const f = fixture()
  f.table.cropRect = f.table.cropRect.map((n: number) => n * scale)
  for (const object of f.table.structure.objects)
    object.rect = object.rect.map((n: number) => n * scale)
  for (const item of f.items) {
    item.rect = item.rect.map((n: number) => n * scale)
    item.height *= scale
    item.baseline *= scale
  }
  f.rules = f.rules.map((r: number[]) => r.map((n) => n * scale))
  expect(run(f).grid[2]).toEqual(['Beta', '2.1** (0.1)', '2.2** (0.2)', '2.3** (0.3)'])
})

it('keeps a stub-only overline and a split literal minus while preserving every original source', () => {
  const f = fixture()
  f.rules.push([10, 73, 50, 73])
  const value = f.items.find((i: { text: string }) => i.text === '2.1**')
  value.rect[0] += 5
  f.items.push({
    ...structuredClone(value),
    text: '−',
    rect: [115, 64, 120, 74],
    sourceItem: { pageNumber: 1, index: 99, text: '−' }
  })
  const result = run(f)
  expect(result.grid[2][1]).toBe('−2.1** (0.1)')
  expect(result.unassigned).toEqual([])
})

it('does not repeat recovery for an already complete record', () => {
  const f = fixture()
  f.table.structure.objects.find(
    (o: { label: string; rect: number[] }) => o.label === 'table row' && o.rect[1] === 70
  ).rect[1] = 60
  const result = run(f)
  expect(result.repairs).not.toContain(repair)
  expect(result.grid[2]).toEqual(['Beta', '2.1** (0.1)', '2.2** (0.2)', '2.3** (0.3)'])
})

const rejected: [string, (f: ReturnType<typeof fixture>) => void][] = [
  [
    'a missing estimate leaf',
    (f) => {
      f.items = f.items.filter((i: { text: string }) => i.text !== '2.2**')
    }
  ],
  [
    'a missing error leaf',
    (f) => {
      f.items = f.items.filter(
        (i: { text: string; rect: number[] }) => !(i.text === '(0.2)' && i.rect[1] === 85)
      )
    }
  ],
  [
    'a data-lane rule separating estimate and error',
    (f) => {
      f.rules.push([100, 80, 400, 80])
    }
  ],
  [
    'a glyph crossing the numeric gutter',
    (f) => {
      f.items.find((i: { text: string }) => i.text === '2.1**').rect[2] = 205
    }
  ],
  [
    'an independent label on the estimate baseline',
    (f) => {
      f.items.push({
        text: 'Other',
        rect: [10, 64, 35, 74],
        baseline: 74,
        height: 10,
        horizontal: true,
        sourceItem: { pageNumber: 1, index: 99, text: 'Other' }
      })
    }
  ],
  [
    'a conflicting predicted span',
    (f) => {
      f.table.structure.objects.push({ label: 'table spanning cell', rect: [100, 60, 200, 100] })
    }
  ],
  [
    'a different neighboring two-line rhythm',
    (f) => {
      for (const i of f.items.filter((i: { text: string }) => i.text.startsWith('1.'))) {
        i.rect[1] -= 4
        i.rect[3] -= 4
        i.baseline -= 4
      }
    }
  ],
  [
    'an estimate already owned by another row',
    (f) => {
      f.table.structure.objects.find(
        (o: { label: string; rect: number[] }) => o.label === 'table row' && o.rect[1] === 20
      ).rect[3] = 70
    }
  ],
  [
    'two model owners for the record stub',
    (f) => {
      f.table.structure.objects.find(
        (o: { label: string; rect: number[] }) => o.label === 'table row' && o.rect[1] === 20
      ).rect[3] = 85
    }
  ],
  [
    'no following complete record',
    (f) => {
      f.items = f.items.filter((i: { rect: number[] }) => i.rect[1] < 100)
    }
  ],
  [
    'missing original identity',
    (f) => {
      delete f.items.find((i: { text: string }) => i.text === '2.1**').sourceItem
    }
  ],
  [
    'a mismatched original literal',
    (f) => {
      f.items.find((i: { text: string }) => i.text === '2.1**').sourceItem.text = 'different'
    }
  ],
  [
    'a reduced-font script lane',
    (f) => {
      const i = f.items.find((i: { text: string }) => i.text === '2.1**')
      i.height = 7
      i.rect[1] = i.rect[3] - 7
    }
  ]
]
it.each(rejected)('refuses recovery with %s', (_name, mutate) => {
  const f = fixture()
  mutate(f)
  expect(run(f).repairs).not.toContain(repair)
})

it.each(['sourceItem', 'sourceSegment', 'sourceToken', 'nested-item', 'nested-segment'])(
  'refuses an out-of-crop %s alias of an original',
  (carrier) => {
    const f = fixture()
    const original = f.items.find((i: { text: string }) => i.text === '2.1**').sourceItem
    const alias: ReturnType<typeof JSON.parse> = {
      text: original.text,
      rect: [700, 500, 730, 510],
      height: 10,
      baseline: 510,
      horizontal: true
    }
    if (carrier === 'nested-item') alias.sourceToken = { sourceItem: original }
    else if (carrier === 'nested-segment')
      alias.sourceToken = { sourceSegment: { ...original, start: 0, end: original.text.length } }
    else alias[carrier] = { ...original }
    f.items.push(alias)
    expect(run(f).repairs).not.toContain(repair)
  }
)

it.each(['sourceSegment', 'sourceToken'])(
  'refuses a second %s carrier on the same native token',
  (carrier) => {
    const f = fixture()
    const item = f.items.find((i: { text: string }) => i.text === '2.1**')
    item[carrier] = { ...item.sourceItem }
    expect(run(f).repairs).not.toContain(repair)
  }
)

it.each(['separate', 'overlapping'])(
  'refuses %s native scalars on one estimate baseline',
  (kind) => {
    const f = fixture()
    const value = f.items.find((i: { text: string }) => i.text === '2.1**')
    value.text = '2.1'
    value.sourceItem.text = value.text
    value.rect[2] = 130
    const rect = kind === 'separate' ? [175, 64, 180, 74] : [115, 64, 120, 74]
    f.items.push({
      text: '2',
      rect,
      height: 10,
      baseline: 74,
      horizontal: true,
      sourceItem: { pageNumber: 1, index: 99, text: '2' }
    })
    expect(run(f).repairs).not.toContain(repair)
  }
)
