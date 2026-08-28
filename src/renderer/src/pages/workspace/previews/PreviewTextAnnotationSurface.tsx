import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { PreviewFileItem } from '@/stores/preview-workbench-store'
import type { TextAnnotation } from '../../../../../shared/annotations'
import type { PreviewFileRendererProps } from './preview-types'
import {
  revealTextAnnotationRange,
  subscribeAnnotationReveal
} from '../annotations/annotation-reveal'
import { isBackwardSelection } from '../annotations/annotation-trigger-anchor'
import { createAnnotationId } from '../annotations/annotation-id'
import {
  AnnotationDraftEditor,
  AnnotationMarkers,
  type AnnotationControl
} from '../annotations/TextAnnotationEditors'
import {
  quoteOccurrenceForRange,
  reconcileTextAnnotationRanges,
  retargetTextAnnotationRange
} from '../annotations/text-annotation-range'

type SelectionDraft = Readonly<{
  quote: string
  backward: boolean
  range: Range
  occurrence: number
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
  const contentRef = useRef<HTMLDivElement | null>(null)
  const ownedRanges = useRef(new Map<string, Range>())
  const pendingRangeRef = useRef<Range | null>(null)
  const [selection, setSelection] = useState<SelectionDraft>()
  const selectionRef = useRef(selection)
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const [annotationControls, setAnnotationControls] = useState<readonly AnnotationControl[]>([])
  const [hoveredAnnotationId, setHoveredAnnotationId] = useState<string>()
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
    selectionRef.current = selection
  }, [selection])

  const retargetDraftSelection = useCallback((): void => {
    const content = contentRef.current
    const draft = selectionRef.current
    if (!content || !draft) return
    const nextRange = retargetTextAnnotationRange(
      content,
      draft.quote,
      draft.range,
      draft.occurrence
    )
    if (nextRange === draft.range) return
    if (nextRange) {
      setSelection({ ...draft, range: nextRange })
      return
    }
    setSelection(undefined)
    setOpen(false)
    setNote('')
  }, [])

  const reconcilePreviewHighlights = useCallback((): void => {
    const highlight = getDraftHighlight()
    if (!highlight) return
    for (const range of ownedRanges.current.values()) highlight.delete(range)
    const content = contentRef.current
    if (!content) {
      ownedRanges.current.clear()
      return
    }
    ownedRanges.current = reconcileTextAnnotationRanges(
      content,
      matchingAnnotations,
      ownedRanges.current
    )
    for (const range of ownedRanges.current.values()) highlight.add(range)
    measureAnnotationControls()
  }, [matchingAnnotations, measureAnnotationControls])

  useLayoutEffect(() => {
    reconcilePreviewHighlights()
    retargetDraftSelection()
  }, [children, reconcilePreviewHighlights, retargetDraftSelection])

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
        if (disconnected) return
        reconcilePreviewHighlights()
        retargetDraftSelection()
      })
    })
    observer.observe(content, { childList: true, characterData: true, subtree: true })
    return () => {
      disconnected = true
      observer.disconnect()
    }
  }, [reconcilePreviewHighlights, retargetDraftSelection])

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
    const cloned = range.cloneRange()
    const content = contentRef.current
    setSelection({
      quote,
      backward: isBackwardSelection(selected),
      range: cloned,
      occurrence: content ? quoteOccurrenceForRange(content, quote, cloned) : 0
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
      <div ref={contentRef} className="contents">
        {children}
      </div>
      <AnnotationMarkers
        controls={annotationControls}
        hoveredAnnotationId={hoveredAnnotationId}
        variant="preview"
        onUpdateNote={onUpdateAnnotationNote}
        onError={onAnnotationError}
      />
      {matchingAnnotations.length > 0 ? (
        <span className="sr-only">{t('Annotated for Agent')}</span>
      ) : null}
      {selection ? (
        <AnnotationDraftEditor
          range={selection.range}
          backward={selection.backward}
          open={open}
          note={note}
          noteInputId={`preview-note-${item.id}`}
          variant="preview"
          onOpenChange={(next) => {
            setOpen(next)
            if (!next) {
              setNote('')
              // Escape keeps the draft (the trigger returns) but must still
              // withdraw a keyboard-triggered native selection.
              window.getSelection()?.removeAllRanges()
            }
          }}
          onCancel={() => setOpen(false)}
          onNoteChange={setNote}
          onAdd={add}
        />
      ) : null}
    </div>
  )
}
