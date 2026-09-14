import type { PdfStructureResult } from '../../../../../../shared/pdf-structure'

export type Selection = {
  result: PdfStructureResult
  element: PdfStructureResult['elements'][number]
  continuations?: Selection[]
  combinedTable?: PdfStructureResult['elements'][number]['table']
}

type Table = NonNullable<Selection['combinedTable']>

// Match a complete repeated header, optionally followed by a measurement-units row.
// Unrecognized multi-level headers retain their separate source selections.
const header = (table: Table): { key: string; rows: number } | undefined => {
  const cells = table.cells.filter((cell) => cell.row === 0).sort((a, b) => a.column - b.column)
  const units = table.cells.filter((cell) => cell.row === 1)
  const populatedUnits = units.filter((cell) => cell.text.trim())
  const repeatedUnits =
    populatedUnits.length >= 2 &&
    populatedUnits.every(
      (cell) =>
        cell.rowSpan === 1 &&
        cell.columnSpan === 1 &&
        cell.column > 0 &&
        cell.text.replace(/\s/g, '') === 'M±SDorn(%)'
    )
  const hasUnits =
    repeatedUnits ||
    (populatedUnits.length === 1 &&
      /^\(Mean\s*±\s*SD\)$/.test(populatedUnits[0].text.trim()) &&
      populatedUnits[0].column === 1 &&
      populatedUnits[0].rowSpan === 1 &&
      populatedUnits[0].columnSpan === table.columnCount - 2 &&
      units.every((cell) => cell.rowSpan === 1))
  const rows = hasUnits ? 2 : 1
  let recordRow = rows
  {
    while (recordRow < Math.min(rows + 4, table.rowCount)) {
      const section = table.cells.filter((cell) => cell.row === recordRow)
      if (
        section.length !== 1 ||
        section[0].column !== 0 ||
        section[0].columnSpan !== table.columnCount ||
        section[0].rowSpan !== 1 ||
        !section[0].text.trim()
      )
        break
      recordRow++
    }
  }
  const record = table.cells.filter((cell) => cell.row === recordRow)
  if (
    table.unassignedText.length ||
    table.rowCount < 2 ||
    cells.length !== table.columnCount ||
    cells.some(
      (cell, i) =>
        cell.column !== i ||
        (cell.rowSpan !== 1 &&
          !(
            repeatedUnits &&
            cell.rowSpan === 2 &&
            !populatedUnits.some((unit) => unit.column === cell.column)
          )) ||
        cell.columnSpan !== 1 ||
        (i > 0 && !cell.text.trim())
    ) ||
    !record.some((cell) => cell.column === 0 && cell.text.trim()) ||
    !record.some((cell) => cell.column > 0 && /\d/.test(cell.text)) ||
    record.some(
      (cell) =>
        cell.column > 0 &&
        cell.text.trim() &&
        !/^[<>≤≥−+-]?\s*(?:\d|\.\d)[\d\s.,()%–−±/+-]*$/.test(cell.text.trim()) &&
        !(
          /^Statistics?$/i.test(cells[cell.column]?.text.trim() ?? '') &&
          /^(?:t|F|χ[²2]?)\s*=\s*[−+-]?\d+(?:\.\d+)?$/i.test(cell.text.trim())
        ) &&
        !(
          /^P(?:[ -]value)?$/i.test(cells[cell.column]?.text.trim() ?? '') &&
          /^P\s*[=<>≤≥]\s*(?:0?\.\d+|[01](?:\.0+)?)$/i.test(cell.text.trim())
        )
    )
  )
    return undefined
  return {
    key: JSON.stringify([
      cells.map((cell) =>
        cell.text
          .replace(/\s*M\s*±\s*SD\s*or\s*n\s*\(%\)\s*$/, '')
          .replace(/\s+/g, ' ')
          .trim()
      ),
      repeatedUnits || cells.some((cell) => /M\s*±\s*SD\s*or\s*n\s*\(%\)/.test(cell.text))
        ? 'M±SDorn(%)'
        : hasUnits
          ? populatedUnits[0].text.replace(/\s+/g, '')
          : null
    ]),
    rows
  }
}

const joinContinuation = (prior: Selection, next: Selection): Table | undefined => {
  const last = prior.continuations?.at(-1) ?? prior
  const number = /^Table\s+([A-Z]?\d+)\b/i.exec(prior.element.caption?.text ?? '')?.[1]
  const continued = /^Table\s+([A-Z]?\d+)\s*[.:]?\s*\(?continued\s*\)?\.?$/i.exec(
    next.element.caption?.text ?? ''
  )?.[1]
  const a = prior.combinedTable ?? prior.element.table,
    b = next.element.table
  const aHeader = a && header(a),
    bHeader = b && header(b)
  const lastRegion = last.element.regions.at(-1)!,
    nextRegion = next.element.regions[0]
  const unlabelledContinuation =
    !next.element.caption &&
    !!a &&
    !!b &&
    a.columnCount >= 4 &&
    a.rowCount >= 10 &&
    b.rowCount <= 10 &&
    !a.notes?.length &&
    lastRegion.y + lastRegion.height >= 0.85 &&
    nextRegion.y <= 0.15 &&
    Math.abs(lastRegion.x - nextRegion.x) < 0.03 &&
    Math.abs(lastRegion.width - nextRegion.width) < 0.05
  if (
    prior.element.kind !== 'table' ||
    next.element.kind !== 'table' ||
    !number ||
    (!unlabelledContinuation && number.toLowerCase() !== continued?.toLowerCase()) ||
    prior.result.sourceChecksum !== next.result.sourceChecksum ||
    prior.result.sourceSizeBytes !== next.result.sourceSizeBytes ||
    last.element.regions.at(-1)!.page + 1 !== next.element.regions[0].page ||
    prior.element.tableParts ||
    next.element.tableParts ||
    prior.element.tableNotes?.length ||
    next.element.tableNotes?.length ||
    !a ||
    !b ||
    !aHeader ||
    !bHeader ||
    aHeader.key !== bHeader.key ||
    a.rowCount + b.rowCount - bHeader.rows > 256 ||
    a.columnCount > 128 ||
    a.cells.length + b.cells.length - b.columnCount > 2048
  )
    return undefined
  return {
    rowCount: a.rowCount + b.rowCount - bHeader.rows,
    columnCount: a.columnCount,
    cells: [
      ...a.cells,
      ...b.cells
        .filter((cell) => cell.row >= bHeader.rows)
        .map((cell) => ({ ...cell, row: cell.row + a.rowCount - bHeader.rows }))
    ],
    notes: [...(a.notes ?? []), ...(b.notes ?? [])],
    unassignedText: [],
    issues: [...a.issues, ...b.issues, ...next.element.issues]
  }
}

export function groupPdfFigureSelections(results: PdfStructureResult[]): Selection[] {
  const entries: Selection[] = []
  for (const result of results)
    for (const element of result.elements) {
      if (element.kind === 'table') {
        const matches = entries.flatMap((entry) => {
          const table = joinContinuation(entry, { result, element })
          return table ? [{ entry, table }] : []
        })
        if (matches.length === 1) {
          const { entry, table } = matches[0]
          entry.combinedTable = table
          ;(entry.continuations ??= []).push({ result, element })
          continue
        }
      }
      const prior =
        element.kind === 'figure' &&
        element.caption &&
        entries.find(
          (entry) =>
            entry.element.kind === 'figure' &&
            entry.element.caption?.text === element.caption?.text &&
            JSON.stringify(entry.element.caption?.regions) ===
              JSON.stringify(element.caption?.regions) &&
            (entry.continuations?.at(-1)?.element ?? entry.element).regions[0].page + 1 ===
              element.regions[0].page
        )
      if (prior) (prior.continuations ??= []).push({ result, element })
      else entries.push({ result, element })
    }
  return entries
}
