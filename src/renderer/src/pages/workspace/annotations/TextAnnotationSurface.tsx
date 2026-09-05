import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type {
  AnnotationValidationError,
  SessionTextAnnotationSource,
  TextAnnotation,
  TextAnnotationSource
} from '../../../../../shared/annotations'
import { isBackwardSelection } from './annotation-trigger-anchor'
import { createAnnotationId } from './annotation-id'
import { revealTextAnnotationRange, subscribeAnnotationReveal } from './annotation-reveal'
import {
  AnnotationDraftEditor,
  AnnotationMarkers,
  type AnnotationControl
} from './TextAnnotationEditors'
import {
  quoteOccurrenceForRange,
  reconcileTextAnnotationRanges,
  retargetTextAnnotationRange
} from './text-annotation-range'

type SelectionDraft = { quote: string; backward: boolean; range: Range; occurrence: number }

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
  onError,
  isAnimating = false
}: {
  children: React.ReactNode
  source: SessionTextAnnotationSource
  activeAnnotations: readonly TextAnnotation[]
  onAdd: (annotation: TextAnnotation) => AnnotationValidationError | undefined
  onUpdateNote?: (id: string, note: string) => AnnotationValidationError | undefined
  onError: (error: AnnotationValidationError) => void
  isAnimating?: boolean
}): React.JSX.Element => {
  const { t } = useTranslation()
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const ownedHighlightIds = useRef(new Set<string>())
  const suppressFollowingClickRef = useRef(false)
  const pendingHighlightKey = `pending-${useId()}`
  const noteInputId = `annotation-note-${useId()}`
  const [selection, setSelection] = useState<SelectionDraft>()
  const selectionRef = useRef(selection)
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const [annotationControls, setAnnotationControls] = useState<readonly AnnotationControl[]>([])
  const [hoveredAnnotationId, setHoveredAnnotationId] = useState<string>()
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

  const isAnimatingRef = useRef(isAnimating)
  useLayoutEffect(() => {
    isAnimatingRef.current = isAnimating
  }, [isAnimating])

  useLayoutEffect(() => {
    // While the message streams in, this surface re-renders every frame; the
    // highlight reconcile re-anchors ranges against a tree the next frame
    // replaces anyway, so it waits for the frame after streaming ends (this
    // effect re-runs when isAnimating flips back). The draft retarget still
    // runs so an in-progress manual selection keeps tracking the text.
    if (!isAnimating) reconcileAnnotationHighlights()
    retargetDraftSelection()
  }, [children, isAnimating, reconcileAnnotationHighlights, retargetDraftSelection])

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
        if (!isAnimatingRef.current) reconcileAnnotationHighlights()
        retargetDraftSelection()
      })
    })
    observer.observe(content, { childList: true, characterData: true, subtree: true })
    return () => {
      disconnected = true
      observer.disconnect()
    }
  }, [reconcileAnnotationHighlights, retargetDraftSelection])

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
      <AnnotationMarkers
        controls={annotationControls}
        hoveredAnnotationId={hoveredAnnotationId}
        variant="workspace"
        onUpdateNote={onUpdateNote}
        onError={onError}
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
          noteInputId={noteInputId}
          variant="workspace"
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

export { TextAnnotationSurface }
