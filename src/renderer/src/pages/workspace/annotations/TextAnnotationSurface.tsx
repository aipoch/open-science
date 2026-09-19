import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BookmarkMarker } from '../bookmarks/BookmarkMarker'

import type {
  AnnotationValidationError,
  SessionTextAnnotationSource,
  TextAnnotation,
  TextAnnotationSource
} from '../../../../../shared/annotations'
import type { Bookmark, TextBookmarkTarget } from '../../../../../shared/bookmarks'
import { useBookmarks } from '../bookmarks/bookmark-context'
import { isBackwardSelection } from './annotation-trigger-anchor'
import { createAnnotationId } from './annotation-id'
import {
  revealTextAnnotationRange,
  subscribeBookmarkReveal,
  subscribeBookmarkRevealPreparation,
  subscribeAnnotationReveal,
  subscribeAnnotationRevealPreparation,
  retryPendingAnnotationReveal
} from './annotation-reveal'
import {
  AnnotationDraftEditor,
  AnnotationMarkers,
  type AnnotationControl
} from './TextAnnotationEditors'
import {
  textAnnotationAnchorForRange,
  quoteOccurrenceForRange,
  reconcileTextAnnotationRanges,
  retargetTextAnnotationRange
} from './text-annotation-range'

type SelectionDraft = { quote: string; backward: boolean; range: Range; occurrence: number }

const DRAFT_HIGHLIGHT_NAME = 'agent-annotation-draft'
const BOOKMARK_HIGHLIGHT_NAME = 'personal-bookmark'
const draftHighlightRanges = new Map<string, Range>()
const bookmarkHighlightRanges = new Map<string, Range>()

const syncDraftHighlights = (): void => {
  if (typeof Highlight === 'undefined' || !globalThis.CSS?.highlights) return
  if (draftHighlightRanges.size === 0) {
    CSS.highlights.delete(DRAFT_HIGHLIGHT_NAME)
    return
  }
  CSS.highlights.set(DRAFT_HIGHLIGHT_NAME, new Highlight(...draftHighlightRanges.values()))
}

const syncBookmarkHighlights = (): void => {
  if (typeof Highlight === 'undefined' || !globalThis.CSS?.highlights) return
  if (bookmarkHighlightRanges.size === 0) {
    CSS.highlights.delete(BOOKMARK_HIGHLIGHT_NAME)
    return
  }
  CSS.highlights.set(BOOKMARK_HIGHLIGHT_NAME, new Highlight(...bookmarkHighlightRanges.values()))
}

const createBookmarkId = (): string =>
  globalThis.crypto?.randomUUID
    ? `bookmark-${globalThis.crypto.randomUUID()}`
    : `bookmark-${Date.now()}-${Math.random().toString(36).slice(2)}`

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
  onRemove,
  onError,
  isAnimating = false
}: {
  children: React.ReactNode
  source: SessionTextAnnotationSource
  activeAnnotations?: readonly TextAnnotation[]
  onAdd?: (annotation: TextAnnotation) => AnnotationValidationError | undefined
  onRemove?: (id: string) => void
  onUpdateNote?: (id: string, note: string) => AnnotationValidationError | undefined
  onError?: (error: AnnotationValidationError) => void
  isAnimating?: boolean
}): React.JSX.Element => {
  const { t } = useTranslation()
  const bookmarkPort = useBookmarks()
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const ownedHighlightIds = useRef(new Set<string>())
  const ownedBookmarkHighlightIds = useRef(new Set<string>())
  const pendingBookmarkIdRef = useRef<string | undefined>(undefined)
  const suppressFollowingClickRef = useRef(false)
  const annotatePointerActiveRef = useRef(false)
  const preserveDraftForCollapsedSelectionRef = useRef(false)
  const suppressFollowingEscapeKeyUpRef = useRef(false)
  const pendingHighlightKey = `pending-${useId()}`
  const noteInputId = `annotation-note-${useId()}`
  const [selection, setSelection] = useState<SelectionDraft>()
  const selectionRef = useRef(selection)
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const [revealUnavailable, setRevealUnavailable] = useState(false)
  const [annotationControls, setAnnotationControls] = useState<readonly AnnotationControl[]>([])
  const [bookmarkMarkers, setBookmarkMarkers] = useState<
    readonly { id: string; left: number; top: number; note: string }[]
  >([])
  const [hoveredAnnotationId, setHoveredAnnotationId] = useState<string>()
  const matchingAnnotations = useMemo(
    () => (activeAnnotations ?? []).filter((annotation) => sourcesMatch(annotation.source, source)),
    [activeAnnotations, source]
  )
  const matchingBookmarks = useMemo(
    () =>
      bookmarkPort.bookmarks.filter(
        (bookmark): bookmark is Bookmark & { target: TextBookmarkTarget } =>
          bookmark.target.kind === 'text' && sourcesMatch(bookmark.target.source, source)
      ),
    [bookmarkPort.bookmarks, source]
  )

  const measureAnnotationControls = useCallback((): void => {
    // Reading an offscreen message's geometry defeats content-visibility containment.
    // Most messages have no markers, including when other messages are annotated.
    if (matchingAnnotations.length === 0 && matchingBookmarks.length === 0) {
      setAnnotationControls((current) => (current.length === 0 ? current : []))
      setBookmarkMarkers((current) => (current.length === 0 ? current : []))
      return
    }
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
    setBookmarkMarkers(
      matchingBookmarks.flatMap((bookmark) => {
        const range = bookmarkHighlightRanges.get(bookmark.id)
        const rect = Array.from(range?.getClientRects?.() ?? []).at(-1)
        if (!rect || (rect.width === 0 && rect.height === 0)) return []
        return [
          {
            id: bookmark.id,
            left: rect.right - surfaceRect.left + 1,
            top: rect.top - surfaceRect.top - 3,
            note: bookmark.note
          }
        ]
      })
    )
  }, [matchingAnnotations, matchingBookmarks])

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
    preserveDraftForCollapsedSelectionRef.current = false
    setSelection(undefined)
    setOpen(false)
    setNote('')
    pendingBookmarkIdRef.current = undefined
  }, [open])

  const captureSelection = useCallback(
    (suppressFollowingClick: boolean): void => {
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
      if (
        !surface.contains(ancestor.nodeType === Node.TEXT_NODE ? ancestor.parentNode : ancestor)
      ) {
        suppressFollowingClickRef.current = false
        clearDraft()
        return
      }
      // Chromium inserts rendered block separators into Selection.toString(), while
      // Range.toString() follows the text nodes used by the anchor and reveal logic.
      // Mixing the two makes a multi-block quote longer than its anchor span and the
      // otherwise valid annotation is rejected as `invalid`.
      const quote = range.toString().trim()
      if (!quote) {
        suppressFollowingClickRef.current = false
        clearDraft()
        return
      }
      suppressFollowingClickRef.current = suppressFollowingClick
      preserveDraftForCollapsedSelectionRef.current = false
      const cloned = range.cloneRange()
      const content = contentRef.current
      setSelection({
        quote,
        backward: isBackwardSelection(selected),
        range: cloned,
        occurrence: content ? quoteOccurrenceForRange(content, quote, cloned) : 0
      })
    },
    [clearDraft, open]
  )

  useEffect(() => {
    // Clicking anywhere else collapses the selection without any event
    // reaching this surface; the draft must follow the real selection
    // instead of lingering over the text as a stale trigger.
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target
      annotatePointerActiveRef.current =
        target instanceof Element && target.closest(ANNOTATE_UI_SELECTOR) !== null
      if (annotatePointerActiveRef.current) return
      preserveDraftForCollapsedSelectionRef.current = false
      clearDraft()
    }
    // Keep the exemption for the complete annotate press. A cancelled press
    // retains the draft until the next pointerdown.
    const onClick = (): void => {
      annotatePointerActiveRef.current = false
    }
    const onPointerCancel = (): void => {
      annotatePointerActiveRef.current = false
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('click', onClick)
    document.addEventListener('pointercancel', onPointerCancel, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('click', onClick)
      document.removeEventListener('pointercancel', onPointerCancel, true)
    }
  }, [clearDraft])

  useEffect(() => {
    const onSelectionChange = (): void => {
      const selected = window.getSelection()
      if (preserveDraftForCollapsedSelectionRef.current) {
        if (!selected || selected.isCollapsed) return
        preserveDraftForCollapsedSelectionRef.current = false
      }
      // Do not create a trigger during the live drag. Once a draft exists,
      // native selection changes must update or withdraw it. The annotation
      // UI and its open editor intentionally preserve the captured draft when
      // their own focus behavior collapses the browser selection.
      if (!selectionRef.current || open || annotatePointerActiveRef.current) return
      captureSelection(false)
    }
    document.addEventListener('selectionchange', onSelectionChange)
    return () => document.removeEventListener('selectionchange', onSelectionChange)
  }, [captureSelection, open])

  useEffect(() => {
    // A selection can begin inside this surface and finish over the transcript's
    // empty space. React then never delivers mouseup to the surface, even though
    // the browser selection still belongs to it. Let every mounted surface
    // reconcile on the document-level completion: the owner captures the range,
    // while the others withdraw any stale draft they still hold.
    const onMouseUp = (event: MouseEvent): void => {
      const target = event.target
      if (target instanceof Element && target.closest(ANNOTATE_UI_SELECTOR)) return
      const surface = surfaceRef.current
      if (surface && target instanceof Node && surface.contains(target)) return
      captureSelection(true)
    }
    document.addEventListener('mouseup', onMouseUp)
    return () => document.removeEventListener('mouseup', onMouseUp)
  }, [captureSelection])

  useLayoutEffect(() => {
    let prepared: TextAnnotation | undefined
    let preparedBookmark: (Readonly<{ id: string }> & TextBookmarkTarget) | undefined
    const stopPreparation = subscribeAnnotationRevealPreparation((annotation) => {
      prepared =
        annotation.kind === 'text' && sourcesMatch(annotation.source, source)
          ? annotation
          : undefined
      setRevealUnavailable(false)
    })
    const stopReveal = subscribeAnnotationReveal((id) => {
      const annotation =
        matchingAnnotations.find((entry) => entry.id === id) ??
        (prepared?.id === id ? prepared : undefined)
      const content = contentRef.current
      if (!annotation || !content) return false
      const range = reconcileTextAnnotationRanges(
        content,
        [annotation],
        new Map(
          Array.from(ownedHighlightIds.current).flatMap((id) => {
            const range = draftHighlightRanges.get(id)
            return range ? [[id, range] as const] : []
          })
        )
      ).get(id)
      setRevealUnavailable(!range)
      if (!range) return false
      revealTextAnnotationRange(range)
      return true
    })
    const stopBookmarkPreparation = subscribeBookmarkRevealPreparation((target) => {
      preparedBookmark =
        target.kind === 'text' && sourcesMatch(target.source, source) ? target : undefined
      setRevealUnavailable(false)
    })
    const stopBookmarkReveal = subscribeBookmarkReveal((target) => {
      if (target.kind !== 'text' || !sourcesMatch(target.source, source)) return
      const bookmark: TextBookmarkTarget | undefined =
        matchingBookmarks.find((entry) => entry.id === target.id)?.target ??
        (preparedBookmark?.id === target.id ? preparedBookmark : undefined)
      const content = contentRef.current
      if (!bookmark || !content) return
      const range = reconcileTextAnnotationRanges(
        content,
        [{ id: target.id, ...bookmark }],
        new Map()
      ).get(target.id)
      setRevealUnavailable(!range)
      if (!range) return 'locator-unsupported'
      revealTextAnnotationRange(range)
      return true
    })
    return () => {
      stopPreparation()
      stopReveal()
      stopBookmarkPreparation()
      stopBookmarkReveal()
    }
  }, [matchingAnnotations, matchingBookmarks, source])

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
      const bookmarkRanges = reconcileTextAnnotationRanges(
        content,
        matchingBookmarks.map((bookmark) => ({ id: bookmark.id, ...bookmark.target })),
        new Map(
          Array.from(ownedBookmarkHighlightIds.current).flatMap((id) => {
            const range = bookmarkHighlightRanges.get(id)
            return range ? [[id, range] as const] : []
          })
        )
      )
      for (const id of ownedBookmarkHighlightIds.current) bookmarkHighlightRanges.delete(id)
      ownedBookmarkHighlightIds.current.clear()
      for (const [id, range] of bookmarkRanges) {
        ownedBookmarkHighlightIds.current.add(id)
        bookmarkHighlightRanges.set(id, range)
      }
    }
    syncDraftHighlights()
    syncBookmarkHighlights()
    if (!content) {
      setAnnotationControls([])
      return
    }
    measureAnnotationControls()
    retryPendingAnnotationReveal()
  }, [matchingAnnotations, matchingBookmarks, measureAnnotationControls])

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
      for (const id of ownedBookmarkHighlightIds.current) bookmarkHighlightRanges.delete(id)
      draftHighlightRanges.delete(pendingHighlightKey)
      syncDraftHighlights()
      syncBookmarkHighlights()
    },
    [pendingHighlightKey]
  )

  // Opening the note editor collapses the native selection; the quoted text
  // stays highlighted while the compact editor also shows a source excerpt.
  useLayoutEffect(() => {
    if (open && selection) draftHighlightRanges.set(pendingHighlightKey, selection.range)
    else draftHighlightRanges.delete(pendingHighlightKey)
    syncDraftHighlights()
  }, [open, selection, pendingHighlightKey])

  const add = (): void => {
    if (!selection || !onAdd) return
    const annotation: TextAnnotation = {
      id: createAnnotationId(),
      kind: 'text',
      target: 'agent',
      quote: selection.quote,
      anchor: textAnnotationAnchorForRange(contentRef.current!, selection.range),
      ...(note.trim() ? { note: note.trim() } : {}),
      source
    }
    const error = onAdd(annotation)
    if (error) {
      onError?.(error)
      return
    }
    ownedHighlightIds.current.add(annotation.id)
    draftHighlightRanges.set(annotation.id, selection.range)
    syncDraftHighlights()
    clearDraft()
    window.getSelection()?.removeAllRanges()
  }

  const saveBookmark = async (bookmarkNote: string): Promise<void> => {
    if (!selection) return
    const id = pendingBookmarkIdRef.current ?? createBookmarkId()
    pendingBookmarkIdRef.current = id
    const target: TextBookmarkTarget = {
      kind: 'text',
      source,
      quote: selection.quote,
      anchor: textAnnotationAnchorForRange(contentRef.current!, selection.range)
    }
    await bookmarkPort.create(id, target, bookmarkNote)
    clearDraft()
    window.getSelection()?.removeAllRanges()
  }

  return (
    <div
      ref={surfaceRef}
      data-annotation-surface="true"
      data-annotation-active={matchingAnnotations.length > 0 ? 'true' : undefined}
      data-bookmark-active={matchingBookmarks.length > 0 ? 'true' : undefined}
      className="relative rounded-md"
      onMouseUp={(event) => {
        const target = event.target
        if (target instanceof Element && target.closest(ANNOTATE_UI_SELECTOR)) return
        captureSelection(true)
      }}
      onKeyUp={(event) => {
        if (suppressFollowingEscapeKeyUpRef.current) {
          suppressFollowingEscapeKeyUpRef.current = false
          if (event.key === 'Escape') return
        }
        const target = event.target
        if (target instanceof Element && target.closest(ANNOTATE_UI_SELECTOR)) return
        captureSelection(false)
      }}
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
      {revealUnavailable ? (
        <p role="status" className="text-xs text-muted-foreground">
          {t('The exact annotation location could not be found.')}
        </p>
      ) : null}
      <AnnotationMarkers
        controls={annotationControls}
        hoveredAnnotationId={hoveredAnnotationId}
        variant="workspace"
        onUpdateNote={onUpdateNote}
        onRemove={onRemove}
        onError={onError}
      />
      {bookmarkMarkers.map((marker) => (
        <BookmarkMarker key={marker.id} {...marker} />
      ))}
      {matchingAnnotations.length > 0 ? (
        <span className="sr-only">{t('Annotated for Agent')}</span>
      ) : null}
      {matchingBookmarks.length > 0 ? <span className="sr-only">{t('Bookmarked')}</span> : null}
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
              const selected = window.getSelection()
              preserveDraftForCollapsedSelectionRef.current = true
              suppressFollowingEscapeKeyUpRef.current = true
              selected?.removeAllRanges()
            }
          }}
          onCancel={() => setOpen(false)}
          onNoteChange={setNote}
          onAdd={add}
          bookmark={{ available: bookmarkPort.available, onSave: saveBookmark }}
        />
      ) : null}
    </div>
  )
}

export { TextAnnotationSurface }
