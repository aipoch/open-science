import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
it('rebuilds paired treatment statistics without joining P values to effect estimates', () => {
  const item = (
    text: string,
    x: number,
    line: number
  ): {
    text: string
    rect: number[]
    height: number
    baseline: number
    horizontal: boolean
  } => ({
    text,
    rect: [x - 20, line * 16 + 3, x + 20, line * 16 + 15],
    height: 12,
    baseline: line * 16 + 15,
    horizontal: true
  })
  const source = [
    ...Array.from({ length: 7 }, (_, c) => item(c ? `Arm ${c}` : 'Outcome', c * 150 + 75, 0)),
    ...Array.from({ length: 3 }, (_, block) => {
      const r = 1 + block * 4
      return [
        item(`Time ${block}`, 75, r),
        ...Array.from({ length: 6 }, (_, c) => item(String(c + 1), 225 + c * 150, r)),
        item('— mo', 90, r + 1),
        item('P value', 75, r + 2),
        ...Array.from({ length: 3 }, (_, c) => item('0.046', 300 + c * 300, r + 2)),
        item('Relative risk', 75, r + 3),
        ...Array.from({ length: 3 }, (_, c) => item('0.8 (0.6–1.0)', 300 + c * 300, r + 3))
      ]
    }).flat()
  ]
  const raw = {
    id: 'comparison',
    cropRect: [0, 0, 1050, 208],
    structure: {
      objects: [
        ...Array.from({ length: 7 }, (_, c) => ({
          label: 'table column',
          rect: [c * 150, 0, (c + 1) * 150, 208]
        })),
        { label: 'table column header', rect: [0, 0, 1050, 16] },
        { label: 'table row', rect: [0, 0, 1050, 16] },
        { label: 'table row', rect: [0, 16, 1050, 208] }
      ]
    }
  }
  const captions = [{ lines: ['Table 2. Results'], rect: [0, -30, 1050, -10] }]
  const result = refineTable(raw, source, captions)
  expect(result.grid).toHaveLength(10)
  expect(result.grid[1]).toEqual(['Time 0 — mo', '1', '2', '3', '4', '5', '6'])
  expect(result.cells.filter((c: { text: string }) => c.text === '0.046')).toHaveLength(9)
  expect(
    result.cells
      .filter((c: { text: string }) => c.text === '0.046')
      .every((c: { colSpan: number }) => c.colSpan === 2)
  ).toBe(true)
  expect(result.unassigned).toEqual([])
  expect(result.issues).toEqual([])
  const offCenter = source.map((i) =>
    i.text === '0.046' ? { ...i, rect: [i.rect[0] - 75, i.rect[1], i.rect[2] - 75, i.rect[3]] } : i
  )
  expect(refineTable(raw, offCenter, captions).repairs).not.toContain(
    'paired-comparison-statistics-recovered'
  )
})

it.each(['HR', 'Ratio'])(
  'restores repeated estimate and CI columns with a final %s column',
  async (lastHeading) => {
    const token = (
      text: string,
      x: number,
      y: number,
      width = 20
    ): {
      text: string
      rect: number[]
      baseline: number
      height: number
      horizontal: boolean
    } => ({
      text,
      rect: [x, y, x + width, y + 10],
      baseline: y + 10,
      height: 10,
      horizontal: true
    })
    const items = [
      ...Array.from({ length: 4 }, (_, p) => [
        token(p === 3 ? lastHeading : 'HR', 110 + p * 100, 10),
        token('95% CI', 145 + p * 100, 10, 40)
      ]).flat(),
      ...Array.from({ length: 6 }, (_, r) => [
        token(`Group ${r}`, 10, 40 + r * 20, 50),
        ...Array.from({ length: 4 }, (_, p) => [
          token('1.20', 110 + p * 100, 40 + r * 20),
          token('0.79, 2.69', 140 + p * 100, 40 + r * 20, 55)
        ]).flat()
      ]).flat()
    ]
    const raw = {
      cropRect: [0, 0, 500, 160],
      structure: {
        objects: [
          { label: 'table column', rect: [0, 0, 100, 160] },
          ...Array.from({ length: 8 }, (_, c) => ({
            label: 'table column',
            rect: [100 + c * 50, 0, 180 + c * 50, 160]
          })),
          { label: 'table row', rect: [0, 0, 500, 25] },
          ...Array.from({ length: 3 }, (_, r) => ({
            label: 'table row',
            rect: [0, 35 + r * 40, 500, 75 + r * 40]
          })),
          { label: 'table spanning cell', rect: [0, 35, 500, 75] }
        ]
      }
    }
    const result = refineTable(
      raw,
      items,
      [{ lines: ['Table 4. Estimates'], rect: [0, -20, 450, -5] }],
      [],
      [
        [0, 25, 500, 25],
        [0, 155, 500, 155]
      ]
    )
    expect(result.grid).toHaveLength(7)
    expect(result.grid.slice(1)).toEqual(
      Array.from({ length: 6 }, (_, r) => [
        `Group ${r}`,
        ...Array.from({ length: 4 }, () => ['1.20', '0.79, 2.69']).flat()
      ])
    )
    expect(result.unassigned).toEqual([])
    const section = [
      token('Outcome', 10, 25, 50),
      { ...token('d', 61, 24.5, 4), height: 6, baseline: 30.5, rect: [61, 24.5, 65, 30.5] }
    ]
    const marked = refineTable(
      raw,
      [...items, ...section],
      [{ lines: ['Table 4. Estimates'], rect: [0, -20, 450, -5] }],
      [],
      [
        [0, 25, 500, 25],
        [0, 155, 500, 155]
      ]
    )
    expect(marked.grid).toHaveLength(8)
    expect(marked.grid[1][0]).toBe('Outcome d')
    expect(marked.grid.slice(2)).toEqual(result.grid.slice(1))
    // Incomplete source records must not be filled with guessed values.
    const { recoverRepeatedIntervalGrid } = await import(
      pathToFileURL(resolve('resources/pdf-structure/literature-pdf-record-grid.mjs')).href
    )
    const missing = items.filter((i) => !(i.rect[0] === 140 && i.rect[1] === 40))
    expect(
      recoverRepeatedIntervalGrid(
        raw,
        missing,
        [{ lines: ['Table 4. Estimates'] }],
        [
          [0, 25, 500, 25],
          [0, 155, 500, 155]
        ]
      )
    ).toBeUndefined()
  }
)
