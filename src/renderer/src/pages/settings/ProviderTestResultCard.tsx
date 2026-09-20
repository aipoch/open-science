import { useTranslation } from 'react-i18next'
import { AlertTriangle, CheckCircle2, ChevronRight, Pencil } from 'lucide-react'

import { cn } from '@/lib/utils'
import { noticeTitleClassName, noticeToneClassNames } from '@/components/ui/notice-chrome'

import type { ValidateProviderResult } from '../../../../shared/settings'
import { CATEGORY_KEYS, describeValidation } from './validation-message'

// Test-connection outcome card for the Provider form footer. The verdict uses the app's status
// callout treatment (tinted circle + semibold title, as in StorageMigrationModal) so the outcome
// reads at a glance; the actionable category copy, tested-target chips and gateway diagnostics
// stay secondary beneath it. Both verdict strings reuse existing translated copy.
type ProviderTestResultCardProps = {
  result: ValidateProviderResult
}

const chipClassName =
  'inline-flex h-5 max-w-full shrink-0 items-center gap-1.5 overflow-hidden rounded-4xl border border-border px-2 text-xs leading-none'

const ProviderTestResultCard = ({ result }: ProviderTestResultCardProps): React.JSX.Element => {
  const { t } = useTranslation()
  const ok = result.ok
  const Icon = ok ? CheckCircle2 : AlertTriangle
  // A verified endpoint the active framework cannot drive stays a success with a warning body.
  const incompatible = ok && result.frameworkIncompatible === true
  const description = incompatible
    ? t(CATEGORY_KEYS.incompatible)
    : ok
      ? undefined
      : t(CATEGORY_KEYS[result.category])

  return (
    <section
      role={ok ? 'status' : 'alert'}
      aria-atomic={true}
      className="flex min-w-0 flex-col gap-3 rounded-2xl border border-border bg-card p-4 text-sm text-foreground"
    >
      <div className="flex min-w-0 items-start gap-3">
        <span
          aria-hidden="true"
          className={cn(
            'flex size-9 shrink-0 items-center justify-center rounded-full',
            noticeToneClassNames[ok ? 'success' : 'warning']
          )}
        >
          <Icon className="size-[18px]" strokeWidth={1.8} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h3 className={noticeTitleClassName}>
            {ok ? t(CATEGORY_KEYS.ok) : t('Connection test failed.')}
          </h3>
          {description ? (
            <p
              className={cn(
                'whitespace-pre-wrap text-sm leading-6 [overflow-wrap:anywhere]',
                incompatible
                  ? 'text-status-warning-foreground dark:text-status-warning-dark-foreground'
                  : 'text-muted-foreground'
              )}
            >
              {description}
            </p>
          ) : null}
          {result.testedTarget || result.status ? (
            <div className="mt-1 flex flex-wrap gap-1.5">
              {result.testedTarget?.model ? (
                <span className={chipClassName}>
                  <span className="shrink-0 text-muted-foreground">{t('Model')}</span>
                  <span className="min-w-0 truncate font-medium" title={result.testedTarget.model}>
                    {result.testedTarget.model}
                  </span>
                </span>
              ) : null}
              {result.testedTarget?.endpoint ? (
                <span className={chipClassName}>
                  <span className="shrink-0 text-muted-foreground">{t('API format')}</span>
                  <span className="font-medium">{result.testedTarget.endpoint}</span>
                </span>
              ) : null}
              {result.status ? (
                <span className={chipClassName}>
                  <span className="shrink-0 text-muted-foreground">HTTP</span>
                  <span className="font-medium">{result.status}</span>
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 border-t border-border pt-2.5">
        <p className="col-start-1 row-start-1 inline-flex items-center gap-1.5 whitespace-nowrap text-xs leading-5 text-muted-foreground">
          <Pencil className="size-3 shrink-0" aria-hidden="true" />
          {t('Changes have not been saved.')}
        </p>
        {result.message || result.status || result.frameworkIncompatible ? (
          <details className="col-start-1 col-end-3 row-start-1 block min-w-0">
            <summary className="ml-auto flex w-fit cursor-pointer list-none items-center gap-1 rounded-sm text-xs leading-5 text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
              <ChevronRight className="size-3 shrink-0 group-open:rotate-90" aria-hidden="true" />
              {t('View details')}
            </summary>
            {/* Block (not flex) details: Chromium wraps non-summary children in an internal shadow
                box, so a flex container would content-size that box against align-items and shrink
                the diagnostics to the right. In block flow the paragraph fills the details element,
                which the grid spans across both columns above — full card width when expanded. */}
            <p className="mt-2 max-h-32 w-full overflow-y-auto whitespace-pre-wrap rounded-lg bg-muted px-3 py-2.5 font-mono text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">
              {describeValidation(result, t)}
            </p>
          </details>
        ) : null}
      </div>
    </section>
  )
}

export { ProviderTestResultCard }
