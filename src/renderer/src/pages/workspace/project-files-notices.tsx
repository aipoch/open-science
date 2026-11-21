import { useTranslation } from 'react-i18next'
import { ErrorNotice } from '@/components/error-notice'
import { Button } from '@/components/ui/button'
import type { ProjectFilesError, ProjectFilesIndexState } from './use-project-files-index'

const PageLoadError = ({
  error,
  searching = false,
  failedCursor,
  onRetry
}: {
  error: ProjectFilesError
  searching?: boolean
  failedCursor?: string
  onRetry: () => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const message = searching
    ? failedCursor
      ? t('Could not load more search results.')
      : t('Could not load search results.')
    : failedCursor
      ? t('Could not load more project files.')
      : t('Could not load project files')
  return (
    <div className="px-4 py-3">
      <ErrorNotice
        role="alert"
        description={
          error.connection
            ? [message, t('Reconnect to the local service and try again.')].join('\n')
            : message
        }
        primaryButton={{ label: t('Retry'), onClick: onRetry }}
      />
    </div>
  )
}

const ProjectFilesIndexNotice = ({
  catalogIndex
}: {
  catalogIndex: ProjectFilesIndexState
}): React.JSX.Element => {
  const { t } = useTranslation()
  const repairError = catalogIndex.repairError
  const directoryUnreadable =
    repairError?.detail ===
    'Project files cannot be repaired until the sessions directory is readable.'
  const needsStatusCheck = Boolean(
    !catalogIndex.overview.isIndexComplete &&
    repairError &&
    !directoryUnreadable &&
    repairError.connection !== 'desktop-runtime-not-submitted'
  )
  const repairMessage = directoryUnreadable
    ? t('Restore read access to the sessions folder, then retry indexing.')
    : repairError?.connection === 'desktop-runtime-not-submitted'
      ? t('Reconnect to the local service and retry indexing.')
      : needsStatusCheck
        ? catalogIndex.overviewError
          ? t('Could not check the file index status.')
          : repairError?.connection
            ? t('Reconnect to check whether indexing finished.')
            : t('Could not confirm whether indexing finished.')
        : t('Some files could not be indexed yet.')

  return (
    <>
      {!catalogIndex.overview.isIndexComplete ? (
        <div className="mx-4 mb-2 flex items-center justify-between gap-3 border-l-2 border-status-warning-foreground/30 dark:border-status-warning-dark-foreground/30 px-3 py-2 text-[11px] text-text-200">
          <span className="min-w-0 flex-1">{repairMessage}</span>
          <Button
            type="button"
            variant="outline"
            size="xs"
            aria-label={needsStatusCheck ? undefined : t('Retry indexing project files')}
            disabled={
              catalogIndex.isRepairing || (needsStatusCheck && !catalogIndex.isOverviewLoaded)
            }
            onClick={needsStatusCheck ? catalogIndex.reloadOverview : catalogIndex.repairIndex}
          >
            {needsStatusCheck
              ? t('Check index status')
              : t(catalogIndex.isRepairing ? 'Retrying...' : 'Retry')}
          </Button>
        </div>
      ) : null}

      {catalogIndex.overviewError && !needsStatusCheck ? (
        <PageLoadError error={catalogIndex.overviewError} onRetry={catalogIndex.reloadOverview} />
      ) : null}
    </>
  )
}

export { PageLoadError, ProjectFilesIndexNotice }
