import { expect, it } from 'vitest'
import { resolve } from './paths'
import { pathToFileURL } from 'node:url'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)
const { recoverNativeWrappedMathRecords, recoverNativeTerminalFieldContinuationGrid } =
  await import(
    pathToFileURL(resolve('resources/literature-pdf-native-math-field-record-grid.mjs')).href
  )
const token = (text: string, x: number, y: number, width = 30): ReturnType<typeof JSON.parse> => ({
  text,
  rect: [x, y, x + width, y + 10],
  height: 10,
  baseline: y + 10,
  horizontal: true
})
const input = (): ReturnType<typeof JSON.parse> => ({
  table: {
    id: 'table',
    cropRect: [40, 70, 460, 200],
    structure: {
      objects: [
        ...[10, 90, 170].map((x) => ({
          label: 'table column',
          score: 0.9,
          rect: [x, 0, x + 75, 125]
        })),
        ...[8, 28, 44, 60, 76, 92, 108].map((y) => ({
          label: 'table row',
          score: 0.9,
          rect: [0, y, 420, y + 14]
        }))
      ]
    }
  },
  tokens: [
    token('State', 50, 80),
    token('Count', 130, 80),
    token('Configurations', 250, 80, 100),
    ...Array.from({ length: 3 }, (_, n) => [
      token('Item' + n, 50, 105 + n * 32),
      token(String(10 + n), 130, 105 + n * 32),
      token('a b + c d', 200, 105 + n * 32, 200),
      token('d e + f g', 200, 121 + n * 32, 180)
    ]).flat()
  ],
  rules: [
    [40, 73, 460, 73],
    [40, 75, 460, 75],
    [40, 99, 460, 99],
    [40, 197, 460, 197]
  ],
  captions: [
    { lines: ['Table 1: Synthetic wrapped mathematical records.'], rect: [40, 55, 460, 65] }
  ]
})
it('folds mathematical continuation lines into their independently anchored source record', () => {
  const f = input(),
    r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(r.grid).toHaveLength(4)
  expect(r.grid[0]).toEqual(['State', 'Count', 'Configurations'])
  expect(r.grid.slice(1).map((r: string[]) => r.slice(0, 2))).toEqual([
    ['Item0', '10'],
    ['Item1', '11'],
    ['Item2', '12']
  ])
  expect(
    r.grid.slice(1).every((r: string[]) => r[2].includes('a b + c d') && r[2].includes('d e + f g'))
  ).toBe(true)
  expect(r.unassigned).toEqual([])
})
it('declines orphan continuation, incomplete anchors and text crossing a source gutter', () => {
  const f = input()
  expect(recoverNativeWrappedMathRecords(f.table, f.tokens, [], f.rules)).toBeUndefined()
  expect(
    recoverNativeWrappedMathRecords(
      f.table,
      f.tokens.slice(0, 4).concat(f.tokens.slice(5)),
      f.captions,
      f.rules
    )
  ).toBeUndefined()
  const g = input()
  g.tokens[6].rect[0] = 140
  expect(recoverNativeWrappedMathRecords(g.table, g.tokens, g.captions, g.rules)).toBeUndefined()
  const h = input()
  h.tokens[3].text = ''
  expect(recoverNativeWrappedMathRecords(h.table, h.tokens, h.captions, h.rules)).toBeUndefined()
})

const terminalFields = (scale = 1): ReturnType<typeof JSON.parse> => {
  const tokens: ReturnType<typeof JSON.parse>[] = []
  const add = (text: string, x: number, baseline: number, width: number, height = 10): void => {
    tokens.push({
      text,
      rect: [x, baseline - height, x + width, baseline],
      height,
      baseline,
      horizontal: true,
      sourceItem: { pageNumber: 1, index: tokens.length, text }
    })
  }
  add('State', 30, 35, 35)
  add('Settings', 110, 35, 50)
  add('Purpose', 300, 35, 45)
  for (let n = 0; n < 4; n++) {
    const baseline = 55 + n * 14
    add(['P', 'T', 'V', 'Z'][n], 30, baseline, 6)
    add('a', 42, baseline, 6)
    add('=', 50, baseline, 6)
    add('0', 58, baseline, 6)
    if (n === 3) {
      add('a∼U[0,1],', 110, baseline, 75)
      add('b∼V[1,2],', 190, baseline, 85)
    } else add('Baseline', 110, baseline, 45)
    add(n === 3 ? 'Uniformity over' : 'Check', 300, baseline, n === 3 ? 80 : 30)
  }
  add('c=d', 110, 111, 15)
  add('2', 125, 107, 4, 7)
  add('/(2a), e=a/2', 129, 111, 70)
  add('parameter variation', 300, 111, 95)
  const table = {
      id: 'anonymous',
      cropRect: [20, 20, 405, 120],
      structure: {
        objects: [
          ...[
            [20, 95],
            [95, 285],
            [285, 405]
          ].map(([x, r]) => ({ label: 'table column', rect: [x - 20, 0, r - 20, 100] })),
          ...[20, 40, 62, 76, 90, 104].map((y) => ({
            label: 'table row',
            rect: [0, y - 20, 385, y - 6]
          }))
        ]
      }
    },
    rules = [22, 41, 117].map((y) => [20, y, 405, y]),
    captions = [
      { page: 1, lines: ['Table 1. Native configuration records.'], rect: [20, 2, 405, 12] }
    ]
  for (const t of tokens) {
    t.rect = t.rect.map((x: number) => x * scale)
    t.height *= scale
    t.baseline *= scale
  }
  table.cropRect = table.cropRect.map((x) => x * scale)
  for (const o of table.structure.objects) o.rect = o.rect.map((x) => x * scale)
  return {
    table,
    tokens,
    rules: rules.map((r) => r.map((x) => x * scale)),
    captions: captions.map((c) => ({ ...c, rect: c.rect.map((x) => x * scale) }))
  }
}
it.each([1, 2])(
  'keeps jointly continued terminal formula and prose fields in one native record at scale %s',
  (scale) => {
    const f = terminalFields(scale),
      original = structuredClone(f),
      r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
    expect(r.grid).toHaveLength(5)
    expect(r.grid[4][1]).toContain('a∼U[0,1], b∼V[1,2],')
    expect(r.grid[4][1]).toContain('c=d2/(2a), e=a/2')
    expect(r.grid[4][2]).toBe('Uniformity over parameter variation')
    expect(
      r.cells
        .flatMap((c: { sourceItems: unknown[] }) => c.sourceItems)
        .sort((a: { index: number }, b: { index: number }) => a.index - b.index)
    ).toEqual(f.tokens.map((t: { sourceItem: unknown }) => t.sourceItem))
    expect(r.unassigned).toEqual([])
    expect(f).toEqual(original)
  }
)
it.each([
  'independent-blank-stub',
  'complete-formula',
  'new-stub',
  'single-assignment',
  'unbalanced-formula',
  'caption',
  'competing-caption',
  'closing',
  'boundary-source',
  'gutter-crossing',
  'shifted-tail',
  'crossing-vertical',
  'duplicate-origin',
  'source-drift'
])('refuses terminal record recovery with %s', (fault) => {
  for (const scale of [0.5, 1, 2]) {
    const f = terminalFields(scale),
      find = (text: string): ReturnType<typeof JSON.parse> =>
        f.tokens.find((t: { text: string }) => t.text === text),
      change = (text: string, replacement: string): void => {
        const t = find(text)
        t.text = replacement
        t.sourceItem.text = replacement
      }
    if (fault === 'independent-blank-stub') change('Uniformity over', 'An independent record.')
    if (fault === 'complete-formula') change('b∼V[1,2],', 'b∼V[1,2]')
    if (fault === 'single-assignment') change('/(2a), e=a/2', '/(2a)')
    if (fault === 'unbalanced-formula') change('b∼V[1,2],', 'b∼V[1,2,')
    if (fault === 'new-stub')
      f.tokens.push({
        text: 'Q',
        rect: [30 * scale, 101 * scale, 36 * scale, 111 * scale],
        height: 10 * scale,
        baseline: 111 * scale,
        horizontal: true,
        sourceItem: { pageNumber: 1, index: 99, text: 'Q' }
      })
    if (fault === 'caption') f.captions = []
    if (fault === 'competing-caption')
      f.captions.push({ ...f.captions[0], lines: ['Table 2. Another record set.'] })
    if (fault === 'closing') f.rules.pop()
    if (fault === 'boundary-source')
      f.tokens.push({
        text: 'foreign',
        rect: [400 * scale, 65 * scale, 425 * scale, 75 * scale],
        height: 10 * scale,
        baseline: 75 * scale,
        horizontal: true,
        sourceItem: { pageNumber: 1, index: 99, text: 'foreign' }
      })
    if (fault === 'gutter-crossing') find('b∼V[1,2],').rect[2] = 305 * scale
    if (fault === 'shifted-tail') find('parameter variation').rect[0] += 5 * scale
    if (fault === 'crossing-vertical')
      f.rules.push([280 * scale, 10 * scale, 280 * scale, 130 * scale])
    if (fault === 'duplicate-origin')
      f.tokens.at(-1).sourceItem.index = f.tokens[0].sourceItem.index
    if (fault === 'source-drift') find('c=d').sourceItem.text = 'changed'
    expect(
      recoverNativeTerminalFieldContinuationGrid(f.table, f.tokens, f.captions, f.rules)
    ).toBeUndefined()
  }
})
