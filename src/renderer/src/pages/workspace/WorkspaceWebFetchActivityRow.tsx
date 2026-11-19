import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import type { ToolActivity } from '@/stores/session-store-contract'
import { ErrorNotice } from '@/components/error-notice'
import { ExternalTextLink } from '@/components/ExternalTextLink'
import { formatDateTime } from '@/lib/format-datetime'
import { resolveLocaleFromTags } from '../../../../shared/locale'
import { sanitizeToolDetailText } from '../../../../shared/tool-detail-sanitizer'
import type { WebResult } from '../../../../shared/web-tools'
import { WorkspaceToolActivityRowButton } from './WorkspaceToolActivityRowButton'
import {
  WorkspaceWebActivityDetails,
  WorkspaceWebActivityFact
} from './WorkspaceWebActivityDetails'
import type { ToolExecutionPhase } from './tool-execution-phase'
import { getWebFetchRequestUrl, safeWebUrl } from './workspace-web-fetch-details'

type Props = {
  activity: ToolActivity
  phase: ToolExecutionPhase
  result?: WebResult
  isExpanded: boolean
  onToggle: (activityId: string, nextExpanded: boolean) => void
}

const WorkspaceWebFetchActivityRow = ({
  activity,
  phase,
  result,
  isExpanded,
  onToggle
}: Props): React.JSX.Element => {
  const { t, i18n } = useTranslation()
  const locale = resolveLocaleFromTags([i18n.resolvedLanguage ?? i18n.language])
  const excerptTitleId = useId()
  const excerptNoteId = useId()
  const cancelled = phase === 'cancelled' || result?.error?.code === 'CANCELLED'
  const stopped = cancelled || ['declined', 'closed', 'interrupted'].includes(phase)
  // Execution authority wins over any late or stale success envelope.
  const document =
    !stopped && phase === 'completed' && result?.status === 'ok' ? result.document : undefined
  const failed = !stopped && (phase === 'failed' || result?.status === 'error')
  const originalUrl = getWebFetchRequestUrl(activity)
  const finalUrl = safeWebUrl(document?.final_url)
  const target = originalUrl ?? finalUrl
  const sourceUrl = finalUrl ?? originalUrl
  const duration = result ? `${Math.round(result.duration_ms)} ms` : undefined
  const status =
    phase === 'declined'
      ? t('Declined')
      : cancelled
        ? t('Cancelled')
        : stopped
          ? t('request ended')
          : failed
            ? t('Failed')
            : phase === 'completed'
              ? t('Completed')
              : t('Reading web page…')
  const error = result?.error
  const description =
    error?.code === 'UNSUPPORTED_CONTENT_TYPE'
      ? t('This page type cannot be read here. Use the literature tools for PDF documents.')
      : error?.code === 'BLOCKED_TARGET'
        ? t('This address is not a supported public web page. Choose a public HTTP or HTTPS URL.')
        : error?.code === 'NETWORK_MODE_UNSUPPORTED'
          ? t(
              'The current network configuration cannot safely read this page. Check your proxy settings.'
            )
          : error?.code === 'CONTENT_TOO_LARGE'
            ? t('This page is too large to read. Choose a smaller page.')
            : error?.code === 'EXTRACTION_FAILED'
              ? t('No readable page text was found. Try another public page.')
              : error?.code === 'INVALID_INPUT'
                ? t('The page address is invalid. Provide a complete public HTTP or HTTPS URL.')
                : undefined
  const source = (url: string): React.JSX.Element => (
    <ExternalTextLink
      href={url}
      title={url}
      className="block max-h-20 overflow-y-auto [overflow-wrap:anywhere] [&>svg]:ml-0.5 [&>svg]:inline-block [&>svg]:align-text-bottom"
    >
      {url}
    </ExternalTextLink>
  )

  const timestamp = (value: string): React.JSX.Element => (
    <time dateTime={value} title={value}>
      {formatDateTime(value, locale, 'dateTime') || value}
    </time>
  )

  return (
    <WorkspaceToolActivityRowButton
      activity={activity}
      phase={phase}
      label={t('Web Fetch')}
      subtitle={target ? new URL(target).hostname : undefined}
      metaLabel={[status, duration].filter(Boolean).join(' · ')}
      isExpanded={isExpanded}
      onToggle={onToggle}
      panelClassName="mx-1 mb-1.5 min-w-0 space-y-2 rounded-lg border border-border-200 bg-bg-000 px-2.5 py-2 text-[12.5px] leading-5 md:ml-[30px]"
      panelTestId="tool-web-fetch-details"
    >
      {failed ? (
        <ErrorNotice inline title={t('The web page could not be read')} description={description} />
      ) : stopped ? (
        <p role="status">{status}</p>
      ) : null}
      {document ? (
        <section className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3">
            <h3 id={excerptTitleId} className="font-medium">
              {t('Page excerpt')}
            </h3>
            {sourceUrl ? (
              <ExternalTextLink
                href={sourceUrl}
                className="min-w-0 text-xs [overflow-wrap:anywhere]"
              >
                <span className="min-w-0">{new URL(sourceUrl).hostname}</span>
              </ExternalTextLink>
            ) : null}
          </div>
          {document.truncated ? (
            <p id={excerptNoteId} className="text-xs text-text-100">
              {t('Partial page text')}
            </p>
          ) : null}
          <pre
            role="region"
            aria-labelledby={excerptTitleId}
            aria-describedby={document.truncated ? excerptNoteId : undefined}
            tabIndex={0}
            className="max-h-44 overflow-y-auto rounded-md border border-border-200 bg-bg-100 px-2.5 py-2 font-sans whitespace-pre-wrap [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-ring"
          >
            {sanitizeToolDetailText(document.text)}
          </pre>
        </section>
      ) : null}
      {phase === 'completed' && !stopped && !failed && !document ? (
        <p className="text-text-100">{t('Content unavailable')}</p>
      ) : null}
      {!stopped && (originalUrl || document || (failed && error)) ? (
        <WorkspaceWebActivityDetails>
          <dl className="grid min-w-0 gap-x-6 gap-y-2 sm:grid-cols-2">
            {originalUrl ? (
              <WorkspaceWebActivityFact label={t('Original URL')}>
                {source(originalUrl)}
              </WorkspaceWebActivityFact>
            ) : null}
            {finalUrl && finalUrl !== originalUrl ? (
              <WorkspaceWebActivityFact label={t('Final URL')}>
                {source(finalUrl)}
              </WorkspaceWebActivityFact>
            ) : null}
            {document ? (
              <WorkspaceWebActivityFact label={t('Fetched at')}>
                {timestamp(document.fetched_at)}
              </WorkspaceWebActivityFact>
            ) : null}
            {failed && error ? (
              <WorkspaceWebActivityFact label={t('Error')}>{error.code}</WorkspaceWebActivityFact>
            ) : null}
          </dl>
        </WorkspaceWebActivityDetails>
      ) : null}
    </WorkspaceToolActivityRowButton>
  )
}

export { WorkspaceWebFetchActivityRow }
