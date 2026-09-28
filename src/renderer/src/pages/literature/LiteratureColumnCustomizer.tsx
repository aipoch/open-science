import { Columns3, Eye, EyeOff, GripVertical } from 'lucide-react'
import { useId, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { CollectionOptionHelp } from './CollectionOptionHelp'
import {
  selectJournalDatasets,
  type JournalDataset,
  type JournalSourceYears
} from '../../../../shared/journal-attributes'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

export function ColumnVisibility({
  label,
  checked,
  disabled = false,
  onCheckedChange
}: {
  label: string
  checked: boolean
  disabled?: boolean
  onCheckedChange: (checked: boolean) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={disabled}
            onClick={() => onCheckedChange(!checked)}
            aria-pressed={checked}
            aria-label={`${label}: ${checked ? t('Hide column') : t('Show column')}`}
            className={`size-8 shrink-0 cursor-pointer ${checked ? 'text-foreground' : 'text-muted-foreground'}`}
          >
            {checked ? (
              <Eye className="size-4" aria-hidden="true" />
            ) : (
              <EyeOff className="size-4" aria-hidden="true" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{checked ? t('Hide column') : t('Show column')}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

export function JournalDatasetChoices({
  datasets,
  years,
  onChange
}: {
  datasets: JournalDataset[]
  years: JournalSourceYears
  onChange: (source: string, year: number | null | undefined) => void
}): React.JSX.Element | null {
  const { t } = useTranslation()
  if (!datasets.length) return null
  return (
    <div className="space-y-2 border-b border-border px-2 pb-3 pt-2">
      <div className="flex items-center gap-1 text-xs font-medium">
        {t('Journal metric data')}
        <CollectionOptionHelp label={t('Journal metric data')}>
          <p>{t('Applies to all references, collections, projects and reference details.')}</p>
          <p className="mt-2">
            {t('Latest year uses imported datasets only. It does not download data.')}
          </p>
        </CollectionOptionHelp>
      </div>
      {selectJournalDatasets(datasets).map((latest) => {
        const year = Object.hasOwn(years, latest.source) ? years[latest.source] : undefined
        const choices = datasets
          .filter(({ source }) => source === latest.source)
          .sort((a, b) => b.year - a.year)
        return (
          <div key={latest.source} className="flex items-center justify-between gap-3">
            <span className="min-w-0 truncate text-sm" title={latest.source}>
              {latest.source}
            </span>
            <Select
              value={year === undefined ? 'latest' : year === null ? 'hidden' : String(year)}
              onValueChange={(value) =>
                onChange(
                  latest.source,
                  value === 'latest' ? undefined : value === 'hidden' ? null : Number(value)
                )
              }
            >
              <SelectTrigger
                className="w-44 shrink-0"
                aria-label={t('Journal data for {{source}}', { source: latest.source })}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="latest">
                  {t('Latest year ({{year}})', { year: latest.year })}
                </SelectItem>
                {choices.map((dataset) => (
                  <SelectItem key={dataset.id} value={String(dataset.year)}>
                    {dataset.year}
                  </SelectItem>
                ))}
                {typeof year === 'number' && !choices.some((dataset) => dataset.year === year) ? (
                  <SelectItem value={String(year)} disabled>
                    {year} · {t('Unavailable')}
                  </SelectItem>
                ) : null}
                <SelectItem value="hidden">{t('Do not show')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )
      })}
    </div>
  )
}

type DropTarget<Column extends string> = Readonly<{
  column: Column
  edge: 'before' | 'after'
}>

const LiteratureColumnCustomizer = <Column extends string>({
  journalSettings,
  columns,
  labels,
  onMove,
  onMoveBy,
  onVisibilityChange,
  visible
}: Readonly<{
  journalSettings?: ReactNode
  columns: readonly Column[]
  labels: Readonly<Record<Column, string>>
  onMove: (source: Column, target: Column, edge: 'before' | 'after') => void
  onMoveBy: (column: Column, delta: -1 | 1) => void
  onVisibilityChange: (column: Column, visible: boolean) => void
  visible: ReadonlySet<Column>
}>): React.JSX.Element => {
  const { t } = useTranslation()
  const titleId = useId()
  const [draggedColumn, setDraggedColumn] = useState<Column>()
  const [dropTarget, setDropTarget] = useState<DropTarget<Column>>()

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={t('Customize')}
          title={t('Customize')}
        >
          <Columns3 className="size-4" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        collisionPadding={8}
        aria-labelledby={titleId}
        className="flex max-h-[min(40rem,var(--radix-popover-content-available-height))] w-80 max-w-[calc(100vw-1rem)] flex-col overflow-hidden rounded-xl border border-border bg-bg-000 p-2 text-sm text-foreground shadow-lg"
      >
        <div className="shrink-0 px-2 pb-1.5 pt-1">
          <p id={titleId} className="text-sm font-medium">
            {t('Customize columns')}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t('Drag or use the up and down arrow keys to reorder. Select columns to show.')}
          </p>
        </div>
        <div className="min-h-0 overflow-y-auto overscroll-contain">
          {journalSettings}
          <div className="space-y-0.5" aria-label={t('Customize columns')}>
            {columns.map((column) => {
              const checked = visible.has(column)
              const dropBefore = dropTarget?.column === column && dropTarget.edge === 'before'
              const dropAfter = dropTarget?.column === column && dropTarget.edge === 'after'
              return (
                <div
                  key={column}
                  draggable
                  data-column={column}
                  className={cn(
                    'group relative flex min-h-10 items-center gap-2 rounded-lg px-2 outline-none',
                    'hover:bg-bg-200 focus-within:bg-bg-200',
                    draggedColumn === column && 'bg-bg-200/70 ring-1 ring-primary/30 ring-inset'
                  )}
                  onDragStart={(event) => {
                    setDraggedColumn(column)
                    event.dataTransfer.effectAllowed = 'move'
                    event.dataTransfer.setData('text/plain', column)
                  }}
                  onDragOver={(event) => {
                    event.preventDefault()
                    event.dataTransfer.dropEffect = 'move'
                    if (!draggedColumn) return
                    if (draggedColumn === column) {
                      setDropTarget(undefined)
                      return
                    }
                    const bounds = event.currentTarget.getBoundingClientRect()
                    setDropTarget({
                      column,
                      edge: event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after'
                    })
                  }}
                  onDrop={(event) => {
                    event.preventDefault()
                    const source = event.dataTransfer.getData('text/plain')
                    if (columns.includes(source as Column)) {
                      onMove(
                        source as Column,
                        column,
                        dropTarget?.column === column ? dropTarget.edge : 'before'
                      )
                    }
                    setDraggedColumn(undefined)
                    setDropTarget(undefined)
                  }}
                  onDragEnd={() => {
                    setDraggedColumn(undefined)
                    setDropTarget(undefined)
                  }}
                >
                  {dropBefore || dropAfter ? (
                    <span
                      aria-hidden="true"
                      data-slot="literature-column-drop-indicator"
                      data-edge={dropBefore ? 'before' : 'after'}
                      className={cn(
                        'pointer-events-none absolute right-1 left-1 z-10 h-0.5 rounded-full bg-primary',
                        dropBefore ? '-top-px' : '-bottom-px'
                      )}
                    />
                  ) : null}
                  <button
                    type="button"
                    className="flex size-7 shrink-0 cursor-grab items-center justify-center rounded-md text-muted-foreground outline-none active:cursor-grabbing focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={t('Move {{column}}', { column: labels[column] })}
                    onKeyDown={(event) => {
                      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                        event.preventDefault()
                        onMoveBy(column, event.key === 'ArrowUp' ? -1 : 1)
                      }
                    }}
                  >
                    <GripVertical className="size-4" aria-hidden="true" />
                  </button>
                  <span className="min-w-0 flex-1 truncate text-sm">{labels[column]}</span>
                  <ColumnVisibility
                    label={labels[column]}
                    checked={checked}
                    onCheckedChange={(next) => onVisibilityChange(column, next)}
                  />
                </div>
              )
            })}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

export { LiteratureColumnCustomizer }
