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

const wrappedUnitPeersFixture = (): ReturnType<typeof readPdfFixture> => {
  const rows = [
      { rect: [0, 10, 400, 24], origin: 'model' },
      { rect: [0, 24, 400, 38], origin: 'model' },
      { rect: [0, 40, 400, 68], origin: 'model' },
      { rect: [0, 70, 400, 98], origin: 'model' }
    ],
    items: {
      text: string
      rect: number[]
      baseline: number
      height: number
      horizontal: boolean
    }[] = []
  const add = (text: string, x: number, baseline: number): void => {
    items.push({
      text,
      rect: [x, baseline - 10, x + 55, baseline],
      baseline,
      height: 10,
      horizontal: true
    })
  }
  const record = (text: string, baseline: number): void => {
    add(text, 5, baseline)
    for (const x of [110, 210, 310]) add('12', x, baseline)
  }
  record('Measure A', 20)
  add('(aU/day)', 15, 32)
  record('Measure B', 50)
  add('(aU/day)', 15, 62)
  record('Measure C', 80)
  add('(aU/day)', 15, 92)
  return {
    rows,
    items,
    columnRects: [0, 100, 200, 300].map((x) => [x, 0, x + 100, 120]),
    rules: [],
    repairs: []
  }
}

it('joins an indented unit only when two intact native wrapped records prove its alignment and leading', () => {
  const f = wrappedUnitPeersFixture(),
    originalItems = structuredClone(f.items)
  mergeWrappedStubTails(f)
  expect(f.rows).toHaveLength(3)
  expect(f.repairs).toEqual(['wrapped-comparison-record-recovered'])
  expect(f.items).toEqual(originalItems)
})

it.each([
  'inline peers',
  'single wrapped peer',
  'peer indentation',
  'peer leading',
  'peer font',
  'incomplete peer values',
  'peer separator',
  'repeated peer label'
])('rejects an indented unit without independent native wrapped proof: %s', (kind) => {
  const f = wrappedUnitPeersFixture(),
    suffixes = f.items.filter((i: { text: string }) => i.text === '(aU/day)')
  if (kind === 'inline peers')
    for (let n = 1; n < suffixes.length; n++) {
      suffixes[n].baseline -= 12
      suffixes[n].rect[1] -= 12
      suffixes[n].rect[3] -= 12
      suffixes[n].rect[0] = 65
      suffixes[n].rect[2] = 95
    }
  if (kind === 'single wrapped peer') suffixes[2].text = '(bU/day)'
  if (kind === 'peer indentation') {
    suffixes[2].rect[0] += 3
    suffixes[2].rect[2] += 3
  }
  if (kind === 'peer leading') {
    suffixes[2].baseline += 3
    suffixes[2].rect[1] += 3
    suffixes[2].rect[3] += 3
  }
  if (kind === 'peer font') suffixes[2].height = 12
  if (kind === 'incomplete peer values')
    f.items = f.items.filter(
      (i: { baseline: number; rect: number[] }) => !(i.baseline === 80 && i.rect[0] === 310)
    )
  if (kind === 'peer separator') f.rules.push([0, 81, 400, 81])
  if (kind === 'repeated peer label')
    f.items.find((i: { text: string }) => i.text === 'Measure C').text = 'Measure B'
  const rows = structuredClone(f.rows)
  mergeWrappedStubTails(f)
  expect(f.rows).toEqual(rows)
  expect(f.repairs).toEqual([])
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
