import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { formatBytes } from '../../../../shared/update'
import type {
  ArtifactReproducibilityActivity,
  ArtifactReproducibilityStartFrontier
} from '../../../../shared/artifact-provenance'
import type { NodeStartPreview } from './artifact-reproducibility-start'

export const ReproducibilityStartPreview = ({
  preview,
  activityLabel,
  frontierLabel,
  issues,
  busy,
  disabledReason,
  error,
  onStart
}: {
  preview: NodeStartPreview
  activityLabel: (activity: ArtifactReproducibilityActivity) => string
  frontierLabel: (frontier: ArtifactReproducibilityStartFrontier) => string
  issues: string[]
  busy: boolean
  disabledReason?: string
  error?: boolean
  onStart: (frontierId: string) => Promise<void>
}): React.JSX.Element => {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const id = useId()
  const plan = preview.effective ?? preview.requested
  return (
    <div className="mt-4 border-t border-border-300/60 pt-3 text-xs" data-node-start-preview>
      <Button
        variant="outline"
        size="sm"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        {t('Check from here')}
      </Button>
      {open ? (
        <div id={id} className="mt-3 min-w-0 space-y-3">
          <p className="text-text-300">
            {t('This preview uses saved metadata only. Files are read when the check starts.')}
          </p>
          {preview.requested ? (
            <p className="font-medium text-text-100">{frontierLabel(preview.requested)}</p>
          ) : null}
          {preview.dependencies.length ? (
            <div className="space-y-1 text-status-warning-foreground dark:text-status-warning-dark-foreground">
              <p>{t('This point still depends on earlier Notebook state.')}</p>
              <ul className="space-y-1">
                {preview.dependencies.map((dependency, index) => (
                  <li key={index} className="[overflow-wrap:anywhere]">
                    {dependency.from && dependency.to
                      ? t('{{run}} requires state from {{upstream}}.', {
                          run: activityLabel(dependency.to),
                          upstream: activityLabel(dependency.from)
                        })
                      : t('The complete dependency path could not be reconstructed.')}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {preview.needsPreparation && preview.effective ? (
            <div className="space-y-1 rounded-md bg-bg-200/55 p-2.5">
              <p>
                {t('The check will start earlier and rerun the preparation steps listed below.')}
              </p>
              <p className="font-medium">{frontierLabel(preview.effective)}</p>
            </div>
          ) : null}
          {preview.unavailableFiles.length ? (
            <div className="space-y-1 text-status-warning-foreground dark:text-status-warning-dark-foreground">
              <p>{t('Some required files cannot be restored safely.')}</p>
              <ul>
                {preview.unavailableFiles.map((file) => (
                  <li key={file.entityId} className="[overflow-wrap:anywhere]">
                    {file.label}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {!preview.effective ? (
            <div
              role="status"
              className="space-y-1 text-status-warning-foreground dark:text-status-warning-dark-foreground"
            >
              <p>
                {preview.noDownstream
                  ? t('No downstream runs remain after this point.')
                  : !preview.requested
                    ? t('No saved starting point is available for this node.')
                    : t('This starting point cannot be restored safely.')}
              </p>
              {!preview.noDownstream && issues.map((issue) => <p key={issue}>{issue}</p>)}
            </div>
          ) : null}
          {preview.missingFileMetadata ? (
            <p className="text-status-warning-foreground dark:text-status-warning-dark-foreground">
              {t('Captured file metadata is missing.')}
            </p>
          ) : null}
          {preview.missingRunMetadata ? (
            <p className="text-status-warning-foreground dark:text-status-warning-dark-foreground">
              {t('The complete dependency path could not be reconstructed.')}
            </p>
          ) : null}
          {plan ? (
            <>
              <div>
                <p className="mb-1 font-medium text-text-100">
                  {t('Files to restore')} ·{' '}
                  {formatBytes(preview.files.reduce((bytes, file) => bytes + file.sizeBytes, 0))}
                </p>
                <ul className="max-h-40 space-y-1 overflow-auto">
                  {preview.files.map((file) => (
                    <li
                      key={file.entityId}
                      className="flex min-w-0 items-center justify-between gap-2"
                    >
                      <span className="truncate" title={file.label}>
                        {file.label}
                      </span>
                      <span className="shrink-0 tabular-nums text-text-300">
                        {formatBytes(file.sizeBytes)}
                      </span>
                    </li>
                  ))}
                </ul>
                {!preview.files.length ? <p className="text-text-300">{t('None')}</p> : null}
              </div>
              <div>
                <p className="mb-1 font-medium text-text-100">
                  {t('Runs to execute')} · {preview.steps.length}
                </p>
                <ol className="max-h-40 space-y-1 overflow-auto">
                  {preview.steps.map((step) => (
                    <li key={step.activityId} className="flex min-w-0 justify-between gap-2">
                      <span className="truncate" title={activityLabel(step)}>
                        {activityLabel(step)}
                      </span>
                      {preview.preparationIds.has(step.activityId) ? (
                        <span className="shrink-0 text-text-300">{t('Preparation')}</span>
                      ) : null}
                    </li>
                  ))}
                </ol>
              </div>
              {preview.effective ? (
                <p className="text-text-300">
                  {plan.claimScope === 'end-to-end'
                    ? t('End-to-end claim')
                    : t('Downstream-only claim')}
                </p>
              ) : null}
            </>
          ) : null}
          {disabledReason ? <p className="text-text-300">{disabledReason}</p> : null}
          {error ? (
            <p
              role="alert"
              className="text-status-warning-foreground dark:text-status-warning-dark-foreground"
            >
              {t('Check failed')}
            </p>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            disabled={
              !preview.effective || preview.missingFileMetadata || busy || Boolean(disabledReason)
            }
            onClick={() => {
              if (preview.effective) void onStart(preview.effective.frontierId)
            }}
          >
            {busy ? t('Checking…') : t('Start check')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
