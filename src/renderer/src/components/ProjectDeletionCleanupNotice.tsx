import { InlineNotice } from '@/components/ui/inline-notice'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { useDateTimeFormat } from '@/hooks/useDateTimeFormat'
import { useProjectStore } from '@/stores/project-store'

type ProjectDeletionCleanupNoticeProps = {
  className?: string
}

const ProjectDeletionCleanupNotice = ({
  className
}: ProjectDeletionCleanupNoticeProps): React.JSX.Element | null => {
  const { t } = useTranslation()
  const formatDate = useDateTimeFormat()
  const cleanup = useProjectStore((state) => state.deletionCleanup)
  const retryDeletionCleanup = useProjectStore((state) => state.retryDeletionCleanup)
  const [isRetrying, setIsRetrying] = useState(false)
  const [retryFailed, setRetryFailed] = useState(false)

  if (cleanup.length === 0) return null

  const retry = (): void => {
    if (isRetrying) return
    setIsRetrying(true)
    setRetryFailed(false)
    void retryDeletionCleanup()
      .catch((error: unknown) => {
        console.warn('Project deletion cleanup retry failed', error)
        setRetryFailed(true)
      })
      .finally(() => setIsRetrying(false))
  }

  return (
    <InlineNotice aria-label={t('Project cleanup')} className={className}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div role="status" className="min-w-0 space-y-1">
          <p className="font-medium">{t('Project cleanup')}</p>
          <ul className="space-y-1">
            {cleanup.map((item) => {
              const project = item.projectName ?? t('Deleted project')
              return (
                <li key={item.projectId}>
                  {item.phase === 'running'
                    ? t('Cleaning up {{project}}…', { project })
                    : item.nextRetryAt === undefined
                      ? t('Cleanup for {{project}} is waiting to retry.', { project })
                      : t('Cleanup for {{project}} will retry at {{time}}.', {
                          project,
                          time: formatDate(item.nextRetryAt, 'timestamp')
                        })}
                  {item.failureCount > 0 ? (
                    <span className="ms-1 text-xs opacity-80">
                      {t('Failed attempts: {{attempts}}', { attempts: item.failureCount })}
                    </span>
                  ) : null}
                </li>
              )
            })}
          </ul>
          {retryFailed ? <p role="alert">{t('Could not retry project cleanup.')}</p> : null}
        </div>
        <Button type="button" variant="outline" size="sm" disabled={isRetrying} onClick={retry}>
          {isRetrying ? t('Retrying…') : t('Retry now')}
        </Button>
      </div>
    </InlineNotice>
  )
}

export { ProjectDeletionCleanupNotice }
