import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { captionKind, findCaptionCandidates } = await import(
  pathToFileURL(resolve('resources/literature-pdf-caption-group.mjs')).href
)
const { hasTableEvidence } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-evidence.mjs')).href
)

it.each([
  'Table 1 costs the independent search there.',
  'Tab. 2 costs our bounded computation.',
  'Table S1 costs a separate evaluation.',
  'TABLE II costs these additional operations.'
])('keeps a finite table reference in ordinary prose: %s', (text) => {
  expect(captionKind(text)).toBeUndefined()
})

it.each([
  'Table 1 Costs of independent searches.',
  'Table 1 Costs for a bounded computation.',
  'Table 1 Cost estimates for separate evaluations.',
  'Table 1: Costs the same under each condition.',
  'Table 1. Costs the same under each condition.',
  'Table S1: Costs of independent searches.'
])('preserves genuine cost noun titles and delimited captions: %s', (text) => {
  expect(captionKind(text)).toBe('table')
})

it('does not use a running table reference to keep a folio-only detection', () => {
  const page = {
    pageNumber: 7,
    width: 600,
    height: 800,
    lines: [
      {
        text: 'Table 1 costs the independent search there.',
        x: 70,
        y: 640,
        width: 460,
        height: 10,
        fontSize: 10
      },
      {
        text: 'The next sentence discusses a separate bounded result.',
        x: 70,
        y: 654,
        width: 460,
        height: 10,
        fontSize: 10
      }
    ],
    graphicsBounds: [],
    invalidGraphicsBounds: 0
  }
  const [caption] = findCaptionCandidates([page])
  const table = { grid: [['', '', '7', '', '', '']], cells: [], issues: [], unassigned: [] }
  expect(caption).toBeUndefined()
  expect(hasTableEvidence(table, caption)).toBe(false)
  // Explicitly captioned scalar tables remain eligible through the same gate.
  expect(hasTableEvidence(table, { text: 'Table 1: Costs of independent searches.' })).toBe(true)
})
