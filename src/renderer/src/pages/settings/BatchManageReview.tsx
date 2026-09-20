import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'

// Shared inline confirmation; the owning action bar manages entry and return focus.
export function BatchManageReview({
  title,
  description,
  summary,
  details,
  actions,
  onCancel,
  busy
}: {
  title: string
  description: ReactNode
  summary: ReactNode
  details: ReactNode
  actions: ReactNode
  onCancel: () => void
  busy: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <section
      data-slot="batch-manage-review"
      aria-label={title}
      className="space-y-3"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          if (!busy) onCancel()
        }
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 tabIndex={-1} data-slot="batch-review-title" className="text-sm font-semibold">
          {title}
        </h3>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onCancel}>
            {t('Cancel', { ns: 'common' })}
          </Button>
          {actions}
        </div>
      </div>
      <div className="text-xs leading-5 text-muted-foreground">{description}</div>
      <div className="space-y-1">{summary}</div>
      <details className="group">
        <summary className="flex min-h-9 cursor-pointer list-none items-center justify-between gap-2 rounded-sm text-xs font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
          {t('Details')}
          <ChevronDown aria-hidden="true" className="size-4 group-open:rotate-180" />
        </summary>
        <div className="space-y-3 pt-2 text-xs leading-5 [overflow-wrap:anywhere]">{details}</div>
      </details>
    </section>
  )
}
