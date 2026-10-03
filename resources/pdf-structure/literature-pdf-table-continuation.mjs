/* eslint-disable @typescript-eslint/explicit-function-return-type */

// Mark an open narrative row whose lower edge reaches the table crop.  The
// marker lets a downstream consumer join the row with a same-column tail on
// the following page without pretending that the page-local crop contains it.
export function detectTableContinuationTail({ rows, cells, cropRect }) {
  const row = rows?.at(-1)
  if (!row || !cropRect || !cells?.length) return undefined
  const text = cells
    .filter((cell) => cell.row === rows.length - 1)
    .map((cell) => cell.text?.trim() ?? '')
    .filter(Boolean)
    .join(' ')
    .trim()
  if (
    text.length < 40 ||
    /[.!?:;)\]…”’]$/u.test(text) ||
    row.rect[3] < cropRect[3] - Math.max(2, (row.rect[3] - row.rect[1]) * 0.35)
  )
    return undefined
  return {
    direction: 'next-page',
    row: rows.length - 1,
    reason: 'open-row-at-crop-bottom'
  }
}
