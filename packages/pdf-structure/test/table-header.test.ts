import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)

it('keeps the blank stub before a recovered header that crosses the first predicted cut', () => {
  const raw = {
    id: 'leading-cut',
    cropRect: [0, 0, 400, 100],
    structure: {
      objects: [
        ...[0, 200, 270, 340].map((x, i, xs) => ({
          label: 'table column',
          rect: [x, 0, xs[i + 1] ?? 400, 100]
        })),
        { label: 'table column header', rect: [0, 30, 400, 45] },
        { label: 'table row', rect: [0, 30, 400, 50] },
        { label: 'table row', rect: [0, 50, 400, 75] }
      ]
    }
  }
  const source = [
    token('Arm A', 198, 8),
    token('Arm B', 274, 8),
    token('Arm C', 340, 8),
    token('Outcome', 5, 33),
    token('10', 205, 33),
    token('20', 275, 33),
    token('30', 340, 33),
    token('Score', 5, 55),
    token('1', 205, 55),
    token('2', 275, 55),
    token('3', 340, 55)
  ]
  const result = refineTable(
    raw,
    source,
    [],
    [],
    [
      [0, 3, 400, 3],
      [0, 24, 400, 24]
    ]
  )
  expect(result.grid[0]).toEqual(['', 'Arm A', 'Arm B', 'Arm C'])
  expect(result.cells.every((c: { rect: number[] }) => c.rect[0] < c.rect[2])).toBe(true)
})
// Minimized geometry from the reported PDF: a three-line header's first line
// sits just above both predicted header and row boxes, but inside the table crop.
const table = {
  id: 'header',
  cropRect: [0, 0, 300, 100],
  structure: {
    objects: [
      { label: 'table row', rect: [0, 20, 300, 50] },
      { label: 'table row', rect: [0, 55, 300, 75] },
      { label: 'table column header', rect: [0, 20, 300, 50] },
      ...[0, 100, 200].map((x) => ({ label: 'table column', rect: [x, 0, x + 100, 100] }))
    ]
  }
}
const token = (
  text: string,
  x: number,
  y: number
): {
  text: string
  rect: number[]
  baseline: number
  height: number
  horizontal: boolean
} => ({
  text,
  rect: [x, y, x + 60, y + 10],
  baseline: y + 10,
  height: 10,
  horizontal: true
})
const items = [
  token('Variable', 5, 35),
  token('Treatment', 105, 8),
  token('Control', 205, 8),
  token('Group A', 105, 21),
  token('Group B', 205, 21),
  token('(N=100)', 105, 35),
  token('(N=50)', 205, 35),
  token('Response', 5, 60),
  token('40', 105, 60),
  token('10', 205, 60)
]

// Native dashed dividers enclose logical rows whose description wraps around
// vertically centered labels/counts. Model rows instead follow physical lines.
const dashedNarrative = (): {
  table: typeof raw & { id: string }
  source: Array<
    ReturnType<typeof token> & { sourceItem: { pageNumber: number; index: number; text: string } }
  >
  rules: number[][]
} => {
  const cuts = [0, 90, 180, 360, 430, 500]
  const table = {
    id: 'wrapped-records',
    cropRect: [0, 0, 500, 151],
    structure: {
      objects: [
        ...cuts.slice(1).map((x, n) => ({ label: 'table column', rect: [cuts[n], 0, x, 150] })),
        { label: 'table column header', rect: [0, 0, 500, 30] },
        ...[0, 30, 50, 70, 90, 110, 130].map((y, n, all) => ({
          label: 'table row',
          rect: [0, y, 500, all[n + 1] ?? 150]
        }))
      ]
    }
  }
  let index = 0
  const item = (
    text: string,
    x: number,
    y: number,
    width = 35
  ): ReturnType<typeof token> & {
    sourceItem: { pageNumber: number; index: number; text: string }
  } => ({
    text,
    rect: [x, y, x + width, y + 10],
    baseline: y + 10,
    height: 10,
    horizontal: true,
    sourceItem: { pageNumber: 1, index: index++, text }
  })
  const source = [
    item('Kind', 20, 10),
    item('Source', 110, 10),
    item('Description', 240, 10, 70),
    item('Train', 375, 3),
    item('count', 375, 16),
    item('Test', 445, 3),
    item('count', 445, 16)
  ]
  for (let n = 0; n < 3; n++) {
    const y = 30 + n * 40
    source.push(
      item(`Group ${String.fromCharCode(65 + n)}`, 10, y + 10, 65),
      item(`Set ${n + 1}`, 105, y + 10, 45),
      item(`Read part ${n + 1}`, 210, y + (n ? -1 : 3), 110),
      item('then continue', 175, y + 20, 160),
      item(`${n + 1}k`, 380, y + 10),
      item(`${n + 4}k`, 450, y + 10)
    )
  }
  const rules = [0, 30, 150].map((y) => [0, y, 500, y])
  for (const y of [70, 110]) for (let x = 5; x < 500; x += 10) rules.push([x, y, x + 4, y])
  return { table, source, rules }
}

it('keeps wrapped text within complete dashed record boundaries and preserves native owners', () => {
  const f = dashedNarrative()
  const before = structuredClone(f)
  const result = refineTable(f.table, f.source, [], [], f.rules)
  expect(result.grid).toEqual([
    ['Kind', 'Source', 'Description', 'Train count', 'Test count'],
    ['Group A', 'Set 1', 'Read part 1 then continue', '1k', '4k'],
    ['Group B', 'Set 2', 'Read part 2 then continue', '2k', '5k'],
    ['Group C', 'Set 3', 'Read part 3 then continue', '3k', '6k']
  ])
  expect(result.unassigned).toEqual([])
  expect(result.issues).toEqual([])
  expect(result.repairs).toContain('dashed-narrative-records-recovered')
  const owners = result.cells.flatMap((c: { sourceItems: { index: number }[] }) => c.sourceItems)
  expect(
    owners.map((i: { index: number }) => i.index).sort((a: number, b: number) => a - b)
  ).toEqual(f.source.map((i) => i.sourceItem.index))
  expect(f).toEqual(before)
})

it.each(['broken divider', 'crossing gutter', 'extra count line'])(
  'rejects an ambiguous dashed record with %s',
  (kind) => {
    const f = dashedNarrative()
    if (kind === 'broken divider') f.rules = f.rules.filter((r) => !(r[1] === 70 && r[0] === 255))
    if (kind === 'crossing gutter') f.source.find((i) => i.text === 'then continue')!.rect[0] = 140
    if (kind === 'extra count line') {
      const original = f.source.find((i) => i.text === '2k')!
      f.source.push({
        ...original,
        rect: [380, 92, 415, 102],
        baseline: 102,
        sourceItem: { ...original.sourceItem, index: 99 }
      })
    }
    const result = refineTable(f.table, f.source, [], [], f.rules)
    expect(result.repairs).not.toContain('dashed-narrative-records-recovered')
  }
)

it('recovers a wrapped count heading above a two-column percentage table', () => {
  const raw = {
    id: 'count-header',
    cropRect: [0, 0, 300, 150],
    structure: {
      objects: [
        { label: 'table column', rect: [0, 30, 200, 150] },
        { label: 'table column', rect: [200, 30, 300, 150] },
        ...Array.from({ length: 5 }, (_, i) => ({
          label: 'table row',
          rect: [0, 30 + i * 20, 300, 50 + i * 20]
        }))
      ]
    }
  }
  const source = [
    token('Number of', 210, 1),
    token('patients', 210, 12),
    ...Array.from({ length: 5 }, (_, i) => [
      token('Reason', 5, 33 + i * 20),
      token('20 (10%)', 210, 33 + i * 20)
    ]).flat()
  ]
  const rules = [[0, 27, 300, 27]]
  expect(refineTable(raw, source, [], [], rules).grid[0]).toEqual(['', 'Number of patients'])
  expect(refineTable(raw, source, [], [], []).grid[0]).not.toEqual(['', 'Number of patients'])
})

it('uses parent underlines to join complete child header spans in a three-tier header', () => {
  const raw = {
    cropRect: [0, 0, 900, 125],
    structure: {
      objects: [
        ...[0, 25, 50, 75, 100].map((y) => ({ label: 'table row', rect: [0, y, 900, y + 20] })),
        { label: 'table column header', rect: [0, 0, 900, 70] },
        ...Array.from({ length: 9 }, (_, c) => ({
          label: 'table column',
          rect: [c * 100, 0, (c + 1) * 100, 125]
        })),
        ...[1, 3, 5, 7].map((c) => ({
          label: 'table spanning cell',
          rect: [c * 100, 25, (c + 2) * 100, 45]
        }))
      ]
    }
  }
  const source = [
    token('Trial A', 235, 5),
    token('Trial B', 635, 5),
    ...[1, 3, 5, 7].map((c) => token(`Arm ${c}`, c * 100 + 25, 30)),
    token('Variable', 5, 55),
    ...Array.from({ length: 8 }, (_, c) => token(c % 2 ? '%' : 'No.', (c + 1) * 100 + 5, 55)),
    ...[80, 105].flatMap((y) =>
      Array.from({ length: 9 }, (_, c) => token(c ? `${c + y}` : `Record ${y}`, c * 100 + 5, y))
    )
  ]
  const rules = [
    [105, 22, 465, 22],
    [505, 22, 865, 22]
  ]
  const result = refineTable(raw, source, [], [], rules)
  expect(result.cells.find((c: { text: string }) => c.text === 'Trial A')).toMatchObject({
    row: 0,
    column: 1,
    colSpan: 4
  })
  expect(result.cells.find((c: { text: string }) => c.text === 'Trial B')).toMatchObject({
    row: 0,
    column: 5,
    colSpan: 4
  })
  expect(result.unassigned).toEqual([])
  const fragmented = [
    [90, 22, 280, 22],
    [280.001, 22, 480, 22],
    [490, 22, 680, 22],
    [680.001, 22, 880, 22]
  ]
  const missingParent = {
    ...raw,
    structure: {
      objects: raw.structure.objects.filter((o) => !(o.label === 'table row' && o.rect[1] === 0))
    }
  }
  const recovered = refineTable(missingParent, source, [], [], fragmented)
  expect(recovered.cells.find((c: { text: string }) => c.text === 'Trial A')).toMatchObject({
    row: 0,
    column: 1,
    colSpan: 4
  })
  expect(recovered.cells.find((c: { text: string }) => c.text === 'Trial B')).toMatchObject({
    row: 0,
    column: 5,
    colSpan: 4
  })
  expect(recovered.unassigned).toEqual([])
  const insetRules = rules.map(([x0, , x1]) => [x0, 19.5, x1, 19.5])
  expect(
    refineTable(raw, source, [], [], insetRules).cells.find(
      (c: { text: string }) => c.text === 'Trial A'
    )?.colSpan
  ).toBe(4)
  expect(
    refineTable(raw, source)
      .cells.filter((c: { text: string }) => /^Trial/.test(c.text))
      .every((c: { colSpan: number }) => c.colSpan === 1)
  ).toBe(true)
  const incomplete = refineTable(
    raw,
    source.filter((item) => !(item.text === '%' && item.rect[0] === 405)),
    [],
    [],
    rules
  )
  expect(incomplete.cells.find((c: { text: string }) => c.text === 'Trial A')?.colSpan).toBe(1)
})

it('uses an underline to merge a centered wrapped parent above two leaf columns', () => {
  const raw = {
    cropRect: [0, 0, 300, 110],
    structure: {
      objects: [
        ...[0, 40, 70].map((y) => ({ label: 'table row', rect: [0, y, 300, y + 30] })),
        ...[0, 100, 200].map((x) => ({ label: 'table column', rect: [x, 0, x + 100, 110] })),
        { label: 'table column header', rect: [0, 0, 300, 70] }
      ]
    }
  }
  const source = [
    token('4 (life', 185, 0),
    token('threatening)', 155, 15),
    token('Measure', 5, 45),
    token('No.', 105, 45),
    token('%', 205, 45),
    token('Infection', 5, 75),
    token('1', 105, 75),
    token('0', 205, 75)
  ]
  // Both lines share a center; their source token widths differ.
  source[1].rect[2] = 275
  const rules = [[105, 29.5, 275, 29.5]]
  const result = refineTable(raw, source, [], [], rules)
  expect(
    result.cells.find((c: { text: string }) => c.text === '4 (life threatening)')
  ).toMatchObject({
    row: 0,
    column: 1,
    colSpan: 2
  })
  expect(result.grid.at(-1)).toEqual(['Infection', '1', '0'])
  expect(
    refineTable(raw, source).cells.some(
      (c: { text: string; colSpan: number }) => c.text === '4 (life threatening)' && c.colSpan === 2
    )
  ).toBe(false)
  const overrun = [token('4 (life', 231, 0), token('threatening)', 215, 15), ...source.slice(2)]
  overrun[1].rect[2] = 307
  const wider = {
    ...raw,
    cropRect: [0, 0, 400, 110],
    structure: {
      objects: [...raw.structure.objects, { label: 'table column', rect: [300, 0, 400, 110] }]
    }
  }
  expect(
    refineTable(wider, overrun, [], [], [[105, 29.5, 307, 29.5]]).cells.some(
      (c: { origin: string; colSpan: number }) =>
        c.origin === 'ruled-header-span' && c.colSpan === 2
    )
  ).toBe(false)
})

it('recovers a captioned table title enclosed by full-width rules as one spanning cell', () => {
  const raw = {
    id: 'ruled-title',
    cropRect: [0, 0, 400, 100],
    structure: {
      objects: [
        ...[40, 65].map((y) => ({ label: 'table row', rect: [0, y, 400, y + 20] })),
        ...[0, 100, 200, 300].map((x) => ({ label: 'table column', rect: [x, 40, x + 100, 100] }))
      ]
    }
  }
  const source = [
    token('Prognostic Index', 5, 14),
    ...['Parameter', 'Score one', 'Score two', 'Score three'].map((s, c) =>
      token(s, c * 100 + 5, 44)
    ),
    ...['Age', '60', '40', '20'].map((s, c) => token(s, c * 100 + 5, 69))
  ]
  const captions = [{ page: 1, lines: ['Table 2. Scoring'], rect: [0, -20, 400, -5] }]
  const rules = [
    [0, 10, 400, 10],
    [0, 35, 400, 35]
  ]
  const result = refineTable(raw, source, captions, [], rules)
  expect(result.cells[0]).toMatchObject({
    text: 'Prognostic Index',
    row: 0,
    column: 0,
    colSpan: 4,
    rowSpan: 1
  })
  expect(result.grid[1]).toEqual(['Parameter', 'Score one', 'Score two', 'Score three'])
  expect(result.unassigned).toEqual([])
  for (const incomplete of [rules.slice(0, 1), rules.slice(1)])
    expect(refineTable(raw, source, captions, [], incomplete).repairs).not.toContain(
      'ruled-table-title-recovered'
    )
  expect(refineTable(raw, source, [], [], rules).repairs).not.toContain(
    'ruled-table-title-recovered'
  )
})

it('recovers a ruled section title before an empty interstitial row', () => {
  const raw = {
    id: 'ruled-section-title',
    cropRect: [0, 0, 300, 190],
    structure: {
      objects: [
        ...[
          [0, 20, 300, 40],
          [0, 40, 300, 60],
          [0, 60, 300, 80],
          [0, 80, 300, 100],
          [0, 100, 300, 120],
          [0, 120, 300, 140],
          [0, 140, 300, 145],
          [0, 145, 300, 165],
          [0, 165, 300, 185]
        ].map((rect) => ({ label: 'table row', rect })),
        ...[0, 100, 200].map((x) => ({
          label: 'table column',
          rect: [x, 0, x + 100, 190]
        })),
        { label: 'table column header', rect: [0, 20, 300, 40] },
        // This broad prediction covers the title and the empty spacer row.
        { label: 'table projected row header', rect: [0, 120, 300, 145] }
      ]
    }
  }
  const source = [
    token('Model', 5, 25),
    token('Score A', 105, 25),
    token('Score B', 205, 25),
    token('Alpha', 5, 65),
    token('1', 105, 65),
    token('2', 205, 65),
    token('Qwen2-VL Models', 70, 125),
    token('Qwen2-VL-7B', 5, 150),
    token('30.1', 105, 150),
    token('26.6', 205, 150),
    token('R1-VL-7B', 5, 170),
    token('36.8', 105, 170),
    token('23.6', 205, 170)
  ]
  const result = refineTable(
    raw,
    source,
    [],
    [],
    [
      [0, 120, 300, 120],
      [0, 140, 300, 140]
    ]
  )
  expect(result.cells).toContainEqual(
    expect.objectContaining({
      text: 'Qwen2-VL Models',
      row: 5,
      column: 0,
      colSpan: 3,
      rowSpan: 1
    })
  )
  expect(result.grid[6]).toEqual(['', '', ''])
  expect(result.unassigned).toEqual([])
  expect(result.issues).toEqual([])
  expect(result.repairs).toContain('source-section-span-recovered')
})

it.each(['isolated', 'same-baseline-peer', 'different-baseline-peer'])(
  'recovers only an isolated centered section title in the header band: %s',
  (variant) => {
    const raw = {
      id: 'header-overlap-section-title',
      cropRect: [0, 0, 300, 120],
      structure: {
        objects: [
          { label: 'table row', rect: [0, 20, 300, 35] },
          { label: 'table row', rect: [0, 55, 300, 75] },
          { label: 'table row', rect: [0, 75, 300, 95] },
          ...[0, 100, 200].map((x) => ({
            label: 'table column',
            rect: [x, 0, x + 100, 120]
          })),
          { label: 'table column header', rect: [0, 20, 300, 35] }
        ]
      }
    }
    const source = [
      token('Model', 5, 22),
      token('Score A', 105, 22),
      token('Score B', 205, 22),
      token('Qwen2.5-VL Models', 70, 38),
      token('Qwen2.5-VL-7B', 5, 57),
      token('42.2', 105, 57),
      token('33.8', 205, 57),
      token('+ GRPO', 5, 77),
      token('47.1', 105, 77),
      token('37.1', 205, 77)
    ]
    if (variant !== 'isolated') {
      source.push(token('Peer', 205, variant === 'same-baseline-peer' ? 38 : 48))
    }
    const result = refineTable(
      raw,
      source.map((item, index) => ({
        ...item,
        sourceItem: { pageNumber: 1, index, text: item.text }
      })),
      [],
      [],
      [
        [0, 35, 300, 35],
        [0, 50, 300, 50]
      ]
    )
    if (variant !== 'isolated') {
      expect(result.repairs).not.toContain('unassigned-centered-section-title-recovered')
      expect(result.cells).not.toContainEqual(
        expect.objectContaining({ text: 'Qwen2.5-VL Models', colSpan: 3 })
      )
      return
    }
    expect(result.cells).toContainEqual(
      expect.objectContaining({
        text: 'Qwen2.5-VL Models',
        row: 1,
        column: 0,
        colSpan: 3,
        rowSpan: 1,
        sourceItems: [{ pageNumber: 1, index: 3, text: 'Qwen2.5-VL Models' }]
      })
    )
    expect(result.unassigned).toEqual([])
    expect(result.issues).toEqual([])
    expect(result.repairs).toContain('unassigned-centered-section-title-recovered')
  }
)

it('recovers a ruled parent header and removes the duplicate empty band below its children', () => {
  const source = {
    id: 'parent',
    cropRect: [0, 0, 500, 130],
    structure: {
      objects: [
        ...[
          [35, 48],
          [46.5, 65],
          [70, 90],
          [95, 120]
        ].map(([a, b]) => ({ label: 'table row', rect: [0, a, 500, b] })),
        { label: 'table column header', rect: [0, 35, 500, 65] },
        ...[0, 100, 200, 300, 400].map((x) => ({
          label: 'table column',
          rect: [x, 0, x + 100, 130]
        }))
      ]
    }
  }
  const glyphs = [
    token('Characteristics', 5, 10),
    { ...token('Expression level', 210, 10), rect: [210, 10, 390, 20] },
    ...['Low', 'High', 'χ2', 'P'].map((s, i) => token(s, 105 + i * 100, 41)),
    ...['Age', '12', '20', '0.1', '0.7'].map((s, i) => token(s, 5 + i * 100, 75)),
    ...['Gender', '11', '22', '0.2', '0.8'].map((s, i) => token(s, 5 + i * 100, 100))
  ]
  const result = refineTable(
    source,
    glyphs,
    [],
    [],
    [
      [0, 5, 500, 5],
      [103.5, 32, 465, 32],
      [0, 68, 500, 68]
    ]
  )
  expect(result.unassigned).toEqual([])
  expect(result.grid).toHaveLength(4)
  expect(result.cells.find((c: { text: string }) => c.text === 'Expression level')).toMatchObject({
    row: 0,
    column: 1,
    colSpan: 4
  })
  expect(result.cells.find((c: { text: string }) => c.text === 'Characteristics')).toMatchObject({
    rowSpan: 2
  })
})

it('includes a final wrapped confidence interval only before a closing table rule', () => {
  const source = {
    id: 'interval',
    cropRect: [0, 0, 300, 90],
    structure: {
      objects: [
        { label: 'table row', rect: [0, 5, 300, 30] },
        { label: 'table row', rect: [0, 35, 300, 55] },
        ...[0, 100, 200].map((x) => ({ label: 'table column', rect: [x, 0, x + 100, 90] }))
      ]
    }
  }
  const glyphs = [
    token('Low', 5, 10),
    token('1', 105, 10),
    token('1', 205, 10),
    token('High', 5, 40),
    token('2.764', 105, 40),
    token('1.948', 205, 40),
    token('(1.495–5.110)', 105, 55),
    token('(1.010–3.755)', 205, 55)
  ]
  const result = refineTable(source, glyphs, [], [], [[0, 75, 300, 75]])
  expect(result.grid.at(-1)).toEqual(['High', '2.764 (1.495–5.110)', '1.948 (1.010–3.755)'])
  expect(result.unassigned).toEqual([])
  expect(refineTable(source, glyphs).unassigned).toEqual(['(1.495–5.110)', '(1.010–3.755)'])
})

it('recovers a partially clipped header line including columns without a second line', () => {
  const source = {
    id: 'mixed-header',
    cropRect: [0, 0, 400, 80],
    structure: {
      objects: [
        { label: 'table row', rect: [0, 15.3, 400, 40] },
        { label: 'table row', rect: [0, 45, 400, 70] },
        { label: 'table column header', rect: [0, 15.3, 400, 40] },
        ...[0, 100, 200, 300].map((x) => ({ label: 'table column', rect: [x, 0, x + 100, 80] }))
      ]
    }
  }
  const mixed = [
    token('Disease', 5, 10),
    token('Total number', 105, 10),
    token('Allele counts', 205, 10),
    token('P-value', 305, 10),
    token('of studies', 105, 23),
    token('(cases/controls)', 205, 23),
    token('AAV', 5, 48),
    token('2', 105, 48),
    token('10/20', 205, 48),
    token('0.01', 305, 48)
  ]
  const result = refineTable(source, mixed)
  expect(result.grid).toEqual([
    ['Disease', 'Total number of studies', 'Allele counts (cases/controls)', 'P-value'],
    ['AAV', '2', '10/20', '0.01']
  ])
  expect(result.unassigned).toEqual([])
})

it('anchors verified math-font stars even when their nominal height equals the text', () => {
  const source = {
    id: 'inline-star',
    cropRect: [0, 0, 100, 50],
    structure: {
      objects: [
        { label: 'table row', rect: [0, 0, 100, 20] },
        { label: 'table row', rect: [0, 20, 100, 45] },
        { label: 'table column', rect: [0, 0, 100, 50] }
      ]
    }
  }
  const glyphs = [
    { ...token('Prior', 5, 4), rect: [5, 4, 30, 14] },
    { ...token('DPB1', 5, 24), rect: [5, 24, 30, 34] },
    { ...token('*', 30, 19.5), rect: [30, 19.5, 35, 29.5], inlineSymbol: true },
    { ...token('01:01', 35, 24), rect: [35, 24, 65, 34] }
  ]
  const result = refineTable(source, glyphs)
  expect(result.grid).toEqual([['Prior'], ['DPB1*01:01']])
  expect(result.cells[1].textRuns).toBeUndefined()
  expect(result.unassigned).toEqual([])
  const small = glyphs.map((item) =>
    item.text === '*'
      ? {
          ...item,
          rect: [30, 24, 33, 30],
          height: 6,
          baseline: 30
        }
      : item
  )
  // A genuinely smaller raised marker retains its script style.
  const smallResult = refineTable(source, small)
  expect(smallResult.cells[1].textRuns).toEqual([
    { text: 'DPB1', position: 'normal' },
    { text: '*', position: 'superscript' },
    { text: ' 01:01', position: 'normal' }
  ])
})

it('recovers the first header line into its own column without introducing a new row', () => {
  const result = refineTable(table, items)
  expect(result.grid[0]).toEqual([
    'Variable',
    'Treatment Group A (N=100)',
    'Control Group B (N=50)'
  ])
  expect(result.grid[1]).toEqual(['Response', '40', '10'])
  expect(result.unassigned).toEqual([])
  expect(result.issues).not.toContain('unresolved-multiline-cell')
})

it('keeps text unresolved without model header evidence or when too far from the header', () => {
  const noHeader = {
    ...table,
    structure: { objects: table.structure.objects.filter((o) => o.label !== 'table column header') }
  }
  expect(refineTable(noHeader, items).unassigned).toEqual(['Treatment', 'Control'])
  const distant = items.map((i) =>
    ['Treatment', 'Control'].includes(i.text)
      ? { ...i, rect: [i.rect[0], 0, i.rect[2], 4], baseline: 4, height: 4 }
      : i
  )
  expect(refineTable(table, distant).unassigned).toEqual(['Treatment', 'Control'])
})

it('does not turn an isolated note above the header into a column label', () => {
  const single = items.filter((i) => i.text !== 'Control')
  expect(refineTable(table, single).unassigned).toEqual(['Treatment'])
})

it('recovers wrapped labels without a model header when an adjacent table caption supports the first row', () => {
  const noHeader = {
    ...table,
    structure: { objects: table.structure.objects.filter((o) => o.label !== 'table column header') }
  }
  const caption = { lines: ['Table 1. Baseline characteristics.'], rect: [0, -18, 300, -4] }
  const result = refineTable(noHeader, items, [caption])
  expect(result.grid[0]).toEqual([
    'Variable',
    'Treatment Group A (N=100)',
    'Control Group B (N=50)'
  ])
  expect(result.unassigned).toEqual([])
})

it('preserves a merged section row after expanding the preceding column header', () => {
  const withSpan = {
    ...table,
    structure: {
      objects: [
        ...table.structure.objects,
        { label: 'table projected row header', rect: [0, 55, 300, 75] }
      ]
    }
  }
  const result = refineTable(
    withSpan,
    items.filter((i) => !['40', '10'].includes(i.text))
  )
  expect(result.grid[0][1]).toBe('Treatment Group A (N=100)')
  expect(result.cells.find((c: { row: number }) => c.row === 1)).toMatchObject({
    column: 0,
    colSpan: 3,
    text: 'Response'
  })
})

it('still rejects model spans that combine independently populated source columns or rows', () => {
  for (const rect of [
    [100, 20, 300, 50],
    [100, 20, 200, 75]
  ]) {
    const withSpan = {
      ...table,
      structure: { objects: [...table.structure.objects, { label: 'table spanning cell', rect }] }
    }
    const result = refineTable(withSpan, items)
    expect(result.grid[0]).toEqual([
      'Variable',
      'Treatment Group A (N=100)',
      'Control Group B (N=50)'
    ])
    expect(result.grid[1]).toEqual(['Response', '40', '10'])
    expect(result.issues).toContain(
      rect[2] === 300 ? 'span-conflicts-with-source-columns' : 'span-conflicts-with-source-rows'
    )
  }
})

it('recovers a single wrapped column heading with model header evidence', () => {
  const source = {
    ...table,
    structure: {
      objects: table.structure.objects.map((o) =>
        (o.label === 'table row' && o.rect[1] === 20) || o.label === 'table column header'
          ? { ...o, rect: [0, 20, 300, 35] }
          : o
      )
    }
  }
  const items = [
    token('Author', 5, 22),
    token('N', 105, 22),
    token('Effectiveness', 205, 9),
    token('measure used', 205, 22),
    token('Smith', 5, 60),
    token('25', 105, 60),
    token('QALY', 205, 60)
  ]
  const result = refineTable(source, items)
  expect(result.grid[0]).toEqual(['Author', 'N', 'Effectiveness measure used'])
  expect(result.unassigned).toEqual([])
  const withoutHeader = {
    ...source,
    structure: {
      objects: source.structure.objects.filter((o) => o.label !== 'table column header')
    }
  }
  expect(refineTable(withoutHeader, items).unassigned).toContain('Effectiveness')
})

it('uses closed PDF borders for left-aligned group headers and retains their child columns', () => {
  const source = {
    id: 'ruled-header',
    cropRect: [0, 0, 500, 100],
    structure: {
      objects: [
        ...[0, 20, 40, 60].map((y) => ({ label: 'table row', rect: [0, y, 500, y + 20] })),
        ...[0, 100, 200, 300, 400].map((x) => ({
          label: 'table column',
          rect: [x, 0, x + 100, 100]
        })),
        { label: 'table column header', rect: [0, 0, 500, 40] }
      ]
    }
  }
  const text = [
    token('Pooled estimate', 5, 5),
    token('Heterogeneity', 305, 5),
    ...['SMD', '95% CI', 'p-value', 'I2 (%)', 'Het. p-value'].map((s, i) =>
      token(s, i * 100 + 5, 25)
    ),
    ...[45, 65].flatMap((y) =>
      ['1.91', '1.4, 2.4', '0.001', '61', '0.001'].map((s, i) => token(s, i * 100 + 5, y))
    )
  ]
  // Top and bottom borders are painted as separate touching segments.
  const rules = [
    ...[0, 300, 500].map((x) => [x, 0, x, 20]),
    ...[0, 20].flatMap((y) => [0, 100, 200, 300, 400].map((x) => [x, y, x + 100, y]))
  ]
  const result = refineTable(source, text, [], [], rules)
  expect(
    result.cells.find((c: { text: string; colSpan: number }) => c.text === 'Pooled estimate')
  ).toMatchObject({
    row: 0,
    column: 0,
    colSpan: 3
  })
  expect(
    result.cells.find((c: { text: string; colSpan: number }) => c.text === 'Heterogeneity')
  ).toMatchObject({
    row: 0,
    column: 3,
    colSpan: 2
  })
  expect(result.grid[1]).toEqual(['SMD', '95% CI', 'p-value', 'I2 (%)', 'Het. p-value'])
  expect(result.unassigned).toEqual([])
  // An open box is insufficient evidence to infer left-aligned spanning headers.
  const open = refineTable(
    source,
    text,
    [],
    [],
    rules.filter((r) => r[1] !== 20)
  )
  expect(
    open.cells.find((c: { text: string; colSpan: number }) => c.text === 'Pooled estimate')?.colSpan
  ).not.toBe(3)
})

it('restores a percentage confidence-interval parent header and its wrapped sibling labels', () => {
  const raw = {
    id: 'confidence-parent',
    cropRect: [0, 0, 500, 100],
    structure: {
      objects: [
        { label: 'table row', rect: [0, 25, 500, 45] },
        { label: 'table column header', rect: [0, 25, 500, 45] },
        { label: 'table row', rect: [0, 55, 500, 75] },
        ...[0, 100, 200, 300, 400].map((x) => ({
          label: 'table column',
          rect: [x, 25, x + 100, 100]
        }))
      ]
    }
  }
  const source = [
    token('Relative', 120, 10),
    token('risk', 120, 25),
    { ...token('95% CI for RR', 220, 10), rect: [220, 10, 380, 20] },
    token('P-value', 420, 10),
    token('Lower', 220, 27),
    token('Upper', 320, 27),
    ...['Age', '1.01', '0.98', '1.2', '0.02'].map((s, c) => token(s, c * 100 + 10, 58))
  ]
  const captions = [{ lines: ['Table 4. Factors'], rect: [0, -22, 500, -5] }]
  const result = refineTable(
    raw,
    source,
    captions,
    [],
    [
      [0, 4, 500, 4],
      [0, 48, 500, 48]
    ]
  )
  expect(result.unassigned).toEqual([])
  expect(result.grid.slice(2)).toEqual([['Age', '1.01', '0.98', '1.2', '0.02']])
  expect(result.cells.find((c: { text: string }) => c.text === '95% CI for RR')).toMatchObject({
    row: 0,
    column: 2,
    colSpan: 2
  })
  expect(result.cells.find((c: { text: string }) => c.text === 'Relative risk')).toMatchObject({
    row: 0,
    column: 1,
    rowSpan: 2
  })
  expect(result.cells.find((c: { text: string }) => c.text === 'P-value')).toMatchObject({
    row: 0,
    column: 4,
    rowSpan: 2
  })
  const noHeader = {
    ...raw,
    structure: { objects: raw.structure.objects.filter((o) => o.label !== 'table column header') }
  }
  expect(refineTable(noHeader, source, captions).unassigned).toContain('95% CI for RR')
})

it('preserves a model header rowspan with parenthesized units and a superscript', () => {
  const raw = {
    id: 'header-unit',
    cropRect: [0, 0, 300, 90],
    structure: {
      objects: [
        { label: 'table row', rect: [0, 10, 300, 25] },
        { label: 'table row', rect: [0, 25, 300, 45] },
        { label: 'table row', rect: [0, 50, 300, 75] },
        { label: 'table column header', rect: [0, 10, 300, 45] },
        { label: 'table spanning cell', rect: [0, 10, 100, 45] },
        ...[0, 100, 200].map((x) => ({ label: 'table column', rect: [x, 0, x + 100, 90] }))
      ]
    }
  }
  const source = [
    token('Starting dose', 15, 15),
    { ...token('(mg/m', 30, 30), rect: [30, 30, 60, 40] },
    { ...token('2', 60, 29), rect: [60, 30.25, 65, 36.25], height: 6, baseline: 36.25 },
    { ...token(')', 65, 30), rect: [65, 30, 70, 40] },
    token('Level 1', 110, 30),
    token('Level 2', 210, 30),
    ...['175', '150', '125'].map((s, c) => token(s, c * 100 + 10, 55))
  ]
  const result = refineTable(raw, source)
  expect(
    result.cells.find((c: { text: string }) => c.text === 'Starting dose (mg/m2)')
  ).toMatchObject({ row: 0, column: 0, rowSpan: 2 })
  expect(result.issues).not.toContain('span-conflicts-with-source-rows')
  const independent = source.map((i) => (i.text === '(mg/m' ? { ...i, text: 'Other' } : i))
  expect(refineTable(raw, independent).issues).toContain('span-conflicts-with-source-rows')
})
it.each([15, 20])(
  'keeps repeated mean (SD) suffixes beside a header ending at %s',
  (headerBottom) => {
    const table = {
      cropRect: [0, 0, 400, 80],
      structure: {
        objects: [
          ...[0, 100, 200, 300].map((x) => ({ label: 'table column', rect: [x, 0, x + 100, 80] })),
          { label: 'table column header', rect: [0, 0, 400, headerBottom] },
          { label: 'table row', rect: [0, 0, 400, headerBottom] },
          { label: 'table row', rect: [0, 32, 400, 50] },
          { label: 'table row', rect: [0, 52, 400, 80] }
        ]
      }
    }
    const token = (text: string, c: number, top: number): object => ({
      text,
      rect: [c * 100 + 5, top, c * 100 + 95, top + 10],
      height: 10,
      baseline: top + 10,
      horizontal: true
    })
    const items = [
      ...[1, 2, 3].flatMap((c) => [token(`Arm ${c} (n=10),`, c, 3), token('mean (SD)', c, 17)]),
      ...['Age', '55 (8.8)', '53 (12.5)', '58 (7.5)'].map((s, c) => token(s, c, 35)),
      ...['Score', '6.3 (1.7)', '6.4 (1.3)', '6.5 (0.9)'].map((s, c) => token(s, c, 55))
    ]
    const result = refineTable(table, items)
    expect(result.grid[0]).toEqual([
      '',
      'Arm 1 (n=10), mean (SD)',
      'Arm 2 (n=10), mean (SD)',
      'Arm 3 (n=10), mean (SD)'
    ])
    expect(result.unassigned).toEqual([])
    expect(
      refineTable(
        table,
        items.filter((_, i) => i !== 3 && i !== 5)
      ).grid[0][1]
    ).not.toContain('mean (SD)')
  }
)

it.each([0, 8])('recovers a ruled text header with %s pixels of crop padding', (inset) => {
  const raw = {
    cropRect: [0, 0, 300, 100],
    structure: {
      objects: [
        ...[0, 100, 200].map((x) => ({ label: 'table column', rect: [x, 0, x + 100, 100] })),
        { label: 'table row', rect: [0, 27, 300, 65] },
        { label: 'table row', rect: [0, 65, 300, 100] }
      ]
    }
  }
  const items = [
    token('Point', 5, 12),
    token('Anatomical', 105, 2),
    token('landmark', 105, 14),
    token('Channel', 205, 12),
    token('1. Arm', 5, 35),
    token('Cubital fold', 105, 35),
    token('Below PC2', 205, 35),
    token('2. Leg', 5, 70),
    token('Patella', 105, 70),
    token('Above ST32', 205, 70)
  ]
  const caption = { lines: ['Table 1. Control points'], rect: [0, -20, 290, -5] }
  const result = refineTable(
    raw,
    items,
    [caption],
    [],
    [
      [inset, 0, 300 - inset, 0],
      [inset, 28, 300 - inset, 28],
      [inset, 100, 300 - inset, 100]
    ]
  )
  expect(result.grid).toEqual([
    ['Point', 'Anatomical landmark', 'Channel'],
    ['1. Arm', 'Cubital fold', 'Below PC2'],
    ['2. Leg', 'Patella', 'Above ST32']
  ])
  expect(result.unassigned).toEqual([])
})

it('keeps centered numeric summaries owned by both continuation rows', () => {
  const raw = {
    cropRect: [0, 0, 1200, 180],
    structure: {
      objects: [
        ...Array.from({ length: 12 }, (_, c) => ({
          label: 'table column',
          rect: [c * 100, 0, (c + 1) * 100, 180]
        })),
        { label: 'table column header', rect: [0, 0, 1200, 30] },
        ...[0, 15, 30, 70, 110, 140].map((y, n, ys) => ({
          label: 'table row',
          rect: [0, y, 1200, ys[n + 1] ?? 180]
        }))
      ]
    }
  }
  const field = (text: string, column: number, y: number): ReturnType<typeof token> =>
    token(text, column * 100 + 20, y)
  const taskValues = (y: number, offset: number): Array<ReturnType<typeof token>> =>
    Array.from({ length: 8 }, (_, c) => field(`${offset + c + 1}.0`, c + 1, y))
  const items = [
    field('Method', 0, 3),
    ...Array.from({ length: 11 }, (_, c) => field(`Heading ${c + 1}`, c + 1, 18)),
    field('†', 0, 38),
    ...taskValues(38, 0),
    field('Example', 0, 48),
    field('8.1', 9, 48),
    field('9.1', 10, 48),
    field('-1.0', 11, 48),
    ...taskValues(58, 10),
    ...taskValues(78, 20),
    field('Another', 0, 88),
    field('18.1', 9, 88),
    field('19.1', 10, 88),
    field('-2.0', 11, 88),
    ...taskValues(98, 30),
    field('Single', 0, 125),
    ...Array.from({ length: 11 }, (_, c) => field(`${c + 1}.0`, c + 1, 125))
  ]
  const missingValue = items.filter((item) => !(item.text === '18.0' && item.rect[1] === 58))
  expect(refineTable(raw, missingValue).repairs).not.toContain(
    'native-centered-numeric-rows-recovered'
  )
  const sourcedItems = items.map((item, index) => ({
    ...item,
    sourceItem: { pageNumber: 1, index, text: item.text }
  }))
  const result = refineTable(raw, sourcedItems)
  expect(result.grid.slice(-5)).toEqual([
    ['† Example', '1.0', '2.0', '3.0', '4.0', '5.0', '6.0', '7.0', '8.0', '8.1', '9.1', '-1.0'],
    ['', '11.0', '12.0', '13.0', '14.0', '15.0', '16.0', '17.0', '18.0', '', '', ''],
    [
      'Another',
      '21.0',
      '22.0',
      '23.0',
      '24.0',
      '25.0',
      '26.0',
      '27.0',
      '28.0',
      '18.1',
      '19.1',
      '-2.0'
    ],
    ['', '31.0', '32.0', '33.0', '34.0', '35.0', '36.0', '37.0', '38.0', '', '', ''],
    ['Single', '1.0', '2.0', '3.0', '4.0', '5.0', '6.0', '7.0', '8.0', '9.0', '10.0', '11.0']
  ])
  expect(
    result.cells.find((cell: { text: string }) => cell.text.includes('Example'))
  ).toMatchObject({
    rowSpan: 2
  })
  expect(result.cells.find((cell: { text: string }) => cell.text === '8.1')).toMatchObject({
    rowSpan: 2
  })
  expect(result.unassigned).toEqual([])
  expect(
    result.cells
      .flatMap((cell: { sourceItems?: Array<{ index: number }> }) =>
        (cell.sourceItems ?? []).map((item) => item.index)
      )
      .sort((a, b) => a - b)
  ).toEqual(sourcedItems.map((_, index) => index))
  const singleRowsOnly = sourcedItems.filter((item) => item.rect[1] < 30 || item.rect[1] === 125)
  expect(refineTable(raw, singleRowsOnly).repairs).not.toContain(
    'native-centered-numeric-rows-recovered'
  )
  const tallLabel = structuredClone(sourcedItems)
  const label = tallLabel.find((item) => item.text === 'Example')!
  label.rect[1] = 32
  label.height = 26
  expect(refineTable(raw, tallLabel).repairs).not.toContain(
    'native-centered-numeric-rows-recovered'
  )
})

it('leaves an unproven numeric continuation untouched when prose interrupts ownership', () => {
  const raw = {
    cropRect: [0, 0, 1200, 140],
    structure: {
      objects: [
        ...Array.from({ length: 12 }, (_, c) => ({
          label: 'table column',
          rect: [c * 100, 0, (c + 1) * 100, 140]
        })),
        { label: 'table column header', rect: [0, 0, 1200, 30] },
        ...[0, 15, 30, 70, 100].map((y, n, ys) => ({
          label: 'table row',
          rect: [0, y, 1200, ys[n + 1] ?? 140]
        }))
      ]
    }
  }
  const field = (text: string, column: number, y: number): ReturnType<typeof token> =>
    token(text, column * 100 + 20, y)
  const taskValues = (y: number, offset: number): Array<ReturnType<typeof token>> =>
    Array.from({ length: 8 }, (_, c) => field(`${offset + c + 1}.0`, c + 1, y))
  const items = [
    field('Method', 0, 3),
    ...Array.from({ length: 11 }, (_, c) => field(`Heading ${c + 1}`, c + 1, 18)),
    ...taskValues(38, 0),
    field('Example', 0, 48),
    field('8.1', 9, 48),
    field('9.1', 10, 48),
    field('-1.0', 11, 48),
    ...taskValues(58, 10),
    field('Unrelated note', 0, 112),
    field('Single', 0, 83),
    ...Array.from({ length: 11 }, (_, c) => field(`${c + 1}.0`, c + 1, 83))
  ]
  const result = refineTable(raw, items)
  expect(result.repairs).not.toContain('native-centered-numeric-rows-recovered')
})

function occupiedNativeHeader(): {
  table: { cropRect: number[]; structure: { objects: Array<{ label: string; rect: number[] }> } }
  source: Array<
    ReturnType<typeof token> & { sourceItem: { pageNumber: number; index: number; text: string } }
  >
  rules: number[][]
} {
  const table = {
    cropRect: [0, 0, 450, 100],
    structure: {
      objects: [
        ...[0, 120, 200, 300].map((x, i, cuts) => ({
          label: 'table column',
          rect: [x, 0, cuts[i + 1] ?? 450, 100]
        })),
        { label: 'table column header', rect: [0, 40, 450, 54] },
        { label: 'table row', rect: [0, 40, 450, 60] },
        { label: 'table row', rect: [0, 70, 450, 90] }
      ]
    }
  }
  const fields: Array<[string, number, number, number]> = [
    ['Type', 10, 10, 50],
    ['Quality', 130, 10, 50],
    ['Level', 140, 22, 50],
    ['Effort', 210, 10, 88],
    ['Cost', 230, 22, 30],
    ['Usage', 302, 10, 50],
    ['Alpha', 10, 44, 50],
    ['High', 130, 44, 50],
    ['Low', 210, 44, 50],
    ['Wide', 310, 44, 50],
    ['Beta', 10, 74, 50],
    ['Low', 130, 74, 50],
    ['High', 210, 74, 50],
    ['Local', 310, 74, 50]
  ]
  const source = fields.map(([text, x, y, width], index) => ({
    ...token(text, x, y),
    rect: [x, y, x + width, y + 10],
    sourceItem: { pageNumber: 1, index, text }
  }))
  return {
    table,
    source,
    rules: [
      [0, 5, 450, 5],
      [0, 35, 450, 35],
      [0, 95, 450, 95]
    ]
  }
}

it('keeps wrapped native header leaves in every occupied column', () => {
  const { table, source, rules } = occupiedNativeHeader()
  const result = refineTable(table, source, [], [], rules)
  expect(result.grid).toEqual([
    ['Type', 'Quality Level', 'Effort Cost', 'Usage'],
    ['Alpha', 'High', 'Low', 'Wide'],
    ['Beta', 'Low', 'High', 'Local']
  ])
  expect(
    result.cells
      .flatMap(
        (cell: { sourceItems?: Array<{ index: number; text: string }> }) => cell.sourceItems ?? []
      )
      .sort((a: { index: number }, b: { index: number }) => a.index - b.index)
  ).toEqual(source.map((item) => item.sourceItem))
  expect(result.unassigned).toEqual([])
})

it.each(['crossing value leaf', 'crossing first leaf', 'missing first leaf'])(
  'does not infer independent header ownership from a %s',
  (fault) => {
    const { table, source, rules } = occupiedNativeHeader()
    if (fault === 'crossing value leaf') source[3].rect[2] = 301
    if (fault === 'crossing first leaf') source[0].rect[2] = 121
    if (fault === 'missing first leaf') source.shift()
    const result = refineTable(table, source, [], [], rules)
    expect(result.grid[0]).toEqual(
      fault === 'crossing value leaf'
        ? ['Type', 'Quality Level', '', 'EffortUsage Cost']
        : fault === 'crossing first leaf'
          ? ['', 'Type Quality Level', '', 'Effort Usage Cost']
          : ['', 'Quality Level', 'Effort Cost', 'Usage']
    )
    expect(result.grid.slice(1)).toEqual([
      ['Alpha', 'High', 'Low', 'Wide'],
      ['Beta', 'Low', 'High', 'Local']
    ])
    expect(
      result.cells
        .flatMap(
          (cell: { sourceItems?: Array<{ index: number; text: string }> }) => cell.sourceItems ?? []
        )
        .sort((a: { index: number }, b: { index: number }) => a.index - b.index)
    ).toEqual(source.map((item) => item.sourceItem))
  }
)
