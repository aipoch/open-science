import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'

export function LiteraturePagination({
  total,
  offset,
  pageSize,
  displayedCount = pageSize,
  countLabel,
  pageSizeLabel,
  disabled = false,
  loading = false,
  onOffsetChange,
  onPageSizeChange
}: {
  total: number
  offset: number
  pageSize: number
  displayedCount?: number
  countLabel: string
  pageSizeLabel: string
  disabled?: boolean
  loading?: boolean
  onOffsetChange: (offset: number) => void
  onPageSizeChange: (size: number) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const page = Math.floor(offset / pageSize) + 1
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const visible = new Set([1, pageCount, page - 1, page, page + 1])
  if (pageCount <= 7) for (let index = 1; index <= pageCount; index++) visible.add(index)
  if (page <= 4) for (let index = 2; index <= 5; index++) visible.add(index)
  if (page >= pageCount - 3)
    for (let index = pageCount - 4; index < pageCount; index++) visible.add(index)
  const pages = [...visible]
    .filter((index) => index >= 1 && index <= pageCount)
    .sort((a, b) => a - b)
  const items = pages.flatMap<number | 'ellipsis'>((value, index) =>
    index && value - pages[index - 1] > 1 ? ['ellipsis', value] : [value]
  )
  return (
    <fieldset
      disabled={disabled}
      className="flex min-h-11 shrink-0 flex-wrap items-center justify-between gap-3 border-t border-border-300/80 bg-bg-000 px-3 py-2"
    >
      <p className="text-xs text-muted-foreground tabular-nums">
        <span className="font-medium text-foreground">
          {total ? offset + 1 : 0}–{Math.min(offset + displayedCount, total)}
        </span>
        {' · '}
        {countLabel}
      </p>
      <div className="flex flex-wrap items-center justify-end gap-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="whitespace-nowrap">{pageSizeLabel}</span>
          <Select
            value={String(pageSize)}
            disabled={disabled || loading}
            onValueChange={(value) => onPageSizeChange(Number(value))}
          >
            <SelectTrigger
              aria-label={pageSizeLabel}
              className="h-7 w-16 bg-bg-000 text-xs tabular-nums"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              {[25, 50, 100].map((size) => (
                <SelectItem key={size} value={String(size)}>
                  {size}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {pageCount > 1 ? (
          <nav aria-label={t('Page {{page}}', { page })} className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t('Previous page')}
              disabled={page <= 1 || loading}
              onClick={() => onOffsetChange((page - 2) * pageSize)}
            >
              <ChevronLeft className="size-4" aria-hidden="true" />
            </Button>
            {items.map((item, index) =>
              item === 'ellipsis' ? (
                <span
                  key={`ellipsis-${index}`}
                  aria-hidden="true"
                  className="grid size-7 place-items-center text-xs text-muted-foreground"
                >
                  …
                </span>
              ) : (
                <Button
                  key={item}
                  type="button"
                  variant={item === page ? 'secondary' : 'ghost'}
                  size="icon-sm"
                  aria-label={t('Page {{page}}', { page: item })}
                  aria-current={item === page ? 'page' : undefined}
                  disabled={loading}
                  className="tabular-nums"
                  onClick={() => onOffsetChange((item - 1) * pageSize)}
                >
                  {item}
                </Button>
              )
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t('Next page')}
              disabled={page >= pageCount || loading}
              onClick={() => onOffsetChange(page * pageSize)}
            >
              <ChevronRight className="size-4" aria-hidden="true" />
            </Button>
          </nav>
        ) : null}
      </div>
    </fieldset>
  )
}
