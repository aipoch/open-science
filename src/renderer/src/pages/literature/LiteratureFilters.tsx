import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Check,
  ChevronDown,
  Hash,
  List,
  ListChecks,
  Paperclip,
  Plus,
  Tags,
  Type,
  X,
  Calendar,
  type LucideIcon
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { TagFilter } from '../settings/ResourceTagControls'
import { CollectionOptionHelp } from './CollectionOptionHelp'
import { LiteratureYearFilter } from './LiteratureYearFilter'
import type { YearFilterState } from './useLiteratureYearFilter'
import type { LiteratureItemType } from '../../../../shared/literature'
import {
  JOURNAL_ATTRIBUTE_FILTER_MAX,
  journalDatasetLabel,
  type JournalAttributeFilter,
  type JournalDataset,
  type JournalField
} from '../../../../shared/journal-attributes'

type FixedField = 'tags' | 'type' | 'year' | 'pdf'
type Field = {
  key: string
  label: string
  icon: LucideIcon
  datasetId?: string
  field?: JournalField
}
type Row = { id: number; key: string; operator: JournalAttributeFilter['operator']; value: string }
type AppliedRow = { id: number; filter: JournalAttributeFilter }
const fixedFields: FixedField[] = ['tags', 'type', 'year', 'pdf']
const journalKey = (datasetId: string, fieldId: string): string =>
  JSON.stringify([datasetId, fieldId])

function FieldPicker({
  fields,
  value,
  onChange,
  disabled = false
}: {
  fields: Field[]
  value?: string
  onChange: (value: string) => void
  disabled?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const selected = fields.find((field) => field.key === value)
  const Icon = selected?.icon ?? Plus
  const matches = fields.filter((field) =>
    field.label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
  )
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setQuery('')
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant={value ? 'outline' : 'ghost'}
          disabled={disabled}
          aria-label={value ? t('Filter field') : t('Add condition')}
          className="min-w-0 justify-start gap-2"
        >
          <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="truncate">{selected?.label ?? value ?? t('Add condition')}</span>
          {value ? (
            <ChevronDown
              className="ml-auto size-3.5 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-popover p-2 text-popover-foreground shadow-menu"
      >
        <Input
          autoFocus
          aria-label={t('Search fields')}
          placeholder={t('Search fields')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="mt-2 max-h-64 overflow-auto">
          {[false, true].map((dynamic) => {
            const group = matches.filter((field) => Boolean(field.datasetId) === dynamic)
            return group.length ? (
              <div key={String(dynamic)} className="py-1">
                <p className="px-2 py-1 text-xs text-muted-foreground">
                  {dynamic ? t('Journal attributes') : t('Fixed fields')}
                </p>
                {group.map((field) => (
                  <Button
                    type="button"
                    key={field.key}
                    variant="ghost"
                    className="w-full justify-start gap-2"
                    onClick={() => {
                      onChange(field.key)
                      setOpen(false)
                      setQuery('')
                    }}
                  >
                    <field.icon
                      className="size-4 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1 truncate text-left">{field.label}</span>
                    {value === field.key ? (
                      <Check className="size-4 shrink-0" aria-hidden="true" />
                    ) : null}
                  </Button>
                ))}
              </div>
            ) : null
          })}
          {!matches.length ? (
            <p className="p-3 text-xs text-muted-foreground">{t('No results found')}</p>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  )
}

export function LiteratureFilters({
  headingId,
  tagId,
  onTagChange,
  itemType,
  onItemTypeChange,
  itemTypeLabels,
  hasPdf,
  onHasPdfChange,
  yearFilter,
  datasets,
  journalFilters,
  onJournalFiltersChange,
  onFilterChange,
  onClear
}: {
  headingId: string
  tagId: string
  onTagChange: (value: string) => void
  itemType: LiteratureItemType | 'all'
  onItemTypeChange: (value: LiteratureItemType | 'all') => void
  itemTypeLabels: Record<LiteratureItemType, string>
  hasPdf: 'all' | 'with' | 'without'
  onHasPdfChange: (value: 'all' | 'with' | 'without') => void
  yearFilter: YearFilterState
  datasets: JournalDataset[]
  journalFilters: JournalAttributeFilter[]
  onJournalFiltersChange: (value: JournalAttributeFilter[]) => void
  onFilterChange: () => void
  onClear: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const fields = useMemo<Field[]>(
    () => [
      { key: 'tags', label: t('Tags'), icon: Tags },
      { key: 'type', label: t('Reference type'), icon: Type },
      { key: 'year', label: t('Year'), icon: Calendar },
      { key: 'pdf', label: t('PDF'), icon: Paperclip },
      ...datasets.flatMap((dataset) =>
        dataset.fields.map((field) => ({
          key: journalKey(dataset.id, field.id),
          label: `${field.label} · ${journalDatasetLabel(dataset)}`,
          datasetId: dataset.id,
          field,
          icon:
            field.kind === 'number'
              ? Hash
              : field.kind === 'singleSelect'
                ? List
                : field.kind === 'multiSelect'
                  ? ListChecks
                  : Type
        }))
      )
    ],
    [datasets, t]
  )
  const initialRows = (): Row[] => [
    ...fixedFields.map((key, id) => ({ id, key, operator: 'equals' as const, value: '' })),
    ...journalFilters.map((filter, index) => ({
      id: index + 4,
      key: journalKey(filter.datasetId, filter.fieldId),
      operator: filter.operator,
      value: filter.value ?? ''
    }))
  ]
  const [rows, setRows] = useState(initialRows)
  const [appliedRows, setAppliedRows] = useState<AppliedRow[]>(() =>
    journalFilters.map((filter, index) => ({ id: index + 4, filter }))
  )
  const nextId = useRef(rows.length)
  const applied = JSON.stringify(journalFilters)
  const previousFilter = (row: Row): JournalAttributeFilter | undefined => {
    const filter = appliedRows.find(
      (entry) =>
        entry.id === row.id && journalKey(entry.filter.datasetId, entry.filter.fieldId) === row.key
    )?.filter
    // A parent reset or removed dataset must not be restored from local row history.
    return filter &&
      journalFilters.some(
        (current) =>
          current.datasetId === filter.datasetId &&
          current.fieldId === filter.fieldId &&
          current.operator === filter.operator &&
          current.value === filter.value
      )
      ? filter
      : undefined
  }
  const invalidRows = new Set(
    rows
      .filter(
        (row) =>
          fields.find((field) => field.key === row.key)?.field?.kind === 'number' &&
          row.operator !== 'missing' &&
          row.value.trim() !== '' &&
          !Number.isFinite(Number(row.value))
      )
      .map((row) => row.id)
  )
  const pendingRows = rows.flatMap((row): AppliedRow[] => {
    const field = fields.find((field) => field.key === row.key)
    if (!field || invalidRows.has(row.id)) {
      // Preserve only this row's applied condition, including duplicate fields.
      const existing = previousFilter(row)
      return existing ? [{ id: row.id, filter: existing }] : []
    }
    if (!field.datasetId || !field.field || (row.operator !== 'missing' && !row.value.trim()))
      return []
    return [
      {
        id: row.id,
        filter: {
          datasetId: field.datasetId,
          fieldId: field.field.id,
          operator: row.operator,
          ...(row.operator === 'missing' ? {} : { value: row.value.trim() })
        }
      }
    ]
  })
  const pending = JSON.stringify(pendingRows.map(({ filter }) => filter))
  const pendingRowState = JSON.stringify(pendingRows)
  const appliedRowState = JSON.stringify(appliedRows)
  useEffect(() => {
    if (pending === applied && pendingRowState === appliedRowState) return
    const timer = window.setTimeout(() => {
      // Equal query values can still belong to different rows after replacement or removal.
      setAppliedRows(JSON.parse(pendingRowState))
      if (pending !== applied) {
        onJournalFiltersChange(JSON.parse(pending))
        onFilterChange()
      }
    }, 400)
    return () => window.clearTimeout(timer)
  }, [pending, applied, pendingRowState, appliedRowState, onJournalFiltersChange, onFilterChange])
  const latest = useRef({ pending, applied, onJournalFiltersChange, onFilterChange })
  useEffect(() => {
    latest.current = { pending, applied, onJournalFiltersChange, onFilterChange }
  }, [pending, applied, onJournalFiltersChange, onFilterChange])
  useEffect(
    () => () => {
      // Closing the popover must not discard the last edit before the debounce finishes.
      const current = latest.current
      if (current.pending !== current.applied) {
        current.onJournalFiltersChange(JSON.parse(current.pending))
        current.onFilterChange()
      }
    },
    []
  )
  const clearField = (key: string): void => {
    if (key === 'tags') onTagChange('all')
    if (key === 'type') onItemTypeChange('all')
    if (key === 'pdf') onHasPdfChange('all')
    if (key === 'year') yearFilter.clear()
    onFilterChange()
  }
  const update = (id: number, patch: Partial<Row>): void =>
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)))
  const available = (id?: number): Field[] =>
    fields.filter((field) =>
      field.datasetId
        ? rows.filter((row) => !fixedFields.includes(row.key as FixedField)).length <
            JOURNAL_ATTRIBUTE_FILTER_MAX ||
          rows.some((row) => row.id === id && !fixedFields.includes(row.key as FixedField))
        : !rows.some((row) => row.id !== id && row.key === field.key)
    )
  const operators = {
    equals: t('Equals'),
    contains: t('Contains'),
    gt: t('Greater than'),
    gte: t('At least'),
    lt: t('Less than'),
    lte: t('At most'),
    missing: t('Is missing')
  }
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <p id={headingId} tabIndex={-1} className="text-sm font-medium outline-none">
          {t('Filters')}
        </p>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {t('Match all conditions')}
          <CollectionOptionHelp label={t('Filters')}>
            {t('Filters only change this view. They do not modify references.')}
          </CollectionOptionHelp>
        </div>
      </div>
      <div className="max-h-[min(28rem,60dvh)] space-y-3 overflow-y-auto">
        {rows.map((row) => {
          const field = fields.find((field) => field.key === row.key)
          const dynamic = Boolean(field?.datasetId)
          const options: JournalAttributeFilter['operator'][] =
            field?.field?.kind === 'number'
              ? ['equals', 'gt', 'gte', 'lt', 'lte', 'missing']
              : ['equals', 'contains', 'missing']
          return (
            <div
              key={row.id}
              className="grid grid-cols-[minmax(0,1fr)_2rem] items-start gap-2 sm:grid-cols-[minmax(0,1.2fr)_8rem_minmax(0,1.4fr)_2rem]"
            >
              <FieldPicker
                fields={available(row.id)}
                value={row.key}
                onChange={(key) => {
                  clearField(row.key)
                  update(row.id, { key, operator: 'equals', value: '' })
                }}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8 text-muted-foreground sm:col-start-4 sm:row-start-1"
                aria-label={t('Remove condition')}
                onClick={() => {
                  clearField(row.key)
                  setRows((current) => current.filter((entry) => entry.id !== row.id))
                }}
              >
                <X className="size-4" aria-hidden="true" />
              </Button>
              {dynamic ? (
                <Select
                  value={row.operator}
                  onValueChange={(value) => update(row.id, { operator: value as Row['operator'] })}
                >
                  <SelectTrigger
                    aria-label={t('Journal attribute operator')}
                    className="w-full min-w-0 sm:col-start-2 sm:row-start-1"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {options.map((operator) => (
                      <SelectItem key={operator} value={operator}>
                        {operators[operator]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <span className="flex h-8 items-center text-xs text-muted-foreground sm:col-start-2 sm:row-start-1">
                  {row.key === 'year' ? t('Between') : t('Equals')}
                </span>
              )}
              <div className="col-span-2 min-w-0 sm:col-span-1 sm:col-start-3 sm:row-start-1">
                {row.key === 'tags' ? (
                  <TagFilter
                    resourceType="literature.item"
                    value={tagId}
                    onChange={(value) => {
                      onTagChange(value)
                      onFilterChange()
                    }}
                    className="w-full"
                  />
                ) : null}
                {row.key === 'type' ? (
                  <Select
                    value={itemType}
                    onValueChange={(value) => {
                      onItemTypeChange(value as LiteratureItemType | 'all')
                      onFilterChange()
                    }}
                  >
                    <SelectTrigger aria-label={t('Reference type')} className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">{t('All')}</SelectItem>
                      {Object.entries(itemTypeLabels).map(([key, label]) => (
                        <SelectItem key={key} value={key}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : null}
                {row.key === 'year' ? <LiteratureYearFilter {...yearFilter} /> : null}
                {row.key === 'pdf' ? (
                  <Select
                    value={hasPdf}
                    onValueChange={(value) => {
                      onHasPdfChange(value as typeof hasPdf)
                      onFilterChange()
                    }}
                  >
                    <SelectTrigger aria-label={t('PDF')} className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">{t('All')}</SelectItem>
                      <SelectItem value="with">{t('With PDF')}</SelectItem>
                      <SelectItem value="without">{t('Without PDF')}</SelectItem>
                    </SelectContent>
                  </Select>
                ) : null}
                {dynamic && row.operator !== 'missing' ? (
                  <>
                    <Input
                      aria-label={t('Journal attribute value')}
                      aria-invalid={invalidRows.has(row.id)}
                      aria-describedby={
                        invalidRows.has(row.id) ? `${headingId}-${row.id}-error` : undefined
                      }
                      placeholder={t('Value')}
                      value={row.value}
                      maxLength={500}
                      onChange={(event) => update(row.id, { value: event.target.value })}
                    />
                    {invalidRows.has(row.id) ? (
                      <p
                        id={`${headingId}-${row.id}-error`}
                        role="alert"
                        className="mt-1 text-xs text-destructive"
                      >
                        {previousFilter(row)
                          ? t(
                              'Enter a valid number. This condition keeps its last applied setting.'
                            )
                          : t('Enter a valid number. This condition has not been applied.')}
                      </p>
                    ) : null}
                  </>
                ) : null}
              </div>
            </div>
          )
        })}
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-border pt-3">
        <FieldPicker
          fields={available()}
          disabled={!available().length}
          onChange={(key) => {
            const id = nextId.current++
            setRows((current) => [...current, { id, key, operator: 'equals', value: '' }])
          }}
        />
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            setRows(
              fixedFields.map((key) => ({
                id: nextId.current++,
                key,
                operator: 'equals',
                value: ''
              }))
            )
            onClear()
          }}
        >
          {t('Clear filters')}
        </Button>
      </div>
    </div>
  )
}
