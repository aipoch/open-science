import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const moduleUrl = pathToFileURL(
  resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')
).href
const { hasTableEvidence } = await import(moduleUrl)

// Minimized, anonymized outputs from s11914-026-00956-3: page 1 affiliations
// became a 3x1 grid; page 5 prose became an empty 5x9 grid with overlapping columns.
it.each([
  {
    grid: [['contact@example.org'], ['Department A'], ['Department B']],
    issues: ['unassigned-source-text', 'unresolved-multiline-cell']
  },
  {
    grid: Array.from({ length: 5 }, () => Array<string>(9).fill('')),
    issues: ['overlapping-predicted-columns', 'unassigned-source-text']
  }
])('rejects the text-only paper false positive: $issues', (table) => {
  expect(hasTableEvidence(table, undefined)).toBe(false)
})

it('keeps a captionless text table without requiring numeric cells', () => {
  expect(
    hasTableEvidence({
      grid: [
        ['Category', 'Description'],
        ['A', 'First'],
        ['B', 'Second']
      ],
      issues: []
    })
  ).toBe(true)
})

it('keeps supported rows beneath a merged header and allows missing cells', () => {
  expect(
    hasTableEvidence({
      grid: [
        ['Merged heading', '', ''],
        ['A', '10', ''],
        ['B', '', '20']
      ],
      issues: ['unassigned-source-text']
    })
  ).toBe(true)
})

it('requires a reliable caption for a single-column table, and never accepts empty content', () => {
  const caption = { text: 'Table 1. Supported single-column table.' }
  expect(hasTableEvidence({ grid: [['Heading'], ['Value']], issues: [] }, caption)).toBe(true)
  expect(
    hasTableEvidence(
      {
        grid: [
          ['', ''],
          ['', '']
        ],
        issues: []
      },
      caption
    )
  ).toBe(false)
})

it('rejects overlapping or single-row guesses without a caption', () => {
  expect(
    hasTableEvidence({
      grid: [
        ['A', 'B'],
        ['C', 'D']
      ],
      issues: ['overlapping-predicted-columns']
    })
  ).toBe(false)
  expect(hasTableEvidence({ grid: [['A', 'B']], issues: [] })).toBe(false)
})
