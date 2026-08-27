import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Pencil } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { PreviewFileItem } from '@/stores/preview-workbench-store'
import type { TextAnnotation } from '../../../../../shared/annotations'
import type { PreviewFileRendererProps } from './preview-types'
import {
  revealTextAnnotationRange,
  subscribeAnnotationReveal
} from '../annotations/annotation-reveal'
import { AnnotationTrigger } from '../annotations/AnnotationTrigger'
import { isBackwardSelection } from '../annotations/annotation-trigger-anchor'
import { createAnnotationId } from '../annotations/annotation-id'
import { reconcileTextAnnotationRanges } from '../annotations/text-annotation-range'

type SelectionDraft = Readonly<{ quote: string; backward: boolean; range: Range }>
type AnnotationControl = Readonly<{
  annotation: TextAnnotation
  left: number
  top: number
}>

const DRAFT_HIGHLIGHT_NAME = 'preview-annotation-draft'
const DRAFT_HIGHLIGHT_STYLE_ID = 'preview-annotation-draft-style'
const NO_ANNOTATIONS: readonly never[] = []

// Pointer interactions owned by the annotate UI itself; a pointerdown inside
// these must not clear the draft (the browser collapses the selection on any
// mousedown, so the draft can only survive through an exemption).
const ANNOTATE_UI_SELECTOR = '[data-annotation-trigger], [data-radix-popper-content-wrapper]'

const projectFileSource = (item: PreviewFileItem): TextAnnotation['source'] | undefined => {
  if (!item.projectId) return undefined
  return {
    kind: 'project-file',
    projectId: item.projectId,
    path: item.path,
    name: item.name,
    ...(item.selectedVersionId ? { versionId: item.selectedVersionId } : {}),
    ...(item.sessionId ? { sessionId: item.sessionId } : {})
  }
}

const belongsToPreview = (annotation: TextAnnotation, item: PreviewFileItem): boolean => {
  const source = annotation.source
  if (source.kind !== 'project-file' || !item.projectId) return false
  if (source.projectId !== item.projectId || source.path !== item.path) return false
  if (source.versionId || item.selectedVersionId) {
    return source.versionId === item.selectedVersionId
  }
  return true
}

const getDraftHighlight = (): Highlight | undefined => {
  if (typeof Highlight === 'undefined' || !globalThis.CSS?.highlights) return undefined
  if (!document.getElementById(DRAFT_HIGHLIGHT_STYLE_ID)) {
    const style = document.createElement('style')
    style.id = DRAFT_HIGHLIGHT_STYLE_ID
    style.textContent = `::highlight(${DRAFT_HIGHLIGHT_NAME}) {
      background-color: color-mix(in oklab, var(--primary) 22%, transparent);
      text-decoration: underline 0.125rem var(--primary);
    }`
    document.head.appendChild(style)
  }
  const current = CSS.highlights.get(DRAFT_HIGHLIGHT_NAME)
  if (current) return current
  const created = new Highlight()
  CSS.highlights.set(DRAFT_HIGHLIGHT_NAME, created)
  return created
}

export const PreviewTextAnnotationSurface = ({
  item,
  activeAnnotations = NO_ANNOTATIONS,
  onAddAnnotation,
  onUpdateAnnotationNote,
  onAnnotationError,
  children
}: PreviewFileRendererProps & { children: React.ReactNode }): React.JSX.Element => {
  const { t } = useTranslation()
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const ownedRanges = useRef(new Map<string, Range>())
  const pendingRangeRef = useRef<Range | null>(null)
  const [selection, setSelection] = useState<SelectionDraft>()
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const [annotationControls, setAnnotationControls] = useState<readonly AnnotationControl[]>([])
  const [hoveredAnnotationId, setHoveredAnnotationId] = useState<string>()
  const [editingAnnotationId, setEditingAnnotationId] = useState<string>()
  const [editingNote, setEditingNote] = useState('')
  const editButtons = useRef(new Map<string, HTMLButtonElement>())
  const source = projectFileSource(item)
  const matchingAnnotations = useMemo(
    () =>
      activeAnnotations.filter(
        (annotation): annotation is TextAnnotation =>
          annotation.kind === 'text' && belongsToPreview(annotation, item)
      ),
    [activeAnnotations, item]
  )

  const measureAnnotationControls = useCallback((): void => {
    const surface = surfaceRef.current
    if (!surface) return
    const surfaceRect = surface.getBoundingClientRect()
    setAnnotationControls(
      matchingAnnotations.flatMap((annotation) => {
        const range = ownedRanges.current.get(annotation.id)
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
      const range = ownedRanges.current.get(annotation.id)
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

  useLayoutEffect(() => {
    const highlight = getDraftHighlight()
    if (!highlight) return
    for (const range of ownedRanges.current.values()) highlight.delete(range)
    const surface = surfaceRef.current
    if (!surface) {
      ownedRanges.current.clear()
      return
    }
    ownedRanges.current = reconcileTextAnnotationRanges(
      surface,
      matchingAnnotations,
      ownedRanges.current
    )
    for (const range of ownedRanges.current.values()) highlight.add(range)
    measureAnnotationControls()
  }, [children, matchingAnnotations, measureAnnotationControls])

  useEffect(() => {
    window.addEventListener('resize', measureAnnotationControls)
    return () => window.removeEventListener('resize', measureAnnotationControls)
  }, [measureAnnotationControls])

  useEffect(() => {
    const surface = surfaceRef.current
    if (!surface || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measureAnnotationControls)
    observer.observe(surface)
    if (surface.firstElementChild) observer.observe(surface.firstElementChild)
    return () => observer.disconnect()
  }, [measureAnnotationControls])

  useLayoutEffect(
    () => () => {
      const highlight = getDraftHighlight()
      if (!highlight) return
      for (const range of ownedRanges.current.values()) highlight.delete(range)
      ownedRanges.current.clear()
      if (pendingRangeRef.current) {
        highlight.delete(pendingRangeRef.current)
        pendingRangeRef.current = null
      }
    },
    []
  )

  // Opening the note editor collapses the native selection; the quoted text
  // must stay visible through the draft highlight until the draft resolves,
  // so the editor itself never needs to repeat the quote.
  useLayoutEffect(() => {
    const highlight = getDraftHighlight()
    if (!highlight) return
    if (open && selection) {
      if (pendingRangeRef.current && pendingRangeRef.current !== selection.range) {
        highlight.delete(pendingRangeRef.current)
      }
      highlight.add(selection.range)
      pendingRangeRef.current = selection.range
    } else if (pendingRangeRef.current) {
      highlight.delete(pendingRangeRef.current)
      pendingRangeRef.current = null
    }
  }, [open, selection])

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

  const captureSelection = (): void => {
    // While the note editor is open the draft is frozen; stray mouseup/keyup
    // events from the surface must neither replace nor drop it.
    if (open) return
    if (!source || !onAddAnnotation) {
      clearDraft()
      return
    }
    const selected = window.getSelection()
    const range = selected?.rangeCount ? selected.getRangeAt(0) : undefined
    const surface = surfaceRef.current
    if (!selected || !range || !surface || selected.isCollapsed) {
      clearDraft()
      return
    }
    const ancestor = range.commonAncestorContainer
    if (!surface.contains(ancestor.nodeType === Node.TEXT_NODE ? ancestor.parentNode : ancestor)) {
      clearDraft()
      return
    }
    const quote = selected.toString().trim()
    if (!quote) {
      clearDraft()
      return
    }
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
        const range = ownedRanges.current.get(annotationId)
        if (!range) return false
        revealTextAnnotationRange(range)
        return true
      }),
    []
  )

  const add = (): void => {
    if (!selection || !source || !onAddAnnotation) return
    const annotation: TextAnnotation = {
      id: createAnnotationId(),
      kind: 'text',
      target: 'agent',
      quote: selection.quote,
      ...(note.trim() ? { note: note.trim() } : {}),
      source
    }
    const error = onAddAnnotation(annotation)
    if (error) {
      onAnnotationError?.(error)
      return
    }
    const highlight = getDraftHighlight()
    highlight?.add(selection.range)
    ownedRanges.current.set(annotation.id, selection.range)
    // The range now belongs to the confirmed annotation; clearing the draft
    // below must not withdraw the highlight it just adopted.
    pendingRangeRef.current = null
    clearDraft()
    window.getSelection()?.removeAllRanges()
  }

  return (
    <div
      ref={surfaceRef}
      data-preview-text-annotation-surface="true"
      data-annotation-active={matchingAnnotations.length > 0 ? 'true' : undefined}
      className="relative size-full rounded-md"
      onMouseUp={captureSelection}
      onKeyUp={captureSelection}
      onScrollCapture={measureAnnotationControls}
      onPointerMove={trackAnnotatedTextHover}
      onPointerLeave={() => setHoveredAnnotationId(undefined)}
    >
      {children}
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
                className="absolute z-30 -translate-x-1/3 -translate-y-2/3"
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
              collisionPadding={8}
              className="z-[70] w-80 space-y-3 border border-border bg-popover p-3 text-popover-foreground"
              onCloseAutoFocus={(event) => {
                event.preventDefault()
                queueMicrotask(() => editButtons.current.get(annotation.id)?.focus())
              }}
            >
              <label className="sr-only" htmlFor={`preview-source-note-${annotation.id}`}>
                {t('Annotation note')}
              </label>
              <Textarea
                id={`preview-source-note-${annotation.id}`}
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
                  disabled={!onUpdateAnnotationNote}
                  onClick={() => {
                    const error = onUpdateAnnotationNote?.(annotation.id, editingNote)
                    if (error) onAnnotationError?.(error)
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
                className="pointer-events-none absolute z-40 max-w-72 truncate rounded-md bg-muted px-2 py-1 text-xs text-foreground shadow-sm"
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
            collisionPadding={8}
            // Full-screen file previews sit at z-[60]/z-[61]. This editor is portalled to
            // document.body, so keep it on the shared floating tier above the preview chrome.
            className="z-[70] w-80 space-y-3 border border-border bg-popover p-3 text-popover-foreground"
          >
            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {t('To Agent')}
            </div>
            <label className="block text-xs font-medium" htmlFor={`preview-note-${item.id}`}>
              {t('Note (optional)')}
            </label>
            <Textarea
              id={`preview-note-${item.id}`}
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
