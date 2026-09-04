import { useRef, useState } from 'react'
import { CircleAlert, Pencil } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { AnnotationValidationError, TextAnnotation } from '../../../../../shared/annotations'
import { AnnotationTrigger, type AnnotationTriggerAction } from './AnnotationTrigger'

type AnnotationControl = Readonly<{
  annotation: TextAnnotation
  left: number
  top: number
}>

const annotationQuote = (annotation: TextAnnotation): string => annotation.quote

type AnnotationEditorVariant = 'workspace' | 'preview'

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
  onError
}: {
  controls: readonly AnnotationControl[]
  hoveredAnnotationId: string | undefined
  variant: AnnotationEditorVariant
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
                    <Pencil className="size-3" aria-hidden="true" />
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
  triggerActions
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
  triggerActions?: readonly AnnotationTriggerAction[]
}): React.JSX.Element => {
  const { t } = useTranslation()
  const presentation = editorPresentation[variant]
  // The blocked state keeps the selection trigger visible while its explanation is open.
  const [blockedRange, setBlockedRange] = useState<Range>()
  const blockedOpen = annotationBlockedByHistoricalVersion && (open || blockedRange === range)
  const effectiveTriggerActions = triggerActions?.map((action) =>
    action.availableWhenAnnotationBlocked
      ? action
      : {
          ...action,
          onActivate: () => {
            if (annotationBlockedByHistoricalVersion) setBlockedRange(range)
            else action.onActivate()
          }
        }
  )

  return (
    <Popover
      open={open || blockedOpen}
      onOpenChange={(next) => {
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
          if (annotationBlockedByHistoricalVersion) setBlockedRange(range)
          else onOpenChange(true)
        }}
        actions={effectiveTriggerActions}
        actionMenuLabel={triggerActions ? t('Selection actions') : undefined}
      />
      {blockedOpen ? (
        <PopoverContent
          role="alert"
          align="start"
          side="bottom"
          sideOffset={6}
          collisionPadding={presentation.collisionPadding}
          className="z-[110] w-72 border border-destructive/30 bg-popover p-3 text-popover-foreground"
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
          collisionPadding={presentation.collisionPadding}
          className={presentation.contentClassName}
        >
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {t('To Agent')}
          </div>
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
        </PopoverContent>
      )}
    </Popover>
  )
}

export { AnnotationDraftEditor, AnnotationMarkers }
export type { AnnotationControl }
