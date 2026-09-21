import type { PdfAnnotation, PdfAnnotationSource } from '../../../../../../shared/pdf-annotations'
import type { TagView } from '../../../../../../shared/tags'
import { useTagStore } from '@/stores/tag-store'
import { ResourceTagMenu, TagSelection } from '../../../settings/ResourceTagControls'
import { TagBadge } from '../../../settings/tag-visuals'
import { tagPresentation } from '../../../settings/tag-presentation'
import {
  ArrowUpRight,
  PanelRightClose,
  Maximize2,
  Download,
  ChevronDown,
  FileText,
  Plus,
  Highlighter,
  NotebookPen,
  Loader2,
  MessageSquareText,
  Quote,
  Scan,
  StickyNote,
  Pencil,
  RefreshCw,
  SlidersHorizontal,
  Trash2,
  X
} from 'lucide-react'
import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem
} from '@/components/ui/dropdown-menu'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { PdfMarkColorControls } from '../../annotations/TextAnnotationEditors'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { type PdfMarkColor, type PdfMarkKind } from '../../../../../../shared/pdf-bookmarks'
import { createAnnotationId } from '../../annotations/annotation-id'
import {
  requestPdfAnnotationReveal,
  subscribeBookmarkReveal
} from '../../annotations/annotation-reveal'
import { PdfAnnotationHistoryControls } from '../../pdf-annotations/PdfAnnotationHistoryControls'
import { handlePdfAnnotationHistoryKey } from '../../pdf-annotations/pdf-annotation-history-keyboard'
import { EMPTY_PDF_ANNOTATIONS } from '../../pdf-annotations/pdf-annotation-index'
import { usePdfAnnotations } from '../../pdf-annotations/pdf-annotations-context'

type Filter = 'all' | 'commented' | 'uncommented'
type NotebookKind = PdfMarkKind | 'page-note' | 'document-note'

const MARK_KINDS: readonly PdfMarkKind[] = [
  'highlight',
  'underline',
  'squiggly',
  'strikethrough',
  'area'
]

const COLORS: readonly PdfMarkColor[] = ['yellow', 'blue', 'green', 'pink', 'purple']

const markLabel = (kind: PdfMarkKind, translate: (key: string) => string): string =>
  translate(
    kind === 'highlight'
      ? 'Highlight'
      : kind === 'underline'
        ? 'Underline'
        : kind === 'squiggly'
          ? 'Wavy underline'
          : kind === 'strikethrough'
            ? 'Strikethrough'
            : 'Area'
  )

const notebookKindLabel = (kind: NotebookKind, translate: (key: string) => string): string =>
  kind === 'page-note'
    ? translate('Page note')
    : kind === 'document-note'
      ? translate('Document note')
      : markLabel(kind, translate)

const bookmarkQuote = (
  bookmark: PdfAnnotation,
  regionLabel: (page: number) => string,
  documentLabel: string
): string => {
  const selector = bookmark.target.selector
  if (selector.kind === 'text') return selector.exact
  if (selector.kind === 'region') return selector.text ?? regionLabel(selector.pageNumber)
  if (selector.kind === 'page-note') return regionLabel(selector.pageNumber)
  return documentLabel
}

const annotationColorClasses = (
  color: PdfMarkColor
): {
  dot: string
  stroke: string
  wash: string
} => {
  switch (color) {
    case 'blue':
      return {
        dot: 'bg-sky-400',
        stroke: 'border-sky-400',
        wash: 'bg-sky-100/70 dark:bg-sky-950/25'
      }
    case 'green':
      return {
        dot: 'bg-emerald-400',
        stroke: 'border-emerald-400',
        wash: 'bg-emerald-100/70 dark:bg-emerald-950/25'
      }
    case 'pink':
      return {
        dot: 'bg-rose-400',
        stroke: 'border-rose-400',
        wash: 'bg-rose-100/70 dark:bg-rose-950/25'
      }
    case 'purple':
      return {
        dot: 'bg-violet-400',
        stroke: 'border-violet-400',
        wash: 'bg-violet-100/70 dark:bg-violet-950/25'
      }
    default:
      return {
        dot: 'bg-amber-400',
        stroke: 'border-amber-400',
        wash: 'bg-amber-100/70 dark:bg-amber-950/25'
      }
  }
}

const PdfAreaPreview = ({
  rect,
  color,
  page
}: {
  rect: { x: number; y: number; width: number; height: number }
  color: PdfMarkColor
  page: number
}): React.JSX.Element => {
  const { t } = useTranslation()
  const palette = annotationColorClasses(color)
  return (
    <div className="flex items-center gap-3 rounded-md border border-border/70 bg-bg-20/70 p-2">
      <div
        className="relative h-16 w-24 shrink-0 overflow-hidden rounded border border-border bg-bg-000 shadow-inner"
        aria-label={t('Selected area')}
      >
        <div className="absolute inset-x-2 top-2 h-px bg-border/70" />
        <div className="absolute inset-x-2 top-4 h-px bg-border/50" />
        <div className="absolute inset-x-2 top-6 h-px bg-border/50" />
        <div className="absolute inset-x-2 top-8 h-px bg-border/50" />
        <div className="absolute inset-x-2 top-10 h-px bg-border/50" />
        <div
          className={cn('absolute rounded-sm border-2', palette.stroke, palette.wash)}
          style={{
            left: `${rect.x * 100}%`,
            top: `${rect.y * 100}%`,
            width: `${rect.width * 100}%`,
            height: `${rect.height * 100}%`
          }}
        />
      </div>
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 text-xs font-medium text-text-000">
          <Scan className="size-3.5 text-muted-foreground" aria-hidden="true" />
          {t('Selected area')}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">{t('Page {{page}}', { page })}</p>
      </div>
    </div>
  )
}

// Draft changes stay local: typing in one card does not rerender the annotation list.
const PdfAnnotationNoteEditor = ({
  annotation,
  pending,
  onCancel,
  onSave
}: {
  annotation: PdfAnnotation
  pending: boolean
  onCancel: () => void
  onSave: (input: { note: string; color: PdfMarkColor }) => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const [editingNote, setEditingNote] = useState(annotation.note)
  const [editingColor, setEditingColor] = useState<PdfMarkColor>(annotation.color ?? 'yellow')
  return (
    <div className="mt-3 space-y-2">
      <Textarea
        aria-label={t('Annotation note')}
        autoFocus
        value={editingNote}
        maxLength={20_000}
        disabled={pending}
        onChange={(event) => setEditingNote(event.target.value)}
      />
      <div className="flex flex-wrap items-end gap-4">
        <PdfMarkColorControls value={editingColor} onChange={setEditingColor} disabled={pending} />
      </div>
      <div className="flex justify-end gap-1">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          {t('Cancel')}
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={pending}
          onClick={() => onSave({ note: editingNote.trim(), color: editingColor })}
        >
          {t('Save')}
        </Button>
      </div>
    </div>
  )
}

const PdfAnnotationTagControls = ({
  annotation,
  tags,
  disabled,
  onChange
}: {
  annotation: PdfAnnotation
  tags: readonly TagView[]
  disabled: boolean
  onChange: (tagIds: string[]) => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const assignedIds = new Set(annotation.tagIds)
  const selectedTags = tags.filter((tag) => assignedIds.has(tag.id))
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      <ResourceTagMenu
        selection={{ ids: annotation.tagIds, onChange, max: 24, disabled }}
        trigger={
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            disabled={disabled}
            aria-label={t('Add tag')}
            className="order-first rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Plus className="size-3.5" aria-hidden="true" />
          </Button>
        }
      />
      {selectedTags.slice(0, 2).map((tag, index) => {
        const removeLabel = t('Remove {{tag}} from this annotation', {
          tag: tagPresentation(tag, t).name
        })
        return (
          <span
            key={tag.id}
            className={cn(
              'group/tag relative hidden min-w-0 max-w-24',
              index === 0
                ? '@min-[25rem]/annotation-card:inline-flex'
                : '@min-[40rem]/annotation-card:inline-flex'
            )}
          >
            <TagBadge tag={tag} className="min-w-0 max-w-24" />
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    disabled={disabled}
                    aria-label={removeLabel}
                    onClick={(event) => {
                      event.stopPropagation()
                      onChange(annotation.tagIds.filter((id) => id !== tag.id))
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Backspace' || event.key === 'Delete') {
                        event.preventDefault()
                        event.stopPropagation()
                        onChange(annotation.tagIds.filter((id) => id !== tag.id))
                      }
                    }}
                    className="pointer-events-auto absolute top-1/2 right-1.5 inline-flex size-3.5 -translate-y-1/2 items-center justify-center rounded-full bg-background text-foreground opacity-100 transition-opacity focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none sm:pointer-events-none sm:opacity-0 sm:group-hover/tag:pointer-events-auto sm:group-hover/tag:opacity-100 sm:group-focus-within/tag:pointer-events-auto sm:group-focus-within/tag:opacity-100"
                  >
                    <X className="size-3" aria-hidden="true" />
                  </button>
                </TooltipTrigger>
                <TooltipContent className="z-[120]">{removeLabel}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </span>
        )
      })}
      {selectedTags.length > 0 ? (
        <ResourceTagMenu
          selection={{ ids: annotation.tagIds, onChange, max: 24, disabled }}
          trigger={
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={disabled}
              aria-label={t('Manage Tags')}
              className={cn(
                'shrink-0 px-1 text-xs text-muted-foreground',
                selectedTags.length === 1 && '@min-[25rem]/annotation-card:hidden',
                selectedTags.length === 2 && '@min-[40rem]/annotation-card:hidden'
              )}
            >
              <span className="@min-[25rem]/annotation-card:hidden">+{selectedTags.length}</span>
              <span className="hidden @min-[25rem]/annotation-card:inline @min-[40rem]/annotation-card:hidden">
                +{selectedTags.length - 1}
              </span>
              <span className="hidden @min-[40rem]/annotation-card:inline">
                +{selectedTags.length - 2}
              </span>
            </Button>
          }
        />
      ) : null}
    </div>
  )
}

const PdfNotebookView = ({
  source,
  active,
  onOpenPdf,
  sourceLoading = false,
  pageCount,
  sidebar = false,
  currentPage = 1,
  selectedId,
  onCloseSidebar,
  onExpandNotes
}: {
  source?: PdfAnnotationSource
  active: boolean
  onOpenPdf?: () => void
  sourceLoading?: boolean
  pageCount?: number
  sidebar?: boolean
  currentPage?: number
  selectedId?: string
  onCloseSidebar?: () => void
  onExpandNotes?: () => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const annotationPort = usePdfAnnotations()
  const { loading, loadError, retryLoad, available, create, update, remove } = annotationPort
  const [scope, setScope] = useState<'all' | 'page'>('all')
  const [editingPage, setEditingPage] = useState(currentPage)
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [composingQuery, setComposingQuery] = useState(false)
  const changeQuery = useCallback((value: string) => {
    setQuery(value)
    if (!value.trim()) setDebouncedQuery('')
  }, [])
  useEffect(() => {
    if (composingQuery || !query.trim()) return
    const timer = setTimeout(() => setDebouncedQuery(query), 250)
    return () => clearTimeout(timer)
  }, [query, composingQuery])
  const [renderLimit, setRenderLimit] = useState(100)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const filtersId = useId()
  const listRef = useRef<HTMLOListElement>(null)
  const [sort, setSort] = useState<'page' | 'newest' | 'oldest'>('page')
  const [filter, setFilter] = useState<Filter>('all')
  const [kindFilter, setKindFilter] = useState<NotebookKind | 'all'>('all')
  const [colorFilter, setColorFilter] = useState<PdfMarkColor | 'all'>('all')
  const [editingId, setEditingId] = useState<string>()
  const [newNoteKind, setNewNoteKind] = useState<'page-note' | 'document-note'>()
  const [newNotePage, setNewNotePage] = useState('1')
  const [newNote, setNewNote] = useState('')
  const [newNoteTags, setNewNoteTags] = useState<string[]>([])
  const [exportFormat, setExportFormat] = useState<'markdown' | 'csv'>('markdown')
  const [pendingId, setPendingId] = useState<string>()
  const [error, setError] = useState<string>()

  const scopedPage = editingId || newNoteKind ? editingPage : currentPage
  const effectiveSort = sidebar ? 'page' : sort
  const globalTags = useTagStore((state) => state.tags)
  const tagsById = useMemo(() => new Map(globalTags.map((tag) => [tag.id, tag])), [globalTags])
  const tagNames = useCallback(
    (ids: readonly string[]) =>
      ids.flatMap((id) => {
        const tag = tagsById.get(id)
        return tag ? [tagPresentation(tag, t).name] : []
      }),
    [tagsById, t]
  )
  const all = active || editingId ? annotationPort.forSource(source) : EMPTY_PDF_ANNOTATIONS
  const scoped =
    sidebar && scope === 'page' && (active || editingId)
      ? annotationPort.forPage(source, scopedPage)
      : all
  const searchQuery = debouncedQuery.trim().toLocaleLowerCase()
  const hasQuery = Boolean(searchQuery)
  const activeFilterCount = [
    hasQuery,
    filter !== 'all',
    kindFilter !== 'all',
    colorFilter !== 'all',
    effectiveSort !== 'page'
  ].filter(Boolean).length
  const searchText = useMemo(
    () =>
      new Map(
        scoped.map((annotation) => [
          annotation.id,
          hasQuery
            ? [
                annotation.note,
                ...tagNames(annotation.tagIds),
                annotation.target.selector.kind === 'text'
                  ? annotation.target.selector.exact
                  : annotation.target.selector.kind === 'region'
                    ? (annotation.target.selector.text ?? '')
                    : ''
              ]
                .join(' ')
                .toLocaleLowerCase()
            : ''
        ])
      ),
    [scoped, hasQuery, tagNames]
  )
  const ordered = useMemo(
    () =>
      [...scoped].sort((left, right) => {
        if (effectiveSort !== 'page')
          return (
            (effectiveSort === 'newest' ? -1 : 1) *
            (left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
          )
        const leftPage =
          left.target.selector.kind === 'document-note' ? 0 : left.target.selector.pageNumber
        const rightPage =
          right.target.selector.kind === 'document-note' ? 0 : right.target.selector.pageNumber
        const top = (item: PdfAnnotation): number =>
          item.target.selector.kind === 'text'
            ? (item.target.selector.quads[0]?.y ?? 0)
            : item.target.selector.kind === 'region'
              ? item.target.selector.rect.y
              : 0
        return (
          leftPage - rightPage ||
          top(left) - top(right) ||
          left.createdAt.localeCompare(right.createdAt) ||
          left.id.localeCompare(right.id)
        )
      }),
    [scoped, effectiveSort]
  )
  const filtered = useMemo(
    () =>
      ordered.filter((annotation) => {
        const commented = annotation.note.trim().length > 0
        return (
          (!searchQuery || searchText.get(annotation.id)!.includes(searchQuery)) &&
          (filter === 'all' || (filter === 'commented' ? commented : !commented)) &&
          (kindFilter === 'all' || annotation.kind === kindFilter) &&
          (colorFilter === 'all' || (annotation.color ?? 'yellow') === colorFilter)
        )
      }),
    [ordered, searchText, searchQuery, filter, kindFilter, colorFilter]
  )

  const editedAnnotation = editingId
    ? all.find((annotation) => annotation.id === editingId)
    : undefined
  // Bound initial React/DOM work without dropping any notes from search or export.
  const visible = useMemo(() => {
    const batch = filtered.slice(0, renderLimit)
    return editedAnnotation && !batch.includes(editedAnnotation)
      ? [editedAnnotation, ...batch]
      : batch
  }, [editedAnnotation, filtered, renderLimit])

  useEffect(() => {
    if (!active || !source) return
    return subscribeBookmarkReveal((target) => {
      if (
        listRef.current
          ?.closest('[data-pdf-preview-root]')
          ?.closest('[inert], [aria-hidden="true"]')
      )
        return
      if (
        target.kind !== 'pdf' ||
        target.selector.kind !== 'document-note' ||
        target.source.kind !== source.kind ||
        target.source.versionId !== source.versionId ||
        target.source.sourceFileId !== source.sourceFileId ||
        target.source.projectId !== source.projectId ||
        target.source.checksum !== source.checksum
      )
        return
      const card = Array.from(listRef.current?.children ?? []).find(
        (element) => (element as HTMLElement).dataset.annotationId === target.id
      ) as HTMLElement | undefined
      if (!card) {
        if (all.some((annotation) => annotation.id === target.id)) {
          setScope('all')
          changeQuery('')
          setFilter('all')
          setKindFilter('all')
          setColorFilter('all')
          setRenderLimit(Math.max(100, ordered.findIndex((item) => item.id === target.id) + 1))
        }
        return
      }
      card.scrollIntoView({ block: 'center' })
      card.focus({ preventScroll: true })
      return true
    })
  }, [active, source, visible, all, ordered, changeQuery])

  const reveal = async (bookmark: PdfAnnotation): Promise<void> => {
    setPendingId(bookmark.id)
    setError(undefined)
    try {
      const outcome = await requestPdfAnnotationReveal(bookmark)
      if (outcome === 'source-unavailable')
        setError(t('PDF annotations are unavailable for this source.'))
      if (outcome === 'locator-unsupported')
        setError(t('The exact annotation location could not be found.'))
    } catch {
      setError(t('The exact annotation location could not be found.'))
    } finally {
      setPendingId(undefined)
    }
  }

  const saveNote = async (
    id: string,
    input: { note: string; color: PdfMarkColor }
  ): Promise<void> => {
    setPendingId(id)
    setError(undefined)
    try {
      await update(id, input)
      setEditingId(undefined)
    } catch {
      setError(t('Annotation note could not be saved. Try again.'))
    } finally {
      setPendingId(undefined)
    }
  }

  const updateTags = async (id: string, tagIds: string[]): Promise<void> => {
    setPendingId(id)
    setError(undefined)
    try {
      await update(id, { tagIds })
    } catch {
      setError(t('Could not update Tags.'))
    } finally {
      setPendingId(undefined)
    }
  }

  const deleteAnnotation = async (id: string): Promise<void> => {
    setPendingId(id)
    setError(undefined)
    try {
      await remove(id)
      if (editingId === id) setEditingId(undefined)
    } catch {
      setError(t('Annotation could not be deleted. Try again.'))
    } finally {
      setPendingId(undefined)
    }
  }

  const exportNotes = (): void => {
    if (!source || filtered.length === 0) return
    const rows = filtered.map((bookmark) => {
      const selector = bookmark.target.selector
      const page =
        selector.kind === 'text' || selector.kind === 'region' || selector.kind === 'page-note'
          ? selector.pageNumber
          : undefined
      const tags = tagNames(bookmark.tagIds)
      return {
        id: bookmark.id,
        kind: bookmark.kind,
        color: bookmark.color ?? 'yellow',
        page,
        quote: bookmarkQuote(
          bookmark,
          (pageNumber) => t('PDF region on page {{page}}', { page: pageNumber }),
          t('Document note')
        ),
        note: bookmark.note,
        tags,
        createdAt: bookmark.createdAt,
        updatedAt: bookmark.updatedAt
      }
    })
    let content: string
    let mimeType: string
    let extension: string
    if (exportFormat === 'csv') {
      const escape = (value: string | number | undefined): string => {
        const raw = value === undefined ? '' : String(value)
        const text = /^[\s]*[=+@-]/u.test(raw) ? `'${raw}` : raw
        return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text
      }
      content = [
        ['id', 'kind', 'color', 'page', 'quote', 'note', 'tags', 'createdAt', 'updatedAt'].join(
          ','
        ),
        ...rows.map((row) =>
          [
            row.id,
            row.kind,
            row.color,
            row.page,
            row.quote,
            row.note,
            row.tags.join(' '),
            row.createdAt,
            row.updatedAt
          ]
            .map(escape)
            .join(',')
        )
      ].join('\n')
      mimeType = 'text/csv;charset=utf-8'
      extension = 'csv'
    } else {
      content = [
        `# ${source.name}`,
        '',
        ...rows.map((row) => {
          const page =
            row.page === undefined ? t('Document') : t('Page {{page}}', { page: row.page })
          const tags = row.tags.length ? ` Tags: ${row.tags.map((tag) => `#${tag}`).join(' ')}` : ''
          return `- **${notebookKindLabel(row.kind, (key) => t(key))}** · ${page} · ${row.quote}${tags}${row.note ? `\n  - ${row.note.replaceAll('\n', '\n  - ')}` : ''}`
        })
      ].join('\n')
      mimeType = 'text/markdown;charset=utf-8'
      extension = 'md'
    }
    const url = URL.createObjectURL(new Blob([content], { type: mimeType }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${source.name.replace(/\.pdf$/iu, '')}-notes.${extension}`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const saveNewNote = async (): Promise<void> => {
    if (!source || !available || !newNoteKind || !newNote.trim()) return
    const pageNumber = Number(newNotePage)
    if (
      newNoteKind === 'page-note' &&
      (!Number.isSafeInteger(pageNumber) ||
        pageNumber < 1 ||
        (pageCount !== undefined && pageNumber > pageCount))
    ) {
      setError(t('Enter a valid page number.'))
      return
    }
    const id = createAnnotationId()
    setPendingId(id)
    setError(undefined)
    try {
      await create(
        id,
        {
          source,
          selector:
            newNoteKind === 'page-note'
              ? { kind: 'page-note', pageNumber, pageRotation: 0, coordinateVersion: 1 }
              : { kind: 'document-note', coordinateVersion: 1 }
        },
        newNoteKind,
        undefined,
        newNoteTags,
        newNote.trim()
      )
      setNewNoteKind(undefined)
      setNewNote('')
      setNewNoteTags([])
      setNewNotePage('1')
    } catch {
      setError(t('Annotation could not be saved. Try again.'))
    } finally {
      setPendingId(undefined)
    }
  }

  // Keep an in-progress editor mounted while explicitly inspecting its PDF source.
  if (!active && !editingId) return <div className="size-full" aria-hidden="true" />
  if (!source) {
    return (
      <section
        className="flex size-full items-center justify-center bg-bg-20 p-6"
        aria-label={t('Notes & Annotations')}
      >
        <div className="flex max-w-sm flex-col items-center gap-3 text-center">
          {sourceLoading ? (
            <Loader2
              className="size-8 animate-spin text-muted-foreground motion-reduce:animate-none"
              aria-hidden="true"
            />
          ) : (
            <NotebookPen className="size-8 text-muted-foreground" aria-hidden="true" />
          )}
          <h3 className="text-sm font-medium">{t('Notes & Annotations')}</h3>
          <p className="text-sm text-muted-foreground">
            {sourceLoading
              ? t('Loading annotations…')
              : t('PDF annotations are unavailable for this source.')}
          </p>
          {onOpenPdf ? (
            <Button variant="outline" size="sm" onClick={onOpenPdf}>
              {t('Original PDF')}
            </Button>
          ) : null}
        </div>
      </section>
    )
  }

  return (
    <section
      className={cn(
        '@container/pdf-notebook size-full min-h-0 flex-col bg-bg-20',
        active ? 'flex' : 'hidden'
      )}
      aria-hidden={!active || undefined}
      aria-label={t('Notes & Annotations')}
      onKeyDown={(event) =>
        handlePdfAnnotationHistoryKey(event, annotationPort, source, () =>
          setError(t('Annotation history could not be applied. Reload annotations and try again.'))
        )
      }
    >
      <header className="shrink-0 border-b border-border bg-bg-000 px-3 py-2.5">
        {sidebar ? (
          <TooltipProvider>
            <div className="mb-2 flex min-w-0 items-center gap-1">
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {t('Notes & Annotations')}
              </span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t('Open full notes view')}
                    onClick={onExpandNotes}
                  >
                    <Maximize2 className="size-3.5" aria-hidden="true" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('Open full notes view')}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t('Hide notes sidebar')}
                    onClick={onCloseSidebar}
                  >
                    <PanelRightClose className="size-4" aria-hidden="true" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('Hide notes sidebar')}</TooltipContent>
              </Tooltip>
            </div>
          </TooltipProvider>
        ) : null}
        <TooltipProvider>
          <div className="flex min-w-0 items-center gap-1.5">
            {sidebar ? (
              <div
                className="mr-auto flex min-w-0 items-center gap-0.5 rounded-md bg-muted p-0.5"
                role="group"
                aria-label={t('Notes scope')}
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={cn(
                    'h-7 min-w-0 shrink px-2 text-xs',
                    scope === 'all'
                      ? 'bg-bg-000 text-foreground shadow-sm hover:bg-bg-000'
                      : 'text-muted-foreground'
                  )}
                  aria-pressed={scope === 'all'}
                  onClick={() => setScope('all')}
                >
                  <span className="truncate">{t('All notes')}</span>
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={cn(
                    'h-7 min-w-0 shrink px-2 text-xs',
                    scope === 'page'
                      ? 'bg-bg-000 text-foreground shadow-sm hover:bg-bg-000'
                      : 'text-muted-foreground'
                  )}
                  aria-pressed={scope === 'page'}
                  onClick={() => setScope('page')}
                >
                  <span className="truncate">{t('Current page')}</span>
                </Button>
              </div>
            ) : (
              <>
                <Select
                  value={exportFormat}
                  onValueChange={(value) => setExportFormat(value as typeof exportFormat)}
                >
                  <SelectTrigger
                    aria-label={t('Export format')}
                    className="h-8 w-auto rounded-md border border-border bg-background px-2 text-xs"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="z-[120]">
                    <SelectItem value="markdown">{t('Markdown')}</SelectItem>
                    <SelectItem value="csv">{t('CSV')}</SelectItem>
                  </SelectContent>
                </Select>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-8 shrink-0 px-2 @min-[36rem]/pdf-notebook:px-2.5"
                      aria-label={
                        filtered.length < all.length
                          ? t('Export filtered notes')
                          : t('Export notes')
                      }
                      disabled={filtered.length === 0}
                      onClick={exportNotes}
                    >
                      <Download className="size-3.5" aria-hidden="true" />
                      <span className="hidden @min-[36rem]/pdf-notebook:inline">
                        {filtered.length < all.length
                          ? t('Export filtered notes')
                          : t('Export notes')}
                      </span>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent className="z-[120]">
                    {filtered.length < all.length ? t('Export filtered notes') : t('Export notes')}
                  </TooltipContent>
                </Tooltip>
              </>
            )}
            <DropdownMenu modal={false}>
              <Tooltip>
                <TooltipTrigger
                  asChild
                  onFocus={(event) => {
                    if (!event.currentTarget.matches(':focus-visible')) event.preventDefault()
                  }}
                >
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-8 shrink-0 px-2"
                      aria-label={t('Add note')}
                      disabled={!available}
                    >
                      <Plus className="size-3.5" aria-hidden="true" />
                      <span className="hidden @min-[36rem]/pdf-notebook:inline">
                        {t('Add note')}
                      </span>
                      <ChevronDown className="size-3.5" aria-hidden="true" />
                    </Button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent className="z-[120]">{t('Add note')}</TooltipContent>
              </Tooltip>
              <DropdownMenuContent
                align="end"
                className="z-[120]"
                onEscapeKeyDown={(event) => event.stopPropagation()}
              >
                <DropdownMenuItem
                  onSelect={() => {
                    setEditingPage(currentPage)
                    setNewNoteKind('document-note')
                    setError(undefined)
                  }}
                >
                  <NotebookPen className="mr-2 size-4" aria-hidden="true" />
                  {t('Add document note')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => {
                    setEditingPage(currentPage)
                    setNewNotePage(String(currentPage))
                    setNewNoteKind('page-note')
                    setError(undefined)
                  }}
                >
                  <FileText className="mr-2 size-4" aria-hidden="true" />
                  {t('Add page note')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="sm"
                  variant={filtersOpen || activeFilterCount > 0 ? 'secondary' : 'ghost'}
                  aria-label={t('Search & filter')}
                  aria-expanded={filtersOpen}
                  aria-controls={filtersId}
                  onClick={() => setFiltersOpen((open) => !open)}
                  className="h-8 shrink-0 gap-1 px-2"
                >
                  <SlidersHorizontal className="size-3.5" aria-hidden="true" />
                  {activeFilterCount > 0 ? (
                    <span className="text-xs tabular-nums">{activeFilterCount}</span>
                  ) : null}
                  <ChevronDown
                    className={cn('size-3 transition-transform', filtersOpen && 'rotate-180')}
                    aria-hidden="true"
                  />
                </Button>
              </TooltipTrigger>
              <TooltipContent className="z-[120]">{t('Search & filter')}</TooltipContent>
            </Tooltip>
            {!sidebar ? (
              <div className="ml-auto flex shrink-0 items-center gap-0.5 border-l border-border/70 pl-1">
                <PdfAnnotationHistoryControls
                  source={source}
                  onError={() =>
                    setError(
                      t(
                        'Annotation history could not be applied. Reload annotations and try again.'
                      )
                    )
                  }
                />
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t('Refresh')}
                  disabled={loading || pendingId !== undefined || editingId !== undefined}
                  onClick={() => {
                    retryLoad()
                    setError(undefined)
                  }}
                >
                  <RefreshCw className="size-3.5" aria-hidden="true" />
                </Button>
              </div>
            ) : null}
          </div>
        </TooltipProvider>
        {sidebar && scope === 'page' ? (
          <p className="mt-2 text-xs text-muted-foreground">
            {t('Page {{page}}', { page: scopedPage })}
          </p>
        ) : null}
      </header>
      {newNoteKind ? (
        <div className="grid shrink-0 grid-cols-[minmax(0,1fr)_auto] items-end gap-2 border-b border-border/70 bg-bg-000/70 px-4 py-3">
          <div className="col-span-2 min-w-0">
            <label className="mb-1 block text-xs font-medium" htmlFor="pdf-notebook-note">
              {newNoteKind === 'page-note' ? t('Page note') : t('Document note')}
            </label>
            <Textarea
              id="pdf-notebook-note"
              value={newNote}
              autoFocus
              maxLength={20_000}
              placeholder={t('Add a private note')}
              onChange={(event) => setNewNote(event.target.value)}
            />
          </div>
          <div className={cn('min-w-0 space-y-1', newNoteKind === 'document-note' && 'col-span-2')}>
            <span className="text-xs font-medium">{t('Tags')}</span>
            <TagSelection
              value={newNoteTags}
              onChange={setNewNoteTags}
              disabled={pendingId !== undefined || !available}
            />
          </div>
          {newNoteKind === 'page-note' ? (
            <label className="text-xs font-medium">
              {t('Page')}
              <Input
                className="mt-1 block h-8 w-20 rounded-md border border-border bg-background px-2 text-xs"
                type="number"
                min={1}
                max={pageCount}
                value={newNotePage}
                onChange={(event) => setNewNotePage(event.target.value)}
              />
            </label>
          ) : null}
          <div className="col-span-2 flex justify-end gap-1">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setNewNoteKind(undefined)}
            >
              {t('Cancel')}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!newNote.trim() || pendingId !== undefined}
              onClick={() => void saveNewNote()}
            >
              {t('Save')}
            </Button>
          </div>
        </div>
      ) : null}
      {filtersOpen ? (
        <div
          id={filtersId}
          className="shrink-0 space-y-1.5 border-b border-border/70 bg-bg-000/70 px-3 py-2"
        >
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {filtered.length} / {all.length} {t('Annotations')} {t('in this PDF')}
            </span>
            {activeFilterCount > 0 ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  changeQuery('')
                  setFilter('all')
                  setKindFilter('all')
                  setColorFilter('all')
                  setSort('page')
                }}
              >
                {t('Clear filters')}
              </Button>
            ) : null}
          </div>
          <Input
            type="search"
            aria-label={t('Search annotations')}
            placeholder={t('Search quotes, notes, and tags…')}
            value={query}
            onChange={(event) => changeQuery(event.target.value)}
            onCompositionStart={() => setComposingQuery(true)}
            onCompositionEnd={(event) => {
              setComposingQuery(false)
              changeQuery(event.currentTarget.value)
            }}
            className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs"
          />
          <div className="flex flex-wrap gap-1.5">
            {!sidebar ? (
              <Select value={sort} onValueChange={(value) => setSort(value as typeof sort)}>
                <SelectTrigger
                  aria-label={t('Sort annotations')}
                  className="h-7 min-w-24 flex-1 rounded-md border border-border bg-background px-2 text-xs"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="z-[120]">
                  <SelectItem value="page">{t('Page order')}</SelectItem>
                  <SelectItem value="newest">{t('Newest first')}</SelectItem>
                  <SelectItem value="oldest">{t('Oldest first')}</SelectItem>
                </SelectContent>
              </Select>
            ) : null}
            <Select value={filter} onValueChange={(value) => setFilter(value as Filter)}>
              <SelectTrigger
                aria-label={t('Annotation filter')}
                className="h-7 min-w-24 flex-1 rounded-md border border-border bg-background px-2 text-xs"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="z-[120]">
                <SelectItem value="all">{t('All marks')}</SelectItem>
                <SelectItem value="commented">{t('Commented')}</SelectItem>
                <SelectItem value="uncommented">{t('Uncommented')}</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={kindFilter}
              onValueChange={(value) => setKindFilter(value as NotebookKind | 'all')}
            >
              <SelectTrigger
                aria-label={t('Mark style')}
                className="h-7 min-w-24 flex-1 rounded-md border border-border bg-background px-2 text-xs"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="z-[120]">
                <SelectItem value="all">{t('All styles')}</SelectItem>
                <SelectItem value="document-note">{t('Document note')}</SelectItem>
                <SelectItem value="page-note">{t('Page note')}</SelectItem>
                {MARK_KINDS.map((kind) => (
                  <SelectItem key={kind} value={kind}>
                    {markLabel(kind, (key) => t(key))}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={colorFilter}
              onValueChange={(value) => setColorFilter(value as PdfMarkColor | 'all')}
            >
              <SelectTrigger
                aria-label={t('Color')}
                className="h-7 min-w-24 flex-1 rounded-md border border-border bg-background px-2 text-xs"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="z-[120]">
                <SelectItem value="all">{t('All colors')}</SelectItem>
                {COLORS.map((color) => (
                  <SelectItem key={color} value={color}>
                    {t(color[0].toUpperCase() + color.slice(1))}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      ) : null}
      {loadError ? (
        <div role="alert" className="flex items-center gap-2 px-4 py-2 text-sm text-destructive">
          {t('PDF annotations could not be loaded.')}
          <Button size="sm" variant="outline" onClick={retryLoad}>
            {t('Retry')}
          </Button>
        </div>
      ) : null}
      {error ? (
        <p className="shrink-0 px-4 py-2 text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <div className={cn('min-h-0 flex-1 overflow-y-auto', sidebar ? 'px-3 py-2' : 'p-4')}>
        {loading && all.length === 0 ? (
          <div className="flex min-h-full items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            {t('Loading annotations…')}
          </div>
        ) : visible.length === 0 ? (
          <div className="mx-auto flex min-h-full max-w-md flex-col items-center justify-center gap-2 py-6 text-center text-sm text-muted-foreground">
            <Highlighter className="size-8 opacity-40" aria-hidden="true" />
            <p>
              {sidebar && scope === 'page'
                ? t('No annotations on this page.')
                : all.length
                  ? t('No matching annotations.')
                  : t('No annotations yet.')}
            </p>
            <p className="text-xs">
              {all.length
                ? t('Change the search or filters to see more annotations.')
                : t('Select text in the PDF to add a highlight, underline, or note.')}
            </p>
            {!all.length && onOpenPdf ? (
              <Button variant="outline" size="sm" className="mt-2" onClick={onOpenPdf}>
                {t('Original PDF')}
              </Button>
            ) : null}
          </div>
        ) : (
          <ol ref={listRef} className={cn('mx-auto grid max-w-3xl', sidebar ? 'gap-0' : 'gap-2')}>
            {visible.map((bookmark, index) => {
              const color = bookmark.color ?? 'yellow'
              const palette = annotationColorClasses(color)
              const itemKind = bookmark.kind
              const canReveal = bookmark.target.selector.kind !== 'document-note'
              const selector = bookmark.target.selector
              const itemLabel = notebookKindLabel(itemKind, (key) => t(key))
              const externalSubtype = bookmark.externalSubtype?.trim()
              const showExternalSubtype =
                Boolean(externalSubtype) &&
                externalSubtype?.toLocaleLowerCase() !== itemLabel.toLocaleLowerCase()
              const quote = bookmarkQuote(
                bookmark,
                (page) => t('PDF region on page {{page}}', { page }),
                t('Document note')
              )
              const page =
                selector.kind === 'text' ||
                selector.kind === 'region' ||
                selector.kind === 'page-note'
                  ? selector.pageNumber
                  : undefined
              const kindIcon =
                itemKind === 'area' ? (
                  <Scan className="size-3.5" aria-hidden="true" />
                ) : itemKind === 'document-note' || itemKind === 'page-note' ? (
                  <StickyNote className="size-3.5" aria-hidden="true" />
                ) : (
                  <Highlighter className="size-3.5" aria-hidden="true" />
                )
              const previous = visible[index - 1]?.target.selector
              const previousPage =
                previous && previous.kind !== 'document-note' ? previous.pageNumber : undefined
              return (
                <Fragment key={bookmark.id}>
                  {sidebar && scope === 'all' && (index === 0 || previousPage !== page) ? (
                    <li
                      className="pt-3 pb-1 first:pt-1"
                      data-annotation-page-group={page ?? 'document'}
                    >
                      <h3 className="text-xs font-medium text-muted-foreground">
                        {page === undefined ? t('Document') : t('Page {{page}}', { page })}
                      </h3>
                    </li>
                  ) : null}
                  <li
                    data-annotation-id={bookmark.id}
                    tabIndex={-1}
                    className={cn(
                      '@container/annotation-card group bg-bg-000',
                      sidebar
                        ? 'border-b border-border/70 py-3'
                        : 'rounded-xl border border-border/80 p-3 shadow-sm transition-shadow hover:shadow-md',
                      sidebar &&
                        selectedId === bookmark.id &&
                        'bg-primary/5 ring-1 ring-inset ring-primary/30',
                      editingId !== bookmark.id &&
                        '[content-visibility:auto] [contain-intrinsic-size:auto_12rem]'
                    )}
                  >
                    <div className="min-w-0">
                      <div className="flex items-start gap-2">
                        <span
                          className={cn('mt-1 size-2.5 shrink-0 rounded-full', palette.dot)}
                          aria-label={t(color[0].toUpperCase() + color.slice(1))}
                        />
                        <div className="flex min-w-0 flex-1 items-center gap-2">
                          <span className="order-first inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-border/70 bg-bg-20 px-2 py-0.5 text-xs font-normal text-muted-foreground">
                            {page === undefined ? t('Document') : t('Page {{page}}', { page })}
                          </span>
                          <span
                            className="inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap text-sm font-semibold text-text-000"
                            title={itemLabel}
                          >
                            {kindIcon}
                            <span className="truncate">{itemLabel}</span>
                          </span>
                          {showExternalSubtype ? (
                            <span className="hidden text-[10px] text-muted-foreground @min-[40rem]/annotation-card:inline">
                              {externalSubtype}
                            </span>
                          ) : null}
                          <span
                            className={cn(
                              'hidden shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium @min-[40rem]/annotation-card:inline',
                              bookmark.origin === 'imported'
                                ? 'bg-sky-100 text-sky-700 dark:bg-sky-950/50 dark:text-sky-300'
                                : 'bg-muted text-muted-foreground'
                            )}
                            title={bookmark.externalSubtype ?? undefined}
                          >
                            {bookmark.origin === 'imported' ? t('Imported') : t('Created')}
                          </span>
                          <PdfAnnotationTagControls
                            annotation={bookmark}
                            tags={globalTags}
                            disabled={!available || pendingId === bookmark.id}
                            onChange={(tagIds) => void updateTags(bookmark.id, tagIds)}
                          />
                        </div>
                        <div className="flex shrink-0 items-center gap-0.5">
                          {canReveal ? (
                            <button
                              type="button"
                              aria-label={t('Show annotation source')}
                              disabled={pendingId === bookmark.id}
                              onClick={() => void reveal(bookmark)}
                              className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              <ArrowUpRight className="size-3.5" aria-hidden="true" />
                            </button>
                          ) : null}
                          <button
                            type="button"
                            aria-label={t('Edit annotation note')}
                            disabled={
                              !available || pendingId === bookmark.id || editingId !== undefined
                            }
                            onClick={() => {
                              setEditingPage(currentPage)
                              setEditingId(bookmark.id)
                              setError(undefined)
                            }}
                            className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            <Pencil className="size-3.5" aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            aria-label={t('Delete annotation')}
                            disabled={!available || pendingId === bookmark.id}
                            onClick={() => void deleteAnnotation(bookmark.id)}
                            className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            <Trash2 className="size-3.5" aria-hidden="true" />
                          </button>
                        </div>
                      </div>
                      <div className="mt-2">
                        <div className="w-full text-left">
                          {selector.kind === 'region' ? (
                            <>
                              <PdfAreaPreview
                                rect={selector.rect}
                                color={color}
                                page={selector.pageNumber}
                              />
                              <span className="sr-only">{quote}</span>
                            </>
                          ) : selector.kind === 'text' ? (
                            <blockquote
                              className={cn(
                                'relative rounded-r-md border-y border-r border-border/70 px-3 py-2.5 pl-8 text-sm leading-5 text-foreground/90',
                                'border-l-2',
                                palette.stroke,
                                palette.wash
                              )}
                              title={quote}
                            >
                              <Quote
                                className="absolute left-2.5 top-2.5 size-3.5 text-muted-foreground/70"
                                aria-hidden="true"
                              />
                              <span className="line-clamp-3 break-words">{quote}</span>
                            </blockquote>
                          ) : null}
                          {bookmark.note ? (
                            <div className="mt-3 flex items-start gap-2 rounded-md border border-border/60 bg-bg-20 px-3 py-2.5 text-sm text-text-200">
                              <MessageSquareText
                                className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                                aria-hidden="true"
                              />
                              <span className="line-clamp-4 whitespace-pre-wrap break-words">
                                {bookmark.note}
                              </span>
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </div>
                    {editingId === bookmark.id ? (
                      <PdfAnnotationNoteEditor
                        key={bookmark.id}
                        annotation={bookmark}
                        pending={pendingId === bookmark.id}
                        onCancel={() => setEditingId(undefined)}
                        onSave={(input) => void saveNote(bookmark.id, input)}
                      />
                    ) : null}
                  </li>
                </Fragment>
              )
            })}
            {filtered.length > renderLimit ? (
              <li className="flex justify-center py-3">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setRenderLimit((limit) => limit + 100)}
                >
                  {t('Load more')}
                </Button>
              </li>
            ) : null}
          </ol>
        )}
      </div>
    </section>
  )
}

export { PdfNotebookView }
