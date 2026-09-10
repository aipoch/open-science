import { useEffect, useState } from 'react'
import { Download, Eye, EyeOff, LoaderCircle, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import type { ProjectFileItem, ProjectFilesPage } from '../../../../shared/project-files'
import type { ArtifactPreviewResult } from '../../../../shared/artifacts'

// The mutation owns no file data. Main persists visibility and broadcasts catalog invalidation.
export const ArtifactHideButton = ({
  projectId,
  fileId,
  name,
  hidden = false
}: {
  projectId: string
  fileId: string
  name: string
  hidden?: boolean
}): React.JSX.Element => {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const change = async (): Promise<void> => {
    setBusy(true)
    setError(false)
    try {
      await window.api.projectFiles.setArtifactHidden({ projectId, fileId, hidden: !hidden })
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        disabled={busy}
        className="bg-bg-000/95"
        aria-label={hidden ? t('Unhide {{name}}', { name }) : t('Hide {{name}}', { name })}
        onClick={() => void change()}
      >
        {busy ? (
          <LoaderCircle className="animate-spin" aria-hidden="true" />
        ) : hidden ? (
          <Eye aria-hidden="true" />
        ) : (
          <EyeOff aria-hidden="true" />
        )}
      </Button>
      {error ? (
        <span role="alert" className="text-xs text-text-200">
          {t('Could not change file visibility.')}
        </span>
      ) : null}
    </>
  )
}

// This surface unmounts on filter/navigation changes. Hidden content never enters the ordinary
// thumbnail cache, persisted preview tabs, composer, or split-panel workbench.
export const HiddenArtifactFiles = ({
  projectId,
  query
}: {
  projectId: string
  query: string
}): React.JSX.Element => {
  const { t } = useTranslation()
  const [revision, setRevision] = useState(0)
  const [page, setPage] = useState<ProjectFilesPage>()
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<ProjectFileItem>()
  const [preview, setPreview] = useState<ArtifactPreviewResult>()
  const [previewError, setPreviewError] = useState(false)

  useEffect(
    () =>
      window.api.projectFiles.onChanged((event) => {
        if (event.projectId === projectId) {
          setRevision((value) => value + 1)
          setSelected(undefined)
        }
      }),
    [projectId]
  )

  useEffect(() => {
    let current = true
    // Discard the previous query immediately while its replacement request is in flight.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPage(undefined)
    setError(false)
    setSelected(undefined)
    void window.api.projectFiles
      .listFiles({
        projectId,
        collection: { kind: 'hidden' },
        limit: 20,
        ...(query ? { search: { filenameContains: query } } : {})
      })
      .then(
        (value) => {
          if (current) setPage(value)
        },
        () => {
          if (current) setError(true)
        }
      )
    return () => {
      current = false
    }
  }, [projectId, query, revision])

  useEffect(() => {
    let current = true
    // A new selection must never display the previous file while its read is in flight.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPreview(undefined)
    setPreviewError(false)
    if (selected)
      void window.api.projectFiles
        .readHiddenArtifact({
          projectId,
          fileId: selected.sourceFileId,
          versionId: selected.sourceVersionId,
          encoding: selected.mimeType?.startsWith('image/') ? 'base64' : 'utf8'
        })
        .then(
          (value) => {
            if (current) setPreview(value)
          },
          () => {
            if (current) setPreviewError(true)
          }
        )
    return () => {
      current = false
    }
  }, [projectId, selected])

  const loadMore = async (): Promise<void> => {
    if (!page?.nextCursor || busy) return
    setBusy(true)
    try {
      const next = await window.api.projectFiles.listFiles({
        projectId,
        collection: { kind: 'hidden' },
        limit: 20,
        cursor: page.nextCursor,
        ...(query ? { search: { filenameContains: query } } : {})
      })
      setPage((current) =>
        current === page ? { ...next, items: [...page.items, ...next.items] } : current
      )
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }
  const download = async (file: ProjectFileItem): Promise<void> => {
    setBusy(true)
    try {
      const result = await window.api.saveProjectArtifacts({
        projectId,
        suggestedArchiveName: file.name,
        files: [
          {
            source: 'artifact',
            hidden: true,
            sessionId: file.sessionId,
            fileId: file.sourceFileId,
            versionId: file.sourceVersionId,
            suggestedName: file.name
          }
        ]
      })
      if (result.saved && result.failures?.length) setError(true)
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }
  const isText =
    selected &&
    (/^(text\/|application\/(json|xml|javascript))/.test(selected.mimeType ?? '') ||
      /\.(txt|md|csv|json|xml|py|js|ts|r|yaml|yml|log)$/i.test(selected.name))

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4" data-testid="hidden-artifacts">
      {error ? (
        <div role="alert">
          <span>{t('Could not load project files.')}</span>
          <Button
            onClick={() => {
              setError(false)
              setRevision((value) => value + 1)
            }}
          >
            {t('Retry')}
          </Button>
        </div>
      ) : null}
      {!page && !error ? (
        <LoaderCircle className="size-4 animate-spin" aria-label={t('Loading...')} />
      ) : null}
      {page?.items.length === 0 ? (
        <p className="text-sm text-text-300">{t('No files yet')}</p>
      ) : null}
      {page?.items.map((file) => (
        <div key={file.id} className="flex items-center gap-2 rounded-md px-2 py-2 hover:bg-bg-200">
          <EyeOff className="size-4 shrink-0 text-text-300" aria-hidden="true" />
          <button
            className="min-w-0 flex-1 truncate text-left text-sm"
            onClick={() => setSelected(file)}
          >
            {file.name}
          </button>
          <Button
            variant="outline"
            size="icon-sm"
            disabled={busy}
            aria-label={t('Download {{name}}', { name: file.name })}
            onClick={() => void download(file)}
          >
            <Download aria-hidden="true" />
          </Button>
          <ArtifactHideButton
            projectId={projectId}
            fileId={file.sourceFileId}
            name={file.name}
            hidden
          />
        </div>
      ))}
      {page?.nextCursor ? (
        <Button disabled={busy} onClick={() => void loadMore()}>
          {t('Load more')}
        </Button>
      ) : null}
      {selected ? (
        <section className="mt-4 rounded-lg bg-bg-100 p-4" aria-label={selected.name}>
          <div className="mb-3 flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-sm">{selected.name}</span>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('Close preview')}
              onClick={() => setSelected(undefined)}
            >
              <X aria-hidden="true" />
            </Button>
          </div>
          {previewError ? (
            <p role="alert">{t('Could not load file preview.')}</p>
          ) : preview ? (
            selected.mimeType?.startsWith('image/') && !preview.truncated ? (
              <img
                className="max-h-[60vh] max-w-full"
                src={`data:${selected.mimeType};base64,${preview.content}`}
                alt={selected.name}
              />
            ) : isText ? (
              <pre className="whitespace-pre-wrap break-words text-xs">{preview.content}</pre>
            ) : (
              <p className="text-sm text-text-300">{t('Download this file to view it.')}</p>
            )
          ) : (
            <LoaderCircle className="size-4 animate-spin" aria-label={t('Loading...')} />
          )}
          {preview?.truncated && isText ? (
            <p className="mt-2 text-xs text-text-300">{t('Preview truncated.')}</p>
          ) : null}
        </section>
      ) : null}
    </div>
  )
}
