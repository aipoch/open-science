import { expect, it } from 'vitest'
import { groupPdfFigureSelections } from './pdf-figure-selections'
import { copyPdfTable } from '../../../../../../shared/pdf-table-copy'
import type { PdfStructureResult } from '../../../../../../shared/pdf-structure'

const batch = (page: number): PdfStructureResult => {
  const region = { page, x: 0.1, y: 0.1, width: 0.8, height: 0.5 }
  return {
    schemaVersion: 1,
    extractionId: `batch-${page}`,
    engineFingerprint: 'a'.repeat(64),
    sourceChecksum: 'b'.repeat(64),
    sourceSizeBytes: 100,
    pageCount: 8,
    requestedPages: [page],
    processedPages: [page],
    pages: [{ page, width: 600, height: 800, rotation: 0 }],
    thumbnails: [],
    navigation: [],
    issues: [],
    elements: [
      {
        id: `table-${page}`,
        kind: 'table',
        thumbnailId: `crop-${page}`,
        regions: [region],
        caption: {
          text: page === 5 ? 'Table 1. Baseline data.' : 'Table 1. (continued)',
          regions: [region]
        },
        issues: [],
        table: {
          rowCount: 2,
          columnCount: 3,
          cells: [
            ['Variable', 'Arm A', 'Arm B'],
            [page === 5 ? 'Letrozole' : 'Anastrozole', '3', '8']
          ].flatMap((row, r) =>
            row.map((text, column) => ({
              row: r,
              column,
              rowSpan: 1,
              columnSpan: 1,
              text,
              regions: [region]
            }))
          ),
          unassignedText: [],
          issues: [],
          notes: page === 5 ? [] : [{ text: 'Source definitions.', regions: [region] }]
        }
      }
    ]
  }
}

it('joins explicit adjacent table continuations across batches without duplicating the header', () => {
  const batches = [batch(5), batch(6), batch(7)]
  const original = structuredClone(batches)
  const entries = groupPdfFigureSelections(batches)
  expect(entries).toHaveLength(1)
  expect(entries[0].continuations).toHaveLength(2)
  expect(entries[0].combinedTable?.rowCount).toBe(4)
  const table = entries[0].combinedTable!
  expect(copyPdfTable(table, 'tsv', '')).toBe(
    'Variable\tArm A\tArm B\nLetrozole\t3\t8\nAnastrozole\t3\t8\nAnastrozole\t3\t8'
  )
  expect(copyPdfTable(table, 'html', '')).toContain('Source definitions.')
  expect(table.cells.find((c) => c.row === 2)?.regions[0].page).toBe(6)
  expect(batches).toEqual(original)
})

it('leaves unrelated, ambiguous or incompatible tables separate', () => {
  const variants = [
    (b: PdfStructureResult) => {
      b.sourceChecksum = 'c'.repeat(64)
    },
    (b: PdfStructureResult) => {
      b.elements[0].regions[0].page = 7
    },
    (b: PdfStructureResult) => {
      b.elements[0].caption!.text = 'Table 2. (continued)'
    },
    (b: PdfStructureResult) => {
      b.elements[0].caption!.text = 'Table 1. Independent data.'
    },
    (b: PdfStructureResult) => {
      b.elements[0].table!.cells[1].text = 'Other arm'
    },
    (b: PdfStructureResult) => {
      b.elements[0].table!.cells[1].rowSpan = 2
    },
    (b: PdfStructureResult) => {
      b.elements[0].table!.cells[4].text = 'Mean (SD)'
    },
    (b: PdfStructureResult) => {
      b.elements[0].table!.unassignedText = [{ text: 'Unplaced heading', regions: [] }]
    }
  ]
  for (const change of variants) {
    const next = batch(6)
    change(next)
    expect(groupPdfFigureSelections([batch(5), next])).toHaveLength(2)
  }
  const first = batch(5)
  first.elements.push({ ...first.elements[0], id: 'other-table' })
  expect(groupPdfFigureSelections([first, batch(6)])).toHaveLength(3)
})

it('joins a repeated units header while preserving section rows, notes and page provenance', () => {
  const data = [batch(5), batch(6)]
  for (const [i, result] of data.entries()) {
    const element = result.elements[0]
    element.caption!.text = i ? 'Table 1 (continued )' : 'Table 1. Longitudinal results'
    element.table = {
      rowCount: 4,
      columnCount: 4,
      cells: [
        ...['Variables', 'Arm A', 'Arm B', 'P-value'].map((text, column) => ({
          row: 0,
          column,
          rowSpan: 1,
          columnSpan: 1,
          text,
          regions: element.regions
        })),
        { row: 1, column: 0, rowSpan: 1, columnSpan: 1, text: '', regions: element.regions },
        {
          row: 1,
          column: 1,
          rowSpan: 1,
          columnSpan: 2,
          text: '(Mean ± SD)',
          regions: element.regions
        },
        { row: 1, column: 3, rowSpan: 1, columnSpan: 1, text: '', regions: element.regions },
        {
          row: 2,
          column: 0,
          rowSpan: 1,
          columnSpan: 4,
          text: `Outcome ${i + 1}`,
          regions: element.regions
        },
        ...['Baseline', '12.2 ± 1.0', '13.4 ± 1.2', '0.2'].map((text, column) => ({
          row: 3,
          column,
          rowSpan: 1,
          columnSpan: 1,
          text,
          regions: element.regions
        }))
      ],
      unassignedText: [],
      issues: [],
      notes: i ? [{ text: 'Paired comparisons.', regions: element.regions }] : []
    }
  }
  const entries = groupPdfFigureSelections(data)
  expect(entries).toHaveLength(1)
  expect(entries[0].combinedTable?.rowCount).toBe(6)
  expect(entries[0].combinedTable?.cells.find((c) => c.row === 4)?.text).toBe('Outcome 2')
  expect(entries[0].combinedTable?.cells.find((c) => c.row === 5)?.regions[0].page).toBe(6)
  expect(copyPdfTable(entries[0].combinedTable!, 'html', '')).toContain('Paired comparisons.')
  data[1].elements[0].table!.cells[5].text = '(Median ± SD)'
  expect(groupPdfFigureSelections(data)).toHaveLength(2)
})

it('joins explicit continuations whose first record follows full-width outcome labels', () => {
  const a = batch(5),
    b = batch(6)
  for (const result of [a, b]) {
    const t = result.elements[0].table!
    t.cells.forEach((c) => {
      if (c.row) c.row += 2
    })
    t.cells.push(
      ...[1, 2].map((row) => ({
        row,
        column: 0,
        rowSpan: 1,
        columnSpan: 3,
        text: `Outcome ${row}`,
        regions: result.elements[0].regions
      }))
    )
    t.rowCount += 2
  }
  const entries = groupPdfFigureSelections([a, b])
  expect(entries).toHaveLength(1)
  expect(entries[0].combinedTable!.cells.filter((c) => c.text === 'Outcome 1')).toHaveLength(2)
})
it('requires a complete repeated header and page-edge geometry for an unlabelled short continuation', () => {
  const a = batch(5),
    b = batch(6)
  b.elements[0].caption = undefined
  for (const r of [a, b]) {
    const t = r.elements[0].table!,
      region = r.elements[0].regions[0]
    t.columnCount = 4
    t.cells.push(
      { row: 0, column: 3, rowSpan: 1, columnSpan: 1, text: 'Arm C', regions: [region] },
      { row: 1, column: 3, rowSpan: 1, columnSpan: 1, text: '9', regions: [region] }
    )
  }
  const t = a.elements[0].table!
  for (let row = 2; row < 12; row++)
    t.cells.push(
      ...t.cells
        .filter((c) => c.row === 1)
        .map((c) => ({ ...c, row, text: c.column ? c.text : `Record ${row}` }))
    )
  t.rowCount = 12
  a.elements[0].regions[0].height = 0.8
  expect(groupPdfFigureSelections([a, b])).toHaveLength(1)
  b.elements[0].regions[0].y = 0.4
  expect(groupPdfFigureSelections([a, b])).toHaveLength(2)
  b.elements[0].regions[0].y = 0.1
  b.elements[0].table!.cells.find((c) => c.row === 0 && c.column === 3)!.text = 'Other group'
  expect(groupPdfFigureSelections([a, b])).toHaveLength(2)
  const next = b.elements[0].table!
  next.cells.find((c) => c.row === 0 && c.column === 3)!.text = 'Arm C'
  for (const c of t.cells.filter((c) => c.row === 0 && [1, 2].includes(c.column)))
    c.text += ' M±SD or n (%)'
  for (const c of next.cells) if (c.row) c.row++
  next.cells.find((c) => c.row === 0 && c.column === 3)!.rowSpan = 2
  next.cells.push(
    ...[1, 2].map((column) => ({
      row: 1,
      column,
      rowSpan: 1,
      columnSpan: 1,
      text: 'M±SD or n (%)',
      regions: b.elements[0].regions
    }))
  )
  next.rowCount++
  const combined = groupPdfFigureSelections([a, b])
  expect(combined).toHaveLength(1)
  expect(combined[0].combinedTable!.rowCount).toBe(13)
})

it('joins a repeated header with explicitly named statistics in the first record', () => {
  const first = batch(5),
    next = batch(6)
  for (const b of [first, next]) {
    const cells = b.elements[0].table!.cells
    cells[1].text = 'Statistics'
    cells[2].text = 'P value'
  }
  first.elements[0].table!.cells[4].text = 't=0.699'
  first.elements[0].table!.cells[5].text = 'P=0.486'
  const joined = groupPdfFigureSelections([first, next])
  expect(joined).toHaveLength(1)
  expect(copyPdfTable(joined[0].combinedTable!, 'tsv', '')).toContain('t=0.699\tP=0.486')
  for (const change of ['wrong-heading', 'prose']) {
    const invalid = structuredClone(first)
    const following = structuredClone(next)
    if (change === 'wrong-heading') {
      invalid.elements[0].table!.cells[1].text = 'Arm A'
      following.elements[0].table!.cells[1].text = 'Arm A'
    } else invalid.elements[0].table!.cells[4].text = 't=approximately 0.699'
    expect(groupPdfFigureSelections([invalid, following])).toHaveLength(2)
  }
})
