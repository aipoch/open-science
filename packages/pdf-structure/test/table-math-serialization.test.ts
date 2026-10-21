import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)
let tokenIndex = 0
const token = (text: string, rect: number[]): object => ({
  text,
  rect,
  height: rect[3] - rect[1],
  baseline: rect[3],
  horizontal: true,
  sourceItem: { pageNumber: 1, index: tokenIndex++, text }
})

it('does not silently trust a stacked symbolic fraction inside a table inequality', () => {
  const table = {
    cropRect: [0, 0, 120, 40],
    structure: {
      objects: [
        { label: 'table row', rect: [0, 0, 120, 40] },
        { label: 'table column', rect: [0, 0, 120, 40] }
      ]
    }
  }
  const result = refineTable(table, [
    token('1 <', [5, 15, 25, 25]),
    token('β', [35, 7, 42, 17]),
    token('α', [35, 26, 42, 36]),
    token('< 2', [52, 15, 72, 25])
  ])
  expect(result.issues).toContain('native-table-structure-ambiguous')
  expect(result.reviewCandidate).toBe(false)
})
