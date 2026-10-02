import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { readPdfFixture } from './read-fixture'

const owner = await import(
  pathToFileURL(
    resolve(
      process.env.PDF_NATIVE_CANDIDATE_MODULE ??
        'resources/pdf-structure/literature-pdf-native-table-candidates.mjs'
    )
  ).href
)
const fixture = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids', `${name}.jsonl`)
  )
const title = (x: ReturnType<typeof fixture>): ReturnType<typeof JSON.parse> =>
  owner.recoverEnclosedTableDescriptionCaption?.(x.table, x.items, x.rules, x.caption, x.scale)
const attachment = (x: ReturnType<typeof fixture>): boolean =>
  owner.isExternalAttachmentTableRegion?.(x.table, x.items, x.rules, x.caption, x.scale) ?? false

it('owns all description lines inside the numbered native frame', () => {
  const x = fixture('enclosed-description-above-separate-table-header')
  expect(title(x)?.lines).toEqual([
    'Table 4',
    'Comparison of recorded quantities',
    'between the scheduled groups'
  ])
  expect(title(x)?.rect).toEqual([70, 104, 330, 136])
})
it.each([
  'side missing',
  'header divider missing',
  'off centre',
  'foreign font',
  'numeric record',
  'no records',
  'already descriptive'
])('rejects a proposed enclosed title when %s', (variant) => {
  const x = fixture('enclosed-description-above-separate-table-header')
  if (variant === 'side missing') x.rules.pop()
  if (variant === 'header divider missing') x.rules.splice(2, 1)
  if (variant === 'off centre') x.items[2].rect = [42, 128, 150, 136]
  if (variant === 'foreign font') x.items[1].height = 11
  if (variant === 'numeric record') x.items[1].text = 'Alpha 18 27 36'
  if (variant === 'no records') x.items = x.items.slice(0, 4)
  if (variant === 'already descriptive') x.caption.lines.push('Existing source description')
  expect(title(x)).toBeUndefined()
})
it('rejects an external attachment description mistaken for a local table', () => {
  expect(attachment(fixture('external-attachment-description-with-file-type-label'))).toBe(true)
})
it.each([
  'no section',
  'no file label',
  'local border',
  'numeric records',
  'unrelated source',
  'ordinary title'
])('preserves a candidate without external attachment proof: %s', (variant) => {
  const x = fixture('external-attachment-description-with-file-type-label')
  if (variant === 'no section') x.items.shift()
  if (variant === 'no file label')
    x.items = x.items.filter((i: { text: string }) => i.text !== '(XLS)')
  if (variant === 'local border') x.rules.push([40, 220, 360, 220])
  if (variant === 'numeric records')
    x.items.push(
      { text: '18 (2.1)', horizontal: true, height: 8, rect: [180, 220, 225, 228] },
      { text: '27 (3.2)', horizontal: true, height: 8, rect: [260, 220, 305, 228] }
    )
  if (variant === 'unrelated source')
    x.items.push({
      text: 'Other source paragraph.',
      horizontal: true,
      height: 8,
      rect: [44, 250, 230, 258]
    })
  if (variant === 'ordinary title') x.items[3].text = 'Table 3 Supplementary summaries'
  expect(attachment(x)).toBe(false)
})
