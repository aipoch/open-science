import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
type Fixture = {
  table: {
    id: string
    cropRect: number[]
    structure: { objects: { label: string; rect: number[] }[] }
  }
  tokens: { text: string; rect: number[]; baseline: number; height: number; horizontal: boolean }[]
  rules: number[][]
}
function fixture(): Fixture {
  const labels = [
    ['Method', 'Risk Ratio', 'P Value'],
    ['First source heading', '', ''],
    ['continued heading', '', ''],
    ['Choice A', '1.00', '…'],
    ['Choice B', '0.69 (0.39, 1.22)', '.20'],
    ['Second source heading', '', ''],
    ['continued heading', '', ''],
    ['Choice A', '1.00', '…'],
    ['Choice B', '0.89 (0.67, 1.18)', '.43']
  ]
  const tokens = labels.flatMap((r, n) =>
    r.flatMap((text, c) =>
      text
        ? [
            {
              text,
              rect: [
                c * 150 + 5 + (c === 0 && [2, 3, 4, 6, 7, 8].includes(n) ? 10 : 0),
                n * 15 + 5,
                c * 150 + 140,
                n * 15 + 15
              ],
              baseline: n * 15 + 15,
              height: 10,
              horizontal: true
            }
          ]
        : []
    )
  )
  return {
    table: {
      id: 'page-1-table-1',
      cropRect: [0, 0, 450, 140],
      structure: {
        objects: [0, 1, 2]
          .map((c) => ({ label: 'table column', rect: [c * 150, 0, (c + 1) * 150, 140] }))
          .concat(
            [0, 1, 2, 3, 4, 5].map((n) => ({
              label: 'table row',
              rect: [0, n * 23, 450, (n + 1) * 23]
            }))
          )
      }
    },
    tokens,
    rules: [
      [0, 0, 450, 0],
      [0, 15, 450, 15],
      [0, 140, 450, 140]
    ]
  }
}
it('keeps both wrapped risk ratio section titles separate from their measured records', () => {
  const f = fixture(),
    t = refineTable(f.table, f.tokens, [], [], f.rules)
  expect(
    t.grid.some(
      (r: string[]) =>
        r[0] === 'Second source heading continued heading' && r[1] === '' && r[2] === ''
    )
  ).toBe(true)
  expect(t.grid.filter((r: string[]) => r[0] === 'Choice A')).toHaveLength(2)
  expect(t.unassigned).toEqual([])
})

const { recoverClinicalCountSections } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-sectional-records.mjs')).href
)
it.each(['ratio heading', 'native closure', 'independent section', 'probability ownership'])(
  'declines wrapped ratio sections without %s',
  (kind) => {
    const f = fixture()
    if (kind === 'ratio heading')
      f.tokens.find((i) => i.text === 'Risk Ratio')!.text = 'Other value'
    if (kind === 'native closure') f.rules.pop()
    if (kind === 'independent section')
      f.tokens.find((i) => i.text === 'Second source heading')!.rect[0] += 10
    if (kind === 'probability ownership') f.tokens.find((i) => i.text === '.20')!.text = 'prose'
    expect(recoverClinicalCountSections(f.table, f.tokens, f.rules)).toBeUndefined()
  }
)
