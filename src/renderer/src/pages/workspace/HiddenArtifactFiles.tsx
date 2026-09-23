import { useCallback, useEffect, useRef, useState } from 'react'
import { Download, LoaderCircle, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import * as Dialog from '@/components/ui/dialog'
import { dialogOverlayClassName, dialogPanelClassName } from '@/components/ui/dialog-chrome'
import type { ProjectFileItem, ProjectFilesPage } from '../../../../shared/project-files'
import type { ArtifactPreviewResult } from '../../../../shared/artifacts'
import { ArtifactHideButton } from './ArtifactHideButton'
import { ArtifactPreview } from './artifact-preview'
import { ProjectFileItems, type ProjectFilesViewMode } from './project-files-presentation-owner'
import { createProjectFilePreviewArtifact } from './project-files-preview-owner'
import { FilePageFooter, PageLoadError, SectionHeader } from './project-files-section'
import { useProjectFileInfiniteLoad } from './project-files-query-model'
import { useNearViewport } from './previews/useNearViewport'

const EMPTY_PREVIEWS = new Map<string, ArtifactPreviewResult>()
const isTextFile = (file: ProjectFileItem): boolean =>
  /^(text\/|application\/(json|xml|javascript))/.test(file.mimeType ?? '') ||
  /\.(txt|md|csv|json|xml|py|js|ts|r|yaml|yml|log)$/i.test(file.name)

// This local thumbnail never supplies a managed identity to ordinary preview components.
const HiddenThumbnailContent = ({ file }: { file: ProjectFileItem }): React.JSX.Element => {
  const [preview, setPreview] = useState<ArtifactPreviewResult>()
  const image = file.mimeType?.startsWith('image/')
  useEffect(() => {
    if (!image && !isTextFile(file)) return
    let current = true
    void window.api.projectFiles
      .readHiddenArtifact({
        projectId: file.projectId,
        fileId: file.sourceFileId,
        versionId: file.sourceVersionId,
        encoding: image ? 'base64' : 'utf8',
        maxBytes: image ? 1024 * 1024 : 32 * 1024
      })
      .then(
        (value) => {
          if (current) setPreview(value)
        },
        () => {}
      )
    return () => {
      current = false
    }
  }, [file, image])
  return (
    <div className="size-full">
      {image && preview && !preview.truncated ? (
        <img
          src={`data:${file.mimeType};base64,${preview.content}`}
          alt={file.name}
          className="size-full object-cover"
        />
      ) : (
        <ArtifactPreview
          artifact={createProjectFilePreviewArtifact(file)}
          preview={image ? undefined : preview}
        />
      )}
    </div>
  )
}

// Unmount the reader outside the viewport so paginated files cannot accumulate retained bytes.
const HiddenThumbnail = ({ file }: { file: ProjectFileItem }): React.JSX.Element => {
  const [elementRef, visible] = useNearViewport<HTMLDivElement>()
  return (
    <div ref={elementRef} className="size-full">
      {visible ? <HiddenThumbnailContent file={file} /> : null}
    </div>
  )
}

// Hidden content is scoped to this filter and discarded on navigation or visibility changes.
export const HiddenArtifactFiles = ({
  projectId,
  query,
  viewMode,
  onCountChange
}: {
  projectId: string
  query: string
  viewMode: ProjectFilesViewMode
  onCountChange?: (count: number) => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const [revision, setRevision] = useState(0)
  const [page, setPage] = useState<ProjectFilesPage>()
  const [error, setError] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [selected, setSelected] = useState<ProjectFileItem>()
  const [preview, setPreview] = useState<ArtifactPreviewResult>()
  const [previewError, setPreviewError] = useState(false)
  const generation = useRef(0)

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
    const request = ++generation.current
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPage(undefined)
    setError(false)
    setLoadingMore(false)
    setSelected(undefined)
    onCountChange?.(0)
    void window.api.projectFiles
      .listFiles({
        projectId,
        collection: { kind: 'hidden' },
        limit: 20,
        ...(query ? { search: { filenameContains: query } } : {})
      })
      .then(
        (value) => {
          if (request === generation.current) {
            setPage(value)
            onCountChange?.(value.totalCount)
          }
        },
        () => {
          if (request === generation.current) setError(true)
        }
      )
    return () => {
      generation.current = request + 1
    }
  }, [projectId, query, revision, onCountChange])

  useEffect(() => {
    let current = true
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

  const loadMore = useCallback(async (): Promise<void> => {
    if (!page?.nextCursor || loadingMore) return
    const request = generation.current
    setLoadingMore(true)
    try {
      const next = await window.api.projectFiles.listFiles({
        projectId,
        collection: { kind: 'hidden' },
        limit: 20,
        cursor: page.nextCursor,
        ...(query ? { search: { filenameContains: query } } : {})
      })
      if (request === generation.current) {
        setPage({ ...next, items: [...page.items, ...next.items] })
        onCountChange?.(next.totalCount)
      }
    } catch {
      if (request === generation.current) setError(true)
    } finally {
      if (request === generation.current) setLoadingMore(false)
    }
  }, [page, loadingMore, projectId, query, onCountChange])
  const sentinelRef = useProjectFileInfiniteLoad(
    Boolean(page?.nextCursor) && !loadingMore && !error && !collapsed,
    loadMore
  )
  const download = async (file: ProjectFileItem): Promise<void> => {
    setDownloading(true)
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
      setDownloading(false)
    }
  }
  const actions = (file: ProjectFileItem): React.JSX.Element => (
    <>
      <ArtifactHideButton
        projectId={projectId}
        fileId={file.sourceFileId}
        name={file.name}
        hidden
      />
      <Button
        variant="outline"
        size="icon-sm"
        className="bg-bg-000/95"
        disabled={downloading}
        aria-label={t('Download {{name}}', { name: file.name })}
        onClick={() => void download(file)}
      >
        <Download aria-hidden="true" />
      </Button>
    </>
  )
  const isText = selected && isTextFile(selected)

  return (
    <div className="min-h-0 flex-1 overflow-y-auto pb-4" data-testid="hidden-artifacts">
      {error ? (
        <PageLoadError
          message={t('Could not load project files.')}
          onRetry={() => setRevision((value) => value + 1)}
        />
      ) : null}
      {!page && !error ? (
        <div className="flex justify-center p-4">
          <LoaderCircle className="size-4 animate-spin" aria-label={t('Loading...')} />
        </div>
      ) : null}
      {page?.items.length === 0 ? (
        <div className="flex h-full items-center justify-center px-6 text-center text-[12px] text-text-300">
          {query ? t('No files match “{{query}}”', { query }) : t('No files yet')}
        </div>
      ) : null}
      {page && page.items.length > 0 ? (
        <section>
          <SectionHeader
            id="hidden"
            title={t('Hidden')}
            countLabel={`${page.totalCount}`}
            isCollapsed={collapsed}
            hideTopBorder
            onToggle={() => setCollapsed((value) => !value)}
          />
          {!collapsed ? (
            <>
              <ProjectFileItems
                key={revision}
                files={page.items}
                viewMode={viewMode}
                previewById={EMPTY_PREVIEWS}
                onPreview={setSelected}
                restrictedPresentation={(file) => ({
                  preview: <HiddenThumbnail file={file} />,
                  actions: actions(file)
                })}
              />
              <FilePageFooter
                page={{
                  ...page,
                  isLoaded: true,
                  isLoading: loadingMore,
                  error: error ? 'error' : undefined
                }}
                mode={typeof IntersectionObserver === 'undefined' ? 'manual' : 'scroll'}
                visibleItemCount={page.items.length}
                loadMoreLabel={t('Load more')}
                onLoadMore={() => void loadMore()}
              />
              <div ref={sentinelRef} className="h-px" aria-hidden="true" />
            </>
          ) : null}
        </section>
      ) : null}
      <Dialog.Root
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open) setSelected(undefined)
        }}
      >
        {selected ? (
          <Dialog.Portal>
            <Dialog.Overlay className={dialogOverlayClassName} />
            <Dialog.Content
              aria-describedby={undefined}
              className={dialogPanelClassName(
                'flex h-[85vh] w-[min(96vw,1400px)] flex-col overflow-hidden p-0'
              )}
            >
              <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2">
                <Dialog.Title className="min-w-0 flex-1 truncate text-sm">
                  {selected.name}
                </Dialog.Title>
                {actions(selected)}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('Close preview')}
                  onClick={() => setSelected(undefined)}
                >
                  <X aria-hidden="true" />
                </Button>
              </div>
              <div className="min-h-0 flex-1 overflow-auto p-4">
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
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        ) : null}
      </Dialog.Root>
    </div>
  )
}
