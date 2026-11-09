import { describe, expect, it } from 'vitest'
import {
  parsePdfStructureResult,
  type PdfStructureIdentity,
  type PdfStructureResult
} from '../src/result.js'
const content = Buffer.from('%PDF-1.7\nimmutable test source\n')
const checksum = 'a'.repeat(64)
const fingerprint = 'b'.repeat(64)
const resultFor = (identity: PdfStructureIdentity): PdfStructureResult => ({
  schemaVersion: 1,
  ...structuredClone(identity),
  pageCount: 10,
  processedPages: [...identity.requestedPages],
  pages: identity.requestedPages.map((page) => ({ page, width: 600, height: 800, rotation: 0 })),
  elements: [],
  thumbnails: [],
  navigation: [],
  issues: []
})

describe('PDF result boundary', () => {
  const identity: PdfStructureIdentity = {
    extractionId: 'extraction-1',
    sourceChecksum: checksum,
    sourceSizeBytes: content.length,
    engineFingerprint: fingerprint,
    requestedPages: [1]
  }
  const grouped = (): PdfStructureResult => {
    const result = resultFor(identity)
    result.elements.push({
      id: 'table-1',
      kind: 'table',
      regions: [{ page: 1, x: 0.1, y: 0.1, width: 0.8, height: 0.8 }],
      caption: {
        text: 'Table 1. Independent sections.',
        regions: [{ page: 1, x: 0.1, y: 0.1, width: 0.8, height: 0.05 }]
      },
      tableParts: [0.2, 0.6].map((y, i) => ({
        title: `${String.fromCharCode(65 + i)}. Group`,
        regions: [{ page: 1, x: 0.2, y, width: 0.5, height: 0.2 }],
        table: { rowCount: 1, columnCount: 1, cells: [], unassignedText: [], issues: [] }
      })),
      issues: []
    })
    return result
  }
  it('retains independent group-part boundaries while accepting legacy groups without them', () => {
    const result = grouped()
    expect(parsePdfStructureResult(result, identity)).toEqual(result)
    for (const part of result.elements[0].tableParts!) delete part.regions
    expect(parsePdfStructureResult(result, identity)).toEqual(result)
  })
  it.each(['partial', 'outside', 'overlap', 'page', 'too-many', 'no-caption'] as const)(
    'rejects inconsistent group-part boundaries: %s',
    (mode) => {
      const result = grouped(),
        element = result.elements[0],
        parts = element.tableParts!
      if (mode === 'partial') delete parts[1].regions
      if (mode === 'outside') parts[0].regions![0].x = 0
      if (mode === 'overlap') parts[1].regions![0].y = 0.3
      if (mode === 'page') parts[0].regions![0].page = 2
      if (mode === 'too-many')
        parts[0].regions = Array.from({ length: 9 }, () => ({ ...parts[0].regions![0] }))
      if (mode === 'no-caption') delete element.caption
      expect(() => parsePdfStructureResult(result, identity)).toThrow()
    }
  )
  it('accepts sparse/merged cells without filling missing content', () => {
    const result = resultFor(identity)
    result.elements.push({
      id: 'table-1',
      kind: 'table',
      regions: [{ page: 1, x: 0, y: 0, width: 1, height: 1 }],
      table: {
        rowCount: 1000000,
        columnCount: 1000000,
        cells: [{ row: 0, column: 0, rowSpan: 2, columnSpan: 2, text: '', regions: [] }],
        unassignedText: [{ text: 'unplaced', regions: [] }],
        issues: []
      },
      issues: []
    })
    expect(parsePdfStructureResult(result, identity).elements[0].table).toEqual(
      result.elements[0].table
    )
  })
  it.each(['coverage', 'identity', 'geometry', 'overlap', 'duplicate', 'page', 'path'] as const)(
    'rejects invalid %s',
    (kind) => {
      const result = resultFor(identity)
      result.elements.push({
        id: 'table-1',
        kind: 'table',
        regions: [{ page: 1, x: 0, y: 0, width: 1, height: 1 }],
        table: {
          rowCount: 1,
          columnCount: 1,
          cells: [{ row: 0, column: 0, rowSpan: 1, columnSpan: 1, text: 'a', regions: [] }],
          unassignedText: [],
          issues: []
        },
        issues: []
      })
      if (kind === 'coverage') result.processedPages = [2]
      if (kind === 'identity') result.sourceChecksum = 'f'.repeat(64)
      if (kind === 'geometry') result.elements[0].regions[0].x = 0.5
      if (kind === 'page') result.elements[0].regions[0].page = 2
      if (kind === 'overlap')
        result.elements[0].table!.cells.push(structuredClone(result.elements[0].table!.cells[0]))
      if (kind === 'duplicate') result.elements.push(structuredClone(result.elements[0]))
      if (kind === 'path') Object.assign(result.elements[0], { path: '../outside.png' })
      expect(() => parsePdfStructureResult(result, identity)).toThrow()
    }
  )
  it('rejects oversized, deeply nested and cyclic values before schema refinement', () => {
    for (const value of [Array(8193).fill(null), 'x'.repeat(262145)]) {
      expect(() => parsePdfStructureResult({ value }, identity)).toThrow('budget')
    }
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => parsePdfStructureResult(cyclic, identity)).toThrow('JSON tree')
    expect(() => parsePdfStructureResult({ cells: Array(2049).fill(null) }, identity)).toThrow(
      'budget'
    )
    let nested: unknown = null
    for (let i = 0; i < 34; i++) nested = { nested }
    expect(() => parsePdfStructureResult(nested, identity)).toThrow('budget')
  })
})
