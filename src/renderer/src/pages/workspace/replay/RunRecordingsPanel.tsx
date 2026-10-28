import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { ErrorNotice } from '@/components/error-notice'
import type { RecordingDiscovery } from './use-recording-discovery'
import type { RecordingCandidate } from './recording-discovery'
import { showRecordedObservation } from './open-run-observation'

export const RunRecordingsPanel = ({
  discovery,
  onChoose
}: {
  onChoose?: (candidate: RecordingCandidate) => void
  discovery: RecordingDiscovery
}): React.JSX.Element => {
  const { t, i18n } = useTranslation()
  return (
    <section
      aria-label={t('Run recordings')}
      className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3"
    >
      <p className="text-xs text-text-300">
        {t('Saved observations from this source. Opening a recording does not run the experiment.')}
      </p>
      {!discovery.supported ? (
        <p className="text-sm text-text-300">
          {t('Run recordings can be opened in the desktop app.')}
        </p>
      ) : null}
      {discovery.recordings.map((candidate) => {
        const { resource, target } = candidate
        return (
          <div
            key={`${target.artifactId}:${target.versionId}`}
            className="rounded-md border border-border-200 p-3"
          >
            <p className="text-sm font-medium text-text-100">{t('Saved run recording')}</p>
            <p className="mt-1 break-all text-xs text-text-300">{resource.name}</p>
            <p className="mt-1 text-xs text-text-300">
              {resource.versionNumber !== undefined
                ? t('Version {{number}}', { number: resource.versionNumber })
                : t('Version {{version}}', { version: target.versionId.slice(0, 8) })}
              {resource.createdAt !== undefined
                ? ` · ${new Date(resource.createdAt).toLocaleString(i18n.language)}`
                : ''}
            </p>
            <Button
              size="sm"
              variant="outline"
              className="mt-2"
              onClick={() =>
                onChoose
                  ? onChoose(candidate)
                  : showRecordedObservation(target, resource.name, candidate.format)
              }
            >
              {t('View saved run recording')}
            </Button>
          </div>
        )
      })}
      {discovery.supported &&
      !discovery.loading &&
      !discovery.recordings.length &&
      !discovery.unchecked &&
      !discovery.unavailable ? (
        <p className="text-sm text-text-300">
          {t(
            'No saved run recordings were found. The session process is available in the other tab.'
          )}
        </p>
      ) : null}
      {discovery.unavailable ? (
        <ErrorNotice
          inline
          tone="amber"
          description={t('Some source files could not be checked for run recordings.')}
          primaryButton={{
            label: t('Retry'),
            onClick: discovery.retry,
            disabled: discovery.loading
          }}
        />
      ) : null}
      {discovery.loading ? (
        <p role="status" className="text-xs text-text-300">
          {t('Looking for saved run recordings…')}
        </p>
      ) : null}
      {discovery.unchecked ? (
        <div className="space-y-2">
          <p className="text-xs text-text-300">
            {t('More source files remain to be checked. This list may be incomplete.')}
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={discovery.loading}
            onClick={discovery.loadMore}
          >
            {t('Check more files')}
          </Button>
        </div>
      ) : null}
    </section>
  )
}
