/* eslint-disable @typescript-eslint/explicit-function-return-type -- inferred anonymous fixture types */
import { expect, it } from 'vitest'
import { parsePdfStructureResult } from '../src/result.js'

function fixture() {
  const ambiguity = { code: 'native-table-structure-ambiguous', detail: 'Unreliable structure' }
  const sources = ['x', 'y'].map((text, index) => ({ pageNumber: 1, index, text }))
  const identity = {
    extractionId: 'captionless-body',
    engineFingerprint: 'b'.repeat(64),
    sourceChecksum: 'c'.repeat(64),
    sourceSizeBytes: 100,
    requestedPages: [1]
  }
  const body = {
    kind: 'math-table',
    sourceItems: sources,
    boundary: {
      kind: 'three-rail',
      pageNumber: 1,
      scale: 1,
      coordinateSystem: 'pdfjs-upright-points',
      rules: [15, 30, 60].map((y, operatorIndex) => ({
        operatorIndex,
        segment: [15, y, 70, y],
        width: 0.5,
        clip: [0, 0, 100, 100]
      })),
      raster: { width: 280, height: 240, sha256: 'a'.repeat(64) }
    }
  }
  const element = {
    id: 'native-body',
    kind: 'table',
    regions: [{ page: 1, x: 0.1, y: 0.1, width: 0.7, height: 0.6 }],
    thumbnailId: 'native-body',
    nativeBody: body,
    table: {
      rowCount: 1,
      columnCount: 2,
      cells: sources.map((source, column) => ({
        row: 0,
        column,
        rowSpan: 1,
        columnSpan: 1,
        text: source.text,
        textRuns: [{ text: source.text, position: 'subscript' }],
        sourceItems: [source],
        regions: [{ page: 1, x: 0.2 + column * 0.2, y: 0.35, width: 0.1, height: 0.1 }]
      })),
      unassignedText: [],
      issues: [ambiguity]
    },
    issues: [ambiguity]
  }
  const value = {
    schemaVersion: 1,
    ...identity,
    pageCount: 1,
    processedPages: [1],
    pages: [{ page: 1, width: 100, height: 100, rotation: 0 }],
    elements: [element],
    thumbnails: [
      {
        id: 'native-body',
        mimeType: 'image/png',
        width: 280,
        height: 240,
        sizeBytes: 100,
        sha256: 'a'.repeat(64)
      }
    ],
    navigation: [],
    issues: []
  }
  return { identity, value, element, body }
}

it('retains an explicitly bounded captionless mathematical body and its unreliable grid', () => {
  const f = fixture()
  expect(parsePdfStructureResult(JSON.parse(JSON.stringify(f.value)), f.identity)).toEqual(f.value)
})

it.each([
  [
    'missing boundary',
    (f: ReturnType<typeof fixture>) => delete (f.body as { boundary?: unknown }).boundary
  ],
  ['other page', (f: ReturnType<typeof fixture>) => (f.body.boundary.pageNumber = 2)],
  ['other scale', (f: ReturnType<typeof fixture>) => (f.body.boundary.scale = 1.5)],
  [
    'unknown coordinates',
    (f: ReturnType<typeof fixture>) => (f.body.boundary.coordinateSystem = 'unknown')
  ],
  [
    'duplicate operator',
    (f: ReturnType<typeof fixture>) => (f.body.boundary.rules[1].operatorIndex = 0)
  ],
  [
    'reversed operators',
    (f: ReturnType<typeof fixture>) => (f.body.boundary.rules[2].operatorIndex = 0)
  ],
  [
    'nonfinite segment',
    (f: ReturnType<typeof fixture>) => (f.body.boundary.rules[0].segment[0] = NaN)
  ],
  [
    'open side alignment',
    (f: ReturnType<typeof fixture>) => (f.body.boundary.rules[1].segment[0] = 16)
  ],
  ['diagonal rail', (f: ReturnType<typeof fixture>) => (f.body.boundary.rules[1].segment[3] = 31)],
  ['zero width', (f: ReturnType<typeof fixture>) => (f.body.boundary.rules[0].width = 0)],
  ['clipped stroke', (f: ReturnType<typeof fixture>) => (f.body.boundary.rules[0].clip[1] = 15)],
  [
    'wrong PNG hash',
    (f: ReturnType<typeof fixture>) => (f.body.boundary.raster.sha256 = 'd'.repeat(64))
  ],
  ['wrong PNG width', (f: ReturnType<typeof fixture>) => (f.body.boundary.raster.width = 281)],
  ['admitted table', (f: ReturnType<typeof fixture>) => (f.element.table.issues = [])],
  ['admitted element', (f: ReturnType<typeof fixture>) => (f.element.issues = [])],
  [
    'borrowed origin',
    (f: ReturnType<typeof fixture>) =>
      (f.body.sourceItems[0] = { pageNumber: 1, index: 4, text: 'x' })
  ],
  [
    'changed literal',
    (f: ReturnType<typeof fixture>) =>
      (f.body.sourceItems = [{ pageNumber: 1, index: 0, text: 'z' }, f.body.sourceItems[1]])
  ],
  [
    'ordinary grid without math evidence',
    (f: ReturnType<typeof fixture>) =>
      (f.element.table.cells = f.element.table.cells.map((c) => ({
        ...c,
        textRuns: [{ text: c.text, position: 'normal' }]
      })))
  ],
  [
    'captioned proof using the new branch',
    (f: ReturnType<typeof fixture>) =>
      Object.assign(f.element, {
        caption: {
          text: 'Table 1',
          regions: [{ page: 1, x: 0.1, y: 0.8, width: 0.6, height: 0.1 }]
        }
      })
  ],
  [
    'algorithm using the new boundary',
    (f: ReturnType<typeof fixture>) => (f.body.kind = 'algorithm')
  ]
])('rejects the captionless contract with %s', (_name, mutate) => {
  const f = fixture()
  mutate(f)
  expect(() => parsePdfStructureResult(JSON.parse(JSON.stringify(f.value)), f.identity)).toThrow()
})
