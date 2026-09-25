/* Hallmark · component: library preview · genre: modern-minimal · theme: existing workspace
 * Pre-emit critique: P5 H4 E4 S5 R5 V4. Preserve project tokens and native control states.
 */
import {
  BookOpen,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FileText,
  Maximize2,
  Search
} from 'lucide-react'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ErrorNotice } from '@/components/error-notice'
import { useNavigationStore } from '@/stores/navigation-store'
import { usePreviewWorkbenchStore } from '@/stores/preview-workbench-store'
import { cn } from '@/lib/utils'
import {
  createLiteratureAttachmentVersionReference,
  type LiteratureItemView,
  type LiteratureCatalogSearchPage
} from '../../../../../shared/literature'
import { readLiteratureDisplayPage } from '../../literature/literature-read-pages'
import { useLiteratureChanges } from '../../literature/useLiteratureChanges'
import { LITERATURE_PREVIEW_SESSION_ID } from '../preview-file-item'

const PAGE_SIZE = 20
const ABSTRACT_EXCERPT_LENGTH = 300

type Selection = { query: string; all: boolean; offset: number; expanded?: string }

const pdfAttachments = (entry: LiteratureItemView): LiteratureItemView['attachments'] =>
  entry.attachments.filter(({ versions }) => {
    const version = versions[0]
    return (
      version &&
      (version.contentType.split(';')[0].trim().toLowerCase() === 'application/pdf' ||
        version.filename.toLowerCase().endsWith('.pdf'))
    )
  })

function ReferenceRow({
  entry,
  expanded,
  onToggle
}: {
  entry: LiteratureItemView
  expanded: boolean
  onToggle: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const detailId = useId()
  const [showMore, setShowMore] = useState(false)
  const creators = entry.item.creators
    .map((creator) =>
      creator.nameMode === 'organization'
        ? creator.literalName
        : [creator.givenName, creator.familyName].filter(Boolean).join(' ')
    )
    .filter(Boolean)
  const pdfs = pdfAttachments(entry)
  const abstract = entry.item.abstract
  return (
    <li className="min-w-0 border-b border-border last:border-0">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={detailId}
        onClick={onToggle}
        className="flex w-full min-w-0 items-start gap-2 rounded-md px-3 py-3 text-left hover:bg-muted active:bg-muted focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-[-2px]"
      >
        <ChevronDown
          aria-hidden="true"
          className={cn('mt-0.5 size-4 shrink-0 text-muted-foreground', !expanded && '-rotate-90')}
        />
        <span className="min-w-0 flex-1 space-y-1">
          <span
            className={cn(
              'block text-sm font-medium [overflow-wrap:anywhere]',
              !expanded && 'line-clamp-2'
            )}
          >
            {entry.item.title}
          </span>
          <span
            className={cn(
              'block text-xs text-muted-foreground',
              !expanded && 'truncate',
              expanded && '[overflow-wrap:anywhere]'
            )}
          >
            {[
              expanded ? creators.join('; ') : creators[0],
              entry.item.issuedYear ?? entry.item.issuedText
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
          {entry.item.containerTitle && (
            <span
              className={cn(
                'block text-xs text-muted-foreground',
                !expanded && 'truncate',
                expanded && '[overflow-wrap:anywhere]'
              )}
            >
              {entry.item.containerTitle}
            </span>
          )}
        </span>
        {pdfs.length > 0 && (
          <FileText
            className="mt-0.5 size-4 shrink-0 text-muted-foreground"
            aria-label={
              pdfs.some(({ versions }) => versions[0].availability !== 'unavailable')
                ? t('PDF available')
                : t('PDF unavailable')
            }
          />
        )}
      </button>
      {expanded && (
        <div
          id={detailId}
          className="min-w-0 space-y-3 px-3 pb-4 pl-9 text-xs [overflow-wrap:anywhere]"
        >
          <div className="space-y-1">
            <h3 className="font-medium">{t('Abstract')}</h3>
            <p className="whitespace-pre-wrap leading-relaxed text-muted-foreground">
              {abstract
                ? showMore
                  ? abstract
                  : abstract.slice(0, ABSTRACT_EXCERPT_LENGTH) +
                    (abstract.length > ABSTRACT_EXCERPT_LENGTH ? '…' : '')
                : t('No abstract available.')}
            </p>
            {abstract.length > ABSTRACT_EXCERPT_LENGTH && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowMore(!showMore)}
                aria-expanded={showMore}
              >
                {showMore ? t('Show less') : t('Show more')}
              </Button>
            )}
          </div>
          {pdfs.length ? (
            <div className="space-y-1">
              {pdfs.map((attachment) => {
                const version = attachment.versions[0]
                return (
                  <Button
                    key={attachment.id}
                    variant="outline"
                    size="sm"
                    className="w-full min-w-0 justify-start"
                    disabled={version.availability === 'unavailable'}
                    title={
                      version.availability === 'unavailable'
                        ? t('PDF unavailable')
                        : version.filename
                    }
                    onClick={() =>
                      usePreviewWorkbenchStore.getState().upsertAndActivateItem({
                        id: `literature:${version.id}`,
                        sessionId: LITERATURE_PREVIEW_SESSION_ID,
                        title: version.filename,
                        type: 'file',
                        source: 'literature',
                        format: 'pdf',
                        managedFileId: attachment.id,
                        selectedVersionId: version.id,
                        path: createLiteratureAttachmentVersionReference(version.id),
                        name: version.filename,
                        mimeType: version.contentType,
                        size: version.sizeBytes,
                        versionNumber: version.versionNumber
                      })
                    }
                  >
                    <FileText aria-hidden="true" />
                    <span className="truncate">{version.filename}</span>
                  </Button>
                )
              })}
            </div>
          ) : (
            <p className="text-muted-foreground">{t('No PDF attached.')}</p>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => useNavigationStore.getState().openLiteratureItem(entry.id, 'user')}
          >
            <Maximize2 aria-hidden="true" />
            {t('View in Literature')}
          </Button>
        </div>
      )}
    </li>
  )
}

// Mount only while visible. A single current page owns both reads and change subscriptions;
// key changes discard obsolete responses and large record payloads, without an all-library cache.
function LibraryResults({
  projectId,
  selection,
  onChange,
  openLiterature
}: {
  projectId?: string
  selection: Selection
  onChange: (selection: Selection) => void
  openLiterature: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [page, setPage] = useState<LiteratureCatalogSearchPage>()
  const [failed, setFailed] = useState(false)
  const [revision, setRevision] = useState(0)
  const generation = useRef(0)
  const { query, all, offset } = selection
  const refresh = (): void => {
    generation.current += 1
    setFailed(false)
    setRevision((value) => value + 1)
  }
  useLiteratureChanges(refresh)
  useLayoutEffect(
    () => () => {
      generation.current += 1
    },
    []
  )
  useEffect(() => {
    const ticket = ++generation.current
    const current = (): boolean => generation.current === ticket
    const timer = window.setTimeout(
      () => {
        void readLiteratureDisplayPage(
          {
            scope: 'library',
            lifecycle: 'active',
            projectId: all ? undefined : projectId,
            query: query.trim() || undefined,
            sortBy: 'created',
            sortDirection: 'desc',
            offset,
            limit: PAGE_SIZE
          },
          current
        )
          .then((result) => {
            if (current()) setPage(result)
          })
          .catch(() => {
            if (current()) setFailed(true)
          })
      },
      query.trim() ? 200 : 0
    )
    return () => {
      window.clearTimeout(timer)
      generation.current += 1
    }
  }, [all, offset, projectId, query, revision])

  if (failed)
    return (
      <div className="p-4">
        <ErrorNotice
          title={t('Could not load references.')}
          primaryButton={{ label: t('Retry'), onClick: refresh }}
        />
      </div>
    )
  if (!page)
    return (
      <div role="status" className="space-y-3 p-4 text-sm text-muted-foreground">
        <span>{t('Loading references…')}</span>
        {[0, 1, 2].map((row) => (
          <div key={row} aria-hidden="true" className="h-12 rounded-md bg-muted" />
        ))}
      </div>
    )
  const entries = page.entries.filter(
    (entry): entry is LiteratureItemView => 'item' in entry && 'attachments' in entry
  )
  const empty = entries.length === 0
  return (
    <>
      {empty ? (
        <div role="status" className="flex flex-col items-start gap-3 px-4 py-8">
          <BookOpen className="size-6 text-muted-foreground" aria-hidden="true" />
          <div className="space-y-1">
            <h3 className="text-sm font-medium">
              {query.trim()
                ? t('No matching references')
                : offset > 0
                  ? t('No references on this page')
                  : all
                    ? t('Your library is empty')
                    : t('No references in this project')}
            </h3>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {query.trim()
                ? t('Try another search or clear the search field.')
                : offset > 0
                  ? t('References may have moved or been removed. Return to the first page.')
                  : all
                    ? t('Add or import references in Literature to start building your library.')
                    : t('Browse your library, or add references to this project in Literature.')}
            </p>
          </div>
          {query.trim() ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onChange({ ...selection, query: '', offset: 0, expanded: undefined })}
            >
              {t('Clear search')}
            </Button>
          ) : offset > 0 ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onChange({ ...selection, offset: 0, expanded: undefined })}
            >
              {t('First page')}
            </Button>
          ) : !all ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onChange({ ...selection, all: true, offset: 0, expanded: undefined })}
            >
              {t('Browse all references')}
            </Button>
          ) : (
            <Button variant="outline" size="sm" onClick={openLiterature}>
              {t('Open in Literature')}
            </Button>
          )}
        </div>
      ) : (
        <ul aria-label={t('Library')} className="min-w-0 px-1">
          {entries.map((entry) => (
            <ReferenceRow
              key={entry.id}
              entry={entry}
              expanded={selection.expanded === entry.id}
              onToggle={() =>
                onChange({
                  ...selection,
                  expanded: selection.expanded === entry.id ? undefined : entry.id
                })
              }
            />
          ))}
        </ul>
      )}
      {(offset > 0 || page.nextOffset !== undefined) && (
        <div className="flex items-center justify-between gap-2 border-t border-border p-3">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('Previous page')}
            disabled={offset === 0}
            onClick={() =>
              onChange({
                ...selection,
                offset: Math.max(0, offset - PAGE_SIZE),
                expanded: undefined
              })
            }
          >
            <ChevronLeft aria-hidden="true" />
          </Button>
          <span className="text-xs text-muted-foreground">
            {t('Page {{page}}', { page: Math.floor(offset / PAGE_SIZE) + 1 })}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('Next page')}
            disabled={page.nextOffset === undefined}
            onClick={() =>
              onChange({ ...selection, offset: page.nextOffset ?? offset, expanded: undefined })
            }
          >
            <ChevronRight aria-hidden="true" />
          </Button>
        </div>
      )}
    </>
  )
}

export default function LibraryPreview({
  projectId,
  isActive
}: {
  projectId?: string
  isActive: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const searchId = useId()
  const scopeId = useId()
  const [selection, setSelection] = useState<Selection>({ query: '', all: !projectId, offset: 0 })
  const openLiterature = (): void => {
    const navigation = useNavigationStore.getState()
    if (!selection.all && projectId) navigation.openProjectLiterature(projectId, 'user')
    else navigation.openLibrary('user')
  }
  return (
    <section
      aria-label={t('Library preview')}
      className="flex size-full min-h-0 min-w-0 flex-col text-foreground"
    >
      <header className="shrink-0 space-y-3 border-b border-border p-4">
        <h2 className="text-base font-semibold">{t('Library')}</h2>
        <Button variant="outline" size="sm" className="w-full" onClick={openLiterature}>
          <Maximize2 aria-hidden="true" />
          {t('Open in Literature')}
        </Button>
        <div className="space-y-1">
          <label htmlFor={searchId} className="text-xs text-muted-foreground">
            {t('Search references')}
          </label>
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              id={searchId}
              type="search"
              className="pl-8"
              value={selection.query}
              onChange={(event) =>
                setSelection({
                  ...selection,
                  query: event.target.value,
                  offset: 0,
                  expanded: undefined
                })
              }
            />
          </div>
        </div>
        <div className="space-y-1">
          <label htmlFor={scopeId} className="block text-xs text-muted-foreground">
            {t('Scope')}
          </label>
          <select
            id={scopeId}
            className="h-8 w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={selection.all ? 'all' : 'project'}
            onChange={(event) =>
              setSelection({
                ...selection,
                all: event.target.value === 'all',
                offset: 0,
                expanded: undefined
              })
            }
          >
            {projectId && <option value="project">{t('Current project')}</option>}
            <option value="all">{t('All references')}</option>
          </select>
        </div>
      </header>
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain">
        {isActive && (
          <LibraryResults
            key={JSON.stringify([projectId, selection.all, selection.query, selection.offset])}
            projectId={projectId}
            selection={selection}
            onChange={setSelection}
            openLiterature={openLiterature}
          />
        )}
      </div>
    </section>
  )
}
