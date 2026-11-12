import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
import fixture from './fixtures/segmented-native-table-titles.json'

const { recoverEquivalentTableCaptionPlans: recover } = await import(
  pathToFileURL(resolve('resources/literature-pdf-equivalent-table-captions.mjs')).href
)
function input(): ReturnType<typeof JSON.parse> {
  const f = structuredClone(fixture)
  const tables = f.tables.map((t, index) => ({
    page: 1,
    cropRect: t.rect.map((v) => v * 1.5),
    sourceViewport: { width: f.page.width * 1.5, height: f.page.height * 1.5, scale: 1.5 },
    caption: index ? undefined : f.captions[0],
    captionIssue: index ? 'shared-table-caption' : undefined,
    futureMetadata: { untouched: true }
  }))
  return { ...f, tables, survivors: new Set([tables[1]]) }
}

it('plans only a missing title on a reported surviving equivalent owner without mutating metadata', () => {
  const f = input(),
    before = structuredClone(f.tables)
  const plans = recover(f.page, f.tables, f.survivors, f.captions, f.rules, [f.page])
  expect(plans).toEqual([{ table: f.tables[1], caption: f.captions[1] }])
  expect(plans[0].table).toBe(f.tables[1])
  expect(plans[0].caption).toBe(f.captions[1])
  expect(f.tables).toEqual(before)
})

it.each([
  'not-reported',
  'no-longer-retained',
  'existing-caption',
  'unknown-diagnostic',
  'null-caption',
  'foreign-viewport',
  'already-owned'
])('does not plan a metadata overwrite with %s', (condition) => {
  const f = input()
  if (condition === 'not-reported') f.survivors.clear()
  if (condition === 'no-longer-retained') f.survivors = new Set([structuredClone(f.tables[1])])
  if (condition === 'existing-caption') f.tables[1].caption = f.captions[0]
  if (condition === 'unknown-diagnostic') f.tables[1].captionIssue = 'future-caption-diagnostic'
  if (condition === 'null-caption') f.tables[1].caption = null
  if (condition === 'foreign-viewport') f.tables[1].sourceViewport.scale = 2
  if (condition === 'already-owned') f.tables[0].caption = f.captions[1]
  expect(recover(f.page, f.tables, f.survivors, f.captions, f.rules, [f.page])).toEqual([])
})

it('becomes a no-op after the existing serializer commits its missing caption', () => {
  const f = input()
  f.tables[1].caption = f.captions[1]
  delete f.tables[1].captionIssue
  expect(recover(f.page, f.tables, f.survivors, f.captions, f.rules, [f.page])).toEqual([])
})
