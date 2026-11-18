import { LoaderCircle, RotateCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { LiteratureRelatedRequest } from '@aipoch/literature-discovery/contracts'

export function CitationLookupLoading({
  direction,
  queued = false
}: {
  direction: LiteratureRelatedRequest['direction']
  queued?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div data-slot="citation-loading" role="status" className="space-y-3">
      <div className="flex items-start gap-2 py-2">
        {!queued && (
          <LoaderCircle
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-primary motion-safe:animate-spin"
          />
        )}
        <div>
          <p className="text-sm font-medium">{queued ? t('Queued') : t('Searching…')}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {direction === 'references'
              ? t('Papers referenced by this paper.')
              : t('Papers that cite this paper.')}
          </p>
        </div>
      </div>
      <div aria-hidden="true" className="divide-y divide-border-300">
        {['w-4/5', 'w-3/5', 'w-5/6'].map((width) => (
          <div key={width} className="space-y-2 py-3">
            <div className={`h-3 rounded bg-muted ${width}`} />
            <div className="h-2.5 w-1/2 rounded bg-muted" />
          </div>
        ))}
      </div>
    </div>
  )
}

export function CitationPageActionLabel({
  loading,
  retryLabel
}: {
  loading: boolean
  retryLabel?: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const Icon = loading ? LoaderCircle : retryLabel ? RotateCw : undefined
  return (
    <>
      {loading ? t('Loading…') : (retryLabel ?? t('Load more'))}
      {Icon && (
        <Icon
          aria-hidden="true"
          className={loading ? 'size-4 motion-safe:animate-spin' : 'size-4'}
        />
      )}
    </>
  )
}
