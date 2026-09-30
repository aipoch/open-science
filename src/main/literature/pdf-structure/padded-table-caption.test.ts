import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { associateTableCaptions } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-association.mjs')).href
)
const fixture = (): ReturnType<typeof readPdfFixture> =>
  readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/padded-wide-table-with-close-caption.jsonl')
  )

it('associates a close title using a wide table’s native top rule despite narrow crop padding', () => {
  const f = fixture(),
    original = structuredClone(f)
  const matches = associateTableCaptions(f.page, f.tables, f.captions, f.rules)
  expect(matches.map((m: { caption?: { lines: string[] } }) => m.caption?.lines[0])).toEqual(
    f.captions.map((c: { lines: string[] }) => c.lines[0])
  )
  expect(f).toEqual(original)
})

it.each(['missing-rule', 'excessive-padding', 'embedded-caption'])(
  'leaves a padded caption unresolved with %s',
  (variant) => {
    const f = fixture()
    if (variant === 'missing-rule') f.rules = []
    else if (variant === 'excessive-padding') f.tables[0].rect[0] -= 20
    else f.captions[0].rect[1] = f.tables[0].rect[1] + 1
    expect(associateTableCaptions(f.page, f.tables, f.captions, f.rules)[0].caption).toBeUndefined()
  }
)
