import { FileText, Image, Pencil, Quote, Trash2 } from 'lucide-react'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'

import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type {
  Annotation,
  AnnotationValidationError,
  SessionTextAnnotationItemType
} from '../../../../../shared/annotations'
import { prepareImagePointAnnotations } from './image-annotation-payload'
import { SentAnnotationCards, type SentAnnotationCardView } from './SentAnnotationCards'

const sessionItemSourceLabel = (itemType: SessionTextAnnotationItemType, t: TFunction): string => {
  const labels: Record<SessionTextAnnotationItemType, string> = {
    'tool-activity': t('Tool activity'),
    plan: t('Execution plan'),
    elicitation: t('Question'),
    'delegated-elicitation': t('Delegated question'),
    'subagent-message': t('Subagent message')
  }
  return labels[itemType]
}

const annotationSourceLabel = (annotation: Annotation, t: TFunction): string => {
  if (annotation.kind === 'image-point') return annotation.source.name
  if (annotation.kind === 'pdf') {
    return `${annotation.source.name} · ${t('Page {{page}}', { page: annotation.selector.pageNumber })}`
  }
  if (annotation.source.kind === 'agent-message') {
    return `${t('Agent Message')} · ${annotation.source.messageId ?? annotation.source.sessionId}`
  }
  if (annotation.source.kind === 'session-item') {
    return sessionItemSourceLabel(annotation.source.itemType, t)
  }
  return annotation.source.name ?? annotation.source.path ?? t('Project File')
}

const sentAnnotationViews = (
  annotations: readonly Annotation[],
  t: TFunction
): readonly SentAnnotationCardView[] => {
  const imagePoints = new Map(
    prepareImagePointAnnotations(annotations).points.map((point) => [point.annotationId, point])
  )
  return annotations.map((annotation) => {
    const imagePoint = imagePoints.get(annotation.id)
    if (imagePoint) {
      return {
        id: annotation.id,
        kind: 'image-point',
        number: imagePoint.number,
        x: imagePoint.x,
        y: imagePoint.y,
        source: annotationSourceLabel(annotation, t),
        note: annotation.note
      }
    }
    if (annotation.kind === 'pdf') {
      if (annotation.selector.kind === 'text') {
        return {
          id: annotation.id,
          kind: 'pdf-text',
          content: annotation.selector.exact,
          source: annotationSourceLabel(annotation, t),
          note: annotation.note
        }
      }
      return {
        id: annotation.id,
        kind: 'pdf-region',
        content: annotation.selector.text ?? t('Selected area'),
        source: annotationSourceLabel(annotation, t),
        note: annotation.note,
        image: annotation.selector.image
      }
    }
    return {
      id: annotation.id,
      kind: 'text',
      content: annotation.kind === 'text' ? annotation.quote : annotation.source.name,
      source: annotationSourceLabel(annotation, t),
      note: annotation.note
    }
  })
}

const annotationChipLabel = (annotation: Annotation, t: TFunction): string =>
  annotation.note ??
  (annotation.kind === 'text'
    ? annotation.quote
    : annotation.kind === 'pdf'
      ? annotation.selector.kind === 'text'
        ? annotation.selector.exact
        : (annotation.selector.text ?? t('Selected area'))
      : (annotation.source.name ?? annotation.source.path))

const AnnotationDraftCards = ({
  annotations,
  disabled,
  onUpdateNote,
  onRemove,
  onReveal
}: {
  annotations: readonly Annotation[]
  disabled: boolean
  onUpdateNote: (id: string, note: string) => AnnotationValidationError | undefined
  onRemove: (id: string) => void
  onReveal?: (annotation: Annotation) => void
}): React.JSX.Element | null => {
  const { t } = useTranslation()
  const [editingId, setEditingId] = useState<string>()
  const [hoveredId, setHoveredId] = useState<string>()
  const [editTooltipId, setEditTooltipId] = useState<string>()
  const [note, setNote] = useState('')
  const editButtons = useRef(new Map<string, HTMLButtonElement>())
  const imagePoints = new Map(
    prepareImagePointAnnotations(annotations).points.map((point) => [point.annotationId, point])
  )
  const closeEditor = (id: string): void => {
    setEditingId(undefined)
    setTimeout(() => editButtons.current.get(id)?.focus(), 0)
  }
  const openEditor = (annotation: Annotation): void => {
    setEditingId(annotation.id)
    setNote(annotation.note ?? '')
  }
  if (annotations.length === 0) return null

  return (
    <TooltipProvider>
      <section
        className="flex max-h-[132px] flex-wrap gap-1.5 overflow-y-auto border-b border-border-200 pb-2"
        aria-label={t('Annotations for Agent')}
      >
        {annotations.map((annotation) => {
          const imagePoint = imagePoints.get(annotation.id)
          const hoverSourceLabel =
            annotation.kind === 'text' && annotation.source.kind === 'agent-message'
              ? t('Agent Message')
              : annotationSourceLabel(annotation, t)
          const hoverLabel = `${annotationChipLabel(annotation, t)} - ${hoverSourceLabel}`
          const editing = editingId === annotation.id
          return (
            <Popover
              key={annotation.id}
              open={editing}
              onOpenChange={(open) => {
                if (open) {
                  setHoveredId(undefined)
                  setEditTooltipId(undefined)
                  openEditor(annotation)
                } else {
                  closeEditor(annotation.id)
                }
              }}
            >
              <Tooltip
                open={!editing && hoveredId === annotation.id}
                onOpenChange={(open) => setHoveredId(open ? annotation.id : undefined)}
              >
                <TooltipTrigger asChild>
                  <article
                    data-annotation-draft-chip="true"
                    data-annotation-hover-label={hoverLabel}
                    className="group relative inline-flex h-7 min-w-0 max-w-[13rem] items-center rounded-md border border-border bg-background text-xs hover:bg-muted focus-within:bg-muted"
                  >
                    <button
                      type="button"
                      data-annotation-quote="true"
                      className="flex min-w-0 flex-1 items-center gap-1.5 self-stretch rounded-l-md px-2 text-left focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                      aria-label={t('Show annotation source')}
                      onClick={() => onReveal?.(annotation)}
                    >
                      {imagePoint ? (
                        <Image
                          className="size-3.5 shrink-0 text-muted-foreground"
                          aria-hidden="true"
                        />
                      ) : annotation.kind === 'pdf' || annotation.source.kind === 'project-file' ? (
                        <FileText
                          className="size-3.5 shrink-0 text-muted-foreground"
                          aria-hidden="true"
                        />
                      ) : (
                        <Quote
                          className="size-3.5 shrink-0 text-muted-foreground"
                          aria-hidden="true"
                        />
                      )}
                      <span className="truncate">{annotationChipLabel(annotation, t)}</span>
                    </button>
                    <div className="flex shrink-0 items-center pr-0.5">
                      <Tooltip
                        open={!editing && editTooltipId === annotation.id}
                        onOpenChange={(open) => setEditTooltipId(open ? annotation.id : undefined)}
                      >
                        <TooltipTrigger
                          asChild
                          onFocus={(event) => {
                            if (!event.currentTarget.matches(':focus-visible'))
                              event.preventDefault()
                          }}
                        >
                          <PopoverTrigger asChild>
                            <Button
                              ref={(element) => {
                                if (element) editButtons.current.set(annotation.id, element)
                                else editButtons.current.delete(annotation.id)
                              }}
                              type="button"
                              variant="ghost"
                              size="icon-xs"
                              disabled={disabled}
                              aria-label={t('Edit annotation note')}
                              className="bg-transparent"
                            >
                              <Pencil aria-hidden="true" />
                            </Button>
                          </PopoverTrigger>
                        </TooltipTrigger>
                        <TooltipContent>{t('Edit annotation note')}</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-xs"
                            disabled={disabled}
                            aria-label={t('Remove annotation')}
                            className="bg-transparent"
                            onClick={() => onRemove(annotation.id)}
                          >
                            <Trash2 aria-hidden="true" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{t('Remove annotation')}</TooltipContent>
                      </Tooltip>
                    </div>
                  </article>
                </TooltipTrigger>
                <TooltipContent
                  data-annotation-hover-note="true"
                  className="max-w-72 truncate bg-muted text-foreground"
                >
                  {hoverLabel}
                </TooltipContent>
              </Tooltip>
              <PopoverContent
                data-annotation-note-editor="true"
                side="top"
                align="end"
                sideOffset={8}
                collisionPadding={12}
                className="z-50 w-80 max-w-[calc(100vw-1.5rem)] space-y-2 border border-border bg-popover p-3 text-popover-foreground shadow-menu"
                onCloseAutoFocus={(event) => {
                  event.preventDefault()
                }}
              >
                <label className="sr-only" htmlFor={`edit-annotation-${annotation.id}`}>
                  {t('Annotation note')}
                </label>
                <Textarea
                  id={`edit-annotation-${annotation.id}`}
                  autoFocus
                  value={note}
                  maxLength={2_000}
                  placeholder={t('Add context for the Agent')}
                  onChange={(event) => setNote(event.target.value)}
                />
                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => closeEditor(annotation.id)}
                  >
                    {t('Cancel')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => {
                      if (!onUpdateNote(annotation.id, note)) closeEditor(annotation.id)
                    }}
                  >
                    {t('Save')}
                  </Button>
                </div>
              </PopoverContent>
            </Popover>
          )
        })}
      </section>
    </TooltipProvider>
  )
}

const AnnotationMessageCards = ({
  annotations,
  onReveal
}: {
  annotations: readonly Annotation[]
  onReveal?: (annotation: Annotation) => void
}): React.JSX.Element | null => {
  const { t } = useTranslation()
  return (
    <SentAnnotationCards
      cards={sentAnnotationViews(annotations, t)}
      placement="message"
      onActivate={
        onReveal
          ? (id) => {
              const annotation = annotations.find((candidate) => candidate.id === id)
              if (annotation) onReveal(annotation)
            }
          : undefined
      }
    />
  )
}

export { AnnotationDraftCards, AnnotationMessageCards }
