import { FileText, Image, MapPin, Pencil, Quote, Trash2 } from 'lucide-react'
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
  if (annotation.source.kind === 'agent-message') {
    return `${t('Agent Message')} · ${annotation.source.messageId ?? annotation.source.sessionId}`
  }
  if (annotation.source.kind === 'session-item') {
    return sessionItemSourceLabel(annotation.source.itemType, t)
  }
  return annotation.source.name ?? annotation.source.path ?? t('Project File')
}

const annotationChipLabel = (annotation: Annotation): string =>
  annotation.note ??
  (annotation.kind === 'text'
    ? annotation.quote
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
          const hoverLabel = `${annotation.note ?? (annotation.kind === 'text' ? annotation.quote : '')} - ${hoverSourceLabel}`
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
                      ) : annotation.source.kind === 'project-file' ? (
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
                      <span className="truncate">{annotationChipLabel(annotation)}</span>
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
  annotations
}: {
  annotations: readonly Annotation[]
}): React.JSX.Element | null => {
  const { t } = useTranslation()
  if (annotations.length === 0) return null
  const imagePoints = new Map(
    prepareImagePointAnnotations(annotations).points.map((point) => [point.annotationId, point])
  )
  return (
    <section className="mb-2 space-y-2" aria-label={t('Sent annotations')}>
      {annotations.map((annotation) => {
        const imagePoint = imagePoints.get(annotation.id)
        return (
          <article
            key={annotation.id}
            className="rounded-lg border border-border/70 bg-background/70 p-2"
          >
            <div className="flex items-center gap-1 text-xs font-semibold">
              {imagePoint ? (
                <MapPin className="size-3" aria-hidden="true" />
              ) : (
                <Quote className="size-3" aria-hidden="true" />
              )}
              {imagePoint
                ? t('Image point {{number}}', { number: imagePoint.number })
                : t('Text quote')}
            </div>
            <blockquote className="mt-1 whitespace-pre-wrap break-words border-l-2 border-primary/50 pl-2 text-xs">
              {imagePoint
                ? t('Point {{number}} at {{x}}, {{y}}', imagePoint)
                : annotation.kind === 'text'
                  ? annotation.quote
                  : annotation.source.name}
            </blockquote>
            <div className="mt-1 text-[11px] opacity-70">
              {t('Source: {{source}}', { source: annotationSourceLabel(annotation, t) })}
            </div>
            {annotation.note ? <div className="mt-1 text-xs">{annotation.note}</div> : null}
          </article>
        )
      })}
    </section>
  )
}

export { AnnotationDraftCards, AnnotationMessageCards }
