import { Check, Highlighter, Strikethrough, Trash2, Underline, Waves } from 'lucide-react'
import { useRef, useState } from 'react'
import { Bookmark as BookmarkIcon, CircleAlert, Loader2, Pencil } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { TagSelection } from '../../settings/ResourceTagControls'
import { Button } from '@/components/ui/button'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { AnnotationValidationError, TextAnnotation } from '../../../../../shared/annotations'
import {
  PDF_MARK_COLORS,
  PDF_MARK_KINDS,
  type PdfMarkColor,
  type PdfMarkKind
} from '../../../../../shared/pdf-bookmarks'
import { AnnotationTrigger, type AnnotationTriggerAction } from './AnnotationTrigger'

type AnnotationControl = Readonly<{
  annotation: TextAnnotation
  left: number
  top: number
}>

const annotationQuote = (annotation: TextAnnotation): string => annotation.quote

type AnnotationEditorVariant = 'workspace' | 'preview'

type BookmarkSaveInput = Readonly<{
  note: string
  markKind: PdfMarkKind
  color: PdfMarkColor
  tagIds: readonly string[]
}>

type BookmarkDraftAction = Readonly<{
  available: boolean
  onSave: (input: BookmarkSaveInput) => Promise<void>
}>

const editorPresentation = {
  workspace: {
    markerClassName: 'absolute z-10 -translate-x-1/3 -translate-y-2/3',
    hoverClassName:
      'pointer-events-none absolute z-20 max-w-72 truncate rounded-md bg-muted px-2 py-1 text-xs text-foreground shadow-sm',
    contentClassName: 'w-80 space-y-3 border border-border bg-popover p-3 text-popover-foreground',
    collisionPadding: undefined,
    noteIdPrefix: 'source-annotation-note'
  },
  preview: {
    markerClassName: 'absolute z-30 -translate-x-1/3 -translate-y-2/3',
    hoverClassName:
      'pointer-events-none absolute z-40 max-w-72 truncate rounded-md bg-muted px-2 py-1 text-xs text-foreground shadow-sm',
    contentClassName:
      'z-[70] w-80 space-y-3 border border-border bg-popover p-3 text-popover-foreground',
    collisionPadding: 8,
    noteIdPrefix: 'preview-source-note'
  }
} as const

const AnnotationMarkers = ({
  controls,
  hoveredAnnotationId,
  variant,
  onUpdateNote,
  onRemove,
  onError
}: {
  controls: readonly AnnotationControl[]
  hoveredAnnotationId: string | undefined
  variant: AnnotationEditorVariant
  onRemove?: (id: string) => void
  onUpdateNote?: (id: string, note: string) => AnnotationValidationError | undefined
  onError?: (error: AnnotationValidationError) => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const [editingAnnotationId, setEditingAnnotationId] = useState<string>()
  const [editingNote, setEditingNote] = useState('')
  const editButtons = useRef(new Map<string, HTMLButtonElement>())
  const presentation = editorPresentation[variant]

  return (
    <TooltipProvider>
      {controls.map(({ annotation, left, top }) => (
        <Popover
          key={annotation.id}
          open={editingAnnotationId === annotation.id}
          onOpenChange={(next) => {
            if (!next) setEditingAnnotationId(undefined)
          }}
        >
          <PopoverAnchor asChild>
            <span className={presentation.markerClassName} style={{ left, top }}>
              <Tooltip>
                <TooltipTrigger
                  asChild
                  onFocus={(event) => {
                    if (!event.currentTarget.matches(':focus-visible')) event.preventDefault()
                  }}
                >
                  <button
                    ref={(element) => {
                      if (element) editButtons.current.set(annotation.id, element)
                      else editButtons.current.delete(annotation.id)
                    }}
                    type="button"
                    data-text-annotation-edit="true"
                    data-annotation-note={annotation.note ?? annotationQuote(annotation)}
                    className="flex size-5 items-center justify-center rounded bg-transparent text-primary/70 hover:bg-muted hover:text-primary focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    aria-label={t('Edit annotation note')}
                    onClick={() => {
                      setEditingAnnotationId(annotation.id)
                      setEditingNote(annotation.note ?? '')
                    }}
                  >
                    <Pencil className="size-4" aria-hidden="true" />
                  </button>
                </TooltipTrigger>
                <TooltipContent className="max-w-72 truncate bg-muted text-foreground">
                  {annotation.note ?? annotationQuote(annotation)}
                </TooltipContent>
              </Tooltip>
            </span>
          </PopoverAnchor>
          <PopoverContent
            align="start"
            side="bottom"
            collisionPadding={presentation.collisionPadding}
            className={presentation.contentClassName}
            onCloseAutoFocus={(event) => {
              event.preventDefault()
              queueMicrotask(() => editButtons.current.get(annotation.id)?.focus())
            }}
          >
            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {t('For agent')}
            </div>
            <label className="sr-only" htmlFor={`${presentation.noteIdPrefix}-${annotation.id}`}>
              {t('Annotation note')}
            </label>
            <Textarea
              id={`${presentation.noteIdPrefix}-${annotation.id}`}
              data-source-annotation-note="true"
              autoFocus
              value={editingNote}
              maxLength={2_000}
              placeholder={t('Add context for the Agent')}
              onChange={(event) => setEditingNote(event.target.value)}
            />
            <div className="flex justify-end gap-2">
              {onRemove ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="mr-auto text-destructive hover:text-destructive"
                  aria-label={t('Remove annotation')}
                  onClick={() => {
                    onRemove(annotation.id)
                    setEditingAnnotationId(undefined)
                  }}
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                </Button>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setEditingAnnotationId(undefined)}
              >
                {t('Cancel')}
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={!onUpdateNote}
                onClick={() => {
                  const error = onUpdateNote?.(annotation.id, editingNote)
                  if (error) onError?.(error)
                  else setEditingAnnotationId(undefined)
                }}
              >
                {t('Save')}
              </Button>
            </div>
          </PopoverContent>
          {hoveredAnnotationId === annotation.id ? (
            <div
              data-text-annotation-hover-note="true"
              className={presentation.hoverClassName}
              style={{ left, top: top + 18 }}
            >
              {annotation.note ?? annotationQuote(annotation)}
            </div>
          ) : null}
        </Popover>
      ))}
    </TooltipProvider>
  )
}

type PdfTextMarkStyle = Readonly<{ kind: Exclude<PdfMarkKind, 'area'>; color: PdfMarkColor }>

const PdfMarkColorControls = ({
  value,
  onChange,
  disabled = false
}: {
  value: PdfMarkColor
  onChange: (color: PdfMarkColor) => void
  disabled?: boolean
}): React.JSX.Element => {
  const { t } = useTranslation()
  const markColorLabel = (color: PdfMarkColor): string =>
    color === 'yellow'
      ? t('Yellow')
      : color === 'blue'
        ? t('Blue')
        : color === 'green'
          ? t('Green')
          : color === 'pink'
            ? t('Pink')
            : t('Purple')
  return (
    <TooltipProvider delayDuration={800}>
      <fieldset className="space-y-2">
        <legend className="text-xs font-medium">{t('Color')}</legend>
        <div className="flex gap-2" role="group" aria-label={t('Color')}>
          {PDF_MARK_COLORS.map((color) => (
            <Tooltip key={color}>
              <TooltipTrigger
                asChild
                onFocus={(event) => {
                  if (!event.currentTarget.matches(':focus-visible')) event.preventDefault()
                }}
              >
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={markColorLabel(color)}
                  aria-pressed={value === color}
                  className={cn(
                    'annotation-color-button disabled:opacity-50 disabled:pointer-events-none inline-flex size-8 shrink-0 items-center justify-center rounded border border-border/50 text-background ring-offset-2 ring-offset-popover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    value === color && 'ring-2 ring-foreground'
                  )}
                  style={{
                    backgroundColor: `var(--color-${color === 'yellow' ? 'amber' : color === 'pink' ? 'rose' : color}-300)`
                  }}
                  onClick={() => onChange(color)}
                >
                  {value === color ? (
                    <Check
                      className="size-4 text-neutral-900"
                      strokeWidth={2.5}
                      aria-hidden="true"
                    />
                  ) : null}
                </button>
              </TooltipTrigger>
              <TooltipContent className="z-[120]">{markColorLabel(color)}</TooltipContent>
            </Tooltip>
          ))}
        </div>
      </fieldset>
    </TooltipProvider>
  )
}

const PdfTextMarkControls = ({
  value,
  onChange
}: {
  value: PdfTextMarkStyle
  onChange: (value: PdfTextMarkStyle) => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const markStyleLabel = (kind: PdfMarkKind): string =>
    kind === 'highlight'
      ? t('Highlight')
      : kind === 'underline'
        ? t('Underline')
        : kind === 'squiggly'
          ? t('Wavy underline')
          : t('Strikethrough')
  return (
    <TooltipProvider delayDuration={800}>
      <fieldset className="space-y-2">
        <legend className="text-xs font-medium">{t('Mark style')}</legend>
        <div className="flex gap-2" role="group" aria-label={t('Mark style')}>
          {PDF_MARK_KINDS.filter((kind) => kind !== 'area').map((kind) => (
            <Tooltip key={kind}>
              <TooltipTrigger
                asChild
                onFocus={(event) => {
                  if (!event.currentTarget.matches(':focus-visible')) event.preventDefault()
                }}
              >
                <button
                  aria-label={markStyleLabel(kind)}
                  type="button"
                  aria-pressed={value.kind === kind}
                  className={cn(
                    'annotation-tool-button inline-flex size-8 shrink-0 items-center justify-center rounded border text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    value.kind === kind
                      ? 'border-primary/30 bg-primary/10 text-primary'
                      : 'border-border/70 text-popover-foreground hover:bg-muted'
                  )}
                  onClick={() => onChange({ ...value, kind })}
                >
                  {kind === 'highlight' ? (
                    <Highlighter className="size-4 shrink-0" aria-hidden="true" />
                  ) : kind === 'underline' ? (
                    <Underline className="size-4 shrink-0" aria-hidden="true" />
                  ) : kind === 'squiggly' ? (
                    <Waves className="size-4 shrink-0" aria-hidden="true" />
                  ) : (
                    <Strikethrough className="size-4 shrink-0" aria-hidden="true" />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent className="z-[120]">{markStyleLabel(kind)}</TooltipContent>
            </Tooltip>
          ))}
        </div>
      </fieldset>

      <PdfMarkColorControls
        value={value.color}
        onChange={(color) => onChange({ ...value, color })}
      />
    </TooltipProvider>
  )
}

const AnnotationDraftEditor = ({
  range,
  backward,
  open,
  note,
  noteInputId,
  variant,
  onOpenChange,
  onCancel,
  onNoteChange,
  onAdd,
  annotationBlockedByHistoricalVersion = false,
  triggerActions,
  onDismissSelection,
  bookmark,
  initialDestination = 'agent',
  bookmarkOnly = false
}: {
  range: Range
  backward: boolean
  open: boolean
  note: string
  noteInputId: string
  variant: AnnotationEditorVariant
  onOpenChange: (open: boolean) => void
  onCancel: () => void
  onNoteChange: (note: string) => void
  onAdd: () => void
  annotationBlockedByHistoricalVersion?: boolean
  onDismissSelection?: () => void
  triggerActions?: readonly AnnotationTriggerAction[]
  bookmark?: BookmarkDraftAction
  initialDestination?: 'agent' | 'bookmark'
  bookmarkOnly?: boolean
}): React.JSX.Element => {
  const { t } = useTranslation()
  const presentation = editorPresentation[variant]
  const [tabState, setTabState] = useState<{
    active: 'agent' | 'bookmark'
    initial: 'agent' | 'bookmark'
    open: boolean
  }>({ active: initialDestination, initial: initialDestination, open })
  let activeTab = tabState.active
  if (tabState.open !== open || (open && tabState.initial !== initialDestination)) {
    activeTab = open ? initialDestination : tabState.active
    setTabState({ active: activeTab, initial: initialDestination, open })
  }
  const setActiveTab = (active: 'agent' | 'bookmark'): void =>
    setTabState({ active, initial: initialDestination, open })
  const [bookmarkNote, setBookmarkNote] = useState('')
  const [bookmarkStyle, setBookmarkStyle] = useState<PdfTextMarkStyle>({
    kind: 'highlight',
    color: 'yellow'
  })
  const [bookmarkTags, setBookmarkTags] = useState<string[]>([])
  const [bookmarkSaving, setBookmarkSaving] = useState(false)
  const [bookmarkError, setBookmarkError] = useState<string>()
  // The blocked state keeps the selection trigger visible while its explanation is open.
  const [blockedRange, setBlockedRange] = useState<Range>()
  const blockedOpen =
    annotationBlockedByHistoricalVersion && !bookmark && (open || blockedRange === range)
  const effectiveTriggerActions = triggerActions?.map((action) =>
    action.availableWhenAnnotationBlocked
      ? action
      : {
          ...action,
          onActivate: () => {
            if (annotationBlockedByHistoricalVersion) {
              setBlockedRange(range)
              if (bookmark) onOpenChange(true)
            } else action.onActivate()
          }
        }
  )

  return (
    <Popover
      open={open || blockedOpen}
      onOpenChange={(next) => {
        if (next) setActiveTab(initialDestination)
        if (blockedOpen) {
          if (!next) setBlockedRange(undefined)
          if (open) onOpenChange(false)
        } else onOpenChange(next)
      }}
    >
      <AnnotationTrigger
        range={range}
        backward={backward}
        hidden={open && !blockedOpen}
        label={t('Annotate')}
        onActivate={() => {
          if (annotationBlockedByHistoricalVersion && !bookmark) setBlockedRange(range)
          else {
            setActiveTab(initialDestination)
            onOpenChange(true)
          }
        }}
        actions={effectiveTriggerActions}
        onDismiss={onDismissSelection}
        actionMenuLabel={triggerActions ? t('Selection actions') : undefined}
      />
      {blockedOpen ? (
        <PopoverContent
          role="alert"
          align="start"
          side="bottom"
          sideOffset={6}
          collisionPadding={presentation.collisionPadding}
          className="annotation-popover z-[110] w-72 border border-destructive/30 bg-popover p-3 text-popover-foreground"
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <div className="flex items-start gap-2 text-xs leading-5 text-destructive">
            <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>
              {t(
                'Historical versions cannot be annotated. Switch to the latest version to annotate.'
              )}
            </span>
          </div>
        </PopoverContent>
      ) : (
        <PopoverContent
          align="start"
          side="bottom"
          sideOffset={0}
          collisionPadding={presentation.collisionPadding}
          className={cn(
            presentation.contentClassName,
            'annotation-popover',
            bookmark &&
              'max-w-[calc(100vw-1rem)] max-h-[var(--radix-popover-content-available-height)] overflow-y-auto'
          )}
        >
          {bookmark && !bookmarkOnly ? (
            <div
              role="tablist"
              aria-label={t('Selection destination')}
              className="inline-flex items-center gap-0.5 rounded-md bg-muted/50 p-0.5"
            >
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'agent'}
                className={cn(
                  'inline-flex h-6 items-center gap-1 rounded px-2 text-[10px] font-normal',
                  activeTab === 'agent'
                    ? 'bg-background text-foreground shadow-sm ring-1 ring-border/50'
                    : 'text-muted-foreground hover:text-foreground'
                )}
                onClick={() => setActiveTab('agent')}
              >
                <Pencil className="size-2.5" strokeWidth={1.5} aria-hidden="true" />
                {t('To Agent')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'bookmark'}
                className={cn(
                  'inline-flex h-6 items-center gap-1 rounded px-2 text-[10px] font-normal',
                  activeTab === 'bookmark'
                    ? 'bg-background text-foreground shadow-sm ring-1 ring-border/50'
                    : 'text-muted-foreground hover:text-foreground'
                )}
                onClick={() => {
                  setActiveTab('bookmark')
                  setBookmarkError(undefined)
                }}
              >
                <BookmarkIcon className="size-2.5" strokeWidth={1.5} aria-hidden="true" />
                {t('For me')}
              </button>
            </div>
          ) : (
            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {bookmarkOnly ? t('Annotate') : t('To Agent')}
            </div>
          )}
          {activeTab === 'bookmark' && bookmark ? (
            <div
              className="line-clamp-2 break-words rounded bg-muted/60 px-2 py-1.5 text-xs leading-5 text-muted-foreground"
              title={range.toString()}
            >
              {range.toString()}
            </div>
          ) : null}
          {activeTab === 'bookmark' && bookmark ? (
            <>
              {bookmarkOnly ? (
                <PdfTextMarkControls value={bookmarkStyle} onChange={setBookmarkStyle} />
              ) : null}
              <label className="block text-xs font-medium" htmlFor={`${noteInputId}-bookmark`}>
                {t('Note (optional)')}
              </label>
              <Textarea
                id={`${noteInputId}-bookmark`}
                data-bookmark-note="true"

                autoFocus
                value={bookmarkNote}
                maxLength={bookmarkOnly ? 20_000 : 2_000}
                placeholder={
                  bookmarkOnly ? t('Annotation note') : t('Optional — a note for your future self…')
                }
                disabled={!bookmark.available || bookmarkSaving}
                onChange={(event) => setBookmarkNote(event.target.value)}
              />
              {bookmarkOnly ? (
                <>
                  <div className="text-xs font-medium">{t('Tags')}</div>
                  <TagSelection
                    value={bookmarkTags}
                    onChange={setBookmarkTags}
                    disabled={!bookmark.available || bookmarkSaving}
                  />
                </>
              ) : null}
              {!bookmark.available ? (
                <p role="status" className="text-xs text-muted-foreground">
                  {bookmarkOnly
                    ? t('Annotations are available after this conversation is saved.')
                    : t('Bookmarks are available after this conversation is saved.')}
                </p>
              ) : null}
              {bookmarkError ? (
                <p role="alert" className="text-xs text-destructive">
                  {bookmarkError}
                </p>
              ) : null}
              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
                  {t('Cancel')}
                </Button>
                <Button
                  type="button"
                  size="sm"

                  disabled={!bookmark.available || bookmarkSaving}
                  onClick={() => {
                    setBookmarkSaving(true)
                    setBookmarkError(undefined)
                    void bookmark
                      .onSave({
                        note: bookmarkNote.trim(),
                        markKind: bookmarkStyle.kind,
                        color: bookmarkStyle.color,
                        tagIds: bookmarkTags
                      })
                      .catch((error: unknown) => {
                        console.error('Failed to save bookmark', error)
                        setBookmarkError(
                          bookmarkOnly
                            ? t('Annotation could not be saved. Try again.')
                            : t('Bookmark could not be saved. Try again.')
                        )
                      })
                      .finally(() => setBookmarkSaving(false))
                  }}
                >
                  {bookmarkSaving ? (
                    <Loader2
                      className="mr-1 size-3.5 animate-spin motion-reduce:animate-none"
                      aria-hidden="true"
                    />
                  ) : null}
                  {bookmarkOnly ? t('Save annotation') : t('Bookmark')}
                </Button>
              </div>
            </>
          ) : annotationBlockedByHistoricalVersion && bookmark ? (
            <>
              <div
                role="alert"
                className="flex items-start gap-2 text-xs leading-5 text-destructive"
              >
                <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <span>
                  {t(
                    'Historical versions cannot be annotated. Switch to the latest version to annotate.'
                  )}
                </span>
              </div>
              <div className="flex justify-end">
                <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
                  {t('Cancel')}
                </Button>
              </div>
            </>
          ) : (
            <>
              <label className="block text-xs font-medium" htmlFor={noteInputId}>
                {t('Note (optional)')}
              </label>
              <Textarea
                id={noteInputId}
                autoFocus
                value={note}
                maxLength={2_000}
                placeholder={t('Add context for the Agent')}
                onChange={(event) => onNoteChange(event.target.value)}
              />
              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
                  {t('Cancel')}
                </Button>
                <Button type="button" size="sm" onClick={onAdd}>
                  {t('Annotate')}
                </Button>
              </div>
            </>
          )}
        </PopoverContent>
      )}
    </Popover>
  )
}

export { AnnotationDraftEditor, AnnotationMarkers, PdfTextMarkControls, PdfMarkColorControls }
export type { AnnotationControl, BookmarkDraftAction, BookmarkSaveInput, PdfTextMarkStyle }
