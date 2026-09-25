/* Hallmark · component: library preview · genre: modern-minimal · theme: existing workspace
 * Pre-emit critique: P5 H4 E4 S5 R5 V4. Preserve project tokens and native control states.
 */
import {
  ArrowUpRight,
  BookOpen,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FileText,
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
import { oversizedLiteratureReference } from '../../../../../shared/literature-export'
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
  const pdfButton = (
    attachment: LiteratureItemView['attachments'][number],
    compact = false
  ): React.JSX.Element => {
    const version = attachment.versions[0]
    return (
      <Button
        key={attachment.id}
        variant="outline"
        size="xs"
        className={cn('min-w-0 max-w-full', !compact && 'w-full justify-start')}
        aria-label={version.filename}
        disabled={version.availability === 'unavailable'}
        title={version.availability === 'unavailable' ? t('PDF unavailable') : version.filename}
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
        <span className="truncate">{compact ? t('PDF') : version.filename}</span>
        {compact && <ArrowUpRight aria-hidden="true" />}
      </Button>
    )
  }
  return (
    <li
      className={cn(
        'relative min-w-0 border-b border-border px-4 last:border-0',
        expanded &&
          'bg-primary/5 before:absolute before:inset-y-3 before:left-0 before:w-0.5 before:bg-primary'
      )}
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={detailId}
        onClick={onToggle}
        className="block w-full min-w-0 rounded-sm pt-3 pb-2 text-left hover:text-primary active:text-primary focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
      >
        <span
          className={cn(
            'block text-sm font-medium leading-relaxed [overflow-wrap:anywhere]',
            !expanded && 'line-clamp-2'
          )}
        >
          {entry.item.title}
        </span>
        {creators.length > 0 && (
          <span
            className={cn(
              'mt-1 block text-xs text-muted-foreground',
              !expanded ? 'truncate' : '[overflow-wrap:anywhere]'
            )}
          >
            {expanded ? creators.join('; ') : creators[0]}
          </span>
        )}
        <span
          className={cn(
            'mt-1 block text-xs text-muted-foreground',
            !expanded ? 'truncate' : '[overflow-wrap:anywhere]'
          )}
        >
          {[entry.item.containerTitle, entry.item.issuedYear ?? entry.item.issuedText]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </button>
      <div className="flex min-w-0 items-center justify-between gap-2 pb-3">
        <Button
          variant="ghost"
          size="xs"
          className="-ml-2 text-muted-foreground"
          aria-expanded={expanded}
          aria-controls={detailId}
          onClick={onToggle}
        >
          {t('Abstract')}
          <ChevronDown aria-hidden="true" className={cn('size-3', !expanded && '-rotate-90')} />
        </Button>
        {pdfs[0] ? (
          pdfButton(pdfs[0], true)
        ) : (
          <span className="text-xs text-muted-foreground">{t('No PDF attached.')}</span>
        )}
      </div>
      {expanded && (
        <div id={detailId} className="min-w-0 pb-3 text-xs [overflow-wrap:anywhere]">
          {pdfs.length > 1 && (
            <div className="mb-3 space-y-1">
              {pdfs.slice(1).map((attachment) => pdfButton(attachment))}
            </div>
          )}
          <h3 className="mb-2 font-medium">{t('Abstract')}</h3>
          <p className="whitespace-pre-wrap leading-relaxed text-muted-foreground">
            {abstract
              ? showMore
                ? abstract
                : abstract.slice(0, ABSTRACT_EXCERPT_LENGTH) +
                  (abstract.length > ABSTRACT_EXCERPT_LENGTH ? '…' : '')
              : t('No abstract available.')}
          </p>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            {abstract.length > ABSTRACT_EXCERPT_LENGTH && (
              <Button
                variant="ghost"
                size="xs"
                className="-ml-2 text-primary"
                onClick={() => setShowMore(!showMore)}
                aria-expanded={showMore}
              >
                {showMore ? t('Show less') : t('Show more')}
                <ChevronDown
                  aria-hidden="true"
                  className={cn('size-3', showMore && 'rotate-180')}
                />
              </Button>
            )}
            <Button
              variant="ghost"
              size="xs"
              className="-mr-2 ml-auto text-muted-foreground"
              onClick={() => useNavigationStore.getState().openLiteratureItem(entry.id, 'user')}
            >
              {t('View in Literature')}
              <ArrowUpRight aria-hidden="true" />
            </Button>
          </div>
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
  const [failure, setFailure] = useState<{ oversized: boolean }>()
  const [revision, setRevision] = useState(0)
  const generation = useRef(0)
  const { query, all, offset } = selection
  const refresh = (): void => {
    generation.current += 1
    setFailure(undefined)
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
          .catch((error: unknown) => {
            if (current()) setFailure({ oversized: Boolean(oversizedLiteratureReference(error)) })
          })
      },
      query.trim() ? 200 : 0
    )
    return () => {
      window.clearTimeout(timer)
      generation.current += 1
    }
  }, [all, offset, projectId, query, revision])

  if (failure)
    return (
      <div className="p-4">
        <ErrorNotice
          title={t('Could not load references.')}
          description={
            failure.oversized
              ? t(
                  'This reference is too large for Preview. Open Literature to access the complete record.'
                )
              : undefined
          }
          primaryButton={
            failure.oversized
              ? { label: t('Open in Literature'), onClick: openLiterature }
              : { label: t('Retry'), onClick: refresh }
          }
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
        <div
          role="status"
          className="mx-auto flex max-w-sm flex-col items-center gap-4 px-6 pt-20 pb-8 text-center"
        >
          <BookOpen
            className="size-8 text-muted-foreground"
            strokeWidth={1.25}
            aria-hidden="true"
          />
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
            <p className="text-xs leading-relaxed text-muted-foreground">
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
              size="sm"
              onClick={() => onChange({ ...selection, query: '', offset: 0, expanded: undefined })}
            >
              {t('Clear search')}
            </Button>
          ) : offset > 0 ? (
            <Button
              size="sm"
              onClick={() => onChange({ ...selection, offset: 0, expanded: undefined })}
            >
              {t('First page')}
            </Button>
          ) : !all ? (
            <Button
              size="sm"
              onClick={() => onChange({ ...selection, all: true, offset: 0, expanded: undefined })}
            >
              {t('Browse all references')}
            </Button>
          ) : (
            <Button size="sm" onClick={openLiterature}>
              {t('Open in Literature')}
            </Button>
          )}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-3 pb-1 text-xs text-muted-foreground">
            <span>
              {page.totalCount !== undefined
                ? t('{{count}} references', {
                    count: page.totalCount,
                    defaultValue_one: '{{count}} reference'
                  })
                : null}
            </span>
            <span>{t('Recently added')}</span>
          </div>
          <ul aria-label={t('Library')} className="min-w-0">
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
        </>
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
      <header className="shrink-0 border-b border-border">
        <div className="flex h-12 items-center justify-between gap-2 px-4">
          <h2 className="flex min-w-0 items-center gap-2 text-sm font-semibold">
            <BookOpen aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            {t('Library')}
          </h2>
          <Button
            variant="ghost"
            size="xs"
            className="-mr-2 text-muted-foreground"
            onClick={openLiterature}
            aria-label={t('Open in Literature')}
            title={t('Open in Literature')}
          >
            {t('Literature')}
            <ArrowUpRight aria-hidden="true" />
          </Button>
        </div>
        <div className="relative mx-4 mb-2">
          <label htmlFor={searchId} className="sr-only">
            {t('Search references')}
          </label>
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            id={searchId}
            type="search"
            placeholder={t('Search references')}
            className="h-8 pl-8 text-xs"
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
        <div
          role="group"
          aria-label={t('Scope')}
          className="flex flex-wrap items-center gap-x-5 px-4"
        >
          {(projectId ? [false, true] : [true]).map((all) => (
            <button
              key={String(all)}
              type="button"
              aria-pressed={selection.all === all}
              className={cn(
                'h-9 border-b-2 border-transparent text-xs whitespace-nowrap hover:text-foreground active:text-primary focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-[-2px]',
                selection.all === all
                  ? 'border-primary font-medium text-foreground'
                  : 'text-muted-foreground'
              )}
              onClick={() => setSelection({ ...selection, all, offset: 0, expanded: undefined })}
            >
              {all ? t('All references') : t('Current project')}
            </button>
          ))}
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
