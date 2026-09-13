import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)

it('recovers duplicated centered columns and shared ratios from repeated ruled numeric rows', () => {
  const item = (text: string, x: number, y: number, w = 20): object => ({
    text,
    rect: [x - w / 2, y, x + w / 2, y + 10],
    baseline: y + 10,
    height: 10,
    horizontal: true
  })
  const table = {
    id: 'centered',
    cropRect: [0, 0, 600, 245],
    structure: {
      objects: [
        ...[
          [0, 250],
          [250, 355],
          [345, 420],
          [395, 495],
          [495, 600]
        ].map(([x, end]) => ({ label: 'table column', rect: [x, 0, end, 245] })),
        { label: 'table column header', rect: [0, 0, 600, 30] },
        ...Array.from({ length: 14 }, (_, r) => ({
          label: 'table row',
          rect: [0, r * 17, 600, r * 17 + 17]
        }))
      ]
    }
  }
  const source = [item('Arm A', 300, 5, 40), item('Arm B', 420, 5, 40), item('Arm C', 540, 5, 40)]
  for (let r = 0; r < 9; r++)
    source.push(
      item(`Outcome ${r}`, 80, 40 + r * 16, 100),
      item(r === 8 ? '–' : '104', 300, 40 + r * 16),
      item('27.7 ± 11.3', 420, 40 + r * 16, 55),
      item('130', 540, 40 + r * 16)
    )
  source.push(
    item('Ratio', 80, 190, 80),
    item('(A + B)/A', 80, 204, 80),
    item('1.01', 360, 204),
    item('90% CI', 80, 220, 80),
    item('(0.91–1.11)', 360, 220, 55)
  )
  const captions = [{ lines: ['Table 2. Concentrations'], rect: [0, -25, 600, -10] }]
  const rules = [
    [0, 0, 600, 0],
    [0, 30, 600, 30],
    [0, 245, 600, 245]
  ]
  const result = refineTable(table, source, captions, [], rules)
  expect(result.grid[0]).toEqual(['', 'Arm A', 'Arm B', 'Arm C'])
  expect(result.grid[9]).toEqual(['Outcome 8', '–', '27.7 ± 11.3', '130'])
  expect(result.cells.find((c: { text: string }) => c.text === '1.01')).toMatchObject({
    colSpan: 2,
    column: 1
  })
  expect(result.unassigned).toEqual([])
  expect(refineTable(table, source, [], [], rules).repairs).not.toContain(
    'centered-value-grid-recovered'
  )
})
