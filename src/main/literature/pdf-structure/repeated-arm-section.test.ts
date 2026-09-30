import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { readPdfFixture } from './read-fixture'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/omitted-section-before-repeated-arm-measurements.jsonl'
    )
  )

it.each([0, 1])(
  'recovers the omitted section before a repeated pair of measurement arms: %s',
  (index) => {
    const x = fixture().cases[index]
    const r = refineTable(x.table, x.tokens, x.captions, [], x.rules)
    expect(r.unassigned).toEqual([])
    expect(r.grid.every((row: string[]) => row.some(Boolean))).toBe(true)
    const recovered = r.cells.find(
      (c: { text: string }) => c.text === (index === 0 ? 'Domain B' : 'Domain C')
    )
    expect(recovered?.colSpan).toBe(8)
    for (const label of ['Domain A', 'Domain B', 'Domain C', 'Domain D']) {
      expect(r.cells.filter((c: { text: string }) => c.text === label)).toHaveLength(1)
    }
  }
)

it.each(['unindented records', 'unknown arm', 'missing repeated measurements'])(
  'does not recover a section without the repeated record signature: %s',
  (guard) => {
    const x = fixture().cases[0]
    const label = x.tokens.find((i: { text: string }) => i.text === 'Domain B')
    const next = x.tokens.filter(
      (i: { rect: number[] }) => i.rect[1] > label.rect[3] && i.rect[1] < label.rect[3] + 35
    )
    if (guard === 'unindented records') {
      const arm = next.find((i: { text: string }) => i.text === 'Intervention')
      const shift = arm.rect[0] - label.rect[0]
      arm.rect[0] -= shift
      arm.rect[2] -= shift
    }
    if (guard === 'unknown arm')
      next.find((i: { text: string }) => i.text === 'Intervention').text = 'Unobserved'
    if (guard === 'missing repeated measurements')
      x.tokens = x.tokens.filter((i: { text: string }) => !(next.includes(i) && i.text === '±'))
    const r = refineTable(x.table, x.tokens, x.captions, [], x.rules)
    expect(r.unassigned).toContain('Domain B')
  }
)
