import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { associateFigures } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-association.mjs')).href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/flowchart-below-numbered-publisher-rule.jsonl'
    )
  )

it('excludes a numbered publisher head while retaining the top enrollment node and both branches', () => {
  const f = fixture()
  const [result] = associateFigures(f.page, f.captions, [], f.rules)
  expect(result.rect[1]).toBeGreaterThan(44)
  expect(result.rect[1]).toBeLessThan(54)
  expect(result.rect[0]).toBeLessThan(47)
  expect(result.rect[2]).toBeGreaterThan(548)
  expect(result.rect[3]).toBeGreaterThan(499)
})

it.each(['missing rule', 'short rule', 'non-numeric label'])(
  'does not infer a publisher band without independent evidence: %s',
  (guard) => {
    const f = fixture()
    if (guard === 'missing rule') f.page.marginRuleBounds = []
    if (guard === 'short rule') f.page.marginRuleBounds[0][2] = 0.3
    if (guard === 'non-numeric label') f.page.lines[0].text = 'A |'
    const [result] = associateFigures(f.page, f.captions, [], f.rules)
    expect(result.rect[1]).toBeLessThan(35)
  }
)
