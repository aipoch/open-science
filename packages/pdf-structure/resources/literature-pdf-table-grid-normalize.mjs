/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { inside } from './literature-pdf-table-geometry.mjs'

const hasText = (cell) => Boolean(cell?.text?.trim())

// Detector columns made only of a vertical separator should not survive as
// data columns.  Remove them only when no source glyph or spanning cell owns
// the slot; a genuinely blank data field remains untouched when it has source
// geometry.
export function removeEmptySeparatorColumns({
  cells,
  columns,
  columnRects,
  items,
  repairs,
  preserveRecoveredRotatedColumns = false
}) {
  if (!cells?.length || !columnRects?.length) return 0
  let removed = 0
  for (let column = columnRects.length - 1; column >= 0; column--) {
    // A rotated continuation can contain an intentionally empty model slot
    // beside a source-recovered column. Keeping those slots preserves the
    // detector's column positions so the recovered row remains aligned with
    // later numeric cells.
    if (preserveRecoveredRotatedColumns) continue
    const direct = cells.filter((cell) => cell.column === column && cell.colSpan === 1)
    if (!direct.length || direct.some(hasText)) continue
    if (
      cells.some(
        (cell) => cell.column < column && cell.column + cell.colSpan > column && cell.colSpan > 1
      )
    )
      continue
    const source = items?.some((item) => item.horizontal && inside(columnRects[column], item))
    if (source) continue
    const populatedBefore = cells.some(
      (cell) => cell.column < column && cell.column + cell.colSpan === column && hasText(cell)
    )
    const populatedAfter = cells.some((cell) => cell.column > column && hasText(cell))
    if (!populatedBefore || !populatedAfter) continue
    columnRects.splice(column, 1)
    if (columns?.length > column) columns.splice(column, 1)
    cells.splice(
      0,
      cells.length,
      ...cells
        .filter((cell) => cell.column !== column)
        .map((cell) => {
          const next = cell.column > column ? { ...cell, column: cell.column - 1 } : cell
          const first = columnRects[next.column]
          const last = columnRects[next.column + next.colSpan - 1]
          return first && last
            ? { ...next, rect: [first[0], next.rect[1], last[2], next.rect[3]] }
            : next
        })
    )
    removed++
  }
  if (removed) repairs.push('empty-separator-column-removed')
  return removed
}
