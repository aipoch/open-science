import { useTranslation } from 'react-i18next'
import type { ToolActivity } from '@/stores/session-store-contract'
import type { PackageWebActivityEvidence } from '../../../../shared/session-package-web'
import { sanitizeToolDetailText } from '../../../../shared/tool-detail-sanitizer'
import { PackageWebOmissions } from '@/components/PackageWebOmissions'
import { ExternalTextLink } from '@/components/ExternalTextLink'
import { ErrorNotice } from '@/components/error-notice'
import {
  WorkspaceWebActivityDetails,
  WorkspaceWebActivityFact
} from './WorkspaceWebActivityDetails'
import { WorkspaceToolActivityRowButton } from './WorkspaceToolActivityRowButton'
import { getToolExecutionPhase } from './tool-execution-phase'
import { safeWebUrl } from './workspace-web-fetch-details'

export const WorkspacePackageWebActivityRow = ({
  activity,
  evidence,
  isExpanded,
  onToggle
}: {
  activity: ToolActivity
  evidence: PackageWebActivityEvidence
  isExpanded: boolean
  onToggle: (id: string, expanded: boolean) => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const text = (value: string): string => sanitizeToolDetailText(value)
  const link = (url: string): React.ReactNode => {
    const safe = safeWebUrl(url)
    return safe ? (
      <ExternalTextLink href={safe} className="max-w-full [overflow-wrap:anywhere]">
        {safe}
      </ExternalTextLink>
    ) : null
  }
  const activityPhase = getToolExecutionPhase(activity, undefined)
  const ended = ['cancelled', 'declined', 'closed', 'interrupted'].includes(activityPhase)
  const phase = ended
    ? activityPhase
    : evidence.errorCode === 'CANCELLED'
      ? 'cancelled'
      : activityPhase === 'failed' || evidence.status === 'error'
        ? 'failed'
        : evidence.status === 'ok'
          ? 'completed'
          : 'closed'
  const stopped = ended || phase === 'cancelled'
  const status =
    phase === 'cancelled'
      ? t('Cancelled')
      : phase === 'declined'
        ? t('Declined')
        : t('request ended')
  const document = evidence.document
  const originalUrl = evidence.requestUrl ?? document?.originalUrl
  return (
    <WorkspaceToolActivityRowButton
      activity={activity}
      phase={phase}
      label={evidence.operation === 'fetch' ? t('Web Fetch') : t('Web Search')}
      subtitle={evidence.query ? text(evidence.query) : undefined}
      metaLabel={t('Read-only')}
      isExpanded={isExpanded}
      onToggle={onToggle}
      panelClassName="mx-1 mb-1.5 min-w-0 space-y-3 rounded-[10px] border border-border-200 bg-bg-000 px-3.5 py-3 text-xs leading-5 md:ml-[30px]"
      panelTestId="package-web-evidence"
    >
      {stopped ? (
        <p role="status">{status}</p>
      ) : phase === 'failed' ? (
        <ErrorNotice
          inline
          title={
            evidence.operation === 'fetch'
              ? t('The web page could not be read')
              : t('The web search could not finish')
          }
        />
      ) : null}
      {!stopped &&
      (evidence.status === 'unavailable' ||
        evidence.resultKind === 'restricted_grounded_result') ? (
        <p className="text-text-100">{t('Result unavailable')}</p>
      ) : null}
      {!stopped &&
        evidence.sources
          .filter(({ title, url, snippet }) => title || url || snippet)
          .map((source) => (
            <article
              key={source.sourceId}
              className="min-w-0 space-y-1"
              data-testid="package-web-source"
            >
              {source.title ? (
                <h3 className="font-medium [overflow-wrap:anywhere]">{text(source.title)}</h3>
              ) : null}
              {source.url ? <div>{link(source.url)}</div> : null}
              {source.snippet ? (
                <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">
                  {text(source.snippet)}
                </p>
              ) : null}
            </article>
          ))}
      {!stopped &&
      evidence.operation === 'fetch' &&
      evidence.status === 'ok' &&
      document?.text === undefined ? (
        <p className="text-text-100">{t('Content unavailable')}</p>
      ) : null}
      {!stopped && document?.text !== undefined ? (
        <section>
          <h3 className="font-medium">{t('Page excerpt')}</h3>
          {document.truncated ? <p className="text-text-100">{t('Partial page text')}</p> : null}
          <pre className="mt-2 whitespace-pre-wrap font-mono [overflow-wrap:anywhere]">
            {text(document.text)}
          </pre>
        </section>
      ) : null}
      <PackageWebOmissions omissions={evidence.omissions} />
      {!stopped &&
      (originalUrl || document?.finalUrl || document?.fetchedAt || evidence.errorCode) ? (
        <WorkspaceWebActivityDetails>
          <dl className="grid min-w-0 gap-2">
            {originalUrl ? (
              <WorkspaceWebActivityFact label={t('Original URL')}>
                {link(originalUrl)}
              </WorkspaceWebActivityFact>
            ) : null}
            {document?.finalUrl && document.finalUrl !== originalUrl ? (
              <WorkspaceWebActivityFact label={t('Final URL')}>
                {link(document.finalUrl)}
              </WorkspaceWebActivityFact>
            ) : null}
            {document?.fetchedAt ? (
              <WorkspaceWebActivityFact label={t('Fetched at')}>
                <time dateTime={document.fetchedAt}>{document.fetchedAt}</time>
              </WorkspaceWebActivityFact>
            ) : null}
            {evidence.errorCode ? (
              <WorkspaceWebActivityFact label={t('Error')}>
                {text(evidence.errorCode)}
              </WorkspaceWebActivityFact>
            ) : null}
          </dl>
        </WorkspaceWebActivityDetails>
      ) : null}
    </WorkspaceToolActivityRowButton>
  )
}
