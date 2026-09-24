import { ChevronDown } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { ErrorNotice } from '@/components/error-notice'
import { cn } from '@/lib/utils'
import type { ProjectFileItem } from '../../../../shared/project-files'
import type { PageState } from './use-project-files-index'

export type FilePageLoadMode = 'manual' | 'scroll'
export const loadMoreButtonClassName = 'bg-bg-200 text-text-100 hover:bg-bg-300 hover:text-text-000'

export const SectionHeader = ({
  id,
  title,
  countLabel,
  isCollapsed,
  hideTopBorder = false,
  onToggle
}: {
  id: string
  title: string
  countLabel: string
  isCollapsed: boolean
  hideTopBorder?: boolean
  onToggle: (id: string) => void
}): React.JSX.Element => (
  <button
    type="button"
    data-testid="project-file-section-header"
    className={cn(
      'flex w-full min-w-0 items-center gap-1.5 px-4 py-2 text-left text-sm text-text-000 hover:bg-bg-100',
      id.startsWith('session:') && 'cursor-default',
      !hideTopBorder && 'border-t border-border-300/40'
    )}
    aria-expanded={!isCollapsed}
    onClick={() => onToggle(id)}
  >
    <ChevronDown
      className={cn(
        'size-3 shrink-0 text-text-300 transition-transform motion-reduce:transition-none',
        isCollapsed && '-rotate-90'
      )}
      strokeWidth={2}
      aria-hidden="true"
    />
    <span className="min-w-0 flex-1 truncate">{title}</span>
    <span className="shrink-0 text-[11px] text-text-300">{countLabel}</span>
  </button>
)

export const PageLoadError = ({
  message,
  onRetry
}: {
  message: string
  onRetry: () => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  return (
    <div className="px-4 py-3">
      <ErrorNotice
        role="alert"
        description={message}
        primaryButton={{ label: t('Retry'), onClick: onRetry }}
      />
    </div>
  )
}

// All mode uses a compact per-section button; category mode normally scroll-loads. Both modes share
// the same terminal state so each upload/session section says No more independently.
export const FilePageFooter = ({
  page,
  mode,
  visibleItemCount,
  loadMoreLabel,
  onLoadMore
}: {
  page: PageState<ProjectFileItem> | undefined
  mode: FilePageLoadMode
  visibleItemCount: number
  loadMoreLabel: string
  onLoadMore: () => void
}): React.JSX.Element | null => {
  const { t } = useTranslation()

  if (!page?.isLoaded || page.error || page.items.length === 0) return null

  const hasMore = visibleItemCount < page.items.length || Boolean(page.nextCursor)

  if (!hasMore && !page.isLoading) {
    return (
      <div
        data-testid="project-files-end"
        className="px-4 py-2 text-center text-[11px] text-text-000"
      >
        {t('No more')}
      </div>
    )
  }

  if (mode !== 'manual' || !hasMore) return null

  return (
    <div className="flex justify-center px-4 py-2">
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className={loadMoreButtonClassName}
        aria-label={loadMoreLabel}
        disabled={page.isLoading}
        onClick={onLoadMore}
      >
        {t(page.isLoading ? 'Loading...' : 'Load more')}
      </Button>
    </div>
  )
}
