import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { readPdfFixture } from './read-fixture'
const { refineTable, hasTableEvidence } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
it.each([
  ['numbered-clinic-affiliations', false],
  ['wrapped-institution-affiliations', false],
  ['numbered-statistical-parameter-prose', false],
  ['comma-separated-bibliography-columns', false],
  ['abbreviation-list-with-empty-model-column', false],
  ['sparse-model-columns-over-body-prose', false],
  ['unlabelled-appendix-membership-directory', true]
])('checks source table evidence for %s', (name, accepted) => {
  const f = readPdfFixture(resolve(`src/main/literature/pdf-structure/fixtures/${name}.jsonl`))
  const table = refineTable(f.table, f.items, f.captions, f.notes, f.rules)
  expect(hasTableEvidence(table, undefined, f.items)).toBe(accepted)
})
