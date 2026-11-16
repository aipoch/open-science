import { ChevronDown, File, RotateCcw, ShieldCheck } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { ErrorNotice } from '@/components/error-notice'
import { errorDetail } from '@/lib/error-detail'
import type { ProjectFolderChange } from '../../../../shared/project-folder-changes'

type Preview = Awaited<ReturnType<typeof window.api.notebook.previewProjectFolderChange>>

const ProjectFolderChangeReviewContent = ({
  change,
  receipt = false
}: {
  change: ProjectFolderChange
  receipt?: boolean
}): React.JSX.Element => {
  const { t } = useTranslation()
  const [current, setCurrent] = useState(change)
  const [preview, setPreview] = useState<Preview>()
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [loadingPreview, setLoadingPreview] = useState(false)
  const [error, setError] = useState<unknown>()
  const generation = useRef(0)
  const undoPending = useRef(false)
  useEffect(() => {
    const request = ++generation.current
    if (receipt) {
      void window.api.notebook
        .inspectProjectFolderChange({
          projectId: change.projectId,
          sessionId: change.sessionId,
          id: change.id
        })
        .then(
          (value) => {
            if (generation.current === request) setCurrent(value)
          },
          (reason) => {
            if (generation.current === request) setError(reason)
          }
        )
    }
    return () => {
      generation.current += 1
    }
  }, [change.id, change.projectId, change.sessionId, receipt])
  const togglePreview = (): void => {
    const next = !expanded
    setExpanded(next)
    if (!next) {
      generation.current += 1
      setLoadingPreview(false)
      return
    }
    if (preview) return
    const request = ++generation.current
    setLoadingPreview(true)
    setError(undefined)
    void window.api.notebook
      .previewProjectFolderChange({
        projectId: change.projectId,
        sessionId: change.sessionId,
        id: change.id
      })
      .then(
        (value) => {
          if (generation.current === request) setPreview(value)
        },
        (reason) => {
          if (generation.current === request) setError(reason)
        }
      )
      .finally(() => {
        if (generation.current === request) setLoadingPreview(false)
      })
  }
  const pending = current.state === 'prepared'
  const title = pending
    ? t('Review file changes')
    : current.state === 'rejected'
      ? t('Change rejected')
      : current.state === 'reverted'
        ? t('Original file restored')
        : current.operation === 'delete'
          ? t('File deleted')
          : t('File replaced')
  const undo = async (): Promise<void> => {
    if (undoPending.current) return
    undoPending.current = true
    setBusy(true)
    setError(undefined)
    try {
      setCurrent(
        await window.api.notebook.revertProjectFolderChange({
          projectId: change.projectId,
          sessionId: change.sessionId,
          id: change.id
        })
      )
      setPreview(undefined)
    } catch (reason) {
      setError(reason)
    } finally {
      undoPending.current = false
      setBusy(false)
    }
  }
  return (
    <section
      className="min-w-0 space-y-3"
      aria-label={title}
      data-testid="project-folder-change-review"
    >
      {receipt ? (
        <div className="flex items-center gap-2 text-sm font-medium">
          <ShieldCheck className="size-4" aria-hidden="true" />
          {title}
        </div>
      ) : null}
      <div className="flex min-w-0 items-start gap-2.5 rounded-lg border border-border p-3">
        <File className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0">
          <p className="break-all text-sm font-medium">{current.relativePath}</p>
          <p className="text-xs text-muted-foreground">
            {current.operation === 'delete'
              ? t('Delete existing file')
              : current.operation === 'create'
                ? t('Create file')
                : t('Replace existing file')}
          </p>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        {pending
          ? current.operation === 'delete'
            ? t('The original file has not been deleted. A backup will be saved before deletion.')
            : t(
                'The prepared result is ready. Your original file is unchanged. A backup will be saved before replacement.'
              )
          : current.state === 'rejected'
            ? t('The original file was not changed.')
            : current.state === 'reverted'
              ? t('The original file has been restored from its backup.')
              : t('Backup available outside your project folder.')}
      </p>
      {pending && current.operation !== 'delete' ? (
        <>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-expanded={expanded}
            onClick={togglePreview}
          >
            <ChevronDown className="size-4" aria-hidden="true" />
            {t('View changes')}
          </Button>
          {expanded ? (
            <div
              className="space-y-3 rounded-lg border border-border p-3"
              aria-busy={loadingPreview}
            >
              {loadingPreview ? (
                <p className="text-xs text-muted-foreground" role="status">
                  {t('Loading…')}
                </p>
              ) : null}
              {preview
                ? (['original', 'candidate'] as const).map((side) => {
                    const file = preview[side]
                    if (!file) return null
                    return (
                      <div key={side}>
                        <p className="mb-1 text-xs font-medium">
                          {side === 'original' ? t('Original') : t('Prepared result')}
                        </p>
                        {file.binary ? (
                          <p className="text-xs text-muted-foreground">
                            {t('Binary file · {{size}} bytes', { size: file.sizeBytes })}
                          </p>
                        ) : (
                          <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 text-xs">
                            {file.text}
                          </pre>
                        )}
                        {file.truncated ? (
                          <p className="text-xs text-muted-foreground">{t('Preview truncated')}</p>
                        ) : null}
                      </div>
                    )
                  })
                : null}
            </div>
          ) : null}
        </>
      ) : null}
      {error ? (
        <ErrorNotice
          inline
          title={t('Could not complete the file change action')}
          description={t('Your saved change record is still available. Try again.')}
          content={errorDetail(error)}
        />
      ) : null}
      {receipt && current.state === 'applied' ? (
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void undo()}>
          <RotateCcw className="size-4" aria-hidden="true" />
          {t('Undo')}
        </Button>
      ) : null}
      {receipt && current.state === 'reverted' ? (
        <p role="status" className="sr-only">
          {t('Original file restored')}
        </p>
      ) : null}
    </section>
  )
}

export const ProjectFolderChangeReview = (props: {
  change: ProjectFolderChange
  receipt?: boolean
}): React.JSX.Element => (
  <ProjectFolderChangeReviewContent
    key={`${props.change.projectId}:${props.change.sessionId}:${props.change.id}:${props.change.state}`}
    {...props}
  />
)
