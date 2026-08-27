import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Pencil } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type {
  AnnotationValidationError,
  SessionTextAnnotationSource,
  TextAnnotation,
  TextAnnotationSource
} from '../../../../../shared/annotations'
import { AnnotationTrigger } from './AnnotationTrigger'
import { isBackwardSelection } from './annotation-trigger-anchor'
import { createAnnotationId } from './annotation-id'
import { revealTextAnnotationRange, subscribeAnnotationReveal } from './annotation-reveal'
import { reconcileTextAnnotationRanges } from './text-annotation-range'

type SelectionDraft = { quote: string; backward: boolean; range: Range }
type AnnotationControl = Readonly<{
  annotation: TextAnnotation
  left: number
  top: number
}>

const DRAFT_HIGHLIGHT_NAME = 'agent-annotation-draft'
const draftHighlightRanges = new Map<string, Range>()

const syncDraftHighlights = (): void => {
  if (typeof Highlight === 'undefined' || !globalThis.CSS?.highlights) return
  if (draftHighlightRanges.size === 0) {
    CSS.highlights.delete(DRAFT_HIGHLIGHT_NAME)
    return
  }
  CSS.highlights.set(DRAFT_HIGHLIGHT_NAME, new Highlight(...draftHighlightRanges.values()))
}

// Pointer interactions owned by the annotate UI itself; a pointerdown inside
// these must not clear the draft (the browser collapses the selection on any
// mousedown, so the draft can only survive through an exemption).
const ANNOTATE_UI_SELECTOR = '[data-annotation-trigger], [data-radix-popper-content-wrapper]'

const sourcesMatch = (left: TextAnnotationSource, right: SessionTextAnnotationSource): boolean => {
  if (left.kind !== right.kind) return false
  if (left.kind === 'agent-message' && right.kind === 'agent-message') {
    return left.sessionId === right.sessionId && left.messageId === right.messageId
  }
  if (left.kind === 'session-item' && right.kind === 'session-item') {
    return (
      left.sessionId === right.sessionId &&
      left.itemId === right.itemId &&
      left.itemType === right.itemType &&
      left.sectionId === right.sectionId
    )
  }
  return false
}

const TextAnnotationSurface = ({
  children,
  source,
  activeAnnotations,
  onAdd,
  onUpdateNote,
  onError
}: {
  children: React.ReactNode
  source: SessionTextAnnotationSource
  activeAnnotations: readonly TextAnnotation[]
  onAdd: (annotation: TextAnnotation) => AnnotationValidationError | undefined
  onUpdateNote?: (id: string, note: string) => AnnotationValidationError | undefined
  onError: (error: AnnotationValidationError) => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const ownedHighlightIds = useRef(new Set<string>())
  const suppressFollowingClickRef = useRef(false)
  const pendingHighlightKey = `pending-${useId()}`
  const noteInputId = `annotation-note-${useId()}`
  const [selection, setSelection] = useState<SelectionDraft>()
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const [annotationControls, setAnnotationControls] = useState<readonly AnnotationControl[]>([])
  const [hoveredAnnotationId, setHoveredAnnotationId] = useState<string>()
  const [editingAnnotationId, setEditingAnnotationId] = useState<string>()
  const [editingNote, setEditingNote] = useState('')
  const editButtons = useRef(new Map<string, HTMLButtonElement>())
  const matchingAnnotations = useMemo(
    () => activeAnnotations.filter((annotation) => sourcesMatch(annotation.source, source)),
    [activeAnnotations, source]
  )

  const measureAnnotationControls = useCallback((): void => {
    const surfaceRect = surfaceRef.current?.getBoundingClientRect()
    if (!surfaceRect) return
    setAnnotationControls(
      matchingAnnotations.flatMap((annotation) => {
        const range = draftHighlightRanges.get(annotation.id)
        if (!range) return []
        const rects = Array.from(range.getClientRects?.() ?? [])
        const rect =
          rects.at(-1) ??
          (typeof range.getBoundingClientRect === 'function'
            ? range.getBoundingClientRect()
            : undefined)
        if (!rect || (rect.width === 0 && rect.height === 0)) return []
        return [
          {
            annotation,
            left: rect.right - surfaceRect.left,
            top: rect.top - surfaceRect.top
          }
        ]
      })
    )
  }, [matchingAnnotations])

  const trackAnnotatedTextHover = (event: React.PointerEvent<HTMLDivElement>): void => {
    const hovered = matchingAnnotations.find((annotation) => {
      const range = draftHighlightRanges.get(annotation.id)
      return Array.from(range?.getClientRects?.() ?? []).some(
        (rect) =>
          event.clientX >= rect.left &&
          event.clientX <= rect.right &&
          event.clientY >= rect.top &&
          event.clientY <= rect.bottom
      )
    })
    setHoveredAnnotationId((current) => (current === hovered?.id ? current : hovered?.id))
  }

  const clearDraft = useCallback((): void => {
    // Only the surface whose editor is open owns a stale native selection
    // (a keyboard-opened editor never let the browser collapse it); clearing
    // it unconditionally would destroy a selection another surface is
    // building with this very pointerdown.
    if (open) window.getSelection()?.removeAllRanges()
    setSelection(undefined)
    setOpen(false)
    setNote('')
  }, [open])

  const captureSelection = (suppressFollowingClick: boolean): void => {
    // While the note editor is open the draft is frozen; stray mouseup/keyup
    // events from the surface must neither replace nor drop it.
    if (open) return
    const selected = window.getSelection()
    const range = selected?.rangeCount ? selected.getRangeAt(0) : undefined
    const surface = surfaceRef.current
    if (!selected || !range || !surface || selected.isCollapsed) {
      suppressFollowingClickRef.current = false
      clearDraft()
      return
    }
    const ancestor = range.commonAncestorContainer
    if (!surface.contains(ancestor.nodeType === Node.TEXT_NODE ? ancestor.parentNode : ancestor)) {
      suppressFollowingClickRef.current = false
      clearDraft()
      return
    }
    const quote = selected.toString().trim()
    if (!quote) {
      suppressFollowingClickRef.current = false
      clearDraft()
      return
    }
    suppressFollowingClickRef.current = suppressFollowingClick
    setSelection({
      quote,
      backward: isBackwardSelection(selected),
      range: range.cloneRange()
    })
  }

  useEffect(() => {
    // Clicking anywhere else collapses the selection without any event
    // reaching this surface; the draft must follow the real selection
    // instead of lingering over the text as a stale trigger.
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (target instanceof Element && target.closest(ANNOTATE_UI_SELECTOR)) return
      clearDraft()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [clearDraft])

  useEffect(
    () =>
      // The composer card reveals a quote by id; only the surface owning that
      // annotation's range answers.
      subscribeAnnotationReveal((annotationId) => {
        if (!ownedHighlightIds.current.has(annotationId)) return false
        const range = draftHighlightRanges.get(annotationId)
        if (!range) return false
        revealTextAnnotationRange(range)
        return true
      }),
    []
  )

  const reconcileAnnotationHighlights = useCallback((): void => {
    const existing = new Map<string, Range>()
    for (const id of ownedHighlightIds.current) {
      const range = draftHighlightRanges.get(id)
      if (range) existing.set(id, range)
    }
    for (const id of ownedHighlightIds.current) draftHighlightRanges.delete(id)
    ownedHighlightIds.current.clear()
    const content = contentRef.current
    if (content) {
      const next = reconcileTextAnnotationRanges(content, matchingAnnotations, existing)
      for (const [id, range] of next) {
        ownedHighlightIds.current.add(id)
        draftHighlightRanges.set(id, range)
      }
    }
    syncDraftHighlights()
    if (!content) {
      setAnnotationControls([])
      return
    }
    measureAnnotationControls()
  }, [matchingAnnotations, measureAnnotationControls])

  useLayoutEffect(() => {
    reconcileAnnotationHighlights()
  }, [children, reconcileAnnotationHighlights])

  useLayoutEffect(() => {
    const content = contentRef.current
    if (!content || typeof MutationObserver === 'undefined') return
    let scheduled = false
    let disconnected = false
    const observer = new MutationObserver(() => {
      if (scheduled) return
      scheduled = true
      queueMicrotask(() => {
        scheduled = false
        if (!disconnected) reconcileAnnotationHighlights()
      })
    })
    observer.observe(content, { childList: true, characterData: true, subtree: true })
    return () => {
      disconnected = true
      observer.disconnect()
    }
  }, [reconcileAnnotationHighlights])

  useEffect(() => {
    window.addEventListener('resize', measureAnnotationControls)
    return () => window.removeEventListener('resize', measureAnnotationControls)
  }, [measureAnnotationControls])

  useEffect(() => {
    const surface = surfaceRef.current
    if (!surface || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measureAnnotationControls)
    observer.observe(surface)
    if (contentRef.current) observer.observe(contentRef.current)
    return () => observer.disconnect()
  }, [measureAnnotationControls])

  useLayoutEffect(
    () => () => {
      for (const id of ownedHighlightIds.current) draftHighlightRanges.delete(id)
      draftHighlightRanges.delete(pendingHighlightKey)
      syncDraftHighlights()
    },
    [pendingHighlightKey]
  )

  // Opening the note editor collapses the native selection; the quoted text
  // must stay visible through the draft highlight until the draft resolves,
  // so the editor itself never needs to repeat the quote.
  useLayoutEffect(() => {
    if (open && selection) draftHighlightRanges.set(pendingHighlightKey, selection.range)
    else draftHighlightRanges.delete(pendingHighlightKey)
    syncDraftHighlights()
  }, [open, selection, pendingHighlightKey])

  const add = (): void => {
    if (!selection) return
    const annotation: TextAnnotation = {
      id: createAnnotationId(),
      kind: 'text',
      target: 'agent',
      quote: selection.quote,
      ...(note.trim() ? { note: note.trim() } : {}),
      source
    }
    const error = onAdd(annotation)
    if (error) {
      onError(error)
      return
    }
    ownedHighlightIds.current.add(annotation.id)
    draftHighlightRanges.set(annotation.id, selection.range)
    syncDraftHighlights()
    clearDraft()
    window.getSelection()?.removeAllRanges()
  }

  return (
    <div
      ref={surfaceRef}
      data-annotation-surface="true"
      data-annotation-active={matchingAnnotations.length > 0 ? 'true' : undefined}
      className="relative rounded-md"
      onMouseUp={() => captureSelection(true)}
      onKeyUp={() => captureSelection(false)}
      onClickCapture={(event) => {
        if (!suppressFollowingClickRef.current) return
        suppressFollowingClickRef.current = false
        const target = event.target
        if (target instanceof Element && target.closest(ANNOTATE_UI_SELECTOR)) return
        event.preventDefault()
        event.stopPropagation()
      }}
      onScrollCapture={measureAnnotationControls}
      onPointerMove={trackAnnotatedTextHover}
      onPointerLeave={() => setHoveredAnnotationId(undefined)}
    >
      <div ref={contentRef} className="contents">
        {children}
      </div>
      <TooltipProvider>
        {annotationControls.map(({ annotation, left, top }) => (
          <Popover
            key={annotation.id}
            open={editingAnnotationId === annotation.id}
            onOpenChange={(next) => {
              if (!next) setEditingAnnotationId(undefined)
            }}
          >
            <PopoverAnchor asChild>
              <span
                className="absolute z-10 -translate-x-1/3 -translate-y-2/3"
                style={{ left, top }}
              >
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
                      data-annotation-note={annotation.note ?? annotation.quote}
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
                    {annotation.note ?? annotation.quote}
                  </TooltipContent>
                </Tooltip>
              </span>
            </PopoverAnchor>
            <PopoverContent
              align="start"
              side="bottom"
              className="w-80 space-y-3 border border-border bg-popover p-3 text-popover-foreground"
              onCloseAutoFocus={(event) => {
                event.preventDefault()
                queueMicrotask(() => editButtons.current.get(annotation.id)?.focus())
              }}
            >
              <label className="sr-only" htmlFor={`source-annotation-note-${annotation.id}`}>
                {t('Annotation note')}
              </label>
              <Textarea
                id={`source-annotation-note-${annotation.id}`}
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
                    if (error) onError(error)
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
                className="pointer-events-none absolute z-20 max-w-72 truncate rounded-md bg-muted px-2 py-1 text-xs text-foreground shadow-sm"
                style={{ left, top: top + 18 }}
              >
                {annotation.note ?? annotation.quote}
              </div>
            ) : null}
          </Popover>
        ))}
      </TooltipProvider>
      {matchingAnnotations.length > 0 ? (
        <span className="sr-only">{t('Annotated for Agent')}</span>
      ) : null}
      {selection ? (
        <Popover
          open={open}
          onOpenChange={(next) => {
            setOpen(next)
            if (!next) {
              setNote('')
              // Escape keeps the draft (the trigger returns) but must still
              // withdraw a keyboard-triggered native selection.
              window.getSelection()?.removeAllRanges()
            }
          }}
        >
          <AnnotationTrigger
            range={selection.range}
            backward={selection.backward}
            hidden={open}
            label={t('Annotate')}
            onActivate={() => setOpen(true)}
          />
          <PopoverContent
            align="start"
            side="bottom"
            className="w-80 space-y-3 border border-border bg-popover p-3 text-popover-foreground"
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
              onChange={(event) => setNote(event.target.value)}
            />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
                {t('Cancel')}
              </Button>
              <Button type="button" size="sm" onClick={add}>
                {t('Annotate')}
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  )
}

export { TextAnnotationSurface }
