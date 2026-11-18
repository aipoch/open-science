import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { resolve } from './paths'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)
const fixture = JSON.parse(
  await readFile(resolve('test/fixtures/narrative-record-boundary.json'), 'utf8')
)
const refine = (value: typeof fixture): ReturnType<typeof JSON.parse> =>
  refineTable(
    structuredClone(value.model),
    structuredClone(value.tokens),
    value.captions,
    value.notes,
    value.rules,
    value.observedRuns
  )

const owner = (result: ReturnType<typeof refine>, text: string): ReturnType<typeof JSON.parse> =>
  result.cells.find((cell: { sourceItems?: { text: string }[] }) =>
    cell.sourceItems?.some((source) => source.text === text)
  )

it('keeps the complete narrative with its independently aligned record', () => {
  const result = refine(fixture)
  expect(owner(result, 'final clause.').row).toBe(owner(result, 'Description A').row)
  expect(owner(result, 'final clause.').row).not.toBe(owner(result, 'Description B').row)
  const sources = result.cells.flatMap(
    (cell: { sourceItems?: unknown[] }) => cell.sourceItems ?? []
  )
  expect(sources).toHaveLength(fixture.tokens.length)
  expect(new Set(sources.map((source: { index: number }) => source.index)).size).toBe(
    sources.length
  )
  expect(sources.sort((a: { index: number }, b: { index: number }) => a.index - b.index)).toEqual(
    fixture.tokens.map((token: { sourceItem: unknown }) => token.sourceItem)
  )
  expect(result.unassigned).toEqual([])
})

it('checks the complete inventory when another independent record follows', () => {
  const changed = structuredClone(fixture)
  changed.model.cropRect[3] = 632
  for (const object of changed.model.structure.objects)
    if (object.label === 'table column') object.rect[3] = 552
  changed.model.structure.objects.push({
    label: 'table row',
    score: 1,
    rect: [0, 407, 500, 542]
  })
  for (let column = 0; column < 5; column++) {
    const text = column === 4 ? 'Description D' : `Value D${column}`
    changed.tokens.push({
      text,
      horizontal: true,
      height: 10,
      baseline: 496,
      rect: [column * 100 + 5, 486, column * 100 + 85, 496],
      sourceItem: { pageNumber: 1, index: 25 + column, text }
    })
  }
  const result = refine(changed)
  expect(owner(result, 'final clause.').row).toBe(owner(result, 'Description A').row)
  expect(owner(result, 'Description D').row).not.toBe(owner(result, 'Description C').row)
})

it.each([
  'missing record',
  'insufficient records',
  'missing leaf',
  'duplicate source',
  'partial source',
  'literal mismatch',
  'different height',
  'broken cadence',
  'foreign overlap',
  'separator rule',
  'model span',
  'unfinished clause',
  'parallel continuation'
])('retains model boundaries when the complete narrative inventory is absent: %s', (fault) => {
  const changed = structuredClone(fixture)
  const tail = changed.tokens.find((token: { text: string }) => token.text === 'final clause.')
  if (fault === 'missing record' || fault === 'insufficient records')
    changed.tokens = changed.tokens.filter((token: { baseline: number }) => token.baseline !== 364)
  if (fault === 'insufficient records')
    changed.model.structure.objects = changed.model.structure.objects.filter(
      (object: { label: string; rect: number[] }) =>
        !(object.label === 'table row' && object.rect[1] === 275)
    )
  if (fault === 'missing leaf')
    changed.tokens = changed.tokens.filter(
      (token: { baseline: number; rect: number[] }) =>
        !(token.baseline === 232 && token.rect[0] === 305)
    )
  if (fault === 'duplicate source') tail.sourceItem.index = changed.tokens[0].sourceItem.index
  if (fault === 'partial source') tail.sourceSegment = { ...tail.sourceItem, start: 0, end: 5 }
  if (fault === 'literal mismatch') tail.sourceItem.text = 'Other text'
  if (fault === 'different height') tail.height = 8
  if (fault === 'broken cadence') {
    tail.baseline -= 2
    tail.rect[1] -= 2
    tail.rect[3] -= 2
  }
  if (fault === 'foreign overlap' || fault === 'parallel continuation')
    changed.tokens.push({
      ...tail,
      text: 'Separate field.',
      sourceItem: { pageNumber: 1, index: 100, text: 'Separate field.' },
      baseline: fault === 'foreign overlap' ? 218 : 220,
      rect: fault === 'foreign overlap' ? [405, 208, 485, 218] : [305, 210, 385, 220]
    })
  if (fault === 'separator rule') changed.rules.push([0, 221, 500, 221])
  if (fault === 'model span')
    changed.model.structure.objects.push({
      label: 'table spanning cell',
      score: 1,
      rect: [400, 10, 500, 220]
    })
  if (fault === 'unfinished clause') {
    tail.text = 'final clause'
    tail.sourceItem.text = tail.text
  }
  expect(refine(changed).repairs).not.toContain('complete-narrative-record-boundary-recovered')
})
