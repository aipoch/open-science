import type { EditContext } from './context'
import { findShape, readPresentation, requireSlide } from './deck'
import { PptxEditError } from './errors'
import type { PptxOperation } from './operations'
import { NS, children, descendants, firstChild } from './package'
import { slideDocFor } from './shapes'
import { readTextBody, writeTextBody } from './text'

export const tableOf = (frame: Element): Element | undefined =>
  frame.localName === 'graphicFrame' ? descendants(frame, NS.a, 'tbl')[0] : undefined

export const readTable = (table: Element): string[][] =>
  children(table, NS.a, 'tr').map((row) =>
    children(row, NS.a, 'tc').map((cell) => {
      const body = firstChild(cell, NS.a, 'txBody')
      return body ? readTextBody(body) : ''
    })
  )

export const setTableCellText = (
  ctx: EditContext,
  op: Extract<PptxOperation, { op: 'setTableCellText' }>
): void => {
  const frame = findShape(slideDocFor(ctx, op.slideId), op.shapeId)
  const table = tableOf(frame)
  if (!table) throw new PptxEditError('UNSUPPORTED_SHAPE', `Shape ${op.shapeId} is not a table.`)
  const row = children(table, NS.a, 'tr')[op.row]
  const cell = row ? children(row, NS.a, 'tc')[op.col] : undefined
  if (!cell) {
    throw new PptxEditError('SHAPE_NOT_FOUND', `Table cell (${op.row}, ${op.col}) does not exist.`)
  }
  if (['hMerge', 'vMerge'].some((name) => cell.getAttribute(name) === '1')) {
    throw new PptxEditError('UNSUPPORTED_SHAPE', 'Merged table cells cannot be edited directly.')
  }
  const body = firstChild(cell, NS.a, 'txBody')
  if (!body) throw new PptxEditError('UNSUPPORTED_SHAPE', 'Table cell has no text body.')
  writeTextBody(body, op.paragraphs, {
    ctx,
    part: requireSlide(readPresentation(ctx), op.slideId).part
  })
}
