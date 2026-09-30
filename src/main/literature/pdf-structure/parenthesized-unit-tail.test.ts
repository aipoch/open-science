import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { mergeWrappedStubTails } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-row-repair.mjs')).href
)
const fixture = (): ReturnType<typeof readPdfFixture> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/repeated-parenthesized-unit-after-value-row.jsonl'
    )
  )
it('keeps a detached parenthesized unit with its populated record when independent peers use that suffix', () => {
  const f = fixture(),
    before = structuredClone(f),
    repairs: string[] = []
  mergeWrappedStubTails({ ...f, repairs })
  expect(f.rows).toHaveLength(before.rows.length - 1)
  expect(f.rows[0].rect[3]).toBe(before.rows[1].rect[3])
  expect(f.rows.slice(1)).toEqual(before.rows.slice(2))
  expect(f.items).toEqual(before.items)
  expect(repairs).toEqual(['wrapped-comparison-record-recovered'])
})
it.each([
  'missing unit peer',
  'incomplete preceding values',
  'incomplete following values',
  'different tail font',
  'different alignment',
  'native separator',
  'independent tail values',
  'nonunit subgroup'
])('keeps the unit band separate with %s', (kind) => {
  const f = fixture()
  const target = f.items
    .filter((i: { text: string }) => i.text === '(IU/day)')
    .sort((a: { baseline: number }, b: { baseline: number }) => a.baseline - b.baseline)[0]
  if (kind === 'missing unit peer')
    f.items.find((i: { text: string }) => i.text === 'Exposure intake (diet) (IU/day)').text =
      'Exposure intake (diet)'
  if (kind === 'incomplete preceding values')
    f.items = f.items.filter((i: { text: string }) => !i.text.includes('3733'))
  if (kind === 'incomplete following values')
    f.items = f.items.filter((i: { text: string }) => !i.text.includes('29.3'))
  if (kind === 'different tail font') target.height *= 1.2
  if (kind === 'different alignment') {
    target.rect[0] += 5
    target.rect[2] += 5
  }
  if (kind === 'native separator')
    f.rules.push([76, target.rect[1] - 0.5, 730, target.rect[1] - 0.5])
  if (kind === 'independent tail values')
    f.items.push({
      ...structuredClone(target),
      text: '7',
      rect: [390, target.rect[1], 400, target.rect[3]]
    })
  if (kind === 'nonunit subgroup') target.text = '(other)'
  const rows = structuredClone(f.rows),
    repairs: string[] = []
  mergeWrappedStubTails({ ...f, repairs })
  expect(f.rows).toEqual(rows)
  expect(repairs).toEqual([])
})
