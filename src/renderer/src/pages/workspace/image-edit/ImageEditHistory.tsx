import { Check, LoaderCircle } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  ArtifactVersionDescriptor,
  ImageVersionDependency
} from '../../../../../shared/artifact-provenance'
import type { ImageTask, ImageTaskList } from '../../../../../shared/image-task'
import { unwrapProvenanceRead } from '../../../../../shared/provenance-read-result'
import type { PreviewFileItem } from '@/stores/preview-workbench-contract'
import { Button } from '@/components/ui/button'
import { ErrorNotice } from '@/components/error-notice'
import { useCachedPreviewImage } from '../previews/useCachedPreviewImage'
import { ImageHistoryCanvas } from './ImageHistoryCanvas'
import {
  imageEditorSource,
  imageHistoryNodes,
  imageLineageRequest,
  type ImageHistoryNode
} from './image-editor-state'

type LineagePage = { artifactCursor?: string | null; imageCursor?: string }
type PageRequest = LineagePage & {
  taskBefore?: NonNullable<ImageTaskList['history']>['before'] | null
  related?: NonNullable<ReturnType<typeof imageEditorSource>>
}
type HistoryPage = {
  versions: ArtifactVersionDescriptor[]
  tasks: ImageTask[]
  dependencies: ImageVersionDependency[]
  next: PageRequest
}

function mergePage<T>(current: T[], incoming: T[], key: (item: T) => string): T[] {
  if (!incoming.length) return current
  const records = new Map(current.map((item) => [key(item), item]))
  for (const item of incoming) records.set(key(item), item)
  return [...records.values()]
}

function HistoryTile({
  item,
  selected,
  label,
  children,
  onClick,
  onEdit
}: {
  item: PreviewFileItem
  selected: boolean
  label: string
  children?: number
  onClick(): void
  onEdit(): void
}): React.JSX.Element {
  const { t } = useTranslation()
  const ref = useRef<HTMLButtonElement>(null)
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      rootMargin: '120px'
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const thumbnail = useCachedPreviewImage(item, visible, false, true)
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      aria-pressed={selected}
      data-image-history-version={item.selectedVersionId}
      className="group w-full min-w-0 cursor-grab rounded-md text-start outline-none active:cursor-grabbing focus-visible:ring-2 focus-visible:ring-ring"
      onClick={onClick}
      onDoubleClick={onEdit}
      onKeyDown={(event) => {
        if (event.key !== 'Enter') return
        event.preventDefault()
        onEdit()
      }}
    >
      <span
        className={`flex h-7 items-center gap-2 px-0.5 text-xs ${selected ? 'font-medium text-primary' : 'text-text-200'}`}
      >
        <span className="min-w-0 truncate">{label}</span>
        {children ? (
          <span className="truncate text-text-200">
            {t('{{count}} results', { count: children, defaultValue_one: '1 result' })}
          </span>
        ) : null}
        {selected ? <Check aria-hidden className="ml-auto size-3.5 shrink-0" /> : null}
      </span>
      <span
        className={`grid aspect-video place-items-center overflow-hidden rounded-md border border-border bg-bg-000 ${selected ? 'ring-2 ring-primary ring-offset-2 ring-offset-bg-100' : 'group-hover:ring-1 group-hover:ring-primary'}`}
      >
        {thumbnail.status === 'ready' ? (
          <img src={thumbnail.url} alt="" draggable={false} className="size-full object-contain" />
        ) : thumbnail.status === 'error' ? (
          <span className="px-3 text-center text-xs text-text-200">
            {t('Image could not be loaded.')}
          </span>
        ) : (
          <span className="size-full animate-pulse bg-bg-200 motion-reduce:animate-none" />
        )}
      </span>
    </button>
  )
}

// History pages are local to the canvas and never expand the live polling cache.
export function ImageEditHistory({
  source,
  selected,
  scope,
  branchId,
  onSelect
}: {
  source: PreviewFileItem
  selected: PreviewFileItem
  scope: Pick<ImageTaskList, 'projectId' | 'sessionId'>
  branchId: string
  onSelect(
    item: PreviewFileItem,
    input?: ReturnType<typeof imageEditorSource>,
    task?: ImageTask
  ): void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [request, setRequest] = useState<PageRequest>({})
  const [page, setPage] = useState<HistoryPage>({
    versions: [],
    tasks: [],
    dependencies: [],
    next: {}
  })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [relatedPages, setRelatedPages] = useState<ReadonlyMap<string, LineagePage>>(
    () => new Map()
  )
  const { projectId, sessionId } = scope
  const anchor = useMemo(() => imageEditorSource(source), [source])

  useEffect(() => {
    let active = true
    const read = async (): Promise<void> => {
      const { related } = request
      const target = related ?? anchor
      const [lineage, tasks] = await Promise.all([
        target && request.artifactCursor !== null
          ? window.api.artifacts
              .getLineage({
                ...imageLineageRequest(target),
                cursor: request.artifactCursor,
                imageCursor: request.imageCursor
              })
              .then(unwrapProvenanceRead)
          : undefined,
        !request.related && request.taskBefore !== null
          ? window.api.imageTasks.list({
              projectId,
              sessionId,
              history: { branchId, before: request.taskBefore }
            })
          : []
      ])
      if (!active) return
      const nextLineage: LineagePage = {
        artifactCursor: lineage?.nextImageCursor
          ? request.artifactCursor
          : (lineage?.nextCursor ?? null),
        imageCursor: lineage?.nextImageCursor
      }
      if (related)
        setRelatedPages((loaded) => new Map(loaded).set(related.sourceVersionId, nextLineage))
      const last = tasks.at(-1)
      setPage((old) => ({
        versions:
          request.imageCursor || !lineage
            ? old.versions
            : mergePage(
                old.versions,
                [
                  ...lineage.versions,
                  ...[lineage.selectedVersion, lineage.basedOnVersion].filter((item) => !!item)
                ],
                ({ versionId }) => versionId
              ),
        tasks: mergePage(old.tasks, tasks, ({ id }) => id),
        dependencies: mergePage(
          old.dependencies,
          lineage?.imageDependencies ?? [],
          ({ output, input }) => `${output.versionId}:${input.sourceVersionId}`
        ),
        next: request.related
          ? old.next
          : {
              ...nextLineage,
              taskBefore:
                tasks.length >= 32 && last ? { createdAt: last.createdAt, id: last.id } : null
            }
      }))
    }
    void read()
      .catch(() => {
        if (active) setError(true)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [anchor, projectId, sessionId, branchId, request])

  const roots = useMemo(
    () => imageHistoryNodes(source, selected, page.versions, page.tasks, page.dependencies),
    [source, selected, page.versions, page.tasks, page.dependencies]
  )
  const flat = [...roots]
  for (const node of flat) flat.push(...node.children)
  const hasLoadedHistory = page.next.taskBefore !== undefined
  const initialLoading = loading && !request.related && !hasLoadedHistory
  const hasMore =
    hasLoadedHistory && (page.next.artifactCursor !== null || page.next.taskBefore !== null)
  const complete =
    hasLoadedHistory &&
    !hasMore &&
    !Array.from(relatedPages.values()).some(({ artifactCursor }) => artifactCursor !== null) &&
    !error
  const byId = new Map(flat.map((node) => [node.item.selectedVersionId, node.item]))
  const unavailable = page.tasks.some(
    (task) =>
      task.error?.code === 'SOURCE_UNAVAILABLE' && byId.has(task.edit.source.sourceVersionId)
  )
  const render = (
    node: ImageHistoryNode,
    isSelected: boolean,
    select: () => void,
    edit: () => void
  ): React.JSX.Element => (
    <HistoryTile
      item={node.item}
      label={
        node.item.versionNumber !== undefined
          ? `v${node.item.versionNumber}`
          : node.parentId
            ? t('Result')
            : t('Source image')
      }
      selected={isSelected}
      onClick={select}
      onEdit={edit}
    >
      {complete && node.children.length > 1 ? node.children.length : undefined}
    </HistoryTile>
  )

  return (
    <section
      aria-label={t('Image history')}
      aria-busy={loading}
      className="flex min-h-0 flex-1 flex-col overflow-hidden bg-bg-100"
    >
      {error ? (
        <ErrorNotice
          inline
          title={t('Image results could not be verified.')}
          primaryButton={{
            label: t('Refresh'),
            onClick: () => {
              setLoading(true)
              setError(false)
              setRequest({ ...request })
            }
          }}
        />
      ) : null}
      {unavailable ? (
        <ErrorNotice inline level="warning" title={t('Some image results are unavailable.')} />
      ) : null}
      {initialLoading ? (
        <div role="status" className="flex flex-1 items-center justify-center p-4">
          <LoaderCircle
            aria-label={t('Loading…')}
            className="size-4 animate-spin motion-reduce:animate-none"
          />
        </div>
      ) : (
        <ImageHistoryCanvas
          roots={roots}
          selectedId={selected.selectedVersionId}
          renderTile={render}
          moreAction={
            !error && hasMore ? (
              <Button
                type="button"
                variant="link"
                size="sm"
                className="text-foreground"
                disabled={loading}
                onClick={() => {
                  setLoading(true)
                  setRequest(page.next)
                }}
              >
                {t('Load more')}
              </Button>
            ) : null
          }
          relatedAction={(node) => {
            const related = imageEditorSource(node.item)
            if (!related || related.sourceVersionId === anchor?.sourceVersionId) return null
            if (
              related.sourceFileId === anchor?.sourceFileId &&
              related.sourceKind === anchor.sourceKind &&
              page.versions.some(({ versionId }) => versionId === related.sourceVersionId)
            ) {
              // The main history already queried these versions. Its cursor owns any remaining pages.
              return null
            }
            const next = relatedPages.get(related.sourceVersionId)
            if (next?.artifactCursor === null) return null
            return (
              <Button
                type="button"
                variant="link"
                size="sm"
                className="min-w-0 shrink text-foreground"
                disabled={loading}
                onClick={() => {
                  setLoading(true)
                  setError(false)
                  setRequest({ related, ...next })
                }}
              >
                <span className="truncate">{t('Load related images')}</span>
              </Button>
            )
          }}
          onEdit={(node) => {
            const parent = byId.get(node.parentId)
            onSelect(
              node.item,
              node.task?.edit.source ?? (parent && imageEditorSource(parent)),
              node.task
            )
          }}
        />
      )}
    </section>
  )
}
