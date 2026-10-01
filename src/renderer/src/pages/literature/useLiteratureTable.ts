import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  journalColumnKey,
  journalDatasetLabel,
  type JournalAttributeFilter,
  type JournalDataset,
  type JournalSourceYears
} from '../../../../shared/journal-attributes'
import {
  LITERATURE_TABLE_PREFERENCES_KEY,
  literatureTableColumnWidths,
  loadLiteratureTablePreferences,
  type LiteratureTableColumn
} from './literature-table-preferences'

/** Own column preferences and the journal filters reconciled with those columns in the same render. */
export function useLiteratureTable({
  datasets: displayedJournalDatasets,
  years: journalSourceYears,
  clearSelection
}: {
  datasets: JournalDataset[]
  years: JournalSourceYears
  clearSelection: () => void
}): {
  journalColumns: Array<{ key: LiteratureTableColumn; label: string }>
  journalAttributeFilters: JournalAttributeFilter[]
  setJournalAttributeFilters: React.Dispatch<React.SetStateAction<JournalAttributeFilter[]>>
  tableColumnOrder: LiteratureTableColumn[]
  visibleTableColumns: Set<LiteratureTableColumn>
  setVisibleTableColumns: React.Dispatch<React.SetStateAction<Set<LiteratureTableColumn>>>
  tableMinWidth: number
  tableColumnLabels: Record<LiteratureTableColumn, string>
  visibleOrderedTableColumns: LiteratureTableColumn[]
  moveTableColumn: (
    source: LiteratureTableColumn,
    target: LiteratureTableColumn,
    edge: 'before' | 'after'
  ) => void
  moveTableColumnBy: (column: LiteratureTableColumn, delta: -1 | 1) => void
} {
  const { t } = useTranslation()
  const journalColumns = useMemo(
    () =>
      displayedJournalDatasets.flatMap((dataset) =>
        dataset.fields
          .filter((field) => field.visible)
          .map((field) => ({
            key: `journal:${journalColumnKey(dataset.id, field)}` as LiteratureTableColumn,
            label: `${field.label} · ${journalDatasetLabel(dataset)}`
          }))
      ),
    [displayedJournalDatasets]
  )
  const [initialTablePreferences] = useState(loadLiteratureTablePreferences)
  const [savedTableColumnOrder, setTableColumnOrder] = useState<LiteratureTableColumn[]>(
    initialTablePreferences.order
  )
  const [visibleTableColumns, setVisibleTableColumns] = useState<Set<LiteratureTableColumn>>(
    () => new Set(initialTablePreferences.visible)
  )
  const [journalAttributeFilters, setJournalAttributeFilters] = useState<JournalAttributeFilter[]>(
    []
  )
  const [previousJournalDisplay, setPreviousJournalDisplay] = useState({
    datasets: displayedJournalDatasets,
    years: journalSourceYears
  })
  if (
    previousJournalDisplay.datasets !== displayedJournalDatasets ||
    previousJournalDisplay.years !== journalSourceYears
  ) {
    const previous = previousJournalDisplay
    setPreviousJournalDisplay({ datasets: displayedJournalDatasets, years: journalSourceYears })
    // Drop conditions for hidden/replaced years before rendering or fetching the new view.
    const filters = journalAttributeFilters.filter((filter) =>
      displayedJournalDatasets.some(({ id }) => id === filter.datasetId)
    )
    if (filters.length !== journalAttributeFilters.length) setJournalAttributeFilters(filters)
    const added: LiteratureTableColumn[] = []
    for (const dataset of displayedJournalDatasets) {
      const old = previous.datasets.find(({ source }) => source === dataset.source)
      const preferenceChanged =
        previous.years[dataset.source] !== journalSourceYears[dataset.source]
      if (old?.id === dataset.id && !preferenceChanged) continue
      if (!old && !preferenceChanged && journalSourceYears[dataset.source] === undefined) continue
      for (const field of dataset.fields.filter((field) => field.visible)) {
        const key = `journal:${journalColumnKey(dataset.id, field)}` as LiteratureTableColumn
        if (savedTableColumnOrder.includes(key)) continue
        const matches =
          old?.fields.filter((entry) => entry.label === field.label && entry.kind === field.kind) ??
          []
        if (
          !old ||
          matches.length !== 1 ||
          visibleTableColumns.has(`journal:${journalColumnKey(old.id, matches[0])}`)
        )
          added.push(key)
      }
    }
    if (added.length) setVisibleTableColumns((visible) => new Set([...visible, ...added]))
  }
  useEffect(() => clearSelection(), [journalSourceYears, clearSelection])
  const tableColumnOrder = useMemo(() => {
    const missing = journalColumns
      .map(({ key }) => key)
      .filter((key) => !savedTableColumnOrder.includes(key))
    return missing.length ? [...savedTableColumnOrder, ...missing] : savedTableColumnOrder
  }, [savedTableColumnOrder, journalColumns])
  const tableMinWidth =
    540 +
    tableColumnOrder.reduce(
      (width, column) =>
        width +
        (visibleTableColumns.has(column) &&
        (!column.startsWith('journal:') || journalColumns.some((field) => field.key === column))
          ? (literatureTableColumnWidths[column] ?? 180)
          : 0),
      0
    )

  const previousTablePreferences = useRef(initialTablePreferences)
  useEffect(() => {
    const previous = previousTablePreferences.current
    const local = { order: tableColumnOrder, visible: [...visibleTableColumns] }
    // External updates have already been adopted; do not echo them to other windows.
    if (
      local.order === previous.order &&
      local.visible.length === previous.visible.length &&
      local.visible.every((column) => previous.visible.includes(column))
    )
      return
    const latest = loadLiteratureTablePreferences()
    const visible = new Set(latest.visible)
    for (const column of tableColumnOrder) {
      if (visibleTableColumns.has(column) !== previous.visible.includes(column)) {
        if (visibleTableColumns.has(column)) visible.add(column)
        else visible.delete(column)
      }
    }
    const merged = {
      order: tableColumnOrder === previous.order ? latest.order : tableColumnOrder,
      visible: [...visible]
    }
    try {
      window.localStorage.setItem(LITERATURE_TABLE_PREFERENCES_KEY, JSON.stringify(merged))
    } catch {
      // Non-critical preferences remain usable in memory; retry only on another edit.
      return
    }
    previousTablePreferences.current = merged
    if (merged.order !== tableColumnOrder) setTableColumnOrder(merged.order)
    if (
      merged.visible.length !== local.visible.length ||
      merged.visible.some((column) => !visibleTableColumns.has(column))
    )
      setVisibleTableColumns(visible)
  }, [tableColumnOrder, visibleTableColumns])

  useEffect(() => {
    const onStorage = (event: StorageEvent): void => {
      if (
        event.storageArea !== window.localStorage ||
        (event.key !== null && event.key !== LITERATURE_TABLE_PREFERENCES_KEY)
      )
        return
      const preferences = loadLiteratureTablePreferences()
      previousTablePreferences.current = preferences
      setTableColumnOrder(preferences.order)
      setVisibleTableColumns(new Set(preferences.visible))
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const tableColumnLabels = useMemo<Record<LiteratureTableColumn, string>>(
    () => ({
      ...Object.fromEntries(journalColumns.map(({ key, label }) => [key, label])),
      abstract: t('Abstract'),
      year: t('Year'),
      publication: t('Publication'),
      authors: t('Authors'),
      type: t('Type'),
      tags: t('Tags'),
      rating: t('Rating'),
      notes: t('Notes'),
      url: t('URL')
    }),
    [t, journalColumns]
  )
  const visibleOrderedTableColumns = useMemo(
    () =>
      tableColumnOrder.filter(
        (column) =>
          visibleTableColumns.has(column) &&
          (!column.startsWith('journal:') || journalColumns.some(({ key }) => key === column))
      ),
    [tableColumnOrder, visibleTableColumns, journalColumns]
  )
  const moveTableColumn = (
    source: LiteratureTableColumn,
    target: LiteratureTableColumn,
    edge: 'before' | 'after'
  ): void => {
    if (source === target) return
    setTableColumnOrder(() => {
      const next = tableColumnOrder.filter((column) => column !== source)
      const targetIndex = next.indexOf(target)
      const insertionIndex =
        targetIndex < 0 ? next.length : targetIndex + (edge === 'after' ? 1 : 0)
      next.splice(insertionIndex, 0, source)
      return next
    })
  }

  const moveTableColumnBy = (column: LiteratureTableColumn, delta: -1 | 1): void => {
    setTableColumnOrder(() => {
      const current = tableColumnOrder
      const sourceIndex = current.indexOf(column)
      const targetIndex = sourceIndex + delta
      if (sourceIndex < 0 || targetIndex < 0 || targetIndex >= current.length) return current
      const next = [...current]
      ;[next[sourceIndex], next[targetIndex]] = [next[targetIndex]!, next[sourceIndex]!]
      return next
    })
  }

  return {
    journalColumns,
    journalAttributeFilters,
    setJournalAttributeFilters,
    tableColumnOrder,
    visibleTableColumns,
    setVisibleTableColumns,
    tableMinWidth,
    tableColumnLabels,
    visibleOrderedTableColumns,
    moveTableColumn,
    moveTableColumnBy
  }
}
