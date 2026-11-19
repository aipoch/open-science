import {
  COMPARISON_CSV_PAGE_SIZE,
  comparisonCellView,
  type ComparisonCell,
  type ComparisonTable
} from '../../../shared/literature-comparison'

type ExportKind = 'matrix' | 'evidence'

function* exportRows(table: ComparisonTable, kind: ExportKind): Generator<unknown[]> {
  const current = (cell: ComparisonCell): boolean => {
    const field = table.fields.find((f) => f.id === cell.fieldId)
    const member = table.members.find((m) => m.itemId === cell.itemId)
    return !!field && comparisonCellView(cell, field, member?.sourceKey).confirmed
  }
  yield kind === 'matrix'
    ? [
        'itemId',
        'title',
        // Identity is independent of user labels and cannot collide with metadata columns.
        // JSON encoding also preserves unusual IDs without URI encoding failures.
        ...table.fields.flatMap((field) =>
          ['value', 'machine value', 'manual value', 'status', 'reviewed'].map(
            (role) => `field:${JSON.stringify([field.id, role])} ${field.name}`
          )
        )
      ]
    : [
        'itemId',
        'cellId',
        'cellStatus',
        'fieldId',
        'field',
        'rule',
        'sourcePolicy',
        'fieldVersion',
        'attempt',
        'status',
        'value',
        'coverage',
        'sourceKey',
        'model',
        'issue',
        'pageStart',
        'pageEnd',
        'quote',
        'manual',
        'manualFieldVersion',
        'manualSourceKey',
        'confirmedCurrent'
      ]
  if (kind === 'matrix') {
    const rows = Map.groupBy(table.cells, (cell) => cell.itemId)
    for (const member of table.members)
      yield [
        member.itemId,
        member.title,
        ...table.fields.flatMap((f) => {
          const c = rows.get(member.itemId)!.find((c) => c.fieldId === f.id)!
          const latest = c.history.findLast(
            (h) => h.fieldVersion === f.version && h.sourceKey === member.sourceKey
          )
          const machine = c.history.at(-1)
          const view = comparisonCellView(c, f, member.sourceKey)
          return [
            c.manual?.value ?? latest?.value ?? '',
            machine?.value ?? '',
            c.manual?.value ?? '',
            c.status +
              (view.stale ? ': outdated' : '') +
              (view.needsReview ? ': manual-needs-review' : '') +
              (machine?.issue ? ': ' + machine.issue : ''),
            view.confirmed
          ]
        })
      ]
  } else
    for (const cell of table.cells) {
      const field = table.fields.find((f) => f.id === cell.fieldId)
      const confirmed = current(cell)
      for (const attempt of cell.history.length ? cell.history : [undefined]) {
        // Older attempts without a snapshot cannot inherit a newer definition.
        const knownCurrent = !attempt || attempt.fieldVersion === field?.version
        const historicalField = attempt?.fieldSnapshot ?? (knownCurrent ? field : undefined)
        const sourcePolicy =
          attempt?.sourcePolicy ?? (knownCurrent ? table.sourcePolicy : undefined)
        for (const evidence of attempt?.evidence.length ? attempt.evidence : [undefined]) {
          // The current manual value belongs to the cell, not to every historical quote.
          const manual =
            attempt === cell.history.at(-1) && evidence === attempt?.evidence[0]
              ? cell.manual
              : undefined
          yield [
            cell.itemId,
            cell.id,
            cell.status,
            cell.fieldId,
            historicalField?.name,
            historicalField?.rule,
            sourcePolicy,
            attempt?.fieldVersion,
            attempt?.id,
            attempt?.status,
            attempt?.value,
            attempt?.coverage,
            attempt?.sourceKey,
            attempt?.model,
            attempt?.issue,
            evidence?.pageStart,
            evidence?.pageEnd,
            evidence?.quote,
            manual?.value,
            manual?.fieldVersion,
            manual?.sourceKey,
            confirmed
          ]
        }
      }
    }
}

// Keep one cursor per immutable snapshot and format. A replay can seek from the beginning.
export class ComparisonCsvReader {
  private rows: Generator<unknown[]>
  private buffer = ''
  private position = 0
  private done = false
  constructor(
    private table: ComparisonTable,
    private kind: ExportKind
  ) {
    this.rows = exportRows(table, kind)
  }
  read(offset: number): { csv: string; nextOffset?: number } {
    if (offset < this.position) {
      this.rows = exportRows(this.table, this.kind)
      this.buffer = ''
      this.position = 0
      this.done = false
    }
    while (!this.done && this.position + this.buffer.length <= offset + COMPARISON_CSV_PAGE_SIZE) {
      const row = this.rows.next()
      if (row.done) {
        this.done = true
        break
      }
      const prefix = this.position || this.buffer.length ? '\r\n' : '\uFEFF'
      this.buffer += prefix + row.value.map(quote).join(',')
      if (this.position < offset) {
        const skip = Math.min(offset - this.position, this.buffer.length)
        this.buffer = this.buffer.slice(skip)
        this.position += skip
      }
    }
    const start = offset - this.position
    if (start >= this.buffer.length) throw new Error('comparison-invalid-offset')
    const csv = this.buffer.slice(start, start + COMPARISON_CSV_PAGE_SIZE)
    this.buffer = this.buffer.slice(start + csv.length)
    this.position = offset + csv.length
    return this.buffer.length || !this.done ? { csv, nextOffset: this.position } : { csv }
  }
}
const quote = (value: unknown): string =>
  '"' +
  String(value ?? '')
    // Some CSV readers reject raw NUL. Make it visible only in the export;
    // never remove it or infer a scientific symbol in the stored evidence.
    .replaceAll('\u0000', '\\u0000')
    .replaceAll('"', '""')
    .replace(/^(\s*)([=+@\-\t\r])/, "'$1$2") +
  '"'
