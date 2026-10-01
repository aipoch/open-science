import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { SlidersHorizontal } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { JournalDataset } from '../../../../../shared/journal-attributes'
import type { LiteratureCollectionView, LiteratureItemType } from '../../../../../shared/literature'
import type { SmartCollectionView } from '../../../../../shared/literature-smart-collections'
import { JournalDatasetChoices, LiteratureColumnCustomizer } from './LiteratureColumnCustomizer'
import { LiteratureFilters } from './LiteratureFilters'
import { setJournalSourceYear } from '../journals/journal-attribute-store'
import type { LiteratureTableColumn } from './literature-table-preferences'
import { useLiteratureTable } from './useLiteratureTable'

export function LiteratureViewControls({
  selectedCollection,
  smartDecisionSource,
  smartView,
  setSmartDecisionSource,
  clearSelection,
  sortBy,
  setSortBy,
  filtersOpen,
  setFiltersOpen,
  yearFilter,
  activeFilterCount,
  accessibilityId,
  tagId,
  setTagId,
  filterItemType,
  setFilterItemType,
  itemTypeLabels,
  filterHasPdf,
  setFilterHasPdf,
  journalFilterDatasets,
  journalAttributeFilters,
  setJournalAttributeFilters,
  clearFilters,
  journalDatasets,
  journalSourceYears,
  tableColumnOrder,
  journalColumns,
  tableColumnLabels,
  visibleTableColumns,
  moveTableColumn,
  moveTableColumnBy,
  setVisibleTableColumns
}: {
  selectedCollection: LiteratureCollectionView | undefined
  smartDecisionSource: 'manual' | 'ai' | 'all'
  smartView: SmartCollectionView | undefined
  setSmartDecisionSource: React.Dispatch<React.SetStateAction<'manual' | 'ai' | 'all'>>
  clearSelection: () => void
  sortBy:
    'title' | 'rating' | 'year' | 'updated' | 'created' | 'created-asc' | 'title-desc' | 'year-asc'
  setSortBy: React.Dispatch<
    React.SetStateAction<
      | 'title'
      | 'rating'
      | 'year'
      | 'updated'
      | 'created'
      | 'created-asc'
      | 'title-desc'
      | 'year-asc'
    >
  >
  filtersOpen: boolean
  setFiltersOpen: React.Dispatch<React.SetStateAction<boolean>>
  yearFilter: Readonly<{
    from: string
    to: string
    draftFrom: string
    draftTo: string
    invalid: boolean
    setDraftFrom: (value: string) => void
    setDraftTo: (value: string) => void
    clear: () => void
  }>
  activeFilterCount: number
  accessibilityId: string
  tagId: string
  setTagId: React.Dispatch<React.SetStateAction<string>>
  filterItemType:
    | 'document'
    | 'all'
    | 'journalArticle'
    | 'review'
    | 'preprint'
    | 'conferencePaper'
    | 'book'
    | 'bookSection'
    | 'thesis'
    | 'report'
    | 'dataset'
    | 'standard'
    | 'patent'
    | 'webpage'
  setFilterItemType: React.Dispatch<
    React.SetStateAction<
      | 'document'
      | 'all'
      | 'journalArticle'
      | 'review'
      | 'preprint'
      | 'conferencePaper'
      | 'book'
      | 'bookSection'
      | 'thesis'
      | 'report'
      | 'dataset'
      | 'standard'
      | 'patent'
      | 'webpage'
    >
  >
  itemTypeLabels: Record<LiteratureItemType, string>
  filterHasPdf: 'with' | 'all' | 'without'
  setFilterHasPdf: React.Dispatch<React.SetStateAction<'with' | 'all' | 'without'>>
  journalFilterDatasets: JournalDataset[]
  journalAttributeFilters: {
    datasetId: string
    fieldId: string
    operator: 'missing' | 'equals' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte'
    value?: string | undefined
  }[]
  setJournalAttributeFilters: React.Dispatch<
    React.SetStateAction<
      {
        datasetId: string
        fieldId: string
        operator: 'missing' | 'equals' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte'
        value?: string | undefined
      }[]
    >
  >
  clearFilters: () => void
  journalDatasets: JournalDataset[]
  journalSourceYears: Record<string, number | null>
  tableColumnOrder: LiteratureTableColumn[]
  journalColumns: ReturnType<typeof useLiteratureTable>['journalColumns']
  tableColumnLabels: ReturnType<typeof useLiteratureTable>['tableColumnLabels']
  visibleTableColumns: Set<LiteratureTableColumn>
  moveTableColumn: (
    source: LiteratureTableColumn,
    target: LiteratureTableColumn,
    edge: 'before' | 'after'
  ) => void
  moveTableColumnBy: (column: LiteratureTableColumn, delta: -1 | 1) => void
  setVisibleTableColumns: React.Dispatch<React.SetStateAction<Set<LiteratureTableColumn>>>
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex shrink-0 items-center justify-end gap-2">
      {selectedCollection?.smart && (
        <Select
          value={smartDecisionSource}
          disabled={!smartView?.countsBySource}
          onValueChange={(value) => {
            setSmartDecisionSource(value as typeof smartDecisionSource)
            clearSelection()
          }}
        >
          <SelectTrigger aria-label={t('Decision source')} className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('All decision sources')}</SelectItem>
            <SelectItem value="ai">{t('AI decisions')}</SelectItem>
            <SelectItem value="manual">{t('Manual decisions')}</SelectItem>
          </SelectContent>
        </Select>
      )}

      <Select
        value={sortBy}
        onValueChange={(value) => {
          setSortBy(value as typeof sortBy)
          clearSelection()
        }}
      >
        <SelectTrigger aria-label={t('Sort references')} className="w-48">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="updated">{t('Recently updated')}</SelectItem>
          <SelectItem value="created">{t('Recently added')}</SelectItem>
          <SelectItem value="created-asc">{t('First added')}</SelectItem>
          <SelectItem value="title">{t('Title: A–Z')}</SelectItem>
          <SelectItem value="title-desc">{t('Title: Z–A')}</SelectItem>
          <SelectItem value="year">{t('Year: newest first')}</SelectItem>
          <SelectItem value="year-asc">{t('Year: oldest first')}</SelectItem>
          <SelectItem value="rating">{t('Highest rated')}</SelectItem>
        </SelectContent>
      </Select>
      <Popover open={filtersOpen} onOpenChange={setFiltersOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            className="relative"
            aria-describedby={
              yearFilter.invalid && !filtersOpen ? 'literature-year-filter-error' : undefined
            }
          >
            <SlidersHorizontal className="size-4" aria-hidden="true" />
            {t('Filters')}
            {activeFilterCount > 0 ? (
              <span className="rounded-full bg-primary/10 px-1.5 text-[11px] font-medium tabular-nums text-primary">
                {activeFilterCount}
              </span>
            ) : null}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          aria-labelledby={`${accessibilityId}-filters`}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            document.getElementById(`${accessibilityId}-filters`)?.focus()
          }}
          className="w-[min(46rem,calc(100vw-2rem))] space-y-4 rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-menu"
        >
          <LiteratureFilters
            headingId={`${accessibilityId}-filters`}
            tagId={tagId}
            onTagChange={setTagId}
            itemType={filterItemType}
            onItemTypeChange={setFilterItemType}
            itemTypeLabels={itemTypeLabels}
            hasPdf={filterHasPdf}
            onHasPdfChange={setFilterHasPdf}
            yearFilter={yearFilter}
            datasets={journalFilterDatasets}
            journalFilters={journalAttributeFilters}
            onJournalFiltersChange={setJournalAttributeFilters}
            onFilterChange={clearSelection}
            onClear={clearFilters}
          />
        </PopoverContent>
      </Popover>
      {yearFilter.invalid && !filtersOpen ? (
        <p id="literature-year-filter-error" role="status" className="text-xs text-destructive">
          {t('Enter a valid year range (0–9999).')}
        </p>
      ) : null}
      <LiteratureColumnCustomizer
        journalSettings={
          <JournalDatasetChoices
            datasets={journalDatasets}
            years={journalSourceYears}
            onChange={setJournalSourceYear}
          />
        }
        columns={tableColumnOrder.filter(
          (column) =>
            !column.startsWith('journal:') || journalColumns.some(({ key }) => key === column)
        )}
        labels={tableColumnLabels}
        visible={visibleTableColumns}
        onMove={moveTableColumn}
        onMoveBy={moveTableColumnBy}
        onVisibilityChange={(column, nextVisible) =>
          setVisibleTableColumns((current) => {
            const next = new Set(current)
            if (nextVisible) next.add(column)
            else next.delete(column)
            return next
          })
        }
      />
    </div>
  )
}
