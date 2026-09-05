import * as Checkbox from '@radix-ui/react-checkbox'
import { Check, Columns3, GripVertical } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

type DropTarget<Column extends string> = Readonly<{
  column: Column
  edge: 'before' | 'after'
}>

const LiteratureColumnCustomizer = <Column extends string>({
  columns,
  labels,
  onMove,
  onMoveBy,
  onVisibilityChange,
  visible
}: Readonly<{
  columns: readonly Column[]
  labels: Readonly<Record<Column, string>>
  onMove: (source: Column, target: Column, edge: 'before' | 'after') => void
  onMoveBy: (column: Column, delta: -1 | 1) => void
  onVisibilityChange: (column: Column, visible: boolean) => void
  visible: ReadonlySet<Column>
}>): React.JSX.Element => {
  const { t } = useTranslation()
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
        className="w-80 rounded-xl border border-border bg-bg-000 p-2 text-sm text-foreground shadow-lg"
      >
        <div className="px-2 pb-1.5 pt-1">
          <p className="text-sm font-medium">{t('Customize columns')}</p>
          <p className="mt-0.5 text-xs whitespace-nowrap text-muted-foreground">
            {t('Drag to reorder. Select columns to show.')}
          </p>
        </div>
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
                <Checkbox.Root
                  id={`literature-column-${column}`}
                  checked={checked}
                  onCheckedChange={(nextChecked) =>
                    onVisibilityChange(column, nextChecked === true)
                  }
                  className="flex size-4 shrink-0 items-center justify-center rounded border border-border-100 bg-bg-000 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Checkbox.Indicator>
                    <Check className="size-3" aria-hidden="true" />
                  </Checkbox.Indicator>
                </Checkbox.Root>
                <label
                  htmlFor={`literature-column-${column}`}
                  className="min-w-0 flex-1 cursor-pointer truncate text-sm"
                >
                  {labels[column]}
                </label>
              </div>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}

export { LiteratureColumnCustomizer }
