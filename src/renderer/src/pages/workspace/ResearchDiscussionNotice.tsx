import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { ErrorNotice } from '@/components/error-notice'
import { usePreviewWorkbenchStore } from '@/stores/preview-workbench-store'
import {
  createResearchReplayItem,
  type ResearchWorkspaceController
} from './workspace-research-controller'

export const ResearchDiscussionNotice = ({
  controller
}: {
  controller: ResearchWorkspaceController
}): React.JSX.Element | null => {
  const { t } = useTranslation()
  const [actionError, setActionError] = useState<string>()
  const [pending, setPending] = useState(false)
  const context = controller.research
  const perform = (action: () => Promise<void>): void => {
    if (pending) return
    setPending(true)
    void action()
      .catch((reason: unknown) =>
        setActionError(reason instanceof Error ? reason.message : String(reason))
      )
      .finally(() => setPending(false))
  }
  if (!context && !controller.error && !controller.loading) return null
  if (controller.error || actionError)
    return (
      <ErrorNotice
        title={t('Could not open the research discussion')}
        description={controller.error ?? actionError}
        primaryButton={{
          label: t('Retry'),
          onClick: () => {
            setActionError(undefined)
            controller.retry()
          }
        }}
      />
    )
  if (!context)
    return (
      <p role="status" className="px-4 py-2 text-xs text-muted-foreground">
        {t('Opening research…')}
      </p>
    )
  return (
    <section
      aria-label={t('Research discussion')}
      className="mx-4 mb-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium">{t('Discussing {{title}}', { title: context.sourceTitle })}</p>
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            usePreviewWorkbenchStore
              .getState()
              .upsertAndActivateItem(
                createResearchReplayItem(
                  context.projectId,
                  context.sourceSessionId,
                  t('Research replay')
                )
              )
          }
        >
          {t('Open research replay')}
        </Button>
      </div>
      <p className="text-muted-foreground">
        {t(
          'The original record is preserved. Your questions and new results are saved in this discussion.'
        )}
      </p>
      {controller.snapshot &&
      !['available', 'archived'].includes(controller.snapshot.sourceStatus) ? (
        <p role="status" className="mt-2 text-muted-foreground">
          {t('The source research is unavailable.')}
        </p>
      ) : null}
      {controller.blocked ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <p role="status">
            {controller.snapshot?.discussionStatus === 'archived'
              ? t('This discussion is archived. Restore it to continue.')
              : t(
                  'The research or its discussion is unavailable. You can still inspect the retained records.'
                )}
          </p>
          {controller.snapshot?.discussionStatus === 'missing' &&
          controller.snapshot.sourceStatus === 'available' ? (
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => perform(controller.recreateDiscussion)}
            >
              {t('Start a new discussion')}
            </Button>
          ) : null}
          {controller.snapshot?.discussionStatus === 'archived' ? (
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => perform(controller.restoreDiscussion)}
            >
              {t('Restore discussion')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
