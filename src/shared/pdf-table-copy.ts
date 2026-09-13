import type { PdfStructureResult } from './pdf-structure'

type Table = NonNullable<PdfStructureResult['elements'][number]['table']>
type Cell = Table['cells'][number]

export const pdfTableLayout = (table: Table): (Cell | null | undefined)[][] => {
  if (table.rowCount > 256 || table.columnCount > 128)
    throw new Error('Table exceeds display limits.')
  const grid = Array.from({ length: table.rowCount }, () =>
    Array<Cell | null | undefined>(table.columnCount).fill(undefined)
  )
  for (const cell of table.cells) {
    for (let row = cell.row; row < cell.row + cell.rowSpan; row++) {
      for (let col = cell.column; col < cell.column + cell.columnSpan; col++) grid[row][col] = null
    }
    grid[cell.row][cell.column] = cell
  }
  return grid
}

export const pdfTableGrid = (table: Table, missing: string): string[][] =>
  pdfTableLayout(table).map((row) =>
    row.map((cell) => (cell === null ? '' : (cell?.text ?? missing)))
  )

const spreadsheetText = (text: string): string =>
  /^\s*[=+@]/.test(text) ||
  (/^\s*-/.test(text) && !/^\s*-(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?\s*$/i.test(text))
    ? `'${text}`
    : text

const tsvCell = (text: string): string => {
  const safe = spreadsheetText(text)
  return /[\t\r\n"]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

export const copyPdfTable = (
  table: Table,
  format: 'tsv' | 'markdown' | 'html',
  missing: string,
  includeNotes = false
): string => {
  if (format === 'html') {
    const escape = (text: string): string =>
      text.replace(
        /[&<>"']/g,
        (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!
      )
    return (
      '<html><body><table>' +
      pdfTableLayout(table)
        .map(
          (row) =>
            '<tr>' +
            row
              .map((cell) => {
                if (cell === null) return ''
                const text = cell?.text ?? missing
                const safe = spreadsheetText(text)
                const formatted = cell?.textRuns
                  ? (safe !== text ? '&#39;' : '') +
                    cell.textRuns
                      .map((run) => {
                        const value = escape(run.text)
                        return run.position === 'superscript'
                          ? `<sup>${value}</sup>`
                          : run.position === 'subscript'
                            ? `<sub>${value}</sub>`
                            : value
                      })
                      .join('')
                  : escape(safe)
                return `<td rowspan="${cell?.rowSpan ?? 1}" colspan="${cell?.columnSpan ?? 1}" style="white-space:pre-wrap;mso-number-format:'\\@'">${formatted}</td>`
              })
              .join('') +
            '</tr>'
        )
        .join('') +
      '</table>' +
      (table.notes ?? []).map((note) => `<p>${escape(spreadsheetText(note.text))}</p>`).join('') +
      '</body></html>'
    )
  }
  const grid = pdfTableGrid(table, missing)
  if (format === 'tsv')
    return (
      grid.map((row) => row.map(tsvCell).join('\t')).join('\n') +
      (includeNotes && table.notes?.length
        ? '\n\n' + table.notes.map((note) => tsvCell(note.text)).join('\n')
        : '')
    )
  const row = (cells: string[]): string =>
    `| ${cells
      .map((text) =>
        text
          .replace(/\\/g, '\\\\')
          .replace(/\|/g, '\\|')
          .replace(/[\r\n]+/g, '<br>')
      )
      .join(' | ')} |`
  return [row(grid[0]), row(grid[0].map(() => '---')), ...grid.slice(1).map(row)].join('\n')
}
