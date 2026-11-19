import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { LiteratureRelatedResult } from '@aipoch/literature-discovery/contracts'
import { ErrorNotice, type ErrorNoticeButton } from '@/components/error-notice'

export function CitationLookupError({
  result,
  sourceName,
  disabled,
  loading,
  onRetry,
  className,
  renderRetry,
  inline = true
}: {
  result: LiteratureRelatedResult
  sourceName: string
  disabled?: boolean
  loading?: boolean
  onRetry(): void
  className?: string
  renderRetry?(button: ErrorNoticeButton): React.ReactNode
  inline?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const [now, setNow] = useState(Date.now)
  const seconds = Math.max(0, Math.ceil(((result.retryAt ?? 0) - now) / 1000))
  const coolingDown = seconds > 0
  useEffect(() => {
    if (!coolingDown) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [coolingDown, result.retryAt])
  const messages = {
    'reference-changed': t('This reference changed. Reopen its details and try again.'),
    expired: t('These results expired. Search again.'),
    'rate-limited': t('{{source}} is limiting requests. Try again later.', { source: sourceName }),
    authentication: t('{{source}} rejected the request. Try again later.', { source: sourceName }),
    'no-match': t('No matching paper was found in {{source}}.', { source: sourceName }),
    timeout: t('The source timed out. Retry this reference.'),
    'source-limit': t('This response exceeds the supported size. Choose another citation source.'),
    'response-invalid': t(
      'The source returned an invalid response. Retry or choose another citation source.'
    ),
    unavailable: t('Citation discovery is temporarily unavailable. Try again.')
  }
  const retry =
    result.issue === 'reference-changed' || result.issue === 'source-limit'
      ? undefined
      : {
          label: coolingDown
            ? t('Retry in {{seconds}}s', { seconds })
            : result.issue === 'expired'
              ? t('Reload from starting paper')
              : t('Retry'),
          disabled: disabled || coolingDown,
          loading,
          onClick: () => {
            if (!disabled && !loading && (result.retryAt ?? 0) <= Date.now()) onRetry()
          }
        }
  return (
    <>
      <ErrorNotice
        inline={inline}
        className={className}
        role="alert"
        description={messages[result.issue ?? 'unavailable']}
        content={
          result.issue === 'no-match'
            ? t('Check the paper identifiers or choose another citation source.')
            : undefined
        }
        primaryButton={renderRetry ? undefined : retry}
      />
      {retry && renderRetry?.(retry)}
    </>
  )
}
