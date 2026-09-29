import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ErrorNotice } from '@/components/error-notice'
import { Button } from '@/components/ui/button'
import type { WorkspaceConversationController } from './workspace-conversation-controller'

export type ResearchSubmissionQueueController =
  WorkspaceConversationController['researchSubmissions']
export const ResearchSubmissionQueue = ({
  controller
}: {
  controller: ResearchSubmissionQueueController
}): React.JSX.Element | null => {
  const { t } = useTranslation()
  const [pending, setPending] = useState<string>()
  const [error, setError] = useState<string>()
  const items = controller.items.filter((item) => item.state !== 'accepted')
  if (!items.length) return null
  const perform = (id: string, operation: () => Promise<unknown>): void => {
    if (pending) return
    setPending(id)
    setError(undefined)
    void operation()
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setPending(undefined))
  }
  return (
    <section
      className="mx-4 my-2 space-y-2 rounded-lg border p-3"
      aria-label={t('Saved research questions')}
    >
      <p className="text-xs font-medium">{t('Saved research questions')}</p>
      {error ? (
        <ErrorNotice title={t('Unable to update saved question')} description={error} />
      ) : null}
      <ol className="max-h-64 space-y-3 overflow-auto">
        {items.map((item) => (
          <li
            key={item.id}
            className="space-y-1 text-xs"
            data-research-submission-id={item.id}
            data-research-submission-state={item.state}
          >
            <p className="line-clamp-3 whitespace-pre-wrap break-words">{item.payload.text}</p>
            <p className="text-muted-foreground">
              {item.state === 'queued'
                ? t('Waiting to send')
                : item.state === 'sending'
                  ? t('Sending question…')
                  : item.state === 'failed'
                    ? t('Not sent')
                    : item.state === 'uncertain'
                      ? t('Delivery needs verification')
                      : t('Saved for recovery')}
            </p>
            {item.payload.attachments.length ? (
              <p className="break-words text-muted-foreground">
                {item.payload.attachments.map((file) => file.originalName).join(', ')}
              </p>
            ) : null}
            {item.state === 'uncertain' ? (
              <ErrorNotice
                title={t('Delivery needs verification')}
                description={t(
                  'Check the Discussion before sending again. This question will not be retried automatically.'
                )}
              />
            ) : null}
            {item.state === 'failed' ? (
              <ErrorNotice
                title={t('Not sent')}
                description={item.error ?? t('Your question and attachments remain saved.')}
              />
            ) : null}
            <div className="flex flex-wrap gap-2">
              {item.state === 'failed' ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={Boolean(pending)}
                  onClick={() => perform(item.id, () => controller.retry(item.id))}
                >
                  {t('Retry')}
                </Button>
              ) : null}
              {['queued', 'failed', 'uncertain'].includes(item.state) ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={Boolean(pending)}
                  onClick={() => perform(item.id, () => controller.cancel(item.id))}
                >
                  {t('Cancel sending')}
                </Button>
              ) : null}
              {['failed', 'uncertain', 'cancelled'].includes(item.state) ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={Boolean(pending)}
                  onClick={() =>
                    perform(item.id, async () => {
                      if (!(await controller.restore(item.id)))
                        throw new Error(
                          t(
                            'The saved question is safe. Clear the current draft before restoring it.'
                          )
                        )
                    })
                  }
                >
                  {t('Restore question to draft')}
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </section>
  )
}
