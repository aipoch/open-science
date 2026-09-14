import { describe, expect, it } from 'vitest'
import { copyPdfTable, pdfTableGrid, pdfTableLayout } from './pdf-table-copy'
import type { PdfStructureResult } from './pdf-structure'

type Table = NonNullable<PdfStructureResult['elements'][number]['table']>
const table: Table = {
  rowCount: 2,
  columnCount: 3,
  cells: [
    { row: 0, column: 0, rowSpan: 1, columnSpan: 2, text: 'Header', regions: [] },
    { row: 0, column: 2, rowSpan: 1, columnSpan: 1, text: '', regions: [] },
    { row: 1, column: 0, rowSpan: 1, columnSpan: 1, text: 'a\tb\n"c"', regions: [] },
    { row: 1, column: 2, rowSpan: 1, columnSpan: 1, text: '=SUM(A1)', regions: [] }
  ],
  unassignedText: [],
  issues: []
}
describe('PDF table copy', () => {
  it('preserves script formatting in HTML while keeping plain text and escaping intact', () => {
    const value: Table = {
      ...table,
      rowCount: 1,
      columnCount: 1,
      cells: [
        {
          row: 0,
          column: 0,
          rowSpan: 1,
          columnSpan: 1,
          regions: [],
          text: 'DPB1*01:01 <0.01*',
          textRuns: [
            { text: 'DPB1*01:01 <0.01', position: 'normal' },
            { text: '*', position: 'superscript' }
          ]
        }
      ]
    }
    expect(copyPdfTable(value, 'html', '')).toContain('DPB1*01:01 &lt;0.01<sup>*</sup>')
    expect(copyPdfTable(value, 'tsv', '')).toBe('DPB1*01:01 <0.01*')
    const formula: Table = {
      ...value,
      cells: [
        {
          ...value.cells[0],
          text: '=x2',
          textRuns: [
            { text: '=x', position: 'normal' },
            { text: '2', position: 'superscript' }
          ]
        }
      ]
    }
    expect(copyPdfTable(formula, 'html', '')).toContain('&#39;=x<sup>2</sup>')
  })
  it('exports merged HTML cells without interpreting PDF text as markup or formulas', () => {
    const value = {
      ...table,
      cells: table.cells.map((cell) => ({
        ...cell,
        text: cell.text === 'Header' ? '<img src=x onerror=alert(1)>' : cell.text
      }))
    }
    const html = copyPdfTable(value, 'html', '[Missing]')
    expect(html).toContain('rowspan="1" colspan="2"')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).not.toContain('<img')
    expect(html).toContain('&#39;=SUM(A1)')
    expect(html.match(/<td /g)).toHaveLength(5)
  })
  it('preserves vertical and rectangular spans without duplicating labels or shifting adjacent values', () => {
    const value: Table = {
      rowCount: 3,
      columnCount: 3,
      cells: [
        { row: 0, column: 0, rowSpan: 2, columnSpan: 2, text: 'Group', regions: [] },
        { row: 0, column: 2, rowSpan: 1, columnSpan: 1, text: '10', regions: [] },
        { row: 1, column: 2, rowSpan: 2, columnSpan: 1, text: '20', regions: [] },
        { row: 2, column: 0, rowSpan: 1, columnSpan: 1, text: '', regions: [] }
      ],
      unassignedText: [],
      issues: []
    }
    expect(pdfTableLayout(value).map((row) => row.map((cell) => cell === null))).toEqual([
      [false, true, false],
      [true, true, false],
      [false, false, true]
    ])
    expect(copyPdfTable(value, 'tsv', '[Missing]')).toBe('Group\t\t10\n\t\t20\n\t[Missing]\t')
    expect(copyPdfTable(value, 'markdown', '[Missing]')).toBe(
      '| Group |  | 10 |\n| --- | --- | --- |\n|  |  | 20 |\n|  | [Missing] |  |'
    )
  })
  it.each(['-1+2', '-1+HYPERLINK("https://example.com")', ' -1e3+2'])(
    'protects negative-looking formulas: %s',
    (text) => {
      const value = {
        ...table,
        rowCount: 1,
        columnCount: 1,
        cells: [{ row: 0, column: 0, rowSpan: 1, columnSpan: 1, text, regions: [] }]
      }
      const output = copyPdfTable(value, 'tsv', '[Missing]')
      expect(output.replace(/^"/, '').startsWith("'")).toBe(true)
    }
  )
  it('distinguishes merged slots, empty source text and missing cells', () => {
    expect(pdfTableGrid(table, '[Missing]')).toEqual([
      ['Header', '', ''],
      ['a\tb\n"c"', '[Missing]', '=SUM(A1)']
    ])
    expect(pdfTableLayout(table)[0][1]).toBeNull()
    expect(pdfTableLayout(table)[1][1]).toBeUndefined()
    expect(copyPdfTable(table, 'tsv', '[Missing]')).toBe(
      'Header\t\t\n"a\tb\n""c"""\t[Missing]\t\'=SUM(A1)'
    )
  })
  it('escapes Markdown columns and preserves negative numbers in TSV', () => {
    const value = {
      ...table,
      rowCount: 1,
      columnCount: 2,
      cells: table.cells.slice(0, 2).map((cell, column) => ({
        ...cell,
        column,
        columnSpan: 1,
        text: column ? '-1.5' : 'a|b\\c\nd'
      }))
    }
    expect(copyPdfTable(value, 'markdown', '?')).toBe('| a\\|b\\\\c<br>d | -1.5 |\n| --- | --- |')
    expect(copyPdfTable(value, 'tsv', '?')).toContain('\t-1.5')
    expect(() => pdfTableGrid({ ...table, rowCount: 1_000_000 }, '?')).toThrow('display limits')
  })
})
